/**
 * The deterministic backstop against asking for something already known.
 *
 * WHY THIS IS NOT A MODEL CALL, AND WHY IT DOES NOT CANCEL ANYTHING.
 *
 * In the live lane the model's speech goes provider -> client over WebRTC. The
 * Worker is not in that path, so there is no point at which a proposed question
 * can be held, inspected and swapped for a better one. Adding such a point is
 * precisely the v2 defect this lane exists to remove, and a second model call to
 * validate the first would double the cost of every turn to catch a mistake the
 * state note should have prevented.
 *
 * So the ordering here is deliberate:
 *
 *   1. The real fix is upstream. `liveStateProjection` now sends every captured
 *      fact WITH its value and whose it is, so the question should never be
 *      composed. See capturedFactMemory in live_tools.js.
 *   2. This module is what happens when it is composed anyway. It reads the
 *      assistant transcript AFTER the response completes, decides deterministically
 *      whether the question asked for something already captured, and if so
 *      queues a corrective state item. The current sentence is left alone --
 *      cancelling mid-question over a redundancy would be more jarring for the
 *      client than the redundancy itself, which is a judgement the compliance
 *      layer makes the other way for prohibited acts, correctly.
 *
 * The net effect is that the same fact is never asked for twice: the first ask
 * is prevented by legible state, and any that slips through cannot recur.
 *
 * The patterns are shared with scripts/run-live-persona-replay.mjs so the
 * harness grades against the detector that actually ships, not a copy of it.
 */

/**
 * Spoken shapes that request a specific fact.
 *
 * Deliberately narrow. A false positive here suppresses a legitimate question,
 * which is worse than the redundancy it is guarding against, so every pattern
 * has to look like an ask for THAT fact and nothing else.
 */
export const FACT_QUESTION_PATTERNS = Object.freeze({
  property_position: [
    /\bdo you(?: currently)?\b[^?]{0,20}\bown\b[^?]{0,20}\b(?:property|home|house)\b/i,
    /\bdo you(?: currently)?\b[^?]{0,20}\bhave\b[^?]{0,10}\b(?:any property|a (?:home|house))\b(?!\s+(?:price|budget))/i,
    /\b(?:home|house|property)\b[^?]{0,60}\b(?:worth|value)\b/i,
    /\b(?:worth|value)\b[^?]{0,60}\b(?:home|house|property)\b/i
  ],
  mortgage_position: [
    /\b(?:do you(?: currently)? have|have you got|which)\b[^?]{0,60}\b(?:current |existing )?mortgage\b/i,
    /\bwhat\b[^?]{0,40}\b(?:balance|left|owe|rate|repayment)\b[^?]{0,40}\bmortgage\b/i,
    /\b(?:current |existing |your )mortgage\b[^?]{0,60}\b(?:balance|left|owe|rate|repayment)\b/i
  ],
  mortgage_annual_interest_rate: [
    /\b(?:what|which)\b[^?]{0,40}\b(?:interest )?rate\b[^?]{0,40}\bmortgage\b/i,
    /\bmortgage\b[^?]{0,40}\b(?:interest )?rate\b[^?]{0,30}\?/i
  ],
  target_retirement_income: [
    /\b(?:target|want|need|like)\b[^?]{0,80}\b(?:income|amount)\b[^?]{0,40}\bretire/i,
    /\bretirement income\b/i,
    /\b(?:annual )?income\b[^?]{0,60}\bretire/i,
    /\bretire[^?]{0,60}\b(?:annual )?income\b/i
  ],
  pension_current_value: [
    /\bhow much\b[^?]{0,60}\bpension\b/i,
    /\bpension\b[^?]{0,60}\b(?:balance|pot|saved|value|worth)\b/i,
    /\b(?:balance|pot|saved|value|worth)\b[^?]{0,60}\bpension\b/i,
    /\b(?:current )?value\b[^?]{0,40}\b(?:prsa|pension)\b/i,
    /\b(?:prsa|pension)\b[^?]{0,40}\b(?:current )?value\b/i
  ],
  pension_employer_contribution_rate: [
    /\bwhat (?:percentage|rate)\b[^?]{0,100}\b(?:employer|company)\b[^?]{0,60}\b(?:contribut|match)/i,
    /\b(?:employer|company)\b[^?]{0,80}\b(?:contribut|match)[^?]{0,80}\bwhat (?:percentage|rate)\b/i
  ],
  cash_savings: [
    /\bhow much\b[^?]{0,40}\b(?:cash|savings?)\b/i,
    /\b(?:cash|savings?)\b[^?]{0,40}\bhow much\b/i
  ]
});

