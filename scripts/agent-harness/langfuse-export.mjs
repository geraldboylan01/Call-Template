/**
 * A8 — publishing a harness run to Langfuse.
 *
 * THE ARCHIVE STAYS THE SOURCE OF TRUTH. This module reads a finished run
 * record and republishes it; it never sits in the call path. A run that found a
 * regression reports it identically whether Langfuse is configured, down, or
 * has never been heard of. That ordering is deliberate — telemetry that can
 * change a result is not telemetry.
 *
 * Exporting from the record rather than from the live run buys two things:
 * every runner that produces the archive shape gets tracing for free, and an
 * already-archived run can be published later, which is what makes grading work
 * at all.
 *
 * WHY THE IDS ARE DERIVED, NOT RANDOM. You run a call today and grade it
 * tomorrow. `apply-consumer-agent-grades.mjs` has to attach your grades to the
 * trace that already exists, so both passes seed the id from `runId:callId` and
 * arrive at the same value without the archive format having to carry it.
 *
 * WHAT THE TIMINGS MEAN. The two model spans carry REAL measured latency. The
 * per-turn spans do not — the archive keeps a transcript, not a clock, so those
 * spans exist to give the conversation shape in the UI and are marked
 * `timing: structural` so nobody reads a duration off them.
 */

import { createLangfuseClient, deterministicIds } from '../lib/langfuse.mjs';
import { euroCostFor } from './cost.mjs';
import { JUDGE_DIMENSIONS } from '../agent-judges/conversation.mjs';
import { GRADE_DIMENSIONS } from './grading.mjs';

/** The trace a given call occupies, in this run and in any later grading pass. */
export function traceIdForCall(runId, callId) {
  return deterministicIds(`${runId}:${callId}`).traceId;
}

/** Tags carry the run key, so Langfuse groups exactly what the archive says is comparable. */
function tagsForRun(record, call) {
  return [
    ...String(record.runKey || '').split(' ').filter(Boolean),
    call?.caller ? `caller:${call.caller}` : null,
    call?.error ? 'outcome:failed' : `outcome:${call?.execution?.status || 'not_attempted'}`,
    ...(call?.tags || [])
  ].filter(Boolean);
}

/** Pairs a flat transcript into client/planner turns. */
function turnsFromTranscript(transcript) {
  const turns = [];
  for (const entry of transcript || []) {
    const isClient = entry.role === 'client';
    const open = turns.at(-1);
    if (isClient || !open || open.planner !== null) {
      turns.push({ client: isClient ? entry.text : null, planner: isClient ? null : entry.text });
    } else {
      open.planner = entry.text;
    }
  }
  return turns;
}

/** One measured model span, from the usage the cost ledger already collects. */
function addModelSpan(root, name, usage, startedAt) {
  if (!usage || !usage.model) return;
  const latency = Number(usage.latencyMs || 0);
  root.child({ name, startedAt })
    .end({
      observationType: 'generation',
      model: usage.model,
      usage: {
        inputTokens: Number(usage.inputTokens || 0),
        outputTokens: Number(usage.outputTokens || 0),
        cachedInputTokens: Number(usage.cachedInputTokens || 0)
      },
      cost: euroCostFor({
        model: usage.model,
        inputTokens: Number(usage.inputTokens || 0),
        outputTokens: Number(usage.outputTokens || 0),
        cachedInputTokens: Number(usage.cachedInputTokens || 0)
      }),
      endedAt: startedAt + latency
    });
}

/**
 * Builds the spans and scores for one archived call. Exported separately from
 * the flush so it can be asserted on without a network.
 */
