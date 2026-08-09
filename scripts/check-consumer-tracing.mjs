// Live-call tracing: the disclosure boundary.
//
// THE ASSERTION THIS FILE EXISTS FOR is the one at "a public cohort exports no
// content". Everything else here is ordinary correctness; that one is a
// disclosure guarantee, and it is written as a NEGATIVE test -- it does not
// check that the right things are present, it checks that conversation text is
// ABSENT from the payload entirely -- for the same reason
// services/learning-signals/test/negative-privacy-m7.test.ts is written that
// way. A positive test passes just as happily when a mask silently stops
// masking.
//
// Free. No network, no model calls, no API key.

import assert from 'node:assert/strict';

import { getConsumerConfig } from '../worker/src/consumer/config.js';
import { extractSegmentedPlannerTurn } from '../worker/src/consumer/realtime_planner.js';
import {
  buildGenerationSpan,
  createTraceCollector,
  flushTraces,
  isTracingConfigured,
  maskMetadata,
  newSpanId,
  newTraceId,
  safeContent,
  shouldSampleTrace,
  traceContentAllowed
} from '../worker/src/consumer/tracing.js';
import {
  batchAsRecord,
  exportCall,
  exportRun,
  traceIdForCall
} from './agent-harness/langfuse-export.mjs';
import { createLangfuseClient, isLangfuseConfigured, __testing } from './lib/langfuse.mjs';

let checks = 0;
function check(description, condition, detail = '') {
  checks += 1;
  assert.ok(condition, `${description}${detail ? `\n      ${detail}` : ''}`);
}

/** Flattens an OTLP span's attributes into a plain object. */
function attributesOf(span) {
  return Object.fromEntries(
    (span.attributes || []).map((item) => [item.key, Object.values(item.value)[0]])
  );
}

/** The spans a collector is holding, unwrapped from the OTLP envelope. */
function collectorSpans(collector) {
  return collector.payload()?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans || [];
}

const CONFIGURED_ENV = Object.freeze({
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  LANGFUSE_HOST: 'https://cloud.langfuse.com',
  CONSUMER_TRACING_ENABLED: 'true'
});

const TEST_COHORT_CONFIG = Object.freeze({
  cohort: 'automated_test',
  agentTestCohorts: ['automated_test', 'consumer_test'],
  tracingSamplePercent: 0
});
const PUBLIC_COHORT_CONFIG = Object.freeze({
  cohort: 'public_beta',
  agentTestCohorts: ['automated_test', 'consumer_test'],
  tracingSamplePercent: 100
});
// What the committed wrangler.toml actually deploys. Named separately because
// the whole point of the next block is that this is NOT a test cohort.
const PRODUCTION_CONFIG = Object.freeze({
  cohort: 'internal',
  agentTestCohorts: ['automated_test', 'consumer_test'],
  tracingSamplePercent: 100
});

/* ------------------------------------------------------ 1. fail closed */

check('unset env is not configured', isTracingConfigured({}) === false);
check('keys without the flag are not configured', isTracingConfigured({
  ...CONFIGURED_ENV, CONSUMER_TRACING_ENABLED: 'false'
}) === false);
check('the flag without keys is not configured', isTracingConfigured({
  CONSUMER_TRACING_ENABLED: 'true'
}) === false);
check('a non-https host is not configured', isTracingConfigured({
  ...CONFIGURED_ENV, LANGFUSE_HOST: 'http://cloud.langfuse.com'
}) === false);
check('all four together are configured', isTracingConfigured(CONFIGURED_ENV) === true);

