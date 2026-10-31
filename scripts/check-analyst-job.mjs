import assert from 'node:assert/strict';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { runAnalyst } from '../worker/src/analyst/runner.js';
import { analystStorage, runPrefix } from '../worker/src/analyst/storage.js';
import { analystBudget, analystPolicy, usageCost } from '../worker/src/analyst/budget.js';
import { analystResponseBody } from '../worker/src/consumer/ai_provider.js';
import { executeTool } from '../js/planning/analyst/executors.js';
import { TOOL_CATALOGUE } from '../js/planning/analyst/contracts.js';
import { createFixtureCase } from '../js/planning/analyst/fixtures/analyst-households.mjs';
import { storeNewCase, callLocalTool, readLocalCase } from './analyst-local-store.mjs';
import { acceptedSession } from '../worker/src/analyst/story.js';
import { handleAnalystRequest } from '../worker/src/analyst/router.js';
import { encryptJson } from '../worker/src/consumer/crypto.js';

console.info = () => {};
// In-process D1 stand-in; the budget triggers run in real SQLite.
const sqlite = new DatabaseSync(':memory:');
function sql(mode, query, values = []) {
  if (mode === 'script') { sqlite.exec(query); return null; }
  const statement = sqlite.prepare(query);
  values = values.map(value => value === undefined ? null : value);
  if (mode === 'all') return { results: statement.all(...values) };
  if (mode === 'first') return statement.get(...values) || null;
  return { meta: { changes: Number(statement.run(...values).changes) } };
}
const db = { prepare(query) { const statement = values => ({ bind: (...args) => statement(args),
  first: async () => sql('first', query, values), all: async () => sql('all', query, values), run: async () => sql('run', query, values) }); return statement([]); } };
const objects = new Map();
const bucket = { async put(key, value) { objects.set(key, value); }, async head(key) { return objects.has(key) ? { key } : null; }, async get(key) { return objects.has(key) ? { text: async () => objects.get(key) } : null; },
  async list({ prefix, delimiter }) { return { objects: [...objects.keys()].filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes(delimiter)).map(key => ({ key })), truncated: false }; } };
