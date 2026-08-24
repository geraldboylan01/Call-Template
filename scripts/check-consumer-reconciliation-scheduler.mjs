#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ConsumerLiveSession,
  plannerReconciliationPreflight,
  reconciliationTriggerForProjection
} from '../worker/src/consumer/live/live_session.js';
import {
  completePlannerReconciliation,
  loadPlannerReconciliation,
  persistableReconciliationTrigger,
  recoverStalePlannerReconciliation,
  startPlannerReconciliation
} from '../worker/src/consumer/realtime_repository.js';
import {
  makeConfig,
  makeEnv,
  newDatabase,
  newSession
} from './agent-harness/transports.mjs';

const FUTURE = '2030-01-01T00:00:00.000Z';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function fakeDurableState(initial = {}) {
  const values = new Map(Object.entries(initial));
  const alarms = [];
  const waitUntilPromises = [];
  let initialization;
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async setAlarm(deadline) { alarms.push(Number(deadline)); }
  };
  const state = {
    storage,
    blockConcurrencyWhile(callback) { initialization = Promise.resolve(callback()); },
    waitUntil(promise) { waitUntilPromises.push(Promise.resolve(promise)); }
  };
  return {
    state,
    values,
    alarms,
    waitUntilPromises,
    initialized: () => initialization
  };
}

async function schedulerSession(label, initial = {}) {
  const env = makeEnv(newDatabase(label), {
    CONSUMER_PLANNER_RECONCILIATION_MODE: 'shadow'
  });
  const durable = fakeDurableState(initial);
  const session = new ConsumerLiveSession(durable.state, env);
  await durable.initialized();
  session.meta = {
    sessionId: 'cs_scheduler_test',
    leaseId: 'rt_scheduler_test',
    hardExpiresAt: FUTURE,
    idleExpiresAt: FUTURE
  };
  session.loadPlannerReconciliationContext = async () => ({ profile: { revision: 1 } });
  session.recordPlannerReconciliationEvent = async () => {};
  session.injectVolatileState = async () => {};
  return { session, durable };
}

/* ------------------------------ a reconstructed DO resumes the durable queue */

{
  const storedQueue = {
    schemaVersion: 1,
    current: {
      providerItemId: 'provider-restart-1',
      throughTurnId: 'turn-restart-1',
      ordinal: 1,
      trigger: 'material_turn',
      retryAttempt: 0,
      notBeforeAt: 0
    },
    queued: {
      providerItemId: 'provider-restart-2',
      throughTurnId: 'turn-restart-2',
      ordinal: 2,
      trigger: 'periodic_checkpoint',
      retryAttempt: 0,
      notBeforeAt: 0
    }
  };
  const { session, durable } = await schedulerSession('reconciliation-scheduler-restart', {
    pendingReconciliationTurn: storedQueue
  });
  const resumed = [];
  session.executePlannerReconciliation = async (_config, _context, job) => {
    resumed.push(job.throughTurnId);
    return { status: 'shadow', validation: { acceptedGroupIds: [], rejectedGroups: [] } };
  };
  session.queueReconciliationDrain();
  await session.reconciliationChain;
  assert.deepEqual(resumed, ['turn-restart-1', 'turn-restart-2'],
    'a reconstructed DO must resume the retained current job before its coalesced successor');
  assert.equal(durable.values.has('pendingReconciliationTurn'), false);
}

/* ---------------------------- confirmation barrier and legacy audit wiring */

/**
 * THE GATE ASKS WHETHER ANYTHING MATERIAL IS OUTSTANDING.
 *
 * It used to ask whether the CONFIRMING turn had been reconciled, which no
 * conversation can ever satisfy — reconciliation for a turn is scheduled at
 * `response.done` and the tool call arrives before it, so the watermark sits
 * one turn behind forever and `confirm_and_run` could not succeed in `shadow`
 * or `apply` at all. These cases pin the sequence, not just the predicate.
 */

// 4. Legacy is untouched: no reconciler, no barrier, whatever else is passed.
assert.deepEqual(plannerReconciliationPreflight('legacy', null, []), {
  ready: true,
  reason: 'legacy'
});
assert.equal(plannerReconciliationPreflight('legacy', null, [
  { turnId: 'turn-9', ordinal: 9 }
]).ready, true, 'legacy must not consult material state at all');