{
  // An unconfigured collector must be inert AND silent -- no buffer, no fetch,
  // and no exception from a call site that traced without checking first.
  let fetched = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched += 1; return { ok: true }; };
  try {
    const collector = createTraceCollector({ env: {}, config: TEST_COHORT_CONFIG });
    collector.record({ name: 'planner', model: 'gpt-5.6-luna', content: { input: 'hello' } });
    check('an unconfigured collector is inactive', collector.active === false);
    check('an unconfigured collector buffers nothing', collector.size === 0);
    check('an unconfigured collector has no payload', collector.payload() === null);
    check('an unconfigured flush resolves false', (await collector.flush()) === false);
    check('an unconfigured collector never calls fetch', fetched === 0, `fetch called ${fetched}×`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/* ------------------------- 2. NEGATIVE PRIVACY: no content for the public */

{
  const collector = createTraceCollector({ env: CONFIGURED_ENV, config: PUBLIC_COHORT_CONFIG });
  check('a public cohort still traces', collector.active === true);
  collector.record({
    name: 'planner.segmented',
    model: 'gpt-5.6-luna',
    content: {
      input: 'I earn 82000 a year and my wife earns 54000, we want to buy in Galway',
      output: '{"assistantMessage":"Thanks — what age are you?"}'
    },
    metadata: { promptVersion: 'planner-v3', inputTokens: 2100, outputTokens: 240, latencyMs: 812 },
    usage: { inputTokens: 2100, outputTokens: 240 }
  });

  const serialised = JSON.stringify(collector.payload());
  const span = collector.payload().resourceSpans[0].scopeSpans[0].spans[0];
  const attributes = attributesOf(span);

  check('no input attribute exists at all', !('langfuse.observation.input' in attributes));
  check('no output attribute exists at all', !('langfuse.observation.output' in attributes));
  // Not "the attribute is absent" but "the words are nowhere in the request".
  for (const fragment of ['82000', '54000', 'Galway', 'wife', 'assistantMessage', 'what age']) {
    check(`"${fragment}" appears nowhere in the payload`, !serialised.includes(fragment),
      `leaked via: ${serialised.slice(0, 400)}`);
  }
  check('metadata still ships', attributes['langfuse.observation.metadata.promptVersion'] === 'planner-v3');
  check('tokens still ship', attributes['gen_ai.usage.prompt_tokens'] === '2100');
  check('the span records that content was withheld',
    attributes['langfuse.observation.metadata.contentCaptured'] === false);
}

{
  // The trap this gate is written around: production's cohort is "internal",
  // which reads like a staging label and is not one. See wrangler.toml:86.
  check('the internal cohort is NOT content-allowed', traceContentAllowed(PRODUCTION_CONFIG) === false);
  const collector = createTraceCollector({ env: CONFIGURED_ENV, config: PRODUCTION_CONFIG });
  collector.record({ name: 'planner', content: { input: 'my PPS is 1234567T' } });
  check('the deployed production cohort exports no content',
    !JSON.stringify(collector.payload()).includes('1234567T'));
}

{
  // And the same holds for the config the committed wrangler.toml actually
  // produces, resolved through getConsumerConfig rather than hand-written --
  // so this check keeps holding if the deployed cohort is ever renamed.
  const shipped = getConsumerConfig({ CONSUMER_COHORT: 'internal' });
  check('the resolved shipped config is not content-allowed',
    traceContentAllowed(shipped) === false,
    `cohort=${shipped.cohort} testCohorts=${JSON.stringify(shipped.agentTestCohorts)}`);
  check('the resolved shipped config defaults to no sampling',
    shipped.tracingSamplePercent === 0);
}

check('an empty test-cohort list allows nothing',
  traceContentAllowed({ cohort: 'automated_test', agentTestCohorts: [] }) === false);
check('a missing test-cohort list allows nothing',
  traceContentAllowed({ cohort: 'automated_test' }) === false);
check('a blank cohort allows nothing',
  traceContentAllowed({ cohort: '', agentTestCohorts: ['automated_test'] }) === false);

/* --------------------------------- 3. content DOES flow for a test cohort */

{
  const collector = createTraceCollector({ env: CONFIGURED_ENV, config: TEST_COHORT_CONFIG });
  collector.record({
    name: 'planner',
    model: 'gpt-5.6-luna',
    content: { input: 'we want to buy in Galway', output: 'What age are you?' },
    metadata: { promptVersion: 'planner-v3' }
  });
  const attributes = attributesOf(collector.payload().resourceSpans[0].scopeSpans[0].spans[0]);
  check('a test cohort exports input', attributes['langfuse.observation.input'] === 'we want to buy in Galway');
  check('a test cohort exports output', attributes['langfuse.observation.output'] === 'What age are you?');
  check('the span records that content was captured',
    attributes['langfuse.observation.metadata.contentCaptured'] === true);
}

/* ------------------- 4. redaction is the floor, not the cohort gate */

{
  const collector = createTraceCollector({ env: CONFIGURED_ENV, config: TEST_COHORT_CONFIG });
  collector.record({
    name: 'planner',
    content: {
      input: 'my PPS is 1234567T and my card is 4111 1111 1111 1111',
      output: 'my password is hunter2secret'
    }
  });
  const serialised = JSON.stringify(collector.payload());
  check('a PPS number is redacted even in a test cohort', !serialised.includes('1234567T'), serialised.slice(0, 300));
  check('a card number is redacted even in a test cohort', !serialised.includes('4111'));
  check('a password is redacted even in a test cohort', !serialised.includes('hunter2secret'));
  check('the redaction marker is present', serialised.includes('redacted identifier'));
}

check('safeContent bounds a very long value', (safeContent('x'.repeat(50_000)) || '').length < 9_000);
check('safeContent returns null for nothing', safeContent(undefined) === null && safeContent(null) === null);
check('safeContent serialises an object', safeContent({ a: 1 }) === '{"a":1}');

/* -------------------------------------------- 5. the metadata allowlist */

{
  const masked = maskMetadata({
    model: 'gpt-5.6-luna',
    latencyMs: 812,
    speculative: true,
    // None of these are on the allowlist.
    assistantMessage: 'you can afford it',
    transcript: 'the whole call',
    sessionId: 'raw-session-id',
    profilePatch: { '/primaryPerson/age': 41 }
  });
  check('allowlisted keys survive', masked.model === 'gpt-5.6-luna' && masked.latencyMs === 812);
  check('booleans survive', masked.speculative === true);
  check('an unlisted key is dropped', !('assistantMessage' in masked) && !('transcript' in masked));
  check('a raw session id is dropped', !('sessionId' in masked));
  check('a non-primitive is dropped', !('profilePatch' in masked));
  check('maskMetadata tolerates nothing', Object.keys(maskMetadata(null)).length === 0);
}

/* --------------------------------------------------- 6. sampling policy */

check('a test cohort always samples', shouldSampleTrace(TEST_COHORT_CONFIG, 0.99) === true);
check('zero percent never samples', shouldSampleTrace({ ...PUBLIC_COHORT_CONFIG, tracingSamplePercent: 0 }, 0) === false);
check('a public cohort samples under the threshold', shouldSampleTrace({ ...PUBLIC_COHORT_CONFIG, tracingSamplePercent: 10 }, 0.05) === true);
check('a public cohort skips over the threshold', shouldSampleTrace({ ...PUBLIC_COHORT_CONFIG, tracingSamplePercent: 10 }, 0.5) === false);

/* ------------------------------------------------- 7. OTLP payload shape */

{
  const collector = createTraceCollector({
    env: CONFIGURED_ENV, config: TEST_COHORT_CONFIG, sessionIdHash: 'abc123hash', lane: 'realtime_v2'
  });
  const turn = collector.startSpan();
  collector.record({
    name: 'turn', spanId: turn.spanId, isRoot: true, startedAt: turn.startedAt, endedAt: turn.startedAt + 900
  });
  collector.record({
    name: 'planner.clause[0]', parentSpanId: turn.spanId, model: 'gpt-5.6-luna',
    startedAt: turn.startedAt + 10, endedAt: turn.startedAt + 400,
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 }, costEur: 0.00042
  });

  const spans = collector.payload().resourceSpans[0].scopeSpans[0].spans;
  check('every span shares one trace id', new Set(spans.map((span) => span.traceId)).size === 1);
  check('a trace id is 32 hex characters', /^[0-9a-f]{32}$/.test(spans[0].traceId));
  check('a span id is 16 hex characters', spans.every((span) => /^[0-9a-f]{16}$/.test(span.spanId)));
  check('the child links to its parent', spans[1].parentSpanId === spans[0].spanId);
  check('the root has no parent', !('parentSpanId' in spans[0]));
  check('start never exceeds end', spans.every(
    (span) => BigInt(span.startTimeUnixNano) <= BigInt(span.endTimeUnixNano)
  ));
  check('timestamps are nanoseconds', spans[0].endTimeUnixNano.length >= 19);

  const root = attributesOf(spans[0]);
  check('the root carries the hashed session id', root['langfuse.session.id'] === 'abc123hash');
  const child = attributesOf(spans[1]);
  check('the lane rides on every span', child['langfuse.observation.metadata.lane'] === 'realtime_v2');
  check('cost maps to gen_ai.usage.cost', child['gen_ai.usage.cost'] === 0.00042);
  // Cached tokens must NOT appear under gen_ai.usage.*. Langfuse sums every
  // number in that namespace into the total, and cached tokens are a subset of
  // input_tokens, not an addition — measured live, 2000 + 250 + 1500 came back
  // as 3750 instead of 2250. They ride as metadata, which is not summed.
  check('cached tokens are NOT in the usage namespace',
    child['gen_ai.usage.cached_input_tokens'] === undefined,
    `found ${child['gen_ai.usage.cached_input_tokens']}`);
  // String, not number: OTLP encodes an integer attribute as intValue, which
  // proto3 JSON renders as a string. Same as the token assertions above.
  check('cached tokens survive as metadata',
    child['langfuse.observation.metadata.cachedInputTokens'] === '80',
    `found ${JSON.stringify(child['langfuse.observation.metadata.cachedInputTokens'])}`);
  check('the usage namespace carries input and output only',
    Object.keys(child).filter((key) => key.startsWith('gen_ai.usage.')).sort().join(',')
      === 'gen_ai.usage.completion_tokens,gen_ai.usage.cost,gen_ai.usage.prompt_tokens',
    Object.keys(child).filter((key) => key.startsWith('gen_ai.usage.')).join(','));
}

check('an out-of-order end is clamped, not negative', (() => {
  const span = buildGenerationSpan({ config: TEST_COHORT_CONFIG, name: 'x', startedAt: 1000, endedAt: 5 });
  return BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano);
})());
check('ids are unique per call', newTraceId() !== newTraceId() && newSpanId() !== newSpanId());

