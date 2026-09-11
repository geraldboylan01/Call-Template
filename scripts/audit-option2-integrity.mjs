#!/usr/bin/env node
// Independent audit probes. Scripted provider, no network; production unchanged.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { interpretDirectModuleConversation, normalizeDirectSnapshot, MODULE_PLANNING_SNAPSHOT_V1,
  DIRECT_MODULE_CONTRACTS } from '../worker/src/consumer/direct_module_planner.js';
import { buildDirectModulePolicyEnvelope, directModulePolicyEntries, directModuleMaterialAssumptions } from '../js/planning/direct_module_policy.js';
import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';

const date = '2026-09-09';
const policy = buildDirectModulePolicyEnvelope({ calculationDateIso: date, baseCurrency: 'EUR' });
const config = { allowedModules: ['mortgage_analysis'], modulePlannerModel: 'scripted',
  modulePlannerTimeoutMs: 30000, modulePlannerReasoningEffort: 'low',
  modulePlannerPromptVersion: 'direct-module-planner-v12', moduleVerifierPromptVersion: 'direct-module-verifier-v11' };
const original = 'My repayment mortgage is 240000 euro at 4.1 percent for 22 years with no overpayments.';
const correction = 'I checked the statement. The mortgage balance is 340000 euro, not the 240000 I gave earlier.';
const turns = [{ id: 't1', role: 'user', transcript: original }, { id: 't2', role: 'user', transcript: correction }];
const profile = { revision: 1, assumptions: { calculationDateIso: date, values: {} }, preferences: { baseCurrency: 'EUR' } };
const pass = { schemaVersion: 'ModuleInputVerificationV1', verdict: 'pass', unsupportedPaths: [],
  omittedSupportedInformation: [], unresolvedAmbiguities: [], clarifications: [], confirmationPromptApproved: true, explanation: 'scripted pass' };
const omission = { ...pass, verdict: 'needs_clarification', confirmationPromptApproved: false,
  omittedSupportedInformation: ['/annualOverpayment'],
  clarifications: [{ id: 'omission', question: 'Please confirm the overpayment treatment.', relatedModuleIds: ['mortgage_analysis'], relatedPaths: ['/annualOverpayment'] }] };
const rejection = { ...pass, verdict: 'reject', confirmationPromptApproved: false,
  unresolvedAmbiguities: ['The proposed balance retains the superseded 240000 instead of the corrected 340000.'],
  clarifications: [{ id: 'correction', question: 'May I use the corrected 340000 balance?', relatedModuleIds: ['mortgage_analysis'], relatedPaths: ['/currentBalance'] }] };

function proposal({ balance = 340000, omit = null, overpayment = 0, assumptionValue = 0,
  balanceQuote = balance === 340000 ? '340000 euro' : '240000 euro', ambiguities = [] } = {}) {
  const input = { ...directModuleTestInputs(date).mortgage_analysis, currentBalance: balance, annualOverpayment: overpayment };
  const evidence = Object.keys(input).filter(key => key !== omit && key !== 'annualOverpayment').map(key => ({
    path: `/${key}`, source: 'conversation', turnId: key === 'currentBalance' && balance === 340000 ? 't2' : 't1',
    quote: key === 'currentBalance' ? balanceQuote : original, profilePath: ''
  }));
  const assumptions = directModulePolicyEntries('mortgage_analysis', input, policy)
    .filter(entry => entry.mode === 'default')
    .map(entry => ({ path: entry.path, source: entry.source, valueJson: JSON.stringify(entry.path === '/annualOverpayment' ? assumptionValue : entry.value) }));
  return { schemaVersion: MODULE_PLANNING_SNAPSHOT_V1, baseSnapshotRevision: 0, throughTurnId: 't2',
    modules: [{ moduleId: 'mortgage_analysis', outputKey: DIRECT_MODULE_CONTRACTS.mortgage_analysis.outputKey,
      status: 'ready', resolvedAcknowledgedUnknown: [], inputJson: JSON.stringify(input), selection: { origin: 'client_requested', reason: '' },
      steeringSummary: '', missing: [], ambiguities, assumptions, evidence }], generalAmbiguities: [],
    confirmationPrompt: `Mortgage balance ${balance} euro, 4.1 percent, 22 years, no overpayments. Shall I run that?` };
}
function normalized(raw, extra = {}) {
  return normalizeDirectSnapshot(raw, { turns, throughTurnId: 't2', policyEnvelope: policy,
    currentProfileContext: profile, allowedModuleIds: config.allowedModules, ...extra });
}
async function run(values, options = {}) {
  const calls = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    calls.push({ kind: body.text.format.name, envelope: JSON.parse(body.input[1].content) });
    assert.ok(values[calls.length - 1], 'unexpected extra provider call');
    assertSchema(values[calls.length - 1], body.text.format.schema);
    return { ok: true, json: async () => ({ status: 'completed', output_text: JSON.stringify(values[calls.length - 1]),
      usage: { input_tokens: 10, output_tokens: 2 } }) };
  };
  try {
    const result = await interpretDirectModuleConversation({ env: { OPENAI_API_KEY: 'synthetic',
      CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') }, config, turns,
      throughTurnId: 't2', currentProfileContext: profile, ...options });
    return { result, calls };
  } finally { globalThis.fetch = fetchBefore; }
}

