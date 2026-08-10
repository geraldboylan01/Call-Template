/**
 * Langfuse transport for the agent harness.
 *
 * WHY THERE IS NO SDK HERE. Two reasons, and the second is the binding one.
 * This repository has no dependencies at all, and the worker-side twin
 * (worker/src/consumer/tracing.js) has to run on Cloudflare Workers, where the
 * OTEL SDK the Langfuse JS SDK is built on needs Node APIs that do not exist.
 * Rather than have two different transports for the same backend, both sides
 * speak OTLP/HTTP JSON over plain `fetch` -- which Langfuse accepts natively --
 * and the payload builders are deliberately the same shape as the one the
 * telemetry service already hand-writes in
 * services/learning-signals/src/sinks/telemetry-sinks.ts.
 *
 * WHAT MAY GO THROUGH THIS MODULE. Synthetic harness data only: model-played
 * personas and the scenario library, which check-consumer-agent-scenarios
 * asserts is `synthetic: true`. This module applies no content mask, because
 * there is no real client content in a harness run to mask. The production path
 * is the other module, and it masks by construction. Do not point this one at a
 * real session.
 *
 * IT NEVER FAILS A RUN. A harness run that found a regression must still report
 * it when Langfuse is down, so every network failure here is swallowed and
 * counted, and an unconfigured environment returns a no-op client with the same
 * shape. No caller needs a null check, and no caller needs a try/catch.
 */

import { createHash } from 'node:crypto';

const OTLP_TRACES_PATH = '/api/public/otel/v1/traces';
const SCORES_PATH = '/api/public/scores';
const DEFAULT_HOST = 'https://cloud.langfuse.com';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTRIBUTE_CHARS = 20_000;

/**
 * WITHOUT THIS HEADER, A TRACE CAN TAKE TEN MINUTES TO APPEAR.
 *
 * Langfuse v4 accepts the span immediately either way -- the POST returns 200
 * -- but routes it through a slow path unless the ingestion version is declared,
 * and a run that polls for a couple of minutes concludes the trace was never
 * stored. It is not a correctness flag, it is the difference between a usable
 * feedback loop and one that looks broken.
 */
const INGESTION_HEADERS = Object.freeze({ 'x-langfuse-ingestion-version': '4' });

/**
 * Span attribute names Langfuse maps onto its own data model.
 *
 * The `langfuse.*` namespace takes precedence over the generic OpenTelemetry
 * GenAI conventions, so where both exist we send the explicit one. Token counts
 * and cost are the exception: they are sent under `gen_ai.usage.*`, which is
 * the form Langfuse reads reliably today.
 */
