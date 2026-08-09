// A7 — run one call as a pasted person, then review it.
//
// THE WORKFLOW THIS EXISTS FOR:
//
//   1. Paste someone's financial situation and their questions into a file.
//   2. Run this. A model plays that person and has a real call with the app.
//   3. Blockers are flagged AS THE CALL HAPPENS, so a call going nowhere stops
//      instead of burning ten more turns.
//   4. A reviewer writes up what worked and what to change.
//   5. A grading sheet is written for you. You grade it; those grades become
//      the ground truth the judge is measured against.
//
//   OPENAI_API_KEY=... node ./scripts/run-consumer-agent-call.mjs callers/mary.md
//   OPENAI_API_KEY=... node ./scripts/run-consumer-agent-call.mjs callers/*.md --turns=10
//
// PAID. Never run by CI.
//
// The assistant's WORDS here are the real ones: this run uses the same
// renderAssistantText the live transport uses, driven by the same shared
// instruction pack, because judging tone on a raw server question prompt would
// judge something no client ever hears.

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { createOpenAiClient } from './agent-clients/openai.mjs';
import {
  detectBlockers, detectExecutionBlockers, newBlockersAfterTurn, shouldAbandon, summariseBlockers
} from './agent-harness/blockers.mjs';
import { createCostLedger } from './agent-harness/cost.mjs';
import { buildGradingSheet } from './agent-harness/grading.mjs';
import { loadCallerFixture } from './agent-harness/caller.mjs';
import { exportRun, traceIdForCall } from './agent-harness/langfuse-export.mjs';
import {
  AGENT_RUN_ARCHIVE_VERSION, firstGoalTurn, runKey, saveRun
} from './agent-harness/runlog.mjs';
import { RELEASED_MODULE_IDS, runAgentScenario } from './agent-harness/transports.mjs';
import { aggregateJudgements, createOpenAiJudge, judgeConversation } from './agent-judges/conversation.mjs';
import { aggregateReviews, createOpenAiReviewer, reviewCall } from './agent-judges/review.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const callerPaths = args.filter((arg) => !arg.startsWith('--'));
const maxTurns = Math.max(1, Number(flag('turns', 10)) || 10);
const runCeilingEur = Number(flag('ceiling', 3)) || 3;
const outDir = flag('out', 'agent-runs');
const noReview = args.includes('--no-review');
const keepGoing = args.includes('--keep-going');
const langfuseConfigured = Boolean(
  String(process.env.LANGFUSE_PUBLIC_KEY || '').trim()
  && String(process.env.LANGFUSE_SECRET_KEY || '').trim()
);
const langfuseHost = String(process.env.LANGFUSE_HOST || '').trim() || 'https://cloud.langfuse.com';

const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
if (!apiKey) {
  console.error('OPENAI_API_KEY is required. This runner makes paid model calls.');
  process.exit(1);
}
if (callerPaths.length === 0) {
  console.error('Give me at least one caller file.');
  console.error('  node ./scripts/run-consumer-agent-call.mjs callers/mary.md');
  console.error('\nA caller file is plain text: who they are, what they have, what they earn.');
  console.error('Optional "# Questions" and "# Behaviour" headings. Nothing else is required.');
  process.exit(1);
}

