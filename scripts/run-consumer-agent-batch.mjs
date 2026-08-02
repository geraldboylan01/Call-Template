// A6 — the batch runner.
//
// Many agent-driven conversations against the real planning engine, with
// bounded concurrency, a hard euro ceiling, and one report at the end.
//
//   OPENAI_API_KEY=... node ./scripts/run-consumer-agent-batch.mjs --repeats=3 --ceiling=5
//   OPENAI_API_KEY=... node ./scripts/run-consumer-agent-batch.mjs --repeats=2 --judge --both
//
// PAID. Never run by CI. Every conversation costs client calls plus planner
// calls, and --judge adds one call per conversation.
//
// WHAT THIS IS FOR. The scripted scenario runner proves fixed journeys still
// behave. This runs the SAME scenarios many times with an unscripted model
// playing the client, so the variance shows up: the question that only loops
// one time in five, the goal that is usually captured, the analysis that
// usually survives. Deterministic assertions still decide pass or fail; the
// batch tells you how often, and the judge tells you how it felt.
//
// The exit code is decided by deterministic outcomes ALONE. The judge's scores
// are printed and never consulted — see scripts/agent-judges/conversation.mjs.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOpenAiClient } from './agent-clients/openai.mjs';
import { rollUpMetrics, runBatch } from './agent-harness/batch.mjs';
import { createCostLedger, latencyPercentiles } from './agent-harness/cost.mjs';
import { RELEASED_MODULE_IDS, runAgentScenario, runVoiceScenario } from './agent-harness/transports.mjs';
import { aggregateJudgements, createOpenAiJudge, judgeConversation } from './agent-judges/conversation.mjs';

const datasetPath = fileURLToPath(new URL('./fixtures/consumer-agent-scenarios.json', import.meta.url));
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const repeats = Math.max(1, Number(flag('repeats', 2)) || 2);
const maxTurns = Math.max(1, Number(flag('turns', 6)) || 6);
const concurrency = Number(flag('concurrency', 3)) || 3;
const runCeilingEur = Number(flag('ceiling', 5)) || 5;
const dayCeilingEur = Number(flag('day-ceiling', 25)) || 25;
const only = flag('id', '');
const withJudge = args.includes('--judge');
const bothTransports = args.includes('--both');
const reportPath = flag('report', join(process.cwd(), 'agent-batch-report.json'));

const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
if (!apiKey) {
  console.error('OPENAI_API_KEY is required. This runner makes paid model calls.');
  process.exit(1);
}

const scenarios = only
  ? dataset.scenarios.filter((item) => item.id === only)
  : dataset.scenarios;
if (scenarios.length === 0) {
  console.error(`No scenario with id "${only}". Available: ${dataset.scenarios.map((item) => item.id).join(', ')}`);
  process.exit(1);
}

const jobs = scenarios.flatMap((scenario) => (
  Array.from({ length: repeats }, (unused, repeat) => ({ scenarioId: scenario.id, scenario, repeat }))
));

const ledger = createCostLedger({ runCeilingEur, dayCeilingEur });
const judge = withJudge ? createOpenAiJudge({ apiKey }) : null;
const judgements = [];
const plannerLatencies = [];

console.info(`[Batch] ${scenarios.length} scenario(s) × ${repeats} = ${jobs.length} conversations`);
console.info(`[Batch] concurrency ${concurrency} (hard cap 10), ceiling €${runCeilingEur.toFixed(2)}`);
console.info(`[Batch] released modules: ${RELEASED_MODULE_IDS}`);
console.info(`[Batch] judge: ${withJudge ? 'on (advisory only — cannot fail this run)' : 'off'}\n`);

async function runConversation({ scenario }) {
  const client = createOpenAiClient({ apiKey, maxTurns });
  const runnable = { ...scenario, turns: Array.from({ length: maxTurns }, () => ({})) };
  const run = await runAgentScenario(runnable, { client });

  // Usage is recorded AFTER the fact; the ceiling was checked before dispatch.
  // Each role is costed at its own model's rate.
  plannerLatencies.push(...client.usage.plannerLatenciesMs);
  ledger.record({ role: 'client', ...client.usage.client });
  ledger.record({ role: 'planner', ...client.usage.planner });

  let divergence = null;
  if (bothTransports) {
    // The SAME words, replayed down the voice path. Any difference is the
    // engine's, not the client's.
    const said = run.transcript.filter((entry) => entry.role === 'client').map((entry) => entry.text);
    let cursor = 0;
    const voice = await runVoiceScenario(
      { ...scenario, turns: said.map(() => ({})) },
      {
        client: {
          id: 'replay',
          async nextMessage() { return said[cursor++] ?? null; },
          extractionFor: client.extractionFor.bind(client)
        }
      }
    );
    const agentGoals = JSON.stringify(run.turns.at(-1)?.goals || []);
    const voiceGoals = JSON.stringify(voice.turns.at(-1)?.goals || []);
    if (agentGoals !== voiceGoals) divergence = `agent ${agentGoals} vs voice ${voiceGoals}`;
  }

  if (judge) {
    // The judge is shared across the batch, so record the DELTA for this
    // conversation. Recording its running total would charge the first
    // conversation once, the second twice, and so on.
    const before = { ...judge.usage };
    judgements.push(await judgeConversation(judge, run));
    ledger.record({
      role: 'judge',
      model: judge.model,
      inputTokens: judge.usage.inputTokens - before.inputTokens,
      outputTokens: judge.usage.outputTokens - before.outputTokens,
      cachedInputTokens: judge.usage.cachedInputTokens - before.cachedInputTokens
    });
  }
  return { ...run, divergence, clientCalls: client.usage.clientCalls, plannerCalls: client.usage.plannerCalls };
}

