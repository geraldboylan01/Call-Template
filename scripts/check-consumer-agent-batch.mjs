/**
 * A6 — deterministic guarantees for batch execution.
 *
 * Free to run: every conversation here is a stub. The point is to prove the
 * three properties that make an unattended paid batch safe to leave running:
 *
 *   1. Concurrency is capped in code at 10, whatever the caller asks for.
 *   2. Spend is refused BEFORE dispatch, not reported after.
 *   3. The judge cannot change the outcome of a run — not by scoring zero, not
 *      by throwing, not by returning nonsense.
 */

import assert from 'node:assert/strict';

import { MAX_CONCURRENCY, resolveConcurrency, rollUpMetrics, runBatch } from './agent-harness/batch.mjs';
import { createCostLedger, euroCostFor, latencyPercentiles } from './agent-harness/cost.mjs';
import { aggregateJudgements, judgeConversation, normaliseJudgement } from './agent-judges/conversation.mjs';

let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
};

const jobsFor = (count) => Array.from({ length: count }, (unused, index) => ({
  scenarioId: `scenario_${index}`, repeat: index
}));

const stubOutcome = (turnCount = 3) => ({
  turns: Array.from({ length: turnCount }, (unused, index) => ({
    questionFactId: `fact_${index}`,
    goals: ['retire'],
    analyses: ['pension_projection'],
    factIds: ['person_current_age'],
    plannerErrorCode: null
  })),
  transcript: [{ role: 'client', text: 'hello' }, { role: 'assistant', text: 'hello back' }]
});

const freeLedger = () => createCostLedger({ runCeilingEur: 1_000, estimatedConversationEur: 0 });

// ---------------------------------------------------------------------------
// 1. Concurrency is capped in code.
// ---------------------------------------------------------------------------

assert.equal(MAX_CONCURRENCY, 10);
check('a request for more than the cap is clamped, not refused', resolveConcurrency(50) === 10);
check('a request below one becomes one', resolveConcurrency(0) === 1 && resolveConcurrency(-3) === 1);
check('a non-numeric request becomes one', resolveConcurrency('lots') === 1);
check('a request within the cap is honoured', resolveConcurrency(4) === 4);

