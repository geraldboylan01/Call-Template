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

function snapshotBody({ omitEvidenceFor = null, confirmationPrompt = PROMPT } = {}) {
  const policy = directModulePolicyEntries('mortgage_analysis', INPUT, POLICY);
  return {
    schemaVersion: MODULE_PLANNING_SNAPSHOT_V1,
    baseSnapshotRevision: 0,
    throughTurnId: 'turn-1',
    modules: [{
      moduleId: 'mortgage_analysis',
      outputKey: DIRECT_MODULE_CONTRACTS.mortgage_analysis.outputKey,
      status: 'ready',
      selection: { origin: 'client_requested', reason: 'you asked about your mortgage' },
      inputJson: JSON.stringify(INPUT),
      steeringSummary: 'your repayment mortgage',
      missing: [], ambiguities: [],
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
    clarifications: [], confirmationPromptApproved: true, explanation: 'scripted pass'
  },
  omission: {
    schemaVersion: 'ModuleInputVerificationV1', verdict: 'fail',
    unsupportedPaths: [], omittedSupportedInformation: ['/annualOverpayment'], unresolvedAmbiguities: [],
    clarifications: [{ moduleIds: ['mortgage_analysis'], paths: ['/annualOverpayment'], question: 'Do you make any yearly overpayments?' }],
    confirmationPromptApproved: false, explanation: 'the planner omitted a supported value'
  },
  ambiguity: {
    schemaVersion: 'ModuleInputVerificationV1', verdict: 'fail',
    unsupportedPaths: [], omittedSupportedInformation: [], unresolvedAmbiguities: ['whose mortgage'],
    clarifications: [{ moduleIds: ['mortgage_analysis'], paths: ['/currentBalance'], question: 'Is that mortgage yours or held jointly?' }],
    confirmationPromptApproved: false, explanation: 'two readings are possible'
  }
};

/** Drive the real planner with a scripted sequence of model replies. */
async function run(script) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    const kind = body.text?.format?.name === 'module_planning_snapshot_v1' ? 'extract' : 'verify';
    const envelope = JSON.parse(body.input?.[1]?.content || '{}');
    calls.push({ kind, findings: envelope.priorAuditFindings || null });
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
      config: CONFIG,
      turns: TURNS,
      throughTurnId: 'turn-1',
      previousSnapshot: null,
      currentProfileContext: PROFILE
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
ok(/independent audit rejected your previous snapshot/.test(repaired.calls[2].findings.instruction),
  'the repair instruction tells the planner the findings are about its own work');
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
pass('a repair that does not pass keeps the original verdict and the original question');

const failedRepair = await run([
  { kind: 'extract', value: snapshotBody({ omitEvidenceFor: 'annualOverpayment' }) },
  { kind: 'verify', value: VERDICTS.omission },
  { kind: 'extract', value: snapshotBody({ confirmationPrompt: '' }) }
]);
assert.equal(failedRepair.calls.length, 3, 'a repair that cannot even be read back is abandoned before a second audit');
assert.equal(failedRepair.result.certificate, null);
assert.equal(failedRepair.result.verification.clarifications[0].question, 'Do you make any yearly overpayments?');
pass('an unreadable repair is abandoned without spending a verification, and changes nothing');

/* ------------------------------------------ every model call is still metered */

// An unmetered call is a budget the session never spends and an incident nobody
// sees, so a repair -- adopted or abandoned -- must show up in the usage the
// caller reports. The scripted transport bills 100 input tokens per call.
const billed = (run) => Number(run.result.extractionUsage?.input_tokens || 0)
  + Number(run.result.verificationUsage?.input_tokens || 0);
assert.equal(billed(clean), 200, 'a clean pass bills its two calls');
assert.equal(billed(repaired), 400, 'an adopted repair bills all four of its calls');
assert.equal(billed(stubborn), 400, 'a repair that failed its second audit is still billed in full');
assert.equal(billed(failedRepair), 300, 'an abandoned repair bills the extraction it actually made');
checks += 4;
pass('a repair is metered whether or not it is adopted; no model call is free');

console.info(`[LiveInternalRepair] ${checks} checks passed.`);
