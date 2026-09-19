#!/usr/bin/env node

/**
 * A REVISION MAY NOT QUIETLY DROP WHAT IT WAS NOT ASKED ABOUT.
 *
 * THE DEFECT THIS PINS. A repair was handed the whole snapshot and asked for
 * the whole snapshot back, so "preserve everything else" was an instruction
 * rather than a property -- and it did not hold. One real House repair fixed
 * the cost read-back and cut its evidence from 59 entries to 22; another
 * restored the household cash flow while dropping the cost amounts it had just
 * been told to add; a third returned an empty confirmation.
 *
 * THE MECHANISM. The auditor declares what must change, and there is now ONE
 * revision in one of two forms. A `presentation` revision is applied to the
 * proposal the planner already made: the model is handed the read-back, named
 * citations, or both, and its reply cannot reach the inputs, so there is never
 * a second version of a figure to choose between and nothing to merge.
 * `reinterpretation` means the proposal itself is wrong -- a full re-author, no
 * preservation claim, and a fresh independent audit.
 *
 * WHAT THIS FILE HAS TO PROVE is the other half: that preservation can never
 * become resurrection. A presentation revision keeps the proposal's figures, so
 * if one of those figures is stale the fresh audit must still refuse it, and no
 * certificate may exist. Every case below ends by checking that.
 *
 * AND THE LINE BETWEEN THE TWO KINDS OF NOT-READY. A candidate the PLANNER left
 * collecting is a judgement about the conversation and replaces what it
 * corrects, runnable or not. A candidate the SERVER downgraded, because a
 * citation would not resolve, decided nothing and is refused. Without that
 * split, a dropped quote could retire a figure the client gave -- and a correct
 * retraction could not retire one they withdrew.
 */
import assert from 'node:assert/strict';

import {
  interpretDirectModuleConversation,
  MODULE_PLANNING_SNAPSHOT_V1,
  DIRECT_MODULE_CONTRACTS
} from '../worker/src/consumer/direct_module_planner.js';
import { buildDirectModulePolicyEnvelope, directModulePolicyEntries } from '../js/planning/direct_module_policy.js';
import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';
import { readJsonPointer, stableStringify } from '../js/planning/utils.js';
import { directModulePlanMeaningKey } from '../worker/src/consumer/direct_module_identity.js';

let checks = 0;
const pass = (message) => { checks += 1; console.info(`[RevisionPreservation] PASS: ${message}`); };

const DATE = new Date().toISOString().slice(0, 10);
const POLICY = buildDirectModulePolicyEnvelope({ calculationDateIso: DATE, baseCurrency: 'EUR' });
const PROFILE = { revision: 1, assumptions: { calculationDateIso: DATE, values: {} }, preferences: { baseCurrency: 'EUR' } };
const CONFIG = {
  allowedModules: ['mortgage_analysis'],
  modulePlannerModel: 'scripted', modulePlannerTimeoutMs: 30_000,
  modulePlannerReasoningEffort: 'low',
  modulePlannerPromptVersion: 'v', moduleVerifierPromptVersion: 'v'
};

const FIRST = 'My repayment mortgage is 240000 euro at 4.1 percent over 22 years, held jointly with Ben, and we overpay 500 a year.';
const CORRECTION = 'I checked the statement. The balance is actually 340000, not 240000.';
const TURNS = [
  { id: 't1', role: 'user', transcript: FIRST, answersTurnId: null },
  { id: 't2', role: 'user', transcript: CORRECTION, answersTurnId: null }
];
const PROMPT = 'I will run the mortgage analysis on a 340000 euro repayment balance at 4.1 percent over 22 years, '
  + 'held jointly with Ben, with 500 a year in overpayments. Shall I run exactly that?';

