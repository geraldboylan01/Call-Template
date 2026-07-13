import { getConsumerInvite, getSessionCredential } from './store.js';

function getMetaContent(name) {
  const element = document.querySelector(`meta[name="${name}"]`);
  return element?.getAttribute('content')?.trim() || '';
}

export const API_BASE_URL = (() => {
  if (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') {
    return 'http://127.0.0.1:8787';
  }

  const override = getMetaContent('planeir-consumer-api-base-url')
    || getMetaContent('call-canvas-worker-base-url');
  return override ? override.replace(/\/+$/, '') : '';
})();

export class ConsumerApiError extends Error {
  constructor(message, { status = 0, code = '', details = null } = {}) {
    super(message);
    this.name = 'ConsumerApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function pathForSession(sessionId, suffix = '') {
  const id = String(sessionId || '').trim();
  if (!id) {
    throw new ConsumerApiError('This private session is no longer available.', { code: 'missing_session' });
  }
  return `/api/consumer/sessions/${encodeURIComponent(id)}${suffix}`;
}

function extractErrorMessage(payload, status) {
  if (payload && typeof payload === 'object') {
    const nestedError = payload.error && typeof payload.error === 'object' ? payload.error : null;
    const message = nestedError?.message || payload.message || payload.error;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  }

  if (status === 401 || status === 403) {
    return 'Your private session access has expired. Please begin a new journey.';
  }
  if (status === 404) {
    return 'This private-beta feature or session is not available.';
  }
  if (status === 409) {
    return 'That update conflicted with a newer change. Please refresh and try again.';
  }
  if (status === 429) {
    return 'There have been too many requests. Please wait a moment and try again.';
  }
  if (status >= 500) {
    return 'Planéir could not complete that request just now. Your existing journey is safe.';
  }
  return `The request could not be completed (${status || 'network error'}).`;
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (response.status === 204) {
    return {};
  }

  if (contentType.includes('application/json')) {
    return response.json().catch(() => ({}));
  }

  const text = await response.text().catch(() => '');
  return text ? { message: text } : {};
}

async function request(path, {
  method = 'GET',
  body,
  authenticated = false,
  signal,
  timeoutMs = 20_000
} = {}) {
  if (!API_BASE_URL) {
    throw new ConsumerApiError('The Planéir planning service is not configured.', {
      code: 'missing_api_base'
    });
  }

  const headers = new Headers({
    Accept: 'application/json'
  });

  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  if (authenticated) {
    const credential = getSessionCredential();
    if (!credential) {
      throw new ConsumerApiError('Your private session access is missing. Please begin again.', {
        status: 401,
        code: 'missing_credential'
      });
    }
    headers.set('X-Consumer-Session', credential);
  } else if (path === '/api/consumer/sessions' && method === 'POST') {
    const invite = getConsumerInvite();
    if (invite) headers.set('X-Consumer-Invite', invite);
    const proposedCredential = getSessionCredential();
    if (proposedCredential) headers.set('X-Consumer-Session', proposedCredential);
  }

  let response;
  const timeoutController = signal ? null : new AbortController();
  const timeoutId = timeoutController
    ? window.setTimeout(() => timeoutController.abort('timeout'), timeoutMs)
    : null;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      signal: signal || timeoutController.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ConsumerApiError('That request took too long. Your saved journey is safe; please retry.', {
        code: 'request_timeout'
      });
    }
    throw new ConsumerApiError('Planéir could not reach the planning service. Check your connection and try again.', {
      code: 'network_error',
      details: error
    });
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }

  const payload = await parseResponse(response);
  if (!response.ok) {
    const errorObject = payload?.error && typeof payload.error === 'object' ? payload.error : {};
    throw new ConsumerApiError(extractErrorMessage(payload, response.status), {
      status: response.status,
      code: String(errorObject.code || payload?.code || ''),
      details: payload
    });
  }

  return payload;
}

export function getBootstrap() {
  return request('/api/consumer/bootstrap');
}

export function createSession(consent) {
  return request('/api/consumer/sessions', {
    method: 'POST',
    body: { consent }
  });
}

export function getSession(sessionId) {
  return request(pathForSession(sessionId), { authenticated: true });
}

export function addTurn(sessionId, { message, idempotencyKey }) {
  return request(pathForSession(sessionId, '/turns'), {
    method: 'POST',
    authenticated: true,
    body: { message, idempotencyKey }
  });
}

export function patchProfile(sessionId, patch, confirmedPaths = [], expectedRevision, removePaths = []) {
  return request(pathForSession(sessionId, '/profile'), {
    method: 'PATCH',
    authenticated: true,
    body: { patch, confirmedPaths, expectedRevision, removePaths }
  });
}

export function confirmProfile(sessionId, confirmedPaths = [], expectedRevision) {
  return request(pathForSession(sessionId, '/confirm'), {
    method: 'POST',
    authenticated: true,
    body: { confirmedPaths, expectedRevision }
  });
}

export function runAnalyses(sessionId, moduleIds) {
  return request(pathForSession(sessionId, '/analyses'), {
    method: 'POST',
    authenticated: true,
    body: Array.isArray(moduleIds) ? { moduleIds } : undefined,
    timeoutMs: 45_000
  });
}

export function createHandoff(sessionId, handoff) {
  return request(pathForSession(sessionId, '/handoffs'), {
    method: 'POST',
    authenticated: true,
    body: handoff
  });
}

export function revokeHandoff(sessionId) {
  return request(pathForSession(sessionId, '/handoffs'), {
    method: 'DELETE',
    authenticated: true
  });
}

export function withdrawAiConsent(sessionId) {
  return request(pathForSession(sessionId, '/consent'), {
    method: 'PATCH',
    authenticated: true,
    body: { aiProcessing: false }
  });
}

export function deleteSession(sessionId) {
  return request(pathForSession(sessionId), {
    method: 'DELETE',
    authenticated: true
  });
}
