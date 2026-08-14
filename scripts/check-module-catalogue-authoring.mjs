import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  MODULE_IDS,
  buildGoalModulePlan,
  composeModuleOffer,
  confirmationSummary,
  consumerLanguageForModule,
  containsInternalModuleTerminology,
  createHouseholdProfile,
  effectiveConsumerAvailability,
  getModuleManifest,
  listModuleManifests,
  nextModuleOffer,
  normalizeHouseholdProfile,
  recommendModules
} from '../js/planning/index.js';
import { MODULE_MANIFEST } from '../js/planning/module_manifest.generated.js';
import {
  REQUIRED_CONSUMER_LANGUAGE_FIELDS,
  parseAuthoredModuleDocument,
  validateModuleManifest
} from '../js/planning/module_manifest_validation.js';
import {
  buildCandidateManifest,
  buildModulePatchExport,
  handleModuleCatalogueRequest,
  validateModuleDraft
} from '../worker/src/advisor/module_catalogue.js';
import worker from '../worker/src/index.js';
import { buildLiveCataloguePrompt } from '../worker/src/consumer/live/catalogue_prompt.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const fixture = JSON.parse(readFileSync(
  resolve(root, 'scripts/fixtures/module-catalogue-authoring-identity.json'),
  'utf8'
));
const NOW = '2026-08-01T09:00:00.000Z';
const ALL_MODULES = Object.values(MODULE_IDS);

const PYTHON_SQLITE = String.raw`
import json
import sqlite3
import sys

database_path, mode = sys.argv[1], sys.argv[2]
payload = json.load(sys.stdin)
connection = sqlite3.connect(database_path)
connection.row_factory = sqlite3.Row
connection.execute('PRAGMA foreign_keys = ON')
try:
    if mode == 'script':
        connection.executescript(payload['sql'])
        connection.commit()
        result = {}
    elif mode == 'batch':
        connection.execute('BEGIN IMMEDIATE')
        result = []
        for item in payload['statements']:
            cursor = connection.execute(item['sql'], item['values'])
            result.append({'meta': {'changes': max(0, cursor.rowcount)}})
        connection.commit()
    else:
        cursor = connection.execute(payload['sql'], payload.get('values', []))
        if mode == 'first':
            row = cursor.fetchone()
            result = dict(row) if row is not None else None
        elif mode == 'all':
            result = {'results': [dict(row) for row in cursor.fetchall()]}
        elif mode == 'run':
            result = {'meta': {'changes': max(0, cursor.rowcount)}}
        else:
            raise ValueError('Unsupported sqlite test mode')
        connection.commit()
    print(json.dumps(result, separators=(',', ':')))
except Exception:
    connection.rollback()
    raise
finally:
    connection.close()
`;

function sqliteCommand(databasePath, mode, payload) {
  const result = spawnSync('python3', ['-c', PYTHON_SQLITE, databasePath, mode], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `Python sqlite test command failed with ${result.status}.`);
  }
  return JSON.parse(result.stdout || 'null');
}

function mutates(sql) {
  return /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(String(sql));
}

class TestD1Statement {
  constructor(owner, sql, values = []) {
    this.owner = owner;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new TestD1Statement(this.owner, this.sql, values);
  }

  async first() {
    return sqliteCommand(this.owner.databasePath, 'first', { sql: this.sql, values: this.values });
  }

  async all() {
    return sqliteCommand(this.owner.databasePath, 'all', { sql: this.sql, values: this.values });
  }

  async run() {
    if (mutates(this.sql)) this.owner.writeAttempts += 1;
    return sqliteCommand(this.owner.databasePath, 'run', { sql: this.sql, values: this.values });
  }
}

class TestD1 {
  constructor(databasePath) {
    this.databasePath = databasePath;
    this.writeAttempts = 0;
    this.batchAttempts = 0;
    this.failNextBatchAt = null;
  }

  prepare(sql) {
    return new TestD1Statement(this, sql);
  }

  async batch(statements) {
    this.batchAttempts += 1;
    this.writeAttempts += statements.filter((statement) => mutates(statement.sql)).length;
    const serialized = statements.map((statement) => ({ sql: statement.sql, values: statement.values }));
    if (Number.isInteger(this.failNextBatchAt)) {
      serialized[this.failNextBatchAt] = { sql: 'INSERT INTO deliberately_missing_atomicity_table VALUES (1)', values: [] };
      this.failNextBatchAt = null;
    }
    return sqliteCommand(this.databasePath, 'batch', { statements: serialized });
  }
}