const ATTR = Object.freeze({
  observationType: 'langfuse.observation.type',
  input: 'langfuse.observation.input',
  output: 'langfuse.observation.output',
  level: 'langfuse.observation.level',
  statusMessage: 'langfuse.observation.status_message',
  metadataPrefix: 'langfuse.observation.metadata.',
  traceName: 'langfuse.trace.name',
  traceInput: 'langfuse.trace.input',
  traceOutput: 'langfuse.trace.output',
  sessionId: 'langfuse.session.id',
  userId: 'langfuse.user.id',
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

/** 32 hex characters, as OTLP requires for a trace id. */
function newTraceId() {
  return crypto.randomUUID().replace(/-/g, '');
}

/** 16 hex characters, as OTLP requires for a span id. */
function newSpanId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * Ids derived from a stable seed rather than at random.
 *
 * This is what lets grading work. A call is traced when it runs; you grade it
 * hours later from the archived record, and the human grades have to land on
 * the trace that already exists. Seeding from `runId:callId` means the grading
 * pass recomputes the same id instead of needing one stored -- and the archive
 * format does not have to change. Same slicing as the telemetry service's OTLP
 * exporter (services/learning-signals/src/sinks/telemetry-sinks.ts:406).
 */
export function deterministicIds(seed) {
  const digest = createHash('sha256').update(String(seed)).digest('hex');
  return { traceId: digest.slice(0, 32), spanId: digest.slice(32, 48) };
}

function nanos(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  return String(BigInt(Math.max(0, Math.trunc(milliseconds))) * 1_000_000n);
}

/**
 * Serialises a value for an attribute that carries structured content. Bounded,
 * because a whole conversation can be arbitrarily long and an OTLP request that
 * is rejected for size loses the entire batch, not just the oversized span.
 */
function boundedText(value, maximum = MAX_ATTRIBUTE_CHARS) {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') return null;
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…[truncated]`;
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
  return entries
    .map(([key, value]) => attribute(key, value))
    .filter((item) => item !== null);
}

/** Flattens a metadata object into individual `langfuse.observation.metadata.*` attributes. */
function metadataAttributes(metadata) {
  if (!metadata || typeof metadata !== 'object') return [];
  return attributesFrom(
    Object.entries(metadata).map(([key, value]) => [
      `${ATTR.metadataPrefix}${key}`,
      typeof value === 'object' && value !== null ? boundedText(value, 2_000) : value
    ])
  );
}

/**
 * One span under construction. `end()` is idempotent so a caller that ends a
 * span in both a success path and a `finally` does not emit it twice.
 */
class SpanHandle {
  constructor(collector, { traceId, spanId, parentSpanId, name, startedAt }) {
    this.collector = collector;
    this.traceId = traceId;
    this.spanId = spanId;
    this.parentSpanId = parentSpanId;
    this.name = name;
    this.startedAt = startedAt;
    this.ended = false;
  }

  /** A nested span. Use for a model call inside a turn, or a clause inside a batch. */
  child(options = {}) {
    return this.collector.startSpan({ ...options, parent: this });
  }

  end(options = {}) {
    if (this.ended) return this;
    this.ended = true;
    this.collector.finishSpan(this, options);
    return this;
  }
}

/**
 * Buffers spans for one process and posts them in a single OTLP batch. Buffering
 * rather than streaming keeps the harness's own timings honest: a run's latency
 * numbers should measure the model, not our telemetry.
 */
class LangfuseCollector {
  constructor({ host, publicKey, secretKey, release, environment, tags, sessionId, userId }) {
    this.host = host;
    this.authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
    this.release = release;
    this.environment = environment;
    this.tags = tags;
    this.sessionId = sessionId;
    this.userId = userId;
    this.spans = [];
    this.pendingScores = [];
    this.failures = 0;
    this.enabled = true;
  }

  /**
   * Starts a trace. The returned handle is the root span; everything else in the
   * turn hangs off it, which is what turns a flat list of model calls into the
   * tree you can actually read.
   */
  startTrace(options = {}) {
    // A caller-supplied traceId wins. Grading depends on it: the id is derived
    // from the run so a later pass can find the trace again, and generating a
    // fresh one here would silently strand every score.
    return this.startSpan({ ...options, traceId: options.traceId || newTraceId(), isRoot: true });
  }

  startSpan({
    traceId,
    spanId,
    parent,
    name = 'span',
    startedAt = Date.now(),
    isRoot = false,
    ...rest
  } = {}) {
    const handle = new SpanHandle(this, {
      traceId: traceId || parent?.traceId || newTraceId(),
      spanId: spanId || newSpanId(),
      parentSpanId: parent?.spanId,
      name,
      startedAt
    });
    handle.openOptions = { isRoot, ...rest };
    return handle;
  }

  finishSpan(handle, options) {
    const merged = { ...handle.openOptions, ...options };
    const {
      isRoot = false,
      observationType,
      model,
      responseModel,
      input,
      output,
      usage,
      cost,
      metadata,
      tags,
      sessionId,
      userId,
      level,
      statusMessage,
      endedAt = Date.now()
    } = merged;

    const attributes = attributesFrom([
      [ATTR.observationType, observationType || (isRoot ? 'span' : 'span')],
      [ATTR.input, boundedText(input)],
      [ATTR.output, boundedText(output)],
      [ATTR.level, level],
      [ATTR.statusMessage, statusMessage],
      [ATTR.system, model ? 'openai' : null],
      [ATTR.requestModel, model],
      [ATTR.responseModel, responseModel || model],
      [ATTR.inputTokens, usage?.inputTokens],
      [ATTR.outputTokens, usage?.outputTokens],
      // Cached tokens are NOT sent under gen_ai.usage.*. Measured against a
      // live project: Langfuse SUMS every gen_ai.usage.* number into the total,
      // and OpenAI's input_tokens already contains the cached ones — so
      // 2000 + 250 + 1500 was reported as 3750 rather than 2250, inflating
      // every cost figure derived from it. They ride as metadata instead, below.
      [ATTR.cost, cost]
    ]);

    // Trace-level identity rides on the root span. Langfuse reads it from any
    // span in the trace, but keeping it in one place means a child span cannot
    // disagree with its parent about which session it belongs to.
    if (isRoot) {
      attributes.push(...attributesFrom([
        [ATTR.traceName, handle.name],
        [ATTR.traceInput, boundedText(input)],
        [ATTR.traceOutput, boundedText(output)],
        [ATTR.sessionId, sessionId ?? this.sessionId],
        [ATTR.userId, userId ?? this.userId],
        [ATTR.tags, tags ?? this.tags],
        [ATTR.release, this.release],
        [ATTR.environment, this.environment]
      ]));
    }
    attributes.push(...metadataAttributes({
      // Kept, just out of the usage totals. Metadata is not summed, so the
      // number stays visible and stays honest.
      ...(usage?.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
      ...metadata
    }));

    this.spans.push({
      traceId: handle.traceId,
      spanId: handle.spanId,
      ...(handle.parentSpanId ? { parentSpanId: handle.parentSpanId } : {}),
      name: handle.name,
      kind: 1,
      startTimeUnixNano: nanos(handle.startedAt),
      endTimeUnixNano: nanos(Math.max(handle.startedAt, endedAt)),
      attributes
    });
  }

  /**
   * Queues a score. Scores are posted on flush rather than inline so that
   * grading a hundred archived calls is one pass of requests at the end, and so
   * that a judge's own latency is never attributed to the call it judged.
   */
  score({ traceId, observationId, name, value, comment, dataType }) {
    // A judge that returned nothing is not a zero -- agent-judges/conversation.mjs
    // is deliberate about that -- so an absent value is dropped, not coerced.
    if (value === null || value === undefined) return;
    if (!traceId || !name) return;
    this.pendingScores.push({
      traceId,
      ...(observationId ? { observationId } : {}),
      name,
      value,
      ...(comment ? { comment } : {}),
      ...(dataType ? { dataType } : {})
    });
  }

  async post(path, body) {
    try {
      const response = await fetch(new URL(path, this.host), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.authorization,
          ...INGESTION_HEADERS
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      // OTLP answers 200 even when it rejected spans, reporting the count in
      // partialSuccess. Treating 2xx as delivery is how a silently dropped
      // batch looks identical to a stored one.
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      this.lastResponse = { status: response.status, body: payload };
      const rejected = Number(payload?.partialSuccess?.rejectedSpans || 0);
      if (!response.ok || rejected > 0) {
        this.failures += 1;
        return false;
      }
      return true;
    } catch (error) {
      this.lastResponse = { status: 0, body: null, error: String(error?.message || error) };
      this.failures += 1;
      return false;
    }
  }

  /** Ships everything buffered. Returns a summary; never throws. */
  async flush() {
    const spans = this.spans.splice(0, this.spans.length);
    const scores = this.pendingScores.splice(0, this.pendingScores.length);
    let delivered = 0;

    if (spans.length > 0) {
      const sent = await this.post(OTLP_TRACES_PATH, {
        resourceSpans: [
          {
            resource: {
              attributes: attributesFrom([
                ['service.name', 'planeir-agent-harness'],
                ['service.version', this.release]
              ])
            },
            scopeSpans: [{ scope: { name: 'planeir.agent-harness' }, spans }]
          }
        ]
      });
      if (sent) delivered += spans.length;
    }

    for (const score of scores) {
      // The scores API takes one score per request; a failed score must not
      // discard the rest of the batch.
      if (await this.post(SCORES_PATH, score)) delivered += 1;
    }

    return { delivered, spans: spans.length, scores: scores.length, failures: this.failures };
  }
}

/** A collector-shaped object that does nothing, for an unconfigured environment. */
class NoopCollector {
  constructor() {
    this.enabled = false;
    this.failures = 0;
  }

  startTrace() {
    return this.startSpan();
  }

  startSpan() {
    const handle = new SpanHandle(this, {
      traceId: '0'.repeat(32),
      spanId: '0'.repeat(16),
      name: 'noop',
      startedAt: 0
    });
    return handle;
  }

  finishSpan() {}

  score() {}

  async flush() {
    return { delivered: 0, spans: 0, scores: 0, failures: 0 };
  }
}

function isLangfuseConfigured(env = process.env) {
  return Boolean(
    env
    && String(env.LANGFUSE_PUBLIC_KEY || '').trim()
    && String(env.LANGFUSE_SECRET_KEY || '').trim()
  );
}

/**
 * Builds a client for this run.
 *
 * @param {object} [options]
 * @param {object} [options.env] defaults to process.env
 * @param {string} [options.release] the harness run key -- see
 *   agent-harness/runlog.mjs. Two runs with different keys are not comparable,
 *   and carrying the key here is what stops Langfuse from implying they are.
 * @param {string[]} [options.tags]
 * @param {string} [options.sessionId] groups turns of one call together
 */
export function createLangfuseClient({
  env = process.env,
  release,
  environment = 'harness',
  tags,
  sessionId,
  userId
} = {}) {
  if (!isLangfuseConfigured(env)) return new NoopCollector();
  return new LangfuseCollector({
    host: String(env.LANGFUSE_HOST || '').trim() || DEFAULT_HOST,
    publicKey: String(env.LANGFUSE_PUBLIC_KEY).trim(),
    secretKey: String(env.LANGFUSE_SECRET_KEY).trim(),
    release,
    environment,
    tags,
    sessionId,
    userId
  });
}

export const __testing = Object.freeze({
  ATTR,
  attribute,
  attributesFrom,
  boundedText,
  metadataAttributes,
  nanos,
  newSpanId,
  newTraceId,
  LangfuseCollector,
  NoopCollector
});
