import { decryptSessionJson } from './crypto_session.js';
import { importSession } from './state.js';

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
const pinInput = document.getElementById('sessionPinInput');
const unlockButton = document.getElementById('sessionUnlockBtn');
const errorHost = document.getElementById('sessionUnlockError');

function setError(message) {
  if (!errorHost) {
    return;
  }

  errorHost.textContent = String(message || '');
}

function setLoading(isLoading) {
  if (!unlockButton) {
    return;
  }

  unlockButton.disabled = isLoading;
  unlockButton.textContent = isLoading ? 'Unlocking...' : 'Unlock';
}

function getSessionIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  return id ? id.trim() : '';
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

async function unlockSession() {
  const sessionId = getSessionIdFromUrl();
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
  setLoading(true);

  try {
    const encryptedPayload = await fetchEncryptedSession(sessionId);
    const plaintext = await decryptSessionJson(pin, encryptedPayload);
    const importedSession = importSession(plaintext);

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
  } catch (error) {
    setError(error?.message || 'Could not unlock session.');
  } finally {
    setLoading(false);
  }
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

if (!getSessionIdFromUrl()) {
  setError('Missing session id in the URL.');
  if (unlockButton) {
    unlockButton.disabled = true;
  }
}

if (!WORKER_BASE_URL) {
  setError('Viewer is not configured with a worker URL.');
  if (unlockButton) {
    unlockButton.disabled = true;
  }
}