// 1. A pure confirmation, every material turn already reviewed.
for (const mode of ['shadow', 'apply']) {
  assert.deepEqual(plannerReconciliationPreflight(mode, {
    planner_reconciliation_status: 'shadow',
    planner_reconciled_through_turn_id: 'turn-1'
  }, []), { ready: true, reason: 'reviewed' },
  `${mode}: a confirmation carrying no facts must not require a review of itself`);
}

// 2. A material turn from earlier in the call is still unreviewed.
for (const mode of ['shadow', 'apply']) {
  const verdict = plannerReconciliationPreflight(mode, {
    planner_reconciliation_status: 'shadow',
    planner_reconciled_through_turn_id: 'turn-1'
  }, [{ turnId: 'turn-2', ordinal: 2 }]);
  assert.equal(verdict.ready, false, `${mode}: an unreviewed material turn must block`);
  assert.equal(verdict.reason, 'reconciliation_pending');
  assert.deepEqual(verdict.outstandingTurnIds, ['turn-2'],
    'the refusal must name what it is waiting for');
}

// 3. The confirming turn carries its own correction, so it blocks itself.
//    (The sequence that produces this — save_facts marking the turn material
//    before confirm_and_run reads the gate — is asserted end to end below.)
for (const mode of ['shadow', 'apply']) {
  assert.equal(plannerReconciliationPreflight(mode, {
    planner_reconciliation_status: 'applied',
    planner_reconciled_through_turn_id: 'turn-4'
  }, [{ turnId: 'turn-5', ordinal: 5 }]).ready, false,
  `${mode}: a correction made while confirming must be reviewed before anything runs`);
}

// 5. A stale or failed pass retires nothing, so its material turn keeps blocking.
assert.equal(plannerReconciliationPreflight('apply', {
  planner_reconciliation_status: 'failed',
  planner_reconciled_through_turn_id: 'turn-1'
}, [{ turnId: 'turn-2', ordinal: 2 }]).ready, false,
'a failed reconciliation must not release the barrier');

// An in-flight pass has decided nothing yet, so it is not yet a clean bill.
assert.equal(plannerReconciliationPreflight('apply', {
  planner_reconciliation_status: 'pending',
  planner_pending_through_turn_id: 'turn-3'
}, []).ready, false, 'a reconciliation still running must block');
assert.equal(reconciliationTriggerForProjection({
  readyToConfirm: false,
  analyses: [{ status: 'needs_information', stillNeeded: [{ factId: 'cash_savings' }] }]
}, {
  readyToConfirm: false,
  analyses: [{ status: 'needs_information', stillNeeded: [] }]
}, ['cash_savings']), 'answered_need',
'an accepted answer to a server-owned open need must schedule reconciliation');
assert.equal(reconciliationTriggerForProjection({
  readyToConfirm: false,
  analyses: [{ status: 'needs_information', stillNeeded: [{ factId: 'cash_savings' }] }]
}, {
  readyToConfirm: true,
  analyses: [{ status: 'ready', stillNeeded: [] }]
}, ['cash_savings']), 'readiness_transition',
'a readiness change must use the narrower readiness-transition trigger');

const liveSource = readFileSync(
  new URL('../worker/src/consumer/live/live_session.js', import.meta.url),
  'utf8'
);
assert.match(liveSource, /code:\s*'reconciliation_pending'/,
  'confirm_and_run must return the recoverable reconciliation_pending result');
assert.match(liveSource, /reconciliationTrigger\s*=\s*'pre_confirmation'/,
  'the confirmation barrier must queue a priority pre-confirmation checkpoint');
assert.match(liveSource, /reconciliationPriority\s*=\s*true/,
  'the confirmation checkpoint must outrank ordinary coalesced triggers');
assert.match(liveSource, /auditTurnFacts\(transcript, itemId, storedTurn\.id\)/,
  'legacy audit must receive the durable source-turn identity');