export function exportCall(client, record, call) {
  const traceId = traceIdForCall(record.runId, call.callId ?? call.caller ?? 'call');
  const finishedAt = Date.parse(record.generatedAt || '') || Date.now();
  const turns = turnsFromTranscript(call.transcript);
  // Turn slots are laid out backwards from the run's timestamp purely so they
  // render in order; see the header note on what these durations are not.
  const firstTurnAt = finishedAt - turns.length - 2;

  const root = client.startTrace({
    traceId,
    name: `call:${call.caller || call.callId || 'unknown'}`,
    startedAt: firstTurnAt,
    isRoot: true
  });

  turns.forEach((turn, index) => {
    const startedAt = firstTurnAt + index;
    root.child({ name: `turn[${index}]`, startedAt })
      .end({
        input: turn.client,
        output: turn.planner,
        endedAt: startedAt + 1,
        metadata: { timing: 'structural', turnIndex: index }
      });
  });

  addModelSpan(root, 'client.simulated', call.usage?.client, finishedAt - 2);
  addModelSpan(root, 'planner', call.usage?.planner, finishedAt - 1);

  const blockers = call.blockers || [];
  root.end({
    endedAt: finishedAt,
    input: call.callerPath || call.caller || null,
    output: {
      goals: call.goals || [],
      analyses: call.analyses || [],
      execution: call.execution?.status || 'not_attempted',
      completedModuleIds: call.execution?.completedModuleIds || [],
      error: call.error || null
    },
    level: call.error || blockers.some((item) => item.severity === 'blocking') ? 'ERROR' : 'DEFAULT',
    statusMessage: call.error || null,
    tags: tagsForRun(record, call),
    sessionId: record.runId,
    metadata: {
      runKey: record.runKey,
      turns: call.turns ?? turns.length,
      factCount: (call.factIds || []).length,
      abandoned: Boolean(call.abandoned),
      blockingFindings: blockers.filter((item) => item.severity === 'blocking').length,
      frictionFindings: blockers.filter((item) => item.severity === 'friction').length,
      blockers: blockers.map((item) => `${item.severity}/${item.id}@${item.turn}`),
      reviewBiggestChange: call.review?.biggestSingleChange || null
    }
  });

  // The judge is advisory here exactly as it is in the harness: these land as
  // scores to be compared against yours, never as a pass/fail.
  const judged = call.judge || {};
  if (judged.available) {
    for (const dimension of JUDGE_DIMENSIONS) {
      client.score({
        traceId,
        name: `judge.${dimension}`,
        value: judged[dimension],
        comment: judged.note || undefined
      });
    }
  }
  // Runners with their own grading dimensions -- the live persona replay grades
  // openness, naturalness, tangent handling and safety -- pass them here rather
  // than being forced through the conversation judge's four.
  for (const [name, value] of Object.entries(call.scores || {})) {
    client.score({ traceId, name, value, comment: call.scoreNote || undefined });
  }
  // Deterministic counts are the objective half and are always posted.
  client.score({ traceId, name: 'blockers.blocking', value: blockers.filter((item) => item.severity === 'blocking').length });
  client.score({ traceId, name: 'blockers.friction', value: blockers.filter((item) => item.severity === 'friction').length });

  return { traceId, spans: turns.length + 1, root };
}

/**
 * Publishes a whole run. Returns a summary; never throws.
 *
 * @param {object} record the archive record written by runlog.saveRun
 * @param {object} [options]
 * @param {object} [options.env] defaults to process.env
 */
export async function exportRun(record, { env = process.env } = {}) {
  const client = createLangfuseClient({
    env,
    release: record.runKey,
    sessionId: record.runId
  });
  if (!client.enabled) return { enabled: false, calls: 0, delivered: 0, failures: 0 };

  for (const call of record.calls || []) exportCall(client, record, call);
  const flushed = await client.flush();
  return { enabled: true, calls: (record.calls || []).length, ...flushed };
}

/**
 * Publishes a batch report.
 *
 * The batch writes `conversations` where the call runner writes `calls`, and
 * identifies a conversation by scenario + repeat rather than by caller. Mapping
 * it onto the same shape here keeps one export path rather than two that could
 * drift apart.
 */
export function batchAsRecord(report) {
  return {
    runId: report.runId,
    runKey: report.runKey,
    generatedAt: report.generatedAt,
    calls: (report.conversations || []).map((conversation) => {
      const callId = `${conversation.scenario}#${conversation.repeat}`;
      return {
        callId,
        caller: conversation.scenario,
        turns: conversation.turns,
        goals: conversation.goals,
        analyses: conversation.analyses,
        transcript: conversation.transcript,
        usage: conversation.usage,
        judge: conversation.judge,
        error: conversation.error,
        // A transport divergence is the batch's own blocking finding: the agent
        // and voice paths reaching different states is a failure of the
        // harness's premise, so it is reported as loudly here as anywhere else.
        blockers: conversation.divergence
          ? [{ severity: 'blocking', id: 'transport_divergence', turn: conversation.turns, detail: conversation.divergence }]
          : [],
        execution: { status: conversation.error ? 'failed' : 'complete' }
      };
    })
  };
}

export async function exportBatch(report, options = {}) {
  return exportRun(batchAsRecord(report), options);
}

/**
 * Publishes your grades against the traces the run already created.
 *
 * Posted after the fact, which is the point: the grading sheet is written with
 * the judge's scores blank so your grade is not anchored to it, and this
 * preserves that — your score reaches Langfuse having never been influenced by
 * the judge's.
 *
 * @param {object} record the archive record the grades belong to
 * @param {Array<object>} grades exactly what grading.parseGradingSheet returns:
 *   `{ callId, graded, scores, mean, notes }`. An ungraded entry is skipped, not
 *   posted as a zero — a blank score is a score you did not give.
 */
export async function exportGrades(record, grades, { env = process.env } = {}) {
  const client = createLangfuseClient({ env, release: record.runKey, sessionId: record.runId });
  if (!client.enabled) return { enabled: false, graded: 0, delivered: 0, failures: 0 };

  let graded = 0;
  for (const grade of grades || []) {
    if (!grade?.graded || !grade.callId) continue;
    const traceId = traceIdForCall(record.runId, grade.callId);
    let posted = false;
    for (const { key } of GRADE_DIMENSIONS) {
      const value = grade.scores?.[key];
      if (value === null || value === undefined) continue;
      client.score({ traceId, name: `human.${key}`, value, comment: grade.notes || undefined });
      posted = true;
    }
    if (posted) graded += 1;
  }
  const flushed = await client.flush();
  return { enabled: true, graded, ...flushed };
}
