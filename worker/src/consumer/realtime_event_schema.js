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
    param: NON_CONTENT_FIELD_TYPES.NULLABLE_STRING,
    recoverable: NON_CONTENT_FIELD_TYPES.BOOLEAN,
    scope: NON_CONTENT_FIELD_TYPES.STRING
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
  'realtime.spoken_completion.ready': event({
    planId: NON_CONTENT_FIELD_TYPES.STRING,
    profileRevision: NON_CONTENT_FIELD_TYPES.INTEGER,
    confirmationTurnId: NON_CONTENT_FIELD_TYPES.STRING
  }),
  'realtime.spoken_completion.failed': event({
    planId: NON_CONTENT_FIELD_TYPES.STRING,
    code: NON_CONTENT_FIELD_TYPES.STRING
  }),
  'realtime.reasoning.escalation': event({
    requested: NON_CONTENT_FIELD_TYPES.STRING,
    applied: NON_CONTENT_FIELD_TYPES.BOOLEAN,
    reason: NON_CONTENT_FIELD_TYPES.STRING
  }),
  'realtime.planner.completed': event({
    sourceTurnId: NON_CONTENT_FIELD_TYPES.STRING,
    latencyMs: NON_CONTENT_FIELD_TYPES.INTEGER,
    acceptedCandidates: NON_CONTENT_FIELD_TYPES.INTEGER,
    rejectedCandidates: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  'realtime.planner.accounting_failed': event({
    sourceTurnId: NON_CONTENT_FIELD_TYPES.STRING,
    code: NON_CONTENT_FIELD_TYPES.STRING
  }),
  'realtime.planner.apply_failed': event({
    sourceTurnId: NON_CONTENT_FIELD_TYPES.STRING,
    code: NON_CONTENT_FIELD_TYPES.STRING
  }),
  'realtime.planner.refresh_failed': event({
    sourceTurnId: NON_CONTENT_FIELD_TYPES.STRING,
    code: NON_CONTENT_FIELD_TYPES.STRING
  }),
  // Carries the provider's own classification of the failure. Without these
  // fields a planner outage is indistinguishable from a schema bug, an auth
  // failure or a token-budget exhaustion — which is exactly what made the live
  // incident undiagnosable. All bounded and categorical; never conversation
  // content.
  'realtime.planner.deferred': event({
    sourceTurnId: NON_CONTENT_FIELD_TYPES.STRING,
    code: NON_CONTENT_FIELD_TYPES.STRING,
    providerStatus: NON_CONTENT_FIELD_TYPES.INTEGER,
    providerRequestId: NON_CONTENT_FIELD_TYPES.STRING,
    providerErrorType: NON_CONTENT_FIELD_TYPES.STRING,
    providerErrorCode: NON_CONTENT_FIELD_TYPES.STRING,
    providerErrorParam: NON_CONTENT_FIELD_TYPES.STRING,
    responseStatus: NON_CONTENT_FIELD_TYPES.STRING,
    incompleteReason: NON_CONTENT_FIELD_TYPES.STRING,
    outputTokens: NON_CONTENT_FIELD_TYPES.INTEGER,
    reasoningTokens: NON_CONTENT_FIELD_TYPES.INTEGER,
    plannerModel: NON_CONTENT_FIELD_TYPES.STRING
  }),
  'realtime.planner.catchup_completed': event({
    sourceTurnId: NON_CONTENT_FIELD_TYPES.STRING,
    latencyMs: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  'realtime.planner.catchup_failed': event({
    sourceTurnId: NON_CONTENT_FIELD_TYPES.STRING,
    code: NON_CONTENT_FIELD_TYPES.STRING
  }),
  // The AI planner failed and the deterministic rules extractor kept the
  // meeting going. Recorded so a degraded meeting is visibly distinct from a
  // healthy one, rather than looking identical in telemetry.
  // The deterministic fallback itself failed to persist. Distinct from
  // `degraded`, which means it succeeded.
  'realtime.planner.degraded_failed': event({
    sourceTurnId: NON_CONTENT_FIELD_TYPES.STRING,
    code: NON_CONTENT_FIELD_TYPES.STRING
  }),
  'realtime.planner.degraded': event({
    sourceTurnId: NON_CONTENT_FIELD_TYPES.STRING,
    code: NON_CONTENT_FIELD_TYPES.STRING,
    plannerModel: NON_CONTENT_FIELD_TYPES.STRING,
    degradedTurnCount: NON_CONTENT_FIELD_TYPES.INTEGER,
    acceptedCandidates: NON_CONTENT_FIELD_TYPES.INTEGER
  }),

  // ---------------------------------------------------------------------
  // Live conversational lane. Additive: no v1/v2 event changes meaning.
  //
  // The same bounded, non-content rule applies — nothing here carries a
  // transcript, a prompt, a tool argument or a figure. Compliance events
  // record WHICH act tripped and which layer caught it, never the words.
  // (Note the type names avoid "transcript"/"audio"/"delta": those are
  // rejected outright by FORBIDDEN_REALTIME_EVENT_TYPE below.)
  // ---------------------------------------------------------------------
  'live.call.activated': event({
    model: NON_CONTENT_FIELD_TYPES.STRING,
    promptVersion: NON_CONTENT_FIELD_TYPES.STRING
  }),
  'live.provider.connected': event({}),
  'live.provider.error': event({
    code: NON_CONTENT_FIELD_TYPES.NULLABLE_STRING,
    param: NON_CONTENT_FIELD_TYPES.NULLABLE_STRING,
    fatal: NON_CONTENT_FIELD_TYPES.BOOLEAN
  }),
  'live.client.turn': event({
    itemId: NON_CONTENT_FIELD_TYPES.STRING
  }),
  // THE THESIS MEASUREMENT: end of client speech to first output audio frame.
  // If this does not come down dramatically against the v2 lane, the whole
  // rebuild was not worth doing — see the plan's §6.6 stop condition.
  'live.response.first_output': event({
    latencyMs: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  'live.response.completed': event({
    toolCallCount: NON_CONTENT_FIELD_TYPES.INTEGER,
    estimatedCostEurMicros: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  'live.tool.completed': event({
    tool: NON_CONTENT_FIELD_TYPES.STRING,
    ok: NON_CONTENT_FIELD_TYPES.BOOLEAN,
    savedCount: NON_CONTENT_FIELD_TYPES.INTEGER,
    rejectedCount: NON_CONTENT_FIELD_TYPES.INTEGER,
    latencyMs: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  // A deterministic detector (L2/L3) cancelled a response mid-sentence.
  'live.compliance.tripped': event({
    actId: NON_CONTENT_FIELD_TYPES.STRING,
    layer: NON_CONTENT_FIELD_TYPES.STRING,
    violationCount: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  // The asynchronous supervisor (L4) returned a verdict on a completed turn.
  'live.compliance.reviewed': event({
    actId: NON_CONTENT_FIELD_TYPES.NULLABLE_STRING,
    confidence: NON_CONTENT_FIELD_TYPES.STRING,
    actionable: NON_CONTENT_FIELD_TYPES.BOOLEAN,
    latencyMs: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  'live.compliance.corrected': event({
    actId: NON_CONTENT_FIELD_TYPES.STRING,
    violationCount: NON_CONTENT_FIELD_TYPES.INTEGER
  }),
  'live.analysis.completed': event({
    completedCount: NON_CONTENT_FIELD_TYPES.INTEGER,
    status: NON_CONTENT_FIELD_TYPES.STRING
  }),
  'live.call.closed': event({
    reason: NON_CONTENT_FIELD_TYPES.STRING,
    status: NON_CONTENT_FIELD_TYPES.STRING,
    errorCode: NON_CONTENT_FIELD_TYPES.NULLABLE_STRING,
    durationMs: NON_CONTENT_FIELD_TYPES.NULLABLE_INTEGER,
    estimatedCostEurMicros: NON_CONTENT_FIELD_TYPES.INTEGER,
    responseCount: NON_CONTENT_FIELD_TYPES.INTEGER,
    violationCount: NON_CONTENT_FIELD_TYPES.INTEGER
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
