const NON_CONTENT_FIELD_TYPES = Object.freeze({
  STRING: 'string',
  NULLABLE_STRING: 'nullable_string',
  BOOLEAN: 'boolean',
  INTEGER: 'integer',
  NULLABLE_INTEGER: 'nullable_integer'
});

function event(fields) {
  return Object.freeze({ fields: Object.freeze({ ...fields }) });
}

// This is the single allowlist for Realtime operational telemetry. It is
// intentionally limited to bounded, non-content fields: transcript, prompt,
// tool arguments/results and audio data have no representation here.
export const REALTIME_EVENT_SCHEMA = Object.freeze({
  'realtime.call.activated': event({
    model: NON_CONTENT_FIELD_TYPES.STRING,
    promptVersion: NON_CONTENT_FIELD_TYPES.STRING,
    toolsetVersion: NON_CONTENT_FIELD_TYPES.STRING
  }),
  'realtime.call.closed': event({
    reason: NON_CONTENT_FIELD_TYPES.STRING,
    status: NON_CONTENT_FIELD_TYPES.STRING,
    errorCode: NON_CONTENT_FIELD_TYPES.NULLABLE_STRING,
    durationMs: NON_CONTENT_FIELD_TYPES.NULLABLE_INTEGER,
    estimatedCostEurMicros: NON_CONTENT_FIELD_TYPES.INTEGER,
    responseCount: NON_CONTENT_FIELD_TYPES.INTEGER,
    toolCallCount: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  'realtime.provider.connected': event({}),
  'realtime.provider.disconnected': event({
    code: NON_CONTENT_FIELD_TYPES.NULLABLE_STRING
  }),
  'realtime.provider.error': event({
    code: NON_CONTENT_FIELD_TYPES.STRING,
    param: NON_CONTENT_FIELD_TYPES.NULLABLE_STRING
  }),
  'realtime.vad.speech_started': event({
    duringResponse: NON_CONTENT_FIELD_TYPES.BOOLEAN
  }),
  'realtime.vad.speech_stopped': event({}),
  'realtime.response.started': event({}),
  'realtime.response.first_output': event({
    latencyMs: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  'realtime.response.interrupted': event({
    latencyMs: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  'realtime.response.completed': event({
    responseCount: NON_CONTENT_FIELD_TYPES.INTEGER,
    estimatedCostMicroEur: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  'realtime.tool.received': event({
    toolName: NON_CONTENT_FIELD_TYPES.STRING
  }),
  'realtime.tool.completed': event({
    toolName: NON_CONTENT_FIELD_TYPES.STRING,
    status: NON_CONTENT_FIELD_TYPES.STRING,
    errorCode: NON_CONTENT_FIELD_TYPES.NULLABLE_STRING
  }),
  'realtime.greeting.authorized': event({
    kind: NON_CONTENT_FIELD_TYPES.STRING,
    characterCount: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  'realtime.speech.authorized': event({
    kind: NON_CONTENT_FIELD_TYPES.STRING,
    characterCount: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  'realtime.silence.prompt_authorized': event({
    idleExpiresAt: NON_CONTENT_FIELD_TYPES.STRING
  }),
  'realtime.analysis_plan.updated': event({
    planId: NON_CONTENT_FIELD_TYPES.STRING,
    status: NON_CONTENT_FIELD_TYPES.STRING,
    profileRevision: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  'realtime.reasoning.escalation': event({
    requested: NON_CONTENT_FIELD_TYPES.STRING,
    applied: NON_CONTENT_FIELD_TYPES.BOOLEAN,
    reason: NON_CONTENT_FIELD_TYPES.STRING
  })
});

const FORBIDDEN_REALTIME_EVENT_TYPE = /(?:audio|delta|transcript)/i;

function allowedValue(type, value) {
  if (type === NON_CONTENT_FIELD_TYPES.NULLABLE_STRING && value === null) return null;
  if (type === NON_CONTENT_FIELD_TYPES.NULLABLE_INTEGER && value === null) return null;
  if (type === NON_CONTENT_FIELD_TYPES.STRING || type === NON_CONTENT_FIELD_TYPES.NULLABLE_STRING) {
    return typeof value === 'string' ? value.slice(0, 160) : undefined;
  }
  if (type === NON_CONTENT_FIELD_TYPES.BOOLEAN) {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (type === NON_CONTENT_FIELD_TYPES.INTEGER || type === NON_CONTENT_FIELD_TYPES.NULLABLE_INTEGER) {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  return undefined;
}

export function sanitizeRealtimeEventPayload(eventType, payload) {
  const normalizedType = String(eventType || '').slice(0, 120);
  const schema = REALTIME_EVENT_SCHEMA[normalizedType];
  if (!schema || FORBIDDEN_REALTIME_EVENT_TYPE.test(normalizedType)) return null;
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {};
  const sanitized = {};
  for (const [fieldName, fieldType] of Object.entries(schema.fields)) {
    if (!Object.hasOwn(raw, fieldName)) continue;
    const value = allowedValue(fieldType, raw[fieldName]);
    if (value !== undefined) sanitized[fieldName] = value;
  }
  return sanitized;
}