/** A proposal, with every knob the adversarial cases need to turn. */
function proposal({ balance = 340000, quote = '340000', overpayment = 500, owners = true,
  confirmationPrompt = PROMPT, dropEvidenceFor = null } = {}) {
  const input = { ...directModuleTestInputs(DATE).mortgage_analysis, currentBalance: balance, annualOverpayment: overpayment };
  const evidence = [
    { path: '/currentBalance', source: 'conversation', turnId: balance === 340000 ? 't2' : 't1', quote, profilePath: '' },
    { path: '/annualInterestRate', source: 'conversation', turnId: 't1', quote: '4.1 percent', profilePath: '' },
    { path: '/remainingTermYears', source: 'conversation', turnId: 't1', quote: '22 years', profilePath: '' },
    { path: '/annualOverpayment', source: 'conversation', turnId: 't1', quote: 'we overpay 500 a year', profilePath: '' },
    ...(owners ? [{ path: '/loanKey', source: 'conversation', turnId: 't1', quote: 'held jointly with Ben', profilePath: '' }] : [])
  ].filter((entry) => entry.path !== dropEvidenceFor && readJsonPointer(input, entry.path) !== undefined);
  const assumptions = directModulePolicyEntries('mortgage_analysis', input, POLICY)
    .filter((entry) => entry.mode === 'default')
    .filter((entry) => {
      const actual = readJsonPointer(input, entry.path);
      return actual === undefined || stableStringify(actual) === stableStringify(entry.value);
    })
    .map((entry) => ({ path: entry.path, source: entry.source, valueJson: JSON.stringify(entry.value) }));
  return {
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    modules: [{
      moduleId: 'mortgage_analysis',
      outputKey: DIRECT_MODULE_CONTRACTS.mortgage_analysis.outputKey,
      status: 'ready',
      selection: { origin: 'client_requested', reason: 'you asked about your mortgage' },
      inputJson: JSON.stringify(input),
      steeringSummary: 'your repayment mortgage',
      resolvedAcknowledgedUnknown: [],
      missing: [], ambiguities: [], assumptions, evidence
    }],
    generalAmbiguities: [],
    confirmationPrompt
  };
}

const VERDICT = {
  schemaVersion: 'ModuleInputVerificationV1',
  verdict: 'pass', unsupportedPaths: [], omittedSupportedInformation: [],
  unresolvedAmbiguities: [], clarifications: [], confirmationPromptApproved: true,
  revisionScope: 'none', revisionTargets: [], explanation: 'scripted'
};
const verdict = (over) => ({ ...VERDICT, ...over });
const clarify = (question) => [{ id: 'q', question, relatedModuleIds: ['mortgage_analysis'], relatedPaths: [] }];

/** Drive the real interpreter with a scripted provider. */
async function run(script, { acknowledgedUnknown = [], operation = null } = {}) {
  const calls = [];
  const remaining = [...script];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    const name = body.text?.format?.name;
    const envelope = JSON.parse(body.input?.[1]?.content || '{}');
    calls.push({ name, envelope });
    // Matched by the schema the planner asked for, not by position: these cases
    // are about WHICH artefact a repair is allowed to return, so the sequence is
    // an outcome under test rather than something the script should dictate.
    const next = remaining.find((item) => item.name === name);
    assert.ok(next, `unexpected model call ${calls.length}: ${name}`);
    remaining.splice(remaining.indexOf(next), 1);
    return { ok: true, json: async () => ({
      id: `resp-${calls.length}`, status: 'completed',
      output_text: JSON.stringify(next.value), usage: { input_tokens: 10, output_tokens: 1 }
    }) };
  };
  try {
    const result = await interpretDirectModuleConversation({
      env: { OPENAI_API_KEY: 'synthetic', CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') },
      config: CONFIG, turns: TURNS, throughTurnId: 't2',
      previousSnapshot: null, currentProfileContext: PROFILE, acknowledgedUnknown, operation
    });
    return { result, calls };
  } finally { globalThis.fetch = original; }
}

const inputOf = (result) => result.snapshot.modules.find((item) => item.moduleId === 'mortgage_analysis').input;
const citedPaths = (result) => new Set(result.snapshot.modules[0].evidence.map((entry) => entry.path));

/* ---------- a presentation revision cannot reach a figure, an owner or a quote */

