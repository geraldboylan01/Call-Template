#!/usr/bin/env node

/**
 * WHAT THE AUDITOR IS TOLD THE CLIENT DID NOT SUPPLY.
 *
 * `materialAssumptions` is the server's own list of the values THIS calculation
 * rests on that the client never gave. It is the floor the read-back has to
 * clear, and it is handed to the independent verifier, so a defect in it is a
 * defect in what the client is asked to confirm.
 *
 * TWO DEFECTS THIS PINS, both found by independent audit of the first-20 work.
 *
 * 1. THE FLOOR DEPENDED ON A REPRESENTATION THE CLIENT CANNOT SEE. The module
 *    row carries `authoredInput` only when it differs from the canonical input,
 *    and the floor required that field. A liquidity plan already written in
 *    canonical shape therefore received NO reserve assumptions, while an
 *    equivalent itemized one received them. Same client, same money, different
 *    confirmation, decided by whether the normalizer had to expand anything.
 *
 * 2. A RECORD-LEVEL QUOTE WAS TREATED AS SOURCE ATTRIBUTION FOR EVERYTHING
 *    INSIDE IT. Evidence at `/pensions/0` quotes the words that establish a
 *    pension exists. It says nothing about who chose the State Pension start
 *    age. Accepting the parent pointer let one owner-and-age quote withhold
 *    four genuine server defaults from the floor -- so the read-back could
 *    present a Planéir assumption as though the client had supplied it, which
 *    is the exact false claim the verifier refuses college plans for.
 *
 * Record existence and leaf source attribution are different claims. Only a
 * citation AT the path is attribution for the value at that path.
 */
import assert from 'node:assert/strict';

import {
  interpretDirectModuleConversation,
  MODULE_PLANNING_SNAPSHOT_V1,
  DIRECT_MODULE_CONTRACTS
} from '../worker/src/consumer/direct_module_planner.js';
import { buildDirectModulePolicyEnvelope, directModulePolicyEntries } from '../js/planning/direct_module_policy.js';
import { readJsonPointer, stableStringify } from '../js/planning/utils.js';
import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';

let checks = 0;
const pass = (message) => { checks += 1; console.info(`[AssumptionFloor] PASS: ${message}`); };

const DATE = new Date().toISOString().slice(0, 10);
const POLICY = buildDirectModulePolicyEnvelope({ calculationDateIso: DATE, baseCurrency: 'EUR' });
const PROFILE = {
  revision: 1,
  assumptions: { calculationDateIso: DATE, values: {} },
  preferences: { baseCurrency: 'EUR' }
};
const VERDICT = {
  schemaVersion: 'ModuleInputVerificationV1',
  verdict: 'pass',
  unsupportedPaths: [], omittedSupportedInformation: [], unresolvedAmbiguities: [],
  clarifications: [], confirmationPromptApproved: true, explanation: 'scripted pass'
};

