#!/usr/bin/env node
// Independent audit probes. Scripted provider, no network; production unchanged.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { interpretDirectModuleConversation, normalizeDirectSnapshot, MODULE_PLANNING_SNAPSHOT_V1,
  DIRECT_MODULE_CONTRACTS } from '../worker/src/consumer/direct_module_planner.js';
import { buildDirectModulePolicyEnvelope, directModulePolicyEntries, directModuleMaterialAssumptions } from '../js/planning/direct_module_policy.js';
import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';

const date = '2026-09-08';
const policy = buildDirectModulePolicyEnvelope({ calculationDateIso: date, baseCurrency: 'EUR' });
const config = { allowedModules: ['mortgage_analysis'], modulePlannerModel: 'scripted',
  modulePlannerTimeoutMs: 30000, modulePlannerReasoningEffort: 'low',
  modulePlannerPromptVersion: 'direct-module-planner-v13', moduleVerifierPromptVersion: 'direct-module-verifier-v12' };
const original = 'My repayment mortgage is 240000 euro at 4.1 percent for 22 years with no overpayments.';
const correction = 'I checked the statement. The mortgage balance is 340000 euro, not the 240000 I gave earlier.';
const turns = [{ id: 't1', role: 'user', transcript: original }, { id: 't2', role: 'user', transcript: correction }];
const profile = { revision: 1, assumptions: { calculationDateIso: date, values: {} }, preferences: { baseCurrency: 'EUR' } };
const pass = { schemaVersion: 'ModuleInputVerificationV1', verdict: 'pass', unsupportedPaths: [],
  omittedSupportedInformation: [], unresolvedAmbiguities: [], clarifications: [], confirmationPromptApproved: true,
  revisionScope: 'none', revisionTargets: [], explanation: 'scripted pass' };
const omission = { ...pass, verdict: 'needs_clarification', confirmationPromptApproved: false,
  omittedSupportedInformation: ['/annualOverpayment'], revisionScope: 'reinterpretation',
  clarifications: [{ id: 'omission', question: 'Please confirm the overpayment treatment.', relatedModuleIds: ['mortgage_analysis'], relatedPaths: ['/annualOverpayment'] }] };
const rejection = { ...pass, verdict: 'reject', confirmationPromptApproved: false,
  unresolvedAmbiguities: ['The proposed balance retains the superseded 240000 instead of the corrected 340000.'],
  clarifications: [{ id: 'correction', question: 'May I use the corrected 340000 balance?', relatedModuleIds: ['mortgage_analysis'], relatedPaths: ['/currentBalance'] }] };
// The auditor asserting the figures are right and only their support is wrong.
const presentationOnly = { ...omission, revisionScope: 'presentation',
  unsupportedPaths: ['/annualOverpayment'],
  revisionTargets: [{ moduleId: 'mortgage_analysis', path: '/annualOverpayment' }] };
