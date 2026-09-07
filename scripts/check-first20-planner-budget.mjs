#!/usr/bin/env node

/**
 * THE TURN'S CLOCK, NOT JUST EACH CALL'S.
 *
 * THE DEFECT THIS PINS. `modulePlannerTimeoutMs` bounds one provider call, and
 * nothing bounded the sequence -- but the sequence is what a waiting person
 * experiences. One typed request could run up to five calls per planning pass,
 * more than one pass per chain when a turn was queued mid-flight, and a whole
 * SECOND chain scheduled from the pre-confirmation `get_state` inside the same
 * request, with the renderer's own budget on top. Behind a browser that gave up
 * at sixty seconds, that meant a turn the server had completed was thrown away
 * and the client was told to retype an answer that had already landed.
 *
 * Speak had no bound here either. CONSUMER_REALTIME_PLANNER_TIMEOUT_MS = 8000
 * governs the separate legacy fact reconciler; the shared semantic planner runs
 * on modulePlannerTimeoutMs for both transports, and at the `get_state`
 * pre-confirmation boundary Speak BLOCKS on the whole chain exactly as Type
 * does. So the ceiling is armed at both boundaries with the same value.
 *
 * These checks drive the real Durable Object over a real migrated D1, so the
 * arming, its idempotence and the drain loop's refusal are proven rather than
 * asserted about.
 */
import assert from 'node:assert/strict';

import { newLiveMeeting, attachTypedSession, settle } from './live-harness/session.mjs';
import { recordRealtimeFinalTurn } from '../worker/src/consumer/realtime_repository.js';

let checks = 0;
const pass = (message) => { checks += 1; console.info(`[PlannerBudget] PASS: ${message}`); };

const meeting = await newLiveMeeting('first20-planner-budget', {
  CONSUMER_MODULE_PLANNER_MODE: 'apply',
  CONSUMER_MODULE_PLANNER_TURN_BUDGET_MS: '90000'
});
const { session, durable } = await attachTypedSession(meeting);

/* ---------------- background planning nobody waits for stays unbounded ---- */

assert.equal(session.directModulePlanningDeadlineAt, null,
  'a session at rest holds no ceiling: the background pass a voice turn schedules has nobody waiting on it');
pass('unarmed planning keeps its unbounded behaviour, because cutting it short would only lose work');

/* --------------------------------- arming is idempotent, which is the point */

const disarm = session.armDirectModulePlanningDeadline();
const armedAt = session.directModulePlanningDeadlineAt;
assert.ok(Number.isFinite(armedAt) && armedAt > Date.now(), 'a boundary arms an absolute ceiling');
assert.ok(armedAt - Date.now() <= 90_000, 'and it is the configured budget, not longer');

// A get_state inside a typed request must inherit that request's REMAINING
// budget. If arming again moved the ceiling, the second chain would simply buy
// itself a fresh ninety seconds and the bound would mean nothing.
const inner = session.armDirectModulePlanningDeadline();
assert.equal(session.directModulePlanningDeadlineAt, armedAt,
  'a nested boundary inherits the remaining budget and can never extend it');
inner();
assert.equal(session.directModulePlanningDeadlineAt, armedAt,
  'and releasing the nested boundary does not release the request that owns it');
disarm();
assert.equal(session.directModulePlanningDeadlineAt, null, 'the owning boundary releases it');
pass('a second planning chain inside one request inherits the remaining budget instead of starting a new one');

/* ------------------- no new pass is started past the ceiling --------------- */

// A REAL persisted client turn, because planning refuses to run without one --
// which is exactly how the first draft of this check managed to pass while
// proving nothing at all. The positive control below is what caught that.
const clientTurn = await recordRealtimeFinalTurn(meeting.env, {
  sessionId: meeting.sessionId,
  leaseId: meeting.meetingId,
  providerItemId: 'planner-budget-turn',
  role: 'user',
  transcript: 'My repayment mortgage balance is 240000 euro at 4.1 percent with 22 years remaining.'
});

let providerCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { providerCalls += 1; throw new Error('scripted: no real provider in this check'); };

const scheduleWithDeadline = async (deadlineAt) => {
  session.directModulePlanningOutstanding = [{ turnId: clientTurn.id, sequence: 1 }];
  session.directModulePlanningDeadlineAt = deadlineAt;
  session.scheduleDirectModulePlanning(clientTurn.id);
  await settle(durable, session, { timeoutMs: 30_000 });
};

try {
  // THE POSITIVE CONTROL RUNS FIRST, so a rig that cannot plan at all is caught
  // here rather than masquerading as a working ceiling.
  await scheduleWithDeadline(Date.now() + 90_000);
  assert.ok(providerCalls > 0, 'with budget remaining, the obligation does start a pass');
  const withBudget = providerCalls;

  // THE PASS THAT MUST NOT HAPPEN. Same obligation, same scheduling call, but
  // the budget is spent: starting here would spend money to miss a deadline
  // that has already passed.
  await scheduleWithDeadline(Date.now() - 1);
  assert.equal(providerCalls, withBudget, 'a spent budget starts no planning pass at all');
  assert.equal(session.directModulePlanningOutstanding.length, 1,
    'and the obligation is kept, not discarded: the next turn settles it');
} finally {
  globalThis.fetch = originalFetch;
  session.directModulePlanningDeadlineAt = null;
}
pass('the drain loop starts no new pass past the ceiling, and loses no obligation by refusing');

console.info(`[PlannerBudget] ${checks} checks passed.`);
