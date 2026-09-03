// End-to-end agent-test journey.
//
// This drives the REAL agent session service — createAgentTestSession,
// processAgentTurn, resolveAgentOffer, resolveAgentCapacity, confirmAgentPlan,
// getAgentSessionState, exportAgentSession, deleteAgentTestSession — against a
// real SQLite-backed D1 with the real consumer migrations, real encryption and
// real revisioned profile writes.
//
// Only the two model calls are stubbed: the silent planner returns a scripted
// extraction, and the renderer returns the deterministic server question. That
// is the point — what is under test is the planning journey, not the model.
//
// It is the D-02 acceptance test: the full offer and three-analysis capacity
// flow, exercised through the agent transport, on the shared planning engine.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODULE_IDS } from '../js/planning/index.js';
import { containsInternalModuleTerminology } from '../js/planning/module_offers.js';
import { getConsumerConfig } from '../worker/src/consumer/config.js';
import { createConsumerCredential } from '../worker/src/consumer/crypto.js';
import { createSessionRecord, getCurrentProfile, getSessionRow } from '../worker/src/consumer/repository.js';
import { executeLiveTool } from '../worker/src/consumer/live/live_tools.js';
import { beginRealtimeToolAttempt } from '../worker/src/consumer/realtime_repository.js';
import {
  confirmAgentPlan,
  createAgentTestSession,
  exportAgentSession,
  getAgentSessionState,
  loadAgentContext,
  processAgentTurn,
  resolveAgentCapacity,
  resolveAgentOffer
} from '../worker/src/consumer/agent_session.js';

const root = fileURLToPath(new URL('..', import.meta.url));

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
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `sqlite test command failed with ${result.status}`);
  }
  return JSON.parse(result.stdout || 'null');
}

class TestD1Statement {
  constructor(databasePath, sql, values = []) {
    this.databasePath = databasePath;
    this.sql = sql;
    this.values = values;
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

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'agent-journey-'));
process.once('exit', () => rmSync(temporaryDirectory, { recursive: true, force: true }));
const databasePath = join(temporaryDirectory, 'consumer.sqlite');
const migrations = [
  '0001_create_consumer_journey', '0002_add_consumer_provider_budget',
  '0003_add_consumer_voice_consent', '0004_add_consumer_voice_dispatch_and_events',
  '0005_add_consumer_realtime_voice', '0006_encrypt_realtime_plan_display',
  '0007_add_realtime_control_inbox', '0008_widen_realtime_session_envelope',
  '0009_add_realtime_consent_purposes', '0010_add_realtime_activation_recovery',
  '0011_add_realtime_meeting_briefs', '0012_add_realtime_planner_usage',
  '0013_complete_realtime_voice_meetings', '0014_add_agent_test_meetings',
  '0015_add_privacy_notice_acknowledgement',
  '0016_add_planning_reconciliation',
  '0017_widen_reconciliation_trigger',
  '0018_add_turn_proposition_link',
  '0019_add_direct_module_meeting_briefs'
].map((name) => readFileSync(`${root}/worker/consumer-migrations/${name}.sql`, 'utf8')).join('\n');
sqliteCommand(databasePath, 'script', { sql: `PRAGMA foreign_keys = ON;\n${migrations}` });

const ALL = Object.values(MODULE_IDS);
const env = {
  CONSUMER_DB: new TestD1(databasePath),
  CONSUMER_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 31).toString('base64url'),
  CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url'),
  CONSUMER_JOURNEY_ENABLED: 'true',
  CONSUMER_MODULE_ROUTING_ENABLED: 'true',
  CONSUMER_GOAL_ROUTING_ENABLED: 'true',
  // D-02 activated, exactly as in the consumer-test environment.
  CONSUMER_MODULE_OFFERS_ENABLED: 'true',
  CONSUMER_AGENT_TEST_ENABLED: 'true',
  CONSUMER_REALTIME_CONVERSATION_V2_ENABLED: 'true',
  CONSUMER_ALLOWED_MODULE_IDS: ALL.join(','),
  CONSUMER_COHORT: 'automated_test',
  CONSUMER_CONSENT_POLICY_VERSION: 'consumer-test-v1',
  CONSUMER_CONSENT_MANIFEST_ID: 'consumer-test-manifest-v1',
  CONSUMER_ANALYSIS_NOTICE_ID: 'analysis-test-v1',
  CONSUMER_AI_NOTICE_ID: 'ai-test-v1',
  CONSUMER_PRIVACY_NOTICE_URL: 'https://planeir.ie/plan/privacy.html',
  CONSUMER_SESSION_TTL_DAYS: '7',
  CONSUMER_AGENT_TEST_MAX_TURNS: '6'
};
const baseConfig = getConsumerConfig(env);
// realtimeConversationV2Enabled requires the full realtime contract, which this
// harness has no need of. Force the conversational shape the agent channel uses.
const config = Object.freeze({ ...baseConfig, realtimeConversationV2Enabled: true, agentTestEnabled: true });
assert.equal(config.moduleOffersEnabled, true, 'D-02 must be active for this journey');

