import {
  buildPublishedCapabilityToken,
  decryptPublishedSessionV2ForAdvisor,
  rotatePublishedClientAccessV4
} from './crypto_session.js';
import {
  exportPublishedSession,
  exportSession,
  importPublishedSession
} from './state.js';

function getMetaContent(name) {
  const element = document.querySelector(`meta[name="${name}"]`);
  return element?.getAttribute('content')?.trim() || '';
}

const WORKER_BASE_URL = (() => {
  if (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') {
    return 'http://127.0.0.1:8787';
  }

  const override = getMetaContent('call-canvas-worker-base-url');
  return override ? override.replace(/\/+$/, '') : '';
})();

const DEFAULT_TIMEZONE = 'Europe/Dublin';
const DEFAULT_LOCATION = 'Zoom meeting link will be created automatically';
const DEFAULT_DURATION_MINUTES = 30;
const PIPELINE_STAGES = [
  'new_lead',
  'reviewing',
  'awaiting_meeting',
  'meeting_booked',
  'session_in_progress',
  'session_published',
  'post_session_email_sent',
  'client_opened',
  'declined',
  'expired',
  'archived'
];
const STAGE_LABELS = {
  new_lead: 'New lead',
  reviewing: 'Reviewing',
  awaiting_meeting: 'Awaiting meeting',
  meeting_booked: 'Meeting booked',
  session_in_progress: 'Session in progress',
  session_published: 'Session published',
  post_session_email_sent: 'Post-session email sent',
  client_opened: 'Client opened',
  declined: 'Declined',
  expired: 'Expired',
  archived: 'Archived'
};
const STAGE_RANKS = PIPELINE_STAGES.reduce((memo, stage, index) => {
  memo[stage] = index;
  return memo;
}, {});

const ui = {
  toastHost: document.getElementById('toastHost'),
  clientStageTabs: document.getElementById('clientStageTabs'),
  clientSourceTabs: document.getElementById('clientSourceTabs'),
  clientSearchInput: document.getElementById('clientSearchInput'),
  clientRefreshButton: document.getElementById('clientRefreshBtn'),
  clientListStatus: document.getElementById('clientListStatus'),
  clientList: document.getElementById('clientList'),
  clientEmptyState: document.getElementById('clientEmptyState'),
  clientDetailCard: document.getElementById('clientDetailCard'),
  clientNameTitle: document.getElementById('clientNameTitle'),
  clientEmailTitle: document.getElementById('clientEmailTitle'),
  clientStageBadge: document.getElementById('clientStageBadge'),
  clientActionError: document.getElementById('clientActionError'),
  clientStageUpdatedAt: document.getElementById('clientStageUpdatedAt'),
  clientLastScheduleEmail: document.getElementById('clientLastScheduleEmail'),
  clientLastFinalEmail: document.getElementById('clientLastFinalEmail'),
  clientLastOpened: document.getElementById('clientLastOpened'),
  clientFullNameInput: document.getElementById('clientFullNameInput'),
  clientEmailInput: document.getElementById('clientEmailInput'),
  clientPhoneInput: document.getElementById('clientPhoneInput'),
  clientStageSelect: document.getElementById('clientStageSelect'),
  clientAdvisorNotes: document.getElementById('clientAdvisorNotes'),
  clientSaveButton: document.getElementById('clientSaveBtn'),
  clientStartSessionButton: document.getElementById('clientStartSessionBtn'),
  clientLeadSelect: document.getElementById('clientLeadSelect'),
  clientLeadReason: document.getElementById('clientLeadReason'),
  clientLeadAvailabilityNotes: document.getElementById('clientLeadAvailabilityNotes'),
  clientScheduleDate: document.getElementById('clientScheduleDate'),
  clientScheduleTime: document.getElementById('clientScheduleTime'),
  clientScheduleDuration: document.getElementById('clientScheduleDuration'),
  clientScheduleTimezone: document.getElementById('clientScheduleTimezone'),
  clientScheduleLocation: document.getElementById('clientScheduleLocation'),
  clientScheduleMessage: document.getElementById('clientScheduleMessage'),
  clientSendScheduleButton: document.getElementById('clientSendScheduleBtn'),
  clientCopyScheduleButton: document.getElementById('clientCopyScheduleBtn'),
  clientPublishedSelect: document.getElementById('clientPublishedSelect'),
  clientPublishedStatus: document.getElementById('clientPublishedStatus'),
  clientPublishedExpires: document.getElementById('clientPublishedExpires'),
  clientPublishedEmailSent: document.getElementById('clientPublishedEmailSent'),
  clientPublishedPin: document.getElementById('clientPublishedPin'),
  clientPublishedEmailInput: document.getElementById('clientPublishedEmailInput'),
  clientPublishedExpirySelect: document.getElementById('clientPublishedExpirySelect'),
  clientPublishedClientLink: document.getElementById('clientPublishedClientLink'),
  clientPublishedAdvisorLink: document.getElementById('clientPublishedAdvisorLink'),
  clientCopyClientLinkButton: document.getElementById('clientCopyClientLinkBtn'),
  clientCopyAdvisorLinkButton: document.getElementById('clientCopyAdvisorLinkBtn'),
  clientSendFinalEmailButton: document.getElementById('clientSendFinalEmailBtn'),
  clientUpdateExpiryButton: document.getElementById('clientUpdateExpiryBtn'),
  clientResetAccessButton: document.getElementById('clientResetAccessBtn'),
  clientRevokeAccessButton: document.getElementById('clientRevokeAccessBtn'),
  clientTimeline: document.getElementById('clientTimeline'),
  advisorAuthLayer: document.getElementById('advisorAuthLayer'),
  advisorAuthPasswordInput: document.getElementById('advisorAuthPasswordInput'),
  advisorAuthLoginButton: document.getElementById('advisorAuthLoginBtn'),
  advisorAuthError: document.getElementById('advisorAuthError'),
  advisorAuthStatus: document.getElementById('advisorAuthStatus'),
  advisorLogoutButton: document.getElementById('advisorLogoutBtn')
};

const params = new URLSearchParams(window.location.search);
const state = {
  clients: [],
  selectedId: params.get('client')?.trim() || '',
  selectedClient: null,
  selectedLeadId: params.get('lead')?.trim() || '',
  selectedPublishedId: params.get('pub')?.trim() || '',
  selectedPublishedSession: null,
  stages: PIPELINE_STAGES.map((value) => ({ value, label: STAGE_LABELS[value] })),
  stageFilter: params.get('stage')?.trim() || 'all',
  // Where the client came from. Three routes create client records and they are
  // not the same relationship: someone who registered and sat through a session
  // with Gerry, a session published straight from the app, and someone who
  // completed an online self-service call and has never spoken to anyone.
  sourceFilter: params.get('source')?.trim() || 'all',
  sources: [],
  listRequestId: 0,
  detailRequestId: 0,
  publishedRequestId: 0,
  searchTimer: 0,
  actionBusy: false,
  lastGeneratedMessage: ''
};

