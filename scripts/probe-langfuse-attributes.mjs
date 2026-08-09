// Which span attributes does THIS Langfuse actually read?
//
//   npm run probe:langfuse
//
// FREE. No OPENAI_API_KEY, no model calls, no spend. Needs only the three
// LANGFUSE_* variables, loaded from .env.local / .env like the verifier.
//
// WHY THIS EXISTS. The verifier proved that observation-level attributes are not
// being stored while trace-level ones are. Published documentation cannot settle
// which names to use instead: the OTEL attribute reference, langfuse#11135 and
// langfuse#11030 disagree with each other, and the ingestion-version header
// changes the answer again. Reading more docs produces another guess.
//
// So this measures it. For every field we care about, it sends ONE SPAN PER
// CANDIDATE ATTRIBUTE NAME, each carrying a value unique to that candidate, then
// reads them back and reports which candidate actually populated the field. One
// span per candidate rather than all candidates on one span, because a mapper
// given four names for the same field picks one by priority and tells you
// nothing about the other three.
//
// The output is a table of "attribute name -> did it populate the field", which
// is the fact needed to fix scripts/lib/langfuse.mjs and
// worker/src/consumer/tracing.js correctly, in one pass.
//
// Everything it writes is synthetic: sentinel strings and made-up numbers. No
// real session, no client content, no credential is ever printed.

import { createHash } from 'node:crypto';

const publicKey = String(process.env.LANGFUSE_PUBLIC_KEY || '').trim();
const secretKey = String(process.env.LANGFUSE_SECRET_KEY || '').trim();
const host = String(process.env.LANGFUSE_HOST || '').trim() || 'https://cloud.langfuse.com';

if (!publicKey || !secretKey) {
  console.error('LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required.');
  console.error('Put them in .env.local — see docs/langfuse-setup.md. This probe costs nothing.');
  process.exit(2);
}

const authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const traceId = createHash('sha256').update(`probe:${runStamp}`).digest('hex').slice(0, 32);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/* ------------------------------------------------------------- the candidates */

const GENERATION = { key: 'langfuse.observation.type', value: { stringValue: 'generation' } };
const str = (key, value) => ({ key, value: { stringValue: value } });
const int = (key, value) => ({ key, value: { intValue: String(value) } });
const dbl = (key, value) => ({ key, value: { doubleValue: value } });

/**
 * Each entry is one field we need, and the attribute names that might carry it.
 * `read` pulls the field back out of whatever Langfuse returns, tolerating the
 * several shapes its API versions use.
 */