function replayMigrations(databasePath, maximum = '9999') {
  const migrationFiles = readdirSync(resolve(root, 'worker/migrations'))
    .filter((name) => name.endsWith('.sql') && name.slice(0, 4) <= maximum)
    .sort();
  const sql = migrationFiles.map((name) => readFileSync(
    resolve(root, 'worker/migrations', name),
    'utf8'
  )).join('\n');
  sqliteCommand(databasePath, 'script', { sql: `PRAGMA foreign_keys = ON;\n${sql}` });
  return migrationFiles;
}

function request(pathname, method = 'GET', body = undefined, headers = {}) {
  return new Request(`http://worker.test${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function callAuthoring(env, pathname, method = 'GET', body = undefined) {
  const response = await handleModuleCatalogueRequest(request(pathname, method, body), env, { pathname });
  return { response, payload: await response.json() };
}

function rowCount(databasePath, table, where = '', values = []) {
  return Number(sqliteCommand(databasePath, 'first', {
    sql: `SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`,
    values
  })?.count || 0);
}

function goal(type) {
  return { goalId: `goal-${type}`, type, title: type, priority: 'high', status: 'active' };
}

function profile(name, type, { persona = {}, liabilities = [], dependants = [] } = {}) {
  const base = createHouseholdProfile({
    profileId: `authoring-${name}`,
    nowIso: NOW,
    calculationDateIso: NOW.slice(0, 10)
  });
  return normalizeHouseholdProfile({
    ...base,
    revision: 1,
    primaryPerson: { ...base.primaryPerson, age: 45 },
    goals: [goal(type)],
    liabilities,
    dependants,
    assumptions: {
      ...base.assumptions,
      values: { ...base.assumptions.values, persona }
    }
  });
}

const mortgage = [{
  liabilityId: 'mortgage-1',
  ownerIds: ['primary'],
  type: 'mortgage',
  label: 'Home mortgage',
  currentBalance: { amount: 180_000, currency: 'EUR' },
  annualInterestRate: 0.04,
  remainingTermMonths: 240
}];
const dependant = [{
  dependantId: 'dep-1',
  name: 'Child',
  relationship: 'child',
  dateOfBirth: '2014-01-01'
}];
const profiles = {
  overall_position: profile('overall', 'understand_position'),
  homeowner_without_mortgage: profile('homeowner', 'understand_position', {
    persona: { propertyStatus: 'homeowner' }
  }),
  recorded_mortgage: profile('mortgage', 'understand_position', { liabilities: mortgage }),
  dependants_without_education_intent: profile('dependants', 'understand_position', {
    persona: { dependantCount: 1 },
    dependants: dependant
  }),
  explicit_education_intent: profile('education', 'understand_position', {
    persona: { educationFunding: true }
  }),
  home_purchase: profile('home-purchase', 'buy_home'),
  retirement: profile('retirement', 'retire'),
  unsupported_wealth_transfer: profile('wealth-transfer', 'transfer_wealth')
};

for (const [name, input] of Object.entries(profiles)) {
  const current = {
    buildGoalModulePlan: buildGoalModulePlan(input, { allowedModuleIds: ALL_MODULES }),
    recommendModules: recommendModules(input)
  };
  assert.deepEqual(current, fixture[name], `${name}: no-candidate routing changed`);
  assert.deepEqual(
    buildGoalModulePlan(input, {
      allowedModuleIds: ALL_MODULES,
      candidateManifest: MODULE_MANIFEST
    }),
    current.buildGoalModulePlan,
    `${name}: committed candidate plan differs from the optimized default`
  );
  assert.deepEqual(
    recommendModules(input, { candidateManifest: MODULE_MANIFEST }),
    current.recommendModules,
    `${name}: committed candidate recommendations differ from the optimized default`
  );
}

const authoredEntries = readdirSync(resolve(root, 'docs/modules'))
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => parseAuthoredModuleDocument(
    readFileSync(resolve(root, 'docs/modules', name), 'utf8'),
    `docs/modules/${name}`
  ));
assert.equal(authoredEntries.length, 15, 'the authored catalogue must contain all 15 modules');
for (const authored of authoredEntries) {
  const generated = MODULE_MANIFEST.find((entry) => entry.moduleId === authored.manifest.moduleId);
  assert.ok(generated, `${authored.manifest.moduleId}: absent from generated manifest`);
  assert.deepEqual(authored.manifest, Object.fromEntries(
    Object.keys(authored.manifest).map((key) => [key, generated[key]])
  ));
  assert.deepEqual(authored.prose, {
    purpose: generated.purpose,
    whenToUse: generated.whenToUse,
    whenNotToUse: generated.whenNotToUse,
    clientSignals: generated.clientSignals
  });
}

const approved = structuredClone(MODULE_MANIFEST.find((entry) => (
  entry.availability.platformConsumerApproved && entry.implementation.hasRunnableEngine
)));
for (const field of REQUIRED_CONSUMER_LANGUAGE_FIELDS) {
  const invalid = structuredClone(approved);
  delete invalid.consumerLanguage[field];
  assert.throws(
    () => validateModuleManifest(invalid, 'shared validator negative fixture'),
    new RegExp(`consumerLanguage\\.${field}`)
  );
}

const languageCandidate = structuredClone(MODULE_MANIFEST);
const candidateMortgage = languageCandidate.find((entry) => entry.moduleId === MODULE_IDS.MORTGAGE);
candidateMortgage.name = 'Candidate Mortgage Lens';
candidateMortgage.consumerLanguage.consumerOfferDescription = 'compare the recorded mortgage using candidate wording';
candidateMortgage.consumerLanguage.consumerShortLabel = 'compare the candidate mortgage wording';
candidateMortgage.consumerLanguage.consumerConfirmationDescription = 'compare the recorded mortgage with candidate wording';
languageCandidate.forEach((entry) => validateModuleManifest(entry, `candidate ${entry.moduleId}`));

assert.equal(getModuleManifest(MODULE_IDS.MORTGAGE, { candidateManifest: languageCandidate }).name,
  'Candidate Mortgage Lens');
assert.equal(listModuleManifests({ candidateManifest: languageCandidate }).length, 15);
assert.equal(
  consumerLanguageForModule(MODULE_IDS.MORTGAGE, { candidateManifest: languageCandidate }).shortDescription,
  'compare the candidate mortgage wording'
);
assert.equal(containsInternalModuleTerminology('Candidate Mortgage Lens', { candidateManifest: languageCandidate }), true);
assert.equal(containsInternalModuleTerminology('Candidate Mortgage Lens'), false);

const candidatePlan = buildGoalModulePlan(profiles.recorded_mortgage, {
  allowedModuleIds: ALL_MODULES,
  candidateManifest: languageCandidate
});
const candidateOffer = nextModuleOffer(candidatePlan, {
  profile: profiles.recorded_mortgage,
  candidateManifest: languageCandidate
});
assert.match(candidateOffer.spokenOffer, /candidate wording/i);
assert.equal(
  composeModuleOffer(candidatePlan.moduleOpportunities[0], {
    profile: profiles.recorded_mortgage,
    candidateManifest: languageCandidate
  }).shortDescription,
  'compare the candidate mortgage wording'
);

const selectedMortgage = buildGoalModulePlan(profile('mortgage-goal', 'optimise_mortgage'), {
  allowedModuleIds: ALL_MODULES,
  candidateManifest: languageCandidate
});
assert.match(
  confirmationSummary(selectedMortgage, { candidateManifest: languageCandidate }).spoken,
  /candidate wording/i
);

const gatedCandidate = structuredClone(languageCandidate);
const gatedMortgage = gatedCandidate.find((entry) => entry.moduleId === MODULE_IDS.MORTGAGE);
gatedMortgage.availability.consumer = false;
gatedMortgage.availability.platformConsumerApproved = false;
gatedMortgage.availability.adviserConsumerEnabled = false;
assert.equal(effectiveConsumerAvailability(MODULE_IDS.MORTGAGE, {
  candidateManifest: gatedCandidate
}).blockedBy, 'platform_consumer_approved');
assert.equal(buildGoalModulePlan(profiles.recorded_mortgage, {
  allowedModuleIds: ALL_MODULES,
  candidateManifest: gatedCandidate
}).moduleOpportunities.some((item) => item.moduleId === MODULE_IDS.MORTGAGE), false);

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'module-catalogue-authoring-'));
process.once('exit', () => rmSync(temporaryDirectory, { recursive: true, force: true }));

// Pre-deployment: the committed catalogue is still readable, while every
// draft path fails before parsing input, calling AI or attempting a write.
const preMigrationDatabasePath = join(temporaryDirectory, 'before-0016.sqlite');
const preMigrationFiles = replayMigrations(preMigrationDatabasePath, '0015');
assert.equal(preMigrationFiles.at(-1), '0015_add_client_source.sql');
const preMigrationDb = new TestD1(preMigrationDatabasePath);
let preMigrationAiCalls = 0;
const preMigrationEnv = {
  LEADS_DB: preMigrationDb,
  MODULE_CATALOGUE_AI_PROVIDER: async () => {
    preMigrationAiCalls += 1;
    throw new Error('AI must not be called before provisioning.');
  }
};
const preMigrationCatalogue = await callAuthoring(preMigrationEnv, '/api/advisor/modules');
assert.equal(preMigrationCatalogue.response.status, 200);
assert.equal(preMigrationCatalogue.payload.count, 15);
assert.equal(preMigrationCatalogue.payload.modules.length, 15);
assert.ok(preMigrationCatalogue.payload.modules.some((entry) => entry.moduleId === 'net_retirement_cashflow'));
assert.ok(preMigrationCatalogue.payload.modules.some((entry) => entry.implementation.status === 'template_only'));
assert.ok(preMigrationCatalogue.payload.modules.some((entry) => entry.implementation.status === 'routing_label'));
assert.ok(preMigrationCatalogue.payload.modules.some((entry) => entry.implementation.status === 'capability'));
assert.match(preMigrationCatalogue.response.headers.get('cache-control') || '', /no-store/);

const absentDraftId = 'module_draft_000000000000000000000000';
const unprovisionedRoutes = [
  ['/api/advisor/module-drafts', 'GET'],
  ['/api/advisor/module-drafts', 'POST'],
  [`/api/advisor/module-drafts/${absentDraftId}`, 'GET'],
  [`/api/advisor/module-drafts/${absentDraftId}`, 'PATCH'],
  [`/api/advisor/module-drafts/${absentDraftId}/generate`, 'POST'],
  [`/api/advisor/module-drafts/${absentDraftId}/validate`, 'POST'],
  [`/api/advisor/module-drafts/${absentDraftId}/preview`, 'POST'],
  [`/api/advisor/module-drafts/${absentDraftId}/export-patch`, 'POST']
];
for (const [pathname, method] of unprovisionedRoutes) {
  const result = await callAuthoring(preMigrationEnv, pathname, method);
  assert.equal(result.response.status, 503, `${method} ${pathname} did not fail closed before migration 0016`);
  assert.equal(result.payload.code, 'catalogue_authoring_not_provisioned');
  assert.equal(
    result.payload.message,
    'Catalogue authoring is not yet provisioned. Deploy Worker migration 0016_create_module_catalogue_drafts.sql.'
  );
  assert.match(result.response.headers.get('cache-control') || '', /no-store/);
}
assert.equal(preMigrationAiCalls, 0);
assert.equal(preMigrationDb.writeAttempts, 0);
assert.equal(preMigrationDb.batchAttempts, 0);
assert.deepEqual(sqliteCommand(preMigrationDatabasePath, 'all', {
  sql: "SELECT name FROM sqlite_master WHERE name LIKE 'module_catalogue_%' ORDER BY name",
  values: []
}).results, []);

// Defensive race mapping: provisioning can change between the table check and
// the operation, so a missing-table error must still become the same clean 503.
const raceMissingDb = {
  prepare(sql) {
    if (/sqlite_master/i.test(sql)) {
      return {
        bind() { return this; },
        async all() {
          return { results: [
            { name: 'module_catalogue_drafts' },
            { name: 'module_catalogue_validation_runs' },
            { name: 'module_catalogue_audit' }
          ] };
        }
      };
    }
    return {
      bind() { return this; },
      async all() { throw new Error('D1_ERROR: no such table: module_catalogue_drafts'); }
    };
  }
};
const racedMissing = await callAuthoring({ LEADS_DB: raceMissingDb }, '/api/advisor/module-drafts');
assert.equal(racedMissing.response.status, 503);
assert.equal(racedMissing.payload.code, 'catalogue_authoring_not_provisioned');

const genericFailureDb = {
  prepare() {
    return {
      bind() { return this; },
      async all() { throw new Error('sensitive sqlite connection detail'); }
    };
  }
};
const genericFailure = await callAuthoring({ LEADS_DB: genericFailureDb }, '/api/advisor/module-drafts');
assert.equal(genericFailure.response.status, 503);
assert.equal(genericFailure.payload.code, 'catalogue_authoring_temporarily_unavailable');
assert.doesNotMatch(JSON.stringify(genericFailure.payload), /sensitive sqlite/i);

// Provisioned: replay the complete adviser migration history into fresh SQLite
// in filename order, matching consumer-regression.yml.
const databasePath = join(temporaryDirectory, 'after-0016.sqlite');
const migrationFiles = replayMigrations(databasePath);
assert.equal(migrationFiles.at(-1), '0016_create_module_catalogue_drafts.sql');
assert.equal(migrationFiles.length, 16);
const authoringMigrationSource = readFileSync(
  resolve(root, 'worker/migrations/0016_create_module_catalogue_drafts.sql'),
  'utf8'
);
assert.doesNotMatch(authoringMigrationSource, /\bALTER\s+TABLE\b/i);
assert.doesNotMatch(authoringMigrationSource, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i);
assert.equal((authoringMigrationSource.match(/CREATE TABLE IF NOT EXISTS/g) || []).length, 3);
assert.equal((authoringMigrationSource.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 4);
const provisionedDb = new TestD1(databasePath);
let aiCalls = 0;
const provisionedEnv = {
  LEADS_DB: provisionedDb,
  MODULE_CATALOGUE_AI_PROVIDER: async () => {
    aiCalls += 1;
    return {
      summary: 'Structured recognition draft for review.',
      draftPayloadJson: JSON.stringify({
        summary: 'Recognise an existing need using a narrower client phrase.',
        parentModuleId: MODULE_IDS.MORTGAGE,
        recognitionSignals: ['My fixed rate is ending soon.']
      }),
      assumptions: [],
      questionsForReviewer: ['Should this remain mortgage-only?']
    };
  }
};

const manifestBeforeDrafts = JSON.stringify(MODULE_MANIFEST);
const promptBeforeDrafts = buildLiveCataloguePrompt();
const mortgageCandidate = structuredClone(MODULE_MANIFEST.find((entry) => entry.moduleId === MODULE_IDS.MORTGAGE));
mortgageCandidate.consumerLanguage.consumerOfferDescription = 'compare the recorded mortgage using reviewed candidate wording';
mortgageCandidate.consumerLanguage.consumerShortLabel = 'a reviewed candidate mortgage comparison';
mortgageCandidate.consumerLanguage.consumerConfirmationDescription = 'compare the recorded mortgage using reviewed candidate wording';
const candidateDraftShape = {
  kind: 'manifest_edit',
  moduleId: MODULE_IDS.MORTGAGE,
  payload: { manifest: mortgageCandidate }
};
assert.equal(buildCandidateManifest(candidateDraftShape).length, 15);
assert.equal(validateModuleDraft(candidateDraftShape).status, 'ready_for_patch');

const draftCountBeforeFault = rowCount(databasePath, 'module_catalogue_drafts');
const auditCountBeforeFault = rowCount(databasePath, 'module_catalogue_audit');
provisionedDb.failNextBatchAt = 1;
const atomicFailure = await callAuthoring(provisionedEnv, '/api/advisor/module-drafts', 'POST', candidateDraftShape);
assert.equal(atomicFailure.response.status, 503);
assert.equal(rowCount(databasePath, 'module_catalogue_drafts'), draftCountBeforeFault);
assert.equal(rowCount(databasePath, 'module_catalogue_audit'), auditCountBeforeFault);

const createdResult = await callAuthoring(provisionedEnv, '/api/advisor/module-drafts', 'POST', candidateDraftShape);
assert.equal(createdResult.response.status, 201);
let draft = createdResult.payload.draft;
assert.equal(draft.revision, 1);
assert.equal(draft.audit.length, 1);
assert.equal(draft.audit[0].action, 'created');
const draftId = draft.id;

const listResult = await callAuthoring(provisionedEnv, '/api/advisor/module-drafts');
assert.equal(listResult.response.status, 200);
assert.ok(listResult.payload.drafts.some((entry) => entry.id === draftId));
const readResult = await callAuthoring(provisionedEnv, `/api/advisor/module-drafts/${draftId}`);
assert.equal(readResult.payload.draft.id, draftId);

const updatedResult = await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${draftId}`,
  'PATCH',
  { revision: 1, payload: candidateDraftShape.payload }
);
assert.equal(updatedResult.response.status, 200);
draft = updatedResult.payload.draft;
assert.equal(draft.revision, 2);
assert.equal(draft.audit.length, 2);

const auditBeforeConflict = rowCount(databasePath, 'module_catalogue_audit', 'draft_id = ?', [draftId]);
const conflictResult = await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${draftId}`,
  'PATCH',
  { revision: 1, payload: candidateDraftShape.payload }
);
assert.equal(conflictResult.response.status, 409);
assert.equal(conflictResult.payload.code, 'draft_revision_conflict');
assert.equal(rowCount(databasePath, 'module_catalogue_audit', 'draft_id = ?', [draftId]), auditBeforeConflict);

const validationCountBeforeFault = rowCount(
  databasePath,
  'module_catalogue_validation_runs',
  'draft_id = ?',
  [draftId]
);
provisionedDb.failNextBatchAt = 2;
const atomicValidationFailure = await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${draftId}/validate`,
  'POST',
  { revision: 2 }
);
assert.equal(atomicValidationFailure.response.status, 503);
assert.equal(rowCount(databasePath, 'module_catalogue_validation_runs', 'draft_id = ?', [draftId]), validationCountBeforeFault);
assert.equal(rowCount(databasePath, 'module_catalogue_audit', 'draft_id = ?', [draftId]), auditBeforeConflict);
assert.equal((await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${draftId}`
)).payload.draft.status, 'draft');

const validatedResult = await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${draftId}/validate`,
  'POST',
  { revision: 2 }
);
assert.equal(validatedResult.response.status, 200);
assert.equal(validatedResult.payload.validation.status, 'ready_for_patch');
assert.equal(rowCount(databasePath, 'module_catalogue_validation_runs', 'draft_id = ?', [draftId]), 1);
assert.equal(validatedResult.payload.draft.status, 'ready_for_patch');

const previewResult = await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${draftId}/preview`,
  'POST',
  { profile: profiles.recorded_mortgage }
);
assert.equal(previewResult.response.status, 200);
assert.equal(previewResult.payload.previewUnavailableReason, undefined);
assert.equal(previewResult.payload.differences.consumerLanguage.changed, true);
assert.equal(
  previewResult.payload.candidate.consumerLanguage[MODULE_IDS.MORTGAGE]?.shortDescription,
  'a reviewed candidate mortgage comparison'
);

const auditBeforeExportFault = rowCount(databasePath, 'module_catalogue_audit', 'draft_id = ?', [draftId]);
provisionedDb.failNextBatchAt = 1;
const atomicExportFailure = await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${draftId}/export-patch`,
  'POST'
);
assert.equal(atomicExportFailure.response.status, 503);
assert.equal(rowCount(databasePath, 'module_catalogue_audit', 'draft_id = ?', [draftId]), auditBeforeExportFault);
assert.equal((await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${draftId}`
)).payload.draft.status, 'ready_for_patch');

const exportedResult = await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${draftId}/export-patch`,
  'POST'
);
assert.equal(exportedResult.response.status, 200);
assert.equal(exportedResult.payload.targetPath, 'docs/modules/mortgage_analysis.md');
assert.match(exportedResult.payload.manifestJsonBlock, /reviewed candidate wording/);
assert.match(exportedResult.payload.applyPatch, /\*\*\* Update File: docs\/modules\/mortgage_analysis\.md/);
assert.equal(exportedResult.payload.draft.status, 'exported_for_review');
assert.ok(exportedResult.payload.requiredVerificationCommands.includes('npm run check:module-manifest'));

const patchArtifact = buildModulePatchExport({ ...candidateDraftShape, id: draftId, revision: 2 });
assert.equal(patchArtifact.targetPath, 'docs/modules/mortgage_analysis.md');
assert.equal(patchArtifact.applyPatch, exportedResult.payload.applyPatch);

const staleUpdate = await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${draftId}`,
  'PATCH',
  { revision: 2, payload: candidateDraftShape.payload }
);
assert.equal(staleUpdate.response.status, 200);
assert.equal(staleUpdate.payload.draft.revision, 3);
const staleExport = await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${draftId}/export-patch`,
  'POST'
);
assert.equal(staleExport.response.status, 409);
assert.equal(staleExport.payload.code, 'stale_validation');

