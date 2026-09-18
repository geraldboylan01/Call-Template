#!/usr/bin/env node
// Real migrated SQLite, Durable Object and lease lifecycle. No provider calls.
// Run every scenario before failing so the baseline records independent faults.
import assert from 'node:assert/strict';
import { attachTypedSession, attachLiveSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { getRealtimeLease, listRealtimeFinalTurns, touchRealtimeLease } from '../worker/src/consumer/realtime_repository.js';
import { terminateRealtimeLease } from '../worker/src/consumer/realtime_lifecycle.js';
import { reachReviewByTyping, scriptPlanner } from './live-harness/review.mjs';

const failures = [];
let passed = 0;
async function check(name, run) {
  try { await run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
async function rig(label, channel = 'typed') {
  const meeting = await newLiveMeeting(`first20-${label}`, {
    CONSUMER_MODULE_PLANNER_MODE: 'apply', CONSUMER_TYPED_LANE_ENABLED: 'true',
    OPENAI_API_KEY: 'synthetic-test-key'
  });
  // The shared harness starts with an agent_test row; exercise actual transport
  // lifecycle by setting its persisted discriminator, not only the DO flag.
  await meeting.env.CONSUMER_DB.prepare('UPDATE consumer_realtime_sessions SET channel = ? WHERE id = ?')
    .bind(channel, meeting.meetingId).run();
  const attached = channel === 'typed' ? await attachTypedSession(meeting) : await attachLiveSession(meeting);
  await attached.durable.state.storage.put('lease', attached.session.meta);
  return { ...attached, meeting };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, request) => {
  const body = JSON.parse(request?.body || '{}');
  return new Response(JSON.stringify({ status: 'completed', output: body?.tools
    ? [{ type: 'function_call', name: 'get_state', arguments: '{}', call_id: 'first20_get_state' }]
    : [], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
try {
  // WHAT THESE TWO CHECKS USED TO BE.
  //
  // A composed typed read-back persisting exactly once, and its reply binding
  // surviving eviction so a later "yes" still attached to the right plan. Both
  // existed to make a SPOKEN OR TYPED APPROVAL safe. There is no approval, so
  // the properties are gone -- replaced by the one that matters now: a review
  // survives eviction as the same immutable object, and the reconstructed
  // meeting is still shut.

  await check('a published review survives Durable Object eviction unchanged', async () => {
    const heal = scriptPlanner();
    try {
      const { meeting, rig: live, result } = await reachReviewByTyping('first20-review-recovery');
      assert.ok(result.review?.reviewId, 'the typed meeting published a review');
      const recovered = await attachTypedSession(meeting, { initial: Object.fromEntries(live.durable.values) });
      const state = await recovered.session.publicState();
      assert.equal(state.review?.reviewId, result.review.reviewId,
        'the reconstructed meeting shows the SAME review, not a new one');
      assert.equal(state.mode, 'review', 'with the conversation still closed');
      assert.deepEqual(state.review.presentation, result.review.presentation,
        'and the identical certified presentation');
    } finally { heal(); }
  });

  await check('a reconstructed meeting still refuses conversation', async () => {
    const heal = scriptPlanner();
    try {
      const { meeting, rig: live } = await reachReviewByTyping('first20-review-closed');
      const recovered = await attachTypedSession(meeting, { initial: Object.fromEntries(live.durable.values) });
      await assert.rejects(
        () => recovered.session.handleTextMessage({ text: 'Yes, run it.' }),
        (error) => error.code === 'review_input_closed',
        'a reconstructed meeting does not reopen input just because it restarted'
      );
      const runs = await meeting.env.CONSUMER_DB
        .prepare('SELECT COUNT(*) AS n FROM consumer_analysis_runs WHERE session_id = ?')
        .bind(meeting.sessionId).first();
      assert.equal(Number(runs.n), 0, 'and nothing executed');
    } finally { heal(); }
  });

  await check('typing preserves the hard-expiry-only idle policy', async () => {
    const { meeting } = await rig('typed-idle');
    const before = await getRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId);
    const after = await touchRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId, 180);
    assert.equal(after.idle_expires_at, before.hard_expires_at);
  });

  await check('typed heartbeat does not require a voice sideband', async () => {
    const { session, durable } = await rig('typed-heartbeat');
    await session.alarm();
    assert.equal(session.pendingTerminalization, null);
    assert.equal(durable.values.has('terminalizationRetryAttempts'), false);
  });

  await check('active typed lease closes through the Durable Object without a provider id', async () => {
    const { session, meeting } = await rig('typed-close');
    const closed = await session.terminalize('complete', 'consumer_closed', null, true);
    assert.equal(closed.providerHangupConfirmed, true);
    assert.equal((await getRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId)).status, 'complete');
  });

  await check('active typed lease closes with coordinator unavailable', async () => {
    const { meeting } = await rig('typed-fallback-close');
    const lease = await getRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId);
    const closed = await terminateRealtimeLease(meeting.env, lease, { status: 'complete', reason: 'consumer_closed' });
    assert.equal(closed.status, 'complete');
  });

  await check('voice fallback still refuses unproven provider termination', async () => {
    const { meeting } = await rig('voice-fallback-close', 'voice');
    const lease = await getRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId);
    await assert.rejects(terminateRealtimeLease(meeting.env, lease), (error) => error.code === 'realtime_hangup_uncertain');
  });
} finally { globalThis.fetch = originalFetch; }
console.log(`[First20ExecutionRecovery] ${passed} passed; ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
