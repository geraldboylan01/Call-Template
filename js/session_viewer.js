import {
  buildPublishedCapabilityToken,
  decryptPublishedSessionV2ForClient,
  decryptSessionJson
} from './crypto_session.js';
import { importPublishedSession } from './state.js';

window.__CALL_CANVAS_AUTO_INIT__ = false;

const WORKER_BASE_URL = (() => {
  const override = typeof window.__WORKER_BASE_URL === 'string'
    ? window.__WORKER_BASE_URL.trim()
    : '';
  if (override) {
    return override.replace(/\/+$/, '');
  }

  if (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') {
    return 'http://127.0.0.1:8787';
  }

  return '';
})();

const unlockLayer = document.getElementById('sessionUnlockLayer');
const unlockHint = document.getElementById('sessionUnlockHint');
const pinGroup = document.getElementById('sessionPinGroup');
const pinInput = document.getElementById('sessionPinInput');
const unlockButton = document.getElementById('sessionUnlockBtn');
const errorHost = document.getElementById('sessionUnlockError');

let publishedClientSecret = '';
let publishedBundle = null;

function getPublishedPinRequired(bundle) {
  if (typeof bundle?.clientAccess?.pinRequired === 'boolean') {
    return bundle.clientAccess.pinRequired;
  }

  if (typeof bundle?.pinRequired === 'boolean') {
    return bundle.pinRequired;
  }

  return false;
}

function setError(message) {
  if (!errorHost) {
    return;
  }

  errorHost.textContent = String(message || '');
}

function setHint(message) {
  if (!unlockHint) {
    return;
  }

  unlockHint.textContent = String(message || '');
}

function setPinGroupVisible(visible) {
  if (!pinGroup) {
    return;
  }

  pinGroup.classList.toggle('is-hidden', !visible);
  pinGroup.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function setLoading(isLoading, label = 'Unlock') {
  if (!unlockButton) {
    return;
  }

  unlockButton.disabled = isLoading;
  unlockButton.textContent = isLoading ? label : 'Unlock';
}

function getSearchParam(name) {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(name);
  return value ? value.trim() : '';
}

function getHashParam(name) {
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(hash);
  const value = params.get(name);
  return value ? value.trim() : '';
}

function getPublishedIdFromUrl() {
  return getSearchParam('pub');
}

function getLegacySessionIdFromUrl() {
  return getSearchParam('id');
}

async function fetchEncryptedSession(sessionId) {
  const response = await fetch(`${WORKER_BASE_URL}/api/session/${encodeURIComponent(sessionId)}`);

  if (response.status === 404) {
    throw new Error('Session link is unavailable or has been revoked.');
  }

  if (!response.ok) {
    throw new Error(`Unable to load session (${response.status}).`);
  }

  return response.json();
}

async function fetchPublishedSession(publishedId, clientSecretB64u) {
  const capability = await buildPublishedCapabilityToken(clientSecretB64u, 'client');
  const response = await fetch(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/client`, {
    headers: {
      'X-Published-Capability': capability
    }
  });

  if (response.status === 404) {
    throw new Error('This secure link is unavailable or incomplete.');
  }

  if (response.status === 410) {
    throw new Error('This secure link has expired or has been revoked.');
  }

  if (!response.ok) {
    throw new Error(`Unable to load secure session (${response.status}).`);
  }

  return response.json();
}

async function openReadonlySession(sessionInput) {
  const importedSession = importPublishedSession(sessionInput);
  const { initApp } = await import('./app.js');
  await initApp({
    initialSession: importedSession,
    readOnly: true,
    allowDevPanel: false,
    allowPublish: false,
    persistLocalSession: false,
    showPensionToggle: false
  });

  if (unlockLayer) {
    unlockLayer.classList.add('is-hidden');
    unlockLayer.setAttribute('aria-hidden', 'true');
  }
}

async function bootstrapPublishedSession() {
  const publishedId = getPublishedIdFromUrl();
  publishedClientSecret = getHashParam('ck');
  publishedBundle = null;

  if (!publishedId) {
    return false;
  }

  if (!publishedClientSecret) {
    setHint('This secure link is incomplete.');
    setError('Ask Gerry to resend the full secure link.');
    setPinGroupVisible(false);
    if (unlockButton) {
      unlockButton.disabled = true;
    }
    return true;
  }

  setError('');
  setHint('Checking your secure link.');
  setPinGroupVisible(false);
  setLoading(true, 'Opening...');

  try {
    publishedBundle = await fetchPublishedSession(publishedId, publishedClientSecret);
    if (!getPublishedPinRequired(publishedBundle)) {
      setHint('Secure link verified. Opening your session.');
      const plaintext = await decryptPublishedSessionV2ForClient(publishedClientSecret, publishedBundle);
      await openReadonlySession(plaintext);
      return true;
    }

    setHint('Enter the 6-digit client PIN to continue.');
    setPinGroupVisible(true);
    setLoading(false);
    if (pinInput) {
      pinInput.focus();
    }
  } catch (error) {
    setHint('This secure link could not be opened.');
    setError(error?.message || 'Could not open secure session.');
    setLoading(false);
  }

  return true;
}

async function unlockLegacySession() {
  const sessionId = getLegacySessionIdFromUrl();
  if (!sessionId) {
    setError('Missing session id in the URL.');
    return;
  }

  const pin = String(pinInput?.value || '').trim();
  if (!/^\d{6}$/.test(pin)) {
    setError('Enter the 6-digit PIN.');
    return;
  }

  setError('');
  setLoading(true, 'Unlocking...');

  try {
    const encryptedPayload = await fetchEncryptedSession(sessionId);
    const plaintext = await decryptSessionJson(pin, encryptedPayload);
    await openReadonlySession(plaintext);
  } catch (error) {
    setError(error?.message || 'Could not unlock session.');
  } finally {
    setLoading(false);
  }
}

async function unlockPublishedSession() {
  if (!publishedBundle || !publishedClientSecret) {
    await bootstrapPublishedSession();
    return;
  }

  const pin = String(pinInput?.value || '').trim();
  if (!/^\d{6}$/.test(pin)) {
    setError('Enter the 6-digit PIN.');
    return;
  }

  setError('');
  setLoading(true, 'Unlocking...');

  try {
    const plaintext = await decryptPublishedSessionV2ForClient(publishedClientSecret, publishedBundle, { pin });
    await openReadonlySession(plaintext);
  } catch (error) {
    setError(error?.message || 'Could not unlock session.');
  } finally {
    setLoading(false);
  }
}

async function unlockSession() {
  if (getPublishedIdFromUrl()) {
    await unlockPublishedSession();
    return;
  }

  await unlockLegacySession();
}

if (unlockButton) {
  unlockButton.addEventListener('click', async () => {
    await unlockSession();
  });
}

if (pinInput) {
  pinInput.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      await unlockSession();
    }
  });
}

async function initViewer() {
  if (!WORKER_BASE_URL) {
    setHint('Viewer setup is incomplete.');
    setError('Viewer is not configured with a worker URL.');
    if (unlockButton) {
      unlockButton.disabled = true;
    }
    return;
  }

  if (getPublishedIdFromUrl()) {
    await bootstrapPublishedSession();
    return;
  }

  if (getLegacySessionIdFromUrl()) {
    setHint('Enter your 6-digit PIN to unlock this call canvas.');
    setPinGroupVisible(true);
    setLoading(false);
    return;
  }

  setHint('This secure link is missing a session reference.');
  setError('Missing session id in the URL.');
  if (unlockButton) {
    unlockButton.disabled = true;
  }
}

void initViewer();