/** Drive the real interpreter and capture the floor the verifier is handed. */
async function floorFor({ moduleId, input, evidence, transcript }) {
  // Disclose every applied contract default, exactly as a correct proposal must:
  // an undisclosed one is refused separately and would mask what is under test.
  const assumptions = directModulePolicyEntries(moduleId, input, POLICY)
    .filter((entry) => entry.mode === 'default')
    .filter((entry) => {
      const actual = readJsonPointer(input, entry.path);
      return actual === undefined || stableStringify(actual) === stableStringify(entry.value);
    })
    .map((entry) => ({ path: entry.path, source: entry.source, valueJson: JSON.stringify(entry.value) }));
  const turns = [{ id: 't1', role: 'user', transcript, answersTurnId: null }];
  const snapshot = {
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: 0,
    throughTurnId: 't1',
    modules: [{
      moduleId,
      outputKey: DIRECT_MODULE_CONTRACTS[moduleId].outputKey,
      status: 'ready',
      selection: { origin: 'client_requested', reason: 'you asked for it' },
      inputJson: JSON.stringify(input),
      steeringSummary: 'summary', missing: [], ambiguities: [],
      assumptions,
      evidence
    }],
    generalAmbiguities: [],
    confirmationPrompt: 'Shall I run exactly that?'
  };
  const bodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    const envelope = JSON.parse(body.input?.[1]?.content || '{}');
    bodies.push(envelope);
    const verifying = body.text?.format?.name === 'module_input_verification_v1';
    return { ok: true, json: async () => ({
      status: 'completed',
      output_text: JSON.stringify(verifying ? VERDICT : snapshot),
      usage: { input_tokens: 10, output_tokens: 1 }
    }) };
  };
  try {
    const result = await interpretDirectModuleConversation({
      env: { OPENAI_API_KEY: 'synthetic', CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') },
      config: {
        allowedModules: [moduleId],
        modulePlannerModel: 'scripted', modulePlannerTimeoutMs: 30_000,
        modulePlannerReasoningEffort: 'low',
        modulePlannerPromptVersion: 'v', moduleVerifierPromptVersion: 'v'
      },
      turns,
      throughTurnId: 't1',
      previousSnapshot: null,
      currentProfileContext: PROFILE
    });
    const verifierEnvelope = bodies.find((item) => item.materialAssumptions !== undefined);
    const row = result.snapshot.modules.find((item) => item.moduleId === moduleId);
    return {
      row,
      paths: (verifierEnvelope?.materialAssumptions || [])
        .flatMap((item) => item.assumptions.map((entry) => entry.path))
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/* --------- the floor cannot depend on a representation the client cannot see */

const LIQUIDITY_TRANSCRIPT = 'I have 33000 in cash and we spend about 3200 a month. I am working. '
  + 'That is all the cash, and I am not counting the house or the pension.';
const liquidity = directModuleTestInputs(DATE).liquidity_analysis;
const liquidityEvidence = Object.keys(liquidity)
  .filter((key) => !['policyVersion', 'minimumBufferMonths', 'targetBufferMonths'].includes(key))
  .map((key) => ({ path: `/${key}`, source: 'conversation', turnId: 't1', quote: LIQUIDITY_TRANSCRIPT, profilePath: '' }));

const canonical = await floorFor({
  moduleId: 'liquidity_analysis',
  input: liquidity,
  evidence: liquidityEvidence,
  transcript: LIQUIDITY_TRANSCRIPT
});
assert.equal(canonical.row.status, 'ready');
assert.equal(canonical.row.authoredInput, undefined,
  'this is the shape that used to lose its floor: authored input equals canonical, so the field is omitted');
assert.deepEqual(
  canonical.paths.filter((path) => /Buffer/.test(path)).sort(),
  ['/minimumBufferMonths', '/targetBufferMonths'],
  'a canonical proposal still owes the client its reserve assumptions'
);
pass('a proposal the normalizer did not have to expand keeps its assumption floor');

/* ------------- a record quote establishes the record, not its every field --- */

const pension = directModuleTestInputs(DATE).pension_projection;
const PENSION_TRANSCRIPT = 'Aoife is 40 and Ben is 41, and we want to look at our pensions.';
// The household fields carry ordinary leaf citations. The PENSION RECORDS carry
// only a record-level citation, and its quote is owners and ages -- nothing in
// it establishes a State Pension choice for anybody.
const householdEvidence = Object.keys(pension)
  .filter((key) => key !== 'pensions')
  .map((key) => ({ path: `/${key}`, source: 'conversation', turnId: 't1', quote: PENSION_TRANSCRIPT, profilePath: '' }));
const recordOnly = [
  ...householdEvidence,
  ...pension.pensions.map((_member, index) => ({
    path: `/pensions/${index}`, source: 'conversation', turnId: 't1', quote: PENSION_TRANSCRIPT, profilePath: ''
  }))
];
const parentOnly = await floorFor({
  moduleId: 'pension_projection',
  input: pension,
  evidence: recordOnly,
  transcript: PENSION_TRANSCRIPT
});
assert.equal(parentOnly.row.status, 'ready', 'the proposal under test must actually reach the auditor');
const statePensionPaths = parentOnly.paths.filter((path) => /statePension|includeStatePension/i.test(path));
assert.equal(statePensionPaths.length, 4,
  'both members owe both of their State Pension defaults: a parent pointer is not source attribution');
pass('a record-level citation no longer withholds the defaults inside that record');

/* ------------------- a citation AT the path is attribution, and suppresses -- */

const leafCited = await floorFor({
  moduleId: 'pension_projection',
  input: pension,
  evidence: [
    ...recordOnly,
    { path: '/pensions/0/statePensionStartAge', source: 'conversation', turnId: 't1', quote: 'Aoife is 40', profilePath: '' }
  ],
  transcript: PENSION_TRANSCRIPT
});
assert.ok(
  !leafCited.paths.includes('/pensions/0/statePensionStartAge'),
  'a value the client is cited as supplying is their answer, and must not be read back as an assumption'
);
assert.ok(
  leafCited.paths.includes('/pensions/1/statePensionStartAge'),
  'and the other member, who supplied nothing, still owes it'
);
pass('a leaf citation is source attribution and removes that one value from the floor');

/* -------------------------- a value the client changed is not an assumption - */

const overridden = await floorFor({
  moduleId: 'pension_projection',
  input: { ...pension, pensions: pension.pensions.map((member) => ({ ...member, statePensionStartAge: 68 })) },
  evidence: recordOnly,
  transcript: PENSION_TRANSCRIPT
});
assert.ok(
  !overridden.paths.some((path) => /statePensionStartAge/.test(path)),
  'a start age that differs from policy is not the policy default, whatever supports it'
);
pass('an overridden default leaves the floor: only the values the calculation actually rests on are recited');

console.info(`[AssumptionFloor] ${checks} checks passed.`);
