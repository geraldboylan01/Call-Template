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
  const override = getMetaContent('call-canvas-worker-base-url');
  return override ? override.replace(/\/+$/, '') : '';
})();

const ui = {
  toastHost: document.getElementById('toastHost'),
  accessSearchInput: document.getElementById('accessSearchInput'),
  accessRefreshButton: document.getElementById('accessRefreshBtn'),
  accessListStatus: document.getElementById('accessListStatus'),
  accessSessionList: document.getElementById('accessSessionList'),
  accessEmptyState: document.getElementById('accessEmptyState'),
  accessDetailCard: document.getElementById('accessDetailCard'),
  accessClientName: document.getElementById('accessClientName'),
  accessPublishedId: document.getElementById('accessPublishedId'),
  accessStatusBadge: document.getElementById('accessStatusBadge'),
  accessRecoveryNotice: document.getElementById('accessRecoveryNotice'),
  accessActionError: document.getElementById('accessActionError'),
  accessExpiresAt: document.getElementById('accessExpiresAt'),
  accessLastEmailSent: document.getElementById('accessLastEmailSent'),
  accessClientPinState: document.getElementById('accessClientPinState'),
  accessCreatedAt: document.getElementById('accessCreatedAt'),
  detailClientEmailInput: document.getElementById('detailClientEmailInput'),
  detailExpirySelect: document.getElementById('detailExpirySelect'),
  detailClientLinkInput: document.getElementById('detailClientLinkInput'),
  detailAdvisorLinkInput: document.getElementById('detailAdvisorLinkInput'),
  detailCopyClientLinkButton: document.getElementById('detailCopyClientLinkBtn'),
  detailCopyAdvisorLinkButton: document.getElementById('detailCopyAdvisorLinkBtn'),
  detailSendEmailButton: document.getElementById('detailSendEmailBtn'),
  detailUpdateExpiryButton: document.getElementById('detailUpdateExpiryBtn'),
  detailResetAccessButton: document.getElementById('detailResetAccessBtn'),
  detailRevokeButton: document.getElementById('detailRevokeBtn'),
  accessQrScratch: document.getElementById('accessQrScratch'),
  advisorAuthLayer: document.getElementById('advisorAuthLayer'),
  advisorAuthHint: document.getElementById('advisorAuthHint'),
  advisorAuthPasswordInput: document.getElementById('advisorAuthPasswordInput'),
  advisorAuthLoginButton: document.getElementById('advisorAuthLoginBtn'),
  advisorAuthError: document.getElementById('advisorAuthError'),
  advisorAuthStatus: document.getElementById('advisorAuthStatus'),
  advisorLogoutButton: document.getElementById('advisorLogoutBtn')
};

const state = {
  sessions: [],
  selectedId: '',
  selectedSession: null,
  listRequestId: 0,
  detailRequestId: 0,
  searchTimer: 0,
  actionBusy: false,
  initialPubId: new URLSearchParams(window.location.search).get('pub')?.trim() || ''
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
  if (!ui.advisorAuthLayer) {
    return;
  }

  ui.advisorAuthLayer.classList.toggle('is-hidden', !visible);
  ui.advisorAuthLayer.setAttribute('aria-hidden', visible ? 'false' : 'true');
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

  if (ui.advisorLogoutButton) {
    ui.advisorLogoutButton.classList.toggle('is-hidden', !(advisorAuthState.enabled && advisorAuthState.authenticated));
  }
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
  if (advisorAuthWaiters.length === 0) {
    return;
  }

  const waiters = advisorAuthWaiters;
  advisorAuthWaiters = [];
  waiters.forEach((resolve) => resolve());
}

async function ensureAdvisorAuthenticated(message = 'Sign in to manage published client access.') {
  await syncAdvisorAuthState();

  if (!advisorAuthState.enabled || advisorAuthState.authenticated) {
    return;
  }

  if (ui.advisorAuthHint) {
    ui.advisorAuthHint.textContent = String(message || 'Sign in to continue.');
  }
  setAdvisorAuthError('');
  setAdvisorAuthVisible(true);
  ui.advisorAuthPasswordInput?.focus();

  return new Promise((resolve) => {
    advisorAuthWaiters.push(resolve);
  });
}

