#!/usr/bin/env node

/**
 * Replay archived synthetic agent calls through T2 only.
 *
 * This intentionally spends no caller or renderer calls and never mutates the
 * archived meeting database. It imports the frozen final profile, synthesizes
 * legacy ledger notes, asks the reconciler for a full-call plan, validates the
 * plan deterministically, and writes an ignored diagnostic artifact.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { applyReconciliationPlan } from '../js/planning/reconciliation.js';
import { loadAgentContext } from '../worker/src/consumer/agent_session.js';
import {
  buildPlannerReconciliationContext,
  legacyPlanningNotesFromProfile,
  requestPlannerReconciliation
} from '../worker/src/consumer/planner_reconciliation.js';
import {
  listRealtimeFinalTurns,
  listRealtimeWriteOutcomes
} from '../worker/src/consumer/realtime_repository.js';
import {
  exportReconciliationShadow,
  traceIdForCall,
  traceLinkForCall
} from './agent-harness/langfuse-export.mjs';
import {
  normalizeShadowExpectations,
  scoreReconciliationShadow,
  summarizeReconciliationShadowScores
} from './agent-harness/reconciliation-shadow-score.mjs';
import {
  cloneCallDatabaseForReconciliation,
  makeConfig,
  makeEnv
} from './agent-harness/transports.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const callDir = resolve(root, 'agent-calls');
const callerPath = resolve(root, 'callers/early-retirement-57.md');
const answerKeyPath = resolve(root, 'callers/early-retirement-57.answer-key.json');
const shadowExpectationsPath = resolve(root, 'callers/early-retirement-57.shadow-expectations.json');
const EXPECTED_CALLER_HASH = 'ee5c9806a55548d467ffe439f9a10767538968b67336e752e5e9429d71ad2b34';
const EXPECTED_ANSWER_KEY_HASH = 'a1ae6bb1992a09051bf74e77b1247d0cbaaf8f90f474f9eb985d9a5eeae6b39e';
const EXPECTED_SHADOW_EXPECTATIONS_HASH = 'bfb133452ef45b23a91edc2a8435ca7a5600fb2056d572e87e11eac84ee23f18';
const SHADOW_RUN_ID = 'p57-pre-reconciliation-shadow-v1';

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertFrozenFixtureHashes() {
  const callerHash = sha256File(callerPath);
  const answerKeyHash = sha256File(answerKeyPath);
  if (callerHash !== EXPECTED_CALLER_HASH || answerKeyHash !== EXPECTED_ANSWER_KEY_HASH) {
    throw new Error(
      'Frozen early-retirement fixture hashes changed; refusing paid reconciliation calls.'
    );
  }
  return Object.freeze({ callerHash, answerKeyHash });
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function loadFrozenShadowExpectations() {
  if (!existsSync(shadowExpectationsPath)) {
    return Object.freeze({ hash: null, fixture: null });
  }
  const hash = sha256File(shadowExpectationsPath);
  if (hash !== EXPECTED_SHADOW_EXPECTATIONS_HASH) {
    throw new Error('Frozen shadow expectations changed; refusing paid reconciliation calls.');
  }
  const fixture = normalizeShadowExpectations(
    JSON.parse(readFileSync(shadowExpectationsPath, 'utf8'))
  );
  return Object.freeze({ hash, fixture });
}

function argumentsFrom(argv) {
  const result = { calls: [], dryRun: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--call' && argv[index + 1]) result.calls.push(argv[++index]);
    else if (argv[index] === '--dry-run') result.dryRun = true;
    else if (argv[index] === '--force') result.force = true;
    else if (argv[index] === '--batch' && argv[index + 1] === 'p57-pre') {
      index += 1;
      result.calls.push('p57-pre-baseline', 'p57-pre-paraphrase', 'p57-pre-stress');
    }
  }
  if (result.calls.length === 0) result.calls.push('p57-pre-baseline');
  return result;
}

function reusableArtifact(outputPath, { inputDigest, promptVersion }) {
  if (!existsSync(outputPath)) return null;
  try {
    const artifact = JSON.parse(readFileSync(outputPath, 'utf8'));
    const matches = artifact.runId === SHADOW_RUN_ID
      && artifact.callerHash === frozenFixtureHashes.callerHash
      && artifact.answerKeyHash === frozenFixtureHashes.answerKeyHash
      && artifact.shadowExpectationsHash === frozenShadowExpectations.hash
      && artifact.promptVersion === promptVersion
      && artifact.inputDigest === inputDigest
      && artifact.plan?.schemaVersion === 1;
    return matches ? artifact : null;
  } catch {
    return null;
  }
}

function assertArchivedTranscriptMatches(storedTurns, archivedTranscript, callId) {
  const archived = archivedTranscript || [];
  if (storedTurns.length !== archived.length) {
    throw new Error(`${callId} stored/archive transcript length mismatch.`);
  }
  storedTurns.forEach((turn, index) => {
    const expectedRole = archived[index]?.role === 'client' ? 'user' : 'assistant';
    if (turn.role !== expectedRole || turn.transcript !== String(archived[index]?.text || '')) {
      throw new Error(`${callId} stored/archive transcript mismatch at turn ${index + 1}.`);
    }
  });
}

function archivedReducedWriteOutcomes(callId, storedUserTurns) {
  const turnsPath = resolve(callDir, `${callId}-turns.json`);
  if (!existsSync(turnsPath)) return [];
  const archived = JSON.parse(readFileSync(turnsPath, 'utf8'));
  if (!Array.isArray(archived)) throw new Error(`${callId} reduced turn archive is invalid.`);
  return archived.slice(0, storedUserTurns.length).map((turn, index) => ({
    source: 'archived_reduced_outcome',
    sourceTurnId: storedUserTurns[index].id,
    acceptedFactIds: Array.isArray(turn.acceptedFactIds) ? turn.acceptedFactIds : [],
    rejectedFactIds: Array.isArray(turn.rejectedFactIds) ? turn.rejectedFactIds : [],
    plannerErrorCode: turn.plannerErrorCode || null,
    degraded: turn.degraded === true
  }));
}

async function replay(callId, { dryRun = false, force = false } = {}) {
  const pointerPath = resolve(callDir, `${callId}-pointer.json`);
  const resultPath = resolve(callDir, `${callId}-result.json`);
  if (!existsSync(pointerPath) || !existsSync(resultPath)) {
    throw new Error(`Missing archived call artifacts for ${callId}.`);
  }
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  const archived = JSON.parse(readFileSync(resultPath, 'utf8'));
  const sourceDatabasePath = resolve(root, pointer.databasePath);
  const databasePath = cloneCallDatabaseForReconciliation(sourceDatabasePath, callId);
  const env = makeEnv(databasePath, {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CONSUMER_PLANNER_RECONCILIATION_MODE: 'shadow',
    // A full-call replay reviews every turn at once, so it is the heaviest
    // reconciliation shape there is — the incremental in-call window is much
    // smaller. The config bound still applies; this only lets the replay use
    // the top of that range instead of the in-call default.
    CONSUMER_PLANNER_RECONCILIATION_TIMEOUT_MS:
      process.env.CONSUMER_PLANNER_RECONCILIATION_TIMEOUT_MS
  });
  const config = makeConfig(env);
  const context = await loadAgentContext(env, config, pointer.sessionId, pointer.meetingId);
  const notes = legacyPlanningNotesFromProfile(context.profile);
  const turns = await listRealtimeFinalTurns(env, pointer.sessionId, pointer.meetingId, 200);
  assertArchivedTranscriptMatches(turns, archived.transcript, callId);
  const throughTurnId = [...turns].reverse().find((turn) => turn.role === 'user')?.id;
  if (!throughTurnId) throw new Error(`${callId} has no archived client turn.`);
  const storedUserTurns = turns.filter((turn) => turn.role === 'user');
  const archivedWriteOutcomes = archivedReducedWriteOutcomes(callId, storedUserTurns);
  const voiceWriteOutcomes = (await Promise.all(
    storedUserTurns.map(async (turn, index) => {
      const actual = await listRealtimeWriteOutcomes(
        env,
        pointer.sessionId,
        pointer.meetingId,
        turn.id,
        48
      );
      return actual.length > 0
        ? actual.map((outcome) => ({ ...outcome, sourceTurnId: turn.id }))
        : archivedWriteOutcomes[index] ? [archivedWriteOutcomes[index]] : [];
    })
  )).flat();
  const input = buildPlannerReconciliationContext({
    context,
    turns,
    notes,
    throughTurnId,
    voiceWriteOutcomes
  });
  const inputDigest = `sha256:${sha256Json(input)}`;
  const promptVersion = config.plannerReconciliationPromptVersion;
  const outputPath = resolve(callDir, `${callId}-reconciliation-shadow.json`);
  const cached = force ? null : reusableArtifact(outputPath, { inputDigest, promptVersion });
  if (dryRun) {
    return {
      callId,
      dryRun: true,
      inputDigest,
      promptVersion,
      reusableArtifact: Boolean(cached),
      forced: force,
      inputBytes: Buffer.byteLength(JSON.stringify(input), 'utf8'),
      transcriptTurns: input.transcriptTurns.length,
      notes: input.notes.length,
      owners: input.owners.length,
      entities: input.entities.length,
      voiceWriteOutcomes: input.voiceWriteOutcomes.length,
      needs: input.needs.length,
      selectedAnalyses: input.selectedAnalyses.map((item) => item.moduleId)
    };
  }
  const requested = cached
    ? { plan: cached.plan, metadata: cached.metadata || {}, reused: true }
    : { ...(await requestPlannerReconciliation({ env, config, input })), reused: false };
  const validation = await applyReconciliationPlan({
    profile: context.profile,
    notes,
    plan: requested.plan,
    transcriptTurns: input.transcriptTurns,
    sessionId: pointer.sessionId,
    transcriptWatermark: throughTurnId,
    baseProfileRevision: context.profile.revision,
    owners: input.owners,
    entities: input.entities
  });
  const traceId = traceIdForCall(SHADOW_RUN_ID, callId);
  const { traceLink } = traceLinkForCall(SHADOW_RUN_ID, callId, { traceId });
  const score = scoreReconciliationShadow({
    callId,
    plan: requested.plan,
    validation,
    reconciliationContext: input,
    expectations: frozenShadowExpectations.fixture
  });
  const operationCount = score.proposedOperationCount;
  const rejectedOperationCount = score.rejectedOperationCount;
  const output = {
    schemaVersion: 1,
    mode: 'shadow',
    runId: SHADOW_RUN_ID,
    callId,
    callerHash: frozenFixtureHashes.callerHash,
    answerKeyHash: frozenFixtureHashes.answerKeyHash,
    shadowExpectationsHash: frozenShadowExpectations.hash,
    promptVersion,
    baseProfileRevision: context.profile.revision,
    throughTurnId,
    reconciliationContext: input,
    inputDigest,
    plan: requested.plan,
    validation,
    operationOutcomes: validation.operationOutcomes,
    score,
    reusedFromArtifact: requested.reused,
    metadata: requested.metadata,
    traceId,
    traceLink,
    coverage: {
      proves: ['planner_path', 'profile_projection', 'requirements'],
      doesNotProve: ['live_save_facts', 'partitionSupportedLiveFacts', 'durable_object_ordering']
    }
  };
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });

  // The ignored local artifact above is authoritative and complete before
  // optional telemetry begins. Langfuse failure is therefore observational
  // only and cannot change this result, validation, or archive.
  const langfuse = requested.reused ? {
    enabled: false, delivered: 0, failures: 0, reused: true
  } : await exportReconciliationShadow({
    runId: SHADOW_RUN_ID,
    callId,
    traceId,
    checkpoint: throughTurnId,
    synthetic: true,
    contentPolicy: 'synthetic_test_content',
    finishedAt: new Date().toISOString(),
    input,
    output: { plan: requested.plan, validation },
    verdict: requested.plan.verdict,
    status: validation.status,
    operationCount,
    acceptedOperationCount: score.acceptedOperationCount,
    rejectedOperationCount,
    clarificationCount: score.clarificationCount,
    usage: requested.metadata
  });
  return {
    callId,
    outputPath,
    verdict: requested.plan.verdict,
    status: validation.status,
    acceptedGroups: validation.acceptedGroupIds.length,
    rejectedGroups: validation.rejectedGroups.length,
    operations: operationCount,
    reusedFromArtifact: requested.reused,
    unprojectedFacts: validation.unprojectedFactOperationIds?.length || 0,
    usage: requested.metadata,
    score,
    traceId,
    traceLink,
    langfuse: {
      enabled: langfuse.enabled,
      delivered: langfuse.delivered,
      failures: langfuse.failures
    }
  };
}

const { calls, dryRun, force } = argumentsFrom(process.argv.slice(2));
const frozenFixtureHashes = assertFrozenFixtureHashes();
const frozenShadowExpectations = loadFrozenShadowExpectations();
const results = [];
for (const callId of calls) results.push(await replay(callId, { dryRun, force }));
const summary = dryRun
  ? null
  : summarizeReconciliationShadowScores(results.map((result) => result.score));
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, results, summary }, null, 2)}\n`);
