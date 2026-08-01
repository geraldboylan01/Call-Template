// Turn-by-turn parity diagnostic.
//
// Built for a specific live failure: two accurate transcripts, an assistant that
// kept talking, and a UI stuck at 0 understood / 0 focus areas. Speech
// recognition was fine and the degraded response worked; planning state simply
// never persisted.
//
// This runs the exact two-turn conversation through BOTH transports and
// captures all twenty diagnostic stages at each turn, so the exact stage where
// values disappear is visible rather than inferred:
//
//   A. SHARED AGENT TEXT PATH — the normal shared planning engine and
//      persistence layer, via processAgentTurn.
//   B. VOICE-EQUIVALENT ORCHESTRATION — the same internal turn-processing the
//      Durable Object performs, with audio removed but the meeting row, tool
//      attempts, planner ordinals, revisions and persistence preserved.
//
// If both fail at the same stage it is a shared-engine defect. If A succeeds and
// B fails it is voice orchestration or session state.
//
// Each transport is run twice: once with a HEALTHY planner (scripted extraction
// standing in for the AI call) and once with a DEAD planner, which is what the
// live meeting hit. The dead-planner run is the one that reproduces the
// incident.
//
// No network and no API key. Real migrations, real encryption, real revisioned
// writes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGoalModulePlan } from '../js/planning/index.js';
import { getConsumerConfig } from '../worker/src/consumer/config.js';
import { createConsumerCredential } from '../worker/src/consumer/crypto.js';
import { ConsumerError } from '../worker/src/consumer/errors.js';
import { createSessionRecord, getCurrentProfile, getSessionRow } from '../worker/src/consumer/repository.js';
import { describeConversationState } from '../worker/src/consumer/conversation.js';
import { createAgentMeeting } from '../worker/src/consumer/agent_repository.js';
import { buildPlanningContext } from '../worker/src/consumer/planning_context.js';
import {
  applyPlannerCandidates,
  composeAndPersistBrief,
  recordPlanEvaluation
} from '../worker/src/consumer/planning_turn.js';
import {
  deterministicFallbackExtraction,
  mapPlannerExtractionToCandidates
} from '../worker/src/consumer/planning_facts.js';
import {
  beginRealtimeToolAttempt,
  completeRealtimeToolAttempt,
  getLatestRealtimeMeetingBrief,
  listRecentRealtimeFinalTurns,
  recordRealtimeFinalTurn
} from '../worker/src/consumer/realtime_repository.js';
import { processAgentTurn, toAgentConsumerView, toAgentDiagnosticView } from '../worker/src/consumer/agent_session.js';

const root = fileURLToPath(new URL('..', import.meta.url));

/* ---------------------------------------------------------------- */
/* Database harness                                                   */
/* ---------------------------------------------------------------- */

const PYTHON_SQLITE = readFileSync(`${root}/scripts/check-consumer-agent-journey.mjs`, 'utf8')
  .split('const PYTHON_SQLITE = String.raw`')[1].split('`;')[0];