const advisorAuthState = {
  enabled: false,
  authenticated: false,
  csrfToken: '',
  expiresAt: null
};

let advisorAuthWaiters = [];

function showToast(message, type = 'success') {
  if (!ui.toastHost) {
    return;
  }

  const toast = document.createElement('div');
  toast.className = `toast${type === 'error' ? ' error' : ''}`;
  toast.textContent = String(message || '');
  ui.toastHost.appendChild(toast);
  window.setTimeout(() => toast.remove(), 2600);
}

function setAdvisorAuthVisible(visible) {
  ui.advisorAuthLayer?.classList.toggle('is-hidden', !visible);
  ui.advisorAuthLayer?.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function setAdvisorAuthError(message) {
  if (ui.advisorAuthError) {
    ui.advisorAuthError.textContent = String(message || '');
  }
}

function setAdvisorAuthLoading(isLoading, label = 'Sign In') {
  if (ui.advisorAuthLoginButton) {
    ui.advisorAuthLoginButton.disabled = isLoading;
    ui.advisorAuthLoginButton.textContent = isLoading ? label : 'Sign In';
  }
}

function updateAdvisorAuthChrome() {
  if (ui.advisorAuthStatus) {
    if (!advisorAuthState.enabled) {
      ui.advisorAuthStatus.textContent = 'Advisor auth disabled';
    } else if (advisorAuthState.authenticated) {
      ui.advisorAuthStatus.textContent = 'Advisor signed in';
    } else {
      ui.advisorAuthStatus.textContent = 'Advisor sign-in required';
    }
  }

  ui.advisorLogoutButton?.classList.toggle('is-hidden', !(advisorAuthState.enabled && advisorAuthState.authenticated));
  document.body.classList.toggle('is-auth-locked', advisorAuthState.enabled && !advisorAuthState.authenticated);
}

function buildAdvisorRequestInit(init = {}, options = {}) {
  const headers = new Headers(init.headers || {});
  if (options.includeCsrf && advisorAuthState.csrfToken) {
    headers.set('X-Advisor-CSRF', advisorAuthState.csrfToken);
  }

  return {
    ...init,
    headers,
    credentials: 'include'
  };
}

async function fetchAdvisorAuthSession() {
  if (!WORKER_BASE_URL) {
    throw new Error('Worker URL is not configured for this environment.');
  }

  const response = await fetch(`${WORKER_BASE_URL}/api/auth/session`, buildAdvisorRequestInit({
    method: 'GET',
    cache: 'no-store'
  }));
  if (!response.ok) {
    throw new Error(`Unable to check advisor session (${response.status}).`);
  }

  return response.json();
}

async function syncAdvisorAuthState() {
  const payload = await fetchAdvisorAuthSession();
  advisorAuthState.enabled = payload?.authEnabled === true;
  advisorAuthState.authenticated = payload?.authenticated === true;
  advisorAuthState.csrfToken = advisorAuthState.authenticated ? String(payload?.csrfToken || '') : '';
  advisorAuthState.expiresAt = advisorAuthState.authenticated ? String(payload?.expiresAt || '') : null;
  updateAdvisorAuthChrome();
  return advisorAuthState;
}

function resolveAdvisorAuthWaiters() {
  const waiters = advisorAuthWaiters;
  advisorAuthWaiters = [];
  waiters.forEach((resolve) => resolve());
}

function redirectToAdvisorWorkspace() {
  window.location.replace(new URL('./index.html', window.location.href).toString());
}

async function ensureAdvisorAuthenticated(message = 'Sign in to manage the client pipeline.') {
  await syncAdvisorAuthState();

  if (!advisorAuthState.enabled || advisorAuthState.authenticated) {
    return;
  }

  redirectToAdvisorWorkspace();
  throw new Error(message);
}

async function fetchWithAdvisorAuth(input, init = {}, options = {}) {
  const { includeCsrf = false, authPrompt = 'Sign in to continue.' } = options;
  await ensureAdvisorAuthenticated(authPrompt);

  const response = await fetch(input, buildAdvisorRequestInit(init, { includeCsrf }));
  if ((response.status === 401 || response.status === 403) && advisorAuthState.enabled) {
    advisorAuthState.authenticated = false;
    advisorAuthState.csrfToken = '';
    updateAdvisorAuthChrome();
    redirectToAdvisorWorkspace();
    throw new Error(authPrompt || 'Advisor login required.');
  }

  return response;
}

function setListStatus(message) {
  if (ui.clientListStatus) {
    ui.clientListStatus.textContent = String(message || '');
  }
}

function setActionError(message) {
  if (!ui.clientActionError) {
    return;
  }

  ui.clientActionError.textContent = String(message || '');
  ui.clientActionError.classList.toggle('is-visible', Boolean(message));
}

function formatDateTime(value, fallback = 'Not set') {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(parsed);
}

function formatStage(stage) {
  return STAGE_LABELS[stage] || STAGE_LABELS.new_lead;
}

function formatPublishedStatus(status) {
  if (status === 'revoked') {
    return 'Revoked';
  }
  if (status === 'expired') {
    return 'Expired';
  }
  return 'Active';
}

function formatClientPinState(session) {
  if (session?.version >= 4) {
    return session.clientPinState === 'active' ? 'Created by client' : 'Pending first open';
  }

  if (session?.version >= 3 && session.pinRequired === false) {
    return 'Direct read-only link';
  }

  return 'Legacy link';
}

function inferExpiryDays(expiresAt) {
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    return 30;
  }

  const diffDays = Math.max(1, Math.round((parsed.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  if (diffDays <= 10) {
    return 7;
  }
  if (diffDays >= 60) {
    return 90;
  }
  return 30;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dateInputValueFromIso(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
}

function timeInputValueFromIso(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return `${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`;
}

function inferDurationMinutes(lead) {
  const start = new Date(lead?.scheduledStartAt || '');
  const end = new Date(lead?.scheduledEndAt || '');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return DEFAULT_DURATION_MINUTES;
  }

  const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  return minutes === 30 ? minutes : DEFAULT_DURATION_MINUTES;
}

function getLinkHashParam(link, key) {
  if (typeof link !== 'string' || !link) {
    return '';
  }

  try {
    const parsed = new URL(link);
    const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
    return new URLSearchParams(hash).get(key)?.trim() || '';
  } catch (_error) {
    return '';
  }
}

function buildClientSessionLink(publishedId, clientSecretB64u) {
  const url = new URL('./session.html', window.location.href);
  url.searchParams.set('pub', publishedId);
  url.searchParams.set('view', 'overview');
  url.hash = new URLSearchParams({ ck: clientSecretB64u }).toString();
  return url.toString();
}

function buildAdvisorSessionLink(publishedId, advisorSecretB64u) {
  const url = new URL('./index.html', window.location.href);
  url.searchParams.set('pub', publishedId);
  url.searchParams.set('view', 'overview');
  url.hash = new URLSearchParams({ ak: advisorSecretB64u }).toString();
  return url.toString();
}

async function copyToClipboard(value) {
  const text = String(value ?? '');
  if (!text) {
    return false;
  }

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

function getSelectedLead() {
  const leads = Array.isArray(state.selectedClient?.leads) ? state.selectedClient.leads : [];
  return leads.find((lead) => String(lead.id) === String(state.selectedLeadId)) || leads[0] || null;
}

function getSelectedPublishedSummary() {
  const sessions = Array.isArray(state.selectedClient?.publishedSessions) ? state.selectedClient.publishedSessions : [];
  return sessions.find((session) => session.publishedId === state.selectedPublishedId) || sessions[0] || null;
}

function getSelectedPublishedSession() {
  const summary = getSelectedPublishedSummary();
  if (!summary) {
    return null;
  }

  if (state.selectedPublishedSession?.publishedId === summary.publishedId) {
    return {
      ...summary,
      ...state.selectedPublishedSession
    };
  }

  return summary;
}

function formatScheduleRange(lead = getSelectedLead()) {
  if (!lead?.scheduledStartAt || !lead?.scheduledEndAt) {
    return 'Choose a date and time';
  }

  const start = new Date(lead.scheduledStartAt);
  const end = new Date(lead.scheduledEndAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 'Choose a date and time';
  }

  const dateText = new Intl.DateTimeFormat('en-IE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: DEFAULT_TIMEZONE
  }).format(start);
  const timeFormatter = new Intl.DateTimeFormat('en-IE', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: DEFAULT_TIMEZONE
  });

  return `${dateText}, ${timeFormatter.format(start)}-${timeFormatter.format(end)} (${DEFAULT_TIMEZONE})`;
}

function getSelectedScheduleValues(options = {}) {
  const { requireSchedule = false } = options;
  const date = String(ui.clientScheduleDate?.value || '').trim();
  const time = String(ui.clientScheduleTime?.value || '').trim();
  const durationMinutes = Number(ui.clientScheduleDuration?.value || DEFAULT_DURATION_MINUTES);

  if (requireSchedule && (!date || !time)) {
    throw new Error('Choose a date and start time first.');
  }

  let scheduledStartAt = '';
  let scheduledEndAt = '';
  if (date && time) {
    const start = new Date(`${date}T${time}:00`);
    if (Number.isNaN(start.getTime())) {
      throw new Error('Choose a valid call date and start time.');
    }
    const end = new Date(start.getTime() + (Number.isFinite(durationMinutes) ? durationMinutes : DEFAULT_DURATION_MINUTES) * 60000);
    scheduledStartAt = start.toISOString();
    scheduledEndAt = end.toISOString();
  }

  return {
    scheduledStartAt,
    scheduledEndAt,
    scheduledTimezone: DEFAULT_TIMEZONE,
    scheduledLocation: String(ui.clientScheduleLocation?.value || '').trim(),
    scheduledMessage: String(ui.clientScheduleMessage?.value || '').trim()
  };
}

function buildDefaultScheduleMessage(lead = getSelectedLead()) {
  const firstName = String(state.selectedClient?.fullName || lead?.fullName || '').trim().split(/\s+/)[0] || 'there';
  const draftLead = {
    ...(lead || {}),
    ...getSelectedScheduleValues()
  };
  return [
    `Hi ${firstName},`,
    '',
    'Thanks again for your Planeir request.',
    '',
    'I can offer the following time for the free education call:',
    '',
    formatScheduleRange(draftLead),
    '',
    'The calendar invite is attached and includes the Zoom link. Please use the accept link in this email within 48 hours so I know the slot is confirmed. If it is not accepted within 48 hours, the Zoom meeting will be deleted automatically. If it does not suit, use the other link and I will suggest another option.',
    '',
    'Planeir uses real scenarios for education and explanation only. It does not sell products or provide regulated financial advice, tax advice, legal advice, or product recommendations.',
    '',
    'Best,',
    'Gerry',
    'Planeir'
  ].join('\n');
}

function syncDefaultScheduleMessage(options = {}) {
  const { force = false } = options;
  if (!ui.clientScheduleMessage) {
    return;
  }

  const current = String(ui.clientScheduleMessage.value || '');
  if (!force && current && current !== state.lastGeneratedMessage) {
    return;
  }

  state.lastGeneratedMessage = buildDefaultScheduleMessage();
  ui.clientScheduleMessage.value = state.lastGeneratedMessage;
}

function buildLeadPayload(options = {}) {
  const lead = getSelectedLead();
  return {
    status: String(lead?.status || 'reviewing'),
    advisorNotes: String(state.selectedClient?.advisorNotes || '').trim(),
    availabilityNotes: String(ui.clientLeadAvailabilityNotes?.value || '').trim(),
    ...getSelectedScheduleValues(options)
  };
}

function getSelectedFinalEmail() {
  const email = String(ui.clientPublishedEmailInput?.value || state.selectedClient?.email || '').trim().toLowerCase();
  if (!email) {
    throw new Error('Enter the final email recipient first.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid final email recipient.');
  }
  return email;
}

function getSelectedExpiryDays() {
  const value = Number(ui.clientPublishedExpirySelect?.value || 30);
  return [7, 30, 90].includes(value) ? value : 30;
}

/**
 * Which kind of client the list is showing.
 *
 * Kept as its own row rather than folded into the stage tabs: source and stage
 * are independent questions -- "how did I meet them" and "where are they up
 * to" -- and combining them would multiply into a tab row nobody can scan.
 */
function renderSourceTabs() {
  if (!ui.clientSourceTabs) {
    return;
  }

  ui.clientSourceTabs.innerHTML = '';
  const tabs = [{ value: 'all', label: 'All sources' }, ...state.sources];
  tabs.forEach((source) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `client-stage-tab${state.sourceFilter === source.value ? ' is-active' : ''}`;
    button.textContent = source.label;
    button.addEventListener('click', async () => {
      state.sourceFilter = source.value;
      const url = new URL(window.location.href);
      if (source.value === 'all') {
        url.searchParams.delete('source');
      } else {
        url.searchParams.set('source', source.value);
      }
      window.history.replaceState({}, '', url);
      renderSourceTabs();
      await loadClientList({ preserveSelection: false, autoSelect: true });
    });
    ui.clientSourceTabs.appendChild(button);
  });
}

function renderStageTabs() {
  if (!ui.clientStageTabs) {
    return;
  }

  ui.clientStageTabs.innerHTML = '';
  const tabs = [{ value: 'all', label: 'All' }, ...state.stages];
  tabs.forEach((stage) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `client-stage-tab${state.stageFilter === stage.value ? ' is-active' : ''}`;
    button.textContent = stage.label;
    button.addEventListener('click', async () => {
      state.stageFilter = stage.value;
      const url = new URL(window.location.href);
      if (stage.value === 'all') {
        url.searchParams.delete('stage');
      } else {
        url.searchParams.set('stage', stage.value);
      }
      window.history.replaceState({}, '', url);
      renderStageTabs();
      await loadClientList({ preserveSelection: false, autoSelect: true });
    });
    ui.clientStageTabs.appendChild(button);
  });
}