const runId = `call-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
const ledger = createCostLedger({ runCeilingEur, estimatedConversationEur: 0.15 });
const judge = createOpenAiJudge({ apiKey });
const reviewer = noReview ? null : createOpenAiReviewer({ apiKey });

console.info(`[Call] ${callerPaths.length} caller(s), up to ${maxTurns} turns each`);
console.info(`[Call] released modules: ${RELEASED_MODULE_IDS}`);
console.info(`[Call] ceiling €${runCeilingEur.toFixed(2)} · real renderer (the words a client would hear)\n`);

const calls = [];
const judgements = [];
const reviews = [];
let lastConfig = null;

for (const callerPath of callerPaths) {
  const gate = ledger.mayDispatch();
  if (!gate.allowed) {
    console.info(`\n[Call] stopping before ${basename(callerPath)}: ${gate.reason}`);
    break;
  }

  let caller;
  let fixture;
  try {
    ({ caller, fixture } = loadCallerFixture(callerPath));
  } catch (error) {
    console.error(`  ✗ ${callerPath}: ${error.message}`);
    continue;
  }

  console.info(`${'='.repeat(72)}\n${caller.id}\n${'='.repeat(72)}`);

  const seen = new Set();
  const liveFindings = [];
  const client = createOpenAiClient({ apiKey, maxTurns });
  // Blockers are checked after every turn, so a call that has clearly gone
  // wrong stops there. That is the point of detecting mid-call rather than
  // in the post-mortem: it saves the turns AND it tells you exactly where it
  // went wrong, rather than handing you a whole transcript to bisect.
  const watchedClient = {
    ...client,
    usage: client.usage,
    async nextMessage(context) {
      const fresh = newBlockersAfterTurn(context.turnsSoFar || [], seen);
      for (const finding of fresh) {
        liveFindings.push(finding);
        console.info(`    ! [${finding.severity}] turn ${finding.turn}: ${finding.detail}`);
      }
      if (!keepGoing && shouldAbandon(fresh)) {
        console.info('    ! abandoning this call — it is not going anywhere');
        return null;
      }
      return client.nextMessage(context);
    },
    extractionFor: client.extractionFor.bind(client)
  };

  let run;
  try {
    run = await runAgentScenario(
      { ...caller, turns: Array.from({ length: maxTurns }, () => ({})) },
      {
        client: watchedClient,
        renderWithModel: true,
        // Finish the call. Without this the modules never run, and the only
        // thing left to grade is the conversation -- not the outcome it was
        // supposed to produce.
        confirmAndRun: true,
        envOverrides: { OPENAI_API_KEY: apiKey }
      }
    );
  } catch (error) {
    console.error(`  *** call failed: ${error?.code || error?.message}`);
    const traceId = traceIdForCall(runId, caller.id);
    calls.push({
      callId: caller.id,
      caller: caller.id,
      callerPath,
      synthetic: true,
      contentPolicy: 'synthetic_test_content',
      fixture,
      error: String(error?.message || error),
      turns: 0,
      transcript: [],
      blockers: [],
      usage: {
        client: { ...client.usage.client, calls: client.usage.clientCalls },
        planner: {
          ...client.usage.planner,
          calls: client.usage.plannerCalls,
          latenciesMs: [...client.usage.plannerLatenciesMs],
          latencyMs: client.usage.plannerLatenciesMs.reduce((sum, value) => sum + value, 0)
        }
      },
      langfuse: {
        traceId,
        traceUrl: langfuseConfigured
          ? `${langfuseHost.replace(/\/$/, '')}/trace/${traceId}`
          : null
      }
    });
    continue;
  }
  lastConfig = run.config;

  for (const entry of run.transcript) {
    console.info(`  ${entry.role === 'client' ? 'CLIENT ' : 'PLANÉIR'} ${entry.text}`);
  }

  const observedTurns = run.turnRecords || run.turns;
  const findings = [
    ...detectBlockers(observedTurns),
    ...detectExecutionBlockers(run.execution, run.turns.length, observedTurns)
  ];
  const last = run.turns.at(-1);
  console.info('\n  --- where the call got to ---');
  console.info(`  goals    : [${(last?.goals || []).join(', ')}]`);
  console.info(`  analyses : [${(last?.analyses || []).join(', ')}]`);
  console.info(`  facts    : ${(last?.factIds || []).length}`);
  console.info(`  turns    : ${run.turns.length}`);

  const execution = run.execution || {};
  console.info(`  analyses run: ${execution.status || 'not attempted'}`
    + (execution.completedModuleIds?.length ? ` — ${execution.completedModuleIds.join(', ')}` : ''));
  if (execution.missingForModules?.length) {
    console.info('\n  --- what the analyses were still short of ---');
    for (const missing of execution.missingForModules) {
      console.info(`  ${missing.moduleIds.join(', ') || 'an analysis'} needed `
        + `${missing.factId || missing.fieldPath}${missing.reason ? ` — ${missing.reason}` : ''}`);
    }
  }

  if (findings.length) {
    console.info(`\n  --- ${findings.length} blocker(s) ---`);
    for (const finding of findings) {
      console.info(`  [${finding.severity}] turn ${finding.turn}: ${finding.detail}`);
    }
  } else {
    console.info('\n  no mechanical blockers found');
  }

  const judged = await judgeConversation(judge, run);
  judgements.push({ callId: caller.id, ...judged });

  const review = await reviewCall(reviewer, run, findings);
  reviews.push(review);
  if (review.available) {
    console.info('\n  --- review ---');
    for (const item of review.worked) console.info(`  ✓ ${item}`);
    for (const item of review.didNotWork) {
      console.info(`  ✗ ${item.what}${item.turn ? ` (turn ${item.turn})` : ''}`);
      if (item.change) console.info(`      → ${item.change}`);
    }
    if (review.biggestSingleChange) console.info(`\n  biggest single change: ${review.biggestSingleChange}`);
  }

  ledger.record({ role: 'client', ...client.usage.client });
  ledger.record({ role: 'planner', ...client.usage.planner });
  ledger.completeConversation();

  calls.push({
    callId: caller.id,
    caller: caller.id,
    callerPath,
    synthetic: true,
    contentPolicy: 'synthetic_test_content',
    fixture,
    turns: run.turns.length,
    firstGoalTurn: firstGoalTurn(observedTurns),
    turnRecords: observedTurns,
    goals: last?.goals || [],
    analyses: last?.analyses || [],
    factIds: last?.factIds || [],
    blockerCount: findings.length,
    blockers: findings,
    execution: {
      status: execution.status || 'not_attempted',
      moduleIds: execution.moduleIds || [],
      completedModuleIds: execution.completedModuleIds || [],
      gatedModuleIds: execution.gatedModuleIds || [],
      missingForModules: execution.missingForModules || [],
      results: execution.results || [],
      error: execution.error || null
    },
    abandoned: liveFindings.length > 0 && run.turns.length < maxTurns,
    judge: judged,
    review,
    usage: {
      client: { ...client.usage.client, calls: client.usage.clientCalls },
      planner: {
        ...client.usage.planner,
        calls: client.usage.plannerCalls,
        latenciesMs: [...client.usage.plannerLatenciesMs],
        latencyMs: client.usage.plannerLatenciesMs.reduce((sum, value) => sum + value, 0)
      }
    },
    langfuse: {
      traceId: traceIdForCall(runId, caller.id),
      traceUrl: langfuseConfigured
        ? `${langfuseHost.replace(/\/$/, '')}/trace/${traceIdForCall(runId, caller.id)}`
        : null
    },
    transcript: run.transcript,
    error: null
  });
  console.info('');
}

/* ---------------------------------------------------------------- report */

const completed = calls.filter((call) => !call.error);
const turnsToGoal = completed
  .map((call) => call.firstGoalTurn)
  .filter(Number.isFinite);

const metrics = {
  calls: calls.length,
  completed: completed.length,
  blockingFindings: completed.reduce(
    (sum, call) => sum + call.blockers.filter((item) => item.severity === 'blocking').length, 0
  ),
  frictionFindings: completed.reduce(
    (sum, call) => sum + call.blockers.filter((item) => item.severity === 'friction').length, 0
  ),
  repeatedQuestions: completed.reduce(
    (sum, call) => sum + call.blockers.filter((item) => item.id === 'repeated_question').length, 0
  ),
  turnsToGoal: turnsToGoal.length ? turnsToGoal.reduce((sum, value) => sum + value, 0) / turnsToGoal.length : null,
  goalCaptureRate: completed.length
    ? completed.filter((call) => call.goals.length > 0).length / completed.length : null,
  // The metric that matters most: did the call gather enough for the analyses
  // it promised to actually run? A call can feel perfect and still fail here.
  analysisCompletionRate: completed.length
    ? completed.filter((call) => call.execution?.status === 'complete').length / completed.length : null,
  analysisSelectionRate: completed.length
    ? completed.filter((call) => call.analyses.length > 0).length / completed.length : null,
  judgeGradeMean: aggregateJudgements(judgements.map((item) => item)).conversationsJudged
    ? Number((judgements.filter((item) => item.available)
      .reduce((sum, item) => sum + item.mean, 0)
      / judgements.filter((item) => item.available).length).toFixed(2))
    : null,
  humanGradeMean: null
};

const record = {
  schemaVersion: AGENT_RUN_ARCHIVE_VERSION,
  runId,
  generatedAt: new Date().toISOString(),
  runKey: runKey({
    config: lastConfig || {},
    releasedModuleIds: RELEASED_MODULE_IDS,
    manifestVersion: '2.0.0'
  }),
  spendEur: ledger.spentThisRunEur,
  metrics,
  blockerSummary: summariseBlockers(completed.flatMap((call) => call.blockers)),
  reviewThemes: aggregateReviews(reviews),
  judge: aggregateJudgements(judgements),
  calls
};

mkdirSync(outDir, { recursive: true });
const archivePath = saveRun(record, { dir: outDir });
const sheetPath = join(outDir, `${runId}-grading.md`);
writeFileSync(sheetPath, buildGradingSheet({ runId, calls: completed }));

// Telemetry begins only after the local archive is safely written. It is
// supplemental: disabled credentials, an outage, or a rejected export cannot
// alter the call record, its blockers, or the process exit code.
const langfuseExport = await exportRun(record).catch(() => ({
  enabled: langfuseConfigured, calls: 0, delivered: 0, failures: 1
}));

console.info(`${'='.repeat(72)}`);
console.info(`[Call] ${completed.length}/${calls.length} calls completed · spend €${ledger.spentThisRunEur.toFixed(4)}`);
console.info(`[Call] ${metrics.blockingFindings} blocking, ${metrics.frictionFindings} friction finding(s)`);
if (record.reviewThemes.recurringChanges.length) {
  console.info('\n[Call] changes suggested across more than one call:');
  for (const item of record.reviewThemes.recurringChanges) {
    console.info(`  (${item.calls}×) ${item.change}`);
  }
}
console.info(`\n[Call] run archived   : ${archivePath}`);
if (langfuseExport.enabled) {
  console.info(`[Call] Langfuse export: ${langfuseExport.delivered} delivered, ${langfuseExport.failures} failed`);
  for (const call of completed) console.info(`[Call] trace           : ${call.langfuse.traceUrl}`);
}
console.info(`[Call] grade it here  : ${sheetPath}`);
console.info('[Call] then run       : node ./scripts/apply-consumer-agent-grades.mjs '
  + `${sheetPath} --run=${archivePath}`);

// Blocking findings are a real result and set the exit code. Judge and reviewer
// opinions never do.
if (metrics.blockingFindings > 0) process.exit(1);