async function fetchWithAdvisorAuth(input, init = {}, options = {}) {
  const { includeCsrf = false, authPrompt = 'Sign in to continue.' } = options;
  await ensureAdvisorAuthenticated(authPrompt);

  let response = await fetch(input, buildAdvisorRequestInit(init, { includeCsrf }));
  if ((response.status === 401 || response.status === 403) && advisorAuthState.enabled) {
    advisorAuthState.authenticated = false;
    advisorAuthState.csrfToken = '';
    updateAdvisorAuthChrome();
    await ensureAdvisorAuthenticated(authPrompt);
    response = await fetch(input, buildAdvisorRequestInit(init, { includeCsrf }));
  }

  return response;
}

function setListStatus(message) {
  if (ui.accessListStatus) {
    ui.accessListStatus.textContent = String(message || '');
  }
}

function setActionError(message) {
  if (!ui.accessActionError) {
    return;
  }

  ui.accessActionError.textContent = String(message || '');
  ui.accessActionError.classList.toggle('is-visible', Boolean(message));
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

function formatStatusLabel(status) {
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
    return session.clientPinState === 'active'
      ? 'Created by client'
      : 'Pending first open';
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
  url.hash = new URLSearchParams({ ck: clientSecretB64u }).toString();
  return url.toString();
}

function buildAdvisorSessionLink(publishedId, advisorSecretB64u) {
  const url = new URL('./index.html', window.location.href);
  url.searchParams.set('pub', publishedId);
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

function getSelectedClientEmail() {
  const normalized = String(ui.detailClientEmailInput?.value || '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('Enter the client email address first.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Enter a valid client email address.');
  }

  return normalized;
}

function getSelectedExpiryDays() {
  const value = Number(ui.detailExpirySelect?.value || 30);
  return [7, 30, 90].includes(value) ? value : 30;
}

async function getQrImageDataUrl(link) {
  if (!ui.accessQrScratch || typeof window.QRCode !== 'function' || !link) {
    throw new Error('QR code is unavailable right now.');
  }

  ui.accessQrScratch.innerHTML = '';
  new window.QRCode(ui.accessQrScratch, {
    text: link,
    width: 148,
    height: 148,
    colorDark: '#0f2233',
    colorLight: '#ffffff'
  });

  await new Promise((resolve) => window.requestAnimationFrame(resolve));

  const image = ui.accessQrScratch.querySelector('img');
  if (image?.src?.startsWith('data:image/png;base64,')) {
    return image.src;
  }

  const canvas = ui.accessQrScratch.querySelector('canvas');
  if (canvas && typeof canvas.toDataURL === 'function') {
    return canvas.toDataURL('image/png');
  }

  throw new Error('QR code could not be generated.');
}

function mergeSelectedIntoList(session) {
  state.sessions = state.sessions.map((entry) => (
    entry.publishedId === session.publishedId
      ? {
        ...entry,
        clientName: session.clientName,
        clientEmail: session.clientEmail,
        status: session.status,
        expiresAt: session.expiresAt,
        emailSendCount: session.emailSendCount,
        lastEmailSentAt: session.lastEmailSentAt,
        clientPinState: session.clientPinState,
        clientPinInitializedAt: session.clientPinInitializedAt,
        clientAccessRevision: session.clientAccessRevision,
        recoveryAvailable: session.recoveryAvailable,
        canEmail: session.status === 'active' && session.version >= 3,
        canExtend: session.status !== 'revoked' && session.version >= 3,
        canResetClientAccess: session.status === 'active' && session.version >= 4,
        canRevoke: session.status === 'active'
      }
      : entry
  ));
}

function setSelectedIdInUrl(publishedId) {
  const url = new URL(window.location.href);
  if (publishedId) {
    url.searchParams.set('pub', publishedId);
  } else {
    url.searchParams.delete('pub');
  }
  window.history.replaceState({}, '', url);
}

function renderSessionList() {
  if (!ui.accessSessionList) {
    return;
  }

  ui.accessSessionList.innerHTML = '';
  if (state.sessions.length === 0) {
    setListStatus('No published sessions matched this search.');
    return;
  }

  setListStatus(`Showing ${state.sessions.length} published session${state.sessions.length === 1 ? '' : 's'}.`);

  state.sessions.forEach((session) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ui-button access-session-card${session.publishedId === state.selectedId ? ' is-selected' : ''}`;

    const top = document.createElement('div');
    top.className = 'access-session-card-top';

    const titleWrap = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'access-session-card-name';
    title.textContent = session.clientName || 'Unnamed client';
    const email = document.createElement('p');
    email.className = 'access-session-card-email';
    email.textContent = session.clientEmail || 'No client email stored';
    titleWrap.append(title, email);

    const badge = document.createElement('span');
    badge.className = `access-status-badge is-${session.status === 'active' ? 'active' : session.status === 'revoked' ? 'revoked' : 'expired'}`;
    badge.textContent = formatStatusLabel(session.status);
    top.append(titleWrap, badge);

    const meta = document.createElement('div');
    meta.className = 'access-session-card-meta';

    const publishedId = document.createElement('span');
    publishedId.className = 'access-session-card-detail';
    publishedId.textContent = session.publishedId;
    const expiry = document.createElement('span');
    expiry.className = 'access-session-card-detail';
    expiry.textContent = `Expires ${formatDateTime(session.expiresAt, 'Unknown')}`;
    const emailState = document.createElement('span');
    emailState.className = 'access-session-card-detail';
    emailState.textContent = session.lastEmailSentAt
      ? `Email sent ${formatDateTime(session.lastEmailSentAt, 'recently')}`
      : 'Email not sent';
    meta.append(publishedId, expiry, emailState);

    button.append(top, meta);
    button.addEventListener('click', async () => {
      await loadSelectedSession(session.publishedId);
    });
    ui.accessSessionList.appendChild(button);
  });
}

function updateDetailActionState() {
  const session = state.selectedSession;
  const recoveryReady = Boolean(session?.recoveryAvailable && session?.clientLink && session?.advisorLink);
  const hasEmail = Boolean(String(ui.detailClientEmailInput?.value || '').trim());
  const busy = state.actionBusy;
  const canEmail = session?.status === 'active' && Number(session?.version || 0) >= 3;
  const canExtend = session?.status !== 'revoked' && Number(session?.version || 0) >= 3;
  const canResetClientAccess = session?.status === 'active' && Number(session?.version || 0) >= 4;
  const canRevoke = session?.status === 'active';

  if (ui.detailCopyClientLinkButton) {
    ui.detailCopyClientLinkButton.disabled = busy || !recoveryReady || !session?.clientLink;
  }
  if (ui.detailCopyAdvisorLinkButton) {
    ui.detailCopyAdvisorLinkButton.disabled = busy || !recoveryReady || !session?.advisorLink;
  }
  if (ui.detailSendEmailButton) {
    ui.detailSendEmailButton.disabled = busy || !recoveryReady || !canEmail || !hasEmail;
    ui.detailSendEmailButton.textContent = session?.emailSendCount > 0 ? 'Resend Final Email' : 'Send Final Email';
  }
  if (ui.detailUpdateExpiryButton) {
    ui.detailUpdateExpiryButton.disabled = busy || !recoveryReady || !canExtend;
  }
  if (ui.detailResetAccessButton) {
    ui.detailResetAccessButton.disabled = busy || !recoveryReady || !canResetClientAccess;
  }
  if (ui.detailRevokeButton) {
    ui.detailRevokeButton.disabled = busy || !recoveryReady || !canRevoke;
  }
}

function renderSelectedSession() {
  const session = state.selectedSession;
  if (!session) {
    ui.accessEmptyState?.classList.remove('is-hidden');
    ui.accessDetailCard?.classList.add('is-hidden');
    updateDetailActionState();
    return;
  }

  ui.accessEmptyState?.classList.add('is-hidden');
  ui.accessDetailCard?.classList.remove('is-hidden');

  if (ui.accessClientName) {
    ui.accessClientName.textContent = session.clientName || 'Unnamed client';
  }
  if (ui.accessPublishedId) {
    ui.accessPublishedId.textContent = session.publishedId;
  }
  if (ui.accessStatusBadge) {
    ui.accessStatusBadge.textContent = formatStatusLabel(session.status);
    ui.accessStatusBadge.className = `access-status-badge is-${session.status === 'active' ? 'active' : session.status === 'revoked' ? 'revoked' : 'expired'}`;
  }
  if (ui.accessRecoveryNotice) {
    ui.accessRecoveryNotice.textContent = session.recoveryAvailable
      ? 'Recovered links are available for this session.'
      : 'Recovery data is unavailable for this session, so link-based actions cannot be performed here.';
  }
  if (ui.detailClientEmailInput) {
    ui.detailClientEmailInput.value = session.clientEmail || '';
  }
  if (ui.detailExpirySelect) {
    ui.detailExpirySelect.value = String(inferExpiryDays(session.expiresAt));
  }
  if (ui.accessExpiresAt) {
    ui.accessExpiresAt.textContent = formatDateTime(session.expiresAt);
  }
  if (ui.accessLastEmailSent) {
    ui.accessLastEmailSent.textContent = session.lastEmailSentAt
      ? formatDateTime(session.lastEmailSentAt)
      : 'Not sent yet';
  }
  if (ui.accessClientPinState) {
    ui.accessClientPinState.textContent = formatClientPinState(session);
  }
  if (ui.accessCreatedAt) {
    ui.accessCreatedAt.textContent = formatDateTime(session.createdAt);
  }
  if (ui.detailClientLinkInput) {
    ui.detailClientLinkInput.value = session.clientLink || '';
  }
  if (ui.detailAdvisorLinkInput) {
    ui.detailAdvisorLinkInput.value = session.advisorLink || '';
  }

  updateDetailActionState();
}

async function fetchPublishedSessions(query = '') {
  const url = new URL(`${WORKER_BASE_URL}/api/advisor/published-sessions`);
  if (query) {
    url.searchParams.set('q', query);
  }
  const response = await fetchWithAdvisorAuth(url.toString(), {
    method: 'GET',
    cache: 'no-store'
  }, {
    authPrompt: 'Sign in to view published client access.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Could not load published sessions (${response.status}).`);
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

async function loadSessionList(options = {}) {
  const { preserveSelection = true, autoSelect = true } = options;
  const requestId = ++state.listRequestId;
  const query = String(ui.accessSearchInput?.value || '').trim();
  setListStatus('Loading published sessions.');

  try {
    const payload = await fetchPublishedSessions(query);
    if (requestId !== state.listRequestId) {
      return;
    }

    state.sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    renderSessionList();

    const preferredId = preserveSelection && state.selectedId && state.sessions.some((entry) => entry.publishedId === state.selectedId)
      ? state.selectedId
      : (state.initialPubId && state.sessions.some((entry) => entry.publishedId === state.initialPubId) ? state.initialPubId : '');

    if (preferredId) {
      state.initialPubId = '';
      await loadSelectedSession(preferredId, { updateUrl: true });
      return;
    }

    if (state.selectedId && !state.sessions.some((entry) => entry.publishedId === state.selectedId)) {
      state.selectedId = '';
      state.selectedSession = null;
    }

    if (!preserveSelection) {
      state.selectedId = '';
      state.selectedSession = null;
    }

    if (!state.selectedId && autoSelect && state.sessions[0]) {
      await loadSelectedSession(state.sessions[0].publishedId, { updateUrl: true });
      return;
    }

    if (!state.selectedId) {
      setSelectedIdInUrl('');
      renderSelectedSession();
    }
  } catch (error) {
    setListStatus(error?.message || 'Could not load published sessions.');
    showToast(error?.message || 'Could not load published sessions.', 'error');
  }
}

async function loadSelectedSession(publishedId, options = {}) {
  const { updateUrl = true } = options;
  state.selectedId = publishedId;
  renderSessionList();
  renderSelectedSession();
  setActionError('');

  const requestId = ++state.detailRequestId;
  try {
    const payload = await fetchPublishedSessionDetail(publishedId);
    if (requestId !== state.detailRequestId) {
      return;
    }

    state.selectedSession = payload?.session || null;
    if (state.selectedSession?.clientSecretB64u && state.selectedSession?.advisorSecretB64u) {
      state.selectedSession.clientLink = buildClientSessionLink(publishedId, state.selectedSession.clientSecretB64u);
      state.selectedSession.advisorLink = buildAdvisorSessionLink(publishedId, state.selectedSession.advisorSecretB64u);
    }
    if (state.selectedSession) {
      mergeSelectedIntoList(state.selectedSession);
    }
    renderSessionList();
    renderSelectedSession();
    if (updateUrl) {
      setSelectedIdInUrl(publishedId);
    }
  } catch (error) {
    if (requestId !== state.detailRequestId) {
      return;
    }

    state.selectedSession = null;
    renderSelectedSession();
    setActionError(error?.message || 'Could not load this published session.');
    showToast(error?.message || 'Could not load this published session.', 'error');
  }
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

  const clientEmail = getSelectedClientEmail();
  const qrImageDataUrl = await getQrImageDataUrl(session.clientLink);
  const capability = await buildPublishedCapabilityToken(advisorSecretB64u, 'advisor');
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/send-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Published-Capability': capability
    },
    body: JSON.stringify({
      clientEmail,
      clientName: session.clientName || 'Client',
      clientLink: session.clientLink,
      pin: '',
      includePinInEmail: false,
      acknowledgeInlinePinRisk: false,
      qrImageDataUrl
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

async function runSelectedSessionAction(action) {
  if (!state.selectedSession) {
    return;
  }

  state.actionBusy = true;
  setActionError('');
  updateDetailActionState();

  try {
    await action(state.selectedSession);
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
    await loadSessionList({ preserveSelection: true, autoSelect: true });
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
    showToast('Advisor signed out.');
    state.sessions = [];
    state.selectedId = '';
    state.selectedSession = null;
    renderSessionList();
    renderSelectedSession();
    await ensureAdvisorAuthenticated('Sign in to manage published client access.');
    await loadSessionList({ preserveSelection: false, autoSelect: true });
  } catch (error) {
    showToast(error?.message || 'Could not sign out.', 'error');
  }
}

function bindEvents() {
  ui.accessRefreshButton?.addEventListener('click', async () => {
    await loadSessionList({ preserveSelection: true, autoSelect: true });
  });

  ui.accessSearchInput?.addEventListener('input', () => {
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => {
      void loadSessionList({ preserveSelection: false, autoSelect: true });
    }, 220);
  });

  ui.detailClientEmailInput?.addEventListener('input', () => {
    if (state.selectedSession) {
      state.selectedSession.clientEmail = String(ui.detailClientEmailInput.value || '').trim().toLowerCase();
      mergeSelectedIntoList(state.selectedSession);
      renderSessionList();
    }
    updateDetailActionState();
  });

  ui.detailCopyClientLinkButton?.addEventListener('click', async () => {
    await runSelectedSessionAction(async (session) => {
      await copyToClipboard(session.clientLink);
      showToast('Client link copied.');
    });
  });

  ui.detailCopyAdvisorLinkButton?.addEventListener('click', async () => {
    await runSelectedSessionAction(async (session) => {
      await copyToClipboard(session.advisorLink);
      showToast('Advisor link copied.');
    });
  });

  ui.detailSendEmailButton?.addEventListener('click', async () => {
    await runSelectedSessionAction(async (session) => {
      const payload = await sendPublishedSessionEmail(session);
      state.selectedSession = {
        ...session,
        clientEmail: payload.clientEmail || getSelectedClientEmail(),
        lastEmailSentAt: payload.lastEmailSentAt || session.lastEmailSentAt,
        emailSendCount: Number(payload.emailSendCount || session.emailSendCount || 0)
      };
      mergeSelectedIntoList(state.selectedSession);
      renderSessionList();
      renderSelectedSession();
      showToast('Final email sent.');
    });
  });

  ui.detailUpdateExpiryButton?.addEventListener('click', async () => {
    await runSelectedSessionAction(async (session) => {
      const payload = await updatePublishedSessionExpiry(session);
      state.selectedSession = {
        ...session,
        status: payload.status || 'active',
        expiresAt: payload.expiresAt || session.expiresAt
      };
      mergeSelectedIntoList(state.selectedSession);
      renderSessionList();
      renderSelectedSession();
      showToast('Expiry updated.');
    });
  });

  ui.detailResetAccessButton?.addEventListener('click', async () => {
    if (!window.confirm('Issue a fresh client link and reset the client PIN setup?\n\nThe current client link and QR code will stop working.')) {
      return;
    }

    await runSelectedSessionAction(async (session) => {
      state.selectedSession = await resetPublishedClientAccess(session);
      mergeSelectedIntoList(state.selectedSession);
      renderSessionList();
      renderSelectedSession();
      showToast('Client access reset.');
    });
  });

  ui.detailRevokeButton?.addEventListener('click', async () => {
    if (!window.confirm('Revoke this client link now?')) {
      return;
    }

    await runSelectedSessionAction(async (session) => {
      await revokePublishedSession(session);
      state.selectedSession = {
        ...session,
        status: 'revoked'
      };
      mergeSelectedIntoList(state.selectedSession);
      renderSessionList();
      renderSelectedSession();
      showToast('Client access revoked.');
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
  renderSessionList();
  renderSelectedSession();

  try {
    await ensureAdvisorAuthenticated('Sign in to manage published client access.');
    await loadSessionList({ preserveSelection: true, autoSelect: true });
  } catch (error) {
    showToast(error?.message || 'Could not initialize client access manager.', 'error');
  }
}

void init();
