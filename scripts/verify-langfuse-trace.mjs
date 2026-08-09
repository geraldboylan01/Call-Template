// Does Langfuse actually read what we send it?
//
//   LANGFUSE_PUBLIC_KEY=pk-… LANGFUSE_SECRET_KEY=sk-… npm run verify:langfuse
//
// FREE. No OPENAI_API_KEY, no model calls, no spend. It needs the three
// LANGFUSE_* variables and nothing else.
//
// WHERE THOSE COME FROM. The npm script loads `.env.local` first-class and
// `.env` as an optional fallback, both via Node's own --env-file-if-exists, so
// neither file is required and a missing one is not an error. `.env.local` is
// listed LAST on the command line, which is what makes it win: Node applies
// --env-file in order and the last occurrence of a key is the one that sticks.
// A variable exported in your shell still beats both, so a one-off run can
// override the file without editing it.
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
  console.error('Put them in .env.local (preferred) or .env — `npm run verify:langfuse` loads');
  console.error('both, .env.local winning. Neither file is required; a shell variable also works:\n');
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

/**
 * Answers "can this key pair read this host, and which project is it?" BEFORE
 * anything is written.
 *
 * Run first because every later symptom looks the same from the outside: a
 * trace that is not found reads identically whether the key was rejected, the
 * host was wrong, the region was wrong, or the data simply has not been indexed
 * yet. This separates the first three from the fourth up front, so a long poll
 * is only ever spent on the one cause that a long poll can actually resolve.
 *
 * Returns the project identity, which is not a credential: an id and a name.
 */
async function preflight() {
  const result = await api('/api/public/projects');

  if (result.status === 0) {
    return {
      ok: false,
      diagnosis: 'HOST UNREACHABLE',
      detail: `Could not connect to ${host} — ${result.error}.`,
      advice: 'Check LANGFUSE_HOST. The EU region is https://cloud.langfuse.com, the US region '
        + 'is https://us.cloud.langfuse.com. They are separate deployments, not a setting.'
    };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      ok: false,
      diagnosis: 'AUTHENTICATION REJECTED',
      detail: `${host} returned ${result.status} to the public/secret key pair.`,
      advice: 'The two keys must be the PAIR issued together for one project — a public key '
        + 'from one project with a secret from another is rejected. Re-copy both from '
        + 'Project → Settings → API Keys. Also confirm the keys were issued by THIS host: '
        + 'an EU key does not work against the US region.'
    };
  }
  if (result.status === 404) {
    return {
      ok: false,
      diagnosis: 'WRONG HOST OR PATH',
      detail: `${host}/api/public/projects returned 404.`,
      advice: 'This does not look like a Langfuse deployment. Check LANGFUSE_HOST for a typo '
        + 'or a trailing path segment.'
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      diagnosis: `UNEXPECTED ${result.status}`,
      detail: `${host}/api/public/projects returned ${result.status}.`,
      advice: 'Check Langfuse status, then retry.'
    };
  }

  const projects = Array.isArray(result.body?.data) ? result.body.data : [];
  return {
    ok: true,
    projects,
    // One project is the normal answer for a project-scoped key pair.
    summary: projects.length
      ? projects.map((item) => `${item.name || '(unnamed)'} [${item.id}]`).join(', ')
      : '(the key pair authenticated but reports no project)'
  };
}

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
    return { source: '/api/public/v2/observations', status: v2.status, observations: v2.body.data };
  }
  const legacy = await api(`/api/public/traces/${encodeURIComponent(traceId)}`);
  if (legacy.ok && legacy.body) {
    return {
      source: `/api/public/traces/{id} (deprecated; v2 said ${v2.status})`,
      status: legacy.status,
      observations: legacy.body.observations || [],
      trace: legacy.body
    };
  }
  return {
    source: null,
    // The status the poll loop reports and reacts to: a 401/403 will not fix
    // itself by waiting, and a 404 on a not-yet-indexed trace will.
    status: v2.status || legacy.status,
    observations: [],
    error: `v2 → ${v2.status}${v2.error ? ` (${v2.error})` : ''}, trace → ${legacy.status}`
  };
}

async function readTrace(traceId) {
  const result = await api(`/api/public/traces/${encodeURIComponent(traceId)}`);
  return result.ok ? result.body : null;
}

/**
 * Replaces summary rows with the full observation records.
 *
 * THE LIST ENDPOINT OMITS THE FIELDS THIS SCRIPT ASSERTS ON. It returns id,
 * type, name, level, latency, modelId and prices, and simply does not carry
 * input, output, metadata, model or usage — measured against a live project,
 * where it made every one of those assertions fail while the attributes had in
 * fact mapped correctly. The per-observation record is the one with the
 * payload, so every row is re-fetched before anything is asserted.
 */
