// Does Langfuse actually read what we send it?
//
//   LANGFUSE_PUBLIC_KEY=pk-… LANGFUSE_SECRET_KEY=sk-… npm run verify:langfuse
//
// FREE. No OPENAI_API_KEY, no model calls, no spend. It needs the three
// LANGFUSE_* variables and nothing else.
//
// WHY THIS EXISTS. Everything else in this repo can be checked offline, because
// everything else is our own code. This one thing cannot: whether a span
// attribute we emit is an attribute Langfuse stores is a fact about their
// backend, and the published sources disagree about it. The OTEL attribute
// reference says gen_ai.usage.input_tokens populates usage.input; langfuse#11135
// reports that neither gen_ai.usage.* nor langfuse.observation.usage_details.*
// do, and closed without a resolution; langfuse#12306 says gen_ai.usage.* are
// INCLUSIVE, meaning the cached-token attribute we send alongside is either
// ignored or double-counted into the cost. Reading more documentation cannot
// settle that. One round-trip can.
//
// It asserts rather than eyeballs, which is possible because trace ids here are
// knowable in advance: traceIdForCall derives them, and a worker collector
// exposes .traceId. So this posts through the REAL code paths — never a
// hand-built payload, or it would be testing itself — reads back what was
// stored, and prints a sent → landed table.
//
// THE ASSERTION THAT MATTERS MOST is the last pair: a test cohort's trace must
// come back WITH conversation text, and a public cohort's must come back
// WITHOUT. check-consumer-tracing.mjs already proves we never SEND content for
// a public cohort. This proves none was STORED — the same guarantee, checked at
// the other end of the wire.
//
// Everything it writes is synthetic. No real session, no real client.

import { createTraceCollector } from '../worker/src/consumer/tracing.js';
import { exportRun, traceIdForCall } from './agent-harness/langfuse-export.mjs';

const publicKey = String(process.env.LANGFUSE_PUBLIC_KEY || '').trim();
const secretKey = String(process.env.LANGFUSE_SECRET_KEY || '').trim();
const host = String(process.env.LANGFUSE_HOST || '').trim() || 'https://cloud.langfuse.com';

if (!publicKey || !secretKey) {
  console.error('LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required.\n');
  console.error('  LANGFUSE_PUBLIC_KEY=pk-lf-… LANGFUSE_SECRET_KEY=sk-lf-… npm run verify:langfuse\n');
  // Deliberately not "check your project settings". No Langfuse account has
  // ever been provisioned for this repository -- not locally, not in Cloudflare
  // secrets, GitHub Actions or Render -- so there is nowhere to look these up.
  console.error('There is no Langfuse account for this project yet, so there is nothing to look');
  console.error('up. docs/langfuse-setup.md walks through creating one (free tier, no card).');
  console.error('\nThis script makes no model calls and costs nothing.');
  process.exit(2);
}

const authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runId = `verify-${stamp}`;

/* ------------------------------------------------------------------ helpers */

