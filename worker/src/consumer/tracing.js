/**
 * Live-call tracing.
 *
 * WHAT THIS IS FOR. One voice turn is not one model call. It is a speculative
 * planner pre-fetch fired while the client is still talking, then a clause-by-
 * clause extraction running concurrently, then possibly a recovery read, then a
 * repair pass over whatever the engine refused, then the director rewriting the
 * question into speech, then controlled TTS -- and on the live lane, a
 * compliance supervisor reviewing what was said afterwards. Until now the whole
 * of that produced a single console line. This module is what turns it into a
 * tree you can read.
 *
 * NO SDK, DELIBERATELY. The Langfuse JS SDK is built on the OpenTelemetry Node
 * SDK, which needs Node APIs this runtime does not have. It speaks OTLP/HTTP
 * JSON instead, over plain `fetch`, which Langfuse accepts natively -- the same
 * wire format and the same builder shape as the harness twin in
 * scripts/lib/langfuse.mjs and the telemetry service's OTLP exporter.
 *
 * THE CONTENT RULE, WHICH IS THE POINT OF THIS FILE.
 *
 *   Prompts, completions and transcripts leave this worker ONLY for a cohort
 *   named in CONSUMER_AGENT_TEST_COHORTS.
 *
 * Note what that does NOT include: the "internal" cohort. Production runs
 * "internal" (worker/wrangler.toml:86). The name invites exactly the wrong
 * assumption, so the gate is written against the agent-test list, which is the
 * closed list production's cohort is deliberately absent from.
 *
 * A real member of the public gets metadata: model, tokens, latency, cost,
 * status, error code, and the shape of the tree. No text. That is not a policy
 * a call site is asked to remember -- `buildGenerationSpan` takes `content` and
 * `metadata` as separate arguments and DISCARDS the content itself unless the
 * cohort allows it, so a new call site cannot leak by forgetting a check. The
 * mask is the same discipline as `maskLangfuseGeneration` in the telemetry
 * service, for the same reason.
 *
 * And even inside a test cohort, content still goes through
 * `redactSensitiveIdentifiers`. A PPS number does not leave this worker for
 * anybody, in any cohort, ever.
 *
 * IT NEVER TOUCHES THE CALL. Spans buffer in memory and ship once, in
 * `waitUntil`, after the response has gone. Every failure is swallowed. A call
 * degrades for no reason that lives in this file.
 */

import { sha256Base64Url } from './crypto.js';
import { redactSensitiveIdentifiers } from './validators.js';

const OTLP_TRACES_PATH = '/api/public/otel/v1/traces';
// Declares the ingestion version. Without it Langfuse v4 still returns 200 but
// routes the span through a slow path that can take ten minutes to surface --
// long enough that a live call looks untraced. Kept identical to the harness
// twin in scripts/lib/langfuse.mjs.
const INGESTION_HEADERS = Object.freeze({ 'x-langfuse-ingestion-version': '4' });
const REQUEST_TIMEOUT_MS = 4_000;
const MAX_CONTENT_CHARS = 8_000;
const MAX_SPANS_PER_FLUSH = 256;

/**
 * The ONLY metadata keys that may leave, mirroring the Langfuse
 * generation_field_allowlist in services/learning-signals/config/observability.yaml.
 * Deny-by-default: a key added to a call site's metadata object is invisible
 * here until it is added on purpose, and reviewed as a disclosure when it is.
 *
 * Nothing on this list is conversational content. Ids are opaque and carry no
 * message-derived value; session ids must be hashed by the caller before they
 * reach this module.
 */
const METADATA_ALLOWLIST = Object.freeze(new Set([
  'lane',
  'stage',
  'turnIndex',
  'model',
  'modelTier',
  'reasoningEffort',
  'promptVersion',
  'schemaVersion',
  'toolsetVersion',
  'pricingVersion',
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'latencyMs',
  'costMicros',
  'responseStatus',
  'incompleteReason',
  'errorCode',
  'clientRequestId',
  'providerRequestId',
  'providerResponseId',
  // The provider's own classification of a failure. Categorical, and the
  // difference between diagnosing an auth problem and a quota problem —
  // see readPlannerProviderError in realtime_planner.js.
  'providerStatus',
  'providerErrorType',
  'providerErrorCode',
  'providerErrorParam',
  'reasoningTokens',
  'segmentIndex',
  'segmentCount',
  'segmentsFailed',
  // How much of a turn was answered by work started before the client stopped
  // talking. The number that says whether speculation is paying for itself.
  'prefetchedCount',
  'speculative',
  'invalidated',
  'retried',
  'retryOfFastFailure',
  // Whether the director produced the spoken line or the deterministic template
  // did. Indistinguishable after the fact without this.
  'directed',
  'toolName',
  'refused'
]));

