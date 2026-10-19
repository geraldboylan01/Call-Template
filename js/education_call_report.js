import {
  buildPublishedCapabilityToken, decryptPublishedSessionV2ForAdvisor,
  finalizePublishedClientPinV4, resolvePublishedClientSessionAccess
} from './crypto_session.js';
import { createResultsView } from './plan/views.js';
import { describePlanningCompletion } from './plan/completion.js';

// The published access key stays in this tab's memory; it is never persisted,
// copied into query parameters, sent to an event endpoint, or written to logs.
window.__CALL_CANVAS_AUTO_INIT__ = false;
const main = document.getElementById('educationReportMain');
const header = document.getElementById('educationReportHeader');
const statusHost = document.getElementById('educationReportStatus');
const resultsHost = document.getElementById('educationReportResults');
const resultStyles = document.getElementById('educationResultsStyles');
const workspaceStyles = document.getElementById('educationWorkspaceStyles');
const metaBase = document.querySelector('meta[name="call-canvas-worker-base-url"]')?.content || '';
const apiBase = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ? 'http://127.0.0.1:8787' : metaBase.replace(/\/+$/, '');
let opening = false;

function parseEducationReportLink(href) {
  const url = new URL(href);
  const publishedId = url.searchParams.get('pub') || '';
  const fragment = new URLSearchParams(url.hash.slice(1));
  const role = fragment.has('ak') ? 'advisor' : 'client';
  const secret = fragment.get(role === 'advisor' ? 'ak' : 'ck') || '';
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(publishedId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('invalid_report_link');
  if (fragment.has('ak') && fragment.has('ck')) throw new Error('invalid_report_link');
  return { publishedId, secret, role, clientView: role === 'client' || url.searchParams.get('view') === 'client' };
}

function renderConsumerReport(snapshot, host) {
  if (snapshot?.kind !== 'consumer-analysis-snapshot' || !snapshot.analysis || !snapshot.session) throw new Error('invalid_report_snapshot');
  const state = {
    view: 'results', analysis: snapshot.analysis, session: snapshot.session,
    profile: { revision: snapshot.profile?.revision, missingInformation: snapshot.profile?.missingInformation || [] },
    bootstrap: { aiEnabled: false, handoffEnabled: false, educationCallEnabled: false },
    analysisPlan: null, realtimeMeetings: [], realtimeTurns: []
  };
  const completion = describePlanningCompletion(state);
  if (!completion.ready || completion.kind !== 'analysis') throw new Error('incomplete_report_snapshot');
  const view = createResultsView(state);
  // Reuse exactly the consumer's result cards, assumptions and uncertainty
  // panels, while removing actions belonging to the live planning journey.
  for (const node of view.querySelectorAll('.education-call-cta, .results-toolbar, .progress-meter, .meeting-transcript-section, [data-action]')) node.remove();
  host.replaceChildren(view);
  host.setAttribute('aria-busy', 'false');
  return { completion, view };
}

async function fetchReport(url, init, role) {
  const response = await fetch(url, { ...init, credentials: 'include', cache: 'no-store' });
  if (response.status === 401 || response.status === 403) throw Object.assign(new Error('report_access_required'), { authRequired: role === 'advisor' });
  if (response.status === 404 || response.status === 410) throw Object.assign(new Error('report_unavailable'), { unavailable: true });
  if (!response.ok) throw new Error('report_fetch_failed');
  return response;
}

async function openWorkspaceReport(snapshot, publishedId, secret, role) {
  // Install the existing read-only shell before app.js captures its UI nodes.
  const response = await fetch(new URL('../app/session.html', import.meta.url), { cache: 'no-store' });
  if (!response.ok) throw new Error('report_shell_unavailable');
  const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
  const shell = parsed.getElementById('app');
  if (!shell) throw new Error('report_shell_unavailable');
  document.body.replaceChildren(document.importNode(shell, true));
  resultStyles.disabled = true;
  workspaceStyles.media = 'all';
  if (!workspaceStyles.sheet) await new Promise((resolve, reject) => {
    workspaceStyles.addEventListener('load', resolve, { once: true });
    workspaceStyles.addEventListener('error', () => reject(new Error('report_styles_unavailable')), { once: true });
  });
  const { importPublishedSession } = await import('./state.js');
  const { initApp } = await import('./app.js');
  await initApp({
    initialSession: importPublishedSession(snapshot),
    assetAccess: { publishedId, secret, role },
    readOnly: true, allowDevPanel: false, allowPublish: false,
    persistLocalSession: false, showPensionToggle: false, startInOverview: true
  });
}

function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function displayReport(plaintext, link) {
  const snapshot = JSON.parse(plaintext);
  if (snapshot.kind === 'consumer-analysis-snapshot') {
    renderConsumerReport(snapshot, resultsHost);
    statusHost.hidden = true;
  } else {
    await openWorkspaceReport(snapshot, link.publishedId, link.secret, link.role);
  }
}

function clientPinRequired(bundle) {
  return Number(bundle?.v) >= 4 || Boolean(bundle?.clientAccess?.pinRequired);
}

function requestClientPin(bundle, link) {
  const firstOpen = Number(bundle?.v) >= 4 && bundle?.clientAccess?.pinState === 'pending';
  const form = element('form', '', 'form-field');
  const title = element('h1', firstOpen ? 'Protect your report' : 'Unlock your report');
  const description = element('p', firstOpen
    ? 'Create a 6-digit PIN for this private report. Keep it so you can return to your analysis.'
    : 'Enter the 6-digit PIN you created for this private report.');
  const field = (text, name) => {
    const label = element('label', '', 'form-field');
    const input = element('input', '', 'text-input');
    Object.assign(input, { name, type: 'password', inputMode: 'numeric', pattern: '[0-9]{6}', maxLength: 6,
      required: true, autocomplete: firstOpen ? 'new-password' : 'current-password' });
    label.append(element('span', text, 'field-label'), input);
    form.append(label);
    return input;
  };
  const pin = field(firstOpen ? 'Create a 6-digit PIN' : '6-digit PIN', 'reportPin');
  const confirmation = firstOpen ? field('Confirm your 6-digit PIN', 'reportPinConfirm') : null;
  const error = element('p', '', 'form-error'); error.setAttribute('role', 'alert');
  const submit = element('button', firstOpen ? 'Save PIN and open report' : 'Open report', 'primary-button');
  submit.type = 'submit'; form.append(error, submit);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    if (confirmation && pin.value !== confirmation.value) { error.textContent = 'PINs do not match.'; return; }
    error.textContent = ''; submit.disabled = true;
    try {
      let plaintext;
      if (firstOpen) {
        const revision = Number(bundle.clientAccess.revision) || 1;
        const finalized = await finalizePublishedClientPinV4(link.secret, bundle, pin.value, { nextRevision: revision + 1 });
        const capability = await buildPublishedCapabilityToken(link.secret, 'client');
        const response = await fetch(`${apiBase}/api/published-sessions/${encodeURIComponent(link.publishedId)}/client-pin/setup`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Published-Capability': capability },
          credentials: 'omit', cache: 'no-store',
          body: JSON.stringify({ expectedRevision: revision, clientBundle: finalized.clientBundle })
        });
        if (response.status === 409) {
          opening = false;
          await openReport(link);
          return;
        }
        if (response.status === 404 || response.status === 410) throw Object.assign(new Error('report_unavailable'), { unavailable: true });
        if (!response.ok) throw new Error('Your PIN could not be saved. Please try again.');
        plaintext = finalized.plaintext;
      } else {
        plaintext = (await resolvePublishedClientSessionAccess(link.secret, bundle, { pin: pin.value })).plaintext;
      }
      pin.value = ''; if (confirmation) confirmation.value = '';
      await displayReport(plaintext, link);
    } catch (failure) {
      if (failure?.unavailable) showFailure(failure, () => void openReport(link));
      else error.textContent = failure?.message === 'Invalid PIN' ? 'That PIN did not unlock this report. Please try again.'
        : failure?.message || 'This report could not be unlocked. Please try again.';
    } finally { submit.disabled = false; }
  });
  statusHost.replaceChildren(title, description, form);
  resultsHost.setAttribute('aria-busy', 'false');
  pin.focus();
}

