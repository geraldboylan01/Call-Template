import { analystElement as el, euros, renderAnalystReview } from './analyst_review.js';

const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
const base = local ? 'http://127.0.0.1:8787' : document.querySelector('meta[name="call-canvas-worker-base-url"]').content;
const ROOT = '/api/advisor/analyst', $ = id => document.getElementById(id);
let csrf = '', selected = new URLSearchParams(location.search).get('run'), timer;
const status = text => { $('status').textContent = text; };
function lock() { csrf = ''; clearTimeout(timer); $('content').hidden = true; $('login').hidden = false; $('logout').hidden = true; $('detail').replaceChildren(); }
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, credentials: 'include', cache: 'no-store',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-Advisor-CSRF': csrf } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { if (response.status === 401) lock(); throw new Error(data.error || 'The analysis request failed.'); }
  return data;
}
function button(text, action) {
  const node = el('button', text, 'button button-secondary'); node.type = 'button';
  node.addEventListener('click', async () => { node.disabled = true; try { await action(); } catch (error) { status(error.message); } finally { node.disabled = false; } });
  return node;
}
async function start(source) {
  const data = await api(ROOT, 'POST', source); selected = data.runId;
  history.replaceState(null, '', `?run=${encodeURIComponent(selected)}`);
  status('Analysis started. You can close this page and return to the saved run.'); await load();
}
async function load() {
  const data = await api(ROOT);
  $('limits').textContent = `${euros(data.limits.runEurMicros)} per analysis · ${euros(data.limits.dailyEurMicros)} per day. Accepted drafts remain private.`;
  $('fixtures').replaceChildren(...data.fixtures.map(row => {
    const card = el('article', undefined, 'analyst-household');
    card.append(el('h3', row.name), el('p', row.description), button('Run analysis', () => start({ fixture: row.name }))); return card;
  }));
  $('confirmedSection').hidden = !data.realEnabled;
  $('confirmed').replaceChildren(...data.confirmed.map(row => button(`${row.requestId} · revision ${row.confirmedRevision} · Run analysis`, () => start(row))));
  $('runs').replaceChildren(...data.runs.map(row => {
    const item = button(`${row.request_id} · ${row.status} · ${new Date(row.created_at).toLocaleString('en-IE')}`, async () => {
      selected = row.run_id; history.replaceState(null, '', `?run=${encodeURIComponent(selected)}`); await poll();
    });
    item.dataset.runId = row.run_id; return item;
  }));
  if (selected) await poll();
}
async function poll() {
  clearTimeout(timer); const id = selected;
  if (!id) return;
  const data = await api(`${ROOT}/${encodeURIComponent(id)}`);
  if (id !== selected) return;
  const savedRun = [...$('runs').children].find(item => item.dataset.runId === id);
  if (savedRun) savedRun.textContent = `${data.requestId} · ${data.status} · ${new Date(data.createdAt).toLocaleString('en-IE')}`;
  renderAnalystReview($('detail'), data);
  if (data.status === 'accepted') {
    const link = el('a', 'Open draft on the story screen', 'button button-primary'); link.href = `./?analystRun=${encodeURIComponent(id)}`; $('detail').prepend(link);
  }
  if (['failed', 'start_failed'].includes(data.status) || data.workflow?.status === 'errored') $('detail').append(button('Resume failed step', async () => { await api(`${ROOT}/${id}/resume`, 'POST', {}); status('Resuming from the last completed step.'); await poll(); }));
  if (new URLSearchParams(location.search).get('log') === '1') {
    const log = await api(`${ROOT}/${id}/log`), details = el('details'); details.open = true;
    details.append(el('summary', 'Complete tool inputs and results'), el('pre', JSON.stringify(log.runLog, null, 2))); $('detail').append(details);
  }
  if (['queued', 'running'].includes(data.status)) timer = setTimeout(() => poll().catch(error => status(error.message)), 5000);
}
async function authenticated() {
  const auth = await api('/api/auth/session');
  if (!auth.authEnabled || !auth.authenticated) { lock(); status('Sign in to run and read private analyses.'); return; }
  csrf = auth.csrfToken; $('login').hidden = true; $('logout').hidden = false;
  try { await load(); $('content').hidden = false; status(''); }
  catch (error) { $('content').hidden = true; status(error.message); }
}
$('login').addEventListener('submit', async event => {
  event.preventDefault(); try { await api('/api/auth/login', 'POST', { password: $('password').value }); $('password').value = ''; await authenticated(); } catch (error) { status(error.message); }
});
$('logout').addEventListener('click', async () => { try { await api('/api/auth/logout', 'POST', {}); lock(); } catch (error) { status(error.message); } });
$('refresh').addEventListener('click', () => load().catch(error => status(error.message)));
document.addEventListener('visibilitychange', () => { if (!document.hidden && selected && csrf) void poll().catch(error => status(error.message)); });
authenticated().catch(error => status(error.message));
