/**
 * A6 — batch execution.
 *
 * Many conversations, bounded concurrency, bounded spend, one report.
 *
 * Two hard limits live here, in code rather than configuration:
 *
 *   1. CONCURRENCY IS CAPPED AT 10, always. A caller may ask for less; asking
 *      for more silently gets 10 rather than an error, because the cap exists to
 *      protect the provider account and the app under test, and a batch that
 *      refuses to start protects neither.
 *   2. SPEND IS CHECKED BEFORE EACH DISPATCH. A conversation that would take the
 *      run past its ceiling is never started. Conversations already in flight are
 *      allowed to finish; the run then stops and reports what it skipped.
 *
 * The orchestrator is transport-agnostic and client-agnostic: it takes a
 * `runConversation` function and a ledger, so the deterministic tests drive it
 * with a stub and pay nothing.
 */

/** Hard ceiling. Not configurable, deliberately. */
export const MAX_CONCURRENCY = 10;

export function resolveConcurrency(requested) {
  const numeric = Math.floor(Number(requested));
  if (!Number.isFinite(numeric) || numeric < 1) return 1;
  return Math.min(MAX_CONCURRENCY, numeric);
}

/**
 * @param {object} options
 * @param {Array<object>} options.jobs one entry per conversation to run
 * @param {(job: object) => Promise<object>} options.runConversation
 * @param {object} options.ledger from createCostLedger
 * @param {number} [options.concurrency]
 * @param {(event: object) => void} [options.onEvent]
 */
export async function runBatch({ jobs, runConversation, ledger, concurrency = 4, onEvent = () => {} }) {
  const limit = resolveConcurrency(concurrency);
  const queue = jobs.slice();
  const results = [];
  const skipped = [];
  let peakInFlight = 0;
  let inFlight = 0;
  let stoppedReason = null;

  const worker = async () => {
    for (;;) {
      if (stoppedReason) {
        // Everything still queued is skipped, not silently dropped.
        const remaining = queue.splice(0);
        for (const job of remaining) skipped.push({ job, reason: stoppedReason });
        return;
      }
      const gate = ledger.mayDispatch();
      if (!gate.allowed) {
        stoppedReason = gate.reason;
        onEvent({ type: 'ceiling_reached', reason: gate.reason });
        continue;
      }
      const job = queue.shift();
      if (!job) return;

      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      onEvent({ type: 'started', job, inFlight });
      const startedAt = Date.now();
      try {
        const outcome = await runConversation(job);
        results.push({ job, outcome, wallClockMs: Date.now() - startedAt, error: null });
        onEvent({ type: 'finished', job, outcome });
      } catch (error) {
        results.push({
          job, outcome: null, wallClockMs: Date.now() - startedAt,
          error: String(error?.message || error).slice(0, 300)
        });
        onEvent({ type: 'failed', job, error });
      } finally {
        inFlight -= 1;
        ledger.completeConversation();
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return {
    results, skipped, peakInFlight, concurrencyLimit: limit, stoppedReason
  };
}

/**
 * The §12.4 operational metrics, rolled up over a batch.
 *
 * These are DESCRIPTIVE. Nothing here decides pass or fail — the deterministic
 * scenario assertions do that. This exists so a person can see what changed
 * between two runs of the same scenarios.
 */
export function rollUpMetrics(results) {
  const completed = results.filter((item) => item.outcome && !item.error);
  const turns = completed.flatMap((item) => item.outcome.turns || []);
  const questionsAsked = turns.map((turn) => turn.questionFactId).filter(Boolean);

  const repeatedQuestions = [];
  for (const item of completed) {
    const asked = (item.outcome.turns || []).map((turn) => turn.questionFactId).filter(Boolean);
    for (const factId of new Set(asked)) {
      const count = asked.filter((value) => value === factId).length;
      if (count > 1) repeatedQuestions.push({ scenario: item.job.scenarioId, factId, count });
    }
  }

  const factsCollected = new Set(completed.flatMap((item) => item.outcome.turns?.at(-1)?.factIds || []));
  const factsRequestedButUnused = [...new Set(questionsAsked)].filter((factId) => !factsCollected.has(factId));

  return {
    conversations: results.length,
    completed: completed.length,
    failed: results.filter((item) => item.error).length,
    turnsToCompletion: {
      mean: completed.length
        ? Number((completed.reduce((sum, item) => sum + (item.outcome.turns?.length || 0), 0) / completed.length).toFixed(2))
        : null,
      max: completed.length ? Math.max(...completed.map((item) => item.outcome.turns?.length || 0)) : null
    },
    conversationsWithAGoal: completed.filter((item) => (item.outcome.turns?.at(-1)?.goals || []).length > 0).length,
    conversationsWithAnAnalysis: completed.filter((item) => (item.outcome.turns?.at(-1)?.analyses || []).length > 0).length,
    factsCollected: factsCollected.size,
    factsRequestedButUnused,
    repeatedQuestions,
    turnsWithNoQuestion: turns.filter((turn) => !turn.questionFactId).length,
    plannerErrors: turns.filter((turn) => turn.plannerErrorCode).map((turn) => turn.plannerErrorCode)
  };
}