const env = { ANALYST_ENABLED: 'true', LEADS_DB: db, SESSIONS_BUCKET: bucket, DEMO_DATA_ENCRYPTION_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' };
const storage = analystStorage(env), budget = analystBudget(env), policy = analystPolicy(env);
let local;
try {
  sql('script', await readFile(new URL('../worker/migrations/0028_analyst_jobs.sql', import.meta.url), 'utf8'));
  // The worker imports the js/ copy; the existing checks read scripts/fixtures.
  assert.equal(await readFile(new URL('../js/planning/analyst/fixtures/form-to-profile.households.json', import.meta.url), 'utf8'),
    await readFile(new URL('./fixtures/form-to-profile.households.json', import.meta.url), 'utf8'), 'The two household fixture copies match');
  const replay = JSON.parse(await readFile(new URL('./fixtures/analyst-job-replay.json', import.meta.url), 'utf8'));
  assert.deepEqual([...new Set(replay.calls.map(call => call.name))].sort(), TOOL_CATALOGUE.map(tool => tool.name).sort(), 'The recorded replay exercises every analyst tool');
  const story = JSON.parse(await readFile(new URL('./fixtures/' + replay.storyFixture, import.meta.url), 'utf8')); story.routeId = '$tradeDown.routeId';
  for (const call of replay.calls) if (call.input.storyFixture) call.input = { story };
  const requestId = 'fixture-' + replay.fixture, runId = 'run-' + crypto.randomUUID(), prefix = runPrefix(requestId, runId);
  const seed = { source: { fixture: replay.fixture }, status: 'queued', events: [], turns: 0, createdAt: new Date().toISOString() };
  await storage.put(prefix + '/initial', seed);
  await db.prepare('INSERT INTO analyst_runs VALUES (?,?,?,?,?,?,?)').bind(runId, requestId, 7, seed.createdAt, seed.createdAt, 'queued', prefix + '/initial').run();
  const done = new Map(); let beforeFailure = true, afterFailure = true, settlementFailure = true, paid = 0, executed = 0;
  const sleeps = [];
  const immediateStep = { do: async (_, __, cb) => cb(), sleep: async () => {} };
  const step = { async sleep(name, duration) { assert.equal(duration, '1 second'); sleeps.push(name); }, async do(name, options, callback) {
    assert.equal(options.timeout, '10 minutes');
    if (done.has(name)) return done.get(name);
    if (name === 'tool-5-0' && beforeFailure) { beforeFailure = false; throw new Error('Injected failure before tool execution'); }
    const result = await callback();
    assert.equal(typeof result, 'string', 'Only opaque snapshot keys enter Workflows persistence');
    if (name === 'tool-6-0' && afterFailure) { afterFailure = false; throw new Error('Injected failure after checkpoint, before acknowledgement'); }
    done.set(name, result); return result;
  } };
  const resolvedCalls = []; let tradeDown;
  const modelImpl = async body => {
    paid++;
    assert.equal(body.store, false); assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.equal(body.reasoning.effort, 'high'); assert.equal(body.tools.length, 10);
    assert.match(body.input[0].content, /"profile":/);
    assert.match(body.input[0].content, /"planningFacts":/);
    assert.match(body.input[0].content, /Explicit invented supplemental review facts/);
    assert.ok(body.tools.every(tool => tool.strict === false));
    const turn = body.input.filter(row => row.type === 'function_call_output').length;
    if (turn) assert.ok(body.input.some(row => row.encrypted_content === 'opaque-test-reasoning'));
    if (turn === 4) {
      const result = JSON.parse(body.input.filter(row => row.type === 'function_call_output').at(-1).output);
      tradeDown = result.data.suggestions.find(row => row.route?.changes.some(change => change.type === 'tradeDownHome'));
      assert.ok(tradeDown, 'Recorded trade-down suggestion exists');
    }
    const template = replay.calls[turn]; assert.ok(template);
    const call = JSON.parse(JSON.stringify(template).replaceAll('$tradeDown.candidateId', tradeDown?.candidateId || '').replaceAll('$tradeDown.routeId', tradeDown?.route.id || ''));
    resolvedCalls[turn] = call;
    return { id: 'fake-' + turn, status: 'completed', usage: { input_tokens: 3000, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 1500, output_tokens_details: { reasoning_tokens: 1000 } },
      output: [{ type: 'reasoning', encrypted_content: 'opaque-test-reasoning', summary: [] },
        { type: 'function_call', call_id: 'call-' + turn, name: call.name, arguments: JSON.stringify(call.input) }] };
  };
  const model = async body => { try { return await modelImpl(body); } catch (error) { console.error('Fake model failure:', error.message); throw error; } };
  const timings = [];
  const retryableBudget = { ...budget, settle: async (...args) => {
    if (args[1] === 3 && settlementFailure) { settlementFailure = false; throw new Error('Injected settlement failure'); }
    return budget.settle(...args);
  } };
  const options = { requestId, runId, step, storage, budget: retryableBudget, env, model, instructions: 'Test instructions', onTool: async (...args) => {
    executed++; const cpu = process.cpuUsage(), start = performance.now();
    const result = await executeTool(...args), delta = process.cpuUsage(cpu);
    timings.push({ tool: args[1], cpuMs: (delta.user + delta.system) / 1000, wallMs: performance.now() - start, usage: result.caseFile.runLog.at(-1).usage });
    return result;
  } };
  await assert.rejects(runAnalyst(options), /Injected settlement failure/);
  await assert.rejects(runAnalyst(options), /Injected failure before/);
  await assert.rejects(runAnalyst(options), /Injected failure after/);
  const finalKey = await runAnalyst(options), state = await storage.get(finalKey);
  assert.equal(state.status, 'accepted', JSON.stringify(state.events.slice(-4)));
  assert.equal(executed, replay.calls.length, 'Checkpoint retry did not execute a completed tool twice');
  assert.equal(paid, replay.calls.length, 'Resume did not make a paid model call twice');
  assert.ok(sleeps.includes('dispatch-model-1') && sleeps.includes('dispatch-tool-1-0'), 'Model and tool steps yield through durable dispatch boundaries');
  assert.equal((await storage.events(requestId, runId)).filter(event => event.status === 'failed').length, 3, 'Failed outcomes remain in the encrypted history after a successful resume');
  assert.equal(state.caseFile.reviewStatus, 'pending');
  assert.equal(state.events.find(row => row.name === 'run_whatif').refusals[0].code, 'not_built_yet');
  assert.ok((await acceptedSession(state.caseFile)).planStory);
  const caseObjects = [...objects.keys()].filter(key => key.includes('/cases/')).length;
  await storage.put(prefix + '/unchanged-case', { ...state, stage: 'review' });
  assert.equal([...objects.keys()].filter(key => key.includes('/cases/')).length, caseObjects, 'A progress update reuses the unchanged encrypted case');
  assert.equal((await storage.get(finalKey, { includeCase: false })).caseFile, undefined, 'Status reads do not load the large case');
  for (const [key, value] of objects) { assert.ok(!value.includes('fictional_dated_cost'), `Unencrypted household content at ${key}`); }
  const manifest = [...objects.keys()].find(key => key.startsWith(finalKey + '/'));
  const tampered = objects.get(manifest); objects.set(manifest, tampered.replace(/"ct":"./, '"ct":"!'));
  await assert.rejects(storage.get(finalKey)); objects.set(manifest, tampered);

  // Actual local store and CLI-facing path, not a second mock executor.
  local = await storeNewCase(await createFixtureCase(replay.fixture, runId));
  for (const call of resolvedCalls) await callLocalTool(local.directory, call.name, call.input);
  assert.deepEqual((await readLocalCase(local.directory)).caseFile, state.caseFile, 'Website and CLI produce the identical case file for the recorded calls');

  const cost = usageCost({ input_tokens: 3000, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 1500, output_tokens_details: { reasoning_tokens: 1000 } }, policy);
  assert.equal(cost.costEurMicros, 20100, 'Cached input is discounted and reasoning is charged exactly once');
  assert.equal(analystPolicy({ ANALYST_RUN_BUDGET_EUR_CENTS: '999999', ANALYST_DAILY_BUDGET_EUR_CENTS: '999999' }).runLimit, 30000000);
  assert.equal(analystPolicy({ ANALYST_REASONING_EFFORT: 'xhigh' }).reasoningEffort, 'xhigh');
  assert.throws(() => analystPolicy({ ANALYST_MODEL: 'gpt-6-astra' }));
  assert.equal(analystResponseBody(policy, '', []).tools[0].name, TOOL_CATALOGUE[0].name);

  // An actual runner stop before the first API request, with state saved.
  const cappedId = 'run-' + crypto.randomUUID(), cappedPrefix = runPrefix(requestId, cappedId);
  await storage.put(cappedPrefix + '/initial', seed);
  await db.prepare('INSERT INTO analyst_runs VALUES (?,?,?,?,?,?,?)').bind(cappedId, requestId, 7, seed.createdAt, seed.createdAt, 'queued', cappedPrefix + '/initial').run();
  const capped = await runAnalyst({ ...options, runId: cappedId, env: { ...env, ANALYST_RUN_BUDGET_EUR_CENTS: '0' }, step: immediateStep, model: () => { throw new Error('Budget allowed an API request'); } });
  assert.equal((await storage.get(capped)).status, 'budget_exhausted');
  const refusedId = 'run-' + crypto.randomUUID(), refusedPrefix = runPrefix(requestId, refusedId);
  await storage.put(refusedPrefix + '/initial', { ...seed, source: { input: { revision: 2, confirmedRevision: 1 } } });
  await db.prepare('INSERT INTO analyst_runs VALUES (?,?,?,?,?,?,?)').bind(refusedId, requestId, 1, seed.createdAt, seed.createdAt, 'queued', refusedPrefix + '/initial').run();
  const refusedKey = await runAnalyst({ ...options, runId: refusedId, step: immediateStep, model: () => { throw new Error('Refused case reached the model'); } });
  assert.equal((await storage.get(refusedKey)).status, 'case_refused');
  assert.equal((await storage.get(refusedKey)).events.find(row => row.name === 'create_case').refusals[0].path, '/confirmedRevision');
  await assert.rejects(budget.reserve(cappedId, 1, 1, { ...policy, dailyLimit: 1 }), /cap/);
  const unknownId = 'run-' + crypto.randomUUID();
  await db.prepare('INSERT INTO analyst_runs VALUES (?,?,?,?,?,?,?)').bind(unknownId, requestId, 7, seed.createdAt, seed.createdAt, 'queued', 'unused').run();
  await budget.reserve(unknownId, 1, 10000, policy);
  await assert.rejects(budget.reserve(unknownId, 1, 10000, policy), /uncertain/);

  const request = new Request('https://api.planeir.ie/api/advisor/analyst');
  const hooks = { respond: (data, status = 200) => ({ data, status }), requireAdmin: async () => ({ session: { authEnabled: true, authenticated: true } }) };
  assert.equal((await handleAnalystRequest(request, { ANALYST_ENABLED: 'false' }, hooks)).status, 404);
  assert.equal((await handleAnalystRequest(request, env, { ...hooks, requireAdmin: async () => ({ session: { authEnabled: false, authenticated: false } }) })).status, 503);
  assert.equal((await handleAnalystRequest(request, env, { ...hooks, requireAdmin: async () => ({ response: { status: 401 } }) })).status, 401);
  let created;
  const enabledEnv = { ...env, OPENAI_API_KEY: 'fake-not-used', ANALYST_WORKFLOW: { create: async value => { created = value; } } };
  const realId = 'dr_' + 'A'.repeat(24);
  const createRequest = revision => new Request(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: realId, confirmedRevision: revision }) });
  assert.equal((await handleAnalystRequest(createRequest(7), enabledEnv, hooks)).status, 403, 'The second flag independently blocks confirmed applications');
  sql('script', 'CREATE TABLE demo_requests (id TEXT PRIMARY KEY, revision INTEGER, confirmed_revision INTEGER, confirmed_at TEXT, confirmed_payload_encrypted TEXT, payload_encrypted TEXT);');
  const confirmation = { information: { question: 'Recorded confirmation only' }, contact: { fullName: 'Invented confirmation test' } };
  const cryptoEnv = { CONSUMER_DATA_ENCRYPTION_KEY: env.DEMO_DATA_ENCRYPTION_KEY, CONSUMER_DATA_ENCRYPTION_KEY_ID: 'demo-v1' };
  const aad = 'planeir/demo/request/' + realId;
  await db.prepare('INSERT INTO demo_requests VALUES (?,?,?,?,?,?)').bind(realId, 8, 7, seed.createdAt,
    await encryptJson(cryptoEnv, confirmation, aad), await encryptJson(cryptoEnv, { ...confirmation, information: { question: 'Unconfirmed edit' } }, aad)).run();
  const realEnv = { ...enabledEnv, ANALYST_CONFIRMED_APPLICATIONS_ENABLED: 'true' };
  assert.equal((await handleAnalystRequest(createRequest(6), realEnv, hooks)).status, 409, 'A superseded confirmation cannot be substituted');
  let requiredCsrf;
  const started = await handleAnalystRequest(createRequest(7), realEnv, { ...hooks, requireAdmin: async csrf => { requiredCsrf = csrf; return { session: { authEnabled: true, authenticated: true } }; } });
  assert.equal(started.status, 202); assert.equal(requiredCsrf, true);
  assert.deepEqual(Object.keys(created.params).sort(), ['requestId', 'runId'], 'Workflow parameters contain no household data');
  const pinnedInput = (await storage.get(runPrefix(realId, started.data.runId) + '/initial')).source.input;
  assert.deepEqual(pinnedInput.information, confirmation.information, 'Only the confirmed encrypted snapshot enters the run');
  assert.equal(pinnedInput.revision, 7); assert.equal(pinnedInput.confirmedRevision, 7);
  const terminalEnv = { ...realEnv, ANALYST_WORKFLOW: { get: async () => ({ status: async () => ({ status: 'terminated' }) }) } };
  const terminal = await handleAnalystRequest(new Request(request.url + '/' + started.data.runId), terminalEnv, hooks);
  assert.equal(terminal.data.status, 'terminated');
  assert.equal(terminal.data.events.at(-1).status, 'terminated', 'Platform termination is recorded even when no runner catch can execute');
  const output = new URL('../.worker-dry-run/analyst-job/', import.meta.url); await mkdir(output, { recursive: true });
  await writeFile(new URL('cpu.json', output), JSON.stringify(timings, null, 2));
  console.log('[AnalystJob] accepted recorded replay; encrypted checkpoints; failed-step resume; exact CLI parity; refusals; euro caps; auth gates. No API spend.');
  console.log('[AnalystJob] local CPU ms: ' + timings.map(row => `${row.tool}=${Math.round(row.cpuMs)}`).join(', '));
  console.log('[AnalystJob] final checkpoint bytes: ' + JSON.stringify(state).length + '; encrypted objects: ' + objects.size);
} finally { if (local) await rm(local.directory, { recursive: true, force: true }); sqlite.close(); }