/* ------------------------------------ 8. delivery never reaches the call */

{
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('langfuse is down'); };
    const collector = createTraceCollector({ env: CONFIGURED_ENV, config: TEST_COHORT_CONFIG });
    collector.record({ name: 'planner' });
    check('a throwing endpoint resolves false rather than rejecting', (await collector.flush()) === false);

    globalThis.fetch = async () => ({ ok: false, status: 500 });
    const failing = createTraceCollector({ env: CONFIGURED_ENV, config: TEST_COHORT_CONFIG });
    failing.record({ name: 'planner' });
    check('a 500 resolves false rather than rejecting', (await failing.flush()) === false);

    globalThis.fetch = async () => ({ ok: true });
    const ok = createTraceCollector({ env: CONFIGURED_ENV, config: TEST_COHORT_CONFIG });
    ok.record({ name: 'planner' });
    check('a successful flush resolves true', (await ok.flush()) === true);
    check('flushing empties the buffer', ok.size === 0);
    check('a second flush is a no-op', (await ok.flush()) === false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  // flushTraces must survive a context that cannot take background work, and a
  // waitUntil that throws. Both would otherwise surface inside a live turn.
  const collector = createTraceCollector({ env: CONFIGURED_ENV, config: TEST_COHORT_CONFIG });
  collector.record({ name: 'planner' });
  flushTraces(collector, undefined);
  flushTraces(collector, {});
  flushTraces(collector, { waitUntil() { throw new Error('no background work'); } });
  let handed = 0;
  flushTraces(collector, { waitUntil(promise) { handed += 1; return promise; } });
  check('flushTraces hands exactly one promise to waitUntil', handed === 1);
  check('flushTraces on an inactive collector is a no-op', (() => {
    let called = 0;
    flushTraces(createTraceCollector({ env: {}, config: TEST_COHORT_CONFIG }), { waitUntil() { called += 1; } });
    return called === 0;
  })());
}

