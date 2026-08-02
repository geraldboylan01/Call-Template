/**
 * A6 — token, latency and euro accounting for agent-driven batches.
 *
 * SPENDING IS BOUNDED BEFORE A CALL IS MADE, NOT AFTER.
 *
 * A batch is the first thing in this harness that can run unattended, so the
 * ceiling is checked *pre-dispatch*: a conversation that would take the run past
 * its ceiling is never started, rather than being noticed once the money is
 * already spent. That is the whole reason this file exists as a ledger rather
 * than a summary printed at the end.
 *
 * Rates are per million tokens, in euro, and are DELIBERATELY declared here as
 * data rather than fetched: an estimate that silently changes is worse than one
 * that is visibly stale. Update them when the price list changes.
 */

/** Euro per million tokens. Update when the published price list changes. */
export const MODEL_RATES = Object.freeze({
  'gpt-5.6-luna': Object.freeze({ input: 0.5, cachedInput: 0.05, output: 4 }),
  'gpt-5.6-terra': Object.freeze({ input: 2.5, cachedInput: 0.25, output: 20 }),
  'gpt-5.6-sol': Object.freeze({ input: 12, cachedInput: 1.2, output: 96 })
});

/** What an unknown model is assumed to cost. Deliberately the dearest tier: an
 * unrecognised model must never make a batch look cheaper than it is. */
const UNKNOWN_MODEL_RATE = MODEL_RATES['gpt-5.6-sol'];

export function euroCostFor({ model, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0 }) {
  const rate = MODEL_RATES[String(model || '')] || UNKNOWN_MODEL_RATE;
  const freshInput = Math.max(0, Number(inputTokens || 0) - Number(cachedInputTokens || 0));
  return (
    (freshInput * rate.input)
    + (Number(cachedInputTokens || 0) * rate.cachedInput)
    + (Number(outputTokens || 0) * rate.output)
  ) / 1_000_000;
}

/**
 * A ledger for one batch run.
 *
 * @param {object} options
 * @param {number} options.runCeilingEur euro ceiling for this run
 * @param {number} [options.dayCeilingEur] euro ceiling across today's runs
 * @param {number} [options.spentTodayEur] already spent today, from the ledger file
 * @param {number} [options.estimatedConversationEur] what one conversation is
 *   assumed to cost when deciding whether to dispatch the next one. The estimate
 *   rises to the observed mean once conversations have completed, so a batch
 *   that turns out dearer than assumed still stops in time.
 */
export function createCostLedger({
  runCeilingEur,
  dayCeilingEur = Infinity,
  spentTodayEur = 0,
  estimatedConversationEur = 0.05
} = {}) {
  if (!(Number(runCeilingEur) > 0)) {
    throw new Error('createCostLedger requires a positive runCeilingEur');
  }
  const entries = [];
  let spentThisRun = 0;
  let conversationsCounted = 0;

  return {
    get spentThisRunEur() { return spentThisRun; },
    get spentTodayEur() { return spentTodayEur + spentThisRun; },
    get entries() { return entries.slice(); },

    /** What the next conversation is expected to cost, on current evidence. */
    projectedConversationEur() {
      return conversationsCounted > 0
        ? Math.max(spentThisRun / conversationsCounted, estimatedConversationEur)
        : estimatedConversationEur;
    },

    /**
     * PRE-DISPATCH GATE. Called before a conversation starts, never after.
     * @returns {{allowed: boolean, reason?: string}}
     */
    mayDispatch() {
      const projected = this.projectedConversationEur();
      if (spentThisRun + projected > runCeilingEur) {
        return {
          allowed: false,
          reason: `run ceiling €${runCeilingEur.toFixed(2)} would be exceeded `
            + `(spent €${spentThisRun.toFixed(4)}, next ≈ €${projected.toFixed(4)})`
        };
      }
      if (spentTodayEur + spentThisRun + projected > dayCeilingEur) {
        return {
          allowed: false,
          reason: `daily ceiling €${dayCeilingEur.toFixed(2)} would be exceeded `
            + `(spent today €${(spentTodayEur + spentThisRun).toFixed(4)}, next ≈ €${projected.toFixed(4)})`
        };
      }
      return { allowed: true };
    },

    /** Record real usage after a call. Never gates — gating happens up front. */
    record({ role, model, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, latencyMs = 0 }) {
      const eur = euroCostFor({ model, inputTokens, outputTokens, cachedInputTokens });
      spentThisRun += eur;
      entries.push({
        role, model, inputTokens, outputTokens, cachedInputTokens, latencyMs, eur
      });
      return eur;
    },

    /** Mark one conversation finished, so the projection reflects reality. */
    completeConversation() {
      conversationsCounted += 1;
    }
  };
}

/** p50/p95 over a list of numbers. Returns nulls for an empty list. */
export function latencyPercentiles(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return { p50: null, p95: null };
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { p50: at(0.5), p95: at(0.95) };
}