const PROBES = [
  {
    field: 'model',
    read: (o) => o?.model,
    candidates: [
      { name: 'gen_ai.request.model', attrs: [str('gen_ai.request.model', 'probe-model-req')], expect: 'probe-model-req' },
      { name: 'gen_ai.response.model', attrs: [str('gen_ai.response.model', 'probe-model-res')], expect: 'probe-model-res' },
      { name: 'llm.model_name', attrs: [str('llm.model_name', 'probe-model-llm')], expect: 'probe-model-llm' },
      { name: 'langfuse.observation.model', attrs: [str('langfuse.observation.model', 'probe-model-lf')], expect: 'probe-model-lf' }
    ]
  },
  {
    field: 'input tokens',
    read: (o) => o?.usage?.input ?? o?.usage?.promptTokens ?? o?.usageDetails?.input,
    candidates: [
      { name: 'gen_ai.usage.input_tokens', attrs: [int('gen_ai.usage.input_tokens', 1111)], expect: 1111 },
      { name: 'gen_ai.usage.prompt_tokens', attrs: [int('gen_ai.usage.prompt_tokens', 2222)], expect: 2222 },
      { name: 'llm.token_count.prompt', attrs: [int('llm.token_count.prompt', 3333)], expect: 3333 },
      { name: 'langfuse.observation.usage_details (json)', attrs: [str('langfuse.observation.usage_details', JSON.stringify({ input: 4444, output: 4445 }))], expect: 4444 }
    ]
  },
  {
    field: 'output tokens',
    read: (o) => o?.usage?.output ?? o?.usage?.completionTokens ?? o?.usageDetails?.output,
    candidates: [
      { name: 'gen_ai.usage.output_tokens', attrs: [int('gen_ai.usage.output_tokens', 6666)], expect: 6666 },
      { name: 'gen_ai.usage.completion_tokens', attrs: [int('gen_ai.usage.completion_tokens', 7777)], expect: 7777 },
      { name: 'llm.token_count.completion', attrs: [int('llm.token_count.completion', 8888)], expect: 8888 },
      { name: 'langfuse.observation.usage_details (json)', attrs: [str('langfuse.observation.usage_details', JSON.stringify({ input: 9990, output: 9999 }))], expect: 9999 }
    ]
  },
  {
    field: 'cost',
    read: (o) => o?.calculatedTotalCost ?? o?.totalCost ?? o?.costDetails?.total,
    candidates: [
      { name: 'gen_ai.usage.cost', attrs: [dbl('gen_ai.usage.cost', 0.001111)], expect: 0.001111 },
      { name: 'langfuse.observation.cost_details (json)', attrs: [str('langfuse.observation.cost_details', JSON.stringify({ total: 0.002222 }))], expect: 0.002222 }
    ]
  },
  {
    field: 'input (content)',
    read: (o) => o?.input,
    candidates: [
      { name: 'langfuse.observation.input', attrs: [str('langfuse.observation.input', 'PROBE_INPUT_LF')], expect: 'PROBE_INPUT_LF' },
      { name: 'gen_ai.prompt', attrs: [str('gen_ai.prompt', 'PROBE_INPUT_GENAI')], expect: 'PROBE_INPUT_GENAI' },
      { name: 'input.value', attrs: [str('input.value', 'PROBE_INPUT_VALUE')], expect: 'PROBE_INPUT_VALUE' }
    ]
  },
  {
    field: 'output (content)',
    read: (o) => o?.output,
    candidates: [
      { name: 'langfuse.observation.output', attrs: [str('langfuse.observation.output', 'PROBE_OUTPUT_LF')], expect: 'PROBE_OUTPUT_LF' },
      { name: 'gen_ai.completion', attrs: [str('gen_ai.completion', 'PROBE_OUTPUT_GENAI')], expect: 'PROBE_OUTPUT_GENAI' },
      { name: 'output.value', attrs: [str('output.value', 'PROBE_OUTPUT_VALUE')], expect: 'PROBE_OUTPUT_VALUE' }
    ]
  },
  {
    field: 'metadata',
    read: (o) => o?.metadata?.probeKey ?? (typeof o?.metadata === 'string' ? o.metadata : undefined),
    candidates: [
      { name: 'langfuse.observation.metadata.probeKey', attrs: [str('langfuse.observation.metadata.probeKey', 'PROBE_META_FLAT')], expect: 'PROBE_META_FLAT' },
      { name: 'langfuse.observation.metadata (json)', attrs: [str('langfuse.observation.metadata', JSON.stringify({ probeKey: 'PROBE_META_JSON' }))], expect: 'PROBE_META_JSON' }
    ]
  },
  {
    field: 'level',
    read: (o) => o?.level,
    candidates: [
      { name: 'langfuse.observation.level', attrs: [str('langfuse.observation.level', 'ERROR')], expect: 'ERROR' }
    ]
  }
];

/* ------------------------------------------------------------------ transport */

function spanId(seed) {
  return createHash('sha256').update(`${traceId}:${seed}`).digest('hex').slice(0, 16);
}

const now = Date.now();
const nanos = (ms) => String(BigInt(ms) * 1_000_000n);

const spans = [];
const index = [];
let n = 0;
for (const probe of PROBES) {
  for (const candidate of probe.candidates) {
    n += 1;
    const id = spanId(`${probe.field}:${candidate.name}:${n}`);
    index.push({ spanId: id, probe, candidate });
    spans.push({
      traceId,
      spanId: id,
      name: `probe.${n}`,
      kind: 1,
      startTimeUnixNano: nanos(now),
      endTimeUnixNano: nanos(now + 10),
      attributes: [
        GENERATION,
        // A model attribute is what makes Langfuse treat a span as a generation,
        // which usage and cost only mean something on. The model probe itself
        // omits it, since that is the thing being measured.
        ...(probe.field === 'model' ? [] : [str('gen_ai.request.model', 'probe-baseline-model')]),
        ...candidate.attrs
      ]
    });
  }
}