/** Span attribute names Langfuse maps onto its own model. Kept identical to the harness twin. */
const ATTR = Object.freeze({
  observationType: 'langfuse.observation.type',
  input: 'langfuse.observation.input',
  output: 'langfuse.observation.output',
  level: 'langfuse.observation.level',
  statusMessage: 'langfuse.observation.status_message',
  metadataPrefix: 'langfuse.observation.metadata.',
  traceName: 'langfuse.trace.name',
  sessionId: 'langfuse.session.id',
  tags: 'langfuse.trace.tags',
  release: 'langfuse.release',
  environment: 'langfuse.environment',
  system: 'gen_ai.system',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  inputTokens: 'gen_ai.usage.prompt_tokens',
  outputTokens: 'gen_ai.usage.completion_tokens',
  // No cachedInputTokens entry, deliberately. Every gen_ai.usage.* number is
  // summed into the total by Langfuse, and cached tokens are a SUBSET of
  // input_tokens rather than an addition to it, so any attribute in this
  // namespace would double-count them. See the comment at the emit site.
  cost: 'gen_ai.usage.cost'
});

/**
 * Fail-closed, exactly like `isLearningSignalsConfigured`. Four things must all
 * be true before a single byte leaves; the committed defaults make sure they
 * are not, so merging this changes nothing about a live call.
 */
export function isTracingConfigured(env) {
  return Boolean(
    env
    && typeof env.LANGFUSE_PUBLIC_KEY === 'string' && env.LANGFUSE_PUBLIC_KEY.trim()
    && typeof env.LANGFUSE_SECRET_KEY === 'string' && env.LANGFUSE_SECRET_KEY.trim()
    && typeof env.LANGFUSE_HOST === 'string' && env.LANGFUSE_HOST.trim().startsWith('https://')
    && String(env.CONSUMER_TRACING_ENABLED || '').trim().toLowerCase() === 'true'
  );
}

/**
 * Whether this cohort's conversation text may leave the worker.
 *
 * TRUE ONLY FOR THE AGENT-TEST COHORTS. Not for "internal" -- read
 * worker/wrangler.toml:86 before changing this: PRODUCTION RUNS THE "internal"
 * COHORT. The name reads like a staging label and is nothing of the sort, and
 * treating it as one here would export the conversation of every real caller.
 *
 * `CONSUMER_AGENT_TEST_COHORTS` is the codebase's existing answer to "is this
 * deployment one of ours" -- a closed list, defaulting to the two test cohorts,
 * which production's cohort is deliberately not in. This reuses that gate rather
 * than inventing a second one that could disagree with it.
 */
export function traceContentAllowed(config) {
  const cohort = String(config?.cohort || '').trim().toLowerCase();
  if (!cohort) return false;
  const testCohorts = config?.agentTestCohorts;
  if (!Array.isArray(testCohorts) || testCohorts.length === 0) return false;
  return testCohorts.includes(cohort);
}

/**
 * Whether this call should be traced at all.
 *
 * A cohort we run ourselves is always sampled -- the whole point is that our own
 * test calls are debuggable. Everything else is subject to the configured
 * percentage, which ships at 0.
 */
export function shouldSampleTrace(config, roll = Math.random()) {
  if (traceContentAllowed(config)) return true;
  const percent = Number(config?.tracingSamplePercent || 0);
  if (!(percent > 0)) return false;
  return roll * 100 < percent;
}

/** Keeps allowlisted primitives and nothing else. */
export function maskMetadata(raw) {
  const masked = {};
  if (!raw || typeof raw !== 'object') return masked;
  for (const key of METADATA_ALLOWLIST) {
    const value = raw[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      masked[key] = value;
    }
  }
  return masked;
}