function renderStageOptions() {
  if (!ui.clientStageSelect) {
    return;
  }

  ui.clientStageSelect.innerHTML = '';
  state.stages.forEach((stage) => {
    const option = document.createElement('option');
    option.value = stage.value;
    option.textContent = stage.label;
    ui.clientStageSelect.appendChild(option);
  });
}

function renderClientList() {
  if (!ui.clientList) {
    return;
  }

  ui.clientList.innerHTML = '';
  if (state.clients.length === 0) {
    setListStatus('No clients matched this filter.');
    return;
  }

  setListStatus(`Showing ${state.clients.length} client${state.clients.length === 1 ? '' : 's'}.`);
  state.clients.forEach((client) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `access-session-card${String(client.id) === String(state.selectedId) ? ' is-selected' : ''}`;

    const top = document.createElement('div');
    top.className = 'access-session-card-top';
    const heading = document.createElement('div');
    heading.className = 'access-session-card-heading';
    const name = document.createElement('p');
    name.className = 'access-session-card-name';
    name.textContent = client.fullName || 'Unnamed client';
    const email = document.createElement('p');
    email.className = 'access-session-card-email';
    email.textContent = client.email || 'No email stored';
    heading.append(name, email);
    const badge = document.createElement('span');
    badge.className = `access-status-badge is-${String(client.pipelineStage || 'new_lead').replace(/_/g, '-')}`;
    badge.textContent = client.pipelineStageLabel || formatStage(client.pipelineStage);
    top.append(heading, badge);

    const meta = document.createElement('div');
    meta.className = 'access-session-card-meta';
    const id = document.createElement('span');
    id.className = 'access-session-card-id';
    id.textContent = `Client #${client.id}`;
    const summary = document.createElement('span');
    summary.className = 'access-session-card-summary';
    summary.textContent = `${client.leadCount || 0} lead${client.leadCount === 1 ? '' : 's'} | ${client.publishedSessionCount || 0} published | updated ${formatDateTime(client.stageUpdatedAt || client.updatedAt, 'recently')}`;
    meta.append(id, summary);

    button.append(top, meta);
    button.addEventListener('click', async () => {
      await loadSelectedClient(String(client.id), { updateUrl: true });
    });
    ui.clientList.appendChild(button);
  });
}

