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

const DEFAULT_LANGFUSE_HOST = 'https://cloud.langfuse.com';
const SAFE_EXECUTION_OUTCOMES = new Set([
  'complete', 'failed', 'needs_information', 'not_attempted', 'partial', 'refused'
]);
const SAFE_RECONCILIATION_VERDICTS = new Set([
  'clean', 'changes_proposed', 'clarification_required'
]);
const SAFE_RECONCILIATION_STATUSES = new Set([
  'shadow', 'applied', 'no_change', 'needs_profile_projection', 'duplicate',
  'clarification_required', 'conflicted', 'rejected', 'failed'
]);
const SAFE_CUSTOM_SCORE_NAMES = new Set([
  'openness', 'naturalness', 'tangentHandling', 'questionRelevance',
  'safety', 'wouldDemoWell'
]);

/** The trace a given call occupies, in this run and in any later grading pass. */
export function traceIdForCall(runId, callId) {
  return deterministicIds(`${runId}:${callId}`).traceId;
}

function contentAllowed(record) {
  return record?.synthetic === true
    && record?.contentPolicy === 'synthetic_test_content';
}

function safeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function safeScore(value) {
  if (typeof value === 'boolean') return value;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeModel(value) {
  const model = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(model) ? model : 'unknown';
}

function safeOutcome(call) {
  if (call?.error) return 'failed';
  const status = String(call?.execution?.status || 'not_attempted');
  return SAFE_EXECUTION_OUTCOMES.has(status) ? status : 'not_attempted';
}

function langfuseHost(env = process.env) {
  const candidate = String(env?.LANGFUSE_HOST || '').trim() || DEFAULT_LANGFUSE_HOST;
  try {
    const url = new URL(candidate);
    if (!['https:', 'http:'].includes(url.protocol)) return DEFAULT_LANGFUSE_HOST;
    return url.href.replace(/\/$/, '');
  } catch {
    return DEFAULT_LANGFUSE_HOST;
  }
}

/** Stable trace identity shared by the archived call and its post-run T2 span. */
export function traceLinkForCall(runId, callId, { env = process.env, traceId = null } = {}) {
  const resolvedTraceId = /^[a-f0-9]{32}$/i.test(String(traceId || ''))
    ? String(traceId).toLowerCase()
    : traceIdForCall(runId, callId);
  return {
    traceId: resolvedTraceId,
    traceLink: `${langfuseHost(env)}/trace/${resolvedTraceId}`
  };
}

/** Tags carry the run key, so Langfuse groups exactly what the archive says is comparable. */
function tagsForRun(record, call, includeContent) {
  if (!includeContent) {
    return ['content:metadata_only', `outcome:${safeOutcome(call)}`];
  }
  return [
    ...String(record.runKey || '').split(' ').filter(Boolean),
    call?.caller ? `caller:${call.caller}` : null,
    `outcome:${safeOutcome(call)}`,
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
  const model = safeModel(usage.model);
  const latency = Number(usage.latencyMs || 0);
  root.child({ name, startedAt })
    .end({
      observationType: 'generation',
      model,
      usage: {
        inputTokens: Number(usage.inputTokens || 0),
        outputTokens: Number(usage.outputTokens || 0),
        cachedInputTokens: Number(usage.cachedInputTokens || 0)
      },
      cost: euroCostFor({
        model,
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
  const turnRecords = call.turnRecords || [];
  // Synthetic harness content is useful diagnostic evidence. An explicitly
  // metadata-only call (the policy used for public/live cohorts) never exports
  // transcript, profile, candidate value, evidence quote, or raw extraction.
  const includeContent = contentAllowed(call);
  // Turn slots are laid out backwards from the run's timestamp purely so they
  // render in order; see the header note on what these durations are not.
  const firstTurnAt = finishedAt - turns.length - 2;

  const root = client.startTrace({
    traceId,
    name: includeContent ? `call:${call.caller || call.callId || 'unknown'}` : 'call:metadata_only',
    startedAt: firstTurnAt,
    isRoot: true
  });

  turns.forEach((turn, index) => {
    const startedAt = firstTurnAt + index;
    const observed = turnRecords[index] || {};
    const blockersAtTurn = (call.blockers || [])
      .filter((item) => Number(item.turn) === index + 1)
      .map((item) => `${item.severity}/${item.id}`);
    const turnSpan = root.child({ name: `turn[${index}]`, startedAt });
    const rawExtraction = observed.observation?.extraction?.raw;
    if (rawExtraction && includeContent) {
      turnSpan.child({ name: 'planner.extraction', startedAt })
        .end({
          input: {
            transcriptId: observed.clientTurnId || null,
            transcript: turn.client
          },
          output: rawExtraction,
          endedAt: startedAt + 1,
          metadata: {
            timing: 'structural',
            acceptedCandidates: (observed.observation?.extraction?.candidates || [])
              .filter((item) => item.accepted).length,
            rejectedCandidates: (observed.observation?.extraction?.candidates || [])
              .filter((item) => item.accepted === false).length
          }
        });
    }
    const safeTurnMetadata = {
      timing: 'structural',
      turnIndex: index,
      profileRevisionBefore: Number(observed.observation?.profiles?.beforeRevision) || 0,
      profileRevisionAfter: Number(observed.observation?.profiles?.afterRevision) || 0,
      rejectedCandidateCount: (observed.rejectedFactInstances || []).length,
      blockerCount: blockersAtTurn.length
    };
    turnSpan.end({
      input: includeContent ? turn.client : null,
      output: includeContent ? turn.planner : null,
      endedAt: startedAt + 1,
      metadata: includeContent ? {
        ...safeTurnMetadata,
        clientTurnId: observed.clientTurnId || null,
        assistantTurnId: observed.assistantTurnId || null,
        questionFactInstanceId: observed.questionFactInstanceId || null,
        rejectionCodes: (observed.rejectedFactInstances || [])
          .map((item) => item.rejectionCode).filter(Boolean),
        blockers: blockersAtTurn
      } : safeTurnMetadata
    });
  });

  addModelSpan(root, 'client.simulated', call.usage?.client, finishedAt - 2);
  addModelSpan(root, 'planner', call.usage?.planner, finishedAt - 1);

  const blockers = call.blockers || [];
  root.end({
    endedAt: finishedAt,
    input: includeContent ? call.callerPath || call.caller || null : null,
    output: includeContent ? {
      goals: call.goals || [],
      analyses: call.analyses || [],
      execution: call.execution?.status || 'not_attempted',
      completedModuleIds: call.execution?.completedModuleIds || [],
      error: call.error || null
    } : null,
    level: call.error || blockers.some((item) => item.severity === 'blocking') ? 'ERROR' : 'DEFAULT',
    statusMessage: includeContent ? call.error || null : call.error ? 'call_failed' : null,
    tags: tagsForRun(record, call, includeContent),
    sessionId: includeContent
      ? record.runId
      : `metadata-${deterministicIds(record.runId || 'run').traceId}`,
    metadata: includeContent ? {
      runKey: record.runKey,
      turns: safeCount(call.turns ?? turns.length),
      factCount: (call.factIds || []).length,
      abandoned: Boolean(call.abandoned),
      blockingFindings: blockers.filter((item) => item.severity === 'blocking').length,
      frictionFindings: blockers.filter((item) => item.severity === 'friction').length,
      blockers: blockers.map((item) => `${item.severity}/${item.id}@${item.turn}`),
      reviewBiggestChange: call.review?.biggestSingleChange || null
    } : {
      contentPolicy: 'metadata_only',
      turns: safeCount(call.turns ?? turns.length),
      factCount: (call.factIds || []).length,
      abandoned: Boolean(call.abandoned),
      blockingFindings: blockers.filter((item) => item.severity === 'blocking').length,
      frictionFindings: blockers.filter((item) => item.severity === 'friction').length
    }
  });

  // The judge is advisory here exactly as it is in the harness: these land as
  // scores to be compared against yours, never as a pass/fail.
  const judged = call.judge || {};
  if (judged.available) {
    for (const dimension of JUDGE_DIMENSIONS) {
      const value = safeScore(judged[dimension]);
      if (value === null) continue;
      client.score({
        traceId,
        name: `judge.${dimension}`,
        value,
        comment: includeContent ? judged.note || undefined : undefined
      });
    }
  }
  // Runners with their own grading dimensions -- the live persona replay grades
  // openness, naturalness, tangent handling and safety -- pass them here rather
  // than being forced through the conversation judge's four.
  for (const [name, value] of Object.entries(call.scores || {})) {
    if (!includeContent && !SAFE_CUSTOM_SCORE_NAMES.has(name)) continue;
    const scored = safeScore(value);
    if (scored === null) continue;
    client.score({ traceId, name, value: scored, comment: includeContent ? call.scoreNote || undefined : undefined });
  }
  // Deterministic counts are the objective half and are always posted.
  client.score({ traceId, name: 'blockers.blocking', value: blockers.filter((item) => item.severity === 'blocking').length });
  client.score({ traceId, name: 'blockers.friction', value: blockers.filter((item) => item.severity === 'friction').length });

  const extractionSpans = includeContent
    ? turnRecords.filter((turn) => turn?.observation?.extraction?.raw).length
    : 0;
  return { traceId, spans: turns.length + extractionSpans + 1, root };
}

/**
 * Append the post-run T2 shadow generation to the call's deterministic trace.
 *
 * This is deliberately a standalone span rather than a new trace: the archive
 * call remains the unit a reviewer opens, and T1/T2 can be compared there. The
 * span id is deterministic too, so replaying one archived checkpoint cannot
 * create a second logical reconciliation observation.
 */
export function exportReconciliationShadowSpan(client, observation, {
  env = process.env
} = {}) {
  const identity = traceLinkForCall(
    observation.runId,
    observation.callId,
    { env, traceId: observation.traceId || null }
  );
  const includeContent = contentAllowed(observation);
  const finishedAt = Date.parse(observation.finishedAt || '') || Date.now();
  const latencyMs = safeCount(observation.usage?.latencyMs);
  const verdict = SAFE_RECONCILIATION_VERDICTS.has(observation.verdict)
    ? observation.verdict
    : 'clean';
  const status = SAFE_RECONCILIATION_STATUSES.has(observation.status)
    ? observation.status
    : 'failed';
  const spanId = deterministicIds(
    `${identity.traceId}:planner.reconciliation.shadow:${observation.checkpoint || 'full_call'}`
  ).spanId;
  const rootSpanId = deterministicIds(
    `${identity.traceId}:planner.reconciliation.shadow:root`
  ).spanId;
  const root = client.startTrace({
    traceId: identity.traceId,
    spanId: rootSpanId,
    name: 'call:reconciliation-shadow',
    startedAt: Math.max(0, finishedAt - latencyMs),
    tags: includeContent
      ? ['cohort:synthetic_test', 'phase:T2']
      : ['content:metadata_only', 'phase:T2']
  });
  const span = root.child({
    spanId,
    traceId: identity.traceId,
    name: 'planner.reconciliation.shadow',
    startedAt: Math.max(0, finishedAt - latencyMs)
  });
  const model = safeModel(observation.usage?.model);
  span.end({
    observationType: 'generation',
    model,
    input: includeContent ? observation.input ?? null : null,
    output: includeContent ? observation.output ?? null : null,
    usage: {
      inputTokens: safeCount(observation.usage?.inputTokens),
      outputTokens: safeCount(observation.usage?.outputTokens),
      cachedInputTokens: safeCount(observation.usage?.cachedInputTokens)
    },
    cost: euroCostFor({
      model,
      inputTokens: safeCount(observation.usage?.inputTokens),
      outputTokens: safeCount(observation.usage?.outputTokens),
      cachedInputTokens: safeCount(observation.usage?.cachedInputTokens)
    }),
    endedAt: finishedAt,
    metadata: {
      phase: 'T2',
      mode: 'shadow',
      contentPolicy: includeContent ? 'synthetic_test_content' : 'metadata_only',
      verdict,
      status,
      operationCount: safeCount(observation.operationCount),
      acceptedOperationCount: safeCount(observation.acceptedOperationCount),
      rejectedOperationCount: safeCount(observation.rejectedOperationCount),
      clarificationCount: safeCount(observation.clarificationCount),
      latencyMs
    }
  });
  root.end({
    endedAt: finishedAt,
    metadata: {
      phase: 'T2',
      mode: 'shadow',
      contentPolicy: includeContent ? 'synthetic_test_content' : 'metadata_only',
      operationCount: safeCount(observation.operationCount),
      acceptedOperationCount: safeCount(observation.acceptedOperationCount),
      rejectedOperationCount: safeCount(observation.rejectedOperationCount)
    }
  });
  return { ...identity, rootSpanId, spanId, root, span };
}

/**
 * Best-effort post-archive delivery for the shadow runner. Never throws: the
 * diagnostic artifact is authoritative and is written before this helper is
 * called, so telemetry cannot change reconciliation state or runner outcome.
 */
export async function exportReconciliationShadow(observation, {
  env = process.env,
  client: suppliedClient = null
} = {}) {
  const identity = traceLinkForCall(
    observation.runId,
    observation.callId,
    { env, traceId: observation.traceId || null }
  );
  try {
    const client = suppliedClient || createLangfuseClient({
      env,
      release: 'planner-reconciliation-shadow-v1',
      environment: 'harness',
      sessionId: `metadata-${deterministicIds(observation.runId || 'run').traceId}`
    });
    if (!client.enabled) {
      return { ...identity, enabled: false, delivered: 0, failures: 0 };
    }
    exportReconciliationShadowSpan(client, observation, { env });
    const flushed = await client.flush();
    return { ...identity, enabled: true, ...flushed };
  } catch (_error) {
    return { ...identity, enabled: Boolean(suppliedClient?.enabled), delivered: 0, failures: 1 };
  }
}

/**
 * Publishes a whole run. Returns a summary; never throws.
 *
 * @param {object} record the archive record written by runlog.saveRun
 * @param {object} [options]
 * @param {object} [options.env] defaults to process.env
 */
export async function exportRun(record, { env = process.env } = {}) {
  const calls = record.calls || [];
  const groups = [
    {
      calls: calls.filter(contentAllowed),
      release: record.runKey,
      sessionId: record.runId
    },
    {
      calls: calls.filter((call) => !contentAllowed(call)),
      release: 'metadata-only-v1',
      sessionId: `metadata-${deterministicIds(record.runId || 'run').traceId}`
    }
  ].filter((group) => group.calls.length > 0);
  let enabled = false;
  let delivered = 0;
  let spans = 0;
  let scores = 0;
  let failures = 0;
  for (const group of groups) {
    try {
      const client = createLangfuseClient({
        env,
        release: group.release,
        sessionId: group.sessionId
      });
      if (!client.enabled) continue;
      enabled = true;
      for (const call of group.calls) {
        try {
          exportCall(client, record, call);
        } catch (_error) {
          failures += 1;
        }
      }
      const flushed = await client.flush();
      delivered += safeCount(flushed.delivered);
      spans += safeCount(flushed.spans);
      scores += safeCount(flushed.scores);
      failures += safeCount(flushed.failures);
    } catch (_error) {
      failures += 1;
    }
  }
  return { enabled, calls: calls.length, delivered, spans, scores, failures };
}

/**
 * Publishes a batch report.
 *
 * The batch writes `conversations` where the call runner writes `calls`, and
 * identifies a conversation by scenario + repeat rather than by caller. Mapping
 * it onto the same shape here keeps one export path rather than two that could
 * drift apart.
 */
function batchAsRecord(report) {
  return {
    runId: report.runId,
    runKey: report.runKey,
    generatedAt: report.generatedAt,
    calls: (report.conversations || []).map((conversation) => {
      const callId = `${conversation.scenario}#${conversation.repeat}`;
      return {
        callId,
        caller: conversation.scenario,
        synthetic: conversation.synthetic === true || report.synthetic === true,
        contentPolicy: conversation.contentPolicy || report.contentPolicy || 'metadata_only',
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

async function exportBatch(report, options = {}) {
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
async function exportGrades(record, grades, { env = process.env } = {}) {
  const client = createLangfuseClient({ env, release: record.runKey, sessionId: record.runId });
  if (!client.enabled) return { enabled: false, graded: 0, delivered: 0, failures: 0 };

  let graded = 0;
  for (const grade of grades || []) {
    if (!grade?.graded || !grade.callId) continue;
    const traceId = traceIdForCall(record.runId, grade.callId);
    const call = (record.calls || []).find((item) => item.callId === grade.callId);
    const includeContent = contentAllowed(call);
    let posted = false;
    for (const { key } of GRADE_DIMENSIONS) {
      const value = grade.scores?.[key];
      if (value === null || value === undefined) continue;
      client.score({
        traceId,
        name: `human.${key}`,
        value,
        comment: includeContent ? grade.notes || undefined : undefined
      });
      posted = true;
    }
    if (posted) graded += 1;
  }
  const flushed = await client.flush();
  return { enabled: true, graded, ...flushed };
}