// Specification states are scoped: recognised-but-unsupported goals are
// valid, while a consumer-active proposal needs a real ready direct module.
const recognitionValidation = validateModuleDraft({
  kind: 'recognition_variant',
  moduleId: MODULE_IDS.MORTGAGE,
  payload: {
    summary: 'Recognise a fixed-rate expiry as a mortgage planning signal.',
    parentModuleId: MODULE_IDS.MORTGAGE,
    recognitionSignals: ['My fixed rate ends this year.']
  }
});
assert.equal(recognitionValidation.status, 'specification_valid');
const engineValidation = validateModuleDraft({
  kind: 'new_engine',
  moduleId: 'income_protection_analysis',
  payload: {
    summary: 'Specify a future income protection engine.',
    goalTypes: ['assess_decision']
  }
});
assert.equal(engineValidation.status, 'specification_valid');
assert.ok(engineValidation.findings.warnings.some((finding) => finding.code === 'engine_not_registered'));
const unsupportedGoalValidation = validateModuleDraft({
  kind: 'new_goal',
  payload: {
    summary: 'Recognise a protection concern without claiming current support.',
    goalType: 'protect_income',
    consumerActive: false
  }
});
assert.equal(unsupportedGoalValidation.status, 'specification_valid');
const activeGoalValidation = validateModuleDraft({
  kind: 'new_goal',
  payload: {
    summary: 'Propose a consumer-active goal without a ready direct route.',
    goalType: 'protect_income',
    consumerActive: true,
    directModuleId: 'income_protection_analysis'
  }
});
assert.equal(activeGoalValidation.status, 'invalid');
assert.ok(activeGoalValidation.findings.errors.some(
  (finding) => finding.code === 'consumer_active_goal_without_direct_analysis'
));
assert.doesNotThrow(() => validateModuleDraft(candidateDraftShape));

