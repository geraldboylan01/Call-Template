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

const STATUS_LABELS = {
  new: 'New',
  reviewing: 'Reviewing',
  'awaiting-client': 'Awaiting client',
  booked: 'Booked',
  declined: 'Declined',
  archived: 'Archived'
};

const ui = {
  toastHost: document.getElementById('toastHost'),
  leadSearchInput: document.getElementById('leadSearchInput'),
  leadStatusFilter: document.getElementById('leadStatusFilter'),
  leadRefreshButton: document.getElementById('leadRefreshBtn'),
  leadListStatus: document.getElementById('leadListStatus'),
  leadList: document.getElementById('leadList'),
  leadEmptyState: document.getElementById('leadEmptyState'),
  leadDetailCard: document.getElementById('leadDetailCard'),
  leadClientName: document.getElementById('leadClientName'),
  leadClientEmail: document.getElementById('leadClientEmail'),
  leadStatusBadge: document.getElementById('leadStatusBadge'),
  leadActionError: document.getElementById('leadActionError'),
  leadCreatedAt: document.getElementById('leadCreatedAt'),
  leadLastScheduleEmailSent: document.getElementById('leadLastScheduleEmailSent'),
  leadStageValue: document.getElementById('leadStageValue'),
  leadOutcomeValue: document.getElementById('leadOutcomeValue'),
  leadReasonText: document.getElementById('leadReasonText'),
  leadAvailabilityNotes: document.getElementById('leadAvailabilityNotes'),
  leadStatusSelect: document.getElementById('leadStatusSelect'),
  leadPhoneValue: document.getElementById('leadPhoneValue'),
  leadAdvisorNotes: document.getElementById('leadAdvisorNotes'),
  leadScheduleDate: document.getElementById('leadScheduleDate'),
  leadScheduleTime: document.getElementById('leadScheduleTime'),
  leadScheduleDuration: document.getElementById('leadScheduleDuration'),
  leadScheduleTimezone: document.getElementById('leadScheduleTimezone'),
  leadScheduleLocation: document.getElementById('leadScheduleLocation'),
  leadScheduleMessage: document.getElementById('leadScheduleMessage'),
  leadSaveButton: document.getElementById('leadSaveBtn'),
  leadSendScheduleButton: document.getElementById('leadSendScheduleBtn'),
  leadCopyEmailButton: document.getElementById('leadCopyEmailBtn'),
  leadEventList: document.getElementById('leadEventList'),
  advisorAuthLayer: document.getElementById('advisorAuthLayer'),
  advisorAuthHint: document.getElementById('advisorAuthHint'),
  advisorAuthPasswordInput: document.getElementById('advisorAuthPasswordInput'),
  advisorAuthLoginButton: document.getElementById('advisorAuthLoginBtn'),
  advisorAuthError: document.getElementById('advisorAuthError'),
  advisorAuthStatus: document.getElementById('advisorAuthStatus'),
  advisorLogoutButton: document.getElementById('advisorLogoutBtn')
};