{
  // The read-back forgot the overpayment. The auditor says so, and scopes it.
  const revised = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt annual overpayment'],
      clarifications: clarify('Please confirm the overpayment.'), revisionScope: 'presentation'
    }) },
    { name: 'module_presentation_revision_v1', value: {
      confirmationPrompt: `${PROMPT} It includes the 500 a year overpayment.`, entries: []
    } },
    { name: 'module_input_verification_v1', value: verdict({}) }
  ]);
  assert.equal(revised.calls.length, 4, 'author, review, revision, review');
  assert.equal(inputOf(revised.result).currentBalance, 340000, 'the corrected balance survives the revision');
  assert.equal(inputOf(revised.result).annualOverpayment, 500, 'and so does every other figure');
  assert.deepEqual([...citedPaths(revised.result)].sort(),
    [...citedPaths(await run([{ name: 'module_planning_snapshot_v1', value: proposal() },
      { name: 'module_input_verification_v1', value: verdict({}) }]).then((r) => r.result))].sort(),
    'not one citation was dropped: no target was named, so the evidence was never touched');
  assert.ok(revised.result.certificate, 'and the corrected plan is certified');
  pass('a read-back revision fixes the words and cannot drop a figure, an owner or a citation');
}

/* ------------------ ...and it cannot resurrect a superseded figure either --- */

{
  // The proposal carries the SUPERSEDED balance. A presentation revision keeps
  // the inputs -- that is the whole point -- so the only thing standing
  // between a stale figure and a certificate is the fresh audit. It must hold.
  const stale = await run([
    { name: 'module_planning_snapshot_v1', value: proposal({ balance: 240000, quote: '240000' }) },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm the balance.'), revisionScope: 'presentation'
    }) },
    { name: 'module_presentation_revision_v1', value: {
      confirmationPrompt: 'I will run the mortgage on 240000 euro at 4.1 percent. Shall I run exactly that?',
      entries: []
    } },
    // The fresh audit sees the whole conversation, including the correction.
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'reject', confirmationPromptApproved: false,
      unresolvedAmbiguities: ['The balance was corrected to 340000 and the proposal still says 240000.'],
      clarifications: clarify('Should I use the corrected 340000 balance?'), revisionScope: 'reinterpretation'
    }) }
  ]);
  assert.equal(stale.result.certificate, null, 'a superseded figure cannot be certified by fixing its wording');
  assert.equal(stale.result.brief.readyToConfirm, false);
  assert.equal(inputOf(stale.result).currentBalance, 240000,
    'the rejected proposal is kept as it was, not silently rewritten by the server');
  // THE LATEST JUDGEMENT IS THE ONE THE CLIENT HEARS. The second audit refused
  // the revised proposal, and its question is the one that stands -- not the
  // first audit's, which described a read-back that no longer exists.
  assert.equal(stale.result.verification.clarifications[0].question, 'Should I use the corrected 340000 balance?');
  pass('a presentation revision preserves the proposal, and a fresh rejection still refuses to certify it');
}

/* ------- one revision replaces the read-back and its citations together ----- */

{
  // THE DEFECT THIS PINS. These were two mutually exclusive branches, so a
  // finding that involved BOTH -- a stale quote and the wording that recited it
  // -- could only be sent down one of them, and the other half stayed broken.
  const before = proposal();
  const revised = await run([
    { name: 'module_planning_snapshot_v1', value: before },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      unsupportedPaths: ['/currentBalance quote is superseded'],
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm the balance.'),
      revisionScope: 'presentation', revisionTargets: [{ moduleId: 'mortgage_analysis', path: '/currentBalance' }]
    }) },
    { name: 'module_presentation_revision_v1', value: {
      confirmationPrompt: `${PROMPT} It includes the 500 a year overpayment.`,
      entries: [{
        moduleId: 'mortgage_analysis', path: '/currentBalance', source: 'conversation',
        turnId: 't2', quote: 'The balance is actually 340000', profilePath: ''
      }]
    } },
    { name: 'module_input_verification_v1', value: verdict({}) }
  ]);
  assert.equal(revised.calls.length, 4, 'both halves in one revision, not two');
  assert.equal(inputOf(revised.result).currentBalance, 340000, 'the figure is untouched by a citation revision');
  assert.equal(inputOf(revised.result).annualOverpayment, 500);
  const balanceCitation = revised.result.snapshot.modules[0].evidence.find((entry) => entry.path === '/currentBalance');
  assert.equal(balanceCitation.turnId, 't2', 'and the citation now points at the turn that established it');
  assert.ok(citedPaths(revised.result).has('/annualOverpayment'), 'every other citation is still there');
  assert.match(revised.result.snapshot.confirmationPrompt, /500 a year overpayment/, 'and the read-back was replaced too');
  assert.ok(revised.result.certificate);
  pass('one revision replaces exactly the named citations and the read-back, and leaves the figures alone');
}

