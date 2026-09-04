/**
 * The REAL live Durable Object, on a real local D1.
 *
 * WHY THIS MODULE EXISTS. `fakeDurableState` had been copied into
 * check-consumer-live-feedback.mjs, check-consumer-reconciliation-scheduler.mjs
 * and check-consumer-live.mjs, and each copy had drifted: one records alarms,
 * one does not, none of them can tell you when the background work has actually
 * finished. Phase 4 needs the last of those, because the whole question it asks
 * is what happens AFTER the reply — so the rig is stated once, here.
 *
 * NOTHING IN THE LANE IS STUBBED BY THIS FILE. It builds a real
 * `ConsumerLiveSession` over a real migrated SQLite-backed D1 with real
 * encryption, and hands back the socket the Worker talks to. The two things a
 * test cannot own — the provider socket and the model behind it — are supplied
 * by the caller.
 */

import { ConsumerLiveSession } from '../../worker/src/consumer/live/live_session.js';
import {
  makeConfig,
  makeEnv,
  newDatabase,
  newSession
} from '../agent-harness/transports.mjs';

/** A meeting lease that will not expire during a harness run. */
const FUTURE = '2035-01-01T00:00:00.000Z';

/**
 * Durable Object storage, plus the one thing the existing copies lack: a record
 * of every `waitUntil` promise, so a caller can wait for the detached work.
 */
export function fakeDurableState(initial = {}) {
  const values = new Map(Object.entries(initial));
  const alarms = [];
  const waitUntilPromises = [];
  let initialization;
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async deleteAll() { values.clear(); },
    async setAlarm(deadline) { alarms.push(Number(deadline)); }
  };
  return {
    state: {
      storage,
      blockConcurrencyWhile(callback) { initialization = Promise.resolve(callback()); },
      waitUntil(promise) { waitUntilPromises.push(Promise.resolve(promise).catch(() => {})); }
    },
    values,
    alarms,
    waitUntilPromises,
    initialized: () => initialization
  };
}

/**
 * The provider sideband, from the Worker's side.
 *
 * Everything the Durable Object pushes at the model lands here in order, which
 * is the only way to observe the two things that have never had an end-to-end
 * test: the tool result the model is handed back, and the refreshed state item
 * that reaches it after the background planner has corrected the record.
 */
function recordingProviderSocket() {
  const sent = [];
  return {
    socket: {
      readyState: 1,
      send(text) { sent.push(JSON.parse(text)); }
    },
    sent,
    /** Tool results, in the shape the model receives them. */
    toolOutputs: () => sent
      .filter((event) => event?.item?.type === 'function_call_output')
      .map((event) => ({ callId: event.item.call_id, output: event.item.output })),
    /** The volatile state notes pushed into the conversation. */
    stateItems: () => sent
      .filter((event) => event?.type === 'conversation.item.create'
        && event?.item?.role === 'system'
        && event?.item?.type === 'message')
      .map((event) => String(event.item.content?.[0]?.text || ''))
  };
}

/**
 * A migrated database, a consented session and an active meeting lease.
 *
 * `apply` is the default because a harness that silently ran the reconciler in
 * legacy mode would report a green Phase 4 while testing nothing. Production
 * fails closed to legacy; this is a disposable local database with synthetic
 * data, so it fails closed the other way — loudly, by testing what it claims.
 */
export async function newLiveMeeting(label, envOverrides = {}) {
  const databasePath = newDatabase(label);
  const env = makeEnv(databasePath, {
    CONSUMER_PLANNER_RECONCILIATION_MODE: 'apply',
    CONSUMER_LIVE_VOICE_ENABLED: 'true',
    ...envOverrides
  });
  const config = makeConfig(env);
  const { sessionId, meetingId } = await newSession(env, config);
  return { env, config, sessionId, meetingId, databasePath };
}

/** Bind a live Durable Object to that meeting. */
export async function attachLiveSession(meeting, { initial = {} } = {}) {
  const durable = fakeDurableState(initial);
  const session = new ConsumerLiveSession(durable.state, meeting.env);
  await durable.initialized();
  const provider = recordingProviderSocket();
  session.webSocket = provider.socket;
  session.meta = {
    sessionId: meeting.sessionId,
    leaseId: meeting.meetingId,
    hardExpiresAt: FUTURE,
    idleExpiresAt: FUTURE
  };
  return { session, durable, provider };
}

/**
 * Wait for everything the Durable Object detached.
 *
 * THE RESPONSE PATH IS NOT ALLOWED TO WAIT FOR ANY OF THIS — that is the
 * architecture under test, and the harness measures it separately. This is the
 * observer waiting, after the reply, so it can look at what the background pass
 * actually did. Draining is iterative because a reconciliation drain schedules
 * further work as it goes: a single `Promise.all` would return before the queue
 * it started had finished.
 */
export async function settle(durable, session, { timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = durable.waitUntilPromises.splice(0);
    await Promise.allSettled([
      ...pending,
      session.eventChain,
      session.reconciliationPersistenceChain,
      session.reconciliationChain,
      session.directModulePlanningChain
    ]);
    // Let any continuation those settled promises queued actually run before
    // deciding the session is idle.
    await new Promise((resolve) => setImmediate(resolve));
    const quiet = durable.waitUntilPromises.length === 0
      && !session.reconciliationDrainScheduled
      && !session.activeReconciliationTurn
      && session.directModulePlanningPending === 0;
    if (quiet) return;
    if (Date.now() > deadline) {
      throw new Error('settle() timed out waiting for detached Durable Object work');
    }
  }
}
