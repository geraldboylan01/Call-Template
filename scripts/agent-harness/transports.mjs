/**
 * Dual-transport scenario harness.
 *
 * The agent environment exists to test the VOICE journey. That only works if
 * both transports are the same engine, so this module runs any scenario through
 * both and hands back comparable results:
 *
 *   A. AGENT   — processAgentTurn, the protected text transport.
 *   B. VOICE   — the Durable Object's internal turn sequence with audio removed
 *                but the meeting row, silent-planner tool attempt, planner
 *                ordinals, revisions, candidate application, plan telemetry and
 *                brief composition all preserved.
 *
 * Everything below the transport boundary is imported from the SAME shared
 * services both production paths use. Nothing here reimplements planning: if a
 * scenario behaves differently in A and B, that is a real divergence, not a
 * harness artefact.
 *
 * Real migrations, real encryption, real revisioned writes, no network.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConsumerConfig } from '../../worker/src/consumer/config.js';
import { createConsumerCredential } from '../../worker/src/consumer/crypto.js';
import { ConsumerError } from '../../worker/src/consumer/errors.js';
import {
  createSessionRecord, getCurrentProfile, getLatestAnalysis, getSessionRow
} from '../../worker/src/consumer/repository.js';
import { describeConversationState } from '../../worker/src/consumer/conversation.js';
import { createAgentMeeting } from '../../worker/src/consumer/agent_repository.js';
import { buildPlanningContext } from '../../worker/src/consumer/planning_context.js';
import {
  applyPlannerCandidates,
  composeAndPersistBrief,
  recordPlanEvaluation
} from '../../worker/src/consumer/planning_turn.js';
import {
  deterministicFallbackExtraction,
  mapPlannerExtractionToCandidates
} from '../../worker/src/consumer/planning_facts.js';
import {
  beginRealtimeToolAttempt,
  completeRealtimeToolAttempt,
  getLatestRealtimeMeetingBrief,
  listRealtimeFinalTurns,
  listRecentRealtimeFinalTurns,
  recordRealtimeFinalTurn
} from '../../worker/src/consumer/realtime_repository.js';
import { runPlannerReconciliation } from '../../worker/src/consumer/planner_reconciliation.js';
import {
  confirmAgentPlan,
  loadAgentContext,
  processAgentTurn,
  toAgentConsumerView,
  toAgentDiagnosticView
} from '../../worker/src/consumer/agent_session.js';
import {
  archiveCandidates,
  cloneForArchive,
  observedCanonicalFacts,
  observedDeterministicNeeds,
  observedNeeds,
  observedQuestion,
  usageDelta,
  usageSnapshot
} from './observability.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

/* ------------------------------------------------------------------ */
/* SQLite-backed D1                                                     */
/* ------------------------------------------------------------------ */

const PYTHON_SQLITE = String.raw`
import json
import sqlite3
import sys

database_path, mode = sys.argv[1], sys.argv[2]
payload = json.load(sys.stdin)
connection = sqlite3.connect(database_path)
connection.row_factory = sqlite3.Row
connection.execute('PRAGMA foreign_keys = ON')
try:
    if mode == 'script':
        connection.executescript(payload['sql'])
        connection.commit()
        result = {}
    elif mode == 'batch':
        connection.execute('BEGIN IMMEDIATE')
        result = []
        for item in payload['statements']:
            cursor = connection.execute(item['sql'], item['values'])
            result.append({'meta': {'changes': max(0, cursor.rowcount)}})
        connection.commit()
    else:
        cursor = connection.execute(payload['sql'], payload.get('values', []))
        if mode == 'first':
            row = cursor.fetchone()
            result = dict(row) if row is not None else None
        elif mode == 'all':
            result = {'results': [dict(row) for row in cursor.fetchall()]}
        elif mode == 'run':
            result = {'meta': {'changes': max(0, cursor.rowcount)}}
        else:
            raise ValueError('Unsupported sqlite test mode')
        connection.commit()
    print(json.dumps(result, separators=(',', ':')))
except Exception:
    connection.rollback()
    raise
finally:
    connection.close()
`;

