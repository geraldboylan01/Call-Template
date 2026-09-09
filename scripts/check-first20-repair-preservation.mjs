#!/usr/bin/env node

/**
 * A REPAIR MAY NOT QUIETLY DROP WHAT IT WAS NOT ASKED ABOUT.
 *
 * THE DEFECT THIS PINS. A repair was handed the whole snapshot and asked for
 * the whole snapshot back, so "preserve everything else" was an instruction
 * rather than a property -- and it did not hold. One real House repair fixed
 * the cost read-back and cut its evidence from 59 entries to 22; another
 * restored the household cash flow while dropping the cost amounts it had just
 * been told to add; a third returned an empty confirmation.
 *
 * THE MECHANISM. The auditor declares what must change. `confirmation` and
 * `evidence` repairs are applied to the proposal the planner already made:
 * the model is handed one artefact to replace and its reply cannot reach the
 * inputs, so there is never a second version of a figure to choose between and
 * nothing to merge. `input` means the proposal itself is wrong -- a full
 * re-author, no preservation claim, and a fresh independent audit.
 *
 * WHAT THIS FILE HAS TO PROVE is the other half: that preservation can never
 * become resurrection. A narrow repair keeps the proposal's figures, so if one
 * of those figures is stale the fresh audit must still refuse it, and no
 * certificate may exist. Every case below ends by checking that.
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
const pass = (message) => { checks += 1; console.info(`[RepairPreservation] PASS: ${message}`); };

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
    baseSnapshotRevision: 0,
    throughTurnId: 't2',
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
  repairScope: 'none', repairTargets: [], explanation: 'scripted'
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

/* ---------- a confirmation repair cannot reach a figure, an owner or a quote */

{
  // The read-back forgot the overpayment. The auditor says so, and scopes it.
  const repaired = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt annual overpayment'],
      clarifications: clarify('Please confirm the overpayment.'), repairScope: 'confirmation'
    }) },
    { name: 'module_confirmation_repair_v1', value: {
      confirmationPrompt: `${PROMPT} It includes the 500 a year overpayment.`
    } },
    { name: 'module_input_verification_v1', value: verdict({}) }
  ]);
  assert.equal(repaired.calls.length, 4);
  assert.equal(inputOf(repaired.result).currentBalance, 340000, 'the corrected balance survives the repair');
  assert.equal(inputOf(repaired.result).annualOverpayment, 500, 'and so does every other figure');
  assert.deepEqual([...citedPaths(repaired.result)].sort(),
    [...citedPaths(await run([{ name: 'module_planning_snapshot_v1', value: proposal() },
      { name: 'module_input_verification_v1', value: verdict({}) }]).then((r) => r.result))].sort(),
    'not one citation was dropped: the repair was never handed the evidence to return');
  assert.ok(repaired.result.certificate, 'and the corrected plan is certified');
  pass('a read-back repair fixes the words and cannot drop a figure, an owner or a citation');
}

/* ------------------ ...and it cannot resurrect a superseded figure either --- */

{
  // The proposal carries the SUPERSEDED balance. A confirmation repair keeps
  // the inputs -- that is the whole point -- so the only thing standing
  // between a stale figure and a certificate is the fresh audit. It must hold.
  const stale = await run([
    { name: 'module_planning_snapshot_v1', value: proposal({ balance: 240000, quote: '240000' }) },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm the balance.'), repairScope: 'confirmation'
    }) },
    { name: 'module_confirmation_repair_v1', value: {
      confirmationPrompt: 'I will run the mortgage on 240000 euro at 4.1 percent. Shall I run exactly that?'
    } },
    // The fresh audit sees the whole conversation, including the correction.
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'reject', confirmationPromptApproved: false,
      unresolvedAmbiguities: ['The balance was corrected to 340000 and the proposal still says 240000.'],
      clarifications: clarify('Should I use the corrected 340000 balance?'), repairScope: 'input'
    }) }
  ]);
  assert.equal(stale.result.certificate, null, 'a superseded figure cannot be certified by fixing its wording');
  assert.equal(stale.result.brief.readyToConfirm, false);
  assert.equal(inputOf(stale.result).currentBalance, 240000,
    'the rejected proposal is kept as it was, not silently rewritten by the server');
  pass('a narrow repair preserves the proposal, and a fresh rejection still refuses to certify it');
}

