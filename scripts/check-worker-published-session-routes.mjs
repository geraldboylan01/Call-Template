import { randomBytes } from 'node:crypto';

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

function randomBase64Url(byteLength) {
  return toBase64Url(randomBytes(byteLength));
}

async function loadPublishedCrypto() {
  const existingWindow = globalThis.window && typeof globalThis.window === 'object'
    ? globalThis.window
    : {};
  existingWindow.crypto = globalThis.crypto;
  globalThis.window = existingWindow;
  return import(new URL('../js/crypto_session.js', import.meta.url));
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

async function requestBytes(baseUrl, path, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    expectedStatus,
    retryLabel = `${method} ${path}`,
    cookieJar = null
  } = options;
  const response = await fetch(new URL(path, `${baseUrl}/`).toString(), {
    method,
    headers: cookieJar ? cookieJar.apply(headers) : headers,
    body
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (typeof expectedStatus === 'number' && response.status !== expectedStatus) {
    throw new Error(`${retryLabel} returned ${response.status} instead of ${expectedStatus}.`);
  }
  return { status: response.status, bytes, headers: response.headers };
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

async function buildPublishedSessionPayload(cryptoHelpers, assetRef = null) {
  const clientSessionJson = JSON.stringify({
    version: 1,
    clientName: 'Smoke Test Client',
    order: ['module-1'],
    modules: [
      {
        id: 'module-1',
        title: 'Protection review',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(assetRef ? {
          media: {
            images: [{
              id: 'smoke-image',
              assetId: assetRef.assetId,
              contentType: 'image/png',
              width: 1,
              height: 1,
              alt: 'Smoke image'
            }]
          }
        } : {}),
        generated: {
          summaryHtml: '<p>Smoke test summary.</p>'
        }
      }
    ]
  });
  const advisorSessionJson = JSON.stringify({
    version: 1,
    clientName: 'Smoke Test Client',
    order: ['module-1'],
    activeModuleId: 'module-1',
    modules: [
      {
        id: 'module-1',
        title: 'Protection review',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        notes: 'Advisor-only note',
        ...(assetRef ? {
          media: {
            images: [{
              id: 'smoke-image',
              assetId: assetRef.assetId,
              contentType: 'image/png',
              width: 1,
              height: 1,
              alt: 'Smoke image'
            }]
          }
        } : {}),
        generated: {
          summaryHtml: '<p>Smoke test summary.</p>'
        }
      }
    ]
  });
  const encrypted = await cryptoHelpers.encryptPublishedSessionV4({
    clientSessionJson,
    advisorSessionJson,
    clientName: 'Smoke Test Client',
    clientEmail: '',
    expiresInDays: 7
  });
  if (assetRef) {
    encrypted.requestBody.assetRefs = {
      draftSessionId: assetRef.draftSessionId,
      assetIds: [assetRef.assetId]
    };
  }

  return {
    ...encrypted,
    assetRef,
    clientSessionJson,
    advisorSessionJson,
    clientCapabilityToken: await cryptoHelpers.buildPublishedCapabilityToken(encrypted.clientSecretB64u, 'client'),
    advisorCapabilityToken: await cryptoHelpers.buildPublishedCapabilityToken(encrypted.advisorSecretB64u, 'advisor')
  };
}

async function buildDetachedSharePayload(cryptoHelpers) {
  const clientSessionJson = JSON.stringify({
    version: 1,
    clientName: 'Detached Share Smoke',
    order: ['module-1', 'module-2'],
    activeModuleId: 'module-1',
    modules: [
      {
        id: 'module-1',
        title: 'Overview module',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        generated: {
          summaryHtml: '<p>Detached share smoke summary.</p>'
        }
      },
      {
        id: 'module-2',
        title: 'Second module',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        generated: {
          summaryHtml: '<p>Second module summary.</p>'
        }
      }
    ]
  });
  const advisorSessionJson = JSON.stringify({
    version: 1,
    clientName: 'Detached Share Smoke',
    order: ['module-1', 'module-2'],
    activeModuleId: 'module-1',
    modules: [
      {
        id: 'module-1',
        title: 'Overview module',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        notes: 'Advisor-only detached note',
        generated: {
          summaryHtml: '<p>Detached share smoke summary.</p>'
        }
      },
      {
        id: 'module-2',
        title: 'Second module',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        notes: 'Another advisor-only note',
        generated: {
          summaryHtml: '<p>Second module summary.</p>'
        }
      }
    ]
  });
  const encrypted = await cryptoHelpers.encryptPublishedSessionV3({
    clientSessionJson,
    advisorSessionJson,
    clientName: 'Detached Share Smoke',
    clientEmail: '',
    expiresInDays: 7
  });
  encrypted.requestBody.publishTarget = 'detached-share';
  encrypted.requestBody.linkAccessMode = 'direct';
  encrypted.requestBody.recovery = {
    clientSecretB64u: encrypted.clientSecretB64u,
    advisorSecretB64u: encrypted.advisorSecretB64u
  };

  return {
    ...encrypted,
    clientSessionJson,
    advisorSessionJson,
    clientCapabilityToken: await cryptoHelpers.buildPublishedCapabilityToken(encrypted.clientSecretB64u, 'client'),
    advisorCapabilityToken: await cryptoHelpers.buildPublishedCapabilityToken(encrypted.advisorSecretB64u, 'advisor')
  };
}

async function main() {
  const workerBaseUrl = trimTrailingSlashes(process.env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL);
  const smokeOrigin = String(process.env.SMOKE_ORIGIN || DEFAULT_SMOKE_ORIGIN).trim();
  const cookieJar = new CookieJar();
  const originHeaders = {
    Origin: smokeOrigin
  };
  const cryptoHelpers = await loadPublishedCrypto();
  const clientPin = '123456';

  console.log(`Smoke checking published-session routes against ${workerBaseUrl}`);

  const advisorSession = await ensureAdvisorSession(workerBaseUrl, originHeaders, cookieJar);
  const advisorCsrfHeaders = advisorSession.authEnabled && advisorSession.csrfToken
    ? { 'X-Advisor-CSRF': advisorSession.csrfToken }
    : {};

  const mediaAsset = {
    draftSessionId: `session-smoke-media-${randomBase64Url(12)}`,
    assetId: `asset-smoke-media-${randomBase64Url(12)}`
  };
  const smokePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9lQAAAABJRU5ErkJggg==', 'base64');
  const draftAssetPath = `/api/advisor/module-assets/${encodeURIComponent(mediaAsset.draftSessionId)}/${encodeURIComponent(mediaAsset.assetId)}`;
  const draftUpload = await requestJson(workerBaseUrl, draftAssetPath, {
    method: 'PUT',
    headers: {
      ...originHeaders,
      ...advisorCsrfHeaders,
      'Content-Type': 'image/png'
    },
    body: smokePng,
    expectedStatus: 201,
    retryLabel: 'upload smoke module image',
    cookieJar
  });
  assert(draftUpload.data?.assetId === mediaAsset.assetId, 'Draft image upload did not return the asset id.');
  const draftImageFetch = await requestBytes(workerBaseUrl, draftAssetPath, {
    headers: originHeaders,
    expectedStatus: 200,
    retryLabel: 'fetch advisor draft image',
    cookieJar
  });
  assert(Buffer.from(draftImageFetch.bytes).equals(smokePng), 'Draft image bytes did not match the uploaded image.');
  if (advisorSession.authEnabled) {
    await requestJson(workerBaseUrl, draftAssetPath, {
      headers: originHeaders,
      expectedStatus: 401,
      retryLabel: 'reject unauthenticated draft image fetch'
    });
  }

  const payload = await buildPublishedSessionPayload(cryptoHelpers, mediaAsset);
  const detachedPayload = await buildDetachedSharePayload(cryptoHelpers);
  let publishedId = '';
  let detachedPublishedId = '';

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

    const detachedCreateResult = await requestJson(workerBaseUrl, '/api/published-sessions', {
      method: 'POST',
      headers: {
        ...originHeaders,
        ...advisorCsrfHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(detachedPayload.requestBody),
      expectedStatus: 201,
      retryLabel: 'create detached share session',
      cookieJar
    });
    detachedPublishedId = String(detachedCreateResult.data?.publishedId || '').trim();
    assert(detachedPublishedId, 'Detached publish response did not include publishedId.');
    assert(detachedCreateResult.data?.clientId === null, 'Detached publish unexpectedly linked a client.');
    assert(detachedCreateResult.data?.sourceLeadId === null, 'Detached publish unexpectedly linked a lead.');
    assert(detachedCreateResult.data?.publishTarget === 'detached-share', 'Detached publish target mismatch.');
    assert(detachedCreateResult.data?.linkAccessMode === 'direct', 'Detached link access mode mismatch.');
    console.log(`Created detached share smoke session ${detachedPublishedId}`);

    const clientHeaders = {
      ...originHeaders,
      'X-Published-Capability': payload.clientCapabilityToken
    };
    const advisorHeaders = {
      ...originHeaders,
      'X-Published-Capability': payload.advisorCapabilityToken
    };
    const detachedClientHeaders = {
      ...originHeaders,
      'X-Published-Capability': detachedPayload.clientCapabilityToken
    };
    const detachedAdvisorHeaders = {
      ...originHeaders,
      'X-Published-Capability': detachedPayload.advisorCapabilityToken
    };

    const detachedClientFetch = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(detachedPublishedId)}/client`, {
      headers: detachedClientHeaders,
      expectedStatus: 200,
      retryLabel: 'fetch detached direct client bundle'
    });
    assert(detachedClientFetch.data?.v === 3, 'Detached client bundle did not report v3.');
    assert(detachedClientFetch.data?.publishedId === detachedPublishedId, 'Detached client bundle publishedId mismatch.');
    assert(detachedClientFetch.data?.clientAccess?.pinRequired === false, 'Detached client bundle unexpectedly required a PIN.');
    const detachedPlaintext = await cryptoHelpers.decryptPublishedSessionV2ForClient(
      detachedPayload.clientSecretB64u,
      detachedClientFetch.data
    );
    assert(detachedPlaintext.includes('Detached Share Smoke'), 'Detached direct client access did not decrypt without a PIN.');

    const detachedAdvisorFetch = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(detachedPublishedId)}/advisor`, {
      headers: detachedAdvisorHeaders,
      expectedStatus: 200,
      retryLabel: 'fetch detached direct advisor bundle',
      cookieJar
    });
    assert(detachedAdvisorFetch.data?.v === 3, 'Detached advisor bundle did not report v3.');
    assert(detachedAdvisorFetch.data?.meta?.clientId === null, 'Detached advisor meta unexpectedly linked a client.');
    assert(detachedAdvisorFetch.data?.meta?.sourceLeadId === null, 'Detached advisor meta unexpectedly linked a lead.');

    const detachedListResult = await requestJson(workerBaseUrl, `/api/advisor/published-sessions?q=${encodeURIComponent(detachedPublishedId)}`, {
      headers: originHeaders,
      expectedStatus: 200,
      retryLabel: 'list detached share in published manager',
      cookieJar
    });
    const detachedSummary = (detachedListResult.data?.sessions || []).find((session) => session.publishedId === detachedPublishedId);
    assert(detachedSummary, 'Detached share session did not appear in the published-session manager list.');
    assert(detachedSummary.clientId === null, 'Detached manager summary unexpectedly linked a client.');
    assert(detachedSummary.pinRequired === false, 'Detached manager summary unexpectedly required a PIN.');
    assert(detachedSummary.recoveryAvailable === true, 'Detached manager summary did not report recovery data.');

    const detachedDetailResult = await requestJson(workerBaseUrl, `/api/advisor/published-sessions/${encodeURIComponent(detachedPublishedId)}`, {
      headers: originHeaders,
      expectedStatus: 200,
      retryLabel: 'load detached share manager detail',
      cookieJar
    });
    assert(detachedDetailResult.data?.session?.clientSecretB64u, 'Detached manager detail did not recover the client secret.');
    assert(detachedDetailResult.data?.session?.advisorSecretB64u, 'Detached manager detail did not recover the advisor secret.');

    const clientFetch = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/client`, {
      headers: clientHeaders,
      expectedStatus: 200,
      retryLabel: 'fetch client bundle'
    });
    assert(clientFetch.data?.v === 4, 'Client bundle did not report v4.');
    assert(clientFetch.data?.publishedId === publishedId, 'Client bundle publishedId mismatch.');
    assert(clientFetch.data?.clientAccess?.pinState === 'pending', 'Client bundle did not start pending.');
    assert(clientFetch.data?.clientAccess?.revision === 1, 'Client bundle did not start at revision 1.');

    const advisorFetch = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/advisor`, {
      headers: advisorHeaders,
      expectedStatus: 200,
      retryLabel: 'fetch advisor bundle',
      cookieJar
    });
    assert(advisorFetch.data?.v === 4, 'Advisor bundle did not report v4.');
    assert(advisorFetch.data?.meta?.clientName === 'Smoke Test Client', 'Advisor meta clientName mismatch.');
    assert(advisorFetch.data?.meta?.clientPinState === 'pending', 'Advisor meta pin state mismatch.');
    assert(advisorFetch.data?.meta?.clientAccessRevision === 1, 'Advisor meta revision mismatch.');

    const publishedAssetPath = `/api/published-sessions/${encodeURIComponent(publishedId)}/assets/${encodeURIComponent(mediaAsset.assetId)}`;
    await requestBytes(workerBaseUrl, publishedAssetPath, {
      headers: originHeaders,
      expectedStatus: 404,
      retryLabel: 'reject unauthenticated published image fetch'
    });
    const clientImageFetch = await requestBytes(workerBaseUrl, publishedAssetPath, {
      headers: clientHeaders,
      expectedStatus: 200,
      retryLabel: 'fetch client published image'
    });
    assert(Buffer.from(clientImageFetch.bytes).equals(smokePng), 'Client published image bytes did not match the uploaded image.');
    assert(clientImageFetch.headers.get('content-type') === 'image/png', 'Client published image content type mismatch.');
    const advisorImageFetch = await requestBytes(workerBaseUrl, publishedAssetPath, {
      headers: advisorHeaders,
      expectedStatus: 200,
      retryLabel: 'fetch advisor published image',
      cookieJar
    });
    assert(Buffer.from(advisorImageFetch.bytes).equals(smokePng), 'Advisor published image bytes did not match the uploaded image.');

    const finalizedClientAccess = await cryptoHelpers.finalizePublishedClientPinV4(
      payload.clientSecretB64u,
      clientFetch.data,
      clientPin,
      { nextRevision: 2 }
    );
    const setupResult = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/client-pin/setup`, {
      method: 'POST',
      headers: {
        ...clientHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        expectedRevision: 1,
        clientBundle: finalizedClientAccess.clientBundle
      }),
      expectedStatus: 200,
      retryLabel: 'first-open client PIN setup'
    });
    assert(setupResult.data?.clientPinState === 'active', 'PIN setup did not activate the client PIN state.');
    assert(setupResult.data?.clientAccessRevision === 2, 'PIN setup did not advance the client access revision.');

    const activeClientFetch = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/client`, {
      headers: clientHeaders,
      expectedStatus: 200,
      retryLabel: 'fetch active client bundle'
    });
    assert(activeClientFetch.data?.clientAccess?.pinState === 'active', 'Client bundle did not become active after PIN setup.');
    assert(activeClientFetch.data?.clientAccess?.revision === 2, 'Client bundle revision did not advance after PIN setup.');

    const rememberedOpenPlaintext = await cryptoHelpers.decryptPublishedSessionWithRememberedDek(
      activeClientFetch.data,
      finalizedClientAccess.dekB64u
    );
    assert(rememberedOpenPlaintext.includes('Smoke Test Client'), 'Same-device remembered access did not decrypt the client session.');

    const newDeviceOpen = await cryptoHelpers.resolvePublishedClientSessionAccess(
      payload.clientSecretB64u,
      activeClientFetch.data,
      { pin: clientPin }
    );
    assert(newDeviceOpen.plaintext.includes('Smoke Test Client'), 'New-device PIN access did not decrypt the client session.');

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

    const rotatedClientAccess = await cryptoHelpers.rotatePublishedClientAccessV4({
      clientSessionJson: payload.clientSessionJson,
      advisorSessionJson: payload.advisorSessionJson,
      advisorSecretB64u: payload.advisorSecretB64u,
      currentRevision: 2
    });
    const resetResult = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/client-access/reset`, {
      method: 'POST',
      headers: {
        ...advisorHeaders,
        ...advisorCsrfHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        expectedRevision: 2,
        clientAuthHashB64u: rotatedClientAccess.clientAuthHashB64u,
        clientBundle: rotatedClientAccess.clientBundle,
        advisorBundle: rotatedClientAccess.advisorBundle
      }),
      expectedStatus: 200,
      retryLabel: 'reset client access',
      cookieJar
    });
    assert(resetResult.data?.clientPinState === 'pending', 'Reset did not return the client link to pending state.');
    assert(resetResult.data?.clientAccessRevision === 3, 'Reset did not advance the client access revision.');

    await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/client`, {
      headers: clientHeaders,
      expectedStatus: 404,
      retryLabel: 'fetch old client bundle after reset'
    });

    const rotatedClientHeaders = {
      ...originHeaders,
      'X-Published-Capability': await cryptoHelpers.buildPublishedCapabilityToken(rotatedClientAccess.clientSecretB64u, 'client')
    };
    const resetClientFetch = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(publishedId)}/client`, {
      headers: rotatedClientHeaders,
      expectedStatus: 200,
      retryLabel: 'fetch rotated client bundle'
    });
    assert(resetClientFetch.data?.clientAccess?.pinState === 'pending', 'Rotated client bundle did not return to pending state.');
    assert(resetClientFetch.data?.clientAccess?.revision === 3, 'Rotated client bundle revision mismatch after reset.');

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
        clientLink: `https://planeir.ie/app/session.html?pub=wrong#ck=${randomBase64Url(32)}`,
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
      headers: rotatedClientHeaders,
      expectedStatus: 410,
      retryLabel: 'fetch revoked client bundle'
    });
    await requestBytes(workerBaseUrl, publishedAssetPath, {
      headers: rotatedClientHeaders,
      expectedStatus: 410,
      retryLabel: 'fetch revoked published image'
    });

    const detachedRevokeResult = await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(detachedPublishedId)}/revoke`, {
      method: 'POST',
      headers: {
        ...detachedAdvisorHeaders,
        ...advisorCsrfHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({}),
      expectedStatus: 200,
      retryLabel: 'revoke detached share session',
      cookieJar
    });
    assert(detachedRevokeResult.data?.ok === true, 'Detached revoke response was not ok.');

    console.log(`Worker published-session smoke checks passed for ${workerBaseUrl}`);
  } finally {
    try {
      await requestJson(workerBaseUrl, draftAssetPath, {
        method: 'DELETE',
        headers: {
          ...originHeaders,
          ...advisorCsrfHeaders
        },
        expectedStatus: 200,
        retryLabel: 'cleanup draft image',
        cookieJar
      });
    } catch (_error) {
      // Cleanup is best-effort only.
    }
    if (detachedPublishedId) {
      try {
        await requestJson(workerBaseUrl, `/api/published-sessions/${encodeURIComponent(detachedPublishedId)}/revoke`, {
          method: 'POST',
          headers: {
            ...originHeaders,
            ...advisorCsrfHeaders,
            'Content-Type': 'application/json',
            'X-Published-Capability': detachedPayload.advisorCapabilityToken
          },
          body: JSON.stringify({}),
          retryLabel: 'cleanup detached revoke',
          cookieJar
        });
      } catch (_error) {
        // Cleanup is best-effort only.
      }
    }
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