function populateLeadSelect() {
  const leads = Array.isArray(state.selectedClient?.leads) ? state.selectedClient.leads : [];
  if (!ui.clientLeadSelect) {
    return;
  }

  ui.clientLeadSelect.innerHTML = '';
  if (leads.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No lead request';
    ui.clientLeadSelect.appendChild(option);
    return;
  }

  leads.forEach((lead) => {
    const option = document.createElement('option');
    option.value = String(lead.id);
    option.textContent = `Lead #${lead.id} - ${formatDateTime(lead.createdAt, 'unknown')}`;
    ui.clientLeadSelect.appendChild(option);
  });

  const selected = getSelectedLead();
  ui.clientLeadSelect.value = selected ? String(selected.id) : '';
}

function populatePublishedSelect() {
  const sessions = Array.isArray(state.selectedClient?.publishedSessions) ? state.selectedClient.publishedSessions : [];
  if (!ui.clientPublishedSelect) {
    return;
  }

  ui.clientPublishedSelect.innerHTML = '';
  if (sessions.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No published session';
    ui.clientPublishedSelect.appendChild(option);
    return;
  }

  sessions.forEach((session) => {
    const option = document.createElement('option');
    option.value = session.publishedId;
    option.textContent = `${formatPublishedStatus(session.status)} - ${formatDateTime(session.createdAt, 'unknown')}`;
    ui.clientPublishedSelect.appendChild(option);
  });

  const selected = getSelectedPublishedSummary();
  ui.clientPublishedSelect.value = selected?.publishedId || '';
}

function renderLeadWorkflow() {
  const lead = getSelectedLead();
  populateLeadSelect();

  if (ui.clientLeadReason) {
    ui.clientLeadReason.value = lead?.reason || '';
  }
  if (ui.clientLeadAvailabilityNotes) {
    ui.clientLeadAvailabilityNotes.value = lead?.availabilityNotes || '';
  }
  if (ui.clientScheduleDate) {
    ui.clientScheduleDate.value = dateInputValueFromIso(lead?.scheduledStartAt);
  }
  if (ui.clientScheduleTime) {
    ui.clientScheduleTime.value = timeInputValueFromIso(lead?.scheduledStartAt);
  }
  if (ui.clientScheduleDuration) {
    ui.clientScheduleDuration.value = String(inferDurationMinutes(lead));
  }
  if (ui.clientScheduleTimezone) {
    ui.clientScheduleTimezone.value = lead?.scheduledTimezone || DEFAULT_TIMEZONE;
  }
  if (ui.clientScheduleLocation) {
    ui.clientScheduleLocation.value = lead?.zoomJoinUrl || lead?.scheduledLocation || DEFAULT_LOCATION;
  }
  if (ui.clientScheduleMessage) {
    state.lastGeneratedMessage = buildDefaultScheduleMessage(lead);
    ui.clientScheduleMessage.value = lead?.scheduledMessage || state.lastGeneratedMessage;
  }
}

function renderPublishedWorkflow() {
  const session = getSelectedPublishedSession();
  populatePublishedSelect();

  if (ui.clientPublishedStatus) {
    ui.clientPublishedStatus.textContent = session ? formatPublishedStatus(session.status) : 'No session';
  }
  if (ui.clientPublishedExpires) {
    ui.clientPublishedExpires.textContent = session ? formatDateTime(session.expiresAt) : 'Not set';
  }
  if (ui.clientPublishedEmailSent) {
    ui.clientPublishedEmailSent.textContent = session?.lastEmailSentAt ? formatDateTime(session.lastEmailSentAt) : 'Not sent';
  }
  if (ui.clientPublishedPin) {
    ui.clientPublishedPin.textContent = session ? formatClientPinState(session) : 'Not set';
  }
  if (ui.clientPublishedEmailInput) {
    ui.clientPublishedEmailInput.value = session?.clientEmail || state.selectedClient?.email || '';
  }
  if (ui.clientPublishedExpirySelect) {
    ui.clientPublishedExpirySelect.value = String(inferExpiryDays(session?.expiresAt));
  }
  if (ui.clientPublishedClientLink) {
    ui.clientPublishedClientLink.value = session?.clientLink || '';
  }
  if (ui.clientPublishedAdvisorLink) {
    ui.clientPublishedAdvisorLink.value = session?.advisorLink || '';
  }
}