const passes = [];
function pass(message) {
  passes.push(message);
  console.info(`[AgentJourney] PASS: ${message}`);
}

/* ---------------------------------------------------------------- */
/* Stubs: the two model calls, and nothing else.                     */
/* ---------------------------------------------------------------- */

function extraction(sourceTurnId, { goals = [], facts = [], positions = [] } = {}, evidenceText = '') {
  return {
    sourceTurnId,
    goalCandidates: goals.map((goal, index) => ({
      candidateId: `goal-${index + 1}`,
      goalType: goal.type,
      confidence: 'high',
      priorityHint: goal.priorityHint || 'unspecified',
      evidenceText,
      correctionTarget: ''
    })),
    semanticFacts: facts.map((fact, index) => ({
      candidateId: `fact-${index + 1}`,
      operation: 'upsert',
      factId: fact.factId,
      value: fact.value,
      certainty: fact.certainty || 'exact',
      evidenceText,
      correctionTarget: ''
    })),
    positions: positions.map((position, index) => ({
      candidateId: `position-${index + 1}`,
      operation: 'upsert',
      kind: position.kind,
      label: position.label || '',
      entityId: position.entityId || '',
      linkedEntityId: position.linkedEntityId || '',
      amount: position.amount || null,
      country: '',
      owner: position.owner || null,
      propertyUse: position.propertyUse || null,
      pensionType: position.pensionType || null,
      agricultural: null,
      certainty: 'exact',
      evidenceText,
      correctionTarget: ''
    })),
    sectionCompletions: [],
    invalidCandidates: [],
    clientQuestion: { present: false, intent: 'none', topic: '', questionText: '' },
    ambiguities: [],
    narrativeSummary: { summary: '', evidence: [] }
  };
}

function scriptedPlanner(script) {
  let index = 0;
  return async ({ sourceTurnId, transcript }) => {
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    return { extraction: extraction(sourceTurnId, step, transcript), metadata: { costMicroEur: 1_000 } };
  };
}

/** Speaks the server-owned question. Deterministic, no network. */
const scriptedRenderer = async ({ context }) => ({
  text: context.state.meetingBrief?.moduleOffer?.spokenOffer
    || context.state.meetingBrief?.questionBatch?.prompt
    || 'Could you tell me a little more about that?',
  fallback: false,
  decisions: [],
  usageMicroEur: 500,
  context
});

/** Uses the real session-creation service, exactly as the HTTP route does. */
async function newAgentSession(label) {
  const created = await createAgentTestSession(env, config, {
    scenarioId: label,
    createSession: async () => {
      const credential = await createConsumerCredential('');
      await createSessionRecord(env, credential, {
        analysis: true, aiProcessing: false, adultConfirmed: true, educationOnlyAcknowledged: true,
        manifestId: config.consentManifestId, policyVersion: config.consentPolicyVersion,
        analysisNoticeId: config.analysisNoticeId, aiNoticeId: config.aiNoticeId,
        privacyNoticeUrl: config.privacyNoticeUrl
      }, config, null);
      return { sessionId: credential.id, credential: credential.credential };
    }
  });
  return { sessionId: created.sessionId, meetingId: created.meetingId };
}

/* ================================================================== */
/* Journey 1 — offer, decision, and the client-safe surface           */
/* ================================================================== */

