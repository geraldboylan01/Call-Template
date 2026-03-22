import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_WORKER_BASE_URL = 'https://call-canvas-session-worker.geraldboylan.workers.dev';
const DEFAULT_SMOKE_ORIGIN = 'https://planeir.ie';
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3_000;

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  setFromHeader(value) {
    const normalized = String(value || '').trim();
    if (!normalized) {
      return;
    }

    const [cookiePart] = normalized.split(';');
    const separatorIndex = cookiePart.indexOf('=');
    if (separatorIndex <= 0) {
      return;
    }

    const name = cookiePart.slice(0, separatorIndex).trim();
    const cookieValue = cookiePart.slice(separatorIndex + 1).trim();
    if (!name) {
      return;
    }

    if (!cookieValue) {
      this.cookies.delete(name);
      return;
    }

    this.cookies.set(name, cookieValue);
  }

  apply(headers) {
    if (this.cookies.size === 0) {
      return headers;
    }

    const nextHeaders = new Headers(headers || {});
    const cookieValue = [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    nextHeaders.set('Cookie', cookieValue);
    return nextHeaders;
  }
}

function trimTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '');
}

function toBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = String(value)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function sha256Base64Url(value) {
  return toBase64Url(createHash('sha256').update(value).digest());
}

function randomBase64Url(byteLength) {
  return toBase64Url(randomBytes(byteLength));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(baseUrl, path, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    expectedStatus,
    retryLabel = `${method} ${path}`,
    cookieJar = null
  } = options;
  const url = new URL(path, `${baseUrl}/`).toString();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: cookieJar ? cookieJar.apply(headers) : headers,
        body
      });
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`${retryLabel} failed after ${MAX_ATTEMPTS} attempts: ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const text = await response.text();
    if (cookieJar) {
      const setCookieHeaders = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
      setCookieHeaders.forEach((value) => {
        cookieJar.setFromHeader(value);
      });
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_error) {
      data = null;
    }

    if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    if (typeof expectedStatus === 'number' && response.status !== expectedStatus) {
      throw new Error(`${retryLabel} returned ${response.status} instead of ${expectedStatus}. Body: ${text}`);
    }

    return {
      status: response.status,
      text,
      data
    };
  }

  throw new Error(`${retryLabel} exhausted retries.`);
}

async function ensureAdvisorSession(baseUrl, originHeaders, cookieJar) {
  const sessionResult = await requestJson(baseUrl, '/api/auth/session', {
    headers: originHeaders,
    expectedStatus: 200,
    retryLabel: 'check advisor auth session',
    cookieJar
  });

  if (sessionResult.data?.authEnabled !== true) {
    return {
      authEnabled: false,
      csrfToken: ''
    };
  }

  if (sessionResult.data?.authenticated === true) {
    return {
      authEnabled: true,
      csrfToken: String(sessionResult.data?.csrfToken || '')
    };
  }

  const password = String(process.env.ADVISOR_SMOKE_PASSWORD || process.env.ADVISOR_PASSWORD || '').trim();
  assert(password, 'Advisor auth is enabled on the live worker but ADVISOR_SMOKE_PASSWORD is not configured for smoke checks.');

  const loginResult = await requestJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: {
      ...originHeaders,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ password }),
    expectedStatus: 200,
    retryLabel: 'advisor login',
    cookieJar
  });

  assert(loginResult.data?.authenticated === true, 'Advisor login did not return an authenticated session.');
  return {
    authEnabled: true,
    csrfToken: String(loginResult.data?.csrfToken || '')
  };
}

function buildPublishedSessionPayload() {
  const clientCapabilityToken = randomBase64Url(32);
  const advisorCapabilityToken = randomBase64Url(32);

  return {
    clientCapabilityToken,
    advisorCapabilityToken,
    requestBody: {
      v: 3,
      meta: {
        clientName: 'Smoke Test Client',
        clientEmail: '',
        expiresInDays: 7
      },
      auth: {
        clientAuthHashB64u: sha256Base64Url(fromBase64Url(clientCapabilityToken)),
        advisorAuthHashB64u: sha256Base64Url(fromBase64Url(advisorCapabilityToken))
      },
      clientBundle: {
        v: 3,
        kind: 'published-client-session',
        payload: {
          alg: 'AES-GCM-256',
          ivB64u: randomBase64Url(12),
          ctB64u: randomBase64Url(96)
        },
        clientAccess: {
          pinRequired: false,
          wrap: {
            alg: 'AES-GCM-256',
            ivB64u: randomBase64Url(12),
            ctB64u: randomBase64Url(48)
          }
        }
      },
      advisorBundle: {
        v: 3,
        kind: 'published-advisor-session',
        payload: {
          alg: 'AES-GCM-256',
          ivB64u: randomBase64Url(12),
          ctB64u: randomBase64Url(96)
        },
        advisorAccess: {
          wrap: {
            alg: 'AES-GCM-256',
            ivB64u: randomBase64Url(12),
            ctB64u: randomBase64Url(48)
          }
        }
      }
    }
  };
}

async function main() {
  const workerBaseUrl = trimTrailingSlashes(process.env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL);
  const smokeOrigin = String(process.env.SMOKE_ORIGIN || DEFAULT_SMOKE_ORIGIN).trim();
  const cookieJar = new CookieJar();
  const originHeaders = {
    Origin: smokeOrigin
  };

  console.log(`Smoke checking published-session routes against ${workerBaseUrl}`);

  const advisorSession = await ensureAdvisorSession(workerBaseUrl, originHeaders, cookieJar);
  const advisorCsrfHeaders = advisorSession.authEnabled && advisorSession.csrfToken
    ? { 'X-Advisor-CSRF': advisorSession.csrfToken }
    : {};

  const payload = buildPublishedSessionPayload();
  let publishedId = '';

  try {
    const createResult = await requestJson(workerBaseUrl, '/api/published-sessions', {
      method: 'POST',
      headers: {
        ...originHeaders,
        ...advisorCsrfHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload.requestBody),
      expectedStatus: 201,
      retryLabel: 'create published session',
      cookieJar
    });

    publishedId = String(createResult.data?.publishedId || '').trim();
    assert(publishedId, 'Publish response did not include publishedId.');
    console.log(`Created smoke session ${publishedId}`);

    const clientHeaders = {
      ...originHeaders,
      'X-Published-Capability': payload.clientCapabilityToken
    };
    const advisorHeaders = {
      ...originHeaders,
      'X-Published-Capability': payload.advisorCapabilityToken
    };

    const clientFetch = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/client`, {
      headers: clientHeaders,
      expectedStatus: 200,
      retryLabel: 'fetch client bundle'
    });
    assert(clientFetch.data?.v === 3, 'Client bundle did not report v3.');
    assert(clientFetch.data?.publishedId === publishedId, 'Client bundle publishedId mismatch.');
    assert(clientFetch.data?.clientAccess?.pinRequired === false, 'Client bundle pinRequired mismatch.');

    const advisorFetch = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/advisor`, {
      headers: advisorHeaders,
      expectedStatus: 200,
      retryLabel: 'fetch advisor bundle',
      cookieJar
    });
    assert(advisorFetch.data?.v === 3, 'Advisor bundle did not report v3.');
    assert(advisorFetch.data?.meta?.clientName === 'Smoke Test Client', 'Advisor meta clientName mismatch.');

    await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/unlocked`, {
      method: 'POST',
      headers: {
        ...clientHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        role: 'client',
        source: 'ci-smoke-client'
      }),
      expectedStatus: 200,
      retryLabel: 'record client unlock'
    });

    await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/unlocked`, {
      method: 'POST',
      headers: {
        ...advisorHeaders,
        ...advisorCsrfHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        role: 'advisor',
        source: 'ci-smoke-advisor'
      }),
      expectedStatus: 200,
      retryLabel: 'record advisor unlock',
      cookieJar
    });

    const extendResult = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/extend`, {
      method: 'POST',
      headers: {
        ...advisorHeaders,
        ...advisorCsrfHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        expiresInDays: 7
      }),
      expectedStatus: 200,
      retryLabel: 'extend published session',
      cookieJar
    });
    assert(extendResult.data?.status === 'active', 'Extend response did not keep the session active.');

    const invalidEmailResult = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/send-email`, {
      method: 'POST',
      headers: {
        ...advisorHeaders,
        ...advisorCsrfHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        clientEmail: 'smoke-test@example.com',
        clientName: 'Smoke Test Client',
        clientLink: `${workerBaseUrl}/app/session.html?pub=wrong#ck=${randomBase64Url(32)}`,
        includePinInEmail: false
      }),
      expectedStatus: 400,
      retryLabel: 'send-email validation failure',
      cookieJar
    });
    assert(
      /does not match this session|host is not allowed|path is invalid|query is invalid|hash is invalid/i.test(invalidEmailResult.text),
      'send-email smoke check did not fail on clientLink validation as expected.'
    );

    const revokeResult = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/revoke`, {
      method: 'POST',
      headers: {
        ...advisorHeaders,
        ...advisorCsrfHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({}),
      expectedStatus: 200,
      retryLabel: 'revoke published session',
      cookieJar
    });
    assert(revokeResult.data?.ok === true, 'Revoke response was not ok.');

    await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/client`, {
      headers: clientHeaders,
      expectedStatus: 410,
      retryLabel: 'fetch revoked client bundle'
    });

    console.log(`Worker published-session smoke checks passed for ${workerBaseUrl}`);
  } finally {
    if (publishedId) {
      try {
        await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/revoke`, {
          method: 'POST',
          headers: {
            ...originHeaders,
            ...advisorCsrfHeaders,
            'Content-Type': 'application/json',
            'X-Published-Capability': payload.advisorCapabilityToken
          },
          body: JSON.stringify({}),
          retryLabel: 'cleanup revoke',
          cookieJar
        });
      } catch (_error) {
        // Cleanup is best-effort only.
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