/* ---- a revision that leaves a value uncited is refused, not adopted ------- */

{
  const starved = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      unsupportedPaths: ['/currentBalance'], clarifications: clarify('Please confirm the balance.'),
      revisionScope: 'presentation', revisionTargets: [{ moduleId: 'mortgage_analysis', path: '/currentBalance' }]
    }) },
    // Returns nothing for the target, so the balance loses its only citation.
    { name: 'module_presentation_revision_v1', value: { confirmationPrompt: null, entries: [] } }
  ]);
  // WAS: a failed narrow repair fell through to an unconditional full re-author,
  // making three author calls possible. There is one revision now. A candidate
  // the SERVER had to downgrade decided nothing, so it is refused outright and
  // the client keeps the auditor's question.
  assert.equal(starved.calls.length, 3, 'the unsupported candidate is abandoned before a second audit');
  assert.equal(starved.result.certificate, null);
  assert.equal(inputOf(starved.result).currentBalance, 340000, 'and the original proposal stands');
  assert.ok(citedPaths(starved.result).has('/currentBalance'), 'with its citation intact');
  assert.equal(starved.result.verification.clarifications[0].question, 'Please confirm the balance.',
    'and the client keeps the original question');
  pass('a citation revision that leaves a value uncited is refused, and changes nothing');
}

/* -------- a reinterpretation may change meaning, but not silently unsupport - */

{
  // `reinterpretation` scope, and the re-author drops the overpayment's citation
  // while keeping the value. That is a provenance regression, not a correction.
  const regressed = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      unsupportedPaths: ['/currentBalance'], clarifications: clarify('Please confirm the balance.'),
      revisionScope: 'reinterpretation'
    }) },
    { name: 'module_planning_snapshot_v1', value: proposal({ dropEvidenceFor: '/annualOverpayment' }) }
  ]);
  assert.equal(regressed.calls.length, 3, 'the regressed candidate is abandoned before a second audit');
  assert.equal(regressed.result.certificate, null);
  assert.equal(inputOf(regressed.result).annualOverpayment, 500,
    'and the original proposal, with its support intact, is what stands');
  pass('a reinterpretation that unsupports a value it was not asked about is not adopted');
}

/* ---- but a reinterpretation that WITHDRAWS a value is adopted, not discarded */

