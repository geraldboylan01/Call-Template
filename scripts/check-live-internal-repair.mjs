#!/usr/bin/env node

/**
 * DO NOT ASK THE CLIENT TO FIX THE PLANNER'S BOOKKEEPING.
 *
 * THE DEFECT THIS PINS. Every non-pass verdict from the independent verifier
 * became a spoken question, because the audit does not distinguish "you never
 * told me this" from "the planner mis-cited something you did tell me". The
 * second kind reached the caller as a question they had already answered, with
 * the answer sitting in the transcript the entire time. That is the specific
 * failure that makes a call feel like it is not listening.
 *
 * THE RULE. A verdict whose findings are ALL about the planner's own work --
 * a citation it failed to make, information it omitted, prose that does not
 * match its own inputs -- earns exactly one repair against the same transcript,
 * the same window and the same contracts. An unresolved AMBIGUITY never
 * qualifies: competing readings can only be settled by the person. One attempt
 * is the entire budget, and a repair is adopted only if it actually passes, so
 * a failed repair costs latency and changes nothing the client hears.
 *
 * These checks drive the real `interpretDirectModuleConversation` with scripted
 * model responses, so the sequencing, the adoption rule and the budget are
 * proven rather than asserted about.
 */
import assert from 'node:assert/strict';

import { interpretDirectModuleConversation, MODULE_PLANNING_SNAPSHOT_V1, DIRECT_MODULE_CONTRACTS } from '../worker/src/consumer/direct_module_planner.js';
import { buildDirectModulePolicyEnvelope, directModulePolicyEntries } from '../js/planning/direct_module_policy.js';
import { directModuleTestInputs } from './live-harness/direct-fixtures.mjs';
import { readJsonPointer } from '../js/planning/utils.js';
import { stableStringify } from '../worker/src/consumer/crypto.js';

let checks = 0;
const pass = (message) => { checks += 1; console.info(`[LiveInternalRepair] PASS: ${message}`); };
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };

const TODAY = new Date().toISOString().slice(0, 10);
const INPUT = directModuleTestInputs(TODAY).mortgage_analysis;
const POLICY = buildDirectModulePolicyEnvelope({ calculationDateIso: TODAY, baseCurrency: 'EUR' });
const TRANSCRIPT = 'My repayment mortgage balance is 240000 euro at 4.1 percent with 22 years remaining, and I am considering no overpayments.';
const PROMPT = 'I will run the mortgage analysis on a 240000 euro repayment balance at 4.1 percent with 22 years left. Shall I run exactly that?';
const TURNS = [{ id: 'turn-1', role: 'user', transcript: TRANSCRIPT, answersTurnId: null }];
const PROFILE = {
  revision: 1,
  assumptions: { calculationDateIso: TODAY, values: {} },
  preferences: { baseCurrency: 'EUR' }
};
const CONFIG = {
  allowedModules: ['mortgage_analysis'],
  modulePlannerModel: 'test-model',
  modulePlannerReasoningEffort: 'low',
  realtimePromptVersion: 'p', realtimeToolsetVersion: 't'
};

function snapshotBody({ omitEvidenceFor = null, confirmationPrompt = PROMPT, ambiguities = [] } = {}) {
  const policy = directModulePolicyEntries('mortgage_analysis', INPUT, POLICY);
  return {
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    modules: [{
      moduleId: 'mortgage_analysis',
      outputKey: DIRECT_MODULE_CONTRACTS.mortgage_analysis.outputKey,
      status: 'ready',
      selection: { origin: 'client_requested', reason: 'you asked about your mortgage' },
      inputJson: JSON.stringify(INPUT),
      steeringSummary: 'your repayment mortgage',
      missing: [], ambiguities,
      assumptions: policy.filter((entry) => entry.mode === 'default'
        && (readJsonPointer(INPUT, entry.path) === undefined
          || stableStringify(readJsonPointer(INPUT, entry.path)) === stableStringify(entry.value)))
        .map((entry) => ({ path: entry.path, source: entry.source, valueJson: JSON.stringify(entry.value) })),
      // The repairable defect: a leaf the transcript supports, left uncited.
      evidence: Object.keys(INPUT)
        .filter((key) => key !== omitEvidenceFor)
        .map((key) => ({ path: `/${key}`, source: 'conversation', turnId: 'turn-1', quote: TRANSCRIPT, profilePath: '' }))
    }],
    generalAmbiguities: [],
    confirmationPrompt
  };
}