async function api(path, params = {}, init = {}) {
  const url = new URL(path, host);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  try {
    const response = await fetch(url, {
      // `init` is spread FIRST: it carries its own `headers`, so spreading it
      // last would replace the merged object and drop the authorization.
      ...init,
      headers: { authorization, accept: 'application/json', ...(init.headers || {}) },
      signal: AbortSignal.timeout(20_000)
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: String(error?.message || error) };
  }
}

console.info('Langfuse attribute probe');
console.info(`  host    ${host}`);
console.info(`  trace   ${traceId}`);
console.info(`  spans   ${spans.length} (one per candidate attribute)\n`);

const ingest = await api('/api/public/otel/v1/traces', {}, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-langfuse-ingestion-version': '4' },
  body: JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [str('service.name', 'planeir-attribute-probe')] },
      scopeSpans: [{ scope: { name: 'planeir.probe' }, spans }]
    }]
  })
});
const rejected = Number(ingest.body?.partialSuccess?.rejectedSpans || 0);
console.info(`Ingest: HTTP ${ingest.status}${rejected ? `, ${rejected} span(s) REJECTED` : ', no rejections'}`);
if (ingest.body?.partialSuccess?.errorMessage) {
  console.info(`  server said: ${ingest.body.partialSuccess.errorMessage}`);
}
if (!ingest.ok) {
  console.error('\nIngestion failed outright; nothing to read back.');
  process.exit(1);
}

/* ------------------------------------------------------------------ read back */

const budgetMs = Math.max(30, Number(process.env.LANGFUSE_VERIFY_TIMEOUT_S) || 300) * 1_000;
const startedAt = Date.now();
let observations = [];
let attempt = 0;
while (Date.now() - startedAt < budgetMs) {
  attempt += 1;
  const read = await api('/api/public/v2/observations', { traceId, limit: 200 });
  observations = Array.isArray(read.body?.data) ? read.body.data : [];
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.info(`  [${String(elapsed).padStart(3)}s] attempt ${attempt}: HTTP ${read.status}, ${observations.length}/${spans.length} observation(s)`);
  if (observations.length >= spans.length) break;
  await sleep(Math.min(15_000, 2_000 * attempt));
}
console.info('');

if (observations.length === 0) {
  console.error('Nothing came back. Re-run the verifier first — this probe assumes ingestion works.');
  process.exit(1);
}

const byId = new Map(observations.map((item) => [item.id, item]));

/* --------------------------------------------------------------------- report */

const winners = {};
let width = 0;
for (const entry of index) width = Math.max(width, entry.candidate.name.length);

for (const probe of PROBES) {
  console.info(`${probe.field}`);
  for (const entry of index.filter((item) => item.probe === probe)) {
    const stored = byId.get(entry.spanId);
    const got = stored ? probe.read(stored) : undefined;
    const hit = stored !== undefined && got !== undefined && got !== null
      && String(got) === String(entry.candidate.expect);
    if (hit && !winners[probe.field]) winners[probe.field] = entry.candidate.name;
    const mark = !stored ? ' -- ' : hit ? ' OK ' : ' no ';
    const detail = !stored
      ? 'span not stored'
      : got === undefined || got === null
        ? '(field empty)'
        : `got ${JSON.stringify(got)}`;
    console.info(`  ${mark} ${entry.candidate.name.padEnd(width)}  ${detail}`);
  }
  console.info('');
}

console.info('─'.repeat(72));
console.info('USE THESE ATTRIBUTE NAMES:');
for (const probe of PROBES) {
  console.info(`  ${probe.field.padEnd(18)} ${winners[probe.field] || '*** NONE WORKED ***'}`);
}
console.info('─'.repeat(72));

// One stored observation in full, so any field we did not think to probe is
// still visible. Synthetic data throughout; nothing here is sensitive.
const sample = byId.get(index[0].spanId) || observations[0];
console.info('\nOne stored observation, verbatim (synthetic probe data):');
console.info(JSON.stringify(sample, null, 2));

/* ----------------------------------------------------- the scores question */

console.info('\nScores: posting one, then reading it back from each API version.');
const scorePost = await api('/api/public/scores', {}, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ traceId, name: 'probe.score', value: 3 })
});
console.info(`  POST /api/public/scores → HTTP ${scorePost.status} ${JSON.stringify(scorePost.body || {}).slice(0, 200)}`);
await sleep(4_000);
for (const path of ['/api/public/v3/scores', '/api/public/v2/scores', '/api/public/scores']) {
  const read = await api(path, { traceId, limit: 50 });
  const count = Array.isArray(read.body?.data) ? read.body.data.length : 'no data[] array';
  console.info(`  GET ${path.padEnd(26)} → HTTP ${read.status}, ${count}`);
  if (Array.isArray(read.body?.data) && read.body.data.length > 0) {
    console.info(`      first: ${JSON.stringify(read.body.data[0]).slice(0, 240)}`);
  } else if (read.body && !Array.isArray(read.body?.data)) {
    console.info(`      body: ${JSON.stringify(read.body).slice(0, 240)}`);
  }
}

console.info(`\nTrace: ${host}/trace/${traceId}`);
console.info('Paste this whole output back to finish the mapping fix.');