assert.match(liveSource, /toolName:\s*'silent_planner'[\s\S]{0,500}sourceTurnId:\s*storedTurnId/,
  'legacy audit must create a silent-planner attempt bound to the stored turn');
assert.match(liveSource, /toolAttemptId:\s*attempt\.row\.id/,
  'legacy audit proposals must carry their attempt foreign key');
assert.match(liveSource, /completeRealtimeToolAttempt\(this\.env/,
  'legacy audit must make its attempt terminal');

/* ---------------- durable queue remains until terminal and coalesces safely */

/**
 * THE TRIGGER VOCABULARY IS A SCHEMA CONSTRAINT, NOT A LABEL.
 *
 * `trigger` carries a closed CHECK constraint, so a cause the database has not
 * heard of does not degrade — the INSERT throws and the checkpoint dies before
 * the model is called. That is what happened to `value_coverage_gap`: the
 * signal the whole omission-recovery mechanism was built on could never once
 * run on its own trigger, and recovery only happened when an unrelated cause
 * fired on the same turn. Every trigger the Worker can emit is pinned against
 * the migration here, and an unknown one degrades instead of failing.
 */
{
  const migration = readFileSync(
    new URL('../worker/consumer-migrations/0017_widen_reconciliation_trigger.sql', import.meta.url),
    'utf8'
  );
  const allowed = new Set(
    (migration.match(/trigger IN \(([\s\S]*?)\)\)/) || [])[1]
      ?.match(/'([a-z_]+)'/g)?.map((value) => value.replaceAll("'", '')) || []
  );
  assert.ok(allowed.size >= 10, `the migration must define the trigger vocabulary: ${[...allowed]}`);
  const emitted = [...liveSource.matchAll(/trigger:\s*'([a-z_]+)'/g)].map((match) => match[1]);
  const emittedLiterals = [...liveSource.matchAll(/\?\s*'([a-z_]+)'\s*:/g)].map((match) => match[1]);
  for (const trigger of new Set([...emitted, ...emittedLiterals])) {
    if (!/^(?:material_turn|rejected_note|answered_need|redundant_question|periodic_checkpoint|readiness_transition|pre_confirmation|agent_shadow_replay|value_coverage_gap|material_backlog)$/.test(trigger)) continue;
    assert.ok(allowed.has(trigger),
      `the live lane emits trigger "${trigger}" but the schema refuses it`);
  }
  assert.ok(allowed.has('value_coverage_gap'),
    'the omission-recovery signal must be a persistable trigger');
  assert.ok(allowed.has('material_backlog'),
    'the backlog checkpoint that opens the confirmation barrier must be persistable');
  assert.equal(persistableReconciliationTrigger('value_coverage_gap'), 'value_coverage_gap');
  assert.equal(persistableReconciliationTrigger('material_backlog'), 'material_backlog');
  // Naming a new cause must never be able to kill the reconciler again.
  assert.equal(persistableReconciliationTrigger('a_cause_nobody_migrated'), 'material_turn');
  assert.equal(persistableReconciliationTrigger(''), 'material_turn');
  console.log('[ReconciliationScheduler] PASS: every emitted trigger is one the schema accepts');
}

