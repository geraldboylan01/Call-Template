#!/usr/bin/env node

/**
 * PHASE 4 BATCH — the same call, several times, because once tells you nothing.
 *
 * WHY REPEATS. Ten paid probes on byte-identical input produced materially
 * different runs: the income landed on some and not others, the partner age
 * came and went, the planner asked six clarifying questions on one run and none
 * on the next. A single run cannot tell a defect from variance, and reporting
 * one as pass/fail would be reporting a coin toss as a measurement.
 *
 * So every criterion is reported k/N. 5/5 and 0/5 are findings; anything
 * between is itself the finding, and is the number worth acting on.
 *
 * PAID. Each run is a whole conversation: a persona model, the live assistant
 * model, and the real background planner. Local SQLite only — no deployment, no
 * production configuration, no writes outside this process.
 *
 *   npm run batch:phase4 -- --repeats=5
 *   npm run batch:phase4 -- --repeats=1 --personas=pension_easy   (smoke)
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIAGNOSTICS_ROOT } from './live-harness/diagnostics.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const REPEATS = Math.max(1, Number(flag('repeats', '5')) || 5);
const PERSONAS = flag('personas', 'pension_easy,pension_medium,pension_hard')
  .split(',').map((id) => id.trim()).filter(Boolean);
const MODEL_MODE = flag('model', 'live');

if (MODEL_MODE === 'live' && !String(process.env.OPENAI_API_KEY || '').trim()) {
  console.error('The batch runs real conversations and needs OPENAI_API_KEY.');
  process.exit(2);
}

const runner = fileURLToPath(new URL('./run-live-call.mjs', import.meta.url));

/**
 * ONE STABLE, PERSISTENT DIRECTORY PER RUN.
 *
 * The first batch wrote traces to a temp workspace and deleted it on exit. It
 * produced twelve k/5 scores, no evidence, and cost €0.90 to learn that medium
 * captures module-critical facts 2 times in 5 — with no way to ask why. The
 * artifacts now outlive the batch, and the batch prints where they are.
 */
const BATCH_STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
const runIdFor = (personaId, run) => `${BATCH_STAMP}-${personaId}-${String(run).padStart(2, '0')}`;

/**
 * THE CRITERIA, EACH A YES/NO ABOUT ONE RUN.
 *
 * Written as predicates over the run's trace rather than parsed out of console
 * output, so a change to the printing cannot quietly change a result. Every one
 * corresponds to something a real call either did or did not do.
 */
const CRITERIA = Object.freeze({
  module_critical_capture: (t) => t.readiness.after.length === 0,
  no_false_positive_facts: (t) => t.falsePositiveFacts === 0,
  no_redundant_questions: (t) => t.redundantQuestions === 0,
  // null when the conversation never established the facts to judge — left out
  // of the denominator rather than scored as a wrong owner. See
  // module_arithmetic_correct.
  ownership_correct: (t) => (t.ownership.correct === null ? null : t.ownership.correct === true),
  aggregate_not_position: (t) => t.aggregateAsPosition === 0,
  correction_superseded: (t) => t.supersessionFailures === 0,
  reconciliation_applied: (t) => t.reconciliation.applied > 0,
  no_reconciliation_conflict: (t) => t.reconciliation.conflicted === 0,
  no_planner_timeout: (t) => t.reconciliation.timedOut === 0,
  confirmation_succeeded: (t) => t.confirmed === true,
  module_executed: (t) => t.moduleCompleted === true,
  // null means no module ran, which is already counted by module_executed.
  // Scoring it as an arithmetic failure double-counts one failure as two and
  // hides whether any client was ever given a wrong number.
  module_arithmetic_correct: (t) => (t.moduleArithmeticCorrect === null ? null : t.moduleArithmeticCorrect === true)
});

const results = [];
for (const personaId of PERSONAS) {
  for (let run = 1; run <= REPEATS; run += 1) {
    const runId = runIdFor(personaId, run);
    const runDir = join(DIAGNOSTICS_ROOT, runId);
    const label = `${personaId} ${run}/${REPEATS}`;
    process.stdout.write(`[batch] ${label} … `);
    const started = Date.now();
    const outcome = spawnSync('node', [
      runner, `--persona=${personaId}`, `--model=${MODEL_MODE}`, `--run-id=${runId}`
    ], { encoding: 'utf8', timeout: 900_000 });
    let trace = null;
    try {
      // The run's own summary, in the directory that survives this process.
      trace = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    } catch (_error) {
      trace = null;
    }
    const wallMs = Date.now() - started;
    // A CRASHED RUN IS A RESULT, NOT A GAP. Dropping it would quietly raise
    // every k/N by removing the worst runs from the denominator.
    results.push({
      personaId,
      run,
      runId,
      runDir,
      wallMs,
      crashed: trace === null,
      stderr: trace === null ? String(outcome.stderr || '').slice(-600) : '',
      trace
    });
    console.info(trace === null ? `CRASHED (${Math.round(wallMs / 1000)}s)` : `${Math.round(wallMs / 1000)}s`);
  }
}