/* ------------------------------------------ 9. the harness export twin */

check('the harness client is unconfigured without keys', isLangfuseConfigured({}) === false);
check('the harness client is configured with keys',
  isLangfuseConfigured({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }) === true);
check('an unconfigured harness client is a no-op', createLangfuseClient({ env: {} }).enabled === false);

check('a derived trace id is stable across passes',
  traceIdForCall('run-1', 'mary') === traceIdForCall('run-1', 'mary'));
check('a derived trace id is per call',
  traceIdForCall('run-1', 'mary') !== traceIdForCall('run-1', 'sean'));
check('a derived trace id is per run',
  traceIdForCall('run-1', 'mary') !== traceIdForCall('run-2', 'mary'));
check('a derived trace id is a valid OTLP id', /^[0-9a-f]{32}$/.test(traceIdForCall('run-1', 'mary')));

{
  const record = {
    runId: 'run-1',
    runKey: 'prompt=v4 toolset=v2',
    generatedAt: '2026-08-05T10:00:00.000Z',
    calls: [{
      callId: 'mary', caller: 'mary', turns: 1, goals: ['buy_home'], analyses: [], factIds: [],
      blockers: [{ severity: 'blocking', id: 'repeated_question', turn: 1, detail: 'asked twice' }],
      execution: { status: 'complete', completedModuleIds: [] },
      transcript: [{ role: 'client', text: 'hello' }, { role: 'planner', text: 'hi' }],
      usage: { planner: { model: 'gpt-5.6-terra', inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, latencyMs: 500 } },
      judge: { available: true, tone: 4, groundedness: 5, explains_why: 3, momentum: null, note: 'ok' },
      error: null
    }]
  };
  const client = createLangfuseClient({
    env: { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }, release: record.runKey
  });
  const exported = exportCall(client, record, record.calls[0]);
  check('an exported call uses the derived trace id', exported.traceId === traceIdForCall('run-1', 'mary'));
  check('every exported span shares that trace id',
    client.spans.every((span) => span.traceId === exported.traceId));
  check('a null judge dimension is not posted as a score',
    !client.pendingScores.some((score) => score.name === 'judge.momentum'));
  check('a scored judge dimension is posted',
    client.pendingScores.some((score) => score.name === 'judge.tone' && score.value === 4));
  check('deterministic blocker counts are posted',
    client.pendingScores.some((score) => score.name === 'blockers.blocking' && score.value === 1));
  const root = attributesOf(client.spans.find((span) => span.name.startsWith('call:')));
  check('the run key becomes tags', JSON.stringify(root['langfuse.trace.tags']).includes('prompt=v4'));
  check('a blocking finding marks the trace as an error', root['langfuse.observation.level'] === 'ERROR');

  const mapped = batchAsRecord({
    runId: 'b1', runKey: 'k', generatedAt: record.generatedAt,
    conversations: [{ scenario: 's1', repeat: 0, turns: 2, goals: [], analyses: [], transcript: [], divergence: 'agent [] vs voice [x]' }]
  });
  check('a batch conversation maps to a call', mapped.calls[0].callId === 's1#0');
  check('a transport divergence becomes a blocking finding',
    mapped.calls[0].blockers[0].id === 'transport_divergence');
}