/* --------------- an evidence repair replaces citations, not the values ------ */

{
  const before = proposal();
  const repaired = await run([
    { name: 'module_planning_snapshot_v1', value: before },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      unsupportedPaths: ['/currentBalance quote is superseded'],
      clarifications: clarify('Please confirm the balance.'),
      repairScope: 'evidence', repairTargets: [{ moduleId: 'mortgage_analysis', path: '/currentBalance' }]
    }) },
    { name: 'module_evidence_repair_v1', value: { entries: [{
      moduleId: 'mortgage_analysis', path: '/currentBalance', source: 'conversation',
      turnId: 't2', quote: 'The balance is actually 340000', profilePath: ''
    }] } },
    { name: 'module_input_verification_v1', value: verdict({}) }
  ]);
  assert.equal(inputOf(repaired.result).currentBalance, 340000, 'the figure is untouched by a citation repair');
  assert.equal(inputOf(repaired.result).annualOverpayment, 500);
  const balanceCitation = repaired.result.snapshot.modules[0].evidence.find((entry) => entry.path === '/currentBalance');
  assert.equal(balanceCitation.turnId, 't2', 'and the citation now points at the turn that established it');
  assert.ok(citedPaths(repaired.result).has('/annualOverpayment'), 'every other citation is still there');
  assert.ok(repaired.result.certificate);
  pass('a citation repair replaces exactly the named citations and leaves the figures alone');
}

/* ---- an evidence repair that leaves a value uncited is refused, not adopted */

{
  const starved = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      unsupportedPaths: ['/currentBalance'], clarifications: clarify('Please confirm the balance.'),
      repairScope: 'evidence', repairTargets: [{ moduleId: 'mortgage_analysis', path: '/currentBalance' }]
    }) },
    // Returns nothing for the target, so the balance loses its only citation.
    { name: 'module_evidence_repair_v1', value: { entries: [] } },
    // The narrow attempt did not fix it, so the fallback re-authors from the
    // REJECTED proposal -- and this one still cannot support the balance.
    { name: 'module_planning_snapshot_v1', value: proposal({ dropEvidenceFor: '/currentBalance' }) }
  ]);
  assert.equal(starved.calls.length, 4, 'a failed narrow repair falls back to one full re-author');
  assert.equal(starved.result.certificate, null);
  assert.equal(starved.result.verification.clarifications[0].question, 'Please confirm the balance.',
    'and when that fails too the client keeps the original question');
  pass('a citation repair that leaves a value uncited is refused, and the fallback cannot rescue it either');
}

/* -------- a full re-author may change meaning, but not silently unsupport --- */

{
  // `input` scope, and the re-author drops the overpayment's citation while
  // keeping the value. That is a provenance regression, not a correction.
  const regressed = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      unsupportedPaths: ['/currentBalance'], clarifications: clarify('Please confirm the balance.'),
      repairScope: 'input'
    }) },
    { name: 'module_planning_snapshot_v1', value: proposal({ dropEvidenceFor: '/annualOverpayment' }) }
  ]);
  assert.equal(regressed.calls.length, 3, 'the regressed candidate is abandoned before a second audit');
  assert.equal(regressed.result.certificate, null);
  assert.equal(inputOf(regressed.result).annualOverpayment, 500,
    'and the original proposal, with its support intact, is what stands');
  pass('a full re-author that unsupports a value it was not asked about is not adopted');
}

/* ------------------- a genuine ambiguity is never repaired at all ----------- */

{
  const ambiguous = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'reject', confirmationPromptApproved: false,
      unresolvedAmbiguities: ['Whose mortgage is this?'],
      clarifications: clarify('Is that mortgage yours or held jointly?'), repairScope: 'confirmation'
    }) }
  ]);
  assert.equal(ambiguous.calls.length, 2,
    'a competing reading is never repaired, whatever scope the auditor asks for');
  assert.equal(ambiguous.result.certificate, null);
  assert.equal(ambiguous.result.verification.clarifications[0].question, 'Is that mortgage yours or held jointly?');
  pass('an unresolved ambiguity goes to the client, and no scope can turn it into a repair');
}

/* --------------- an acknowledged unknown survives every repair -------------- */