{
  const { sessionId, meetingId } = await newAgentSession('offer-journey');
  const planner = scriptedPlanner([
    // Turn 1: a retirement goal plus a home and a mortgage. The mortgage review
    // is a circumstance-driven OFFER, not a routed slot.
    {
      goals: [{ type: 'improve_pension', priorityHint: 'primary' }],
      facts: [{ factId: 'property_status', value: 'homeowner' }],
      positions: [
        { kind: 'property', entityId: 'home', propertyUse: 'home', label: 'Home', amount: { amount: 500_000, currency: 'EUR' } },
        { kind: 'mortgage', entityId: 'mortgage', linkedEntityId: 'home', label: 'Mortgage', amount: { amount: 250_000, currency: 'EUR' } }
      ]
    },
    {}
  ]);

  const first = await processAgentTurn(env, config, {
    sessionId,
    meetingId,
    message: 'I am 52. My home is worth about €500,000 and the mortgage on it is about €250,000. I want to sort my pension out.',
    deps: { extractTurn: planner, renderText: scriptedRenderer }
  });

  assert.ok(first.consumer.assistantMessage, 'the turn produces a client-visible reply');
  assert.ok(first.diagnostics.analyses.length > 0, 'the turn produces a deterministic plan');
  assert.ok(
    first.diagnostics.analyses.some((a) => a.moduleId === MODULE_IDS.PENSION_PROJECTION),
    `the stated goal selects its analysis: [${first.diagnostics.analyses.map((a) => a.moduleId).join(', ')}]`
  );
  assert.ok(first.diagnostics.activeOffer?.moduleId, 'an offer is live on the agent transport');
  assert.equal(first.diagnostics.activeOffer.moduleId, MODULE_IDS.MORTGAGE);
  assert.equal(
    containsInternalModuleTerminology(first.consumer.assistantMessage),
    false,
    'the offer reaches the client in client-safe language'
  );
  const consumerJson = JSON.stringify(first.consumer);
  for (const moduleId of ALL) {
    assert.ok(!consumerJson.includes(moduleId), `module id ${moduleId} must not reach the consumer projection`);
  }
  pass('a live offer is produced end to end and reaches the client in client-safe language');

  // Uncertain changes nothing.
  const uncertain = await resolveAgentOffer(env, config, { sessionId, meetingId, decision: 'uncertain' });
  assert.equal(uncertain.decisionMode, 'action');
  assert.equal(uncertain.parityValid, false, 'action mode is explicitly not parity-valid');
  assert.deepEqual(uncertain.diagnostics.planningDecisions.accepted, [], 'uncertain accepts nothing');
  assert.deepEqual(uncertain.diagnostics.planningDecisions.declined, [], 'uncertain declines nothing');
  assert.ok(uncertain.diagnostics.activeOffer?.moduleId, 'the offer stays on the table after an uncertain answer');
  pass('an uncertain answer changes nothing and leaves the offer live');

  // Accepted moves shared planning state and opens the analysis.
  const accepted = await resolveAgentOffer(env, config, { sessionId, meetingId, decision: 'accepted' });
  assert.deepEqual(accepted.diagnostics.planningDecisions.accepted, [MODULE_IDS.MORTGAGE], 'acceptance is recorded');
  assert.ok(
    accepted.diagnostics.analyses.some((a) => a.moduleId === MODULE_IDS.MORTGAGE),
    'the accepted analysis joins the plan'
  );
  assert.equal(
    accepted.diagnostics.analyses.find((a) => a.moduleId === MODULE_IDS.MORTGAGE).selectionState,
    'accepted',
    'acceptance alone does not authorise execution'
  );
  assert.equal(accepted.diagnostics.activeOffer, null, 'the resolved offer is no longer on the table');
  pass('acceptance is persisted, opens the analysis, and does not authorise execution');
}

/* ================================================================== */
/* Journey 2 — decline is durable                                     */
/* ================================================================== */