function sqliteCommand(databasePath, mode, payload) {
  const result = spawnSync('python3', ['-c', PYTHON_SQLITE, databasePath, mode], {
    input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(result.stderr || 'sqlite command failed');
  return JSON.parse(result.stdout || 'null');
}

class TestD1Statement {
  constructor(databasePath, sql, values = []) {
    this.databasePath = databasePath; this.sql = sql; this.values = values;
  }
  bind(...values) { return new TestD1Statement(this.databasePath, this.sql, values); }
  async first() { return sqliteCommand(this.databasePath, 'first', { sql: this.sql, values: this.values }); }
  async all() { return sqliteCommand(this.databasePath, 'all', { sql: this.sql, values: this.values }); }
  async run() { return sqliteCommand(this.databasePath, 'run', { sql: this.sql, values: this.values }); }
}
class TestD1 {
  constructor(databasePath) { this.databasePath = databasePath; }
  prepare(sql) { return new TestD1Statement(this.databasePath, sql); }
  async batch(statements) {
    return sqliteCommand(this.databasePath, 'batch', {
      statements: statements.map((s) => ({ sql: s.sql, values: s.values }))
    });
  }
}

const MIGRATION_FILES = [
  '0001_create_consumer_journey', '0002_add_consumer_provider_budget',
  '0003_add_consumer_voice_consent', '0004_add_consumer_voice_dispatch_and_events',
  '0005_add_consumer_realtime_voice', '0006_encrypt_realtime_plan_display',
  '0007_add_realtime_control_inbox', '0008_widen_realtime_session_envelope',
  '0009_add_realtime_consent_purposes', '0010_add_realtime_activation_recovery',
  '0011_add_realtime_meeting_briefs', '0012_add_realtime_planner_usage',
  '0013_complete_realtime_voice_meetings', '0014_add_agent_test_meetings',
  '0015_add_privacy_notice_acknowledgement',
  '0016_add_planning_reconciliation'
];
const MIGRATIONS = MIGRATION_FILES
  .map((name) => readFileSync(`${root}/worker/consumer-migrations/${name}.sql`, 'utf8'))
  .join('\n');
const RECONCILIATION_MIGRATION = readFileSync(
  `${root}/worker/consumer-migrations/0016_add_planning_reconciliation.sql`,
  'utf8'
);

const workspace = mkdtempSync(join(tmpdir(), 'agent-harness-'));
process.once('exit', () => rmSync(workspace, { recursive: true, force: true }));
let databaseCounter = 0;

/** The production adviser-canary release allowlist, read from the real config. */
export const RELEASED_MODULE_IDS = (readFileSync(`${root}/worker/wrangler.toml`, 'utf8')
  .match(/^CONSUMER_ALLOWED_MODULE_IDS = "([^"]*)"$/m) || [])[1];

export function makeEnv(databasePath, overrides = {}) {
  return {
    CONSUMER_DB: new TestD1(databasePath),
    // The background planner's mode follows the environment, so an automated
    // run exercises the same lane a live meeting would. Fail-closed to legacy,
    // exactly as the Worker does, so CI never starts making reconciler calls.
    CONSUMER_PLANNER_RECONCILIATION_MODE:
      process.env.CONSUMER_PLANNER_RECONCILIATION_MODE || 'legacy',
    CONSUMER_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 31).toString('base64url'),
    CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url'),
    CONSUMER_JOURNEY_ENABLED: 'true',
    CONSUMER_MODULE_ROUTING_ENABLED: 'true',
    CONSUMER_GOAL_ROUTING_ENABLED: 'true',
    CONSUMER_AGENT_TEST_ENABLED: 'true',
    CONSUMER_ALLOWED_MODULE_IDS: RELEASED_MODULE_IDS,
    CONSUMER_MODULE_OFFERS_ENABLED: 'true',
    CONSUMER_COHORT: 'automated_test',
    CONSUMER_CONSENT_POLICY_VERSION: 'consumer-test-v1',
    CONSUMER_CONSENT_MANIFEST_ID: 'consumer-test-manifest-v1',
    CONSUMER_ANALYSIS_NOTICE_ID: 'analysis-test-v1',
    CONSUMER_AI_NOTICE_ID: 'ai-test-v1',
    CONSUMER_PRIVACY_NOTICE_URL: 'https://planeir.ie/plan/privacy.html',
    CONSUMER_SESSION_TTL_DAYS: '7',
    CONSUMER_AGENT_TEST_MAX_TURNS: '40',
    ...overrides
  };
}

/**
 * A database that SURVIVES THE PROCESS.
 *
 * newDatabase() puts its file in a per-process temp workspace, which is right
 * for a test run. It is useless for a call driven one turn at a time from a
 * shell, where every turn is a separate node process and the session has to
 * still be there when the next one starts.
 */
export function openCallDatabase(databasePath) {
  if (!existsSync(databasePath)) {
    mkdirSync(dirname(databasePath), { recursive: true });
    sqliteCommand(databasePath, 'script', { sql: `PRAGMA foreign_keys = ON;\n${MIGRATIONS}` });
  }
  return databasePath;
}

/**
 * Read an archived pre-0016 call through a disposable migrated clone.
 *
 * Frozen call databases are evidence artifacts. Applying an ALTER TABLE to the
 * source merely to inspect them would invalidate the baseline, so the shadow
 * runner gets an isolated workspace copy and only the additive reconciliation
 * migration is applied there. The source path is never opened for writing.
 */
export function cloneCallDatabaseForReconciliation(sourceDatabasePath, label = 'shadow') {
  if (!existsSync(sourceDatabasePath)) {
    throw new Error(`Archived call database does not exist: ${sourceDatabasePath}`);
  }
  databaseCounter += 1;
  const safeLabel = String(label || 'shadow').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  const clonePath = join(workspace, `${safeLabel}-${databaseCounter}.sqlite`);
  copyFileSync(sourceDatabasePath, clonePath);
  const columns = sqliteCommand(clonePath, 'all', {
    sql: 'PRAGMA table_info(consumer_realtime_final_turns)',
    values: []
  }).results || [];
  if (!columns.some((column) => column.name === 'meeting_sequence')) {
    sqliteCommand(clonePath, 'script', {
      sql: `PRAGMA foreign_keys = ON;\n${RECONCILIATION_MIGRATION}`
    });
  }
  return clonePath;
}

export function newDatabase(label) {
  databaseCounter += 1;
  const databasePath = join(workspace, `${label}-${databaseCounter}.sqlite`);
  sqliteCommand(databasePath, 'script', { sql: `PRAGMA foreign_keys = ON;\n${MIGRATIONS}` });
  return databasePath;
}

export function makeConfig(env) {
  return Object.freeze({
    ...getConsumerConfig(env),
    realtimeConversationV2Enabled: true,
    realtimeSpokenCompletionEnabled: false,
    realtimeMaxToolCalls: 24,
    agentTestEnabled: true
  });
}

export async function newSession(env, config) {
  const credential = await createConsumerCredential('');
  await createSessionRecord(env, credential, {
    analysis: true, aiProcessing: false, adultConfirmed: true, educationOnlyAcknowledged: true,
    manifestId: config.consentManifestId, policyVersion: config.consentPolicyVersion,
    analysisNoticeId: config.analysisNoticeId, aiNoticeId: config.aiNoticeId,
    privacyNoticeUrl: config.privacyNoticeUrl
  }, config, null);
  const meeting = await createAgentMeeting(env, { sessionId: credential.id, config });
  return { sessionId: credential.id, meetingId: meeting.id };
}

/* ------------------------------------------------------------------ */
/* Comparable per-turn result                                           */
/* ------------------------------------------------------------------ */

/**
 * The fields a scenario asserts on, and the fields the two transports must
 * agree about. Deliberately excludes assistant prose: wording comes from two
 * different model calls and is never expected to match.
 */
function comparableTurn({ transcript, diagnostics, plannerErrorCode, degraded, outcomes }) {
  return {
    transcript,
    plannerErrorCode: plannerErrorCode ?? null,
    degraded: degraded === true,
    acceptedFactIds: (outcomes || []).filter((o) => o.accepted).map((o) => o.factId).sort(),
    rejectedFactIds: (outcomes || []).filter((o) => !o.accepted).map((o) => o.factId).sort(),
    goals: [...(diagnostics.goals?.active || [])].sort(),
    primaryGoal: diagnostics.goals?.primary ?? null,
    deferredGoals: [...(diagnostics.goals?.deferred || [])].sort(),
    priorityQuestionRequired: diagnostics.goals?.priorityQuestionRequired === true,
    factIds: (diagnostics.facts || []).map((f) => f.factId).sort(),
    analyses: (diagnostics.analyses || []).map((a) => a.moduleId),
    // A blocked analysis stays on the plan instead of vanishing, so staying
    // selected and being runnable have to be observable separately.
    analysisAvailability: Object.fromEntries((diagnostics.analyses || [])
      .filter((a) => a.moduleId)
      .map((a) => [a.moduleId, a.availability ?? a.intakeStatus ?? null])),
    stillNeededFactIds: (diagnostics.stillNeeded || []).map((f) => f.factId),
    questionFactId: diagnostics.pendingQuestion?.factId ?? null,
    offerModuleId: diagnostics.activeOffer?.moduleId ?? null,
    capacityCandidateModuleId: diagnostics.activeCapacityDecision?.candidateModuleId ?? null,
    capacityAtLimit: diagnostics.capacity?.atLimit === true,
    accepted: [...(diagnostics.planningDecisions?.accepted || [])].sort(),
    declined: [...(diagnostics.planningDecisions?.declined || [])].sort(),
    deferred: [...(diagnostics.planningDecisions?.deferred || [])].sort(),
    confirmed: [...(diagnostics.planningDecisions?.confirmed || [])].sort()
  };
}

/* ------------------------------------------------------------------ */
/* A. Agent transport                                                   */
/* ------------------------------------------------------------------ */

/**
 * @param {object} scenario
 * @param {object} options
 * @param {object} options.client
 * @param {boolean} [options.renderWithModel] use the REAL assistant renderer
 *   instead of the deterministic stand-in.
 *
 *   The stand-in returns the server-owned question verbatim, which is exactly
 *   right for parity testing: what is under test there is planning, and prose
 *   comes from two different model calls that are never expected to match.
 *
 *   It is exactly WRONG for judging a call. Grading tone or momentum on a raw
 *   question prompt grades something no client would ever hear. So a review run
 *   turns this on and pays for the real renderer, which is the same
 *   `renderAssistantText` the live transport uses, driven by the same shared
 *   instruction pack.
 */
export async function runAgentScenario(
  scenario,
  { client, envOverrides = {}, renderWithModel = false, confirmAndRun = false } = {}
) {
  const databasePath = newDatabase(`agent-${scenario.id}`);
  const env = makeEnv(databasePath, envOverrides);
  const config = makeConfig(env);
  const { sessionId, meetingId } = await newSession(env, config);
  const turns = [];
  const turnRecords = [];
  const transcript = [];
  let previousSpendMicroEur = 0;

  for (let index = 0; index < scenario.turns.length; index += 1) {
    const beforeUsage = usageSnapshot(client.usage || {});
    const say = await client.nextMessage({ scenario, transcript, turnIndex: index, turnsSoFar: turnRecords });
    if (!say) break;
    const beforeContext = await loadAgentContext(env, config, sessionId, meetingId);
    let rawExtraction = null;
    const result = await processAgentTurn(env, config, {
      sessionId, meetingId, message: say,
      deps: {
        extractTurn: async ({ sourceTurnId, transcript: text, context }) => {
          rawExtraction = await client.extractionFor({
            scenario, turnIndex: index, sourceTurnId, text, context
          });
          return { extraction: rawExtraction, metadata: { costMicroEur: 0 } };
        },
        // Deterministic stand-in for the renderer: the server-owned question.
        // What is under test is planning, not prose. A review run passes
        // renderWithModel and gets the real thing.
        ...(renderWithModel ? {} : {
          renderText: async ({ context }) => ({
            text: context.state.meetingBrief?.questionBatch?.prompt || '(no question)',
            fallback: false, decisions: [], usageMicroEur: 0, context
          })
        })
      }
    });
    let afterContext = await loadAgentContext(env, config, sessionId, meetingId);
    // THE BACKGROUND PLANNER RUNS HERE TOO. In a live meeting the Durable
    // Object fires it once the turn settles; nothing fired it in the agent
    // harness, so the transport used to test the system did not exercise the
    // half of it currently under development. Same cadence as live_session: a
    // turn that wrote or rejected a note, plus a periodic checkpoint.
    let reconciliation = null;
    if (config.plannerReconciliationMode !== 'legacy') {
      const noteActivity = (result.diagnostics?.candidateOutcomes || []).length > 0;
      if (noteActivity || (index + 1) % 3 === 0) {
        try {
          const outcome = await runPlannerReconciliation({
            env,
            config,
            context: afterContext,
            leaseId: meetingId,
            throughTurnId: result.consumer.turnId,
            trigger: noteActivity ? 'material_turn' : 'periodic_checkpoint',
            loadContext: () => loadAgentContext(env, config, sessionId, meetingId)
          });
          reconciliation = {
            status: outcome.status,
            appliedProfileRevision: outcome.appliedProfileRevision ?? null,
            acceptedOperationIds: outcome.validation?.acceptedOperationIds || [],
            rejectedGroups: (outcome.validation?.rejectedGroups || [])
              .map((group) => ({ groupId: group.groupId, code: group.code })),
            clarificationNeeds: (outcome.validation?.clarificationNeeds || [])
              .map((need) => ({ factInstanceId: need.factInstanceId, prompt: need.prompt }))
          };
        } catch (error) {
          reconciliation = {
            status: 'failed',
            errorCode: String(error?.code || 'planner_reconciliation_failed'),
            errorDetail: String(error?.message || '').slice(0, 400)
          };
        }
        afterContext = await loadAgentContext(env, config, sessionId, meetingId);
      }
    }
    const storedTurns = await listRealtimeFinalTurns(env, sessionId, meetingId, 200);
    const clientRowIndex = storedTurns.findIndex((item) => item.id === result.consumer.turnId);
    const assistantRow = storedTurns.slice(Math.max(0, clientRowIndex + 1))
      .find((item) => item.role === 'assistant');
    const clientTranscript = {
      id: result.consumer.turnId,
      role: 'client',
      text: say,
      createdAt: storedTurns[clientRowIndex]?.createdAt || null
    };
    const assistantTranscript = {
      id: assistantRow?.id || null,
      role: 'assistant',
      text: result.consumer.assistantMessage,
      createdAt: assistantRow?.createdAt || null
    };
    transcript.push(clientTranscript);
    transcript.push(assistantTranscript);
    let mappedCandidates = [];
    if (rawExtraction) {
      try {
        mappedCandidates = mapPlannerExtractionToCandidates(rawExtraction);
      } catch (_error) {
        // The raw extraction is still archived. Candidate mapping failure is
        // represented by the turn's planner/rejection diagnostics.
      }
    }
    const candidateObservations = archiveCandidates({
      candidates: mappedCandidates,
      invalidCandidates: rawExtraction?.invalidCandidates || [],
      outcomes: result.diagnostics.candidateOutcomes || [],
      profile: afterContext.profile,
      askedQuestion: observedQuestion(beforeContext)
    });
    const question = observedQuestion(afterContext);
    const spendMicroEur = Number(result.usage?.spendMicroEur || 0);
    const turnRecord = comparableTurn({
      transcript: say,
      diagnostics: result.diagnostics,
      plannerErrorCode: result.diagnostics.plannerErrorCode,
      degraded: result.diagnostics.degraded,
      outcomes: result.diagnostics.candidateOutcomes
    });
    turns.push(turnRecord);
    turnRecords.push({
      ...turnRecord,
      // What the background planner did with this turn, so a failure can be
      // traced to the layer that caused it rather than inferred from the reply.
      reconciliation,
      clientTurnId: clientTranscript.id,
      assistantTurnId: assistantTranscript.id,
      questionFactInstanceId: question?.factInstanceId || null,
      acceptedFactInstanceIds: candidateObservations
        .filter((item) => item.accepted && item.factInstanceId)
        .map((item) => item.factInstanceId),
      rejectedFactInstances: candidateObservations
        .filter((item) => item.accepted === false)
        .map((item) => ({
          factId: item.factId,
          factInstanceId: item.factInstanceId,
          entityId: item.entityId,
          ownerId: item.ownerId,
          rejectionCode: item.rejectionCode
        })),
      observation: {
        schemaVersion: 'consumer-agent-turn-observation-v1',
        transcript: { client: clientTranscript, assistant: assistantTranscript },
        profiles: {
          beforeRevision: Number(beforeContext.sessionRow.current_profile_revision),
          before: cloneForArchive(beforeContext.profile),
          afterRevision: Number(afterContext.sessionRow.current_profile_revision),
          after: cloneForArchive(afterContext.profile)
        },
        extraction: {
          raw: cloneForArchive(rawExtraction),
          candidates: candidateObservations,
          plannerErrorCode: result.diagnostics.plannerErrorCode || null,
          degraded: result.diagnostics.degraded === true,
          repairedCount: Number(result.diagnostics.repairedCount || 0),
          repairAttemptFailed: result.diagnostics.repairAttemptFailed === true,
          segmentsFailed: Number(result.diagnostics.segmentsFailed || 0)
        },
        question,
        needsAfter: observedNeeds(afterContext),
      // Derived from the module adapters rather than from the persisted brief,
      // so "what changed after reconciliation" is answerable from one record.
      deterministicNeedsAfter: observedDeterministicNeeds(afterContext),
        canonicalFactsAfter: observedCanonicalFacts(afterContext),
        usage: usageDelta(beforeUsage, usageSnapshot(client.usage || {})),
        spendMicroEur: {
          turn: Math.max(0, spendMicroEur - previousSpendMicroEur),
          cumulative: spendMicroEur
        }
      }
    });
    previousSpendMicroEur = spendMicroEur;
  }
  // FINISH THE CALL. Until this ran, a persona call stopped at the last
  // question and no module ever executed -- so there was nothing to grade
  // except the conversation. Confirming drives the same path the live app
  // takes: confirmAgentPlan -> confirmAndRunRealtimeAnalysisPlan ->
  // runStoredConsumerAnalysis -> runConsumerAnalysis, which is the real module
  // JS in js/planning. The client's data reaches those modules as the PROFILE
  // the call built; there is no separate input-mapping step, because the
  // semantic-fact layer already is that mapping.
  let execution = null;
  if (confirmAndRun) {
    try {
      const confirmed = await confirmAgentPlan(env, config, { sessionId, meetingId });
      const sessionRow = await getSessionRow(env, sessionId);
      // Any status, not just complete. An analysis that could not run is the
      // most actionable result there is: it means the call promised something
      // it had not gathered enough to deliver, and the payload names exactly
      // what was still needed.
      const payload = (await getLatestAnalysis(env, sessionId, null)) || {};
      execution = {
        ...confirmed.execution,
        speakableText: confirmed.consumer?.assistantMessage || '',
        results: (payload.results || []).map((item) => ({
          moduleId: item.moduleId,
          status: item.status ?? 'complete',
          // The module's own output, kept whole: grading an analysis means
          // looking at what it actually produced, not at a summary of it.
          output: item
        })),
        missingForModules: confirmed.execution.requiredQuestions || [],
        profileRevision: Number(sessionRow?.current_profile_revision ?? 0),
        error: null
      };
    } catch (error) {
      // A call that cannot reach execution is a finding, not a crash: the
      // conversation still happened and is still worth reviewing.
      execution = {
        planId: null, status: 'failed', moduleIds: [], completedModuleIds: [], gatedModuleIds: [],
        results: [], missingForModules: [], error: error?.code || String(error?.message || error)
      };
    }
  }
  return {
    transport: 'agent', sessionId, meetingId, turns, turnRecords, transcript, execution, env, config
  };
}

/* ------------------------------------------------------------------ */
/* B. Voice-equivalent orchestration                                    */
/* ------------------------------------------------------------------ */

export async function runVoiceScenario(scenario, { client, envOverrides = {} } = {}) {
  const databasePath = newDatabase(`voice-${scenario.id}`);
  const env = makeEnv(databasePath, envOverrides);
  const config = makeConfig(env);
  const { sessionId, meetingId } = await newSession(env, config);
  const turns = [];
  const transcript = [];

  const loadContext = async () => {
    const sessionRow = await getSessionRow(env, sessionId);
    const profile = await getCurrentProfile(env, sessionRow);
    const stored = await getLatestRealtimeMeetingBrief(env, sessionId, meetingId);
    return buildPlanningContext({
      config, sessionRow, profile, pendingProposals: [],
      meetingPhase: stored?.brief?.phase || null,
      latestMeetingBrief: stored?.brief || null,
      channel: 'voice'
    });
  };

  for (let index = 0; index < scenario.turns.length; index += 1) {
    const say = await client.nextMessage({ scenario, transcript, turnIndex: index, turnsSoFar: turns });
    if (!say) break;
    const turnRef = `voice_turn_${index + 1}`;

    // The DO records the finalized turn first, then plans from it.
    await recordRealtimeFinalTurn(env, {
      sessionId, leaseId: meetingId, providerItemId: turnRef, role: 'user', transcript: say
    });
    const recentTurns = await listRecentRealtimeFinalTurns(env, sessionId, meetingId, 8);
    let context = await loadContext();

    let extraction = null;
    let plannerErrorCode = null;
    let degraded = false;
    try {
      extraction = await client.extractionFor({
        scenario, turnIndex: index, sourceTurnId: turnRef, text: say, context
      });
    } catch (error) {
      plannerErrorCode = error instanceof ConsumerError ? error.code : 'planner_failed';
      extraction = deterministicFallbackExtraction({
        transcript: say, profile: context.profile, sourceTurnId: turnRef
      });
      degraded = Boolean(extraction);
    }

    let outcomes = [];
    if (extraction) {
      const attempt = await beginRealtimeToolAttempt(env, {
        sessionId, leaseId: meetingId,
        providerToolCallId: `planner_${turnRef}`,
        toolName: 'silent_planner',
        toolVersion: `${config.realtimePlannerPromptVersion}:1`,
        expectedProfileRevision: Number(context.sessionRow.current_profile_revision),
        arguments: { schemaVersion: extraction.schemaVersion, sourceTurnId: turnRef },
        maxToolCalls: config.realtimeMaxToolCalls
      });
      const before = context;
      const applied = await applyPlannerCandidates({
        env, config, context, extraction, transcript: say,
        evidenceRef: turnRef, leaseId: meetingId, toolAttemptId: attempt.row.id, loadContext
      });
      outcomes = applied.outcomes;
      context = applied.context;
      await completeRealtimeToolAttempt(env, {
        sessionId, leaseId: meetingId, toolAttemptId: attempt.row.id,
        status: 'succeeded',
        result: { ok: true, sourcedValueEvidence: applied.sourcedValueEvidence },
        errorCode: null,
        latencyMs: 0
      }).catch(() => {});
      await recordPlanEvaluation({
        env, sessionId, previousState: before.state, nextState: context.state
      });
    }

    context = await loadContext();
    await composeAndPersistBrief({
      env, context, extraction: extraction || {}, sourceTurnId: turnRef,
      leaseId: meetingId, spokenCompletionEnabled: false
    });
    const after = await loadContext();
    const assistantText = after.state.meetingBrief?.questionBatch?.prompt || '(no question)';
    await recordRealtimeFinalTurn(env, {
      sessionId, leaseId: meetingId, providerItemId: `${turnRef}_a`, role: 'assistant', transcript: assistantText
    }).catch(() => {});

    transcript.push({ role: 'client', text: say });
    transcript.push({ role: 'assistant', text: assistantText });
    turns.push(comparableTurn({
      transcript: say,
      diagnostics: toAgentDiagnosticView(after),
      plannerErrorCode, degraded, outcomes
    }));
    void toAgentConsumerView({ assistantText, context: after });
    void describeConversationState;
  }
  return { transport: 'voice', sessionId, meetingId, turns, transcript, env, config };
}

/**
 * Run one scenario through BOTH transports.
 *
 * The client is re-created per transport so a stateful (AI) client starts each
 * run from the same place and both transports see the same conversation.
 */
export async function runBothTransports(scenario, { makeClient, envOverrides = {} } = {}) {
  const agent = await runAgentScenario(scenario, { client: makeClient(), envOverrides });
  const voice = await runVoiceScenario(scenario, { client: makeClient(), envOverrides });
  return { agent, voice };
}

export { comparableTurn };