/* ------------------------------------------------------------- the report */

const line = (text = '') => console.info(text);
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

line(`\n${'='.repeat(78)}`);
line(`PHASE 4 BATCH — ${PERSONAS.length} personas x ${REPEATS} runs, model=${MODEL_MODE}`);
line('='.repeat(78));

for (const personaId of PERSONAS) {
  const runs = results.filter((item) => item.personaId === personaId);
  const usable = runs.filter((item) => !item.crashed);
  line(`\n${personaId}  (${usable.length}/${runs.length} completed)`);
  for (const [name, predicate] of Object.entries(CRITERIA)) {
    // A crashed run scores as a failure for every criterion, because it is one.
    // A criterion that does not APPLY to a run leaves the denominator, rather
    // than scoring as a failure — see module_arithmetic_correct.
    const verdicts = runs.map((item) => {
      if (item.crashed) return false;
      try { return predicate(item.trace); } catch (_error) { return false; }
    });
    const applicable = verdicts.filter((verdict) => verdict !== null);
    const hits = applicable.filter((verdict) => verdict === true).length;
    const total = applicable.length;
    const bar = total === 0 ? '—'
      : hits === total ? '█'.repeat(total)
        : hits === 0 ? '·'.repeat(total)
          : '█'.repeat(hits) + '·'.repeat(total - hits);
    const skipped = verdicts.length - total;
    line(`  ${name.padEnd(30)} ${hits}/${total}  ${bar}`
      + (skipped ? `   (${skipped} n/a)` : ''));
  }
  const live = usable.flatMap((item) => item.trace.turns.map((turn) => turn.replyLatencyMs));
  const plannerLatencies = usable.flatMap((item) => item.trace.reconciliation.latencies || []);
  line(`  ${'live reply latency (median)'.padEnd(30)} ${median(live)}ms   max ${Math.max(0, ...live)}ms`);
  line(`  ${'planner latency (median)'.padEnd(30)} ${median(plannerLatencies)}ms   max ${Math.max(0, ...plannerLatencies)}ms`);
  line(`  ${'spend'.padEnd(30)} €${usable.reduce((total, item) => total + (item.trace.spendEur || 0), 0).toFixed(4)}`);

  // REPEATED FAILURE PATTERNS. A criterion that fails on most runs of one
  // persona and passes on another is a property of that conversation, not noise.
  const repeated = Object.entries(CRITERIA)
    .map(([name, predicate]) => {
      const verdicts = runs.map((item) => {
        if (item.crashed) return false;
        try { return predicate(item.trace); } catch (_error) { return false; }
      }).filter((verdict) => verdict !== null);
      return [name, verdicts.filter((v) => v === true).length, verdicts.length];
    })
    .filter(([, hits, total]) => total > 0 && hits < total && hits <= Math.floor(total / 2))
    .map(([name]) => name);
  if (repeated.length) line(`  REPEATED FAILURE: ${repeated.join(', ')}`);
  for (const crashed of runs.filter((item) => item.crashed)) {
    line(`  CRASHED run ${crashed.run}: ${crashed.stderr.split('\n').filter(Boolean).at(-1) || '(no stderr)'}`);
    line(`            artifacts: ${crashed.runDir}`);
  }
  // Where to read every failure, printed with the scores rather than left to be
  // reconstructed later.
  for (const item of runs) {
    const failed = item.crashed ? ['crashed'] : (item.trace?.criteriaFailed || []);
    if (failed.length) line(`  run ${item.run}: ${failed.join(', ')}  →  ${item.runDir}/timeline.txt`);
  }
}

const allUsable = results.filter((item) => !item.crashed);
line(`\n${'='.repeat(78)}`);
line(`total runs ${results.length}  ·  completed ${allUsable.length}  ·  `
  + `spend €${allUsable.reduce((total, item) => total + (item.trace.spendEur || 0), 0).toFixed(4)}`);
line(`diagnostics kept in ${DIAGNOSTICS_ROOT}/${BATCH_STAMP}-*`);
process.exitCode = allUsable.length === results.length ? 0 : 1;