const batch = await runBatch({
  jobs,
  concurrency,
  ledger,
  runConversation,
  onEvent: (event) => {
    if (event.type === 'finished') console.info(`  ✓ ${event.job.scenarioId} #${event.job.repeat + 1}`);
    if (event.type === 'failed') console.info(`  ✗ ${event.job.scenarioId} #${event.job.repeat + 1}: ${event.error?.message}`);
    if (event.type === 'ceiling_reached') console.info(`\n  ! stopping: ${event.reason}`);
  }
});

const metrics = rollUpMetrics(batch.results);
const divergences = batch.results.filter((item) => item.outcome?.divergence);

console.info(`\n${'='.repeat(72)}`);
console.info(`[Batch] ${metrics.completed}/${metrics.conversations} conversations completed, ${metrics.failed} failed`);
console.info(`[Batch] spend €${ledger.spentThisRunEur.toFixed(4)} of €${runCeilingEur.toFixed(2)} ceiling`);
console.info(`[Batch] peak concurrency ${batch.peakInFlight} (limit ${batch.concurrencyLimit})`);
if (batch.skipped.length) console.info(`[Batch] ${batch.skipped.length} conversation(s) skipped: ${batch.stoppedReason}`);
console.info(`[Batch] turns to completion: mean ${metrics.turnsToCompletion.mean}, max ${metrics.turnsToCompletion.max}`);
console.info(`[Batch] captured a goal in ${metrics.conversationsWithAGoal}/${metrics.completed}, `
  + `an analysis in ${metrics.conversationsWithAnAnalysis}/${metrics.completed}`);
const plannerPercentiles = latencyPercentiles(plannerLatencies);
if (plannerPercentiles.p50 !== null) {
  console.info(`[Batch] planner latency p50 ${plannerPercentiles.p50}ms, p95 ${plannerPercentiles.p95}ms`);
}
if (metrics.repeatedQuestions.length) {
  console.info(`\n[Batch] repeated questions (${metrics.repeatedQuestions.length}):`);
  for (const item of metrics.repeatedQuestions.slice(0, 12)) {
    console.info(`  ${item.scenario}: asked ${item.factId} ${item.count} times`);
  }
}
if (metrics.plannerErrors.length) {
  console.info(`\n[Batch] planner errors: ${[...new Set(metrics.plannerErrors)].join(', ')}`);
}
if (divergences.length) {
  console.info(`\n[Batch] TRANSPORT DIVERGENCES (${divergences.length}):`);
  for (const item of divergences) console.info(`  ${item.job.scenarioId}: ${item.outcome.divergence}`);
}
if (withJudge) {
  const summary = aggregateJudgements(judgements);
  console.info(`\n[Batch] judge (advisory — did not affect this run's result):`);
  console.info(`  tone ${summary.tone} · groundedness ${summary.groundedness} · `
    + `explains why ${summary.explains_why} · momentum ${summary.momentum} `
    + `(${summary.conversationsJudged} judged)`);
}

const report = {
  generatedAt: new Date().toISOString(),
  releasedModules: RELEASED_MODULE_IDS,
  settings: { repeats, maxTurns, concurrency: batch.concurrencyLimit, runCeilingEur, dayCeilingEur, bothTransports, withJudge },
  spend: { runEur: ledger.spentThisRunEur, stoppedReason: batch.stoppedReason, skipped: batch.skipped.length },
  metrics,
  plannerLatencyMs: plannerPercentiles,
  divergences: divergences.map((item) => ({ scenario: item.job.scenarioId, detail: item.outcome.divergence })),
  judge: withJudge ? aggregateJudgements(judgements) : null,
  conversations: batch.results.map((item) => ({
    scenario: item.job.scenarioId,
    repeat: item.job.repeat,
    error: item.error,
    wallClockMs: item.wallClockMs,
    turns: item.outcome?.turns?.length ?? 0,
    goals: item.outcome?.turns?.at(-1)?.goals ?? [],
    analyses: item.outcome?.turns?.at(-1)?.analyses ?? [],
    transcript: item.outcome?.transcript ?? []
  }))
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.info(`\n[Batch] report written to ${reportPath}`);

// THE EXIT CODE IS DETERMINISTIC. Conversations that failed outright, and
// transport divergences, decide it. The judge's scores never do.
const failed = metrics.failed + divergences.length;
if (failed > 0) {
  console.info(`\n[Batch] ${failed} deterministic failure(s). The judge's scores did not affect this.`);
  process.exit(1);
}
console.info('\n[Batch] no deterministic failures.');
