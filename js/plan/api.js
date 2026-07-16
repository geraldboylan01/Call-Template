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
  rawBody,
  requestHeaders,
  authenticated = false,
  signal,
  timeoutMs = 20_000,
  responseType = 'json'
} = {}) {
  if (!API_BASE_URL) {
    throw new ConsumerApiError('The Planéir planning service is not configured.', {
      code: 'missing_api_base'
    });
  }

  const headers = new Headers({
    Accept: responseType === 'blob' || responseType === 'stream'
      ? 'audio/mpeg'
      : (responseType === 'text' ? 'application/sdp, application/json' : 'application/json'),
    ...(requestHeaders || {})
  });

  if (body !== undefined && rawBody === undefined) {
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

  const requestController = new AbortController();
  let timedOut = false;
  let responseStreamActive = false;
  const abortFromCaller = () => requestController.abort(signal?.reason || 'cancelled');
  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  let timeoutId = null;
  const armTimeout = () => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      timedOut = true;
      requestController.abort('timeout');
    }, timeoutMs);
  };
  armTimeout();
  const cleanupRequest = () => {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  };
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: rawBody === undefined
        ? (body === undefined ? undefined : JSON.stringify(body))
        : rawBody,
      credentials: 'omit',
      cache: 'no-store',
      signal: requestController.signal
    });
    if (!response.ok) {
      const payload = await parseResponse(response);
      if (requestController.signal.aborted) throw new Error('request_aborted');
      const errorObject = payload?.error && typeof payload.error === 'object' ? payload.error : {};
      throw new ConsumerApiError(extractErrorMessage(payload, response.status), {
        status: response.status,
        code: String(errorObject.code || payload?.code || ''),
        details: payload
      });
    }

    if (responseType === 'blob') {
      return {
        blob: await response.blob(),
        headers: response.headers,
        contentType: response.headers.get('content-type') || ''
      };
    }

    if (responseType === 'stream') {
      if (!response.body || typeof response.body.getReader !== 'function') {
        throw new ConsumerApiError('Approved voice streaming is unavailable in this browser.', {
          code: 'response_stream_unavailable'
        });
      }
      const reader = response.body.getReader();
      if (requestController.signal.aborted) {
        await reader.cancel(requestController.signal.reason).catch(() => {});
        throw new Error('request_aborted');
      }
      let closed = false;
      let abortReader = null;
      const closeStream = () => {
        if (closed) return;
        closed = true;
        if (abortReader) requestController.signal.removeEventListener('abort', abortReader);
        responseStreamActive = false;
        cleanupRequest();
      };
      abortReader = () => {
        reader.cancel(requestController.signal.reason || 'response_stream_aborted').catch(() => {});
        closeStream();
      };
      requestController.signal.addEventListener('abort', abortReader, { once: true });
      responseStreamActive = true;
      armTimeout();
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (closed) return;
            if (chunk.done) {
              closeStream();
              controller.close();
              return;
            }
            armTimeout();
            controller.enqueue(chunk.value);
          } catch (error) {
            if (closed) return;
            closeStream();
            controller.error(error);
          }
        },
        async cancel(reason) {
          requestController.abort(reason || 'response_stream_cancelled');
          await reader.cancel(reason).catch(() => {});
          closeStream();
        }
      });
      return {
        stream,
        headers: response.headers,
        contentType: response.headers.get('content-type') || '',
        contentLength: Number(response.headers.get('content-length')) || null
      };
    }

    if (responseType === 'text') {
      return {
        body: await response.text(),
        headers: response.headers,
        contentType: response.headers.get('content-type') || '',
        status: response.status
      };
    }

    const payload = await parseResponse(response);
    if (requestController.signal.aborted) throw new Error('request_aborted');
    return payload;
  } catch (error) {
    if (error instanceof ConsumerApiError) throw error;
    if (signal?.aborted) {
      throw new ConsumerApiError('The request was cancelled.', {
        code: 'request_aborted'
      });
    }
    if (timedOut || error?.name === 'AbortError') {
      throw new ConsumerApiError('That request took too long. Your saved journey is safe; please retry.', {
        code: 'request_timeout'
      });
    }
    throw new ConsumerApiError('Planéir could not reach the planning service. Check your connection and try again.', {
      code: 'network_error',
      details: error
    });
  } finally {
    if (!responseStreamActive) cleanupRequest();
  }
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