function renderTimeline() {
  if (!ui.clientTimeline) {
    return;
  }

  ui.clientTimeline.innerHTML = '';
  const events = Array.isArray(state.selectedClient?.timeline) ? state.selectedClient.timeline : [];
  if (events.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'access-manager-status';
    empty.textContent = 'No timeline events yet.';
    ui.clientTimeline.appendChild(empty);
    return;
  }

  events.forEach((event) => {
    const item = document.createElement('div');
    item.className = 'lead-event-item';
    const title = document.createElement('strong');
    title.textContent = `${String(event.eventType || '').replace(/-/g, ' ')} ${event.sourceType === 'published_session' ? 'published session' : 'lead'}`;
    const meta = document.createElement('span');
    meta.textContent = `${formatDateTime(event.createdAt)} by ${event.actorType || 'system'}`;
    item.append(title, meta);
    ui.clientTimeline.appendChild(item);
  });
}

function updateActionState() {
  const busy = state.actionBusy;
  const hasClient = Boolean(state.selectedClient);
  const lead = getSelectedLead();
  const session = getSelectedPublishedSession();
  const recoveryReady = Boolean(session?.clientLink && session?.advisorLink);
  const hasEmail = Boolean(String(ui.clientPublishedEmailInput?.value || '').trim());

  if (ui.clientSaveButton) {
    ui.clientSaveButton.disabled = busy || !hasClient;
  }
  if (ui.clientStartSessionButton) {
    ui.clientStartSessionButton.disabled = busy || !hasClient;
  }
  if (ui.clientSendScheduleButton) {
    ui.clientSendScheduleButton.disabled = busy || !lead;
    ui.clientSendScheduleButton.textContent = lead?.scheduleEmailSendCount > 0 ? 'Create Zoom + Resend' : 'Create Zoom + Send';
  }
  if (ui.clientCopyScheduleButton) {
    ui.clientCopyScheduleButton.disabled = busy || !lead;
  }
  if (ui.clientCopyClientLinkButton) {
    ui.clientCopyClientLinkButton.disabled = busy || !recoveryReady || !session?.clientLink;
  }
  if (ui.clientCopyAdvisorLinkButton) {
    ui.clientCopyAdvisorLinkButton.disabled = busy || !recoveryReady || !session?.advisorLink;
  }
  if (ui.clientSendFinalEmailButton) {
    ui.clientSendFinalEmailButton.disabled = busy || !recoveryReady || session?.status !== 'active' || !hasEmail;
    ui.clientSendFinalEmailButton.textContent = session?.emailSendCount > 0 ? 'Resend Final Email' : 'Send Final Email';
  }
  if (ui.clientUpdateExpiryButton) {
    ui.clientUpdateExpiryButton.disabled = busy || !recoveryReady || session?.status === 'revoked';
  }
  if (ui.clientResetAccessButton) {
    ui.clientResetAccessButton.disabled = busy || !recoveryReady || session?.status !== 'active' || Number(session?.version || 0) < 4;
  }
  if (ui.clientRevokeAccessButton) {
    ui.clientRevokeAccessButton.disabled = busy || !recoveryReady || session?.status !== 'active';
  }
}

function renderSelectedClient() {
  const client = state.selectedClient;
  if (!client) {
    ui.clientEmptyState?.classList.remove('is-hidden');
    ui.clientDetailCard?.classList.add('is-hidden');
    updateActionState();
    return;
  }

  ui.clientEmptyState?.classList.add('is-hidden');
  ui.clientDetailCard?.classList.remove('is-hidden');

  if (ui.clientNameTitle) {
    ui.clientNameTitle.textContent = client.fullName || 'Unnamed client';
  }
  if (ui.clientEmailTitle) {
    ui.clientEmailTitle.textContent = client.email ? `${client.email} | Client #${client.id}` : `Client #${client.id}`;
  }
  if (ui.clientStageBadge) {
    ui.clientStageBadge.textContent = client.pipelineStageLabel || formatStage(client.pipelineStage);
    ui.clientStageBadge.className = `access-status-badge is-${String(client.pipelineStage || 'new_lead').replace(/_/g, '-')}`;
  }
  if (ui.clientStageUpdatedAt) {
    ui.clientStageUpdatedAt.textContent = formatDateTime(client.stageUpdatedAt);
  }
  if (ui.clientLastScheduleEmail) {
    ui.clientLastScheduleEmail.textContent = client.lastScheduleEmailSentAt ? formatDateTime(client.lastScheduleEmailSentAt) : 'Not sent';
  }
  if (ui.clientLastFinalEmail) {
    ui.clientLastFinalEmail.textContent = client.lastPublishedEmailSentAt ? formatDateTime(client.lastPublishedEmailSentAt) : 'Not sent';
  }
  if (ui.clientLastOpened) {
    ui.clientLastOpened.textContent = client.lastClientOpenedAt ? formatDateTime(client.lastClientOpenedAt) : 'Not opened';
  }
  if (ui.clientFullNameInput) {
    ui.clientFullNameInput.value = client.fullName || '';
  }
  if (ui.clientEmailInput) {
    ui.clientEmailInput.value = client.email || '';
  }
  if (ui.clientPhoneInput) {
    ui.clientPhoneInput.value = client.phone || '';
  }
  if (ui.clientStageSelect) {
    ui.clientStageSelect.value = client.pipelineStage || 'new_lead';
  }
  if (ui.clientAdvisorNotes) {
    ui.clientAdvisorNotes.value = client.advisorNotes || '';
  }

  renderLeadWorkflow();
  renderPublishedWorkflow();
  renderTimeline();
  updateActionState();
}

async function fetchClients(query = '', stage = 'all', source = 'all') {
  const url = new URL(`${WORKER_BASE_URL}/api/advisor/clients`);
  if (query) {
    url.searchParams.set('q', query);
  }
  if (stage && stage !== 'all') {
    url.searchParams.set('stage', stage);
  }
  if (source && source !== 'all') {
    url.searchParams.set('source', source);
  }

  const response = await fetchWithAdvisorAuth(url.toString(), {
    method: 'GET',
    cache: 'no-store'
  }, {
    authPrompt: 'Sign in to view clients.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Could not load clients (${response.status}).`);
  }

  return response.json();
}

async function fetchClientDetail(clientId) {
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/advisor/clients/${encodeURIComponent(clientId)}`, {
    method: 'GET',
    cache: 'no-store'
  }, {
    authPrompt: 'Sign in to manage this client.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Could not load this client (${response.status}).`);
  }

  return response.json();
}

async function patchClient(clientId, payload) {
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/advisor/clients/${encodeURIComponent(clientId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  }, {
    includeCsrf: true,
    authPrompt: 'Sign in to update this client.'
  });

  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error || `Could not save client (${response.status}).`);
  }

  return response.json();
}