{
  // THE DEFECT THIS PINS, from the seeded withdrawn-rate probe. The client
  // retracts their certainty about the rate. The re-author correctly moves the
  // module to collecting with the rate unknown -- and because a collecting
  // module cannot run, that correct recovery used to be thrown away, leaving
  // the snapshot reporting the withdrawn 4.1% as the client's current position.
  // Certification stayed blocked either way, so nothing ever executed; but
  // Realtime steers on this state, and it was steering on a retracted number.
  //
  // Adopting a state and authorising execution are different decisions.
  const withdrawn = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'reject', confirmationPromptApproved: false,
      unsupportedPaths: ['/annualInterestRate'],
      clarifications: clarify('Do you still want to use 4.1 percent?'), revisionScope: 'reinterpretation'
    }) },
    { name: 'module_planning_snapshot_v1', value: (() => {
      const candidate = structuredClone(proposal());
      const input = JSON.parse(candidate.modules[0].inputJson);
      input.annualInterestRate = null;
      candidate.modules[0].inputJson = JSON.stringify(input);
      candidate.modules[0].status = 'collecting';
      candidate.modules[0].missing = [{ path: '/annualInterestRate',
        reason: 'The client withdrew their certainty about the rate.', question: 'What rate should I use?' }];
      candidate.modules[0].evidence = candidate.modules[0].evidence
        .filter((entry) => entry.path !== '/annualInterestRate');
      candidate.confirmationPrompt = '';
      return candidate;
    })() }
  ]);
  assert.equal(withdrawn.calls.length, 3, 'a collecting candidate is not certifiable, so it is not re-audited');
  assert.equal(withdrawn.result.certificate, null, 'and it can never authorise execution');
  assert.equal(withdrawn.result.brief.readyToConfirm, false);
  assert.equal(withdrawn.result.snapshot.modules[0].status, 'collecting',
    'the planner\'s own judgement that the plan is not ready is what stands');
  assert.equal(inputOf(withdrawn.result).annualInterestRate, null,
    'and the withdrawn figure does not survive as current state');
  pass('a reinterpretation that withdraws a value to unknown is adopted as state, and certifies nothing');
}

/* ------ a refused plan stops advertising the meaning the review refused ---- */

{
  // THE DEFECT THIS PINS, the residual of the seeded withdrawn-rate probe. The
  // auditor rejects the rate, declares a genuine unresolved ambiguity -- so no
  // revision is permitted, correctly, because only the client can settle it --
  // and the snapshot went on saying 4.1% and `ready`. Execution was blocked
  // throughout, so this was never a safety failure; it was the conversation
  // holding a belief an independent review had just taken away, and Realtime
  // steers on exactly that state.
  //
  // The AI names what is unresolved. Code only applies the answer.
  const refused = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'reject', confirmationPromptApproved: false,
      unresolvedAmbiguities: ['The client withdrew their certainty about the rate and cannot check it now.'],
      clarifications: [{ id: 'rate', question: 'What rate should I use once you can check it?',
        relatedModuleIds: ['mortgage_analysis'], relatedPaths: ['/annualInterestRate'] }],
      revisionScope: 'none'
    }) }
  ]);
  assert.equal(refused.calls.length, 2, 'a genuine ambiguity still spends no revision');
  assert.equal(refused.result.certificate, null, 'and certifies nothing');
  assert.equal(refused.result.brief.readyToConfirm, false);
  assert.equal(refused.result.snapshot.modules[0].status, 'collecting',
    'the module the review refused stops advertising that it is ready to run');
  assert.equal(inputOf(refused.result).annualInterestRate, null,
    'and the figure the review could not resolve is unknown, not stale');
  assert.ok(!citedPaths(refused.result).has('/annualInterestRate'),
    'the citation that supported it supports nothing now');
  assert.ok(refused.result.snapshot.modules[0].missing.some((need) => need.path === '/annualInterestRate'),
    'and it is on the list of what is still needed');
  // ONLY EVER AWAY FROM READY. Every figure the review did NOT name is left
  // exactly as the planner authored it: this applies a refusal, it does not
  // form a second opinion about the client's money.
  assert.equal(inputOf(refused.result).currentBalance, 340000, 'an unnamed figure is untouched');
  assert.equal(inputOf(refused.result).annualOverpayment, 500);
  assert.ok(citedPaths(refused.result).has('/currentBalance'), 'and keeps its citation');
  pass('a refused plan stops advertising the meaning the review refused, and still certifies nothing');
}

/* ------- and a refusal naming no module retires readiness for the plan ----- */

