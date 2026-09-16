/**
 * The execution approval reader, scripted.
 *
 * WHAT IS REAL AND WHAT IS NOT. Everything around this is real: the offer
 * binding, the certificate, the delivery evidence, the newer-turn fence, the
 * idempotent receipt, the engine. Only the reader's OPINION is scripted -- the
 * fixture says "a competent reader would call this a pure approval of the
 * offer" and the production barriers decide what that is worth.
 *
 * THIS IS NOT A CLASSIFIER, AND MUST NOT BECOME ONE. It does not inspect the
 * client's words to work out what they meant; it looks the exact utterance up
 * in a table a human wrote, and an utterance nobody has declared reads back
 * `unclear`. That is deliberate in both directions. A harness that guessed
 * would quietly reintroduce the deterministic reader this change removed, and
 * would let a new fixture pass by accident. A new fixture that means to be
 * approved has to say so, in one line, where a reviewer can see it.
 *
 * The envelope is still consulted for ONE thing: what the reply was answering.
 * That is a server record, not a reading, and the wrong-proposition regression
 * turns on it.
 */

// Imported, not retyped. A harness that carries its own copy of the schema
// name and version is a harness that keeps passing after the contract moves.
import {
  EXECUTION_APPROVAL_DECISION_SCHEMA_NAME,
  EXECUTION_APPROVAL_DECISION_V1
} from '../../worker/src/consumer/live/approval_decision.js';

export const APPROVAL_DECISION_SCHEMA_NAME = EXECUTION_APPROVAL_DECISION_SCHEMA_NAME;
const SCHEMA_VERSION = EXECUTION_APPROVAL_DECISION_V1;

/**
 * Every client utterance the offline suite puts in front of the reader, and
 * what a competent reader would say about it. Keyed by the exact transcript.
 *
 * `proposition` defaults to `offer`: these fixtures deliver a plan and then
 * answer it. Where a fixture means the client to be answering something else,
 * it says so here or overrides at the call site.
 */
const FIXTURE_DECISIONS = new Map(Object.entries({
  // The 2026-09-05 production utterance. Whisper's rendering of an
  // Irish-accented "yeah" under language 'en'.
  'Ja.': { decision: 'pure_approval' },
  'Yes, go ahead.': { decision: 'pure_approval' },
  'Yes, go ahead': { decision: 'pure_approval' },
  'Yes, please go ahead.': { decision: 'pure_approval' },
  'Yes please go ahead': { decision: 'pure_approval' },
  'Yes, that is right. Go ahead.': { decision: 'pure_approval' },
  'Yes, run it.': { decision: 'pure_approval' },
  'Yes, run it': { decision: 'pure_approval' },
  'Yes, run the plan.': { decision: 'pure_approval' },
  'Yeah, run that plan.': { decision: 'pure_approval' },
  'Yes please': { decision: 'pure_approval' },
  'Yes, please.': { decision: 'pure_approval' },
  'Yes': { decision: 'pure_approval' },
  'Yes.': { decision: 'pure_approval' },
  'yes': { decision: 'pure_approval' },
  'yes, go ahead': { decision: 'pure_approval' },
  'Yes please, run that plan': { decision: 'pure_approval' },
  'Go ahead': { decision: 'pure_approval' },
  'Go ahead.': { decision: 'pure_approval' },
  'That is right, go ahead.': { decision: 'pure_approval' },
  'Perfect, go ahead.': { decision: 'pure_approval' },
  'Grand, go ahead.': { decision: 'pure_approval' },
  'Grand, go ahead': { decision: 'pure_approval' },
  'Sounds good, go ahead.': { decision: 'pure_approval' },

  // The natural-approval set the completion matrix walks. These are here as a
  // statement about what a reader should conclude, not as a vocabulary the
  // product depends on: the point of the matrix is that ordinary agreement, in
  // whatever words, reaches the same one execution.
  'Yes, run the plan': { decision: 'pure_approval' },
  'Work away': { decision: 'pure_approval' },
  'Fire away': { decision: 'pure_approval' },
  'Please do': { decision: 'pure_approval' },
  'Sure, go for it': { decision: 'pure_approval' },
  'Perfect': { decision: 'pure_approval' },

  // Not approvals. Each of these is a real turn from a fixture that asserts
  // the meeting does NOT run on it.
  'Do I need to do it?': { decision: 'question_or_uncertainty' },
  'What does that include?': { decision: 'question_or_uncertainty' },
  'No, not yet.': { decision: 'question_or_uncertainty' },
  'Hold on.': { decision: 'question_or_uncertainty' }
}));

/**
 * The scripted reading for one envelope.
 *
 * @param {object} envelope the server envelope the Worker actually built
 * @param {Record<string, {decision: string, proposition?: string}>} script
 *        per-test overrides, keyed by the exact client reply
 */
export function scriptedApprovalDecision(envelope, script = {}) {
  const reply = String(envelope?.clientReply || '');
  // A FIXTURE MAY READ THE ENVELOPE. Some of what a reader concludes genuinely
  // depends on what it was shown -- a bare "yes" means one thing against
  // "shall I run that plan?" and another against "shall I explain it?" -- and a
  // test about being shown the wrong question needs a reader that answers the
  // question it was given rather than one that already knows the answer.
  const declared = script[reply] || FIXTURE_DECISIONS.get(reply) || null;
  const entry = typeof declared === 'function' ? declared(envelope) : declared;
  if (!entry) {
    return {
      schemaVersion: SCHEMA_VERSION,
      decision: 'unclear',
      answeredProposition: 'none',
      reason: 'no fixture declares what this reply means'
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    decision: entry.decision,
    answeredProposition: entry.proposition || 'offer',
    reason: entry.reason || 'scripted fixture reading'
  };
}

/**
 * A provider response envelope in the shape `structuredPlannerResponse` parses.
 * Harnesses that already own `globalThis.fetch` return this from one branch.
 */
export function approvalDecisionResponse(envelope, script = {}) {
  return {
    ok: true,
    json: async () => ({
      status: 'completed',
      output_text: JSON.stringify(scriptedApprovalDecision(envelope, script)),
      usage: { input_tokens: 40, output_tokens: 10 }
    })
  };
}

/**
 * Intercept only the approval reader's call, and leave every other request to
 * whatever the harness had installed. For tests that are not otherwise
 * scripting the provider at all.
 *
 * Returns the uninstall.
 */
export function installScriptedApprovalReader(script = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    let body = null;
    try { body = JSON.parse(String(init?.body || '')); } catch (_error) { body = null; }
    if (body?.text?.format?.name === APPROVAL_DECISION_SCHEMA_NAME) {
      let envelope = {};
      try { envelope = JSON.parse(body.input?.[1]?.content || '{}'); } catch (_error) { envelope = {}; }
      return approvalDecisionResponse(envelope, script);
    }
    if (typeof original === 'function') return original(url, init);
    throw new Error(`Unscripted provider request to ${String(url)}`);
  };
  return () => { globalThis.fetch = original; };
}