{
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('langfuse is down'); };
    const result = await exportRun(
      { runId: 'r', runKey: 'k', generatedAt: '2026-08-05T10:00:00.000Z', calls: [{ callId: 'a', transcript: [] }] },
      { env: { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' } }
    );
    check('a harness export survives an outage', result.failures > 0 && result.delivered === 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

check('the harness and worker agree on attribute names',
  __testing.ATTR.input === 'langfuse.observation.input'
  && __testing.ATTR.sessionId === 'langfuse.session.id');

/* ------------------------- 10. the real planner fan-out, end to end */

{
  // The shape this whole exercise exists to produce. Asserted against the real
  // extractSegmentedPlannerTurn rather than a hand-built tree, because the thing
  // worth protecting is that a dense turn's clause reads, and the retry one of
  // them needed, stay attached to the turn they belong to.
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      // The second clause fails fast, which the planner retries once.
      if (calls === 2) {
        return {
          ok: false,
          status: 429,
          headers: new Headers(),
          body: null,
          text: async () => JSON.stringify({ error: { type: 'rate_limit', code: 'rate_limit_exceeded' } })
        };
      }
      return {
        ok: true,
        headers: new Headers({ 'x-request-id': 'req_test' }),
        json: async () => ({
          id: 'resp_test',
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } },
          output_text: JSON.stringify({ facts: [], positions: [], sectionCompletion: [], turnClassification: {} })
        })
      };
    };

    const plannerConfig = {
      ...TEST_COHORT_CONFIG,
      realtimeConversationV2Enabled: true,
      realtimePlannerModel: 'gpt-5.6-luna',
      realtimePlannerTimeoutMs: 15_000
    };
    const trace = createTraceCollector({
      env: CONFIGURED_ENV, config: plannerConfig, lane: 'realtime_v2', sessionIdHash: 'hashed'
    });
    await extractSegmentedPlannerTurn({
      env: { ...CONFIGURED_ENV, OPENAI_API_KEY: 'sk-test' },
      config: plannerConfig,
      context: { config: plannerConfig, state: {} },
      sourceTurnId: 'item_1',
      transcript: 'I am 41 and my wife is 39. We want to buy a house in Galway. I earn 82000.',
      recentTurns: [],
      trace
    }).catch(() => {});

    const spans = collectorSpans(trace);
    const segmented = spans.find((span) => span.name === 'planner.segmented');
    check('a dense turn produces a segmented parent span', Boolean(segmented));
    check('the segmented span is the root of the turn', !('parentSpanId' in segmented));
    check('every clause read hangs off it',
      spans.filter((span) => span !== segmented).every((span) => span.parentSpanId === segmented.spanId),
      `spans: ${spans.map((span) => span.name).join(', ')}`);

    const metadataOf = (span) => Object.fromEntries(
      span.attributes
        .filter((item) => item.key.startsWith('langfuse.observation.metadata.'))
        .map((item) => [item.key.slice('langfuse.observation.metadata.'.length), Object.values(item.value)[0]])
    );
    const clauses = spans.filter((span) => span.name === 'planner.extraction');
    check('each clause records which clause it was',
      clauses.every((span) => metadataOf(span).segmentIndex !== undefined));
    check('a retried clause is distinguishable from a first attempt',
      clauses.some((span) => metadataOf(span).retryOfFastFailure === true));
    check('a failed clause keeps the provider\'s own classification',
      clauses.some((span) => metadataOf(span).providerErrorCode === 'rate_limit_exceeded'),
      JSON.stringify(clauses.map(metadataOf)));
    check('a failed clause is marked as an error',
      clauses.some((span) => attributesOf(span)['langfuse.observation.level'] === 'ERROR'));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.info(`[Consumer tracing] ${checks} checks passed: unconfigured is silent, `
  + 'a public cohort exports no conversation text, identifiers are redacted even '
  + 'in a test cohort, and delivery failure never reaches the call.');