export function putAnalysisPlan(sessionId, plan) {
  const body = plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : {};
  return request(pathForSession(sessionId, '/analysis-plan'), {
    method: 'PUT',
    authenticated: true,
    body,
    timeoutMs: 60_000
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

export function updateVoiceConsent(sessionId, {
  granted,
  noticeId,
  policyVersion,
  privacyNoticeUrl
}) {
  return request(pathForSession(sessionId, '/voice/consent'), {
    method: 'PATCH',
    authenticated: true,
    body: {
      granted: granted === true,
      noticeId: String(noticeId || ''),
      policyVersion: String(policyVersion || ''),
      privacyNoticeUrl: String(privacyNoticeUrl || '')
    }
  });
}

export function updateRealtimeVoiceConsent(sessionId, {
  granted,
  noticeId,
  policyVersion,
  privacyNoticeUrl
}) {
  return request(pathForSession(sessionId, '/voice/realtime/consent'), {
    method: 'PATCH',
    authenticated: true,
    body: {
      granted: granted === true,
      noticeId: String(noticeId || ''),
      policyVersion: String(policyVersion || ''),
      privacyNoticeUrl: String(privacyNoticeUrl || '')
    }
  });
}

export function transcribeVoice(sessionId, {
  audio,
  durationMs,
  idempotencyKey,
  signal
}) {
  if (!(audio instanceof Blob) || audio.size === 0) {
    throw new ConsumerApiError('The recording did not contain any audio.', {
      code: 'empty_voice_recording'
    });
  }
  const boundedDurationMs = String(Math.max(0, Math.round(Number(durationMs) || 0)));
  return request(pathForSession(sessionId, '/voice/transcriptions'), {
    method: 'POST',
    authenticated: true,
    rawBody: audio,
    requestHeaders: {
      'Content-Type': String(audio.type || 'application/octet-stream'),
      'X-Voice-Duration-Ms': boundedDurationMs,
      'X-Voice-Request-Id': String(idempotencyKey || '')
    },
    signal,
    timeoutMs: 60_000
  });
}

export function speakNextQuestion(sessionId, { idempotencyKey, signal } = {}) {
  return request(pathForSession(sessionId, '/voice/speech'), {
    method: 'POST',
    authenticated: true,
    body: { idempotencyKey: String(idempotencyKey || '') },
    signal,
    timeoutMs: 45_000,
    responseType: 'blob'
  });
}

function realtimeCallPath(sessionId, leaseId = '') {
  const base = pathForSession(sessionId, '/voice/realtime/calls');
  const cleanLeaseId = String(leaseId || '').trim();
  if (!cleanLeaseId) return base;
  if (cleanLeaseId.length > 200) {
    throw new ConsumerApiError('The Live voice session reference is invalid.', {
      code: 'invalid_realtime_lease'
    });
  }
  return `${base}/${encodeURIComponent(cleanLeaseId)}`;
}

export function createRealtimeVoiceCall(sessionId, {
  sdp,
  idempotencyKey,
  activationId,
  controlCapability,
  signal
} = {}) {
  const offerSdp = String(sdp || '');
  if (!offerSdp.startsWith('v=0')) {
    throw new ConsumerApiError('The browser did not create a valid Live voice connection offer.', {
      code: 'invalid_realtime_offer'
    });
  }
  return request(realtimeCallPath(sessionId), {
    method: 'POST',
    authenticated: true,
    rawBody: offerSdp,
    requestHeaders: {
      'Content-Type': 'application/sdp',
      'X-Voice-Request-Id': String(idempotencyKey || ''),
      'X-Realtime-Activation-Id': String(activationId || ''),
      'X-Realtime-Control-Capability': String(controlCapability || '')
    },
    signal,
    timeoutMs: 45_000,
    responseType: 'text'
  });
}

export function deleteRealtimeVoiceActivation(sessionId, activationId, {
  signal,
  controlCapability
} = {}) {
  const value = String(activationId || '').trim();
  if (!/^rt_activation_[A-Za-z0-9_-]{20,80}$/.test(value)) {
    throw new ConsumerApiError('The Live voice activation reference is invalid.', {
      code: 'invalid_realtime_activation'
    });
  }
  return request(pathForSession(
    sessionId,
    `/voice/realtime/activations/${encodeURIComponent(value)}`
  ), {
    method: 'DELETE',
    authenticated: true,
    requestHeaders: realtimeControlHeaders(controlCapability),
    signal,
    timeoutMs: 20_000
  });
}

function realtimeControlHeaders(controlCapability) {
  const value = String(controlCapability || '').trim();
  if (!/^rt_control_[A-Za-z0-9_-]{20,80}$/.test(value)) {
    throw new ConsumerApiError('The Live voice control channel is unavailable.', {
      code: 'invalid_realtime_control_capability'
    });
  }
  return { 'X-Realtime-Control-Capability': value };
}

export function getRealtimeVoiceCall(sessionId, leaseId, { signal, controlCapability } = {}) {
  return request(realtimeCallPath(sessionId, leaseId), {
    authenticated: true,
    requestHeaders: realtimeControlHeaders(controlCapability),
    signal,
    timeoutMs: 20_000
  });
}

export function deleteRealtimeVoiceCall(sessionId, leaseId, { signal, controlCapability } = {}) {
  return request(realtimeCallPath(sessionId, leaseId), {
    method: 'DELETE',
    authenticated: true,
    requestHeaders: realtimeControlHeaders(controlCapability),
    signal,
    timeoutMs: 20_000
  });
}

export function speakRealtimeAuthorized(sessionId, leaseId, authorization, {
  signal,
  controlCapability
} = {}) {
  const value = authorization && typeof authorization === 'object' && !Array.isArray(authorization)
    ? authorization
    : {};
  return request(`${realtimeCallPath(sessionId, leaseId)}/speech`, {
    method: 'POST',
    authenticated: true,
    body: {
      speechId: String(value.speechId || ''),
      kind: String(value.kind || ''),
      profileRevision: Number(value.profileRevision),
      bindingId: String(value.bindingId || ''),
      text: String(value.text || ''),
      token: String(value.token || ''),
      controlId: String(value.controlId || ''),
      expiresAt: String(value.expiresAt || '')
    },
    requestHeaders: realtimeControlHeaders(controlCapability),
    signal,
    timeoutMs: 45_000,
    responseType: 'stream'
  });
}

export function deleteSession(sessionId) {
  return request(pathForSession(sessionId), {
    method: 'DELETE',
    authenticated: true
  });
}