{
  const wholePlan = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'reject', confirmationPromptApproved: false,
      unresolvedAmbiguities: ['The conversation does not establish whose mortgage this is.'],
      clarifications: [{ id: 'owner', question: 'Whose mortgage should I review?',
        relatedModuleIds: [], relatedPaths: [] }],
      revisionScope: 'none'
    }) }
  ]);
  assert.equal(wholePlan.result.certificate, null);
  assert.equal(wholePlan.result.snapshot.modules[0].status, 'collecting',
    'a refusal that names no module retires readiness across the plan, because the plan is what was refused');
  // Nothing was named, so nothing is erased: the figures stand, and the client
  // is asked the auditor's question.
  assert.equal(inputOf(wholePlan.result).currentBalance, 340000);
  assert.equal(wholePlan.result.verification.clarifications[0].question, 'Whose mortgage should I review?');
  pass('an unnamed refusal retires readiness without erasing a figure nobody disputed');
}

/* ---------- a passing verdict is never touched by any of the above --------- */

{
  // The guard runs only on a non-pass. A clean pass must reach its certificate
  // with every figure, citation and status exactly as authored -- this is the
  // barrier that keeps the rule above from ever being able to grant or block
  // an execution it was not asked about.
  const clean = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({}) }
  ]);
  assert.ok(clean.result.certificate, 'a clean pass still certifies');
  assert.equal(clean.result.snapshot.modules[0].status, 'ready');
  assert.equal(inputOf(clean.result).annualInterestRate, 0.041, 'and nothing was cleared');
  assert.ok(citedPaths(clean.result).has('/annualInterestRate'));
  pass('a passing verdict is untouched: the refusal rule only ever moves a module away from ready');
}

/* ------------------- a genuine ambiguity is never revised at all ----------- */

{
  const ambiguous = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'reject', confirmationPromptApproved: false,
      unresolvedAmbiguities: ['Whose mortgage is this?'],
      clarifications: clarify('Is that mortgage yours or held jointly?'), revisionScope: 'presentation'
    }) }
  ]);
  assert.equal(ambiguous.calls.length, 2,
    'a competing reading is never revised, whatever scope the auditor asks for');
  assert.equal(ambiguous.result.certificate, null);
  assert.equal(ambiguous.result.verification.clarifications[0].question, 'Is that mortgage yours or held jointly?');
  pass('an unresolved ambiguity goes to the client, and no scope can turn it into a revision');
}

/* -------- an explicit `none` is dispatched as written, and costs nothing ---- */

{
  // THE DEFECT THIS PINS. An explicit `none` used to be overridden into the
  // widest re-author, on the theory that it was the safest default. It is not a
  // default: it is the auditor's judgement that nothing the planner can do
  // alone would fix this, and overriding it spent two calls re-deriving the
  // verdict that had already said so.
  const asked = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Which balance should I use?'), revisionScope: 'none'
    }) }
  ]);
  assert.equal(asked.calls.length, 2, 'an explicit `none` dispatches no further provider work');
  assert.equal(asked.result.certificate, null);
  assert.equal(asked.result.verification.clarifications[0].question, 'Which balance should I use?');
  pass('an auditor that says only the client can help is believed, and the client is asked');
}

/* --------------- an acknowledged unknown survives every revision ------------ */

{
  const acknowledged = [{ moduleId: 'mortgage_analysis', path: '/annualInterestRate', sourceTurnId: 't1' }];
  const blocked = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() }
  ], { acknowledgedUnknown: acknowledged });
  const row = blocked.result.snapshot.modules[0];
  assert.notEqual(row.status, 'ready',
    'a requirement the client said they cannot answer keeps the module out of the ready state');
  assert.equal(blocked.result.certificate, null);
  assert.equal(blocked.calls.length, 1, 'and it is not revisable: only the client can resolve it');
  pass('an acknowledged unknown is server-owned and no revision path can erase it');
}

/* --- a re-author may not swap a leaf citation for a parent one and pass ---- */