/**
 * Redacts and bounds a piece of conversation text.
 *
 * Applied to content that is ALREADY cleared to leave. Redaction is not the
 * cohort gate -- it is the floor under it, so that the one cohort allowed to
 * export text still cannot export an identifier.
 */
export function safeContent(value) {
  if (value === undefined || value === null) return null;
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (_error) {
    return null;
  }
  if (typeof text !== 'string' || !text) return null;
  const redacted = redactSensitiveIdentifiers(text);
  return redacted.length <= MAX_CONTENT_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_CONTENT_CHARS)}…[truncated]`;
}

function attribute(key, value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (Array.isArray(value)) {
    return { key, value: { arrayValue: { values: value.map((item) => ({ stringValue: String(item) })) } } };
  }
  return { key, value: { stringValue: String(value) } };
}

function attributesFrom(entries) {
  return entries.map(([key, value]) => attribute(key, value)).filter((item) => item !== null);
}

function nanos(milliseconds) {
  return String(BigInt(Math.max(0, Math.trunc(Number(milliseconds) || 0))) * 1_000_000n);
}

/**
 * The session handle a trace may carry.
 *
 * Turns of one call have to group together in the UI, which needs a stable id --
 * but the raw session id is the handle that reaches that caller's stored data,
 * and it is not something to publish to a third party. A hash groups exactly as
 * well and reverses into nothing.
 */
export async function hashedTraceSessionId(sessionId) {
  const value = String(sessionId || '').trim();
  if (!value) return null;
  try {
    return (await sha256Base64Url(`langfuse-session:${value}`)).slice(0, 32);
  } catch (_error) {
    return null;
  }
}

export function newTraceId() {
  return crypto.randomUUID().replace(/-/g, '');
}

export function newSpanId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * Builds one span.
 *
 * `content` and `metadata` are separate arguments on purpose. Metadata is
 * masked to the allowlist; content is dropped entirely unless the cohort allows
 * it. A caller cannot opt out of either, and passing content for a public
 * cohort is not an error -- it simply does not survive this function.
 *
 * @param {object} options
 * @param {object} options.config resolved consumer config, for the cohort gate
 * @param {object} [options.content] `{input, output}` — dropped unless allowed
 * @param {object} [options.metadata] masked to METADATA_ALLOWLIST
 */
export function buildGenerationSpan({
  traceId,
  spanId,
  parentSpanId,
  name,
  config,
  observationType = 'generation',
  content,
  metadata,
  model,
  usage,
  costEur,
  level,
  errorCode,
  startedAt,
  endedAt,
  isRoot = false,
  sessionIdHash,
  tags,
  release,
  environment
} = {}) {
  const contentAllowed = traceContentAllowed(config);

  const attributes = attributesFrom([
    [ATTR.observationType, observationType],
    [ATTR.level, level || (errorCode ? 'ERROR' : null)],
    // An error CODE is not content: it is one of a fixed set this worker
    // defines, and it is the single most useful thing to see on a failed turn.
    [ATTR.statusMessage, errorCode || null],
    [ATTR.system, model ? 'openai' : null],
    [ATTR.requestModel, model],
    [ATTR.responseModel, model],
    [ATTR.inputTokens, usage?.inputTokens],
    [ATTR.outputTokens, usage?.outputTokens],
    // Cached tokens are NOT sent under gen_ai.usage.*. Measured against a live
    // project: Langfuse SUMS every gen_ai.usage.* number into the total, and
    // OpenAI's input_tokens already contains the cached ones — so 2000 + 250 +
    // 1500 was reported as 3750 rather than 2250, inflating every cost figure
    // derived from it. They ride as metadata instead, below.
    [ATTR.cost, costEur]
  ]);

  if (contentAllowed) {
    attributes.push(...attributesFrom([
      [ATTR.input, safeContent(content?.input)],
      [ATTR.output, safeContent(content?.output)]
    ]));
  }

  if (isRoot) {
    attributes.push(...attributesFrom([
      [ATTR.traceName, name],
      [ATTR.sessionId, sessionIdHash],
      [ATTR.tags, tags],
      [ATTR.release, release],
      [ATTR.environment, environment]
    ]));
  }

  // Cached tokens are kept, just out of the usage totals: metadata is not
  // summed, so the number stays visible and stays honest. `cachedInputTokens`
  // is already on METADATA_ALLOWLIST, so this survives the mask, and a call
  // site that puts it in metadata itself still wins.
  const maskedWithCache = maskMetadata({
    ...(usage?.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
    ...(metadata || {})
  });
  attributes.push(...attributesFrom(
    Object.entries(maskedWithCache).map(([key, value]) => [`${ATTR.metadataPrefix}${key}`, value])
  ));
  // Recorded so a trace states its own disclosure level rather than leaving a
  // reader to infer from absent text whether a turn was silent or masked.
  attributes.push(...attributesFrom([[`${ATTR.metadataPrefix}contentCaptured`, contentAllowed]]));

  const start = Number(startedAt) || Date.now();
  return {
    traceId: traceId || newTraceId(),
    spanId: spanId || newSpanId(),
    ...(parentSpanId ? { parentSpanId } : {}),
    name: String(name || 'span'),
    kind: 1,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(Math.max(start, Number(endedAt) || start)),
    attributes
  };
}

/**
 * A per-turn span buffer.
 *
 * Created per request, and per turn inside the realtime Durable Objects -- a
 * call lives for minutes and a session-long buffer would hold spans that should
 * already have shipped. Never module-global: one isolate serves concurrent
 * requests, and a shared buffer would put two callers' turns in one trace.
 */
export function createTraceCollector({ env, config, sessionIdHash, lane, sampled } = {}) {
  const active = Boolean(
    sampled !== false
    && isTracingConfigured(env)
    && (sampled === true || shouldSampleTrace(config))
  );
  const traceId = newTraceId();
  const spans = [];

  const collector = {
    active,
    traceId,
    lane,

    /** Opens a span and returns its id, for use as a parent. */
    startSpan() {
      return { spanId: newSpanId(), startedAt: Date.now() };
    },

    /**
     * Records a finished span. Silently does nothing when inactive, so call
     * sites need no conditional.
     */
    record(options = {}) {
      if (!active || spans.length >= MAX_SPANS_PER_FLUSH) return;
      spans.push(buildGenerationSpan({
        ...options,
        traceId,
        config,
        sessionIdHash,
        environment: config?.cohort,
        metadata: { lane, ...(options.metadata || {}) }
      }));
    },

    /** How many spans are waiting. Exposed for assertions, not for control flow. */
    get size() { return spans.length; },

    /** The OTLP request body, or null when there is nothing to send. */
    payload() {
      if (spans.length === 0) return null;
      return {
        resourceSpans: [{
          resource: {
            attributes: attributesFrom([
              ['service.name', 'planeir-consumer-worker'],
              ['deployment.environment', config?.cohort]
            ])
          },
          scopeSpans: [{ scope: { name: 'planeir.consumer' }, spans: spans.slice() }]
        }]
      };
    },

    /**
     * Ships and clears the buffer. Resolves to a boolean; never rejects, never
     * throws. Call inside waitUntil, never in the response path.
     */
    async flush() {
      if (!active) return false;
      const body = collector.payload();
      spans.length = 0;
      if (!body) return false;
      try {
        const authorization = btoa(
          `${String(env.LANGFUSE_PUBLIC_KEY).trim()}:${String(env.LANGFUSE_SECRET_KEY).trim()}`
        );
        const response = await fetch(new URL(OTLP_TRACES_PATH, String(env.LANGFUSE_HOST).trim()), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Basic ${authorization}`,
            ...INGESTION_HEADERS
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        return response.ok;
      } catch (_error) {
        // Telemetry delivery is never a call-affecting event.
        return false;
      }
    }
  };
  return collector;
}

/**
 * Hands a collector's flush to the platform's background work.
 *
 * Takes the ExecutionContext (or a Durable Object state) so the call path is
 * already finished when delivery runs. A missing context is not an error --
 * it means there is nowhere safe to do the work, so the spans are dropped.
 */
export function flushTraces(collector, ctx) {
  if (!collector?.active) return;
  const waitUntil = typeof ctx?.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : null;
  if (!waitUntil) return;
  try {
    waitUntil(collector.flush());
  } catch (_error) {
    // Nothing a failed hand-off can usefully do to a call in progress.
  }
}

export const __testing = Object.freeze({ ATTR, METADATA_ALLOWLIST, attributesFrom, nanos });