function showFailure(error, retry) {
  resultStyles.disabled = false;
  workspaceStyles.media = 'not all';
  if (!document.body.contains(main)) document.body.replaceChildren(header, main);
  resultsHost.replaceChildren(); resultsHost.setAttribute('aria-busy', 'false');
  statusHost.hidden = false;
  const heading = document.createElement('h1'); heading.textContent = 'Walkthrough report';
  const message = document.createElement('p');
  message.textContent = error?.authRequired
    ? 'Sign in to your adviser workspace, then retry here to open the private report.'
    : error?.unavailable ? 'This report is no longer available. It may have expired or been revoked.'
      : 'This report could not be opened. Use the complete private link from your walkthrough email, or retry shortly.';
  statusHost.replaceChildren(heading, message);
  if (error?.authRequired) {
    const link = document.createElement('a');
    link.href = './index.html'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.className = 'secondary-button'; link.textContent = 'Sign in to workspace';
    statusHost.append(link);
  }
  if (retry) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'primary-button'; button.textContent = 'Retry opening report';
    button.addEventListener('click', retry);
    statusHost.append(button);
  }
}

async function openReport(link) {
  if (opening) return;
  opening = true;
  statusHost.hidden = false;
  statusHost.textContent = 'Opening the report shared for this call…';
  resultsHost.setAttribute('aria-busy', 'true');
  try {
    const brand = document.getElementById('educationReportBrand');
    if (brand && link.role === 'client') {
      brand.href = '../plan/'; brand.setAttribute('aria-label', 'Planéir home');
    }
    const badge = header?.querySelector('.beta-badge');
    if (badge) badge.textContent = link.clientView ? 'Your analysis · Read only' : 'Private report · Read only';
    const capability = await buildPublishedCapabilityToken(link.secret, link.role);
    const response = await fetchReport(`${apiBase}/api/published-sessions/${encodeURIComponent(link.publishedId)}/${link.role}`, {
      headers: { 'X-Published-Capability': capability }
    }, link.role);
    const bundle = await response.json();
    if (link.role === 'client' && clientPinRequired(bundle)) {
      requestClientPin(bundle, link);
      return;
    }
    const resolved = link.role === 'advisor'
      ? await decryptPublishedSessionV2ForAdvisor(link.secret, bundle)
      : await resolvePublishedClientSessionAccess(link.secret, bundle);
    await displayReport(resolved.plaintext, link);
  } catch (error) {
    showFailure(error, () => void openReport(link));
  } finally { opening = false; }
}

if (main && statusHost && resultsHost) {
  try {
    const link = parseEducationReportLink(window.location.href);
    // Clear the fragment before making any network request or creating UI.
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    void openReport(link);
  } catch (error) {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    showFailure(error);
  }
}