const noRevision = { ...omission, revisionScope: 'none' };

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
  return { schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    modules: [{ moduleId: 'mortgage_analysis', outputKey: DIRECT_MODULE_CONTRACTS.mortgage_analysis.outputKey,
      status: 'ready', inputJson: JSON.stringify(input), selection: { origin: 'client_requested', reason: '' },
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
let checks = 0;
function checked(label, fn) { fn(); checks++; console.log(`PASS ${label}`); }

for (const assumptionValue of [0, 500, null]) {
  const raw = proposal({ overpayment: 500, assumptionValue });
  const item = normalized(raw).modules[0];
  checked(`Fix A divergent overpayment with disclosure ${assumptionValue} remains unsupported`, () => {
    assert.equal(item.status, 'needs_clarification');
    assert.ok(item.inputSupportIssues.includes('/annualOverpayment'));
    assert.ok(!item.assumptions.some(entry => entry.path === '/annualOverpayment'));
  });
  // WAS: the server repaired provenance before any audit, so this drove
  // extract -> structural repair and asserted two calls. The unsupported
  // proposal now reaches the auditor with its structural diagnostics, and the
  // one revision it asks for cannot rescue a value that stays uncited.
  const failed = await run([raw, presentationOnly, { confirmationPrompt: null, entries: [] }]);
  checked(`Fix A disclosure ${assumptionValue} cannot gain a certificate through its one revision`, () => {
    assert.equal(failed.result.certificate, null); assert.equal(failed.calls.length, 3);
    assert.equal(failed.calls[1].kind, 'module_input_verification_v1',
      'the auditor sees the proposal, rather than provenance being repaired behind its back');
    assert.deepEqual(failed.calls[1].envelope.structuralDiagnostics.map(item => (
      { moduleId: item.moduleId, paths: item.paths })),
      [{ moduleId: 'mortgage_analysis', paths: ['/annualOverpayment'] }]);
  });
}
const explicitDefault = normalized(proposal());
checked('coherent disclosed approved default remains supported', () => assert.equal(explicitDefault.modules[0].status, 'ready'));
const noDisclosure = proposal();
noDisclosure.modules[0].assumptions = noDisclosure.modules[0].assumptions.filter(entry => entry.path !== '/annualOverpayment');
const omittedInput = JSON.parse(noDisclosure.modules[0].inputJson); delete omittedInput.annualOverpayment;
noDisclosure.modules[0].inputJson = JSON.stringify(omittedInput);
checked('omitted undeclared native default still throws', () => assert.throws(() => normalized(noDisclosure),
  error => error.code === 'module_snapshot_default_undisclosed'));

const structural = proposal({ omit: 'currentBalance' });
const corrected = proposal();
const stale = proposal({ balance: 240000 });
const blocked = await run([structural, omission, stale, rejection]);
checked('a reinterpretation may reintroduce stale meaning, but fresh rejection blocks certification', () => {
  // WAS five calls: a structural repair, an audit, a full re-author and a
  // second audit. Four now -- author, review, one revision, review.
  assert.equal(blocked.calls.length, 4); assert.equal(blocked.result.certificate, null);
  assert.equal(blocked.calls[3].envelope.proposedSnapshot.modules[0].input.currentBalance, 240000);
  // THE STATE AND THE VERDICT MOVE TOGETHER, AND THE REFUSAL IS APPLIED. The
  // re-author reintroduced the superseded 240,000; the audit refused it and
  // named /currentBalance as what it could not resolve; so the state reports
  // that figure as unknown rather than continuing to assert a number an
  // independent review had just rejected. The corrected 340,000 is NOT written
  // here either: reading the correction is the planner's job, not the server's.
  assert.equal(blocked.result.snapshot.modules[0].input.currentBalance, null);
  assert.notEqual(blocked.result.snapshot.modules[0].status, 'ready');
  assert.equal(blocked.result.verification.clarifications[0].id, 'correction');
});
checked('the revision and both verifications retain every original and correction turn', () => {
  for (const call of blocked.calls) assert.deepEqual(call.envelope.conversation.map(turn => turn.text), [original, correction]);
});
const trusted = await run([structural, omission, stale, pass]);
checked('LIMIT: an erroneous final verifier pass can still certify a stale reinterpretation', () => {
  assert.ok(trusted.result.certificate);
  assert.equal(trusted.result.snapshot.modules[0].input.currentBalance, 240000);
});
const ambiguous = proposal({ omit: 'currentBalance', ambiguities: [{ id: 'owner', question: 'Whose mortgage?', relatedPaths: ['/currentBalance'] }] });
const open = await run([ambiguous]);
checked('an explicitly declared genuine ambiguity never enters the revision path', () => {
  assert.equal(open.calls.length, 1); assert.equal(open.result.certificate, null);
});

const punctuation = proposal({ balance: 50, balanceQuote: '50' });
const punctuationTurns = [{ id: 't1', role: 'user', transcript: 'The balance is 250,50 euro.' }, turns[1]];
// Support other fields independently so this probe isolates the quote matcher.
for (const e of punctuation.modules[0].evidence) if (e.path !== '/currentBalance') e.quote = punctuationTurns[0].transcript;
const punctResult = normalized(punctuation, { turns: punctuationTurns });
checked('LIMIT: word boundary counting accepts 50 as unique in 250,50; semantic verifier must reject wrong numeric meaning', () => {
  assert.equal(punctResult.modules[0].status, 'ready');
  assert.ok(punctResult.modules[0].evidence.some(entry => entry.path === '/currentBalance' && entry.quote === '50'));
});

// Separate source-attribution defect: a record-existence quote is treated as
// evidence that the client supplied ALL defaulted values nested in the record.
// A TRACKED FIXTURE, BECAUSE THIS PROBE IS IN THE GATE. It read the paid
// v10c-r2b run directly out of diagnostics/, which is gitignored, so
// `npm run check:first20` could not pass on a clean checkout at all. The fixture
// is a faithful extract of that archive: the same conversation turns and the
// same first provider response, nothing edited.
const pensionArchive = JSON.parse(await readFile('scripts/fixtures/first20/pension-partners-contributions-correction.json', 'utf8'));
const pensionRaw = JSON.parse(pensionArchive.providerCalls[0].response.output.flatMap(item => item.content || []).find(item => item.type === 'output_text').text);
pensionRaw.modules = pensionRaw.modules.filter(item => item.moduleId === 'pension_projection');
const pension = pensionRaw.modules[0];
pension.evidence = pension.evidence.filter(item => !/\/(includeStatePension|statePensionStartAge|statePensionFraction)$/.test(item.path));
const pensionTurns = pensionArchive.turns.map(turn => ({ ...turn, transcript: turn.transcript.replace('Include the full Irish State Pension for both from age 66 as a planning assumption. ', '') }));
for (const member of [0, 1]) for (const [field, value] of [['includeStatePension', true], ['statePensionStartAge', 66]]) {
  pension.assumptions.push({ path: `/pensions/${member}/${field}`, source: 'planning_policy', valueJson: JSON.stringify(value) });
}
const pensionProbe = await run([pensionRaw, pass], { config: { ...config, allowedModules: ['pension_projection'] }, turns: pensionTurns, throughTurnId: 'c3' });
const suppliedFloor = pensionProbe.calls[1].envelope.materialAssumptions.flatMap(item => item.assumptions);
// WAS a LIMIT probe asserting that these four defaults were suppressed.
// Record existence and leaf source attribution are different claims: an
// owner-and-age quote establishes that a pension record exists and says nothing
// about who chose the State Pension start age inside it. Treating the parent
// pointer as source attribution withheld four genuine server defaults from the
// read-back, which presents a Planeir assumption as the client's own answer.
checked('owner-only parent citations no longer suppress unsupplied State Pension defaults', () => {
  const policyFloor = directModuleMaterialAssumptions('pension_projection', JSON.parse(pension.inputJson), policy);
  assert.equal(policyFloor.filter(item => /^\/pensions\//.test(item.path)).length, 4);
  assert.ok(pensionProbe.result.snapshot.modules[0].authoredInput, 'isolate parent-path bug from absent authoredInput bug');
  assert.equal(suppliedFloor.filter(item => /^\/pensions\//.test(item.path)).length, 4,
    'every default the client did not supply reaches the auditor floor');
  assert.ok(pension.evidence.filter(item => /^\/pensions\/\d$/.test(item.path)).every(item => !item.quote.includes('Pension')));
});

console.log(`Audit Claude integrity: ${checks} probes passed. LIMIT probes deliberately demonstrate boundaries, not safe semantic outcomes.`);