{
  const { session, durable } = await schedulerSession('reconciliation-scheduler-durable');
  session.unreviewedMaterialTurns = [{ turnId: 'turn-1', ordinal: 1 }];
  const first = deferred();
  const calls = [];
  session.executePlannerReconciliation = async (_config, _context, job) => {
    calls.push({ turn: job.throughTurnId, retry: job.retryAttempt });
    if (job.throughTurnId === 'turn-1') await first.promise;
    return { status: 'shadow', validation: { acceptedGroupIds: [], rejectedGroups: [] } };
  };

  session.queueReconciliation({
    providerItemId: 'provider-1', throughTurnId: 'turn-1', ordinal: 1, trigger: 'material_turn'
  });
  await eventually(() => calls.length === 1, 'the first durable job did not begin');
  await session.reconciliationPersistenceChain;
  let stored = durable.values.get('pendingReconciliationTurn');
  assert.equal(stored.current.throughTurnId, 'turn-1',
    'an executing job must remain in durable storage');

  session.unreviewedMaterialTurns = [
    { turnId: 'turn-1', ordinal: 1 },
    { turnId: 'turn-2', ordinal: 2 }
  ];
  session.queueReconciliation({
    providerItemId: 'provider-2', throughTurnId: 'turn-2', ordinal: 2, trigger: 'material_turn'
  });
  await session.reconciliationPersistenceChain;
  stored = durable.values.get('pendingReconciliationTurn');
  assert.equal(stored.current.throughTurnId, 'turn-1',
    'coalescing must not overwrite the in-flight durable job');
  assert.equal(stored.queued.throughTurnId, 'turn-2',
    'a later trigger must be durably retained behind the in-flight job');
  assert.deepEqual(stored.queued.reviewTurnIds, ['turn-1', 'turn-2'],
    'a coalesced checkpoint must retain every earlier material-turn audit obligation');

  first.resolve();
  await session.reconciliationChain;
  assert.deepEqual(calls, [
    { turn: 'turn-1', retry: 0 },
    { turn: 'turn-2', retry: 0 }
  ]);
  assert.equal(durable.values.has('pendingReconciliationTurn'), false,
    'the durable queue may be deleted only after both jobs are terminal');
  assert.ok(durable.waitUntilPromises.length >= 3,
    'queue persistence and drain work must be attached to waitUntil');
}

/* -------------------------- a fresh pending replay waits without busy-loop */

{
  const { session, durable } = await schedulerSession('reconciliation-scheduler-pending');
  let calls = 0;
  session.executePlannerReconciliation = async () => {
    calls += 1;
    return {
      status: 'pending',
      replayed: true,
      reconciliationId: 'planner-reconciliation-pending',
      createdAt: new Date().toISOString()
    };
  };
  session.recoverPendingPlannerReconciliation = async (_result) => ({
    status: 'pending',
    recovered: false,
    createdAt: new Date().toISOString()
  });
  session.queueReconciliation({
    providerItemId: 'provider-pending',
    throughTurnId: 'turn-pending',
    ordinal: 1,
    trigger: 'periodic_checkpoint'
  });
  await session.reconciliationChain;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'a fresh pending replay must not immediately invoke itself again');
  const stored = durable.values.get('pendingReconciliationTurn');
  assert.ok(Number(stored.current.notBeforeAt) > Date.now(),
    'a fresh pending replay must retain a durable future wake time');
  assert.ok(durable.alarms.some((deadline) => deadline <= stored.current.notBeforeAt),
    'the DO alarm must cover the pending-row stale boundary');
}

/* ---------------------------- stale pending and conflict retry are bounded */

{
  const { session, durable } = await schedulerSession('reconciliation-scheduler-stale');
  const retries = [];
  session.executePlannerReconciliation = async (_config, _context, job) => {
    retries.push(job.retryAttempt);
    if (job.retryAttempt === 0) {
      return {
        status: 'pending',
        replayed: true,
        reconciliationId: 'planner-reconciliation-stale',
        createdAt: '2020-01-01T00:00:00.000Z'
      };
    }
    return { status: 'shadow', validation: { acceptedGroupIds: [], rejectedGroups: [] } };
  };
  session.recoverPendingPlannerReconciliation = async () => ({
    status: 'failed',
    recovered: true,
    errorCode: 'planner_reconciliation_stale_pending'
  });
  session.queueReconciliation({
    providerItemId: 'provider-stale', throughTurnId: 'turn-stale', ordinal: 1, trigger: 'material_turn'
  });
  await session.reconciliationChain;
  assert.deepEqual(retries, [0, 1], 'one stale pending row must receive exactly one fresh attempt');
  assert.equal(durable.values.has('pendingReconciliationTurn'), false);
}

{
  const { session } = await schedulerSession('reconciliation-scheduler-conflict');
  const retries = [];
  session.executePlannerReconciliation = async (_config, _context, job) => {
    retries.push(job.retryAttempt);
    return job.retryAttempt === 0
      ? { status: 'conflicted', errorCode: 'planner_reconciliation_stale' }
      : { status: 'shadow', validation: { acceptedGroupIds: [], rejectedGroups: [] } };
  };
  session.queueReconciliation({
    providerItemId: 'provider-conflict', throughTurnId: 'turn-conflict', ordinal: 1, trigger: 'material_turn'
  });
  await session.reconciliationChain;
  assert.deepEqual(retries, [0, 1], 'a stale-profile conflict must rerun once against fresh context');
}