{
  const { sessionId, meetingId } = await newAgentSession('decline-journey');
  const planner = scriptedPlanner([{
    goals: [{ type: 'improve_pension', priorityHint: 'primary' }],
    facts: [{ factId: 'property_status', value: 'homeowner' }],
    positions: [
      { kind: 'property', entityId: 'home', propertyUse: 'home', label: 'Home', amount: { amount: 500_000, currency: 'EUR' } },
      { kind: 'mortgage', entityId: 'mortgage', linkedEntityId: 'home', label: 'Mortgage', amount: { amount: 250_000, currency: 'EUR' } }
    ]
  }, {}]);
  await processAgentTurn(env, config, {
    sessionId, meetingId,
    message: 'My home is worth about €500,000 and the mortgage on it is about €250,000. I want to sort my pension.',
    deps: { extractTurn: planner, renderText: scriptedRenderer }
  });
  const declined = await resolveAgentOffer(env, config, { sessionId, meetingId, decision: 'declined' });
  assert.deepEqual(declined.diagnostics.planningDecisions.declined, [MODULE_IDS.MORTGAGE], 'the decline is persisted');
  assert.equal(declined.diagnostics.activeOffer, null, 'a declined analysis is not offered again');
  assert.ok(
    !declined.diagnostics.analyses.some((a) => a.moduleId === MODULE_IDS.MORTGAGE),
    'a declined analysis stays out of the plan'
  );

  // And it must not come back on a later turn.
  const later = await processAgentTurn(env, config, {
    sessionId, meetingId,
    message: 'My pension is worth about 120,000.',
    deps: { extractTurn: planner, renderText: scriptedRenderer }
  });
  assert.notEqual(later.diagnostics.activeOffer?.moduleId, MODULE_IDS.MORTGAGE,
    'a declined analysis is never re-offered in the same cycle');
  pass('a decline is durable across later turns and keeps the analysis out of the plan');
}

/* ================================================================== */
/* Journey 3 — the three-analysis capacity flow                       */
/* ================================================================== */

async function atCapacitySession(label) {
  const { sessionId, meetingId } = await newAgentSession(label);
  const planner = scriptedPlanner([{
    goals: [
      { type: 'understand_position', priorityHint: 'primary' },
      { type: 'optimise_mortgage' },
      { type: 'fund_education' }
    ],
    facts: [
      { factId: 'property_status', value: 'homeowner' },
      { factId: 'has_pension', value: true },
      { factId: 'dependant_count', value: 2 }
    ],
    positions: [
      { kind: 'property', entityId: 'home', propertyUse: 'home', label: 'Home', amount: { amount: 500_000, currency: 'EUR' } },
      { kind: 'mortgage', entityId: 'mortgage', linkedEntityId: 'home', label: 'Mortgage', amount: { amount: 250_000, currency: 'EUR' } },
      { kind: 'pension', entityId: 'pension', pensionType: 'occupational', label: 'Pension', amount: { amount: 120_000, currency: 'EUR' } }
    ]
  }, {}]);
  const turn = await processAgentTurn(env, config, {
    sessionId, meetingId,
    message: 'I want to understand where I stand overall, review the mortgage, and plan for my two children’s college. My home is worth about €500,000, its mortgage is about €250,000, and my pension is about €120,000.',
    deps: { extractTurn: planner, renderText: scriptedRenderer }
  });
  return { sessionId, meetingId, turn };
}

{
  const { turn } = await atCapacitySession('capacity-shape');
  assert.equal(turn.diagnostics.analyses.length, 3, `the plan fills to three: [${turn.diagnostics.analyses.map((a) => a.moduleId).join(', ')}]`);
  assert.equal(turn.diagnostics.capacity.atLimit, true, 'the plan reports it is at the limit');
  assert.equal(turn.diagnostics.capacity.maximumAnalyses, 3);
  const capacity = turn.diagnostics.activeCapacityDecision;
  assert.ok(capacity?.candidateModuleId, 'a live capacity decision is produced on the agent transport');
  assert.equal(capacity.replacementChoices.length, 3, 'exactly the current three may be replaced');
  assert.equal(containsInternalModuleTerminology(capacity.spoken), false, 'the capacity question is client-safe');
  pass('reaching the three-analysis limit produces a live, client-safe capacity decision end to end');
}

