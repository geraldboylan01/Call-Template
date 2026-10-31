import { REVIEWED_FIXTURES } from '../../../js/planning/analyst/fixtures/analyst-households.mjs';
import { analystStorage, runPrefix } from './storage.js';
import { analystPolicy, analystBudget } from './budget.js';
import { decryptJson } from '../consumer/crypto.js';
import { acceptedSession } from './story.js';

const ROOT = '/api/advisor/analyst';
export function analystMethods(path) {
  if (path === ROOT) return 'GET,POST,OPTIONS';
  if (new RegExp(`^${ROOT}/run-[a-f0-9-]{36}(?:/(session|log|resume))?$`).test(path)) return path.endsWith('/resume') ? 'POST,OPTIONS' : 'GET,OPTIONS';
  return null;
}
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export async function handleAnalystRequest(request, env, { respond, requireAdmin }) {
  const path = new URL(request.url).pathname;
  try {
    const access = await requireAdmin(request.method !== 'GET');
    if (access.response) return access.response;
    // Existing adviser helper intentionally allows auth-disabled local modes.
    // Analyst jobs explicitly reject that mode, like demo administration does.
    if (access.session?.authenticated !== true || access.session?.authEnabled !== true) fail(503, 'Adviser sign-in is required.');
    if (!analystMethods(path)?.split(',').includes(request.method)) fail(405, 'Method not allowed.');
    if (env.ANALYST_ENABLED !== 'true') return respond({ enabled: false, error: 'Website analyses are switched off.' }, 404);
    if (!env.SESSIONS_BUCKET || !env.LEADS_DB || !env.DEMO_DATA_ENCRYPTION_KEY || !env.ANALYST_WORKFLOW || !env.OPENAI_API_KEY) fail(503, 'Website analyses are not configured.');
    const storage = analystStorage(env), policy = analystPolicy(env);
    const realEnabled = env.ANALYST_CONFIRMED_APPLICATIONS_ENABLED === 'true';
    if (path === ROOT && request.method === 'GET') {
      const runs = (await env.LEADS_DB.prepare('SELECT * FROM analyst_runs ORDER BY created_at DESC LIMIT 100').all()).results;
      const confirmed = realEnabled ? (await env.LEADS_DB.prepare(`SELECT id AS requestId,confirmed_revision AS confirmedRevision,confirmed_at AS confirmedAt
        FROM demo_requests WHERE confirmed_revision IS NOT NULL AND confirmed_payload_encrypted IS NOT NULL ORDER BY confirmed_at DESC LIMIT 100`).all()).results : [];
      return respond({ enabled: true, fixtures: REVIEWED_FIXTURES, confirmed, runs,
        limits: { runEurMicros: policy.runLimit, dailyEurMicros: policy.dailyLimit }, realEnabled });
    }
    if (path === ROOT && request.method === 'POST') {
      if (Number(request.headers.get('Content-Length')) > 4096) fail(413, 'Analysis request is too large.');
      const raw = await request.text(); if (raw.length > 4096) fail(413, 'Analysis request is too large.');
      let body; try { body = JSON.parse(raw); } catch { fail(400, 'Send a JSON request.'); }
      let requestId, source, confirmedRevision;
      if (body.fixture && REVIEWED_FIXTURES.some(row => row.name === body.fixture)) {
        requestId = 'fixture-' + body.fixture; confirmedRevision = 7; source = { fixture: body.fixture };
      } else {
        if (!realEnabled) fail(403, 'Confirmed application analyses are switched off.');
        if (!/^dr_[A-Za-z0-9_-]{24}$/.test(body.requestId) || !Number.isInteger(body.confirmedRevision)) fail(400, 'Choose a saved confirmed revision.');
        const row = await env.LEADS_DB.prepare('SELECT * FROM demo_requests WHERE id=? AND confirmed_revision=? AND confirmed_payload_encrypted IS NOT NULL')
          .bind(body.requestId, body.confirmedRevision).first();
        if (!row) fail(409, 'That confirmed revision is unavailable. Refresh the list.');
        const cryptoEnv = { CONSUMER_DATA_ENCRYPTION_KEY: env.DEMO_DATA_ENCRYPTION_KEY,
          CONSUMER_DATA_ENCRYPTION_KEY_ID: env.DEMO_DATA_ENCRYPTION_KEY_ID || 'demo-v1',
          CONSUMER_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: env.DEMO_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON };
        const payload = await decryptJson(cryptoEnv, row.confirmed_payload_encrypted, `planeir/demo/request/${row.id}`);
        requestId = row.id; confirmedRevision = row.confirmed_revision;
        // Never read payload_encrypted (which may contain newer unconfirmed edits).
        source = { input: { revision: confirmedRevision, confirmedRevision, confirmedAt: row.confirmed_at,
          information: payload.information, clientLabel: payload.contact.fullName } };
      }
      const runId = 'run-' + crypto.randomUUID(), prefix = runPrefix(requestId, runId), timestamp = new Date().toISOString();
      await storage.put(`${prefix}/initial`, { source, status: 'queued', stage: 'queued', events: [], createdAt: timestamp, turns: 0 });
      await env.LEADS_DB.prepare('INSERT INTO analyst_runs (run_id,request_id,confirmed_revision,created_at,updated_at,snapshot_key) VALUES (?,?,?,?,?,?)')
        .bind(runId, requestId, confirmedRevision, timestamp, timestamp, `${prefix}/initial`).run();
      try { await env.ANALYST_WORKFLOW.create({ id: runId, params: { requestId, runId } }); }
      catch { await env.LEADS_DB.prepare("UPDATE analyst_runs SET status='start_failed' WHERE run_id=? AND status='queued'").bind(runId).run(); fail(503, 'The run is saved but could not start. Use Resume.'); }
      return respond({ runId, requestId, status: 'queued' }, 202);
    }
    const [runId, action] = path.slice(ROOT.length + 1).split('/');
    const row = await env.LEADS_DB.prepare('SELECT * FROM analyst_runs WHERE run_id=?').bind(runId).first();
    if (!row) fail(404, 'Analysis not found.');
    const state = await storage.get(row.snapshot_key, { includeCase: ['session', 'log'].includes(action) });
    if (!state) fail(503, 'Analysis checkpoint is unavailable.');
    let workflow;
    try { workflow = await (await env.ANALYST_WORKFLOW.get(runId)).status(); } catch { workflow = { status: 'unavailable' }; }
    // CPU/memory termination can prevent the runner's catch from executing.
    // Reconcile the platform's recorded terminal outcome with the saved case.
    if (['errored', 'terminated'].includes(workflow.status) && ['queued', 'running'].includes(state.status)) {
      state.status = workflow.status === 'errored' ? 'failed' : 'terminated';
      state.stage = 'stopped'; state.active = null; state.finishedAt = new Date().toISOString();
      state.events.push(await storage.recordEvent(row.request_id, runId, { type: 'outcome', status: state.status, at: state.finishedAt,
        message: 'The Workflow ' + workflow.status + '. Its last completed state is saved.' }, workflow.status + '-' + row.updated_at));
      const key = runPrefix(row.request_id, runId) + '/terminal/' + workflow.status;
      await storage.put(key, state); await storage.progress(runId, key, state);
    }
    if (action === 'resume') {
      if (!['failed', 'start_failed'].includes(row.status) && workflow.status !== 'errored') fail(409, 'Only a failed step can be resumed.');
      // Older complete snapshots may predate the independent event history.
      const failure = state.events.findLast(event => event.status === 'failed' && event.type === 'outcome');
      if (failure && !failure.id) await storage.recordEvent(row.request_id, runId, failure, 'failure-' + failure.at);
      await storage.recordEvent(row.request_id, runId, { type: 'workflow', name: 'Resume', status: 'resuming',
        at: new Date().toISOString(), message: 'Resume requested. Completed model and tool checkpoints will be reused.' });
      if (row.status === 'start_failed' && workflow.status === 'unavailable') await env.ANALYST_WORKFLOW.create({ id: runId, params: { requestId: row.request_id, runId } });
      else if (row.status === 'start_failed' && ['queued', 'running', 'complete'].includes(workflow.status)) return respond({ runId, status: workflow.status });
      else await (await env.ANALYST_WORKFLOW.get(runId)).restart();
      return respond({ runId, status: 'resuming' });
    }
    const spend = await analystBudget(env).summary(runId, { ...policy,
      runLimit: Math.min(policy.runLimit, state.policy?.runLimit ?? policy.runLimit) });
    const history = [...state.events, ...await storage.events(row.request_id, runId)];
    const events = [...new Map(history.map(event => [event.id || `${event.type}/${event.turn}/${event.name}/${event.at}`, event])).values()]
      .sort((a, b) => a.at.localeCompare(b.at));
    const review = { runId, requestId: row.request_id, status: row.status === 'start_failed' && state.status === 'queued' ? 'start_failed' : state.status, stage: state.stage, active: state.active,
      turns: state.turns, createdAt: state.createdAt, finishedAt: state.finishedAt, events, spend,
      usage: state.caseSummary?.budget || state.caseFile?.budget, versions: state.caseSummary?.versions || state.caseFile?.pinned.versions,
      checkerReports: state.caseSummary?.checkerReports || state.caseFile?.checkerReports || [],
      model: state.policy?.model, reasoningEffort: state.policy?.reasoningEffort, pricingVersion: state.policy?.pricingVersion,
      modelMessages: (state.transcript || []).filter(item => item.type === 'message' && item.role === 'assistant')
        .map(item => item.content.filter(part => part.type === 'output_text').map(part => part.text).join('\n')) };
    if (action === 'session') {
      if (state.status !== 'accepted') fail(409, 'This run has no accepted draft.');
      return respond({ session: await acceptedSession(state.caseFile), review });
    }
    if (action === 'log') return respond({ ...review, runLog: state.caseFile?.runLog || [] });
    return respond({ ...review, workflow });
  } catch (error) {
    return respond({ error: error.status ? error.message : 'Analysis storage or configuration is unavailable.' }, error.status || 503);
  }
}