const VERDICTS = {
  pass: {
    schemaVersion: 'ModuleInputVerificationV1', verdict: 'pass',
    unsupportedPaths: [], omittedSupportedInformation: [], unresolvedAmbiguities: [],
    clarifications: [], confirmationPromptApproved: true,
    revisionScope: 'none', revisionTargets: [], explanation: 'scripted pass'
  },
  omission: {
    schemaVersion: 'ModuleInputVerificationV1', verdict: 'fail',
    unsupportedPaths: [], omittedSupportedInformation: ['/annualOverpayment'], unresolvedAmbiguities: [],
    clarifications: [{ moduleIds: ['mortgage_analysis'], paths: ['/annualOverpayment'], question: 'Do you make any yearly overpayments?' }],
    confirmationPromptApproved: false, revisionScope: 'reinterpretation', revisionTargets: [],
    explanation: 'the planner omitted a supported value'
  },
  ambiguity: {
    schemaVersion: 'ModuleInputVerificationV1', verdict: 'fail',
    unsupportedPaths: [], omittedSupportedInformation: [], unresolvedAmbiguities: ['whose mortgage'],
    clarifications: [{ moduleIds: ['mortgage_analysis'], paths: ['/currentBalance'], question: 'Is that mortgage yours or held jointly?' }],
    confirmationPromptApproved: false, revisionScope: 'reinterpretation', revisionTargets: [],
    explanation: 'two readings are possible'
  }
};

