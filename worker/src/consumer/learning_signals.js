// Learning-signals emitter (integration Phase 1).
//
// This is the emit + minimisation layer that lets a realtime fact-find feed the
// privacy-first learning-signal service (services/learning-signals). It is a
// COMPLETE NO-OP unless three env vars are set, so merging it changes nothing
// about live calls until an operator deliberately switches it on:
//
//   LEARNING_SIGNALS_URL         base URL of the telemetry service
//   LEARNING_SIGNALS_INGEST_KEY  a tenant API key with the `ingest` scope
//   LEARNING_SIGNALS_MODULE_ID   the provisioned module id this planner maps to
//
// Guarantees, in order of importance:
//   1. It NEVER throws into the call path and NEVER blocks the call — delivery
//      runs in waitUntil and every failure is swallowed. Telemetry is
//      best-effort; a fact-find must never degrade because of it.
//   2. It emits ONLY minimised, categorical signals. Raw reasons/transcripts/
//      answers never leave: the provider's free-form `reason` is mapped to a
//      fixed enum here, and nothing else from the call is forwarded.

const OUTCOME_BY_STATUS = new Map([
  ['completed', 'completed'],
  ['abandoned', 'abandoned'],
  ['cancelled', 'abandoned'],
  ['expired', 'abandoned'],
  ['idle', 'abandoned'],
  ['failed', 'failed'],
]);

// Ordered technical matchers: if a reason code contains any of these fragments
// it is infrastructure, not the client's choice. Everything else is treated as
// non-technical. Only the mapped enum is ever emitted — never the raw reason.
const TECHNICAL_DETAIL_RULES = [
  [/sideband|connection|websocket|network|disconnect/, 'network_dropout'],
  [/provider|rate|quota|billing|upstream|api[_-]?key/, 'provider_error'],
  [/error|fail|hangup_uncertain|lost/, 'technical_failure'],
];
const NON_TECHNICAL_DETAIL_RULES = [
  [/decline|reject/, 'user_declined'],
  [/user|caller|hangup|ended|complete/, 'user_ended'],
  [/silence|idle|timeout|expire/, 'timeout'],
];

const ALLOWED_CAUSE_DETAILS = new Set([
  'technical_failure',
  'network_dropout',
  'provider_error',
  'user_ended',
  'user_declined',
  'timeout',
  'completed',
  'other',
]);

export function isLearningSignalsConfigured(env) {
  return Boolean(
    env
      && typeof env.LEARNING_SIGNALS_URL === 'string' && env.LEARNING_SIGNALS_URL.trim()
      && typeof env.LEARNING_SIGNALS_INGEST_KEY === 'string' && env.LEARNING_SIGNALS_INGEST_KEY.trim()
      && typeof env.LEARNING_SIGNALS_MODULE_ID === 'string' && env.LEARNING_SIGNALS_MODULE_ID.trim(),
  );
}

export function mapSessionOutcome(status) {
  return OUTCOME_BY_STATUS.get(String(status || '').toLowerCase()) || 'failed';
}

// Maps a free-form provider reason to a fixed {causeClass, causeDetail}. The
// raw reason is never returned. Unknown reasons fail to the safest bucket for
// their outcome (a failure we cannot classify is treated as technical).
export function mapCause(reason, outcome) {
  const text = String(reason || '').toLowerCase();
  for (const [pattern, detail] of TECHNICAL_DETAIL_RULES) {
    if (pattern.test(text)) return { causeClass: 'technical', causeDetail: detail };
  }
  for (const [pattern, detail] of NON_TECHNICAL_DETAIL_RULES) {
    if (pattern.test(text)) return { causeClass: 'non_technical', causeDetail: detail };
  }
  return outcome === 'failed'
    ? { causeClass: 'technical', causeDetail: 'technical_failure' }
    : { causeClass: 'non_technical', causeDetail: 'other' };
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Builds the minimised event batch for one finished call. Pure and
 * side-effect free so it can be unit-tested exhaustively for leaks. Every
 * attrs value is a fixed category, count, or bucket — never call content.
 */
export function buildSessionSummary({ status, reason, activatedAtMs, responseCount, nowMs = Date.now() }) {
  const outcome = mapSessionOutcome(status);
  const cause = mapCause(reason, outcome);
  const activated = Number.isFinite(activatedAtMs);
  const startIso = isoOrNull(activatedAtMs) || new Date(nowMs).toISOString();
  const endIso = new Date(nowMs).toISOString();
  const durationMs = activated ? Math.max(0, nowMs - activatedAtMs) : null;
  const turnCount = Math.max(0, Math.min(10000, Math.trunc(Number(responseCount) || 0)));

  const events = [];
  events.push({ event_type: 'session.started', attrs: { channel: 'voice', source: 'orchestrator' }, occurred_at: startIso });

  if (activated) {
    events.push({ event_type: 'call.connected', attrs: { channel: 'voice' }, occurred_at: startIso });
  } else if (outcome !== 'completed') {
    // Never reached the client: a connect failure, tagged with its cause.
    events.push({
      event_type: 'call.connect_failed',
      attrs: { cause_class: cause.causeClass, cause_detail: cause.causeDetail },
      occurred_at: endIso,
    });
  }

  // A technical failure after connecting is a mid-call drop.
  if (activated && outcome !== 'completed' && cause.causeClass === 'technical') {
    events.push({
      event_type: 'call.dropped',
      attrs: { cause_class: cause.causeClass, cause_detail: cause.causeDetail },
      occurred_at: endIso,
    });
  }

  const completedAttrs = { outcome, turn_count: turnCount };
  if (outcome !== 'completed') completedAttrs.abandonment_cause = cause.causeClass;
  const completed = {
    event_type: 'session.completed',
    attrs: completedAttrs,
    occurred_at: endIso,
  };
  if (durationMs !== null) completed.duration_ms = durationMs;
  events.push(completed);

  return { events };
}

async function postJson(env, path, body) {
  const base = env.LEARNING_SIGNALS_URL.replace(/\/+$/, '');
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.LEARNING_SIGNALS_INGEST_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`learning-signals ${path} ${response.status}`);
  return response.json();
}

export async function deliverSessionSummary(env, input) {
  const summary = buildSessionSummary(input);
  // Open the session (subject_ref is the opaque call id — non-identifying, and
  // the service pseudonymises it server-side), then ingest the batch against
  // the session id the service returns.
  const opened = await postJson(env, '/v1/sessions', {
    module_id: env.LEARNING_SIGNALS_MODULE_ID,
    subject_ref: String(input.sessionId),
  });
  const sessionId = opened && typeof opened.session_id === 'string' ? opened.session_id : null;
  if (!sessionId) return;
  const events = summary.events.map((event) => ({ ...event, session_id: sessionId, event_id: crypto.randomUUID() }));
  await postJson(env, '/v1/telemetry/events', { events });
}

/**
 * Fire-and-forget entry point. Call it from the session-termination hook. It
 * returns immediately; delivery (if configured) runs in waitUntil and cannot
 * throw into the caller.
 */
export function emitSessionSummary(env, waitUntil, input) {
  try {
    if (!isLearningSignalsConfigured(env)) return;
    if (!input || !input.sessionId) return;
    const schedule = typeof waitUntil === 'function' ? waitUntil : (promise) => { void promise; };
    schedule(deliverSessionSummary(env, input).catch(() => {}));
  } catch (_error) {
    // Telemetry must never affect the call.
  }
}

export const __test = { ALLOWED_CAUSE_DETAILS };
