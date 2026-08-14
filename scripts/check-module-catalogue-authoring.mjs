import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

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

const root = resolve(new URL('..', import.meta.url).pathname);
const fixture = JSON.parse(readFileSync(
  resolve(root, 'scripts/fixtures/module-catalogue-authoring-identity.json'),
  'utf8'
));
const NOW = '2026-08-01T09:00:00.000Z';
const ALL_MODULES = Object.values(MODULE_IDS);

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

console.info('[ModuleCatalogueAuthoring] PASS: shared validator and authored catalogue match the build.');
console.info('[ModuleCatalogueAuthoring] PASS: no-candidate routing matches all eight frozen identity profiles.');
console.info('[ModuleCatalogueAuthoring] PASS: candidate routing, availability, language and terminology are fully isolated.');