async function fetchPublishedSessionDetail(publishedId) {
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/advisor/published-sessions/${encodeURIComponent(publishedId)}`, {
    method: 'GET',
    cache: 'no-store'
  }, {
    authPrompt: 'Sign in to manage this published session.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Could not load this published session (${response.status}).`);
  }

  return response.json();
}

async function loadSelectedPublishedSession(publishedId) {
  const requestId = ++state.publishedRequestId;
  state.selectedPublishedId = publishedId || '';
  state.selectedPublishedSession = null;
  renderPublishedWorkflow();
  updateActionState();

  if (!publishedId) {
    return;
  }

  try {
    const payload = await fetchPublishedSessionDetail(publishedId);
    if (requestId !== state.publishedRequestId) {
      return;
    }

    const session = payload?.session || null;
    if (session?.clientSecretB64u && session?.advisorSecretB64u) {
      session.clientLink = buildClientSessionLink(publishedId, session.clientSecretB64u);
      session.advisorLink = buildAdvisorSessionLink(publishedId, session.advisorSecretB64u);
    }
    state.selectedPublishedSession = session;
    renderPublishedWorkflow();
    updateActionState();
  } catch (error) {
    if (requestId !== state.publishedRequestId) {
      return;
    }
    setActionError(error?.message || 'Could not recover this published session.');
    showToast(error?.message || 'Could not recover this published session.', 'error');
  }
}

function mergeSelectedIntoList(client) {
  if (!client) {
    return;
  }

  state.clients = state.clients.map((entry) => (
    String(entry.id) === String(client.id)
      ? { ...entry, ...client }
      : entry
  ));
}

function setSelectedIdInUrl(clientId) {
  const url = new URL(window.location.href);
  if (clientId) {
    url.searchParams.set('client', clientId);
  } else {
    url.searchParams.delete('client');
  }
  if (state.selectedLeadId) {
    url.searchParams.set('lead', state.selectedLeadId);
  } else {
    url.searchParams.delete('lead');
  }
  if (state.selectedPublishedId) {
    url.searchParams.set('pub', state.selectedPublishedId);
  } else {
    url.searchParams.delete('pub');
  }
  window.history.replaceState({}, '', url);
}

async function loadClientList(options = {}) {
  const { preserveSelection = true, autoSelect = true } = options;
  const requestId = ++state.listRequestId;
  const query = String(ui.clientSearchInput?.value || '').trim();
  setListStatus('Loading clients.');

  try {
    const payload = await fetchClients(query, state.stageFilter, state.sourceFilter);
    if (requestId !== state.listRequestId) {
      return;
    }

    state.stages = Array.isArray(payload?.stages) ? payload.stages : state.stages;
    state.sources = Array.isArray(payload?.sources) ? payload.sources : state.sources;
    state.clients = Array.isArray(payload?.clients) ? payload.clients : [];
    renderStageOptions();
    renderStageTabs();
    renderSourceTabs();
    renderClientList();

    const preferredId = preserveSelection && state.selectedId && state.clients.some((entry) => String(entry.id) === String(state.selectedId))
      ? state.selectedId
      : (state.clients[0] ? String(state.clients[0].id) : '');

    if (preferredId && autoSelect) {
      await loadSelectedClient(preferredId, { updateUrl: true });
      return;
    }

    if (!preferredId) {
      state.selectedId = '';
      state.selectedClient = null;
      state.selectedPublishedSession = null;
      setSelectedIdInUrl('');
      renderSelectedClient();
    }
  } catch (error) {
    setListStatus(error?.message || 'Could not load clients.');
    showToast(error?.message || 'Could not load clients.', 'error');
  }
}

async function loadSelectedClient(clientId, options = {}) {
  const { updateUrl = true } = options;
  state.selectedId = String(clientId);
  renderClientList();
  renderSelectedClient();
  setActionError('');

  const requestId = ++state.detailRequestId;
  try {
    const payload = await fetchClientDetail(clientId);
    if (requestId !== state.detailRequestId) {
      return;
    }

    state.selectedClient = payload?.client || null;
    const leads = Array.isArray(state.selectedClient?.leads) ? state.selectedClient.leads : [];
    const sessions = Array.isArray(state.selectedClient?.publishedSessions) ? state.selectedClient.publishedSessions : [];
    if (!leads.some((lead) => String(lead.id) === String(state.selectedLeadId))) {
      state.selectedLeadId = leads[0] ? String(leads[0].id) : '';
    }
    if (!sessions.some((session) => session.publishedId === state.selectedPublishedId)) {
      state.selectedPublishedId = sessions[0]?.publishedId || '';
    }
    state.selectedPublishedSession = null;

    if (state.selectedClient) {
      mergeSelectedIntoList(state.selectedClient);
    }
    renderClientList();
    renderSelectedClient();
    if (updateUrl) {
      setSelectedIdInUrl(clientId);
    }
    if (state.selectedPublishedId) {
      await loadSelectedPublishedSession(state.selectedPublishedId);
    }
  } catch (error) {
    if (requestId !== state.detailRequestId) {
      return;
    }
    state.selectedClient = null;
    state.selectedPublishedSession = null;
    renderSelectedClient();
    setActionError(error?.message || 'Could not load this client.');
    showToast(error?.message || 'Could not load this client.', 'error');
  }
}

async function sendScheduleEmail(leadId) {
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/advisor/leads/${encodeURIComponent(leadId)}/send-schedule-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildLeadPayload({ requireSchedule: true }))
  }, {
    includeCsrf: true,
    authPrompt: 'Sign in to send schedule emails.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Could not send schedule email (${response.status}).`);
  }

  return response.json();
}

async function fetchPublishedAdvisorBundle(publishedId, advisorSecretB64u) {
  const capability = await buildPublishedCapabilityToken(advisorSecretB64u, 'advisor');
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/advisor`, {
    method: 'GET',
    headers: {
      'X-Published-Capability': capability
    }
  }, {
    authPrompt: 'Sign in to reopen this published session.'
  });

  if (response.status === 404) {
    throw new Error('This advisor link is unavailable or incomplete.');
  }
  if (response.status === 410) {
    throw new Error('This advisor link has expired or has been revoked.');
  }
  if (!response.ok) {
    throw new Error(`Unable to reopen published session (${response.status}).`);
  }

  return response.json();
}

async function sendPublishedSessionEmail(session) {
  const publishedId = String(session?.publishedId || '').trim();
  const advisorSecretB64u = getLinkHashParam(session?.advisorLink, 'ak');
  if (!publishedId || !advisorSecretB64u) {
    throw new Error('Advisor recovery link is unavailable.');
  }

  const clientEmail = getSelectedFinalEmail();
  const capability = await buildPublishedCapabilityToken(advisorSecretB64u, 'advisor');
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/send-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Published-Capability': capability
    },
    body: JSON.stringify({
      clientEmail,
      clientName: state.selectedClient?.fullName || session.clientName || 'Client',
      clientLink: session.clientLink,
      pin: '',
      includePinInEmail: false,
      acknowledgeInlinePinRisk: false
    })
  }, {
    includeCsrf: true,
    authPrompt: 'Sign in to send the final client email.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Failed to send final email (${response.status}).`);
  }

  return response.json();
}