{
  // Every conversation parks until released, so in-flight count is observable.
  let release;
  const parked = new Promise((resolve) => { release = resolve; });
  let started = 0;
  const batchPromise = runBatch({
    jobs: jobsFor(40),
    concurrency: 999,
    ledger: freeLedger(),
    runConversation: async () => { started += 1; await parked; return stubOutcome(); }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('no more than the hard cap may run at once', started <= MAX_CONCURRENCY,
    `${started} conversations started`);
  release();
  const batch = await batchPromise;
  check('the cap holds for the whole batch', batch.peakInFlight <= MAX_CONCURRENCY,
    `peak ${batch.peakInFlight}`);
  check('every job still runs', batch.results.length === 40, `${batch.results.length} results`);
}

// ---------------------------------------------------------------------------
// 2. Spend is refused BEFORE dispatch.
// ---------------------------------------------------------------------------

{
  const ledger = createCostLedger({ runCeilingEur: 0.10, estimatedConversationEur: 0.04 });
  let dispatched = 0;
  const batch = await runBatch({
    jobs: jobsFor(20),
    concurrency: 1,
    ledger,
    runConversation: async () => {
      dispatched += 1;
      ledger.record({ role: 'client', model: 'gpt-5.6-luna', inputTokens: 20_000, outputTokens: 8_000 });
      return stubOutcome();
    }
  });
  check('a run stops once its ceiling would be crossed', dispatched < 20, `${dispatched} dispatched`);
  check('the run never exceeds its ceiling', ledger.spentThisRunEur <= 0.10,
    `spent €${ledger.spentThisRunEur.toFixed(4)}`);
  check('the reason the run stopped is reported', /run ceiling/.test(batch.stoppedReason || ''),
    String(batch.stoppedReason));
  check('skipped conversations are named, not silently dropped',
    batch.skipped.length === 20 - dispatched,
    `${batch.skipped.length} skipped, ${dispatched} dispatched`);
}

{
  // The daily ceiling binds even when this run's own ceiling is generous.
  const ledger = createCostLedger({
    runCeilingEur: 1_000, dayCeilingEur: 5, spentTodayEur: 4.99, estimatedConversationEur: 0.05
  });
  const gate = ledger.mayDispatch();
  check('a daily ceiling refuses the next conversation up front', gate.allowed === false, String(gate.reason));
  check('the daily refusal names the daily ceiling', /daily ceiling/.test(gate.reason || ''), String(gate.reason));
}

{
  // A batch dearer than estimated must still stop: the projection follows the
  // observed mean once conversations have completed.
  const ledger = createCostLedger({ runCeilingEur: 1, estimatedConversationEur: 0.001 });
  let dispatched = 0;
  await runBatch({
    jobs: jobsFor(200),
    concurrency: 1,
    ledger,
    runConversation: async () => {
      dispatched += 1;
      ledger.record({ role: 'planner', model: 'gpt-5.6-sol', inputTokens: 8_000, outputTokens: 2_000 });
      return stubOutcome();
    }
  });
  check('an under-estimated batch still stops at its ceiling', ledger.spentThisRunEur <= 1,
    `spent €${ledger.spentThisRunEur.toFixed(4)} over ${dispatched} conversations`);
  check('the projection rises to what conversations actually cost', dispatched < 200,
    `${dispatched} dispatched`);
}

check('an unknown model is costed at the dearest rate, never the cheapest',
  euroCostFor({ model: 'some-new-model', inputTokens: 1_000_000 })
    >= euroCostFor({ model: 'gpt-5.6-sol', inputTokens: 1_000_000 }));
check('cached input is cheaper than fresh input',
  euroCostFor({ model: 'gpt-5.6-luna', inputTokens: 1_000_000, cachedInputTokens: 1_000_000 })
    < euroCostFor({ model: 'gpt-5.6-luna', inputTokens: 1_000_000 }));
check('a ledger without a ceiling cannot be created',
  (() => { try { createCostLedger({}); return false; } catch { return true; } })());

// ---------------------------------------------------------------------------
// 3. The judge cannot change the outcome of a run.
// ---------------------------------------------------------------------------

{
  const worst = await judgeConversation(
    { async judge() { return { tone: 1, groundedness: 1, explains_why: 1, momentum: 1, note: 'terrible' }; } },
    stubOutcome()
  );
  check('the worst possible judgement still just returns scores', worst.available === true && worst.mean === 1);

  const throwing = await judgeConversation(
    { async judge() { throw new Error('provider exploded'); } },
    stubOutcome()
  );
  check('a judge that throws yields an absent opinion, not a failure', throwing.available === false);
  check('the reason the judge was unavailable is reported', /judge unavailable/.test(throwing.note));

  const nonsense = await judgeConversation(
    { async judge() { return { tone: 'excellent', groundedness: null }; } },
    stubOutcome()
  );
  check('unparseable scores become absent, not zero', nonsense.available === false);

  const clamped = normaliseJudgement({ tone: 9, groundedness: -4, explains_why: 3, momentum: 3 });
  check('scores are clamped into range', clamped.tone === 5 && clamped.groundedness === 1);

  // The property that matters: identical batches, opposite judgements, same result.
  const runOne = await runBatch({
    jobs: jobsFor(3), concurrency: 2, ledger: freeLedger(), runConversation: async () => stubOutcome()
  });
  const runTwo = await runBatch({
    jobs: jobsFor(3), concurrency: 2, ledger: freeLedger(), runConversation: async () => stubOutcome()
  });
  const judgedOne = await Promise.all(runOne.results.map(() => judgeConversation(
    { async judge() { return { tone: 5, groundedness: 5, explains_why: 5, momentum: 5 }; } }, stubOutcome()
  )));
  const judgedTwo = await Promise.all(runTwo.results.map(() => judgeConversation(
    { async judge() { throw new Error('down'); } }, stubOutcome()
  )));
  check('batch failure counts ignore the judge entirely',
    runOne.results.filter((item) => item.error).length === runTwo.results.filter((item) => item.error).length);
  check('a perfect judgement and an absent one aggregate without error',
    aggregateJudgements(judgedOne).tone === 5 && aggregateJudgements(judgedTwo).conversationsJudged === 0);
  check('no judge at all is a valid state', (await judgeConversation(null, stubOutcome())).available === false);
}

// ---------------------------------------------------------------------------
// Metrics rollup.
// ---------------------------------------------------------------------------

{
  const results = [
    { job: { scenarioId: 'a' }, outcome: stubOutcome(3), error: null, wallClockMs: 10 },
    { job: { scenarioId: 'b' }, outcome: stubOutcome(5), error: null, wallClockMs: 20 },
    { job: { scenarioId: 'c' }, outcome: null, error: 'boom', wallClockMs: 5 }
  ];
  const metrics = rollUpMetrics(results);
  check('a failed conversation is counted, not hidden', metrics.failed === 1 && metrics.completed === 2);
  check('turns to completion is reported', metrics.turnsToCompletion.mean === 4 && metrics.turnsToCompletion.max === 5);
  check('facts asked for but never collected are surfaced', metrics.factsRequestedButUnused.length > 0);

  const looping = [{
    job: { scenarioId: 'loop' },
    outcome: {
      turns: [
        { questionFactId: 'property_position', goals: [], analyses: [], factIds: [] },
        { questionFactId: 'property_position', goals: [], analyses: [], factIds: [] }
      ],
      transcript: []
    },
    error: null,
    wallClockMs: 1
  }];
  check('a repeated question is surfaced with its count',
    rollUpMetrics(looping).repeatedQuestions[0]?.count === 2);

  const percentiles = latencyPercentiles([10, 20, 30, 40, 1_000]);
  check('latency percentiles are reported', percentiles.p50 === 30 && percentiles.p95 === 1_000);
  check('percentiles over nothing are null, not zero', latencyPercentiles([]).p50 === null);
}

console.info(`[Agent batch] ${checks} checks passed: concurrency capped at ${MAX_CONCURRENCY}, `
  + 'spend refused pre-dispatch, judge advisory only.');
