import { applicationToProfile, APPLICATION_PROFILE_MAPPING_VERSION } from '../application_to_profile.js';
import { profileToPlanPack } from '../profile_to_plan_pack.js';
import { compilePlanPack, PLAN_PACK_VERSIONS } from '../plan_pack/compiler.js';
import { assertIsoDate, assertIsoDateTime, sha256Json, stableStringify } from '../utils.js';
import { ANALYST_VERSION, RUN_LIMITS, refused } from './contracts.js';
import { compiledFacts } from './facts.js';

const versions = () => ({ ...PLAN_PACK_VERSIONS, tools: ANALYST_VERSION, applicationMapping: APPLICATION_PROFILE_MAPPING_VERSION });
const safeId = (value, path) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw Object.assign(new Error('Use a safe request/run identifier.'), { path });
  }
  return value;
};

/** A confirmed export, never the latest editable payload. No clocks or I/O. */
export async function createCaseFile({ requestId, runId, revision, confirmedRevision, confirmedAt,
  calculationDate, information, clientLabel, notes = [], previousRun = null }) {
  safeId(requestId, '/requestId'); safeId(runId, '/runId');
  if (!Number.isInteger(confirmedRevision) || confirmedRevision < 1 || revision !== confirmedRevision) {
    throw Object.assign(new Error('Use the saved confirmed payload with its matching revision; unconfirmed edits cannot enter a run.'), { path: '/confirmedRevision' });
  }
  if (previousRun !== null) {
    if (!previousRun || typeof previousRun !== 'object' || Array.isArray(previousRun)
      || Object.keys(previousRun).some(key => !['runId', 'confirmedRevision'].includes(key))
      || !Number.isInteger(previousRun.confirmedRevision) || previousRun.confirmedRevision < 1
      || previousRun.confirmedRevision >= confirmedRevision || previousRun.runId === runId) {
      throw Object.assign(new Error('Link only the stopped run ID and its earlier confirmed revision; its calculations cannot enter this run.'), { path: '/previousRun' });
    }
    safeId(previousRun.runId, '/previousRun/runId');
  }
  assertIsoDateTime(confirmedAt, 'confirmedAt');
  const date = assertIsoDate(calculationDate ?? confirmedAt.slice(0, 10), 'calculationDate');
  const profile = applicationToProfile(information, { revision: confirmedRevision, confirmedAt, calculationDateIso: date });
  let compilerRuns = 0;
  const beforeCompile = () => {
    if (compilerRuns >= RUN_LIMITS.compilerRuns) throw Object.assign(new Error('The plan has used its engine runs.'), { code: 'budget_exceeded', path: '/budget/compilerRuns' });
    compilerRuns++;
  };
  const assembly = await profileToPlanPack(profile, { confirmedRevision, calculationDate: date, clientLabel, beforeCompile });
  if (!assembly.planPack) throw Object.assign(new Error('The confirmed form cannot become a plan.'), { path: '/information', diagnostics: assembly.missingFacts });
  const compiled = await compilePlanPack(assembly.planPack, { ...assembly.compileOptions, beforeCompile });
  if (compiled.status !== 'compiled') throw Object.assign(new Error('The current position could not compile.'), { path: '/currentPosition', diagnostics: compiled.diagnostics });
  const pinned = JSON.parse(JSON.stringify({ requestId, runId, confirmedRevision, confirmedAt, calculationDate: date,
    information, profile, planningFacts: assembly.planPack.planningInputs, notes, previousRun,
    versions: versions(), planPack: assembly.planPack, currentPosition: compiled,
    missingFacts: assembly.missingFacts, omittedChapters: assembly.omittedChapters, provenance: assembly.provenance }));
  const facts = compiledFacts(compiled, 'current');
  return {
    caseFileVersion: 1, pinned, pinHash: await sha256Json(pinned),
    factRegistry: { current: facts.registry }, routeDrafts: {}, pricedRoutes: {}, storyDrafts: {},
    whatifs: {}, checkerReports: [], taskList: [], reviewStatus: 'pending',
    // The initial bridge preflights and current-position compilation consume
    // the same compiler budget as subsequent tool calls.
    budget: { pricingCalls: 0, compilerRuns, whatifsByRoute: {} },
    runLog: [{ sequence: 1, tool: 'create_case', input: { confirmedRevision, calculationDate: date },
      result: { ok: true, status: 'ok', sourceHash: compiled.source.hash, versions: pinned.versions } }]
  };
}

export async function caseRefusal(caseFile) {
  if (caseFile?.caseFileVersion !== 1 || !caseFile.pinned) return refused('invalid_case', '/caseFileVersion', 'Use an analyst case file.');
  if (await sha256Json(caseFile.pinned) !== caseFile.pinHash) return refused('changed_snapshot', '/pinned', 'The pinned inputs or calculations have changed; create a new run.');
  if (stableStringify(caseFile.pinned.versions) !== stableStringify(versions())) {
    return refused('version_mismatch', '/pinned/versions', 'Restore this run’s tool and rule versions, or create a new run.');
  }
  return null;
}