{
  // Unclear must change nothing and must not choose for the client.
  const { sessionId, meetingId, turn } = await atCapacitySession('capacity-unclear');
  const before = turn.diagnostics.analyses.map((a) => a.moduleId).sort();
  const unclear = await resolveAgentCapacity(env, config, { sessionId, meetingId, decision: 'unclear' });
  assert.deepEqual(unclear.diagnostics.analyses.map((a) => a.moduleId).sort(), before, 'unclear changes nothing');
  assert.ok(unclear.diagnostics.activeCapacityDecision, 'the decision stays on the table');
  pass('an unclear capacity answer changes nothing and leaves the decision live');
}

{
  // Deferral keeps the current three and closes the decision.
  const { sessionId, meetingId, turn } = await atCapacitySession('capacity-defer');
  const before = turn.diagnostics.analyses.map((a) => a.moduleId).sort();
  const candidateId = turn.diagnostics.activeCapacityDecision.candidateModuleId;
  const deferred = await resolveAgentCapacity(env, config, { sessionId, meetingId, decision: 'defer' });
  assert.deepEqual(deferred.diagnostics.analyses.map((a) => a.moduleId).sort(), before, 'deferral keeps the current three');
  assert.deepEqual(deferred.diagnostics.planningDecisions.deferred, [candidateId], 'the deferral is persisted');
  assert.equal(deferred.diagnostics.activeCapacityDecision, null, 'deferral closes the decision rather than re-asking');
  pass('deferral keeps the current three, is persisted, and is not pressed again');
}

{
  // Replacement swaps exactly the analysis the client named, then the confirmed
  // set is exactly what executes.
  const { sessionId, meetingId, turn } = await atCapacitySession('capacity-replace');
  const capacity = turn.diagnostics.activeCapacityDecision;
  const removeId = capacity.replacementChoices[0].moduleId;
  const candidateId = capacity.candidateModuleId;

  const replaced = await resolveAgentCapacity(env, config, {
    sessionId, meetingId, decision: 'replace', replaceChoiceIndex: 1
  });
  const after = replaced.diagnostics.analyses.map((a) => a.moduleId);
  assert.ok(!after.includes(removeId), 'the analysis the client named leaves the plan');
  assert.ok(after.includes(candidateId), 'the proposed analysis takes its place');
  assert.ok(after.length <= 3, 'replacement never exceeds the limit');
  assert.deepEqual(replaced.diagnostics.planningDecisions.replaced, [removeId], 'the replacement is persisted');
  assert.ok(replaced.result.acknowledgement, 'the client is told what changed');
  assert.equal(
    containsInternalModuleTerminology(replaced.result.acknowledgement),
    false,
    'the acknowledgement uses client language'
  );
  pass('replacement swaps exactly the named analysis and is acknowledged in client language');

  // Confirm and execute.
  const confirmed = await confirmAgentPlan(env, config, { sessionId, meetingId });
  const executed = confirmed.execution.moduleIds;
  assert.ok(executed.length > 0, 'the confirmed plan executes something');
  assert.ok(executed.includes(candidateId), 'the analysis the client swapped in executes');
  assert.ok(!executed.includes(removeId), 'the analysis the client swapped out does not execute');
  assert.ok(executed.length <= 3, 'never more than three execute');
  assert.deepEqual(
    [...confirmed.diagnostics.planningDecisions.confirmed].sort(),
    [...executed].sort(),
    'analysisPlan.moduleIds equals the confirmed execution set'
  );
  pass('the confirmed set is recorded and is exactly what executes');
}

/* ================================================================== */
/* Limits, state, export, and revision handling                       */
/* ================================================================== */