{
  // WHERE THE PROTECTION ACTUALLY LIVES. I wrote a separate non-regression
  // guard for this and removed it: mutation-testing showed it caught nothing,
  // because a value that loses its citation stops the module being ready and a
  // server-downgraded candidate is never adopted. This case pins that lower
  // layer, so a later change to readiness cannot quietly open the hole the
  // guard was supposed to cover.
  const swapped = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      unsupportedPaths: ['/currentBalance'], clarifications: clarify('Please confirm the balance.'),
      revisionScope: 'reinterpretation'
    }) },
    { name: 'module_planning_snapshot_v1', value: (() => {
      const candidate = structuredClone(proposal());
      // /annualOverpayment keeps its value but loses the client's words.
      candidate.modules[0].evidence = candidate.modules[0].evidence
        .filter((entry) => entry.path !== '/annualOverpayment');
      return candidate;
    })() }
  ]);
  assert.equal(swapped.calls.length, 3, 'the candidate that lost a citation is abandoned before a second audit');
  assert.equal(swapped.result.certificate, null);
  assert.ok(citedPaths(swapped.result).has('/annualOverpayment'),
    'the original proposal, with the client\'s own words behind the figure, is what stands');
  pass('a re-author cannot drop the client\'s citation for a figure it was not asked about');
}

/* ------- a target the planner cannot act on costs nothing and changes nothing */

{
  // THE DEFECT THIS PINS. revisionTargets left its address space unstated, so
  // the auditor addressed a citation the way it addresses findings --
  // /evidence/0 rather than /currentBalance -- and the revision matched nothing,
  // replaced nothing, and burned a call to return the proposal unchanged. The
  // contract now says input pointers; this makes the failure mode safe either way.
  const misaddressed = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      unsupportedPaths: ['/modules/0/evidence/0'], clarifications: clarify('Please confirm the balance.'),
      revisionScope: 'presentation', revisionTargets: [{ moduleId: 'mortgage_analysis', path: '/evidence/0' }]
    }) },
    { name: 'module_presentation_revision_v1', value: { confirmationPrompt: null, entries: [] } },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'reject', confirmationPromptApproved: false,
      unsupportedPaths: ['/modules/0/evidence/0'], clarifications: clarify('Please confirm the balance.'),
      revisionScope: 'none'
    }) }
  ]);
  assert.equal(misaddressed.result.certificate, null, 'an unactionable target certifies nothing');
  assert.equal(inputOf(misaddressed.result).currentBalance, 340000, 'and changes no figure');
  assert.ok(citedPaths(misaddressed.result).has('/currentBalance'), 'and drops no citation');
  pass('a revision target the planner cannot act on leaves the proposal exactly as it was');
}

/* ---------------- a reinterpretation earns its own certificate -------------- */

{
  // THE SEQUENCE THIS PINS. The auditor judged the financial content wrong, so
  // the one revision is a full re-author -- from the proposal it rejected, over
  // the same conversation -- and it must pass a fresh audit of its own to be
  // adopted at all.
  //
  // WAS: a narrow repair first, and a full re-author only as an unconditional
  // fallback when the narrow one gave up. Six calls, and the auditor's own
  // judgement about which was needed was ignored on the way down.
  const rescued = await run([
    { name: 'module_planning_snapshot_v1', value: proposal({ balance: 240000, quote: '240000' }) },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'reject', confirmationPromptApproved: false,
      unresolvedAmbiguities: [],
      unsupportedPaths: ['/currentBalance was superseded by the correction'],
      clarifications: clarify('Please confirm the balance.'), revisionScope: 'reinterpretation'
    }) },
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({}) }
  ]);
  assert.equal(rescued.calls.length, 4, 'author, review, one re-author, review');
  assert.ok(rescued.result.certificate, 'and the re-authored plan is certified on its own fresh audit');
  assert.equal(inputOf(rescued.result).currentBalance, 340000, 'having moved the figure the auditor said was wrong');
  pass('a reinterpretation may move a figure, and earns its own certificate on a fresh audit');
}

/* ------- and a reinterpretation cannot resurrect a figure the client corrected */

