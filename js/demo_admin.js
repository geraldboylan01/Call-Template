import { applicationToSections, topicLabels } from './case_application/index.js';

const base = ['127.0.0.1', 'localhost'].includes(location.hostname) ? 'http://127.0.0.1:8787' : 'https://api.planeir.ie';
const $ = id => document.getElementById(id);
let csrf = '', requests = [], selected = '', nextCursor = null;
const initialRequest = new URLSearchParams(location.search).get('request');
function node(tag, text, className) { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; return n; }
function status(text) { $('demoAdminStatus').textContent = text; }
async function api(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, { method, credentials: 'include', cache: 'no-store', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf && method !== 'GET' ? { 'X-Advisor-CSRF': csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { if (response.status === 401) lock(); throw new Error(data.error || 'The request could not be completed.'); }
  return data;
}
function lock() { csrf = ''; requests = []; $('demoAdminContent').hidden = true; $('demoAdminLogin').hidden = false; $('demoAdminLogout').hidden = true; $('demoAdminList').replaceChildren(); $('demoAdminDetail').replaceChildren(); }
async function authenticated() {
  const auth = await api('/api/auth/session');
  if (!auth.authEnabled || !auth.authenticated) { lock(); status(auth.authEnabled ? 'Sign in to manage demo requests.' : 'Admin authentication is not configured. Demo management is unavailable.'); return; }
  csrf = auth.csrfToken;
  $('demoAdminContent').hidden = false; $('demoAdminLogin').hidden = true; $('demoAdminLogout').hidden = false;
  await load();
  if (initialRequest && /^dr_[A-Za-z0-9_-]{24}$/.test(initialRequest) && !requests.some(r => r.id === initialRequest)) {
    const record = await api(`/api/advisor/demo/requests/${initialRequest}`); requests.unshift(record);
  }
  if (initialRequest) selected = initialRequest;
  render();
}
async function load(more = false) {
  const data = await api(`/api/advisor/demo/requests${more && nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : ''}`);
  requests = more ? [...requests, ...data.requests] : data.requests;
  requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  nextCursor = data.nextCursor;
  $('demoAdminMore').hidden = !nextCursor;
  render();
  const invitations = await api('/api/advisor/demo/invitations');
  $('demoInvitationList').replaceChildren(...invitations.invitations.map(invite => {
    const item = node('article', '', 'workspace-notice');
    item.append(node('p', `${invite.label} · ${invite.uses}/${invite.max_uses} participants · Expires ${new Date(invite.expires_at).toLocaleString('en-IE')} · ${invite.revoked_at ? 'Revoked' : 'Active'}`));
    if (!invite.revoked_at) item.append(action('Revoke invitation', async () => { await api(`/api/advisor/demo/invitations/${invite.id}/revoke`, 'POST', {}); await load(); status('Invitation revoked for new participants.'); }));
    return item;
  }));
}
function action(label, run) {
  const button = node('button', label, 'button button-secondary button-sm'); button.type = 'button';
  button.addEventListener('click', async () => { button.disabled = true; try { await run(); } catch (error) { status(error.message); } finally { button.disabled = false; } });
  return button;
}
function render() {
  const search = $('demoAdminSearch').value.toLowerCase();
  const filtered = requests.filter(r => `${r.contact.fullName} ${r.contact.email}`.toLowerCase().includes(search));
  $('demoAdminList').replaceChildren(...filtered.map(record => {
    const button = action(`${record.contact.fullName} · ${record.contact.email} · ${record.accessStatus} · ${record.confirmedRevision === record.revision ? 'Confirmed' : 'Not confirmed'} · ${topicLabels(record.information).join(', ') || 'No topics selected'} · ${new Date(record.createdAt).toLocaleDateString('en-IE')}`, async () => { selected = record.id; render(); });
    button.setAttribute('aria-pressed', String(record.id === selected)); return button;
  }));
  if (!filtered.length) $('demoAdminList').append(node('p', 'No requests match this view.'));
  const record = requests.find(r => r.id === selected);
  if (!record) { $('demoAdminDetail').replaceChildren(node('p', 'Select a request to review it.')); return; }
  const detail = $('demoAdminDetail'); detail.replaceChildren(node('h2', record.contact.fullName), node('p', record.contact.email), node('p', `Access: ${record.accessStatus} · Saved revision: ${record.revision} · Confirmed revision: ${record.confirmedRevision ?? 'None'}`));
  const actions = node('div', '', 'demo-admin-actions');
  for (const [label, operation] of [['Approve and email access', 'approve'], ['Resend private access link', 'send-access-link'], ['Revoke demo access', 'revoke']]) {
    actions.append(action(label, async () => { await api(`/api/advisor/demo/requests/${record.id}/${operation}`, 'POST', {}); await load(); status(operation === 'revoke' ? 'Access revoked. Saved information remains available for deletion.' : 'Access updated and email queued. Delivery status appears below.'); }));
  }
  actions.append(action('Delete saved information', async () => { if (!window.confirm('Delete this person’s saved information and private access? This cannot be undone.')) return; await api(`/api/advisor/demo/requests/${record.id}`, 'DELETE'); selected = ''; await load(); status('Saved information deleted.'); }));
  detail.append(actions);
  for (const email of (record.emails || []).slice(0, 5)) detail.append(node('p', `Email: ${email.kind} · ${email.status} · ${email.attempts} attempt(s)${email.status === 'failed' ? ' — use Resend private access link to try again.' : ''}`));
  for (const section of applicationToSections(record.information)) {
    detail.append(node('h3', section.title));
    const list = node('dl');
    const line = value => { list.append(node('dt', value.label || '')); if (value.items) value.items.forEach(line); else list.append(node('dd', String(value.value ?? ''))); };
    section.lines.forEach(line); detail.append(list);
  }
}
$('demoAdminLogin').addEventListener('submit', async event => { event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true; try { await api('/api/auth/login', 'POST', { password: $('demoAdminPassword').value }); $('demoAdminPassword').value = ''; await authenticated(); status('Signed in.'); } catch (error) { status(error.message); } finally { button.disabled = false; } });
$('demoAdminLogout').addEventListener('click', async () => { try { await api('/api/auth/logout', 'POST', {}); lock(); status('Signed out.'); } catch (error) { status(error.message); } });
$('demoAdminRefresh').addEventListener('click', () => load().then(() => status('Requests refreshed.')).catch(error => status(error.message)));
$('demoAdminMore').addEventListener('click', () => load(true).catch(error => status(error.message)));
$('demoAdminSearch').addEventListener('input', render);
$('demoInvitationForm').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try {
    const data = new FormData(event.currentTarget);
    const invite = await api('/api/advisor/demo/invitations', 'POST', { label: data.get('label'), days: Number(data.get('days')), maxUses: Number(data.get('maxUses')) });
    $('demoInvitationUrl').value = invite.url; $('demoCreatedInvitation').hidden = false;
    await load(); status('Invitation created. Copy the link before leaving this page.');
  } catch (error) { status(error.message); } finally { button.disabled = false; }
});
$('demoInvitationCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('demoInvitationUrl').value); status('Invitation copied.'); } catch { $('demoInvitationUrl').select(); status('Select and copy the invitation link.'); } });
authenticated().catch(error => status(error.message));