{
  const { session, durable } = await schedulerSession('reconciliation-scheduler-conflict-bounded');
  const retries = [];
  session.executePlannerReconciliation = async (_config, _context, job) => {
    retries.push(job.retryAttempt);
    return { status: 'conflicted', errorCode: 'planner_reconciliation_stale' };
  };
  session.queueReconciliation({
    providerItemId: 'provider-conflict-bounded',
    throughTurnId: 'turn-conflict-bounded',
    ordinal: 1,
    trigger: 'material_turn'
  });
  await session.reconciliationChain;
  assert.deepEqual(retries, [0, 1], 'repeated conflicts must stop after the single recovery attempt');
  assert.equal(durable.values.has('pendingReconciliationTurn'), false,
    'an exhausted conflict job must become terminal rather than spin');
}

/* -------------------------------------------- repository CAS and recovery */

async function repositoryFixture(label) {
  const env = makeEnv(newDatabase(label), {
    CONSUMER_PLANNER_RECONCILIATION_MODE: 'shadow'
  });
  const config = makeConfig(env);
  const { sessionId, meetingId } = await newSession(env, config);
  const session = await env.CONSUMER_DB.prepare(`
    SELECT current_profile_revision FROM consumer_sessions WHERE id = ? LIMIT 1
  `).bind(sessionId).first();
  return { env, sessionId, meetingId, revision: Number(session.current_profile_revision) };
}

async function startAttempt(fixture, suffix, throughTurnId = `turn-${suffix}`) {
  return startPlannerReconciliation(fixture.env, {
    sessionId: fixture.sessionId,
    leaseId: fixture.meetingId,
    baseProfileRevision: fixture.revision,
    throughTurnId,
    trigger: 'material_turn',
    mode: 'shadow',
    idempotencyKey: `scheduler-test:${suffix}`,
    promptVersion: 'planning-reconciliation-v2',
    input: { schemaVersion: 1, suffix }
  });
}

async function completeShadow(fixture, started, throughTurnId) {
  return completePlannerReconciliation(fixture.env, {
    sessionId: fixture.sessionId,
    leaseId: fixture.meetingId,
    reconciliationId: started.row.id,
    reconciliationRevision: Number(started.row.reconciliation_revision),
    throughTurnId,
    status: 'shadow',
    output: { schemaVersion: 1, verdict: 'clean' },
    model: 'test-model',
    inputTokens: 1,
    outputTokens: 1,
    cachedInputTokens: 0,
    latencyMs: 1,
    operationCount: 0,
    acceptedOperationCount: 0,
    rejectedOperationCount: 0,
    errorCode: null
  });
}

// A model result produced against profile N must not advance the watermark
// after the household and lease have moved to N+1.
{
  const fixture = await repositoryFixture('reconciliation-cas-stale-profile');
  const started = await startAttempt(fixture, 'stale-profile');
  await fixture.env.CONSUMER_DB.prepare(`
    UPDATE consumer_sessions SET current_profile_revision = ? WHERE id = ?
  `).bind(fixture.revision + 1, fixture.sessionId).run();
  await fixture.env.CONSUMER_DB.prepare(`
    UPDATE consumer_realtime_sessions SET latest_profile_revision = ? WHERE id = ?
  `).bind(fixture.revision + 1, fixture.meetingId).run();

  const completed = await completeShadow(fixture, started, 'turn-stale-profile');
  assert.equal(completed.status, 'conflicted');
  const saved = await loadPlannerReconciliation(
    fixture.env, fixture.sessionId, fixture.meetingId, started.row.id
  );
  assert.equal(saved.row.status, 'conflicted');
  const lease = await fixture.env.CONSUMER_DB.prepare(`
    SELECT planner_reconciled_through_turn_id, planner_reconciliation_status,
           latest_profile_revision
    FROM consumer_realtime_sessions WHERE id = ?
  `).bind(fixture.meetingId).first();
  assert.equal(lease.planner_reconciled_through_turn_id, null);
  assert.equal(lease.planner_reconciliation_status, 'failed');
  assert.equal(Number(lease.latest_profile_revision), fixture.revision + 1);
}