{
  // THE DANGEROUS SHAPE. A reinterpretation CAN move a figure -- including
  // backwards. Nothing deterministic stops it, and nothing should: only the
  // independent audit can tell a correction from a mistake. This drives exactly
  // that, and the audit must refuse it.
  const resurrect = await run([
    { name: 'module_planning_snapshot_v1', value: proposal({ confirmationPrompt: 'Shall I run that?' }) },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm the balance.'), revisionScope: 'reinterpretation'
    }) },
    // The re-author puts the SUPERSEDED 240000 back and reads it back cleanly.
    { name: 'module_planning_snapshot_v1', value: proposal({ balance: 240000, quote: '240000' }) },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'reject', confirmationPromptApproved: false,
      unresolvedAmbiguities: ['The balance was corrected to 340000 and this proposal says 240000.'],
      clarifications: clarify('Should I use the corrected 340000 balance?'), revisionScope: 'none'
    }) }
  ]);
  assert.equal(resurrect.result.certificate, null, 'a re-authored stale figure earns no certificate');
  assert.equal(resurrect.result.brief.readyToConfirm, false);
  // THE STATE AND THE VERDICT MOVE TOGETHER. The re-author is the planner's own
  // reading and it is adopted; the audit that refused it is the verdict the
  // client hears. Keeping the older proposal while reporting the newer verdict
  // would leave the question describing figures the snapshot does not hold.
  assert.equal(inputOf(resurrect.result).currentBalance, 240000,
    'the newest reading is the state, and it is refused, and it cannot run');
  assert.equal(resurrect.result.verification.clarifications[0].question, 'Should I use the corrected 340000 balance?');
  pass('a reinterpretation may move a figure backwards, and a fresh rejection blocks it from executing');
}

/* -------- an adopted revision that changes meaning is a different plan ------ */

{
  // The client must be asked again when the plan they were read is not the plan
  // that would run. Plan identity is what the confirmation offer is bound to,
  // so a revision that moves a figure has to produce a different identity.
  const before = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({}) }
  ]);
  const after = await run([
    { name: 'module_planning_snapshot_v1', value: proposal({ confirmationPrompt: 'Shall I run that?' }) },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm.'), revisionScope: 'reinterpretation'
    }) },
    // A DIFFERENT overpayment: supported, honest, and not what was read out.
    { name: 'module_planning_snapshot_v1', value: proposal({ overpayment: 0 }) },
    { name: 'module_input_verification_v1', value: verdict({}) }
  ]);
  assert.ok(before.result.certificate && after.result.certificate);
  assert.equal(inputOf(after.result).annualOverpayment, 0, 'the revision changed a client-facing figure');
  assert.notEqual(
    directModulePlanMeaningKey(after.result.snapshot, after.result.certificate),
    directModulePlanMeaningKey(before.result.snapshot, before.result.certificate),
    'so it is a different plan, and the offer bound to the old one cannot survive it'
  );
  pass('a revision that changes client-facing meaning produces a different plan identity, forcing fresh confirmation');
}

/* ----------- the revision is affordable work, not unconditional work ------- */

{
  // A REVISION NOBODY CAN VERIFY IS MONEY SPENT ON NOTHING. With only enough
  // allowance for the two calls already made, the revision is not started: the
  // client gets the auditor's question rather than a call the operation cannot
  // pay to check.
  //
  // DEFENDED TWICE, DELIBERATELY. roomForRevision() declines to start it, and
  // structuredResponse refuses an over-allowance call before dispatch. Removing
  // either one leaves this assertion passing, which is the point: the guarantee
  // does not rest on the polite check remembering to run.
  const broke = await run([
    { name: 'module_planning_snapshot_v1', value: proposal({ confirmationPrompt: 'Shall I run that?' }) },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm the balance.'), revisionScope: 'reinterpretation'
    }) }
  ], { operation: { id: 'tight', deadlineAt: null, callAllowance: 3, callsUsed: 0, controller: new AbortController() } });
  assert.equal(broke.calls.length, 2, 'an exhausted allowance does not start a revision it cannot audit');
  assert.equal(broke.result.certificate, null);
  assert.equal(broke.result.verification.clarifications[0].question, 'Please confirm the balance.');
  pass('the revision is skipped when the operation cannot afford it, and the client is asked instead');
}

console.info(`[RevisionPreservation] ${checks} checks passed.`);
