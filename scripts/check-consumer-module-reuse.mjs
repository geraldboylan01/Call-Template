import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  applyProfilePatch,
  createHouseholdProfile,
  extractRulesOnlyProfilePatch,
  runConsumerAnalysis
} from '../js/planning/index.js';
import {
  buildConsumerModuleCacheKey,
  createConsumerModuleCachePayload,
  findReusableConsumerModuleRun
} from '../worker/src/consumer/repository.js';
import { encryptJson, stableStringify } from '../worker/src/consumer/crypto.js';

const NOW = '2026-07-14T12:00:00.000Z';
const CALCULATION_DATE = '2026-07-14';

function homeProfile() {
  const empty = createHouseholdProfile({
    profileId: 'profile-module-reuse',
    nowIso: NOW,
    calculationDateIso: CALCULATION_DATE
  });
  const extraction = extractRulesOnlyProfilePatch(
    "I'm 34, earn €80k a year and have €50k in savings. I spend €2,500 a month and pay €1,500 rent. I'm a first-time buyer and want to buy a house for about €400k by 2028. I save €1,200 a month.",
    { profile: empty, capturedAt: NOW, conversationTurnId: 'turn-reuse' }
  );
  return applyProfilePatch(empty, extraction.patch, { nowIso: NOW }).profile;
}

function replace(profile, path, value) {
  return applyProfilePatch(profile, {
    patchId: `patch-${crypto.randomUUID()}`,
    operations: [{
      op: 'replace',
      path,
      value,
      provenance: {
        source: 'user_statement',
        confidence: 'high',
        certainty: 'exact',
        capturedAt: NOW,
        confirmedByUser: true
      }
    }]
  }, { nowIso: NOW }).profile;
}

function add(profile, path, value) {
  return applyProfilePatch(profile, {
    patchId: `patch-${crypto.randomUUID()}`,
    operations: [{
      op: 'add',
      path,
      value,
      provenance: {
        source: 'user_statement',
        confidence: 'high',
        certainty: 'exact',
        capturedAt: NOW,
        confirmedByUser: true
      }
    }]
  }, { nowIso: NOW }).profile;
}

const memoryCache = new Map();
const cacheKey = (identity) => stableStringify(identity);

async function runWithMemoryCache(profile, options = {}) {
  const executions = [];
  const result = await runConsumerAnalysis({
    profile,
    moduleIds: ['house_purchase'],
    calculatedAt: NOW,
    calculationVersion: options.calculationVersion,
    scenarioOverrides: options.scenarioOverrides || {},
    resolveReusableModuleResult: (identity) => memoryCache.get(cacheKey(identity)) || null,
    onModuleResult: (execution) => {
      executions.push(execution);
      if (!execution.reused) memoryCache.set(cacheKey(execution.cacheIdentity), execution.result);
    }
  });
  assert.equal(result.analysisPlan.status, 'complete');
  return { result, executions };
}

const baseProfile = homeProfile();
const first = await runWithMemoryCache(baseProfile);
assert.deepEqual(first.executions.map(({ moduleId, reused }) => [moduleId, reused]), [
  ['liquidity_analysis', false],
  ['house_purchase', false]
]);

const correctedProfile = replace(baseProfile, '/goals/0/targetAmount/amount', 425_000);
const corrected = await runWithMemoryCache(correctedProfile);
assert.deepEqual(corrected.executions.map(({ moduleId, reused }) => [moduleId, reused]), [
  ['liquidity_analysis', true],
  ['house_purchase', false]
], 'a target-price correction must reuse liquidity but rerun house purchase');

const exactRepeat = await runWithMemoryCache(correctedProfile);
assert.deepEqual(exactRepeat.executions.map(({ moduleId, reused }) => [moduleId, reused]), [
  ['liquidity_analysis', true],
  ['house_purchase', true]
], 'an exact deterministic match must reuse both module runs');

const changedScenario = await runWithMemoryCache(correctedProfile, {
  scenarioOverrides: { house_purchase: { plannedMonthlySavings: 2_000 } }
});
assert.deepEqual(changedScenario.executions.map(({ moduleId, reused }) => [moduleId, reused]), [
  ['liquidity_analysis', true],
  ['house_purchase', false]
], 'a changed module scenario must not reuse that module');

const warningOnlyReadinessChange = add(correctedProfile, '/assets/-', {
  assetId: 'sterling-cash',
  ownerIds: ['primary'],
  type: 'cash',
  label: 'Sterling cash',
  currentValue: { amount: 1_000, currency: 'GBP' },
  liquid: true
});
const readinessChanged = await runWithMemoryCache(warningOnlyReadinessChange);
assert.equal(
  readinessChanged.executions.find(({ moduleId }) => moduleId === 'liquidity_analysis')?.reused,
  false,
  'readiness/warning changes must invalidate reuse even when the EUR engine input is unchanged'
);