{
  const { sessionId, meetingId } = await newAgentSession('limits');
  const planner = scriptedPlanner([{ goals: [{ type: 'understand_position' }] }, {}]);
  const deps = { extractTurn: planner, renderText: scriptedRenderer };

  const first = await processAgentTurn(env, config, {
    sessionId, meetingId, message: 'Where do I stand overall?', deps
  });

  // Optimistic revision handling.
  await assert.rejects(
    () => processAgentTurn(env, config, {
      sessionId, meetingId, message: 'again', expectedRevision: 999, deps
    }),
    (error) => error.code === 'profile_revision_conflict',
    'a stale expectedRevision is refused'
  );
  const ok = await processAgentTurn(env, config, {
    sessionId, meetingId, message: 'I am 52.', expectedRevision: first.consumer.revision, deps
  });
  assert.ok(ok.consumer.revision >= first.consumer.revision, 'a current expectedRevision is accepted');
  pass('optimistic revision handling refuses a stale revision and accepts the current one');

  // Message limits.
  await assert.rejects(
    () => processAgentTurn(env, config, { sessionId, meetingId, message: '   ', deps }),
    (error) => error.code === 'agent_message_required'
  );
  await assert.rejects(
    () => processAgentTurn(env, config, { sessionId, meetingId, message: 'x'.repeat(config.maxMessageLength + 1), deps }),
    (error) => error.code === 'agent_message_too_long'
  );
  pass('empty and oversized consumer messages are refused');

  // Turn limit (configured to 6 for this harness).
  let hitLimit = false;
  for (let index = 0; index < 12; index += 1) {
    try {
      await processAgentTurn(env, config, { sessionId, meetingId, message: `turn ${index}`, deps });
    } catch (error) {
      if (error.code === 'agent_turn_limit_reached') { hitLimit = true; break; }
      throw error;
    }
  }
  assert.ok(hitLimit, 'the turn limit is enforced');
  pass('the per-session turn limit is enforced');

  // State and export.
  const state = await getAgentSessionState(env, config, { sessionId, meetingId });
  assert.equal(state.sessionId, sessionId);
  assert.ok(state.usage.turnCount >= config.agentTestMaxTurns, 'state reports the turn count');
  assert.equal(state.usage.limits.maxTurns, config.agentTestMaxTurns);
  assert.ok(state.usage.spendMicroEur > 0, 'model spend is metered');

  const exported = await exportAgentSession(env, config, { sessionId, meetingId });
  assert.equal(exported.channel, 'agent_test');
  assert.equal(exported.cohort, 'automated_test');
  assert.equal(exported.versions.moduleOffersEnabled, true, 'the export records whether D-02 was active');
  assert.ok(exported.transcript.length > 0, 'the transcript is exportable');
  assert.ok(exported.transcript.some((t) => t.role === 'user'), 'the transcript carries client turns');
  assert.ok(exported.transcript.some((t) => t.role === 'assistant'), 'the transcript carries assistant turns');
  assert.ok(exported.diagnostics, 'the export carries tester diagnostics');
  pass('session state and transcript export report turns, spend, versions and diagnostics');
}

{
  // The cost ceiling is checked BEFORE dispatch, not after.
  const { sessionId, meetingId } = await newAgentSession('cost');
  const tinyBudget = Object.freeze({ ...config, agentTestSessionBudgetMicroEur: 1, agentTestMaxTurns: 50 });
  const deps = {
    extractTurn: scriptedPlanner([{ goals: [{ type: 'understand_position' }] }]),
    renderText: scriptedRenderer
  };
  await processAgentTurn(env, tinyBudget, { sessionId, meetingId, message: 'Where do I stand?', deps });
  await assert.rejects(
    () => processAgentTurn(env, tinyBudget, { sessionId, meetingId, message: 'and again', deps }),
    (error) => error.code === 'agent_cost_limit_reached',
    'the per-session cost ceiling stops further dispatch'
  );
  pass('the per-session cost ceiling is enforced before dispatch');
}

{
  // Flag off must make the service unavailable, not merely unrouted.
  const { sessionId, meetingId } = await newAgentSession('flag-off');
  const disabled = Object.freeze({ ...config, agentTestEnabled: false });
  for (const [label, call] of [
    ['turn', () => processAgentTurn(env, disabled, { sessionId, meetingId, message: 'hello', deps: {} })],
    ['state', () => getAgentSessionState(env, disabled, { sessionId, meetingId })],
    ['export', () => exportAgentSession(env, disabled, { sessionId, meetingId })],
    ['offer', () => resolveAgentOffer(env, disabled, { sessionId, meetingId, decision: 'accepted' })],
    ['capacity', () => resolveAgentCapacity(env, disabled, { sessionId, meetingId, decision: 'defer' })],
    ['confirm', () => confirmAgentPlan(env, disabled, { sessionId, meetingId })]
  ]) {
    await assert.rejects(call, (error) => error.code === 'agent_test_disabled', `${label} is unavailable with the flag off`);
  }
  pass('with the flag off every agent-test operation is unavailable');
}