function sqliteCommand(databasePath, mode, payload) {
  const result = spawnSync('python3', ['-c', PYTHON_SQLITE, databasePath, mode], {
    input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(result.stderr || 'sqlite failed');
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

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'turn-parity-'));
process.once('exit', () => rmSync(temporaryDirectory, { recursive: true, force: true }));

const MIGRATIONS = [
  '0001_create_consumer_journey', '0002_add_consumer_provider_budget',
  '0003_add_consumer_voice_consent', '0004_add_consumer_voice_dispatch_and_events',
  '0005_add_consumer_realtime_voice', '0006_encrypt_realtime_plan_display',
  '0007_add_realtime_control_inbox', '0008_widen_realtime_session_envelope',
  '0009_add_realtime_consent_purposes', '0010_add_realtime_activation_recovery',
  '0011_add_realtime_meeting_briefs', '0012_add_realtime_planner_usage',
  '0013_complete_realtime_voice_meetings', '0014_add_agent_test_meetings'
].map((name) => readFileSync(`${root}/worker/consumer-migrations/${name}.sql`, 'utf8')).join('\n');

/* ---------------------------------------------------------------- */
/* The live conversation                                              */
/* ---------------------------------------------------------------- */

export const LIVE_TURNS = Object.freeze([
  "So I'm 32 and I'm after having a young kid, and I would like to just have an overall look at "
    + 'my financial picture and ensure that at one stage I can afford to send this kid to college.',
  'I want to get a broader picture of my current financial position and then look towards '
    + 'getting my kid into college.'
]);

/** What a correct AI planner returns for each turn. */
function scriptedExtraction(sourceTurnId, index) {
  const turns = [
    {
      goals: [
        { goalType: 'understand_position', priorityHint: 'unspecified' },
        { goalType: 'fund_education', priorityHint: 'unspecified' }
      ],
      facts: [
        { factId: 'person_current_age', value: { age: 32 } },
        { factId: 'household_structure', value: { value: 'family' } },
        { factId: 'dependant_count', value: { value: 1 } }
      ]
    },
    {
      goals: [
        { goalType: 'understand_position', priorityHint: 'unspecified' },
        { goalType: 'fund_education', priorityHint: 'unspecified' }
      ],
      facts: []
    }
  ][index];
  return {
    schemaVersion: 'PlannerExtractionV3',
    sourceTurnId,
    goalCandidates: turns.goals.map((goal, i) => ({
      candidateId: `goal-${i + 1}`, goalType: goal.goalType, confidence: 'high',
      priorityHint: goal.priorityHint, evidenceText: 'scripted evidence', correctionTarget: ''
    })),
    semanticFacts: turns.facts.map((fact, i) => ({
      candidateId: `fact-${i + 1}`, operation: 'upsert', factId: fact.factId,
      value: fact.value, certainty: 'exact', evidenceText: 'scripted evidence', correctionTarget: ''
    })),
    positions: [], sectionCompletions: [], invalidCandidates: [],
    clientQuestion: { present: false, intent: 'none', topic: '', questionText: '' },
    ambiguities: [], narrativeSummary: { summary: '', evidence: [] }
  };
}

/* ---------------------------------------------------------------- */
/* Environment                                                        */
/* ---------------------------------------------------------------- */

function makeEnv(databasePath) {
  return {
    CONSUMER_DB: new TestD1(databasePath),
    CONSUMER_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 31).toString('base64url'),
    CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url'),
    CONSUMER_JOURNEY_ENABLED: 'true',
    CONSUMER_MODULE_ROUTING_ENABLED: 'true',
    CONSUMER_GOAL_ROUTING_ENABLED: 'true',
    CONSUMER_AGENT_TEST_ENABLED: 'true',
    // The live adviser-canary allowlist, now the manifest-approved set.
    CONSUMER_ALLOWED_MODULE_IDS: 'college_funding,house_purchase,liquidity_analysis,loan_analysis,mortgage_analysis,pension_projection,personal_balance_sheet',
    CONSUMER_MODULE_OFFERS_ENABLED: 'false',
    CONSUMER_COHORT: 'adviser_test',
    CONSUMER_CONSENT_POLICY_VERSION: 'consumer-adviser-test-v1',
    CONSUMER_CONSENT_MANIFEST_ID: 'consumer-adviser-test-manifest-v1',
    CONSUMER_ANALYSIS_NOTICE_ID: 'analysis-adviser-test-v1',
    CONSUMER_AI_NOTICE_ID: 'ai-adviser-test-v1',
    CONSUMER_PRIVACY_NOTICE_URL: 'https://planeir.ie/plan/privacy.html',
    CONSUMER_SESSION_TTL_DAYS: '7',
    CONSUMER_AGENT_TEST_MAX_TURNS: '20'
  };
}

