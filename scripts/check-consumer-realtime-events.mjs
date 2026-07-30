import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  REALTIME_EVENT_SCHEMA,
  sanitizeRealtimeEventPayload
} from '../worker/src/consumer/realtime_event_schema.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const sessionSource = readFileSync(`${root}/worker/src/consumer/realtime_session.js`, 'utf8');
const eventTypeExpressions = [...sessionSource.matchAll(
  /eventType:\s*([\s\S]*?)(?=,\s*\n\s*payload:)/g
)].map((match) => match[1]);
const emittedEventTypes = new Set();
for (const expression of eventTypeExpressions) {
  for (const match of expression.matchAll(/['"](realtime\.[a-z0-9_.]+)['"]/g)) {
    emittedEventTypes.add(match[1]);
  }
}

const expectedEmitterTypes = [
  'realtime.analysis_plan.updated',
  'realtime.call.activated',
  'realtime.call.closed',
  'realtime.greeting.authorized',
  'realtime.planner.accounting_failed',
  'realtime.planner.apply_failed',
  'realtime.planner.catchup_completed',
  'realtime.planner.catchup_failed',
  'realtime.planner.completed',
  'realtime.planner.deferred',
  'realtime.planner.degraded',
  'realtime.planner.degraded_failed',
  'realtime.planner.refresh_failed',
  'realtime.provider.connected',
  'realtime.provider.error',
  'realtime.reasoning.escalation',
  'realtime.response.completed',
  'realtime.response.first_output',
  'realtime.response.interrupted',
  'realtime.response.started',
  'realtime.silence.prompt_authorized',
  'realtime.speech.authorized',
  'realtime.spoken_completion.failed',
  'realtime.spoken_completion.ready',
  'realtime.tool.completed',
  'realtime.vad.speech_started',
  'realtime.vad.speech_stopped'
];
assert.deepEqual([...emittedEventTypes].sort(), expectedEmitterTypes);

for (const eventType of emittedEventTypes) {
  assert.ok(REALTIME_EVENT_SCHEMA[eventType], `${eventType} is emitted without an operational event schema.`);
}

for (const [eventType, definition] of Object.entries(REALTIME_EVENT_SCHEMA)) {
  assert.doesNotMatch(eventType, /audio|delta|transcript/i);
  for (const fieldName of Object.keys(definition.fields)) {
    assert.doesNotMatch(
      fieldName,
      /audio|transcript|promptText|instructions|arguments|result|content/i,
      `${eventType}.${fieldName} could retain conversation content.`
    );
  }
}

assert.deepEqual(sanitizeRealtimeEventPayload('realtime.vad.speech_started', {
  duringResponse: true,
  transcript: 'must never be persisted'
}), { duringResponse: true });
assert.deepEqual(sanitizeRealtimeEventPayload('realtime.greeting.authorized', {
  kind: 'greeting',
  characterCount: 83,
  text: 'must never be persisted'
}), { kind: 'greeting', characterCount: 83 });
assert.deepEqual(sanitizeRealtimeEventPayload('realtime.silence.prompt_authorized', {
  idleExpiresAt: '2026-07-16T12:00:00.000Z',
  prompt: 'must never be persisted'
}), { idleExpiresAt: '2026-07-16T12:00:00.000Z' });
assert.deepEqual(sanitizeRealtimeEventPayload('realtime.call.closed', {
  reason: 'consumer_ended',
  status: 'complete',
  errorCode: null,
  durationMs: 42_000,
  estimatedCostEurMicros: 123_456,
  responseCount: 4,
  toolCallCount: 3,
  transcript: 'must never be persisted'
}), {
  reason: 'consumer_ended',
  status: 'complete',
  errorCode: null,
  durationMs: 42_000,
  estimatedCostEurMicros: 123_456,
  responseCount: 4,
  toolCallCount: 3
});
assert.equal(sanitizeRealtimeEventPayload('realtime.audio.delta', { audio: 'raw' }), null);
assert.equal(sanitizeRealtimeEventPayload('realtime.unknown', {}), null);
assert.deepEqual(sanitizeRealtimeEventPayload('realtime.response.first_output', {
  latencyMs: Number.NaN
}), {});

console.log(`Realtime operational event schema covers ${emittedEventTypes.size} emitter types without content fields.`);