{
  const acknowledged = [{ moduleId: 'mortgage_analysis', path: '/annualInterestRate', sourceTurnId: 't1' }];
  const blocked = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() }
  ], { acknowledgedUnknown: acknowledged });
  const row = blocked.result.snapshot.modules[0];
  assert.notEqual(row.status, 'ready',
    'a requirement the client said they cannot answer keeps the module out of the ready state');
  assert.equal(blocked.result.certificate, null);
  assert.equal(blocked.calls.length, 1, 'and it is not repairable: only the client can resolve it');
  pass('an acknowledged unknown is server-owned and no repair path can erase it');
}

/* --- a re-author may not swap a leaf citation for a parent one and pass ---- */

{
  // WHERE THE PROTECTION ACTUALLY LIVES. I wrote a separate non-regression
  // guard for this and removed it: mutation-testing showed it caught nothing,
  // because a value that loses its citation stops the module being ready and an
  // unready candidate is never adopted. This case pins that lower layer, so a
  // later change to readiness cannot quietly open the hole the guard was
  // supposed to cover.
  const widened = structuredClone(proposal());
  widened.modules[0].evidence = widened.modules[0].evidence
    .filter((entry) => entry.path !== '/annualOverpayment');
  const swapped = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      unsupportedPaths: ['/currentBalance'], clarifications: clarify('Please confirm the balance.'),
      repairScope: 'input'
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
  // THE DEFECT THIS PINS. repairTargets left its address space unstated, so the
  // auditor addressed a citation the way it addresses findings -- /evidence/0
  // rather than /currentBalance -- and the repair matched nothing, replaced
  // nothing, and burned a call to return the proposal unchanged. The contract
  // now says input pointers; this makes the failure mode safe either way.
  const misaddressed = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      unsupportedPaths: ['/modules/0/evidence/0'], clarifications: clarify('Please confirm the balance.'),
      repairScope: 'evidence', repairTargets: [{ moduleId: 'mortgage_analysis', path: '/evidence/0' }]
    }) },
    { name: 'module_evidence_repair_v1', value: { entries: [] } }
  ]);
  assert.equal(misaddressed.result.certificate, null, 'an unactionable target certifies nothing');
  assert.equal(inputOf(misaddressed.result).currentBalance, 340000, 'and changes no figure');
  assert.ok(citedPaths(misaddressed.result).has('/currentBalance'), 'and drops no citation');
  pass('a repair target the planner cannot act on leaves the proposal exactly as it was');
}

/* ---------------- the fallback is a fresh candidate, not a second patch ----- */

{
  // THE SEQUENCE THIS PINS. A narrow repair is tried first because it cannot
  // touch a figure. When it does not fix the finding, a full re-author follows
  // -- from the proposal the AUDITOR rejected, over the same conversation --
  // and it must pass a fresh audit of its own to be adopted at all.
  const rescued = await run([
    { name: 'module_planning_snapshot_v1', value: proposal({ confirmationPrompt: 'Shall I run that?' }) },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm the balance.'), repairScope: 'confirmation'
    }) },
    // The narrow attempt returns a read-back that still says nothing useful.
    { name: 'module_confirmation_repair_v1', value: { confirmationPrompt: 'Shall I run that?' } },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm the balance.'), repairScope: 'confirmation'
    }) },
    // Fallback: a full re-author, which this time reads the plan back properly.
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({}) }
  ]);
  assert.equal(rescued.calls.length, 6, 'narrow first, then one full re-author, each with its own audit');
  assert.ok(rescued.result.certificate, 'and the re-authored plan is certified on its own fresh audit');
  assert.equal(inputOf(rescued.result).currentBalance, 340000);
  pass('a failed narrow repair falls back to a full re-author that earns its own certificate');
}

/* ------- and the fallback cannot resurrect a figure the client corrected ---- */

