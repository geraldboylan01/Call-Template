#!/usr/bin/env node

/**
 * A TYPED MEETING IS NOT A CALL, AND THE SESSION LIFECYCLE HAS TO KNOW IT.
 *
 * The planner, verifier and confirmation barrier were shared correctly from the
 * start. What was not shared correctly was everything AROUND them: activation,
 * heartbeat, shutdown, cost control and lease scoping all assumed that an
 * active meeting is a voice meeting holding a provider socket. Two of those
 * assumptions were load-bearing enough to break the product:
 *
 *   The heartbeat treats "no sideband socket" as "session lost". A typed
 *   meeting holds no socket between turns by design, so every typed meeting
 *   was marked for failure-termination fifteen seconds after it started.
 *
 *   The close path asks "was a call ever dispatched" and answered it from
 *   `activated_at`, which typed also sets. So every typed close reached the
 *   provider-hangup branch, found no call id -- there is none -- and threw.
 *
 * They cancelled each other into a stalemate: the meeting kept working while
 * retrying a termination it could never finish, leaking its lease and its
 * budget reservation and emitting no telemetry. Fixing either one alone would
 * have been worse than fixing neither, which is why this file asserts both.
 */

import assert from 'node:assert/strict';

import { attachTypedSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { getRealtimeLease } from '../worker/src/consumer/realtime_repository.js';

let checks = 0;
function ok(value, message) { checks += 1; assert.ok(value, message); }
function equal(actual, expected, message) { checks += 1; assert.equal(actual, expected, message); }

const ENV = {
  CONSUMER_MODULE_PLANNER_MODE: 'apply',
  CONSUMER_TYPED_LANE_ENABLED: 'true',
  OPENAI_API_KEY: 'synthetic-test-key'
};

function scriptModels() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.openai.com')) return original(url, init);
    const body = JSON.parse(init?.body || '{}');
    const output = body?.text?.format?.name
      ? []
      : [{ type: 'message', content: [{ type: 'output_text', text: 'Go on.' }] }];
    return new Response(JSON.stringify({ status: 'completed', output, usage: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { restore() { globalThis.fetch = original; } };
}

/* ------------------------------------- a typed meeting survives its heartbeat */

{
  const models = scriptModels();
  const meeting = await newLiveMeeting('typed-heartbeat', ENV);
  const { session, durable } = await attachTypedSession(meeting);

  equal(session.webSocket, null, 'a typed meeting holds no provider socket, by design');
  const first = await session.handleTextMessage({ text: 'First message.' });
  await settle(durable, session);
  equal(first.ok, true, 'the meeting works before its first heartbeat');

  // This is the alarm that fires 15 seconds after activation.
  await session.alarm();
  equal(session.pendingTerminalization ?? null, null,
    'the heartbeat must NOT mark a typed meeting for termination for want of a socket');
  equal(session.closing, false, 'and must not begin closing it');

  const second = await session.handleTextMessage({ text: 'Second message, later.' });
  await settle(durable, session);
  equal(second.ok, true, 'the meeting still works after its heartbeat');

  // And it stays that way, rather than accumulating a retry loop.
  for (const attempt of [1, 2, 3]) {
    await session.alarm();
    equal(session.pendingTerminalization ?? null, null,
      `heartbeat ${attempt} leaves no pending termination`);
  }
  models.restore();
}

/* ------------------------------------------- a typed meeting closes cleanly */

{
  const models = scriptModels();
  const meeting = await newLiveMeeting('typed-close', ENV);
  const { session } = await attachTypedSession(meeting);

  const before = await getRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId);
  equal(before.status, 'active', 'the meeting starts active');
  equal(before.channel, 'typed', 'and the LEASE records the channel -- terminalize reads it from there');

  let thrown = null;
  try {
    await session.terminalize('complete', 'consumer_closed', null, false);
  } catch (error) {
    thrown = error.code || error.message;
  }
  equal(thrown, null, 'closing a typed meeting must not demand a provider call to hang up');

  const after = await getRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId);
  equal(after.status, 'complete', 'the lease is actually closed, not left active');
  ok(after.ended_at, 'and stamped, so the expiry sweep has nothing left to reclaim');
  // The budget reservation is settled by closing. Without this a second typed
  // meeting in the same session is refused for want of budget the first one
  // never released.
  ok(session.closing, 'the object records that it closed');
  models.restore();
}

/* ------------------------------- voice still requires its provider call id */

// The fix must not weaken the voice guarantee it sits beside: a call that was
// dispatched and cannot be proven hung up must still refuse to close quietly.
{
  const { attachLiveSession } = await import('./live-harness/session.mjs');
  const meeting = await newLiveMeeting('voice-close-guard', ENV);
  const { session } = await attachLiveSession(meeting);
  let code = null;
  try {
    await session.terminalize('complete', 'consumer_closed', null, false);
  } catch (error) {
    code = error.code;
  }
  equal(code, 'live_hangup_uncertain',
    'a VOICE meeting with no provable hangup still refuses to close -- unchanged');
}

/* ------------------------------- the allowance and the turn cap both apply */

// Voice enforces these in `handleUsage`, which only ever runs from a provider
// message. A typed meeting produces none, so it had no mid-meeting ceiling at
// all -- bounded only by the reservation it took at the door, which is the
// whole remaining session budget.
{
  const models = scriptModels();
  const meeting = await newLiveMeeting('typed-allowance', ENV);
  const { session, durable } = await attachTypedSession(meeting);

  ok(typeof session.enforceTypedBudget === 'function',
    'a typed meeting has its own allowance check');
  equal(await session.enforceTypedBudget(), false,
    'a fresh meeting is well inside its allowance');

  // Drive the lease past its turn cap the way real turns would, then check.
  const config = (await import('../worker/src/consumer/config.js')).getConsumerConfig(meeting.env);
  await meeting.env.CONSUMER_DB.prepare(
    'UPDATE consumer_realtime_sessions SET response_count = ? WHERE id = ?'
  ).bind(config.realtimeMaxResponses, meeting.meetingId).run();

  equal(await session.enforceTypedBudget(), true,
    'a typed meeting that has used its turn allowance is stopped');
  const lease = await getRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId);
  equal(lease.status, 'budget_exhausted', 'and the lease is actually closed rather than left running');
  equal(lease.close_reason, 'dispatch_stop_reached', 'for the same reason a call would be');
  models.restore();
}

// And it has to be WIRED to the turn path, not merely available on the object.
{
  const models = scriptModels();
  const meeting = await newLiveMeeting('typed-allowance-wired', ENV);
  const { session, durable } = await attachTypedSession(meeting);
  const config = (await import('../worker/src/consumer/config.js')).getConsumerConfig(meeting.env);
  await meeting.env.CONSUMER_DB.prepare(
    'UPDATE consumer_realtime_sessions SET response_count = ? WHERE id = ?'
  ).bind(config.realtimeMaxResponses, meeting.meetingId).run();

  const turn = await session.handleTextMessage({ text: 'One more question.' });
  await settle(durable, session);

  // The client keeps the reply they paid for; there is simply no next turn.
  equal(turn.ok, true, 'the turn already in flight still answers the client');
  ok(turn.assistantText, 'and they keep that answer');
  equal(turn.closed, 'budget_exhausted', 'the reply tells the client the meeting has reached its limit');
  equal(
    (await getRealtimeLease(meeting.env, meeting.sessionId, meeting.meetingId)).status,
    'budget_exhausted',
    'metering a typed turn enforces the allowance -- it is not enough for the check to merely exist'
  );
  models.restore();
}

console.log(`[LiveTypedLifecycle] ${checks} checks passed.`);