{
  // Planning events must be recorded, not silently dropped.
  const { sessionId, meetingId } = await newAgentSession('events');
  const planner = scriptedPlanner([{
    goals: [{ type: 'improve_pension', priorityHint: 'primary' }],
    facts: [{ factId: 'property_status', value: 'homeowner' }],
    positions: [
      { kind: 'property', entityId: 'home', propertyUse: 'home', label: 'Home', amount: { amount: 500_000, currency: 'EUR' } },
      { kind: 'mortgage', entityId: 'mortgage', linkedEntityId: 'home', label: 'Mortgage', amount: { amount: 250_000, currency: 'EUR' } }
    ]
  }, {}]);
  await processAgentTurn(env, config, {
    sessionId, meetingId,
    message: 'My home is worth about €500,000 and the mortgage on it is about €250,000. I want to sort my pension.',
    deps: { extractTurn: planner, renderText: scriptedRenderer }
  });
  await resolveAgentOffer(env, config, { sessionId, meetingId, decision: 'accepted' });

  const rows = sqliteCommand(databasePath, 'all', {
    sql: 'SELECT event_name, metadata_json FROM consumer_events WHERE session_id = ? ORDER BY created_at',
    values: [sessionId]
  }).results;
  const names = new Set(rows.map((row) => row.event_name));
  for (const expected of [
    'agent_test_session_created', 'agent_turn_submitted',
    'goal_plan_evaluated', 'module_offer_presented', 'module_offer_decided'
  ]) {
    assert.ok(names.has(expected), `${expected} must be recorded, not dropped (saw: ${[...names].join(', ')})`);
  }
  const decided = rows.find((row) => row.event_name === 'module_offer_decided');
  const metadata = JSON.parse(decided.metadata_json);
  assert.equal(metadata.moduleId, MODULE_IDS.MORTGAGE, 'the decision event carries the module id');
  assert.equal(metadata.decision, 'accepted');
  assert.equal(metadata.channel, 'agent_test', 'the event records which transport made the decision');
  const presented = JSON.parse(rows.find((row) => row.event_name === 'module_offer_presented').metadata_json);
  assert.equal(presented.channel, 'agent_test');
  pass('offer and capacity planning events are recorded with bounded, channel-tagged metadata');
}

{
  // The shared context builder must not require realtime consent or a lease.
  const { sessionId, meetingId } = await newAgentSession('no-lease');
  const context = await loadAgentContext(env, config, sessionId, meetingId);
  assert.equal(context.state.channel, 'agent_test', 'the context is built on the agent channel');
  assert.ok(context.state.capacity, 'the shared state carries capacity for every transport');
  assert.ok(Array.isArray(context.state.moduleOpportunities), 'the shared state carries opportunities for every transport');
  const sessionRow = await getSessionRow(env, sessionId);
  const profile = await getCurrentProfile(env, sessionRow);
  assert.ok(profile, 'the profile decrypts through the shared repository');
  pass('the agent transport builds shared planning state with no realtime consent and no lease');
}

{
  // The live semantic guard can prove an explicitly anaphoric match even
  // though one spoken value supports two canonical rate fields. That guarded
  // fact must survive the complete shared commit path; re-running the silent
  // planner's one-occurrence/one-candidate grounder here would drop it.
  const { sessionId, meetingId } = await newAgentSession('live-anaphoric-rate');
  const transcript = 'My workplace pension is worth €61,000. I contribute 5% and my employer matches that.';
  const before = await loadAgentContext(env, config, sessionId, meetingId);
  const attempt = await beginRealtimeToolAttempt(env, {
    sessionId,
    leaseId: meetingId,
    providerToolCallId: 'live-anaphoric-rate-call',
    toolName: 'save_facts',
    toolVersion: 'planeir-live-tools-v1',
    expectedProfileRevision: Number(before.sessionRow.current_profile_revision),
    arguments: { factCount: 1 },
    maxToolCalls: config.realtimeMaxToolCalls
  });
  const result = await executeLiveTool('save_facts', {
    facts: [{
      factId: 'pension_positions',
      value: {
        entityId: 'workplace_pension',
        type: 'occupational',
        owner: 'primary',
        currentValue: { amount: 61_000, currency: 'EUR' },
        employeeContributionRate: 5,
        employerContributionRate: 5
      },
      certainty: 'exact'
    }]
  }, {
    env,
    config,
    latestClientTranscript: transcript,
    clientSourcedFigures: null,
    assistantReadBack: '',
    evidenceRef: 'live-anaphoric-rate-turn',
    leaseId: meetingId,
    toolAttemptId: attempt.row.id,
    loadContext: () => loadAgentContext(env, config, sessionId, meetingId)
  });
  assert.deepEqual(result.rejected, [], 'the already-grounded live fact is not rejected by a second grounder');
  assert.deepEqual(result.saved, ['pension_positions']);
  const sessionRow = await getSessionRow(env, sessionId);
  const profile = await getCurrentProfile(env, sessionRow);
  const pension = profile.pensions.find((item) => item.type === 'occupational');
  assert.equal(pension?.currentValue?.amount, 61_000);
  assert.equal(pension?.employeeContributionRate, 0.05);
  assert.equal(pension?.employerContributionRate, 0.05);
  pass('a live anaphoric employer match survives strict grounding and the full shared commit path');
}