async function withFullDetail(found) {
  if (!found?.observations?.length) return found;
  const detailed = [];
  for (const row of found.observations) {
    if (!row?.id) { detailed.push(row); continue; }
    let full = null;
    for (const path of [
      `/api/public/observations/${encodeURIComponent(row.id)}`,
      `/api/public/v2/observations/${encodeURIComponent(row.id)}`
    ]) {
      const result = await api(path);
      if (result.ok && result.body && typeof result.body === 'object' && !Array.isArray(result.body)) {
        full = result.body;
        break;
      }
    }
    detailed.push(full || row);
  }
  return { ...found, observations: detailed, detailFetched: true };
}

/**
 * Scores for one trace.
 *
 * TAKES THE ENDPOINT THAT RETURNS OUR SCORES, not the first that answers.
 * Measured against a live project: /v3 and /v2 both reply 200 with an empty
 * data[], while /v1 holds the scores — so accepting the first well-formed
 * response silently reported "no scores landed" when they had. And /v1 returns
 * rows for the whole project regardless of the traceId parameter, so the filter
 * has to be applied here rather than trusted.
 */
async function readScores(traceId) {
  let fallback = { source: null, scores: [] };
  for (const path of ['/api/public/v3/scores', '/api/public/v2/scores', '/api/public/scores']) {
    const result = await api(path, { traceId, limit: 100 });
    if (!result.ok || !Array.isArray(result.body?.data)) continue;
    const mine = result.body.data.filter((item) => item.traceId === traceId);
    if (mine.length > 0) return { source: path, scores: mine };
    // Well-formed but empty: remember it only so the report can name something.
    if (!fallback.source) fallback = { source: `${path} (0 for this trace)`, scores: [] };
  }
  return fallback;
}

/**
 * Polls until the trace appears, reporting every attempt.
 *
 * THE WINDOW IS LONG ON PURPOSE. Langfuse v4 accepts a span immediately but,
 * unless the request declares `x-langfuse-ingestion-version: 4`, can take up to
 * ten minutes to surface it. We now send that header, so this should resolve in
 * seconds — but the window has to outlast the slow path anyway, or a missing
 * header on some future code path reads as "the trace was never stored" instead
 * of "you did not wait long enough". Override with LANGFUSE_VERIFY_TIMEOUT_S.
 *
 * Each attempt prints elapsed time and the HTTP status, on its own line rather
 * than a rewritten one, so a transcript of a failed run is diagnosable.
 */
async function waitForTrace(traceId, { label }) {
  const budgetMs = Math.max(30, Number(process.env.LANGFUSE_VERIFY_TIMEOUT_S) || 720) * 1_000;
  const startedAt = Date.now();
  let attempt = 0;
  let last = null;

  while (Date.now() - startedAt < budgetMs) {
    attempt += 1;
    last = await readObservations(traceId);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const status = last.status === undefined ? 'n/a' : last.status;
    console.info(
      `  [${String(elapsed).padStart(4)}s] ${label}: attempt ${String(attempt).padStart(2)} · `
      + `HTTP ${status} · ${last.observations.length} observation(s)`
      + (last.source ? ` · via ${last.source}` : '')
    );
    if (last.observations.length > 0) return last;

    // A read that is failing outright will not start working by being repeated.
    if (last.status === 401 || last.status === 403) return last;

    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    // Back off gently at first, then settle at 20s so a ten-minute window is a
    // readable number of lines rather than a hundred.
    const delay = Math.min(20_000, 2_000 * attempt, remaining);
    await sleep(delay);
  }
  return last || readObservations(traceId);
}

/**
 * Did the data arrive at all, under any id?
 *
 * Run only after the window expires. Looking the trace up by id cannot tell
 * "nothing was stored" apart from "something was stored under an id we did not
 * predict" — and those have completely different causes. This lists what the
 * project actually received, so the answer is visible rather than inferred.
 */