const state = {
  leads: [],
  selectedId: '',
  selectedLead: null,
  listRequestId: 0,
  detailRequestId: 0,
  searchTimer: 0,
  actionBusy: false,
  lastGeneratedMessage: '',
  initialLeadId: new URLSearchParams(window.location.search).get('lead')?.trim() || ''
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
  if (!ui.advisorAuthLoginButton) {
    return;
  }

  ui.advisorAuthLoginButton.disabled = isLoading;
  ui.advisorAuthLoginButton.textContent = isLoading ? label : 'Sign In';
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

async function ensureAdvisorAuthenticated(message = 'Sign in to manage Planeir leads.') {
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
  if (ui.leadListStatus) {
    ui.leadListStatus.textContent = String(message || '');
  }
}

function setActionError(message) {
  if (!ui.leadActionError) {
    return;
  }

  ui.leadActionError.textContent = String(message || '');
  ui.leadActionError.classList.toggle('is-visible', Boolean(message));
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

function formatScheduleRange(lead = state.selectedLead) {
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

function getSelectedScheduleValues(options = {}) {
  const { requireSchedule = false } = options;
  const date = String(ui.leadScheduleDate?.value || '').trim();
  const time = String(ui.leadScheduleTime?.value || '').trim();
  const durationMinutes = Number(ui.leadScheduleDuration?.value || DEFAULT_DURATION_MINUTES);

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
    scheduledLocation: String(ui.leadScheduleLocation?.value || '').trim(),
    scheduledMessage: String(ui.leadScheduleMessage?.value || '').trim()
  };
}

function buildDefaultScheduleMessage(lead = state.selectedLead) {
  const firstName = String(lead?.fullName || '').trim().split(/\s+/)[0] || 'there';
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
    'The calendar invite is attached and includes the Zoom link. If that time works, you can add it to your calendar and reply to confirm. If it does not suit, reply with a few windows that work for you and I will suggest another option.',
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
  if (!ui.leadScheduleMessage) {
    return;
  }

  const current = String(ui.leadScheduleMessage.value || '');
  if (!force && current && current !== state.lastGeneratedMessage) {
    return;
  }

  state.lastGeneratedMessage = buildDefaultScheduleMessage();
  ui.leadScheduleMessage.value = state.lastGeneratedMessage;
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

function mergeSelectedIntoList(lead) {
  state.leads = state.leads.map((entry) => (
    Number(entry.id) === Number(lead.id)
      ? {
        ...entry,
        ...lead,
        reasonPreview: lead.reasonPreview || (lead.reason?.length > 180 ? `${lead.reason.slice(0, 177)}...` : lead.reason)
      }
      : entry
  ));
}

function setSelectedIdInUrl(leadId) {
  const url = new URL(window.location.href);
  if (leadId) {
    url.searchParams.set('lead', leadId);
  } else {
    url.searchParams.delete('lead');
  }
  window.history.replaceState({}, '', url);
}

function renderLeadList() {
  if (!ui.leadList) {
    return;
  }

  ui.leadList.innerHTML = '';
  if (state.leads.length === 0) {
    setListStatus('No leads matched this search.');
    return;
  }

  setListStatus(`Showing ${state.leads.length} lead${state.leads.length === 1 ? '' : 's'}.`);

  state.leads.forEach((lead) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `access-session-card${String(lead.id) === String(state.selectedId) ? ' is-selected' : ''}`;

    const top = document.createElement('div');
    top.className = 'access-session-card-top';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'access-session-card-heading';
    const title = document.createElement('p');
    title.className = 'access-session-card-name';
    title.textContent = lead.fullName || 'Unnamed lead';
    const email = document.createElement('p');
    email.className = 'access-session-card-email';
    email.textContent = lead.email || 'No email stored';
    titleWrap.append(title, email);

    const badge = document.createElement('span');
    badge.className = `access-status-badge is-${lead.status || 'new'}`;
    badge.textContent = lead.statusLabel || STATUS_LABELS[lead.status] || 'New';
    top.append(titleWrap, badge);

    const meta = document.createElement('div');
    meta.className = 'access-session-card-meta';
    const leadId = document.createElement('span');
    leadId.className = 'access-session-card-id';
    leadId.textContent = `Lead #${lead.id}`;
    const summary = document.createElement('span');
    summary.className = 'access-session-card-summary';
    summary.textContent = lead.lastScheduleEmailSentAt
      ? `Schedule sent ${formatDateTime(lead.lastScheduleEmailSentAt, 'recently')} | ${lead.reasonPreview || ''}`
      : `${formatDateTime(lead.createdAt, 'Unknown')} | ${lead.reasonPreview || ''}`;
    meta.append(leadId, summary);

    button.append(top, meta);
    button.addEventListener('click', async () => {
      await loadSelectedLead(String(lead.id));
    });
    ui.leadList.appendChild(button);
  });
}

function updateDetailActionState() {
  const busy = state.actionBusy;
  const hasLead = Boolean(state.selectedLead);
  if (ui.leadSaveButton) {
    ui.leadSaveButton.disabled = busy || !hasLead;
  }
  if (ui.leadSendScheduleButton) {
    ui.leadSendScheduleButton.disabled = busy || !hasLead;
    ui.leadSendScheduleButton.textContent = state.selectedLead?.scheduleEmailSendCount > 0
      ? 'Create Zoom + Resend'
      : 'Create Zoom + Send';
  }
  if (ui.leadCopyEmailButton) {
    ui.leadCopyEmailButton.disabled = busy || !hasLead;
  }
}

function renderEvents(events = []) {
  if (!ui.leadEventList) {
    return;
  }

  ui.leadEventList.innerHTML = '';
  if (events.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'access-manager-status';
    empty.textContent = 'No history yet.';
    ui.leadEventList.appendChild(empty);
    return;
  }

  events.forEach((event) => {
    const item = document.createElement('div');
    item.className = 'lead-event-item';
    const title = document.createElement('strong');
    title.textContent = String(event.eventType || '').replace(/-/g, ' ');
    const meta = document.createElement('span');
    meta.textContent = `${formatDateTime(event.createdAt)} by ${event.actorType || 'system'}`;
    item.append(title, meta);
    ui.leadEventList.appendChild(item);
  });
}

function renderSelectedLead() {
  const lead = state.selectedLead;
  if (!lead) {
    ui.leadEmptyState?.classList.remove('is-hidden');
    ui.leadDetailCard?.classList.add('is-hidden');
    updateDetailActionState();
    return;
  }

  ui.leadEmptyState?.classList.add('is-hidden');
  ui.leadDetailCard?.classList.remove('is-hidden');

  if (ui.leadClientName) {
    ui.leadClientName.textContent = lead.fullName || 'Unnamed lead';
  }
  if (ui.leadClientEmail) {
    ui.leadClientEmail.textContent = lead.email ? `${lead.email} | Lead #${lead.id}` : `Lead #${lead.id}`;
  }
  if (ui.leadStatusBadge) {
    ui.leadStatusBadge.textContent = STATUS_LABELS[lead.status] || 'New';
    ui.leadStatusBadge.className = `access-status-badge is-${lead.status || 'new'}`;
  }
  if (ui.leadCreatedAt) {
    ui.leadCreatedAt.textContent = formatDateTime(lead.createdAt);
  }
  if (ui.leadLastScheduleEmailSent) {
    ui.leadLastScheduleEmailSent.textContent = lead.lastScheduleEmailSentAt
      ? `${formatDateTime(lead.lastScheduleEmailSentAt)} (${lead.scheduleEmailSendCount || 1})`
      : 'Not sent yet';
  }
  if (ui.leadStageValue) {
    ui.leadStageValue.textContent = lead.stageLabel || 'Not provided';
  }
  if (ui.leadOutcomeValue) {
    ui.leadOutcomeValue.textContent = lead.callOutcomeLabel || 'Not provided';
  }
  if (ui.leadReasonText) {
    ui.leadReasonText.value = lead.reason || '';
  }
  if (ui.leadAvailabilityNotes) {
    ui.leadAvailabilityNotes.value = lead.availabilityNotes || '';
  }
  if (ui.leadStatusSelect) {
    ui.leadStatusSelect.value = lead.status || 'new';
  }
  if (ui.leadPhoneValue) {
    ui.leadPhoneValue.value = lead.phone || 'Not provided';
  }
  if (ui.leadAdvisorNotes) {
    ui.leadAdvisorNotes.value = lead.advisorNotes || '';
  }
  if (ui.leadScheduleDate) {
    ui.leadScheduleDate.value = dateInputValueFromIso(lead.scheduledStartAt);
  }
  if (ui.leadScheduleTime) {
    ui.leadScheduleTime.value = timeInputValueFromIso(lead.scheduledStartAt);
  }
  if (ui.leadScheduleDuration) {
    ui.leadScheduleDuration.value = String(inferDurationMinutes(lead));
  }
  if (ui.leadScheduleTimezone) {
    ui.leadScheduleTimezone.value = lead.scheduledTimezone || DEFAULT_TIMEZONE;
  }
  if (ui.leadScheduleLocation) {
    ui.leadScheduleLocation.value = lead.zoomJoinUrl || lead.scheduledLocation || DEFAULT_LOCATION;
  }
  if (ui.leadScheduleMessage) {
    state.lastGeneratedMessage = buildDefaultScheduleMessage(lead);
    ui.leadScheduleMessage.value = lead.scheduledMessage || state.lastGeneratedMessage;
  }
  renderEvents(Array.isArray(lead.events) ? lead.events : []);
  updateDetailActionState();
}

async function fetchLeads(query = '', status = 'new') {
  const url = new URL(`${WORKER_BASE_URL}/api/advisor/leads`);
  if (query) {
    url.searchParams.set('q', query);
  }
  if (status) {
    url.searchParams.set('status', status);
  }
  const response = await fetchWithAdvisorAuth(url.toString(), {
    method: 'GET',
    cache: 'no-store'
  }, {
    authPrompt: 'Sign in to view Planeir leads.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Could not load leads (${response.status}).`);
  }

  return response.json();
}

async function fetchLeadDetail(leadId) {
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/advisor/leads/${encodeURIComponent(leadId)}`, {
    method: 'GET',
    cache: 'no-store'
  }, {
    authPrompt: 'Sign in to manage this lead.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Could not load this lead (${response.status}).`);
  }

  return response.json();
}

function buildLeadPayload(options = {}) {
  return {
    status: String(ui.leadStatusSelect?.value || state.selectedLead?.status || 'new'),
    advisorNotes: String(ui.leadAdvisorNotes?.value || '').trim(),
    availabilityNotes: String(ui.leadAvailabilityNotes?.value || '').trim(),
    ...getSelectedScheduleValues(options)
  };
}

async function updateLead(leadId) {
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/advisor/leads/${encodeURIComponent(leadId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildLeadPayload())
  }, {
    includeCsrf: true,
    authPrompt: 'Sign in to update this lead.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Could not save lead (${response.status}).`);
  }

  return response.json();
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

async function loadLeadList(options = {}) {
  const { preserveSelection = true, autoSelect = true } = options;
  const requestId = ++state.listRequestId;
  const query = String(ui.leadSearchInput?.value || '').trim();
  const status = String(ui.leadStatusFilter?.value || 'new').trim();
  setListStatus('Loading leads.');

  try {
    const payload = await fetchLeads(query, status);
    if (requestId !== state.listRequestId) {
      return;
    }

    state.leads = Array.isArray(payload?.leads) ? payload.leads : [];
    renderLeadList();

    const preferredId = preserveSelection && state.selectedId && state.leads.some((entry) => String(entry.id) === String(state.selectedId))
      ? state.selectedId
      : (state.initialLeadId && state.leads.some((entry) => String(entry.id) === String(state.initialLeadId)) ? state.initialLeadId : '');

    if (preferredId) {
      state.initialLeadId = '';
      await loadSelectedLead(preferredId, { updateUrl: true });
      return;
    }

    if (state.selectedId && !state.leads.some((entry) => String(entry.id) === String(state.selectedId))) {
      state.selectedId = '';
      state.selectedLead = null;
    }

    if (!preserveSelection) {
      state.selectedId = '';
      state.selectedLead = null;
    }

    if (!state.selectedId && autoSelect && state.leads[0]) {
      await loadSelectedLead(String(state.leads[0].id), { updateUrl: true });
      return;
    }

    if (!state.selectedId) {
      setSelectedIdInUrl('');
      renderSelectedLead();
    }
  } catch (error) {
    setListStatus(error?.message || 'Could not load leads.');
    showToast(error?.message || 'Could not load leads.', 'error');
  }
}

async function loadSelectedLead(leadId, options = {}) {
  const { updateUrl = true } = options;
  state.selectedId = String(leadId);
  renderLeadList();
  renderSelectedLead();
  setActionError('');

  const requestId = ++state.detailRequestId;
  try {
    const payload = await fetchLeadDetail(leadId);
    if (requestId !== state.detailRequestId) {
      return;
    }

    state.selectedLead = payload?.lead || null;
    if (state.selectedLead) {
      mergeSelectedIntoList(state.selectedLead);
    }
    renderLeadList();
    renderSelectedLead();
    if (updateUrl) {
      setSelectedIdInUrl(leadId);
    }
  } catch (error) {
    if (requestId !== state.detailRequestId) {
      return;
    }
    state.selectedLead = null;
    renderSelectedLead();
    setActionError(error?.message || 'Could not load this lead.');
    showToast(error?.message || 'Could not load this lead.', 'error');
  }
}

async function runSelectedLeadAction(action) {
  if (!state.selectedLead) {
    return;
  }

  state.actionBusy = true;
  setActionError('');
  updateDetailActionState();
  try {
    await action(state.selectedLead);
  } catch (error) {
    setActionError(error?.message || 'That action could not be completed.');
    showToast(error?.message || 'That action could not be completed.', 'error');
  } finally {
    state.actionBusy = false;
    updateDetailActionState();
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
    await loadLeadList({ preserveSelection: true, autoSelect: true });
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
    state.leads = [];
    state.selectedId = '';
    state.selectedLead = null;
    renderLeadList();
    renderSelectedLead();
    window.location.replace(new URL('../', window.location.href).toString());
  } catch (error) {
    showToast(error?.message || 'Could not sign out.', 'error');
  }
}

function bindEvents() {
  ui.leadRefreshButton?.addEventListener('click', async () => {
    await loadLeadList({ preserveSelection: true, autoSelect: true });
  });

  ui.leadSearchInput?.addEventListener('input', () => {
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => {
      void loadLeadList({ preserveSelection: false, autoSelect: true });
    }, 220);
  });

  ui.leadStatusFilter?.addEventListener('change', async () => {
    await loadLeadList({ preserveSelection: false, autoSelect: true });
  });

  [ui.leadScheduleDate, ui.leadScheduleTime, ui.leadScheduleDuration].forEach((input) => {
    input?.addEventListener('input', () => {
      syncDefaultScheduleMessage();
    });
  });

  ui.leadScheduleMessage?.addEventListener('input', () => {
    updateDetailActionState();
  });

  ui.leadSaveButton?.addEventListener('click', async () => {
    await runSelectedLeadAction(async (lead) => {
      const payload = await updateLead(lead.id);
      state.selectedLead = payload?.lead || state.selectedLead;
      mergeSelectedIntoList(state.selectedLead);
      renderLeadList();
      renderSelectedLead();
      showToast('Lead saved.');
    });
  });

  ui.leadSendScheduleButton?.addEventListener('click', async () => {
    await runSelectedLeadAction(async (lead) => {
      const payload = await sendScheduleEmail(lead.id);
      state.selectedLead = payload?.lead || state.selectedLead;
      mergeSelectedIntoList(state.selectedLead);
      renderLeadList();
      renderSelectedLead();
      showToast(payload?.advisorCopyError ? 'Client email sent. Advisor copy failed.' : 'Schedule email sent.', payload?.advisorCopyError ? 'error' : 'success');
    });
  });

  ui.leadCopyEmailButton?.addEventListener('click', async () => {
    await runSelectedLeadAction(async () => {
      syncDefaultScheduleMessage();
      await copyToClipboard(String(ui.leadScheduleMessage?.value || ''));
      showToast('Email copy copied.');
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
  bindEvents();
  renderLeadList();
  renderSelectedLead();

  try {
    await ensureAdvisorAuthenticated('Sign in to manage Planeir leads.');
    await loadLeadList({ preserveSelection: true, autoSelect: true });
  } catch (error) {
    if (!advisorAuthState.enabled || advisorAuthState.authenticated) {
      showToast(error?.message || 'Could not initialize lead inbox.', 'error');
    }
  }
}

void init();