const calculationVersionChanged = await runWithMemoryCache(correctedProfile, {
  calculationVersion: 'consumer-calculation-isolation-test'
});
assert.ok(calculationVersionChanged.executions.every(({ reused }) => reused === false));

class ModuleRunQueryDb {
  constructor(rows) {
    this.rows = rows;
  }

  prepare(sql) {
    assert.match(sql, /WHERE mr\.session_id = \?/);
    return {
      bind: (sessionId, moduleId, moduleVersion, calculationVersion, inputSnapshotHash) => ({
        all: async () => ({
          results: this.rows.filter((row) => row.session_id === sessionId
            && row.module_id === moduleId
            && row.module_version === moduleVersion
            && row.calculation_version === calculationVersion
            && row.input_snapshot_hash_b64u === inputSnapshotHash
            && row.status === 'complete'
            && ['complete', 'partial'].includes(row.analysis_status)
            && row.session_active === true)
        })
      })
    };
  }
}

const persistedExecution = corrected.executions.find(({ moduleId }) => moduleId === 'house_purchase');
assert.ok(persistedExecution && !persistedExecution.reused);
const identity = persistedExecution.cacheIdentity;
const result = persistedExecution.result;
const sessionId = 'cs_module_cache_session_000001';
const rowId = 'module_cache_row_1';
const encryptionKey = crypto.randomBytes(32).toString('base64url');
const key = await buildConsumerModuleCacheKey(identity);
const baseEnv = {
  CONSUMER_DATA_ENCRYPTION_KEY: encryptionKey,
  CONSUMER_DATA_ENCRYPTION_KEY_ID: 'module-cache-test-v1'
};
const encrypted = await encryptJson(
  baseEnv,
  createConsumerModuleCachePayload(identity, result),
  `consumer/module/${sessionId}/${rowId}`
);
const validRow = {
  id: rowId,
  session_id: sessionId,
  module_id: identity.moduleId,
  module_version: identity.moduleVersion,
  calculation_version: identity.calculationVersion,
  input_snapshot_hash_b64u: key,
  status: 'complete',
  analysis_status: 'complete',
  session_active: true,
  payload_encrypted: encrypted,
  created_at: NOW
};

const validEnv = { ...baseEnv, CONSUMER_DB: new ModuleRunQueryDb([validRow]) };
assert.deepEqual(await findReusableConsumerModuleRun(validEnv, sessionId, identity), result);
assert.equal(
  await findReusableConsumerModuleRun(validEnv, 'cs_other_session_0000000001', identity),
  null,
  'module results must never cross consumer sessions'
);

const changedVersionIdentity = { ...identity, calculationVersion: 'other-calculation-version' };
assert.equal(await findReusableConsumerModuleRun(validEnv, sessionId, changedVersionIdentity), null);
const changedModuleVersionIdentity = { ...identity, moduleVersion: `${identity.moduleVersion}-next` };
assert.equal(await findReusableConsumerModuleRun(validEnv, sessionId, changedModuleVersionIdentity), null);
const changedReadinessIdentity = { ...identity, readinessSnapshotHash: `${identity.readinessSnapshotHash}-changed` };
assert.equal(await findReusableConsumerModuleRun(validEnv, sessionId, changedReadinessIdentity), null);
const changedScenarioIdentity = { ...identity, scenarioSnapshotHash: `${identity.scenarioSnapshotHash}-changed` };
assert.equal(await findReusableConsumerModuleRun(validEnv, sessionId, changedScenarioIdentity), null);

const tamperedEnv = {
  ...baseEnv,
  CONSUMER_DB: new ModuleRunQueryDb([{ ...validRow, payload_encrypted: `${encrypted}tampered` }])
};
assert.equal(
  await findReusableConsumerModuleRun(tamperedEnv, sessionId, identity),
  null,
  'an unreadable encrypted cache entry must be isolated and recomputed'
);

const mismatchedPayload = await encryptJson(
  baseEnv,
  createConsumerModuleCachePayload(
    { ...identity, moduleVersion: `${identity.moduleVersion}-tampered` },
    result
  ),
  `consumer/module/${sessionId}/${rowId}`
);
const metadataTamperedEnv = {
  ...baseEnv,
  CONSUMER_DB: new ModuleRunQueryDb([{ ...validRow, payload_encrypted: mismatchedPayload }])
};
assert.equal(
  await findReusableConsumerModuleRun(metadataTamperedEnv, sessionId, identity),
  null,
  'encrypted cache metadata must match the indexed row identity'
);

console.log('Consumer deterministic module reuse, invalidation, isolation, and tamper checks passed.');
