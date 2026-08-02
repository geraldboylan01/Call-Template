import assert from 'node:assert/strict';

import {
  buildSessionSummary,
  emitSessionSummary,
  isLearningSignalsConfigured,
  mapCause,
  mapSessionOutcome,
  __test,
} from '../worker/src/consumer/learning_signals.js';

// ---------------------------------------------------------------------------
// Configuration gating: absent env vars => complete no-op (no delivery).
// ---------------------------------------------------------------------------
assert.equal(isLearningSignalsConfigured(undefined), false);
assert.equal(isLearningSignalsConfigured({}), false);
assert.equal(
  isLearningSignalsConfigured({ LEARNING_SIGNALS_URL: 'x', LEARNING_SIGNALS_INGEST_KEY: 'y' }),
  false,
  'must require all three vars',
);
assert.equal(
  isLearningSignalsConfigured({
    LEARNING_SIGNALS_URL: 'http://localhost:3000',
    LEARNING_SIGNALS_INGEST_KEY: 'k',
    LEARNING_SIGNALS_MODULE_ID: 'm',
    LEARNING_SIGNALS_RETENTION_DAYS: '30',
  }),
  true,
);

// emitSessionSummary is a no-op when unconfigured: it must not schedule work
// and must not throw.
{
  let scheduled = 0;
  emitSessionSummary({}, () => { scheduled += 1; }, { sessionId: 'cs_x', status: 'completed' });
  assert.equal(scheduled, 0, 'unconfigured emit must schedule nothing');
}

// emitSessionSummary never throws even with a hostile waitUntil / bad input.
emitSessionSummary(
  { LEARNING_SIGNALS_URL: 'http://x', LEARNING_SIGNALS_INGEST_KEY: 'k', LEARNING_SIGNALS_MODULE_ID: 'm', LEARNING_SIGNALS_RETENTION_DAYS: '30' },
  () => { throw new Error('boom'); },
  { sessionId: 'cs_x', status: 'completed' },
);
emitSessionSummary({ LEARNING_SIGNALS_URL: 'http://x', LEARNING_SIGNALS_INGEST_KEY: 'k', LEARNING_SIGNALS_MODULE_ID: 'm', LEARNING_SIGNALS_RETENTION_DAYS: '30' }, () => {}, null);

// ---------------------------------------------------------------------------
// Outcome + cause mapping.
// ---------------------------------------------------------------------------
assert.equal(mapSessionOutcome('completed'), 'completed');
assert.equal(mapSessionOutcome('abandoned'), 'abandoned');
assert.equal(mapSessionOutcome('idle'), 'abandoned');
assert.equal(mapSessionOutcome('failed'), 'failed');
assert.equal(mapSessionOutcome('totally-unknown'), 'failed', 'unknown status fails safe');

assert.deepEqual(mapCause('sideband_lost', 'failed'), { causeClass: 'technical', causeDetail: 'network_dropout' });
assert.deepEqual(mapCause('provider_error', 'failed'), { causeClass: 'technical', causeDetail: 'provider_error' });
assert.deepEqual(mapCause('user_ended', 'abandoned'), { causeClass: 'non_technical', causeDetail: 'user_ended' });
assert.deepEqual(mapCause('silence_timeout', 'abandoned'), { causeClass: 'non_technical', causeDetail: 'timeout' });
assert.deepEqual(mapCause('mystery', 'failed'), { causeClass: 'technical', causeDetail: 'technical_failure' }, 'unknown failure => technical');
assert.deepEqual(mapCause('mystery', 'abandoned'), { causeClass: 'non_technical', causeDetail: 'other' });

// ---------------------------------------------------------------------------
// Built summary shape + the privacy invariant: no raw reason ever appears, and
// every cause_detail is a member of the fixed enum.
// ---------------------------------------------------------------------------
function eventsByType(events) {
  return new Map(events.map((event) => [event.event_type, event]));
}

// A clean completed call.
{
  const activatedAtMs = Date.parse('2026-07-24T10:00:00.000Z');
  const nowMs = activatedAtMs + 180000;
  const { events } = buildSessionSummary({ status: 'completed', reason: 'user_ended', activatedAtMs, responseCount: 6, nowMs });
  const byType = eventsByType(events);
  assert.ok(byType.has('session.started'));
  assert.ok(byType.has('call.connected'));
  assert.ok(byType.has('session.completed'));
  assert.ok(!byType.has('call.dropped'), 'a completed call is not a drop');
  assert.equal(byType.get('session.completed').attrs.outcome, 'completed');
  assert.equal(byType.get('session.completed').attrs.turn_count, 6);
  assert.equal(byType.get('session.completed').duration_ms, 180000);
  assert.ok(!('abandonment_cause' in byType.get('session.completed').attrs), 'no cause when completed');
}

// A mid-call technical drop.
{
  const activatedAtMs = Date.parse('2026-07-24T10:00:00.000Z');
  const { events } = buildSessionSummary({ status: 'failed', reason: 'sideband_lost', activatedAtMs, responseCount: 2, nowMs: activatedAtMs + 45000 });
  const byType = eventsByType(events);
  assert.ok(byType.has('call.connected'), 'connected before dropping');
  assert.ok(byType.has('call.dropped'));
  assert.equal(byType.get('call.dropped').attrs.cause_class, 'technical');
  assert.equal(byType.get('session.completed').attrs.outcome, 'failed');
  assert.equal(byType.get('session.completed').attrs.abandonment_cause, 'technical');
}

// A connect failure (never activated).
{
  const { events } = buildSessionSummary({ status: 'failed', reason: 'provider_error', activatedAtMs: NaN, responseCount: 0, nowMs: Date.now() });
  const byType = eventsByType(events);
  assert.ok(byType.has('call.connect_failed'));
  assert.ok(!byType.has('call.connected'), 'never connected');
  assert.ok(!byType.has('call.dropped'));
  assert.equal(byType.get('call.connect_failed').attrs.cause_detail, 'provider_error');
  assert.ok(!('duration_ms' in byType.get('session.completed')), 'no duration without activation');
}

// The leak invariant: run a battery of raw reasons (some resembling PII / free
// text) and assert the serialized events never contain the raw reason and only
// use allowed enum values.
{
  const hostileReasons = [
    'client John Smith hume up angrily',
    'network dropped: 10.0.0.5 unreachable',
    'billing card 4111111111111111 declined',
    'sideband_lost',
    'completely novel provider phrase 42',
  ];
  for (const reason of hostileReasons) {
    for (const status of ['completed', 'failed', 'abandoned']) {
      const { events } = buildSessionSummary({ status, reason, activatedAtMs: Date.now() - 1000, responseCount: 3, nowMs: Date.now() });
      const serialized = JSON.stringify(events);
      assert.ok(!serialized.includes(reason), `raw reason leaked for status=${status}`);
      assert.ok(!serialized.includes('4111111111111111'), 'card number leaked');
      assert.ok(!serialized.includes('John Smith'), 'name leaked');
      assert.ok(!serialized.includes('10.0.0.5'), 'ip leaked');
      for (const event of events) {
        for (const key of ['cause_class', 'cause_detail', 'abandonment_cause']) {
          if (event.attrs && key in event.attrs) {
            if (key === 'cause_detail') {
              assert.ok(__test.ALLOWED_CAUSE_DETAILS.has(event.attrs[key]), `illegal cause_detail ${event.attrs[key]}`);
            } else {
              assert.ok(['technical', 'non_technical'].includes(event.attrs[key]), `illegal ${key}`);
            }
          }
        }
      }
    }
  }
}

console.log('check-learning-signals-emitter: all assertions passed');
