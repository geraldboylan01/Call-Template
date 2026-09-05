#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildDirectModulePolicyEnvelope } from '../js/planning/direct_module_policy.js';
import {
  normalizeDirectSnapshot,
  interpretDirectModuleConversation
} from '../worker/src/consumer/direct_module_planner.js';
import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';

const date = '2026-09-05';
const input = directModuleTestInputs(date).mortgage_analysis;
const transcript = 'My mortgage balance is 240000, the annual rate is 4.1%, with 22 years left. No overpayments.';
const turns = [{ id: 'c1', role: 'user', transcript }];
const profile = { revision: 1, assumptions: { calculationDateIso: date }, preferences: { baseCurrency: 'EUR' } };
const policyEnvelope = buildDirectModulePolicyEnvelope({ calculationDateIso: date });
const raw = () => ({
  schemaVersion: 'ModulePlanningSnapshotV1', baseSnapshotRevision: 0, throughTurnId: 'c1',
  generalAmbiguities: [],
  confirmationPrompt: 'Review your mortgage of €240,000 at 4.1% with 22 years left and no overpayments?',
  modules: [{
    moduleId: 'mortgage_analysis', outputKey: 'generated.mortgageInputs', status: 'ready',
    inputJson: JSON.stringify(input), steeringSummary: '', missing: [], ambiguities: [],
    selection: { origin: 'client_requested', reason: 'review your mortgage' },
    assumptions: policyEnvelope.modules.mortgage_analysis.filter((entry) => entry.mode === 'default')
      .map((entry) => ({ path: entry.path, source: entry.source, valueJson: JSON.stringify(entry.value) })),
    evidence: ['/currentBalance', '/annualInterestRate', '/remainingTermYears'].map((path) => ({
      path, source: 'conversation', turnId: 'c1', quote: transcript, profilePath: ''
    }))
  }]
});
const normalizeOptions = { turns, throughTurnId: 'c1', policyEnvelope, currentProfileContext: profile,
  allowedModuleIds: ['mortgage_analysis'] };
const unknown = [{ moduleId: 'mortgage_analysis', path: '/annualInterestRate' }];
const findings = [];
function check(name, work) {
  try { work(); console.info(`PASS ${name}`); }
  catch (error) { findings.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}

check('acknowledged unknown blocks even when the model correctly omits it from missing', () => {
  const result = normalizeDirectSnapshot(raw(), { ...normalizeOptions, acknowledgedUnknown: unknown });
  assert.equal(result.modules[0].status, 'collecting');
  assert.deepEqual(result.modules[0].blocked.map((entry) => entry.path), ['/annualInterestRate']);
  assert.deepEqual(result.modules[0].missing, []);
});
check('unknown does not disappear from a collecting snapshot with no repeated question', () => {
  const candidate = raw(); candidate.modules[0].status = 'collecting';
  delete candidate.modules[0].evidence;
  const result = normalizeDirectSnapshot(candidate, { ...normalizeOptions, acknowledgedUnknown: unknown });
  assert.equal(result.modules[0].blocked.length, 1);
});
check('a question solely about an acknowledged unknown leaves the ask list', () => {
  const candidate = raw(); candidate.modules[0].status = 'needs_clarification';
  candidate.modules[0].ambiguities = [{ id: 'unknown_rate', question: 'What is the rate?', relatedPaths: ['/annualInterestRate'] }];
  const result = normalizeDirectSnapshot(candidate, { ...normalizeOptions, acknowledgedUnknown: unknown });
  assert.deepEqual(result.modules[0].ambiguities, []);
  assert.equal(result.modules[0].status, 'collecting');
});
check('an unknown for another module never blocks this module', () => {
  const result = normalizeDirectSnapshot(raw(), { ...normalizeOptions,
    acknowledgedUnknown: [{ moduleId: 'loan_analysis', path: '/annualInterestRate' }] });
  assert.equal(result.modules[0].status, 'ready');
});

const pass = { schemaVersion: 'ModuleInputVerificationV1', verdict: 'pass', unsupportedPaths: [],
  omittedSupportedInformation: [], unresolvedAmbiguities: [], clarifications: [],
  confirmationPromptApproved: true, explanation: 'The client established every input.' };
const reject = { ...pass, verdict: 'reject', confirmationPromptApproved: false,
  explanation: 'The readback needs a correction.', clarifications: [{ id: 'readback',
    question: 'Please confirm the stated inputs.', relatedModuleIds: ['mortgage_analysis'], relatedPaths: [] }] };
const response = (value, tokens, index) => new Response(JSON.stringify({
  id: `response-${index}`, status: 'completed',
  output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  usage: { input_tokens: tokens, output_tokens: tokens + 1, input_tokens_details: { cached_tokens: Math.floor(tokens / 2) } }
}), { status: 200 });
const originalFetch = globalThis.fetch;
let index = 0;
const answers = [[raw(), 101], [reject, 203], [raw(), 307], [pass, 401]];
try {
  globalThis.fetch = async () => { const [value, tokens] = answers[index]; return response(value, tokens, ++index); };
  const result = await interpretDirectModuleConversation({
    env: { OPENAI_API_KEY: 'fixture-only', CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') },
    config: { allowedModules: ['mortgage_analysis'], modulePlannerModel: 'fixture', modulePlannerReasoningEffort: 'low',
      modulePlannerTimeoutMs: 1000, modulePlannerPromptVersion: 'fixture', moduleVerifierPromptVersion: 'fixture' },
    turns, throughTurnId: 'c1', currentProfileContext: profile
  });
  check('successful repair accounts for every real provider call exactly once', () => {
    assert.ok(result.certificate);
    assert.equal(index, 4);
    assert.equal(result.extractionUsage.input_tokens + result.verificationUsage.input_tokens, 1012);
    assert.equal(result.extractionUsage.output_tokens + result.verificationUsage.output_tokens, 1016);
  });
} finally { globalThis.fetch = originalFetch; }

if (findings.length) { console.error(`${findings.length} First 20 semantic integrity regressions failed.`); process.exitCode = 1; }
else console.info('First 20 semantic integrity regressions passed; no provider traffic.');