{
  // THE DANGEROUS SHAPE. The fallback is a full re-author, so it CAN move a
  // figure -- including backwards. Nothing deterministic stops it, and nothing
  // should: only the independent audit can tell a correction from a mistake.
  // This drives exactly that, and the audit must refuse it.
  const resurrect = await run([
    { name: 'module_planning_snapshot_v1', value: proposal({ confirmationPrompt: 'Shall I run that?' }) },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm the balance.'), repairScope: 'confirmation'
    }) },
    { name: 'module_confirmation_repair_v1', value: { confirmationPrompt: 'Shall I run that?' } },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm the balance.'), repairScope: 'confirmation'
    }) },
    // The re-author puts the SUPERSEDED 240000 back and reads it back cleanly.
    { name: 'module_planning_snapshot_v1', value: proposal({ balance: 240000, quote: '240000' }) },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'reject', confirmationPromptApproved: false,
      unresolvedAmbiguities: ['The balance was corrected to 340000 and this proposal says 240000.'],
      clarifications: clarify('Should I use the corrected 340000 balance?'), repairScope: 'input'
    }) }
  ]);
  assert.equal(resurrect.result.certificate, null, 'a re-authored stale figure earns no certificate');
  assert.equal(resurrect.result.brief.readyToConfirm, false);
  assert.equal(inputOf(resurrect.result).currentBalance, 340000,
    'and the rejected re-author is discarded: the corrected proposal is what stands');
  pass('the fallback may move a figure, and a fresh rejection still blocks it from executing');
}

/* -------- an adopted fallback that changes meaning is a different plan ------ */

{
  // The client must be asked again when the plan they were read is not the plan
  // that would run. Plan identity is what the confirmation offer is bound to,
  // so a fallback that moves a figure has to produce a different identity.
  const before = await run([
    { name: 'module_planning_snapshot_v1', value: proposal() },
    { name: 'module_input_verification_v1', value: verdict({}) }
  ]);
  const after = await run([
    { name: 'module_planning_snapshot_v1', value: proposal({ confirmationPrompt: 'Shall I run that?' }) },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm.'), repairScope: 'confirmation'
    }) },
    { name: 'module_confirmation_repair_v1', value: { confirmationPrompt: 'Shall I run that?' } },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm.'), repairScope: 'confirmation'
    }) },
    // A DIFFERENT overpayment: supported, honest, and not what was read out.
    { name: 'module_planning_snapshot_v1', value: proposal({ overpayment: 0 }) },
    { name: 'module_input_verification_v1', value: verdict({}) }
  ]);
  assert.ok(before.result.certificate && after.result.certificate);
  assert.equal(inputOf(after.result).annualOverpayment, 0, 'the fallback changed a client-facing figure');
  assert.notEqual(
    directModulePlanMeaningKey(after.result.snapshot, after.result.certificate),
    directModulePlanMeaningKey(before.result.snapshot, before.result.certificate),
    'so it is a different plan, and the offer bound to the old one cannot survive it'
  );
  pass('a fallback that changes client-facing meaning produces a different plan identity, forcing fresh confirmation');
}

/* ----------- the fallback is affordable work, not unconditional work ------- */

{
  // A REPAIR NOBODY CAN VERIFY IS MONEY SPENT ON NOTHING, and that rule has to
  // reach the fallback too. With only enough allowance for the narrow attempt
  // and its audit, the re-author is not started: the client gets the auditor's
  // question rather than a call the operation cannot pay to check.
  //
  // DEFENDED TWICE, DELIBERATELY. roomForRepair() declines to start it, and
  // structuredResponse refuses an over-allowance call before dispatch. Removing
  // either one leaves this assertion passing, which is the point: the guarantee
  // does not rest on the polite check remembering to run.
  const broke = await run([
    { name: 'module_planning_snapshot_v1', value: proposal({ confirmationPrompt: 'Shall I run that?' }) },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm the balance.'), repairScope: 'confirmation'
    }) },
    { name: 'module_confirmation_repair_v1', value: { confirmationPrompt: 'Shall I run that?' } },
    { name: 'module_input_verification_v1', value: verdict({
      verdict: 'needs_clarification', confirmationPromptApproved: false,
      omittedSupportedInformation: ['/confirmationPrompt'],
      clarifications: clarify('Please confirm the balance.'), repairScope: 'confirmation'
    }) }
  ], { operation: { id: 'tight', deadlineAt: null, callAllowance: 4, callsUsed: 0, controller: new AbortController() } });
  assert.equal(broke.calls.length, 4, 'an exhausted allowance does not start a re-author it cannot audit');
  assert.equal(broke.result.certificate, null);
  assert.equal(broke.result.verification.clarifications[0].question, 'Please confirm the balance.');
  pass('the fallback is skipped when the operation cannot afford it, and the client is asked instead');
}

console.info(`[RepairPreservation] ${checks} checks passed.`);
