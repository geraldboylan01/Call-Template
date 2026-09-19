#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildDirectModulePolicyEnvelope } from '../js/planning/direct_module_policy.js';
import {
  normalizeDirectSnapshot,
  interpretDirectModuleConversation,
  verifyDirectModuleCertificate
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
    inputJson: JSON.stringify(input), steeringSummary: '', resolvedAcknowledgedUnknown: [], missing: [], ambiguities: [],
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

const recoveryTurns = [
  { id: 'c0', role: 'user', transcript: 'I do not know the mortgage interest rate.' },
  ...turns
];
const recoveryUnknown = [{ ...unknown[0], sourceTurnId: 'c0' }];
check('a later evidenced answer can recover an acknowledged unknown for semantic verification', () => {
  const candidate = raw();
  candidate.modules[0].resolvedAcknowledgedUnknown = [{ path: '/annualInterestRate', turnId: 'c1', quote: transcript }];
  const result = normalizeDirectSnapshot(candidate, { ...normalizeOptions, turns: recoveryTurns, acknowledgedUnknown: recoveryUnknown });
  assert.equal(result.modules[0].status, 'ready');
  assert.deepEqual(result.modules[0].blocked, []);
  assert.deepEqual(result.resolvedAcknowledgedUnknown, [{ moduleId: 'mortgage_analysis', path: '/annualInterestRate', sourceTurnId: 'c0', turnId: 'c1' }]);
});
for (const [name, changes] of [
  ['same-turn answer', { sourceTurnId: 'c1' }],
  ['unknown chronology', { sourceTurnId: 'not-in-window' }],
  ['legacy acknowledgement', { sourceTurnId: undefined }]
]) check(`${name} cannot clear a client acknowledgement`, () => {
  const candidate = raw();
  candidate.modules[0].resolvedAcknowledgedUnknown = [{ path: '/annualInterestRate', turnId: 'c1', quote: transcript }];
  const result = normalizeDirectSnapshot(candidate, { ...normalizeOptions, turns: recoveryTurns,
    acknowledgedUnknown: [{ ...unknown[0], ...changes }] });
  assert.equal(result.modules[0].status, 'collecting');
});
check('an adviser statement cannot clear a client acknowledgement', () => {
  const candidate = raw();
  candidate.modules[0].resolvedAcknowledgedUnknown = [{ path: '/annualInterestRate', turnId: 'c1', quote: transcript }];
  const result = normalizeDirectSnapshot(candidate, { ...normalizeOptions,
    turns: recoveryTurns.map((turn) => turn.id === 'c1' ? { ...turn, role: 'assistant' } : turn),
    acknowledgedUnknown: recoveryUnknown });
  assert.equal(result.modules[0].status, 'collecting');
});

const pass = { schemaVersion: 'ModuleInputVerificationV1', verdict: 'pass', unsupportedPaths: [],
  omittedSupportedInformation: [], unresolvedAmbiguities: [], clarifications: [],
  confirmationPromptApproved: true, revisionScope: 'none', revisionTargets: [],
  explanation: 'The client established every input.' };
// The auditor says what must change, and there are two forms it may ask for.
// `reject` asks for a complete re-author because the financial content is
// wrong; `rejectPresentation` asserts the figures are right and only the
// read-back and its citations need replacing.
const reject = { ...pass, verdict: 'reject', confirmationPromptApproved: false,
  revisionScope: 'reinterpretation',
  explanation: 'The readback needs a correction.', clarifications: [{ id: 'readback',
    question: 'Please confirm the stated inputs.', relatedModuleIds: ['mortgage_analysis'], relatedPaths: [] }] };
const rejectPresentation = (targets = []) => ({ ...reject, revisionScope: 'presentation',
  revisionTargets: targets, unsupportedPaths: targets.map((item) => item.path) });
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
    assert.equal(result.extractionUsage.input_tokens_details.cached_tokens
      + result.verificationUsage.input_tokens_details.cached_tokens, 504);
  });
} finally { globalThis.fetch = originalFetch; }