async function updatePublishedSessionExpiry(session) {
  const publishedId = String(session?.publishedId || '').trim();
  const advisorSecretB64u = getLinkHashParam(session?.advisorLink, 'ak');
  if (!publishedId || !advisorSecretB64u) {
    throw new Error('Advisor recovery link is unavailable.');
  }

  const capability = await buildPublishedCapabilityToken(advisorSecretB64u, 'advisor');
  const expiresInDays = getSelectedExpiryDays();
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/extend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Published-Capability': capability
    },
    body: JSON.stringify({ expiresInDays })
  }, {
    includeCsrf: true,
    authPrompt: 'Sign in to update this published session.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Failed to update expiry (${response.status}).`);
  }

  return response.json();
}

async function resetPublishedClientAccess(session) {
  const publishedId = String(session?.publishedId || '').trim();
  const advisorSecretB64u = getLinkHashParam(session?.advisorLink, 'ak');
  if (!publishedId || !advisorSecretB64u) {
    throw new Error('Advisor recovery link is unavailable.');
  }

  const currentBundle = await fetchPublishedAdvisorBundle(publishedId, advisorSecretB64u);
  const decrypted = await decryptPublishedSessionV2ForAdvisor(advisorSecretB64u, currentBundle);
  const sourceSession = importPublishedSession(decrypted.plaintext);
  const clientPlaintext = exportPublishedSession(sourceSession);
  const advisorPlaintext = exportSession(sourceSession);
  const currentRevision = Number(
    currentBundle?.meta?.clientAccessRevision
    || decrypted.clientAccessRevision
    || session.clientAccessRevision
    || 1
  );
  const rotated = await rotatePublishedClientAccessV4({
    clientSessionJson: clientPlaintext,
    advisorSessionJson: advisorPlaintext,
    advisorSecretB64u,
    currentRevision
  });
  const capability = await buildPublishedCapabilityToken(advisorSecretB64u, 'advisor');
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/client-access/reset`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Published-Capability': capability
    },
    body: JSON.stringify({
      expectedRevision: currentRevision,
      clientSecretB64u: rotated.clientSecretB64u,
      clientAuthHashB64u: rotated.clientAuthHashB64u,
      clientBundle: rotated.clientBundle,
      advisorBundle: rotated.advisorBundle
    })
  }, {
    includeCsrf: true,
    authPrompt: 'Sign in to reset this client link.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Failed to reset client access (${response.status}).`);
  }

  const payload = await response.json();
  return {
    ...session,
    status: payload?.status || 'active',
    clientLink: buildClientSessionLink(publishedId, rotated.clientSecretB64u),
    advisorLink: buildAdvisorSessionLink(publishedId, advisorSecretB64u),
    clientEmail: payload?.clientEmail || session.clientEmail || '',
    lastEmailSentAt: payload?.lastEmailSentAt || null,
    emailSendCount: Number(payload?.emailSendCount || 0),
    clientPinState: payload?.clientPinState || 'pending',
    clientAccessRevision: Number(payload?.clientAccessRevision || (currentRevision + 1)),
    recoveryAvailable: true
  };
}

async function revokePublishedSession(session) {
  const publishedId = String(session?.publishedId || '').trim();
  const advisorSecretB64u = getLinkHashParam(session?.advisorLink, 'ak');
  if (!publishedId || !advisorSecretB64u) {
    throw new Error('Advisor recovery link is unavailable.');
  }

  const capability = await buildPublishedCapabilityToken(advisorSecretB64u, 'advisor');
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Published-Capability': capability
    }
  }, {
    includeCsrf: true,
    authPrompt: 'Sign in to revoke this published session.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Failed to revoke (${response.status}).`);
  }

  return response.json();
}

async function runClientAction(action) {
  if (!state.selectedClient) {
    return;
  }

  state.actionBusy = true;
  setActionError('');
  updateActionState();
  try {
    await action(state.selectedClient);
  } catch (error) {
    setActionError(error?.message || 'That action could not be completed.');
    showToast(error?.message || 'That action could not be completed.', 'error');
  } finally {
    state.actionBusy = false;
    updateActionState();
  }
}

async function refreshSelectedClient() {
  if (state.selectedId) {
    await loadSelectedClient(state.selectedId, { updateUrl: true });
    await loadClientList({ preserveSelection: true, autoSelect: false });
  }
}

async function handleAdvisorLogin() {
  const password = String(ui.advisorAuthPasswordInput?.value || '');
  if (!password.trim()) {
    setAdvisorAuthError('Enter the advisor password.');
    return;
  }

  setAdvisorAuthLoading(true, 'Signing In...');
  setAdvisorAuthError('');

  try {
    const response = await fetch(`${WORKER_BASE_URL}/api/auth/login`, buildAdvisorRequestInit({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password })
    }));
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || `Sign-in failed (${response.status}).`);
    }

    advisorAuthState.enabled = payload?.authEnabled === true;
    advisorAuthState.authenticated = payload?.authenticated === true;
    advisorAuthState.csrfToken = String(payload?.csrfToken || '');
    advisorAuthState.expiresAt = String(payload?.expiresAt || '');
    updateAdvisorAuthChrome();
    if (ui.advisorAuthPasswordInput) {
      ui.advisorAuthPasswordInput.value = '';
    }
    setAdvisorAuthVisible(false);
    resolveAdvisorAuthWaiters();
    await loadClientList({ preserveSelection: true, autoSelect: true });
  } catch (error) {
    setAdvisorAuthError(error?.message || 'Could not sign in.');
  } finally {
    setAdvisorAuthLoading(false);
  }
}

async function handleAdvisorLogout() {
  try {
    const response = await fetch(`${WORKER_BASE_URL}/api/auth/logout`, buildAdvisorRequestInit({
      method: 'POST'
    }, {
      includeCsrf: true
    }));
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || `Sign-out failed (${response.status}).`);
    }

    advisorAuthState.authenticated = false;
    advisorAuthState.csrfToken = '';
    advisorAuthState.expiresAt = null;
    updateAdvisorAuthChrome();
    state.clients = [];
    state.selectedId = '';
    state.selectedClient = null;
    state.selectedPublishedSession = null;
    renderClientList();
    renderSelectedClient();
    window.location.replace(new URL('../', window.location.href).toString());
  } catch (error) {
    showToast(error?.message || 'Could not sign out.', 'error');
  }
}