const recognitionCreated = await callAuthoring(provisionedEnv, '/api/advisor/module-drafts', 'POST', {
  kind: 'recognition_variant',
  moduleId: MODULE_IDS.MORTGAGE,
  payload: {
    summary: 'Initial recognition specification.',
    parentModuleId: MODULE_IDS.MORTGAGE,
    recognitionSignals: ['Initial phrase.']
  }
});
const recognitionDraft = recognitionCreated.payload.draft;
const recognitionAuditBeforeFault = rowCount(
  databasePath,
  'module_catalogue_audit',
  'draft_id = ?',
  [recognitionDraft.id]
);
provisionedDb.failNextBatchAt = 1;
const atomicGenerationFailure = await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${recognitionDraft.id}/generate`,
  'POST',
  { revision: recognitionDraft.revision, brief: 'Exercise AI mutation rollback.' }
);
assert.equal(atomicGenerationFailure.response.status, 503);
assert.equal((await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${recognitionDraft.id}`
)).payload.draft.revision, 1);
assert.equal(
  rowCount(databasePath, 'module_catalogue_audit', 'draft_id = ?', [recognitionDraft.id]),
  recognitionAuditBeforeFault
);
const generatedResult = await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${recognitionDraft.id}/generate`,
  'POST',
  { revision: recognitionDraft.revision, brief: 'Add the fixed-rate expiry wording for review.' }
);
assert.equal(generatedResult.response.status, 200);
assert.equal(aiCalls, 2);
assert.equal(generatedResult.payload.draft.revision, 2);
assert.equal(generatedResult.payload.draft.audit[0].action, 'ai_generated');
assert.equal(generatedResult.payload.draft.status, 'draft');

const noAiResult = await callAuthoring(
  { LEADS_DB: provisionedDb },
  `/api/advisor/module-drafts/${recognitionDraft.id}/generate`,
  'POST',
  { revision: 2, brief: 'This must fail without provider configuration.' }
);
assert.equal(noAiResult.response.status, 503);
assert.equal(noAiResult.payload.code, 'catalogue_ai_not_configured');
assert.equal((await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${recognitionDraft.id}`
)).payload.draft.revision, 2);