const env = { OPENAI_API_KEY: 'fixture-only', CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') };
const config = { allowedModules: ['mortgage_analysis'], modulePlannerModel: 'fixture', modulePlannerReasoningEffort: 'low',
  modulePlannerTimeoutMs: 1000, modulePlannerPromptVersion: 'fixture', moduleVerifierPromptVersion: 'fixture' };
async function checkAsync(name, work) {
  try { await work(); console.info(`PASS ${name}`); }
  catch (error) { findings.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
function assertStrictObjects(schema) {
  if (schema.type === 'object') {
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    assert.equal(schema.additionalProperties, false);
    for (const value of Object.values(schema.properties)) assertStrictObjects(value);
  }
  if (schema.items) assertStrictObjects(schema.items);
}
async function fixtureRun(answers, options = {}) {
  const requests = [];
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.text.format.strict, true);
    assertStrictObjects(body.text.format.schema);
    requests.push(JSON.parse(body.input[1].content));
    assert.ok(answers.length >= requests.length, 'Unexpected additional provider call');
    const [value, tokens] = answers[requests.length - 1];
    return response(value, tokens, requests.length);
  };
  try {
    const result = await interpretDirectModuleConversation({ env, config, turns,
      throughTurnId: 'c1', currentProfileContext: profile, ...options });
    return { result, requests };
  } finally { globalThis.fetch = originalFetch; }
}
const brokenCitation = () => {
  const candidate = raw();
  candidate.modules[0].evidence[0].quote = 'My mortgage balance ... 240000';
  return candidate;
};
await checkAsync('a malformed ready citation reaches the auditor, and one presentation revision fixes it', async () => {
  // WAS: the server repaired provenance BEFORE any audit, spending a call to
  // fix citations for figures no independent reviewer had yet looked at.
  //
  // A citation the server cannot resolve downgrades its module out of ready, so
  // that proposal used to be invisible to the auditor -- "not every module
  // ready" meant verification was skipped entirely. It is the same finding seen
  // from two sides: the auditor now sees the proposal AND the paths the server
  // refused, and decides whether the figures are right and only their support
  // failed, or whether the value should not be there at all.
  const targets = [{ moduleId: 'mortgage_analysis', path: '/currentBalance' }];
  const { result, requests } = await fixtureRun([
    [brokenCitation(), 101], [rejectPresentation(targets), 203], [{ confirmationPrompt: null, entries: [
      { moduleId: 'mortgage_analysis', path: '/currentBalance', source: 'conversation',
        turnId: 'c1', quote: transcript, profilePath: '' }
    ] }, 307], [pass, 401]
  ]);
  assert.equal(requests.length, 4, 'author, review, revision, review');
  // The auditor is told which paths failed AND why each citation was dropped.
  // This fixture's own quote -- 'My mortgage balance ... 240000' -- is an
  // ellipsis splice, which is the commonest real failure: the establishing
  // words are not contiguous, so the model reassembles them. Told only the
  // path, it cannot tell that from a citation it forgot, and it re-sends the
  // same spliced quote. Told the reason, it can widen the span instead.
  assert.deepEqual(requests[1].structuralDiagnostics, [{
    moduleId: 'mortgage_analysis',
    paths: ['/currentBalance'],
    droppedCitations: [{
      path: '/currentBalance',
      turnId: 'c1',
      quote: 'My mortgage balance ... 240000',
      reason: 'quote_is_not_a_contiguous_substring_of_that_turn'
    }]
  }]);
  assert.equal(requests[1].proposedSnapshot.modules[0].input.currentBalance, 240000,
    'the auditor judges the figure itself, not just its citation');
  // The revision is handed the same failed proposal and the same targets.
  assert.deepEqual(requests[2].revisionTargets, targets);
  assert.deepEqual(requests[2].conversation, requests[0].conversation);
  assert.deepEqual(requests[2].serverPolicy, requests[0].serverPolicy);
  assert.equal(requests[2].failedProposal.modules[0].input.currentBalance, 240000);
  assert.ok(result.certificate);
  assert.equal(result.snapshot.modules[0].status, 'ready');
  assert.equal(result.snapshot.modules[0].evidence.find((entry) => entry.path === '/currentBalance').quote,
    transcript, 'the replaced citation is the one that survives');
  assert.equal(result.extractionUsage.input_tokens + result.verificationUsage.input_tokens, 1012);
  assert.equal(result.extractionUsage.output_tokens + result.verificationUsage.output_tokens, 1016);
  assert.equal(result.extractionUsage.input_tokens_details.cached_tokens
    + result.verificationUsage.input_tokens_details.cached_tokens, 504);
});
await checkAsync('a presentation revision replaces the read-back and the citations together', async () => {
  // The two used to be separate branches, so a finding that involved both could
  // only be sent down one of them and the other half stayed broken.
  const targets = [{ moduleId: 'mortgage_analysis', path: '/currentBalance' }];
  const replacement = 'Comparing Aoife’s repayment mortgage: €240,000 at 4.1% over 22 years. Shall I run that?';
  const { result, requests } = await fixtureRun([
    [brokenCitation(), 101], [rejectPresentation(targets), 203],
    [{ confirmationPrompt: replacement, entries: [
      { moduleId: 'mortgage_analysis', path: '/currentBalance', source: 'conversation',
        turnId: 'c1', quote: transcript, profilePath: '' }
    ] }, 307], [pass, 401]
  ]);
  assert.equal(requests.length, 4);
  assert.ok(result.certificate);
  assert.equal(result.snapshot.confirmationPrompt, replacement, 'the read-back is replaced');
  assert.equal(result.snapshot.modules[0].evidence.find((entry) => entry.path === '/currentBalance').quote,
    transcript, 'and so is the citation, in the same revision');
  assert.equal(result.snapshot.modules[0].input.currentBalance, 240000,
    'and the figure it supports is untouched');
});
await checkAsync('a reinterpretation receives the exact failed current proposal and material readback, not old planning state', async () => {
  const candidate = raw();
  candidate.confirmationPrompt = 'Compare Aoife’s repayment mortgage: about €240,000 at 4.1% over 22 years, '
    + 'with no lump-sum or annual overpayment. Shall I run exactly that plan?';
  const previous = normalizeDirectSnapshot(raw(), normalizeOptions);
  previous.snapshotRevision = 9;
  previous.confirmationPrompt = 'An earlier read-back that must not replace the audited question.';
  const { result, requests } = await fixtureRun([[candidate, 101], [reject, 203], [candidate, 307], [pass, 401]], {
    previousSnapshot: previous
  });
  assert.equal(requests.length, 4);
  const revision = requests[2].priorAuditFindings;
  assert.deepEqual(revision.failedProposal, requests[1].proposedSnapshot);
  assert.equal(revision.failedProposal.confirmationPrompt, candidate.confirmationPrompt);
  assert.notEqual(revision.failedProposal.confirmationPrompt, requests[2].previousSnapshot.confirmationPrompt);
  // THE SERVER OWNS THE BOOKKEEPING, SO THE MODEL IS NOT SHOWN IT.
  // A re-author handed the rejected proposal used to copy that proposal's own
  // revision back as its base, and a complete correct rebuild was discarded
  // over a number it had no way to reason about.
  assert.equal(revision.failedProposal.snapshotRevision, undefined);
  assert.equal(revision.failedProposal.baseSnapshotRevision, undefined);
  assert.equal(revision.failedProposal.throughTurnId, undefined);
  assert.equal(result.snapshot.snapshotRevision, 10, 'and binds the right revision anyway');
  assert.equal(result.snapshot.throughTurnId, 'c1');
  assert.deepEqual(requests[3].proposedSnapshot.modules[0].input, revision.failedProposal.modules[0].input);
  assert.ok(result.certificate);
  assert.equal(result.extractionUsage.input_tokens + result.verificationUsage.input_tokens, 1012);
});
// WAS: "a structural repair still needs semantic approval, and two repairs is
// the ceiling", asserting five calls across two error classes.
//
// There is one class now and one revision. The first half of the claim is
// unchanged and still proven here: a revision buys NO semantic approval, and a
// plan that still cannot pass is still refused.
await checkAsync('one revision is the ceiling, and it buys no semantic approval', async () => {
  const targets = [{ moduleId: 'mortgage_analysis', path: '/currentBalance' }];
  const { result, requests } = await fixtureRun([
    [brokenCitation(), 101], [rejectPresentation(targets), 203],
    [{ confirmationPrompt: null, entries: [
      { moduleId: 'mortgage_analysis', path: '/currentBalance', source: 'conversation',
        turnId: 'c1', quote: transcript, profilePath: '' }
    ] }, 307], [reject, 401]
  ]);
  assert.equal(requests.length, 4, 'author, review, one revision, review -- and no more');
  assert.equal(result.certificate, null);
  assert.equal(result.brief.readyToConfirm, false);
  assert.equal(result.verification.verdict, 'reject');
  // THE LATEST INDEPENDENT JUDGEMENT IS THE ONE REPORTED. The second audit
  // refused the revised proposal, and that is the verdict the client's question
  // comes from -- not the older one, which described a proposal that no longer
  // exists.
  assert.equal(result.verification.revisionScope, 'reinterpretation');
  assert.equal(result.verificationUsage.input_tokens, 401);
  // 101 + 203 + 307: every completed call billed exactly once, including the
  // superseded first audit.
  assert.equal(result.extractionUsage.input_tokens, 611);
});
await checkAsync('a presentation revision that leaves a value uncited is refused, and changes nothing', async () => {
  // A citation revision that leaves a value unsupported has made the proposal
  // LESS supported, not more. The server downgraded it -- the planner decided
  // nothing -- so it is refused and the original question stands. This is the
  // line that stops a dropped quote retiring a figure the client gave.
  const targets = [{ moduleId: 'mortgage_analysis', path: '/currentBalance' }];
  const { result, requests } = await fixtureRun([
    [brokenCitation(), 101], [rejectPresentation(targets), 203],
    [{ confirmationPrompt: null, entries: [] }, 307]
  ]);
  assert.equal(requests.length, 3, 'an unsupported candidate is abandoned before a second audit');
  assert.equal(result.certificate, null);
  assert.equal(result.snapshot.modules[0].status, 'needs_clarification');
  assert.equal(result.snapshot.modules[0].input.currentBalance, 240000,
    'the proposal is exactly as it was');
  assert.equal(result.extractionUsage.input_tokens, 408);
});
await checkAsync('genuine missing information never triggers structural self-repair', async () => {
  const candidate = raw();
  candidate.modules[0].status = 'collecting';
  candidate.modules[0].missing = [{ path: '/annualInterestRate', reason: 'The client does not know.', question: 'What is the interest rate?' }];
  const { result, requests } = await fixtureRun([[candidate, 101]]);
  assert.equal(requests.length, 1);
  assert.equal(result.certificate, null);
});
await checkAsync('a resolved acknowledgement is bound into its certificate and strict provider schema', async () => {
  const candidate = raw();
  candidate.modules[0].resolvedAcknowledgedUnknown = [{ path: '/annualInterestRate', turnId: 'c1', quote: transcript }];
  const { result } = await fixtureRun([[candidate, 101], [pass, 203]], {
    turns: recoveryTurns, acknowledgedUnknown: recoveryUnknown
  });
  assert.ok(result.certificate);
  const context = { config, calculationDateIso: date, baseCurrency: 'EUR', currentProfileContext: profile };
  assert.equal(await verifyDirectModuleCertificate(env, result.certificate, result.snapshot, null, context), true);
  for (const mutation of [
    (snapshot) => { snapshot.resolvedAcknowledgedUnknown = []; },
    (snapshot) => { snapshot.resolvedAcknowledgedUnknown[0].sourceTurnId = 'earlier-fabricated-turn'; },
    (snapshot) => { snapshot.resolvedAcknowledgedUnknown[0].turnId = 'unreviewed-answer'; },
    (snapshot) => { snapshot.resolvedAcknowledgedUnknown[0].path = '/currentBalance'; }
  ]) {
    const changed = structuredClone(result.snapshot);
    mutation(changed);
    assert.equal(await verifyDirectModuleCertificate(env, result.certificate, changed, null, context), false);
  }
});
await checkAsync('semantic rejection of a claimed resolution never produces a certificate', async () => {
  const candidate = raw();
  candidate.modules[0].resolvedAcknowledgedUnknown = [{ path: '/annualInterestRate', turnId: 'c1', quote: transcript }];
  const { result, requests } = await fixtureRun([[candidate, 101], [{ ...reject,
    unresolvedAmbiguities: ['The later statement remains uncertain rather than establishing the rate.'] }, 203]], {
    turns: recoveryTurns, acknowledgedUnknown: recoveryUnknown
  });
  assert.equal(requests.length, 2);
  assert.equal(result.certificate, null);
  assert.equal(result.brief.readyToConfirm, false);
});

if (findings.length) { console.error(`${findings.length} First 20 semantic integrity regressions failed.`); process.exitCode = 1; }
else console.info('First 20 semantic integrity regressions passed; no provider traffic.');