// Validate every scripted response against the exact live request schema. This
// catches illegal fixtures before they can claim a runtime behavior.
function assertSchema(value, schema, path = '$') {
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path} enum`);
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), path);
    for (const key of schema.required || []) assert.ok(key in value, `${path}.${key} required`);
    for (const [key, nested] of Object.entries(value)) {
      if (schema.additionalProperties === false) assert.ok(key in schema.properties, `${path}.${key} extra`);
      if (schema.properties?.[key]) assertSchema(nested, schema.properties[key], `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value), path);
    if (schema.maxItems) assert.ok(value.length <= schema.maxItems, `${path} maxItems`);
    value.forEach((item, i) => assertSchema(item, schema.items, `${path}/${i}`));
  } else if (schema.type) {
    assert.ok(schema.type === 'integer' ? Number.isInteger(value) : typeof value === schema.type, `${path} type`);
    if (schema.maxLength) assert.ok(value.length <= schema.maxLength, `${path} maxLength`);
  }
}
const validPass = { ...pass, repairScope: 'none', repairTargets: [] };
const validOmission = { ...omission, repairScope: 'confirmation', repairTargets: [] };
const validRejection = { ...rejection, repairScope: 'none', repairTargets: [] };
let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`); }
}
const noRepair = { ...validOmission, repairScope: 'none',
  explanation: 'Only the client can clarify whether this value remains current. No internal repair is appropriate.' };
const none = await run([proposal(), noRepair, proposal(), validRejection]);
check('explicit repairScope none dispatches no further provider work', () => assert.equal(none.calls.length, 2));
check('none-scope extra fallback is still refused by a fresh rejecting verifier', () => assert.equal(none.result.certificate, null));

const narrowPrompt = 'Narrow attempted wording, with no joint owner yet.';
const lateAmbiguity = { ...validRejection, explanation: 'The current versus hypothetical use is genuinely uncertain.' };
const afterNarrow = await run([proposal(), validOmission,
  { confirmationPrompt: narrowPrompt }, lateAmbiguity, proposal(), validRejection]);
check('new genuine ambiguity in the narrow audit stops fallback', () => assert.equal(afterNarrow.calls.length, 4));
check('fallback sees the latest non-repairable audit if one is allowed', () => {
  assert.deepEqual(afterNarrow.calls[4]?.envelope.priorAuditFindings?.unresolvedAmbiguities, lateAmbiguity.unresolvedAmbiguities);
});
check('failed narrow artifact is not merged into fallback original proposal', () => {
  assert.notEqual(afterNarrow.calls[4].envelope.priorAuditFindings.failedProposal.confirmationPrompt, narrowPrompt);
  assert.deepEqual(afterNarrow.calls[4].envelope.conversation, afterNarrow.calls[0].envelope.conversation);
});
check('rejecting fallback issues no certificate', () => assert.equal(afterNarrow.result.certificate, null));

// A resolved acknowledgement has been server-validated before narrow repair.
// Narrow readback replacement should not erase its proven chronology.
const resolvedTurns = [
  { id: 't0', role: 'user', transcript: 'I do not know the mortgage rate.' },
  ...turns,
  { id: 't3', role: 'user', transcript: 'The statement confirms that the rate is 4.1 percent.' }
];
const resolved = proposal(); resolved.throughTurnId = 't3';
resolved.modules[0].evidence = resolved.modules[0].evidence.filter(e => e.path !== '/annualInterestRate');
resolved.modules[0].evidence.push({ path: '/annualInterestRate', source: 'conversation', turnId: 't3',
  quote: 'the rate is 4.1 percent', profilePath: '' });
resolved.modules[0].resolvedAcknowledgedUnknown = [{ path: '/annualInterestRate', turnId: 't3', quote: 'the rate is 4.1 percent' }];
const acknowledgement = [{ moduleId: 'mortgage_analysis', path: '/annualInterestRate', sourceTurnId: 't0' }];
const unknown = await run([resolved, validOmission, { confirmationPrompt: resolved.confirmationPrompt }, validPass], {
  turns: resolvedTurns, throughTurnId: 't3', acknowledgedUnknown: acknowledgement,
  operation: { deadlineAt: Date.now() + 90000, callAllowance: 4, callsUsed: 0, controller: new AbortController() }
});
check('narrow confirmation repair retains the validated later-answer resolution', () => {
  assert.equal(unknown.calls[3].envelope.proposedSnapshot.resolvedAcknowledgedUnknown.length, 1);
});
check('resolved unknown stays ready after a valid readback-only repair', () => assert.equal(unknown.result.brief.readyToConfirm, true));
console.log(`Option2 integrity: ${failures} reproduced safety/availability invariant failures.`);
if (failures) process.exitCode = 1;