/* ================================================================== */
/* Incident regression — the multi-goal opening, through this transport */
/* ================================================================== */

{
  // Q15 of the live-incident investigation: does the exact utterance that
  // produced a clarification loop in voice succeed through the agent transport?
  const { sessionId, meetingId } = await newAgentSession('incident-multi-goal');
  const planner = scriptedPlanner([{
    goals: [{ type: 'understand_position' }, { type: 'buy_home' }],
    facts: [
      { factId: 'person_current_age', value: 25 },
      { factId: 'career_stage', value: 'early_career', certainty: 'approximate' }
    ]
  }, {}]);
  const deps = { extractTurn: planner, renderText: scriptedRenderer };

  const opening = await processAgentTurn(env, config, {
    sessionId,
    meetingId,
    message: "I'm 25 and early in my career. I want to get a broader picture of my financial "
      + "position, and I'm hoping to buy a house in the future, so I want to make sure I'm "
      + "properly set up for that.",
    deps
  });

  assert.deepEqual(
    [...opening.diagnostics.goals.active].sort(),
    ['buy_home', 'understand_position'],
    'both goals are recognised through the agent transport'
  );
  assert.ok(
    opening.diagnostics.facts.some((f) => f.factId === 'person_current_age' && f.value === 25),
    'the stated age is recorded'
  );
  assert.equal(opening.diagnostics.goals.priorityQuestionRequired, true, 'two unranked goals need a focus question');
  assert.ok(opening.diagnostics.pendingQuestion?.factId, 'the meeting has a real question to ask');
  assert.equal(
    opening.diagnostics.pendingQuestion.factId,
    'primary_goal_focus',
    'the agent transport asks which goal to focus on first'
  );
  assert.ok(opening.consumer.assistantMessage.trim().length > 0, 'the client receives a reply');
  assert.doesNotMatch(
    opening.consumer.assistantMessage,
    /repeat|say (?:that )?again|didn.t (?:quite )?(?:catch|get|understand)/i,
    'the client is never asked to repeat a complete statement'
  );

  // Answering it must progress the meeting, not restart the loop.
  const answerPlanner = scriptedPlanner([{ goals: [{ type: 'buy_home', priorityHint: 'primary' }] }, {}]);
  const answered = await processAgentTurn(env, config, {
    sessionId,
    meetingId,
    message: 'Buying a house is the one I care about most right now.',
    deps: { extractTurn: answerPlanner, renderText: scriptedRenderer }
  });
  assert.equal(answered.diagnostics.goals.primary, 'buy_home', 'the stated focus is persisted');
  assert.equal(answered.diagnostics.goals.priorityQuestionRequired, false, 'the focus question is resolved');
  assert.ok(answered.diagnostics.analyses.length > 0, 'analyses appear once the focus is known');
  assert.notEqual(
    answered.diagnostics.pendingQuestion?.factId,
    'primary_goal_focus',
    'the focus question is not asked twice'
  );
  pass('incident regression: the multi-goal opening succeeds end to end through the agent transport');
}

console.info(`\n[AgentJourney] ${passes.length} assertions passed.`);
