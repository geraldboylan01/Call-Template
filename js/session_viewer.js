import {
  buildPublishedCapabilityToken,
  decryptPublishedSessionV2ForClient,
  decryptPublishedSessionWithRememberedDek,
  decryptSessionJson,
  finalizePublishedClientPinV4,
  resolvePublishedClientSessionAccess
} from './crypto_session.js';
import { importPublishedSession } from './state.js';

window.__CALL_CANVAS_AUTO_INIT__ = false;

const PUBLISHED_DEVICE_ACCESS_STORAGE_PREFIX = 'planeir_published_client_access_v1';

function getMetaContent(name) {
  const element = document.querySelector(`meta[name="${name}"]`);
  return element?.getAttribute('content')?.trim() || '';
}

const WORKER_BASE_URL = (() => {
  const override = getMetaContent('call-canvas-worker-base-url');
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
const pinConfirmInput = document.getElementById('sessionPinConfirmInput');
const unlockButton = document.getElementById('sessionUnlockBtn');
const errorHost = document.getElementById('sessionUnlockError');

let publishedClientSecret = '';
let publishedBundle = null;
let publishedUnlockMode = 'enter';

async function recordPublishedUnlock(publishedId, clientSecretB64u, source = 'viewer') {
  const sessionId = typeof publishedId === 'string' ? publishedId.trim() : '';
  const secret = typeof clientSecretB64u === 'string' ? clientSecretB64u.trim() : '';
  if (!sessionId || !secret || !WORKER_BASE_URL) {
    return;
  }

  try {
    const capability = await buildPublishedCapabilityToken(secret, 'client');
    await fetch(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(sessionId)}/unlocked`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Published-Capability': capability
      },
      body: JSON.stringify({
        role: 'client',
        source
      }),
      keepalive: true
    });
  } catch (_error) {
    // Unlock telemetry should not block the client session opening path.
  }
}

function getPublishedPinRequired(bundle) {
  if (typeof bundle?.clientAccess?.pinRequired === 'boolean') {
    return bundle.clientAccess.pinRequired;
  }

  if (typeof bundle?.pinRequired === 'boolean') {
    return bundle.pinRequired;
  }

  return false;
}

function isFirstOpenPublishedBundle(bundle) {
  return Number(bundle?.v) >= 4 || bundle?.clientAccess?.mode === 'client-first-pin';
}

function getPublishedClientPinState(bundle) {
  return bundle?.clientAccess?.pinState === 'active' ? 'active' : 'pending';
}

function getPublishedClientAccessRevision(bundle) {
  const revision = Number(bundle?.clientAccess?.revision || 0);
  return Number.isInteger(revision) && revision > 0 ? revision : 0;
}

function getPublishedRememberedAccessKey(publishedId) {
  return `${PUBLISHED_DEVICE_ACCESS_STORAGE_PREFIX}:${publishedId}`;
}

function readRememberedPublishedAccess(publishedId) {
  const storageKey = getPublishedRememberedAccessKey(publishedId);
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const revision = Number(parsed.revision || 0);
    const dekB64u = typeof parsed.dekB64u === 'string' ? parsed.dekB64u.trim() : '';
    const expiresAt = typeof parsed.expiresAt === 'string' ? parsed.expiresAt.trim() : '';
    if (!Number.isInteger(revision) || revision < 1 || !dekB64u) {
      return null;
    }

    return {
      revision,
      dekB64u,
      expiresAt
    };
  } catch (_error) {
    return null;
  }
}

function writeRememberedPublishedAccess(publishedId, access) {
  const storageKey = getPublishedRememberedAccessKey(publishedId);
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      revision: Number(access?.revision || 0),
      dekB64u: String(access?.dekB64u || ''),
      expiresAt: String(access?.expiresAt || '')
    }));
  } catch (_error) {
    // Local convenience storage is optional.
  }
}

function clearRememberedPublishedAccess(publishedId) {
  if (!publishedId) {
    return;
  }

  try {
    localStorage.removeItem(getPublishedRememberedAccessKey(publishedId));
  } catch (_error) {
    // Ignore local storage failures.
  }
}

function setUnlockLayerVisible(visible) {
  if (!unlockLayer) {
    return;
  }

  unlockLayer.classList.toggle('is-hidden', !visible);
  unlockLayer.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function shouldUseRememberedPublishedAccess(bundle, rememberedAccess) {
  if (!isFirstOpenPublishedBundle(bundle) || getPublishedClientPinState(bundle) !== 'active') {
    return false;
  }

  if (!rememberedAccess) {
    return false;
  }

  const currentRevision = getPublishedClientAccessRevision(bundle);
  if (!currentRevision || rememberedAccess.revision !== currentRevision) {
    return false;
  }

  const bundleExpiry = String(bundle?.expiresAt || '').trim();
  if (bundleExpiry && rememberedAccess.expiresAt && rememberedAccess.expiresAt !== bundleExpiry) {
    return false;
  }

  if (bundleExpiry && Date.parse(bundleExpiry) <= Date.now()) {
    return false;
  }

  return Boolean(rememberedAccess.dekB64u);
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

function getUnlockButtonLabel() {
  return publishedUnlockMode === 'create' ? 'Create PIN' : 'Unlock';
}

function setUnlockMode(mode) {
  publishedUnlockMode = mode === 'create' ? 'create' : 'enter';
  const showGroup = mode === 'create' || mode === 'enter';

  if (pinGroup) {
    pinGroup.classList.toggle('is-hidden', !showGroup);
    pinGroup.setAttribute('aria-hidden', showGroup ? 'false' : 'true');
  }

  if (pinConfirmInput) {
    const showConfirm = mode === 'create';
    pinConfirmInput.classList.toggle('is-hidden', !showConfirm);
    pinConfirmInput.setAttribute('aria-hidden', showConfirm ? 'false' : 'true');
    pinConfirmInput.disabled = !showConfirm;
    pinConfirmInput.value = showConfirm ? pinConfirmInput.value : '';
  }

  if (unlockButton && !unlockButton.disabled) {
    unlockButton.textContent = getUnlockButtonLabel();
  }
}

function setLoading(isLoading, label) {
  if (!unlockButton) {
    return;
  }

  unlockButton.disabled = isLoading;
  if (isLoading) {
    unlockButton.textContent = label || (publishedUnlockMode === 'create' ? 'Saving...' : 'Unlocking...');
  } else {
    unlockButton.textContent = getUnlockButtonLabel();
  }
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

function getNormalizedPinValue() {
  return String(pinInput?.value || '').trim();
}

function getNormalizedPinConfirmValue() {
  return String(pinConfirmInput?.value || '').trim();
}

function validateRequiredPin(pin, message = 'Enter the 6-digit PIN.') {
  if (!/^\d{6}$/.test(pin)) {
    throw new Error(message);
  }
}

function clearPinInputs() {
  if (pinInput) {
    pinInput.value = '';
  }
  if (pinConfirmInput) {
    pinConfirmInput.value = '';
  }
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
    clearRememberedPublishedAccess(publishedId);
    throw new Error('This secure link is unavailable or incomplete.');
  }

  if (response.status === 410) {
    clearRememberedPublishedAccess(publishedId);
    throw new Error('This secure link has expired or has been revoked.');
  }

  if (!response.ok) {
    throw new Error(`Unable to load secure session (${response.status}).`);
  }

  return response.json();
}

async function submitPublishedClientPinSetup(publishedId, clientSecretB64u, expectedRevision, clientBundle) {
  const capability = await buildPublishedCapabilityToken(clientSecretB64u, 'client');
  const response = await fetch(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/client-pin/setup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Published-Capability': capability
    },
    body: JSON.stringify({
      expectedRevision,
      clientBundle
    })
  });

  const payload = await response.json().catch(() => null);
  if (response.status === 409) {
    return {
      ok: false,
      conflict: true,
      payload
    };
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Unable to save your PIN (${response.status}).`);
  }

  return {
    ok: true,
    payload
  };
}

async function openReadonlySession(sessionInput) {
  const importedSession = importPublishedSession(sessionInput);
  const { initApp } = await import('./app.js');
  const publishedId = getPublishedIdFromUrl();
  await initApp({
    initialSession: importedSession,
    assetAccess: publishedId && publishedClientSecret
      ? {
        publishedId,
        secret: publishedClientSecret,
        role: 'client'
      }
      : null,
    readOnly: true,
    allowDevPanel: false,
    allowPublish: false,
    persistLocalSession: false,
    showPensionToggle: false,
    startInOverview: true
  });

  setUnlockLayerVisible(false);
}

async function tryOpenPublishedSessionWithRememberedAccess(publishedId, rememberedAccess) {
  if (!rememberedAccess) {
    return false;
  }

  try {
    const plaintext = await decryptPublishedSessionWithRememberedDek(publishedBundle, rememberedAccess.dekB64u);
    await openReadonlySession(plaintext);
    void recordPublishedUnlock(publishedId, publishedClientSecret, 'viewer-remembered');
    return true;
  } catch (_error) {
    clearRememberedPublishedAccess(publishedId);
    return false;
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
    setUnlockMode('enter');
    if (unlockButton) {
      unlockButton.disabled = true;
    }
    return true;
  }

  setError('');
  setHint('Checking your secure link.');
  setUnlockMode('enter');
  clearPinInputs();
  setLoading(true, 'Opening...');

  try {
    publishedBundle = await fetchPublishedSession(publishedId, publishedClientSecret);
    if (isFirstOpenPublishedBundle(publishedBundle)) {
      const rememberedAccess = readRememberedPublishedAccess(publishedId);
      if (shouldUseRememberedPublishedAccess(publishedBundle, rememberedAccess)) {
        setHint('Secure link verified. Opening your session.');
        const opened = await tryOpenPublishedSessionWithRememberedAccess(publishedId, rememberedAccess);
        if (opened) {
          return true;
        }
      }

      if (getPublishedClientPinState(publishedBundle) === 'pending') {
        clearRememberedPublishedAccess(publishedId);
        setHint('Create your 6-digit PIN to continue.');
        setUnlockMode('create');
        setLoading(false);
        if (pinInput) {
          pinInput.focus();
        }
        return true;
      }

      setHint('Enter your 6-digit client PIN to continue.');
      setUnlockMode('enter');
      setLoading(false);
      if (pinInput) {
        pinInput.focus();
      }
      return true;
    }

    if (!getPublishedPinRequired(publishedBundle)) {
      setHint('Secure link verified. Opening your session.');
      const plaintext = await decryptPublishedSessionV2ForClient(publishedClientSecret, publishedBundle);
      await openReadonlySession(plaintext);
      void recordPublishedUnlock(publishedId, publishedClientSecret, 'viewer-no-pin');
      return true;
    }

    setHint('Enter the 6-digit client PIN to continue.');
    setUnlockMode('enter');
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

  const pin = getNormalizedPinValue();
  if (!/^\d{6}$/.test(pin)) {
    setError('Enter the 6-digit PIN.');
    return;
  }

  setError('');
  setLoading(true);

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
  const publishedId = getPublishedIdFromUrl();
  if (!publishedBundle || !publishedClientSecret || !publishedId) {
    await bootstrapPublishedSession();
    return;
  }

  if (isFirstOpenPublishedBundle(publishedBundle)) {
    if (getPublishedClientPinState(publishedBundle) === 'pending') {
      const pin = getNormalizedPinValue();
      const pinConfirm = getNormalizedPinConfirmValue();
      try {
        validateRequiredPin(pin, 'Create a 6-digit PIN.');
        validateRequiredPin(pinConfirm, 'Confirm your 6-digit PIN.');
        if (pin !== pinConfirm) {
          throw new Error('PINs do not match.');
        }
      } catch (error) {
        setError(error.message || 'Create a valid 6-digit PIN.');
        return;
      }

      setError('');
      setLoading(true, 'Saving...');

      try {
        const currentRevision = getPublishedClientAccessRevision(publishedBundle) || 1;
        const finalized = await finalizePublishedClientPinV4(publishedClientSecret, publishedBundle, pin, {
          nextRevision: currentRevision + 1
        });
        const setupResult = await submitPublishedClientPinSetup(
          publishedId,
          publishedClientSecret,
          currentRevision,
          finalized.clientBundle
        );
        if (!setupResult.ok && setupResult.conflict) {
          publishedBundle = await fetchPublishedSession(publishedId, publishedClientSecret);
          setUnlockMode('enter');
          setHint('This secure link was already set up. Enter the 6-digit PIN to continue.');
          setError('This secure link was already opened on another device.');
          setLoading(false);
          if (pinInput) {
            pinInput.focus();
          }
          return;
        }

        writeRememberedPublishedAccess(publishedId, {
          revision: Number(setupResult.payload?.clientAccessRevision || finalized.revision),
          dekB64u: finalized.dekB64u,
          expiresAt: publishedBundle?.expiresAt || ''
        });
        publishedBundle = {
          ...publishedBundle,
          clientAccess: finalized.clientBundle.clientAccess
        };
        await openReadonlySession(finalized.plaintext);
        void recordPublishedUnlock(publishedId, publishedClientSecret, 'viewer-first-open-pin-created');
      } catch (error) {
        setError(error?.message || 'Could not save your PIN.');
        setLoading(false);
      }

      return;
    }

    const pin = getNormalizedPinValue();
    if (!/^\d{6}$/.test(pin)) {
      setError('Enter the 6-digit PIN.');
      return;
    }

    setError('');
    setLoading(true);

    try {
      const resolved = await resolvePublishedClientSessionAccess(publishedClientSecret, publishedBundle, { pin });
      writeRememberedPublishedAccess(publishedId, {
        revision: getPublishedClientAccessRevision(publishedBundle),
        dekB64u: resolved.dekB64u,
        expiresAt: publishedBundle?.expiresAt || ''
      });
      await openReadonlySession(resolved.plaintext);
      void recordPublishedUnlock(publishedId, publishedClientSecret, 'viewer-pin');
    } catch (error) {
      setError(error?.message || 'Could not unlock session.');
      setLoading(false);
    }

    return;
  }

  const pin = getNormalizedPinValue();
  if (!/^\d{6}$/.test(pin)) {
    setError('Enter the 6-digit PIN.');
    return;
  }

  setError('');
  setLoading(true);

  try {
    const plaintext = await decryptPublishedSessionV2ForClient(publishedClientSecret, publishedBundle, { pin });
    await openReadonlySession(plaintext);
    void recordPublishedUnlock(publishedId, publishedClientSecret, 'viewer-pin');
  } catch (error) {
    setError(error?.message || 'Could not unlock session.');
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

[pinInput, pinConfirmInput].forEach((element) => {
  if (!element) {
    return;
  }

  element.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      await unlockSession();
    }
  });
});

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
    setUnlockMode('enter');
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