const specPreview = await callAuthoring(
  provisionedEnv,
  `/api/advisor/module-drafts/${recognitionDraft.id}/preview`,
  'POST',
  { profile: profiles.recorded_mortgage }
);
assert.match(specPreview.payload.previewUnavailableReason, /only for an existing registered-module manifest edit/i);

assert.equal(JSON.stringify(MODULE_MANIFEST), manifestBeforeDrafts);
assert.equal(buildLiveCataloguePrompt(), promptBeforeDrafts);

// Full Worker smoke: origin, adviser login, CSRF, no-store, preflight and the
// route-specific persistent rate limit all execute through the actual entry point.
const workerEnv = {
  LEADS_DB: provisionedDb,
  ADVISOR_PASSWORD: 'module-catalogue-test-password',
  ADVISOR_SESSION_SECRET: 'module-catalogue-test-session-secret-with-sufficient-entropy'
};
const workerContext = { waitUntil() {} };
function workerRequest(pathname, {
  method = 'GET',
  body = undefined,
  origin = 'http://localhost:3000',
  ip = '198.51.100.10',
  cookie = '',
  csrf = ''
} = {}) {
  const headers = new Headers({ Origin: origin, 'CF-Connecting-IP': ip });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  if (csrf) headers.set('X-Advisor-CSRF', csrf);
  return new Request(`http://localhost:8787${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

const untrusted = await worker.fetch(workerRequest('/api/advisor/modules', {
  origin: 'https://attacker.invalid',
  ip: '198.51.100.11'
}), workerEnv, workerContext);
assert.equal(untrusted.status, 403);
assert.match(untrusted.headers.get('cache-control') || '', /no-store/);

const unauthenticated = await worker.fetch(workerRequest('/api/advisor/modules', {
  ip: '198.51.100.12'
}), workerEnv, workerContext);
assert.equal(unauthenticated.status, 401);
assert.match(unauthenticated.headers.get('cache-control') || '', /no-store/);

const loginResponse = await worker.fetch(workerRequest('/api/auth/login', {
  method: 'POST',
  body: { password: workerEnv.ADVISOR_PASSWORD },
  ip: '198.51.100.13'
}), workerEnv, workerContext);
assert.equal(loginResponse.status, 200);
const loginPayload = await loginResponse.json();
const cookie = String(loginResponse.headers.get('set-cookie') || '').split(';')[0];
assert.match(cookie, /^planeir_advisor_session=/);
assert.match(loginPayload.csrfToken, /^[A-Za-z0-9_-]{32,}$/);

const authenticatedCatalogue = await worker.fetch(workerRequest('/api/advisor/modules', {
  cookie,
  ip: '198.51.100.13'
}), workerEnv, workerContext);
assert.equal(authenticatedCatalogue.status, 200);
assert.equal((await authenticatedCatalogue.json()).modules.length, 15);
assert.match(authenticatedCatalogue.headers.get('cache-control') || '', /no-store/);

const missingCsrf = await worker.fetch(workerRequest('/api/advisor/module-drafts', {
  method: 'POST',
  body: {
    kind: 'new_goal',
    payload: { summary: 'CSRF negative fixture.', goalType: 'csrf_fixture', consumerActive: false }
  },
  cookie,
  ip: '198.51.100.13'
}), workerEnv, workerContext);
assert.equal(missingCsrf.status, 403);
assert.match(missingCsrf.headers.get('cache-control') || '', /no-store/);

const withCsrf = await worker.fetch(workerRequest('/api/advisor/module-drafts', {
  method: 'POST',
  body: {
    kind: 'new_goal',
    payload: { summary: 'Authenticated creation fixture.', goalType: 'auth_fixture', consumerActive: false }
  },
  cookie,
  csrf: loginPayload.csrfToken,
  ip: '198.51.100.13'
}), workerEnv, workerContext);
assert.equal(withCsrf.status, 201);

const preflight = await worker.fetch(workerRequest('/api/advisor/module-drafts', {
  method: 'OPTIONS',
  ip: '198.51.100.14'
}), workerEnv, workerContext);
assert.equal(preflight.status, 204);
assert.match(preflight.headers.get('cache-control') || '', /no-store/);

let rateLimitedResponse = null;
for (let attempt = 1; attempt <= 41; attempt += 1) {
  rateLimitedResponse = await worker.fetch(workerRequest('/api/advisor/modules', {
    cookie,
    ip: '198.51.100.15'
  }), workerEnv, workerContext);
  if (attempt <= 40) assert.equal(rateLimitedResponse.status, 200);
}
assert.equal(rateLimitedResponse.status, 429);
assert.match(rateLimitedResponse.headers.get('cache-control') || '', /no-store/);

console.info('[ModuleCatalogueAuthoring] PASS: shared validator and authored catalogue match the build.');
console.info('[ModuleCatalogueAuthoring] PASS: no-candidate routing matches all eight frozen identity profiles.');
console.info('[ModuleCatalogueAuthoring] PASS: candidate routing, availability, language and terminology are fully isolated.');
console.info('[ModuleCatalogueAuthoring] PASS: migration 0016 replays after all 15 existing adviser migrations.');
console.info('[ModuleCatalogueAuthoring] PASS: unprovisioned draft routes fail cleanly before writes or AI calls.');
console.info('[ModuleCatalogueAuthoring] PASS: draft revision, validation, preview, export and audit writes are atomic.');
console.info('[ModuleCatalogueAuthoring] PASS: specifications, scoped goals, stale validation and AI draft-only generation are enforced.');
console.info('[ModuleCatalogueAuthoring] PASS: Worker authentication, trusted origin, CSRF, rate limits and no-store are enforced.');