/** Drive the real planner with a scripted sequence of model replies. */
async function run(script, { deadlineAt = null, config = CONFIG } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    const kind = body.text?.format?.name === 'module_planning_snapshot_v1' ? 'extract' : 'verify';
    const envelope = JSON.parse(body.input?.[1]?.content || '{}');
    calls.push({ kind, findings: envelope.priorAuditFindings || null, proposal: envelope.proposedSnapshot || null,
      diagnostics: envelope.structuralDiagnostics || null });
    const next = script[calls.length - 1];
    assert.ok(next, `the script must cover model call ${calls.length} (${kind})`);
    assert.equal(next.kind, kind, `call ${calls.length} should be a ${next.kind}, not a ${kind}`);
    return { ok: true, json: async () => ({
      status: 'completed',
      output_text: JSON.stringify(next.value),
      usage: { input_tokens: 100, output_tokens: 10 }
    }) };
  };
  try {
    const result = await interpretDirectModuleConversation({
      env: { OPENAI_API_KEY: 'synthetic', CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url') },
      config,
      turns: TURNS,
      throughTurnId: 'turn-1',
      previousSnapshot: null,
      currentProfileContext: PROFILE,
      deadlineAt
    });
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

/* -------------------------------------------- a clean pass repairs nothing */

const clean = await run([
  { kind: 'extract', value: snapshotBody() },
  { kind: 'verify', value: VERDICTS.pass }
]);
assert.equal(clean.calls.length, 2);
ok(Boolean(clean.result.certificate), 'a passing plan is certified');
pass('a plan that passes first time costs exactly one extraction and one verification');

/* ------------------------------- the planner's own omission is repaired silently */

const repaired = await run([
  { kind: 'extract', value: snapshotBody({ omitEvidenceFor: 'annualOverpayment' }) },
  { kind: 'verify', value: VERDICTS.omission },
  { kind: 'extract', value: snapshotBody() },
  { kind: 'verify', value: VERDICTS.pass }
]);
assert.equal(repaired.calls.length, 4);
ok(repaired.calls[2].findings, 'the repair extraction is given the audit findings');
assert.deepEqual(repaired.calls[2].findings.omittedSupportedInformation, ['/annualOverpayment']);
ok(/independent audit rejected the proposal in failedProposal/.test(repaired.calls[2].findings.instruction),
  'the revision instruction tells the planner the findings are about its own work');
assert.deepEqual(repaired.calls[2].findings.failedProposal, repaired.calls[1].proposal,
  'the repair receives exactly the proposal the verifier rejected');
ok(!repaired.calls[0].findings, 'the first extraction is never given findings');
ok(Boolean(repaired.result.certificate), 'the repaired plan is certified');
assert.equal(repaired.result.verification.verdict, 'pass');
assert.deepEqual(repaired.result.verification.clarifications, []);
ok(Boolean(repaired.result.snapshot.confirmationPrompt), 'the repaired plan can be read back');
pass('an omission the transcript already answers is repaired without asking the client anything');

/* -------------------------- a genuine ambiguity still goes to the client at once */

const ambiguous = await run([
  { kind: 'extract', value: snapshotBody({ omitEvidenceFor: 'annualOverpayment' }) },
  { kind: 'verify', value: VERDICTS.ambiguity }
]);
assert.equal(ambiguous.calls.length, 2, 'an unresolved ambiguity must not spend a repair attempt');
assert.equal(ambiguous.result.certificate, null);
assert.equal(ambiguous.result.verification.clarifications[0].question, 'Is that mortgage yours or held jointly?');
pass('a genuine ambiguity is never repaired internally: only the client can settle competing readings');

/* --------------------------------- one attempt, and only an adopted repair counts */

const stubborn = await run([
  { kind: 'extract', value: snapshotBody({ omitEvidenceFor: 'annualOverpayment' }) },
  { kind: 'verify', value: VERDICTS.omission },
  { kind: 'extract', value: snapshotBody({ omitEvidenceFor: 'annualOverpayment' }) },
  { kind: 'verify', value: VERDICTS.omission }
]);
assert.equal(stubborn.calls.length, 4, 'the repair budget is exactly one attempt, never a loop');
assert.equal(stubborn.result.certificate, null);
assert.equal(stubborn.result.verification.clarifications[0].question, 'Do you make any yearly overpayments?');
pass('a revision that does not pass leaves the client with a question, never a certificate');

const failedRepair = await run([
  { kind: 'extract', value: snapshotBody({ omitEvidenceFor: 'annualOverpayment' }) },
  { kind: 'verify', value: VERDICTS.omission },
  { kind: 'extract', value: snapshotBody({ confirmationPrompt: '' }) }
]);
assert.equal(failedRepair.calls.length, 3, 'a repair that cannot even be read back is abandoned before a second audit');
assert.equal(failedRepair.result.certificate, null);
assert.equal(failedRepair.result.verification.clarifications[0].question, 'Do you make any yearly overpayments?');
pass('an unreadable repair is abandoned without spending a verification, and changes nothing');

/* ------------- structural provenance is reviewed, not repaired blind ------- */

// THE DEFECT THIS PINS, found in the paid v9 corpus. Structural provenance and
// the semantic verifier shared ONE repair budget, and structural ran first. A
// snapshot needing a citation repaired therefore spent the budget before the
// verifier had ever seen it, and the verifier's own finding -- a stale quote,
// a read-back omission, both squarely the planner's own bookkeeping -- had no
// repair left. College asked a parent to reconfirm an age they had already
// corrected. House purchase asked for figures already given.
//
// THE FIX IS NO LONGER A SECOND BUDGET. They were never two problems: a bad
// citation and the prose that recites it are one proposal seen from two sides.
// A provenance failure is now REPORTED to the auditor rather than repaired
// behind its back, so one judgement covers both -- and the auditor can say the
// figure should not be there at all, instead of the planner spending a call
// perfecting a quote for a value that was wrong.
//
// `currentBalance` carries no policy assumption, so omitting its citation is a
// structural provenance failure rather than a semantic one.

const structuralReviewed = await run([
  { kind: 'extract', value: snapshotBody({ omitEvidenceFor: 'currentBalance' }) },
  { kind: 'verify', value: VERDICTS.omission },
  { kind: 'extract', value: snapshotBody() },
  { kind: 'verify', value: VERDICTS.pass }
]);
assert.equal(structuralReviewed.calls.length, 4,
  'author, review, one revision, review -- not a structural repair before anyone had looked');
ok(structuralReviewed.calls[1].proposal,
  'the auditor sees the proposal whose provenance failed, rather than a repair made behind its back');
assert.deepEqual(structuralReviewed.calls[1].diagnostics?.map((item) => item.paths), [['/currentBalance']],
  'and is told exactly which paths the server could not resolve');
ok(structuralReviewed.calls[2].findings?.structuralDiagnostics,
  'the revision is told the same thing');
ok(Boolean(structuralReviewed.result.certificate),
  'the plan the client hears is certified rather than turned into a question they already answered');
assert.deepEqual(structuralReviewed.result.verification.clarifications, []);
pass('a provenance gap reaches the auditor, and one revision fixes it: four calls, one certificate');

// AND THE CEILING IS ONE. A stubborn planner spends it and stops.
const spent = await run([
  { kind: 'extract', value: snapshotBody({ omitEvidenceFor: 'currentBalance' }) },
  { kind: 'verify', value: VERDICTS.omission },
  { kind: 'extract', value: snapshotBody() },
  { kind: 'verify', value: VERDICTS.omission }
]);
assert.equal(spent.calls.length, 4, 'one revision is the whole budget, never a loop');
assert.equal(spent.result.certificate, null);
assert.equal(spent.result.verification.clarifications[0].question, 'Do you make any yearly overpayments?');
pass('one revision is the ceiling: a planner that still cannot fix itself asks, and does not keep paying');

// A REVISION THAT LEAVES PROVENANCE BROKEN NEVER REACHES A SECOND AUDIT. The
// module is still not ready, the server downgraded it rather than the planner
// deciding anything, so the candidate is refused and no certificate can exist.
const stillBroken = await run([
  { kind: 'extract', value: snapshotBody({ omitEvidenceFor: 'currentBalance' }) },
  { kind: 'verify', value: VERDICTS.omission },
  { kind: 'extract', value: snapshotBody({ omitEvidenceFor: 'currentBalance' }) }
]);
assert.equal(stillBroken.calls.length, 3,
  'a revision that did not clear provenance stops there and never buys a second verification');
assert.equal(stillBroken.result.certificate, null);
pass('a failed provenance revision leaves the module unconfirmable, at no further cost');

/* ------------ neither repair may settle a genuinely competing reading ------ */

// The semantic side of this rule was already pinned above. The STRUCTURAL side
// was true only by construction and had no test: its gate requires every
// relevant module to be ready-or-provenance-blocked, and a module carrying its
// own ambiguity is needs_clarification WITHOUT support issues, so it fails that
// predicate. Pinned here so a later refactor cannot quietly let a repair choose
// between two readings of what the client meant.
const ambiguousModule = await run([
  { kind: 'extract', value: snapshotBody({
    omitEvidenceFor: 'currentBalance',
    ambiguities: [{ path: '/currentBalance', reason: 'two mortgages were mentioned', question: 'Which mortgage did you mean?' }]
  }) }
]);
assert.equal(ambiguousModule.calls.length, 1,
  'a competing reading is never repaired structurally, even alongside a real provenance gap');
assert.equal(ambiguousModule.result.certificate, null);
// WAS: "a repair fixes representation, never meaning". A reinterpretation is
// now allowed to correct the planner's own mistaken reading of a conversation
// that is actually complete -- that is what the auditor asks for when it says
// the financial content is wrong. What survives unchanged, and is what this
// case pins, is the prohibition on INVENTING an answer to genuine uncertainty:
// a module carrying its own competing readings goes to the person, and no
// scope can turn that into work the planner does alone.
pass('a competing reading is never settled internally: an ambiguous module goes straight to the client');

/* ------------- the turn's clock, not just each call's, bounds the work ----- */

// A REPAIR NOBODY CAN VERIFY IS MONEY SPENT ON NOTHING. modulePlannerTimeoutMs
// bounds one call; nothing bounded the sequence, and the sequence is what a
// waiting client actually experiences. An optional call is therefore not
// STARTED without room to finish the pair it belongs to -- the repair, and the
// audit that has to approve it.
//
// THIS IS A FAIL-SAFE CEILING, NOT A TARGET. Degrading to the auditor's own
// clarification is the worst acceptable outcome, not a good one.
const BUDGETED = { ...CONFIG, modulePlannerRepairFloorMs: 20_000 };

const outOfTime = await run(
  [
    { kind: 'extract', value: snapshotBody({ omitEvidenceFor: 'annualOverpayment' }) },
    { kind: 'verify', value: VERDICTS.omission }
  ],
  { deadlineAt: Date.now() + 1_000, config: BUDGETED }
);
assert.equal(outOfTime.calls.length, 2,
  'with no room for a repair and its audit, the repair is never started');
assert.equal(outOfTime.result.certificate, null);
assert.equal(outOfTime.result.verification.clarifications[0].question, 'Do you make any yearly overpayments?');
pass('an exhausted turn budget skips the optional call rather than starting one it cannot finish');

const inTime = await run(
  [
    { kind: 'extract', value: snapshotBody({ omitEvidenceFor: 'annualOverpayment' }) },
    { kind: 'verify', value: VERDICTS.omission },
    { kind: 'extract', value: snapshotBody() },
    { kind: 'verify', value: VERDICTS.pass }
  ],
  { deadlineAt: Date.now() + 600_000, config: BUDGETED }
);
assert.equal(inTime.calls.length, 4, 'ample budget changes nothing about the repair itself');
ok(Boolean(inTime.result.certificate), 'and the repaired plan is still certified');
pass('a budget with room left behaves exactly as an unbounded pass does');

/* ------------------------------------------ every model call is still metered */

// An unmetered call is a budget the session never spends and an incident nobody
// sees, so a repair -- adopted or abandoned -- must show up in the usage the
// caller reports. The scripted transport bills 100 input tokens per call.
const billed = (run) => Number(run.result.extractionUsage?.input_tokens || 0)
  + Number(run.result.verificationUsage?.input_tokens || 0);
assert.equal(billed(clean), 200, 'a clean pass bills its two calls');
assert.equal(billed(repaired), 400, 'an adopted revision bills all four of its calls');
assert.equal(billed(stubborn), 400, 'a revision that failed its second audit is still billed in full');
assert.equal(billed(failedRepair), 300, 'an abandoned revision bills the extraction it actually made');
assert.equal(billed(structuralReviewed), 400, 'a reviewed provenance gap bills all four of its calls');
assert.equal(billed(spent), 400, 'a revision that still does not pass is billed in full');
assert.equal(billed(stillBroken), 300, 'a revision that never earned a second audit bills the three calls it made');
checks += 7;
pass('a revision is metered whether or not it is adopted; no model call is free');

console.info(`[LiveInternalRepair] ${checks} checks passed.`);