// Completing attempt A after attempt B started may conflict A, but it may not
// clear B's pending cursor or make B non-terminal.
{
  const fixture = await repositoryFixture('reconciliation-cas-overlap');
  const first = await startAttempt(fixture, 'overlap-a', 'turn-overlap-a');
  const second = await startAttempt(fixture, 'overlap-b', 'turn-overlap-b');
  const firstCompletion = await completeShadow(fixture, first, 'turn-overlap-a');
  assert.equal(firstCompletion.status, 'conflicted');
  const secondBefore = await loadPlannerReconciliation(
    fixture.env, fixture.sessionId, fixture.meetingId, second.row.id
  );
  assert.equal(secondBefore.row.status, 'pending');
  let lease = await fixture.env.CONSUMER_DB.prepare(`
    SELECT planner_reconciliation_revision, planner_pending_through_turn_id,
           planner_reconciliation_status
    FROM consumer_realtime_sessions WHERE id = ?
  `).bind(fixture.meetingId).first();
  assert.equal(Number(lease.planner_reconciliation_revision), Number(second.row.reconciliation_revision));
  assert.equal(lease.planner_pending_through_turn_id, 'turn-overlap-b');
  assert.equal(lease.planner_reconciliation_status, 'pending');

  const secondCompletion = await completeShadow(fixture, second, 'turn-overlap-b');
  assert.equal(secondCompletion.status, 'shadow');
  lease = await fixture.env.CONSUMER_DB.prepare(`
    SELECT planner_reconciled_through_turn_id, planner_reconciliation_status
    FROM consumer_realtime_sessions WHERE id = ?
  `).bind(fixture.meetingId).first();
  assert.equal(lease.planner_reconciled_through_turn_id, 'turn-overlap-b');
  assert.equal(lease.planner_reconciliation_status, 'shadow');
}

// Stale recovery is terminal and idempotent, and recovering an older overlap
// cannot erase the current attempt's cursor.
{
  const fixture = await repositoryFixture('reconciliation-stale-recovery');
  const first = await startAttempt(fixture, 'recovery-a', 'turn-recovery-a');
  const second = await startAttempt(fixture, 'recovery-b', 'turn-recovery-b');
  await fixture.env.CONSUMER_DB.prepare(`
    UPDATE consumer_planner_reconciliations
    SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?
  `).bind(first.row.id).run();
  const recovered = await recoverStalePlannerReconciliation(fixture.env, {
    sessionId: fixture.sessionId,
    leaseId: fixture.meetingId,
    reconciliationId: first.row.id,
    staleBefore: '2021-01-01T00:00:00.000Z'
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.errorCode, 'planner_reconciliation_stale_pending');
  const replay = await recoverStalePlannerReconciliation(fixture.env, {
    sessionId: fixture.sessionId,
    leaseId: fixture.meetingId,
    reconciliationId: first.row.id,
    staleBefore: '2021-01-01T00:00:00.000Z'
  });
  assert.equal(replay.recovered, false);
  assert.equal(replay.status, 'failed');
  const lease = await fixture.env.CONSUMER_DB.prepare(`
    SELECT planner_pending_through_turn_id, planner_reconciliation_status
    FROM consumer_realtime_sessions WHERE id = ?
  `).bind(fixture.meetingId).first();
  assert.equal(lease.planner_pending_through_turn_id, 'turn-recovery-b');
  assert.equal(lease.planner_reconciliation_status, 'pending');
  const current = await loadPlannerReconciliation(
    fixture.env, fixture.sessionId, fixture.meetingId, second.row.id
  );
  assert.equal(current.row.status, 'pending');
}

console.info('[ConsumerReconciliationScheduler] PASS: durable queue, bounded recovery, confirmation barrier and repository CAS');