async function api(path, params = {}) {
  const url = new URL(path, host);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  try {
    const response = await fetch(url, {
      headers: { authorization, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000)
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: String(error?.message || error) };
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** First defined property from a list of candidate names. Shapes differ by API version. */
function pick(object, ...names) {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asText(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Observations for a trace, from whichever read API this deployment serves.
 * v2 is current; the trace endpoint is deprecated but returns them inline and
 * is the fallback for an older self-hosted version.
 */
async function readObservations(traceId) {
  const v2 = await api('/api/public/v2/observations', { traceId, limit: 100 });
  if (v2.ok && Array.isArray(v2.body?.data)) {
    return { source: '/api/public/v2/observations', observations: v2.body.data };
  }
  const legacy = await api(`/api/public/traces/${encodeURIComponent(traceId)}`);
  if (legacy.ok && legacy.body) {
    return {
      source: `/api/public/traces/{id} (deprecated; v2 said ${v2.status})`,
      observations: legacy.body.observations || [],
      trace: legacy.body
    };
  }
  return {
    source: null,
    observations: [],
    error: `v2 → ${v2.status}${v2.error ? ` (${v2.error})` : ''}, trace → ${legacy.status}`
  };
}

async function readTrace(traceId) {
  const result = await api(`/api/public/traces/${encodeURIComponent(traceId)}`);
  return result.ok ? result.body : null;
}

async function readScores(traceId) {
  for (const path of ['/api/public/v3/scores', '/api/public/v2/scores', '/api/public/scores']) {
    const result = await api(path, { traceId, limit: 100 });
    if (result.ok && Array.isArray(result.body?.data)) {
      return { source: path, scores: result.body.data };
    }
  }
  return { source: null, scores: [] };
}

/** Polls until the trace appears. Ingestion is asynchronous; it is normally seconds. */
async function waitForTrace(traceId, { label }) {
  const delays = [2_000, 3_000, 5_000, 5_000, 10_000, 15_000, 20_000, 30_000];
  let waited = 0;
  for (const delay of delays) {
    const found = await readObservations(traceId);
    if (found.observations.length > 0) return found;
    await sleep(delay);
    waited += delay;
    process.stdout.write(`  … waiting for ${label} (${Math.round(waited / 1000)}s)\r`);
  }
  process.stdout.write(' '.repeat(60) + '\r');
  return readObservations(traceId);
}

/* ------------------------------------------------------------------ results */

const rows = [];
let failures = 0;

/**
 * @param {boolean|null} ok  true pass, false fail, null informational —
 *   recorded and printed but never fails the run. Used where the correct
 *   behaviour is genuinely unknown until we see it, which is the point.
 */
function record({ label, sent, landed, ok, note = '' }) {
  if (ok === false) failures += 1;
  rows.push({ label, sent: asText(sent), landed: asText(landed), ok, note });
}

/* ------------------------------------------------------- 1. the harness path */

console.info(`Langfuse round-trip · host ${host}`);
console.info(`Run id ${runId}\n`);

const harnessRecord = {
  runId,
  runKey: 'prompt=verify-v1 toolset=verify-v1 planner=gpt-5.6-luna manifest=2.0.0 modules=verify',
  generatedAt: new Date().toISOString(),
  calls: [{
    callId: 'verify-caller',
    caller: 'verify-caller',
    turns: 2,
    goals: ['buy_home'],
    analyses: ['house_purchase'],
    factIds: ['fact_a', 'fact_b'],
    blockers: [{ severity: 'blocking', id: 'verify_blocker', turn: 2, detail: 'synthetic' }],
    execution: { status: 'complete', completedModuleIds: ['house_purchase'] },
    transcript: [
      { role: 'planner', text: 'VERIFY_PLANNER_GREETING' },
      { role: 'client', text: 'VERIFY_CLIENT_UTTERANCE' },
      { role: 'planner', text: 'VERIFY_PLANNER_QUESTION' }
    ],
    usage: {
      client: { model: 'gpt-5.6-luna', inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 0, calls: 2 },
      // Deliberately: cached is a SUBSET of input, exactly as OpenAI reports it.
      // If Langfuse adds them the cost comes back higher than euroCostFor says.
      planner: { model: 'gpt-5.6-terra', inputTokens: 4_000, outputTokens: 500, cachedInputTokens: 3_000, calls: 1, latencyMs: 1_234 }
    },
    judge: {
      available: true, tone: 4, groundedness: 5, explains_why: 3,
      // Absent on purpose. An unscored dimension must not arrive as a zero.
      momentum: null,
      note: 'synthetic verification'
    },
    error: null
  }]
};

const harnessTraceId = traceIdForCall(runId, 'verify-caller');
const exported = await exportRun(harnessRecord, { env: process.env });
console.info(`1. harness run  → trace ${harnessTraceId}`);
console.info(`   posted ${exported.delivered} object(s), ${exported.failures} failure(s)`);
if (exported.failures > 0 || exported.delivered === 0) {
  console.error('\nNothing was accepted. Check the keys and host, then re-run.');
  process.exit(1);
}

/* -------------------------------------------- 2 & 3. the worker paths */

const workerEnv = {
  LANGFUSE_PUBLIC_KEY: publicKey,
  LANGFUSE_SECRET_KEY: secretKey,
  LANGFUSE_HOST: host,
  CONSUMER_TRACING_ENABLED: 'true'
};
const testCohortConfig = {
  cohort: 'automated_test',
  agentTestCohorts: ['automated_test', 'consumer_test'],
  tracingSamplePercent: 0
};
const publicCohortConfig = {
  cohort: 'public_beta',
  agentTestCohorts: ['automated_test', 'consumer_test'],
  tracingSamplePercent: 100
};

/** The real turn shape: a segmented parent, two clause children, one failed. */
async function postWorkerTurn(config, marker) {
  const collector = createTraceCollector({
    env: workerEnv,
    config,
    lane: 'realtime_v2',
    sessionIdHash: `verify-session-${config.cohort}`
  });
  if (!collector.active) throw new Error(`collector inactive for cohort ${config.cohort}`);

  const started = Date.now();
  const parent = collector.startSpan();
  const clauseOne = collector.startSpan();
  const clauseTwo = collector.startSpan();

  collector.record({
    name: 'planner.clause[0]',
    spanId: clauseOne.spanId,
    parentSpanId: parent.spanId,
    model: 'gpt-5.6-luna',
    startedAt: started,
    endedAt: started + 400,
    content: { input: `${marker}_CLAUSE_INPUT`, output: `${marker}_CLAUSE_OUTPUT` },
    usage: { inputTokens: 2_000, outputTokens: 250, cachedInputTokens: 1_500 },
    costEur: 0.001234,
    metadata: { promptVersion: 'planner-v3', segmentIndex: 0, latencyMs: 400 }
  });
  collector.record({
    name: 'planner.clause[1]',
    spanId: clauseTwo.spanId,
    parentSpanId: parent.spanId,
    model: 'gpt-5.6-luna',
    startedAt: started + 10,
    endedAt: started + 300,
    content: { input: `${marker}_FAILED_CLAUSE_INPUT` },
    errorCode: 'realtime_planner_request_failed',
    metadata: { segmentIndex: 1, providerErrorCode: 'rate_limit_exceeded', errorCode: 'realtime_planner_request_failed' }
  });
  collector.record({
    name: 'planner.segmented',
    spanId: parent.spanId,
    isRoot: true,
    observationType: 'span',
    startedAt: started,
    endedAt: started + 900,
    content: { input: `${marker}_TURN_INPUT`, output: `${marker}_TURN_OUTPUT` },
    tags: ['verify:round-trip', `cohort:${config.cohort}`],
    release: 'verify-v1',
    metadata: { segmentCount: 2, segmentsFailed: 1, prefetchedCount: 1 }
  });

  const flushed = await collector.flush();
  return { traceId: collector.traceId, flushed };
}

const testTurn = await postWorkerTurn(testCohortConfig, 'VERIFYTEST');
console.info(`2. worker turn (automated_test) → trace ${testTurn.traceId} · accepted=${testTurn.flushed}`);
const publicTurn = await postWorkerTurn(publicCohortConfig, 'VERIFYPUBLIC');
console.info(`3. worker turn (public_beta)    → trace ${publicTurn.traceId} · accepted=${publicTurn.flushed}\n`);

/* ---------------------------------------------------------- read back */

console.info('Waiting for ingestion…');
const harness = await waitForTrace(harnessTraceId, { label: 'harness trace' });
const test = await waitForTrace(testTurn.traceId, { label: 'test-cohort trace' });
const pub = await waitForTrace(publicTurn.traceId, { label: 'public-cohort trace' });

if (harness.observations.length === 0) {
  console.error(`\nThe harness trace never appeared. ${harness.error || ''}`);
  console.error('Ingestion was accepted, so this is either slower than the poll window or a');
  console.error('project mismatch between the ingest key and the read key.');
  process.exit(1);
}

console.info(`Read via ${harness.source}`);
const scoreRead = await readScores(harnessTraceId);
console.info(`Scores via ${scoreRead.source || '(none answered)'}\n`);

const harnessTrace = harness.trace || await readTrace(harnessTraceId);
const byName = (list, name) => list.find((item) => item.name === name);

/* ------------------------------------------------------------ assertions */

// -- ingestion and identity
record({
  label: 'trace exists',
  sent: harnessTraceId,
  landed: pick(harnessTrace || {}, 'id') || `${harness.observations.length} observation(s)`,
  ok: harness.observations.length > 0
});
record({
  label: 'session id (grouping)',
  sent: runId,
  landed: pick(harnessTrace || {}, 'sessionId', 'session_id'),
  ok: harnessTrace ? pick(harnessTrace, 'sessionId', 'session_id') === runId : null,
  note: harnessTrace ? '' : 'trace endpoint unavailable'
});
record({
  label: 'tags (the run key)',
  sent: 'prompt=verify-v1 …, caller:verify-caller',
  landed: pick(harnessTrace || {}, 'tags'),
  ok: harnessTrace ? (pick(harnessTrace, 'tags') || []).includes('prompt=verify-v1') : null
});
record({
  label: 'release',
  sent: harnessRecord.runKey,
  landed: pick(harnessTrace || {}, 'release'),
  ok: harnessTrace ? Boolean(pick(harnessTrace, 'release')) : null
});

// -- the tree
const segmented = byName(test.observations, 'planner.segmented');
const clause0 = byName(test.observations, 'planner.clause[0]');
const clause1 = byName(test.observations, 'planner.clause[1]');
record({
  label: 'observation names survive',
  sent: 'planner.segmented, planner.clause[0], planner.clause[1]',
  landed: test.observations.map((item) => item.name).join(', ') || '(none)',
  ok: Boolean(segmented && clause0 && clause1)
});
const parentId = clause0 ? pick(clause0, 'parentObservationId', 'parent_observation_id') : undefined;
record({
  label: 'parent nesting survives',
  sent: 'clause[0].parent = planner.segmented',
  landed: parentId ? `parent id ${String(parentId).slice(0, 12)}…` : '(no parent recorded)',
  ok: Boolean(parentId && segmented && parentId === segmented.id),
  note: 'the tree is the entire point of this work'
});

// -- generation typing and model
record({
  label: 'typed as a generation',
  sent: 'langfuse.observation.type=generation + model',
  landed: clause0 ? pick(clause0, 'type') : '(missing)',
  ok: clause0 ? String(pick(clause0, 'type') || '').toUpperCase() === 'GENERATION' : false
});
record({
  label: 'model',
  sent: 'gpt-5.6-luna',
  landed: clause0 ? pick(clause0, 'model') : '(missing)',
  ok: clause0 ? pick(clause0, 'model') === 'gpt-5.6-luna' : false
});

// -- THE TOKEN QUESTION (langfuse#11135)
const usage = clause0 ? (pick(clause0, 'usage') || {}) : {};
const usageDetails = clause0 ? (pick(clause0, 'usageDetails', 'usage_details') || {}) : {};
const landedInput = pick(usage, 'input', 'promptTokens', 'inputTokens') ?? pick(usageDetails, 'input');
const landedOutput = pick(usage, 'output', 'completionTokens', 'outputTokens') ?? pick(usageDetails, 'output');
record({
  label: 'input tokens  [langfuse#11135]',
  sent: 'gen_ai.usage.prompt_tokens = 2000',
  landed: landedInput ?? '(nothing landed)',
  ok: Number(landedInput) === 2_000,
  note: Number(landedInput) === 2_000 ? '' : 'switch to langfuse.observation.usage_details'
});
record({
  label: 'output tokens [langfuse#11135]',
  sent: 'gen_ai.usage.completion_tokens = 250',
  landed: landedOutput ?? '(nothing landed)',
  ok: Number(landedOutput) === 250
});

// -- THE CACHED-TOKEN / COST QUESTION (langfuse#12306)
const landedCached = pick(usage, 'cachedInput', 'cached_input')
  ?? pick(usageDetails, 'cache_read_input_tokens', 'cached_input_tokens', 'cachedInputTokens');
record({
  label: 'cached tokens [langfuse#12306]',
  sent: 'gen_ai.usage.cached_input_tokens = 1500',
  landed: landedCached ?? '(ignored)',
  // Informational: BOTH answers are actionable, neither is a failure of this run.
  ok: null,
  note: landedCached === undefined
    ? 'ignored — drop the attribute or move to usage_details'
    : 'landed — check the total below is not inflated'
});
const landedTotal = pick(usage, 'total', 'totalTokens');
record({
  label: 'total tokens not inflated',
  sent: 'input 2000 (already includes 1500 cached) + output 250',
  landed: landedTotal ?? '(no total)',
  ok: landedTotal === undefined ? null : Number(landedTotal) <= 2_250,
  note: Number(landedTotal) > 2_250 ? 'INFLATED — cached is being added on top of input' : ''
});
const landedCost = pick(clause0 || {}, 'calculatedTotalCost', 'totalCost', 'costDetails');
record({
  label: 'cost  [langfuse#11030]',
  sent: 'gen_ai.usage.cost = 0.001234',
  landed: landedCost ?? '(nothing landed)',
  ok: landedCost === undefined ? false : null,
  note: 'compare against euroCostFor in agent-harness/cost.mjs'
});

// -- error path
record({
  label: 'a failed clause is an error',
  sent: "level=ERROR, status='realtime_planner_request_failed'",
  landed: clause1 ? `${pick(clause1, 'level')} / ${pick(clause1, 'statusMessage', 'status_message')}` : '(missing)',
  ok: clause1 ? String(pick(clause1, 'level') || '').toUpperCase() === 'ERROR' : false
});
const clause1Meta = clause1 ? (pick(clause1, 'metadata') || {}) : {};
record({
  label: 'metadata (provider classification)',
  sent: 'providerErrorCode=rate_limit_exceeded',
  landed: pick(clause1Meta, 'providerErrorCode') ?? asText(clause1Meta).slice(0, 60),
  ok: pick(clause1Meta, 'providerErrorCode') === 'rate_limit_exceeded'
});

// -- scores
const scoreNamed = (name) => scoreRead.scores.find((item) => item.name === name);
record({
  label: 'judge scores land',
  sent: 'judge.tone=4, judge.groundedness=5, judge.explains_why=3',
  landed: scoreRead.scores.map((item) => `${item.name}=${item.value}`).join(', ') || '(none)',
  ok: Number(scoreNamed('judge.tone')?.value) === 4
});
record({
  label: 'blocker counts land',
  sent: 'blockers.blocking=1',
  landed: scoreNamed('blockers.blocking')?.value ?? '(none)',
  ok: Number(scoreNamed('blockers.blocking')?.value) === 1
});
record({
  label: 'an unscored dimension stays absent',
  sent: 'judge.momentum = null (not posted)',
  landed: scoreNamed('judge.momentum') ? `PRESENT = ${scoreNamed('judge.momentum').value}` : 'absent',
  ok: !scoreNamed('judge.momentum'),
  note: 'a blank judgement must never arrive as a zero'
});

/* ------------------------------- THE DISCLOSURE BOUNDARY, AT THE FAR END */

const testBlob = JSON.stringify(test.observations);
const publicBlob = JSON.stringify(pub.observations);
record({
  label: 'test cohort: content IS stored',
  sent: 'VERIFYTEST_CLAUSE_INPUT / _OUTPUT',
  landed: testBlob.includes('VERIFYTEST_CLAUSE_INPUT') ? 'present' : 'MISSING',
  ok: testBlob.includes('VERIFYTEST_CLAUSE_INPUT') && testBlob.includes('VERIFYTEST_CLAUSE_OUTPUT'),
  note: 'our own test calls must be debuggable'
});
record({
  label: 'public cohort: NO content stored',
  sent: 'VERIFYPUBLIC_* markers (dropped before sending)',
  landed: publicBlob.includes('VERIFYPUBLIC') ? 'LEAKED' : 'absent',
  ok: !publicBlob.includes('VERIFYPUBLIC'),
  note: 'the disclosure guarantee, verified against the stored trace'
});
record({
  label: 'public cohort: metadata still stored',
  sent: 'segmentIndex, promptVersion, tokens',
  landed: pub.observations.length ? `${pub.observations.length} observation(s)` : '(nothing)',
  ok: pub.observations.length > 0,
  note: 'metadata-only must still be useful'
});

/* -------------------------------------------------------------- report */

const width = Math.min(46, Math.max(...rows.map((row) => row.label.length)) + 1);
const mark = (ok) => (ok === true ? ' ok ' : ok === false ? 'FAIL' : ' ?? ');
console.info(`${'─'.repeat(110)}`);
console.info(`${'  '}${'assertion'.padEnd(width)} ${'sent'.padEnd(38)} landed`);
console.info(`${'─'.repeat(110)}`);
for (const row of rows) {
  console.info(`${mark(row.ok)} ${row.label.padEnd(width)} ${row.sent.slice(0, 37).padEnd(38)} ${row.landed.slice(0, 40)}`);
  if (row.note && row.ok !== true) console.info(`     ${' '.repeat(width)} └ ${row.note}`);
}
console.info(`${'─'.repeat(110)}\n`);

const unknowns = rows.filter((row) => row.ok === null).length;
console.info(`Traces:  ${host}/trace/${harnessTraceId}`);
console.info(`         ${host}/trace/${testTurn.traceId}   (automated_test — content expected)`);
console.info(`         ${host}/trace/${publicTurn.traceId}   (public_beta — no content expected)\n`);

if (failures > 0) {
  console.error(`${failures} mapping(s) did not land${unknowns ? `, ${unknowns} unknown` : ''}.`);
  console.error('Fix the ATTR map in scripts/lib/langfuse.mjs AND its twin in');
  console.error('worker/src/consumer/tracing.js — check-consumer-tracing.mjs asserts they agree.');
  process.exit(1);
}
console.info(`Every mapping landed${unknowns ? `; ${unknowns} informational row(s) to read above` : ''}.`);
console.info('Next: OPENAI_API_KEY=… npm run probe:live-personas -- --persona multi_goal_opener');