/**
 * Asking someone to say a figure again, in any wording.
 *
 * This is separate from the per-fact patterns because it is redundant whatever
 * the fact is: a client who has given a number should never be asked to repeat
 * it, confirm it "in words", or say it more precisely.
 */
const REPEAT_REQUEST = /\b(?:say (?:that|it) again|repeat (?:that|it|the)|in words|one more time|confirm (?:that|the) (?:figure|number|amount|rate)|remind me (?:what|of) (?:that|the))\b/i;

/** The clauses in a turn that are actually asking for something. */
function requestClauses(text) {
  const clauses = String(text || '').match(/[^.!?]+[.!?]?/g) || [];
  // Including `?` as a boundary matters for natural turns such as "Anything
  // else? Do you own a home?". Spoken requests can also be imperatives ("Tell
  // me what your home is worth."), so inspect those clauses too without
  // treating an ordinary recap as an ask.
  return clauses.filter((clause) => (
    clause.includes('?')
    || /\b(?:tell me|let me know|give me|share with me)\b/i.test(clause)
  ));
}

/** Which semantic facts a spoken turn is asking for. */
export function requestedFactIdsFromSpeech(text) {
  const requests = requestClauses(text);
  const requested = [];
  for (const [factId, patterns] of Object.entries(FACT_QUESTION_PATTERNS)) {
    if (requests.some((request) => patterns.some((pattern) => pattern.test(request)))) requested.push(factId);
  }
  return requested;
}

/** True when the turn asks the client to say an already-given figure again. */
export function requestsRepetition(text) {
  return requestClauses(text).some((clause) => REPEAT_REQUEST.test(clause));
}

/**
 * The redundancy verdict for one assistant turn.
 *
 * `capturedFactIds` is the set of fact ids the projection currently knows a
 * value for. A question is redundant when EVERY fact it asks for is already
 * captured -- a turn that asks for one known and one unknown fact is doing
 * useful work and must not be flagged.
 *
 * `stillNeededFactIds` is the escape hatch that keeps entity scope honest: if
 * an analysis still needs that fact for some other pension, child or property,
 * the question is legitimate even though the bare fact id is captured
 * elsewhere, and this returns clean.
 */
export function redundantQuestionVerdict(text, {
  capturedFactIds = [],
  stillNeededFactIds = []
} = {}) {
  const captured = new Set(capturedFactIds);
  const stillNeeded = new Set(stillNeededFactIds);
  const requested = requestedFactIdsFromSpeech(text);
  const repetition = requestsRepetition(text);
  const redundant = requested.filter((factId) => captured.has(factId) && !stillNeeded.has(factId));
  // A turn is redundant when it asks for NOTHING an analysis is still waiting
  // on and at least one thing already known.
  //
  // Requiring every matched fact id to be captured was too strict: one spoken
  // question routinely matches two patterns ("what rate are you on for the
  // mortgage" is both mortgage_position and mortgage_annual_interest_rate), and
  // the broader of the two is often a presence fact that carries no value and
  // so never appears as captured. Anchoring on stillNeeded instead asks the
  // question that actually matters -- is this turn advancing an analysis? --
  // and keeps a genuinely useful question askable.
  const advancesAnAnalysis = requested.some((factId) => stillNeeded.has(factId));
  const tripped = repetition || (requested.length > 0 && !advancesAnAnalysis && redundant.length > 0);
  return {
    tripped,
    requested,
    redundant,
    reason: repetition ? 'repetition_requested' : tripped ? 'already_captured' : ''
  };
}