async function newSession(env, config) {
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

/* ---------------------------------------------------------------- */
/* Path B — voice-equivalent orchestration                            */
/* ---------------------------------------------------------------- */

/**
 * The Durable Object's turn sequence with audio removed. Everything else is
 * preserved: the meeting row, the finalized-turn record, the silent-planner
 * tool attempt, planner ordinals, optimistic revisions, candidate application,
 * plan telemetry and brief composition.
 *
 * Captures all twenty diagnostic stages.
 */
async function voiceEquivalentTurn(env, config, { sessionId, meetingId, transcript, turnOrdinal, planner }) {
  const stage = { turnOrdinal, transcript };

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

  // 1 raw final transcript
  const turnRef = `voice_turn_${turnOrdinal}`;
  await recordRealtimeFinalTurn(env, {
    sessionId, leaseId: meetingId, providerItemId: turnRef, role: 'user', transcript
  });
  const recentTurns = await listRecentRealtimeFinalTurns(env, sessionId, meetingId, 8);
  let context = await loadContext();
  stage.expectedRevision = Number(context.sessionRow.current_profile_revision); // 12

  // 2-5 planner, then deterministic fallback exactly as the DO orders them
  let extraction = null;
  stage.normalExtractionSucceeded = false;
  stage.fallbackRan = false;
  try {
    extraction = await planner({ sourceTurnId: turnRef, transcript, context, recentTurns });
    stage.normalExtractionSucceeded = true;
    stage.plannerResult = 'ok';
  } catch (error) {
    stage.plannerResult = error?.code || 'planner_failed';
    stage.fallbackRan = true;
    extraction = deterministicFallbackExtraction({
      transcript, profile: context.profile, sourceTurnId: turnRef
    });
    stage.fallbackExtraction = extraction
      ? { goals: extraction.goalCandidates.map((g) => g.goalType), facts: extraction.semanticFacts.map((f) => f.factId) }
      : null;
  }
  if (!extraction) {
    stage.outcome = 'no_extraction';
    return stage;
  }

  // 6-7 candidates
  stage.goalCandidates = extraction.goalCandidates.map((g) => g.goalType);
  stage.factCandidates = extraction.semanticFacts.map((f) => f.factId);
  stage.mappedCandidates = mapPlannerExtractionToCandidates(extraction).map((c) => c.factId);

  // 14-15 persistence: the silent-planner tool attempt, then candidates
  const before = context;
  let attempt = null;
  try {
    attempt = await beginRealtimeToolAttempt(env, {
      sessionId, leaseId: meetingId,
      providerToolCallId: `planner_${turnRef}`,
      toolName: 'silent_planner',
      toolVersion: `${config.realtimePlannerPromptVersion}:1`,
      expectedProfileRevision: Number(context.sessionRow.current_profile_revision),
      arguments: { schemaVersion: extraction.schemaVersion, sourceTurnId: turnRef },
      maxToolCalls: config.realtimeMaxToolCalls
    });
    stage.toolAttempt = attempt.row?.id ? 'created' : 'missing';
  } catch (error) {
    stage.toolAttempt = `FAILED: ${error?.code || error?.message}`;
    stage.outcome = 'tool_attempt_failed';
    return stage;
  }

  let applied;
  try {
    applied = await applyPlannerCandidates({
      env, config, context, extraction,
      evidenceRef: turnRef, leaseId: meetingId, toolAttemptId: attempt.row.id, loadContext
    });
  } catch (error) {
    stage.outcome = 'apply_threw';
    stage.applyError = error?.code || error?.message;
    return stage;
  }
  // 10 accepted / rejected with categorical reasons
  stage.outcomes = applied.outcomes.map((o) => ({
    factId: o.factId, accepted: o.accepted, code: o.errorCode || null
  }));
  context = applied.context;
  await completeRealtimeToolAttempt(env, {
    sessionId, leaseId: meetingId, toolAttemptId: attempt.row.id,
    status: 'succeeded', result: { ok: true }, errorCode: null, latencyMs: 0
  }).catch(() => {});

  await recordPlanEvaluation({
    env, sessionId, previousState: before.state, nextState: context.state
  });

  // 13 actual revision, 16 profile after persistence
  const afterRow = await getSessionRow(env, sessionId);
  const afterProfile = await getCurrentProfile(env, afterRow);
  stage.actualRevision = Number(afterRow.current_profile_revision);
  stage.persistedGoals = afterProfile.goals.map((g) => g.type);
  stage.persistedAge = afterProfile.primaryPerson?.age ?? null;
  stage.primaryGoalFocus = afterProfile.assumptions?.values?.planning?.primaryGoalType ?? null; // 11
  stage.projectedPersona = { ...(afterProfile.assumptions?.values?.persona || {}) }; // 8

  // 17 describeConversationState
  const conversationState = describeConversationState(afterProfile, config);
  stage.stateModuleSlots = conversationState.moduleSlots.map((s) => s.moduleId);
  stage.stateNextQuestion = conversationState.nextQuestion?.factId ?? null;
  stage.planModuleSlots = buildGoalModulePlan(afterProfile, { allowedModuleIds: config.allowedModules })
    .moduleSlots.map((s) => s.moduleId);

  // 18 composeMeetingBrief
  context = await loadContext();
  const composed = await composeAndPersistBrief({
    env, context, extraction, sourceTurnId: turnRef, leaseId: meetingId, spokenCompletionEnabled: false
  });
  stage.briefAnalyses = composed.brief?.analyses.map((a) => a.moduleId) ?? [];
  stage.briefUnderstood = composed.brief?.understood.length ?? 0;
  stage.briefQuestion = composed.brief?.questionBatch?.prompt ?? null;
  stage.briefQuestionFactId = composed.brief?.questionBatch?.primaryFact?.factId ?? null; // 19

  // 20 UI-safe projection
  const finalContext = await loadContext();
  stage.uiProjection = toAgentDiagnosticView(finalContext);
  stage.consumerProjection = toAgentConsumerView({ assistantText: '(voice speaks)', context: finalContext });
  stage.outcome = 'applied';
  return stage;
}

/* ---------------------------------------------------------------- */
/* Runners                                                            */
/* ---------------------------------------------------------------- */

const HEALTHY_PLANNER = async ({ sourceTurnId, transcript }) => {
  const index = LIVE_TURNS.indexOf(transcript);
  return scriptedExtraction(sourceTurnId, index >= 0 ? index : 0);
};
const DEAD_PLANNER = async () => {
  throw new ConsumerError(502, 'realtime_planner_request_failed', 'simulated provider outage');
};

async function runVoicePath(label, planner) {
  const databasePath = join(temporaryDirectory, `voice-${label}.sqlite`);
  sqliteCommand(databasePath, 'script', { sql: `PRAGMA foreign_keys = ON;\n${MIGRATIONS}` });
  const env = makeEnv(databasePath);
  const config = Object.freeze({
    ...getConsumerConfig(env), realtimeConversationV2Enabled: true,
    realtimeSpokenCompletionEnabled: false, realtimeMaxToolCalls: 24, agentTestEnabled: true
  });
  const { sessionId, meetingId } = await newSession(env, config);
  const stages = [];
  for (const [index, transcript] of LIVE_TURNS.entries()) {
    stages.push(await voiceEquivalentTurn(env, config, {
      sessionId, meetingId, transcript, turnOrdinal: index + 1, planner
    }));
  }
  return stages;
}

async function runAgentPath(label, planner) {
  const databasePath = join(temporaryDirectory, `agent-${label}.sqlite`);
  sqliteCommand(databasePath, 'script', { sql: `PRAGMA foreign_keys = ON;\n${MIGRATIONS}` });
  const env = makeEnv(databasePath);
  const config = Object.freeze({
    ...getConsumerConfig(env), realtimeConversationV2Enabled: true,
    realtimeSpokenCompletionEnabled: false, realtimeMaxToolCalls: 24, agentTestEnabled: true
  });
  const { sessionId, meetingId } = await newSession(env, config);
  const stages = [];
  for (const [index, transcript] of LIVE_TURNS.entries()) {
    const result = await processAgentTurn(env, config, {
      sessionId, meetingId, message: transcript,
      deps: {
        extractTurn: async ({ sourceTurnId, transcript: text, context }) => ({
          extraction: await planner({ sourceTurnId, transcript: text, context }),
          metadata: { costMicroEur: 0 }
        }),
        renderText: async ({ context }) => ({
          text: context.state.meetingBrief?.questionBatch?.prompt || '(no question)',
          fallback: false, decisions: [], usageMicroEur: 0, context
        })
      }
    });
    stages.push({
      turnOrdinal: index + 1,
      transcript,
      plannerErrorCode: result.diagnostics.plannerErrorCode,
      outcomes: result.diagnostics.candidateOutcomes.map((o) => ({
        factId: o.factId, accepted: o.accepted, code: o.errorCode || null
      })),
      actualRevision: result.consumer.revision,
      persistedGoals: result.diagnostics.goals.active,
      primaryGoalFocus: result.diagnostics.goals.primary,
      understoodCount: result.diagnostics.facts.length,
      stateModuleSlots: result.diagnostics.analyses.map((a) => a.moduleId),
      briefQuestion: result.diagnostics.pendingQuestion?.prompt ?? null,
      briefQuestionFactId: result.diagnostics.pendingQuestion?.factId ?? null,
      uiProjection: result.diagnostics,
      consumerProjection: result.consumer
    });
  }
  return stages;
}

/* ---------------------------------------------------------------- */
/* Report and assertions                                              */
/* ---------------------------------------------------------------- */

function report(label, stages) {
  console.info(`\n===== ${label} =====`);
  for (const stage of stages) {
    console.info(`  TURN ${stage.turnOrdinal}: "${String(stage.transcript).slice(0, 56)}..."`);
    if (stage.plannerResult) console.info(`    planner            : ${stage.plannerResult}`);
    if (stage.plannerErrorCode !== undefined) console.info(`    plannerErrorCode   : ${stage.plannerErrorCode ?? 'none'}`);
    if (stage.fallbackRan !== undefined) console.info(`    fallbackRan        : ${stage.fallbackRan}`);
    if (stage.fallbackExtraction !== undefined) {
      console.info(`    fallbackExtraction : ${JSON.stringify(stage.fallbackExtraction)}`);
    }
    if (stage.toolAttempt) console.info(`    toolAttempt        : ${stage.toolAttempt}`);
    if (stage.outcomes) {
      console.info(`    candidates         : ${stage.outcomes.map((o) => `${o.accepted ? '+' : '-'}${o.factId}${o.code ? `(${o.code})` : ''}`).join(' ')}`);
    }
    if (stage.expectedRevision !== undefined) {
      console.info(`    revision           : expected ${stage.expectedRevision} -> actual ${stage.actualRevision}`);
    }
    console.info(`    persistedGoals     : ${JSON.stringify(stage.persistedGoals ?? [])}`);
    if (stage.persistedAge !== undefined) console.info(`    persistedAge       : ${stage.persistedAge}`);
    console.info(`    primaryGoalFocus   : ${stage.primaryGoalFocus ?? 'none'}`);
    console.info(`    moduleSlots        : ${JSON.stringify(stage.stateModuleSlots ?? [])}`);
    if (stage.planModuleSlots) console.info(`    planModuleSlots    : ${JSON.stringify(stage.planModuleSlots)}`);
    console.info(`    briefQuestion      : ${stage.briefQuestionFactId ?? 'none'} | ${JSON.stringify(String(stage.briefQuestion ?? '').slice(0, 60))}`);
    const understood = stage.understoodCount ?? stage.briefUnderstood ?? (stage.uiProjection?.facts?.length ?? 0);
    console.info(`    UI understood      : ${understood}`);
    console.info(`    UI focus areas     : ${(stage.uiProjection?.analyses ?? []).length}`);
    if (stage.outcome && stage.outcome !== 'applied') console.info(`    *** OUTCOME        : ${stage.outcome} ${stage.applyError || ''}`);
  }
}

const passes = [];
function pass(message) {
  passes.push(message);
  console.info(`[TurnParity] PASS: ${message}`);
}

const runs = {
  'AGENT / healthy planner': await runAgentPath('healthy', HEALTHY_PLANNER),
  'VOICE / healthy planner': await runVoicePath('healthy', HEALTHY_PLANNER),
  'AGENT / dead planner': await runAgentPath('dead', DEAD_PLANNER),
  'VOICE / dead planner': await runVoicePath('dead', DEAD_PLANNER)
};
for (const [label, stages] of Object.entries(runs)) report(label, stages);

console.info('\n');

/* ---- The invariant this fixture exists to enforce ---------------- */

//  THE FINDING THIS FIXTURE PRODUCED.
//
//  The goals DO persist. What is empty is the analysis set, because the live
//  adviser canary allows only house_purchase and liquidity_analysis, and this
//  client's goals route elsewhere:
//
//      understand_position -> personal_balance_sheet   (not allowed)
//      fund_education      -> college_funding          (not allowed)
//
//  buildGoalModulePlan filters both out, so moduleSlots is empty and the UI
//  shows "0 focus areas" and "Nothing else is currently required". That is
//  correct behaviour for the allowlist, not a persistence failure.
//
//  The real defect is that the meeting must SAY so. describeConversationState
//  already produces exactly the right line for this case ("I've noted that
//  goal, but it does not yet have a consumer analysis in this version"), and
//  the brief must carry it so the model cannot improvise an intake question
//  about facts nobody asked for and nothing was saved against.

for (const [label, stages] of Object.entries(runs)) {
  const last = stages.at(-1);

  // 1. State is durably persisted.
  assert.ok(
    (last.persistedGoals || []).length > 0,
    `${label}: the conversation must leave at least one persisted goal, got none. `
      + 'The live failure was an assistant that kept talking while nothing was saved.'
  );

  // 2. The UI-safe projection matches persisted state EXACTLY. This is what
  //    makes "0 understood" impossible while goals exist.
  assert.deepEqual(
    [...(last.uiProjection?.goals?.active ?? [])].sort(),
    [...(last.persistedGoals ?? [])].sort(),
    `${label}: the UI-safe projection must match persisted state exactly`
  );

  // 3. A response is never based on state that was not saved: the meeting
  //    always has a SERVER-OWNED next question. Without this the model
  //    improvises, which is how the live meeting asked for household income
  //    while nothing at all had been persisted.
  assert.ok(
    last.briefQuestionFactId,
    `${label}: the brief must carry a server-owned question so the model cannot improvise one`
  );

  // 4. This client's goals must now reach real analyses. Before the release
  //    allowlist was widened to the manifest-approved set, understand_position
  //    and fund_education routed to personal_balance_sheet and college_funding
  //    -- neither of which was released -- so the meeting showed zero focus
  //    areas however well extraction worked.
  assert.ok(
    (last.stateModuleSlots || []).length > 0,
    `${label}: this client's goals must reach at least one released analysis, got none`
  );
  assert.equal(
    (last.uiProjection?.analyses ?? []).length,
    (last.stateModuleSlots || []).length,
    `${label}: the UI focus areas must match the selected analyses`
  );
}
pass('every transport persists goals, projects them faithfully, and asks a server-owned question');

{
  // The expected extraction for this client.
  for (const [label, stages] of Object.entries(runs)) {
    const goals = stages.at(-1).persistedGoals || [];
    assert.ok(
      goals.includes('fund_education'),
      `${label}: the college-funding goal must persist, got ${JSON.stringify(goals)}`
    );
  }
  for (const label of ['AGENT / healthy planner', 'VOICE / healthy planner']) {
    const goals = runs[label].at(-1).persistedGoals || [];
    assert.ok(goals.includes('understand_position'), `${label}: the broad financial-position goal must persist`);
  }
  assert.equal(runs['VOICE / healthy planner'].at(-1).persistedAge, 32, 'the stated age must persist');
  pass('the college-funding goal persists on every path; the broad review and age persist with a healthy planner');
}

{
  // PARITY. Agent and voice must reach the same state, healthy AND degraded.
  // The degraded pair is the one that caught the real divergence: the
  // deterministic fallback was wired into voice only, so the agent path
  // persisted nothing while voice persisted fund_education and the age.
  for (const [agentLabel, voiceLabel] of [
    ['AGENT / healthy planner', 'VOICE / healthy planner'],
    ['AGENT / dead planner', 'VOICE / dead planner']
  ]) {
    const agent = runs[agentLabel].at(-1);
    const voice = runs[voiceLabel].at(-1);
    assert.deepEqual(
      [...(agent.persistedGoals || [])].sort(),
      [...(voice.persistedGoals || [])].sort(),
      `${agentLabel} and ${voiceLabel} must persist the same goals`
    );
    assert.deepEqual(
      [...(agent.stateModuleSlots || [])].sort(),
      [...(voice.stateModuleSlots || [])].sort(),
      `${agentLabel} and ${voiceLabel} must select the same analyses`
    );
    assert.equal(
      agent.briefQuestionFactId,
      voice.briefQuestionFactId,
      `${agentLabel} and ${voiceLabel} must ask for the same fact`
    );
  }
  pass('the agent and voice-equivalent paths agree on goals, analyses and the next question');
}

{
  // A degraded turn must be visibly degraded, never presented as healthy.
  for (const label of ['AGENT / dead planner', 'VOICE / dead planner']) {
    const first = runs[label][0];
    assert.ok(
      first.fallbackRan === true || first.plannerErrorCode,
      `${label}: a planner outage must be reported, not hidden`
    );
  }
  pass('a planner outage is always reported as degraded rather than presented as a healthy turn');
}

console.info(`\n[TurnParity] ${passes.length} assertions passed.`);