async function recentActivityProbe() {
  const traces = await api('/api/public/traces', { limit: 20 });
  if (!traces.ok) return { ok: false, status: traces.status };
  const data = Array.isArray(traces.body?.data) ? traces.body.data : [];
  return {
    ok: true,
    total: data.length,
    // Ours are recognisable without printing anything sensitive.
    mine: data.filter((item) => String(item.name || '').startsWith('call:verify-')
      || String(item.sessionId || '').startsWith('verify-')),
    newest: data.slice(0, 3).map((item) => ({
      id: String(item.id || '').slice(0, 12),
      name: String(item.name || '(unnamed)').slice(0, 40),
      timestamp: item.timestamp || item.createdAt || '(no time)'
    }))
  };
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

console.info(`Langfuse round-trip`);
console.info(`  host   ${host}`);
console.info(`  region ${host.includes('us.cloud.langfuse.com') ? 'US' : host.includes('cloud.langfuse.com') ? 'EU' : 'self-hosted / custom'}`);
console.info(`  keys   public ${publicKey.length} chars, secret ${secretKey.length} chars (values never printed)`);
console.info(`  run id ${runId}\n`);

console.info('Preflight: can this key pair read this host?');
const identity = await preflight();
if (!identity.ok) {
  console.error(`\n  ✗ ${identity.diagnosis}`);
  console.error(`    ${identity.detail}\n`);
  console.error(`    ${identity.advice}`);
  process.exit(1);
}
console.info(`  ✓ authenticated · project(s): ${identity.summary}`);
console.info('    Both keys resolve to this project, so ingest and read-back cannot');
console.info('    disagree about which project they are talking to.\n');

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
  console.error('\n  ✗ INGESTION REJECTED');
  console.error('    The write itself failed, so nothing was ever stored — this is not an');
  console.error('    indexing delay. A 2xx with rejectedSpans > 0 counts as a rejection here,');
  console.error('    because OTLP reports partial failure in the body, not the status line.');
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

const timeoutSeconds = Math.max(30, Number(process.env.LANGFUSE_VERIFY_TIMEOUT_S) || 720);
console.info(`Waiting for ingestion (up to ${timeoutSeconds}s; override with LANGFUSE_VERIFY_TIMEOUT_S)…`);
const harness = await waitForTrace(harnessTraceId, { label: 'harness' });

if (harness.observations.length === 0) {
  // Preflight already proved the host, the credentials and the project, and the
  // write already reported acceptance. So the causes are narrower than they look.
  console.error('\n─────────────────────────────────────────────────────────────');
  console.error('The harness trace did not appear. Narrowing it down:\n');
  console.error(`  host + credentials  : OK (preflight authenticated, project ${identity.summary})`);
  console.error(`  ingestion           : accepted, ${exported.delivered} object(s), no rejected spans`);
  console.error(`  read-back HTTP      : ${harness.status}${harness.error ? ` — ${harness.error}` : ''}`);

  if (harness.status === 401 || harness.status === 403) {
    console.error('\n  ✗ AUTHENTICATION FAILED ON READ-BACK, having succeeded on preflight.');
    console.error('    That points at a key with write but not read scope. Reissue the pair.');
    process.exit(1);
  }

  console.error('\n  Checking whether the data arrived under a different id…');
  const probe = await recentActivityProbe();
  if (!probe.ok) {
    console.error(`  Could not list recent traces (HTTP ${probe.status}).`);
  } else if (probe.mine.length > 0) {
    console.error(`\n  ✗ STORED, BUT NOT UNDER THE ID WE SENT. ${probe.mine.length} matching trace(s).`);
    console.error('    Ingestion works; the id is being rewritten, so lookup by derived id fails.');
    console.error('    That breaks grade attachment, which depends on a stable id. Report this.');
    process.exit(1);
  } else if (probe.total === 0) {
    console.error('\n  ✗ THE PROJECT CONTAINS NO TRACES AT ALL.');
    console.error('    Writes are being accepted and discarded. The usual cause is keys issued');
    console.error('    on a different region than LANGFUSE_HOST: the write is accepted by the');
    console.error(`    host you posted to (${host}) but the data lands in the project the keys`);
    console.error('    belong to. Confirm the region you signed up on and set LANGFUSE_HOST to');
    console.error('    match — https://cloud.langfuse.com (EU) or https://us.cloud.langfuse.com (US).');
    process.exit(1);
  } else {
    console.error(`\n  ✗ STILL INDEXING. The project holds ${probe.total} other trace(s):`);
    for (const item of probe.newest) console.error(`      ${item.timestamp}  ${item.name}`);
    console.error('\n    So the project is live and readable, ours just has not surfaced within');
    console.error(`    ${timeoutSeconds}s. This run sends x-langfuse-ingestion-version: 4, which is`);
    console.error('    what keeps ingestion real-time; without it Langfuse can take ~10 minutes.');
    console.error('    Retry with a longer window:  LANGFUSE_VERIFY_TIMEOUT_S=1200 npm run verify:langfuse');
    process.exit(1);
  }
}

const testSummary = await waitForTrace(testTurn.traceId, { label: 'test-cohort' });
const pubSummary = await waitForTrace(publicTurn.traceId, { label: 'public-cohort' });

// Every assertion below reads input/output/model/usage/metadata, none of which
// the list endpoint returns. Fetch the real records before asserting anything.
console.info('\nFetching full observation records (the list endpoint is a summary)…');
const harnessFull = await withFullDetail(harness);
const test = await withFullDetail(testSummary);
const pub = await withFullDetail(pubSummary);
console.info(`  harness ${harnessFull.observations.length}, test ${test.observations.length}, `
  + `public ${pub.observations.length} record(s)\n`);

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