function bindEvents() {
  ui.clientRefreshButton?.addEventListener('click', async () => {
    await loadClientList({ preserveSelection: true, autoSelect: true });
  });

  ui.clientSearchInput?.addEventListener('input', () => {
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => {
      void loadClientList({ preserveSelection: false, autoSelect: true });
    }, 220);
  });

  ui.clientLeadSelect?.addEventListener('change', () => {
    state.selectedLeadId = String(ui.clientLeadSelect.value || '');
    renderLeadWorkflow();
    setSelectedIdInUrl(state.selectedId);
    updateActionState();
  });

  ui.clientPublishedSelect?.addEventListener('change', async () => {
    await loadSelectedPublishedSession(String(ui.clientPublishedSelect.value || ''));
    setSelectedIdInUrl(state.selectedId);
  });

  [ui.clientScheduleDate, ui.clientScheduleTime, ui.clientScheduleDuration].forEach((input) => {
    input?.addEventListener('input', () => {
      syncDefaultScheduleMessage();
    });
  });

  ui.clientScheduleMessage?.addEventListener('input', () => {
    updateActionState();
  });

  ui.clientPublishedEmailInput?.addEventListener('input', () => {
    updateActionState();
  });

  ui.clientSaveButton?.addEventListener('click', async () => {
    await runClientAction(async (client) => {
      const payload = await patchClient(client.id, {
        fullName: String(ui.clientFullNameInput?.value || '').trim(),
        email: String(ui.clientEmailInput?.value || '').trim(),
        phone: String(ui.clientPhoneInput?.value || '').trim(),
        pipelineStage: String(ui.clientStageSelect?.value || client.pipelineStage || 'new_lead'),
        advisorNotes: String(ui.clientAdvisorNotes?.value || '').trim()
      });
      state.selectedClient = payload?.client || state.selectedClient;
      mergeSelectedIntoList(state.selectedClient);
      renderClientList();
      renderSelectedClient();
      showToast('Client saved.');
    });
  });

  ui.clientStartSessionButton?.addEventListener('click', async () => {
    await runClientAction(async (client) => {
      const currentRank = STAGE_RANKS[client.pipelineStage] ?? 0;
      if (currentRank < STAGE_RANKS.session_published || ['declined', 'expired'].includes(client.pipelineStage)) {
        await patchClient(client.id, {
          fullName: String(ui.clientFullNameInput?.value || client.fullName || '').trim(),
          email: String(ui.clientEmailInput?.value || client.email || '').trim(),
          phone: String(ui.clientPhoneInput?.value || client.phone || '').trim(),
          pipelineStage: 'session_in_progress',
          advisorNotes: String(ui.clientAdvisorNotes?.value || client.advisorNotes || '').trim()
        }).catch(() => null);
      }

      const lead = getSelectedLead();
      const url = new URL('./index.html', window.location.href);
      url.searchParams.set('client', String(client.id));
      url.searchParams.set('fresh', '1');
      if (lead?.id) {
        url.searchParams.set('lead', String(lead.id));
      }
      if (client.fullName) {
        url.searchParams.set('name', client.fullName);
      }
      if (client.email) {
        url.searchParams.set('email', client.email);
      }
      window.location.href = url.toString();
    });
  });

  ui.clientSendScheduleButton?.addEventListener('click', async () => {
    await runClientAction(async () => {
      const lead = getSelectedLead();
      if (!lead) {
        throw new Error('No lead request is available for scheduling.');
      }
      const payload = await sendScheduleEmail(lead.id);
      showToast(payload?.advisorCopyError ? 'Client email sent. Advisor copy failed.' : 'Schedule email sent.', payload?.advisorCopyError ? 'error' : 'success');
      await refreshSelectedClient();
    });
  });

  ui.clientCopyScheduleButton?.addEventListener('click', async () => {
    await runClientAction(async () => {
      syncDefaultScheduleMessage();
      await copyToClipboard(String(ui.clientScheduleMessage?.value || ''));
      showToast('Meeting email copied.');
    });
  });

  ui.clientCopyClientLinkButton?.addEventListener('click', async () => {
    await runClientAction(async () => {
      await copyToClipboard(getSelectedPublishedSession()?.clientLink || '');
      showToast('Client link copied.');
    });
  });

  ui.clientCopyAdvisorLinkButton?.addEventListener('click', async () => {
    await runClientAction(async () => {
      await copyToClipboard(getSelectedPublishedSession()?.advisorLink || '');
      showToast('Advisor link copied.');
    });
  });

  ui.clientSendFinalEmailButton?.addEventListener('click', async () => {
    await runClientAction(async () => {
      const session = getSelectedPublishedSession();
      if (!session) {
        throw new Error('No published session is selected.');
      }
      await sendPublishedSessionEmail(session);
      showToast('Final email sent.');
      await refreshSelectedClient();
    });
  });

  ui.clientUpdateExpiryButton?.addEventListener('click', async () => {
    await runClientAction(async () => {
      const session = getSelectedPublishedSession();
      if (!session) {
        throw new Error('No published session is selected.');
      }
      await updatePublishedSessionExpiry(session);
      showToast('Expiry updated.');
      await refreshSelectedClient();
    });
  });

  ui.clientResetAccessButton?.addEventListener('click', async () => {
    if (!window.confirm('Issue a fresh client link and reset the client PIN setup?\n\nThe current client link will stop working.')) {
      return;
    }

    await runClientAction(async () => {
      const session = getSelectedPublishedSession();
      if (!session) {
        throw new Error('No published session is selected.');
      }
      state.selectedPublishedSession = await resetPublishedClientAccess(session);
      showToast('Client access reset.');
      renderPublishedWorkflow();
      updateActionState();
    });
  });

  ui.clientRevokeAccessButton?.addEventListener('click', async () => {
    if (!window.confirm('Revoke this client link now?')) {
      return;
    }

    await runClientAction(async () => {
      const session = getSelectedPublishedSession();
      if (!session) {
        throw new Error('No published session is selected.');
      }
      await revokePublishedSession(session);
      showToast('Client access revoked.');
      await refreshSelectedClient();
    });
  });

  ui.advisorAuthLoginButton?.addEventListener('click', async () => {
    await handleAdvisorLogin();
  });

  ui.advisorAuthPasswordInput?.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      await handleAdvisorLogin();
    }
  });

  ui.advisorLogoutButton?.addEventListener('click', async () => {
    await handleAdvisorLogout();
  });
}

async function init() {
  renderStageOptions();
  renderStageTabs();
  renderSourceTabs();
  bindEvents();
  renderClientList();
  renderSelectedClient();

  try {
    await ensureAdvisorAuthenticated('Sign in to manage the client pipeline.');
    await loadClientList({ preserveSelection: true, autoSelect: true });
  } catch (error) {
    if (!advisorAuthState.enabled || advisorAuthState.authenticated) {
      showToast(error?.message || 'Could not initialize client pipeline.', 'error');
    }
  }
}

void init();
