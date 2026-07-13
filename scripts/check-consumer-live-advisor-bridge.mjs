import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3_000;

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  capture(headers) {
    const values = typeof headers?.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers?.get('set-cookie')].filter(Boolean);
    for (const value of values) {
      const [pair] = String(value || '').split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      if (!name) continue;
      if (cookieValue) this.cookies.set(name, cookieValue);
      else this.cookies.delete(name);
    }
  }

  apply(headers = {}) {
    const result = new Headers(headers);
    if (this.cookies.size) {
      result.set('Cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    return result;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBase64Url(byteLength) {
  return randomBytes(byteLength).toString('base64url');
}

export function buildProposedCredential() {
  return `cs_${randomBase64Url(18)}.${randomBase64Url(32)}`;
}

async function requestJson(baseUrl, pathname, {
  method = 'GET',
  origin,
  headers = {},
  body,
  cookieJar,
  acceptedStatuses = [200],
  retryOnServerError = true,
  diagnosticPath = pathname
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const requestHeaders = cookieJar
      ? cookieJar.apply({ Origin: origin, Accept: 'application/json', ...headers })
      : new Headers({ Origin: origin, Accept: 'application/json', ...headers });
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
    let response;
    try {
      response = await fetch(new URL(pathname, `${baseUrl}/`), {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_ATTEMPTS) throw error;
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    cookieJar?.capture(response.headers);
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_error) {
      throw new Error(`${method} ${diagnosticPath} returned invalid JSON.`);
    }
    if (response.status >= 500 && retryOnServerError && attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    assert.ok(
      acceptedStatuses.includes(response.status),
      `${method} ${diagnosticPath} returned ${response.status}; expected ${acceptedStatuses.join(' or ')}.`
    );
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      origin,
      `${method} ${diagnosticPath} did not return the expected CORS origin.`
    );
    assert.match(
      response.headers.get('cache-control') || '',
      /^no-store(?:,|$)/,
      `${method} ${diagnosticPath} must not be cached.`
    );
    return { payload, status: response.status };
  }
  throw lastError || new Error(`${method} ${diagnosticPath} failed.`);
}

export function assertBetaBootstrap(payload) {
  assert.equal(payload?.flags?.consumerJourneyEnabled, true, 'Consumer journey is not live.');
  assert.equal(payload?.flags?.consumerAiIntakeEnabled, false, 'AI must remain disabled.');
  assert.equal(payload?.flags?.consumerModuleRoutingEnabled, true, 'Rules-only routing is not live.');
  assert.equal(payload?.flags?.consumerHumanHandoffEnabled, false, 'Handoff must remain disabled.');
  assert.equal(payload?.access?.publicAccessEnabled, false, 'Public access must remain disabled.');
  assert.equal(payload?.access?.inviteRequired, true, 'Signed invites must remain required.');
  assert.equal(payload?.cohort, 'adviser_test', 'The live cohort must be adviser_test.');
  assert.deepEqual(
    [...(payload?.allowedModules || [])].sort(),
    ['house_purchase', 'liquidity_analysis'],
    'The live module allowlist changed.'
  );
  for (const value of [
    payload?.consentPolicyVersion,
    payload?.consentManifestId,
    payload?.analysisNoticeId,
    payload?.ai?.noticeId,
    payload?.privacyNoticeUrl
  ]) {
    assert.ok(typeof value === 'string' && value.length > 0, 'The live disclosure contract is incomplete.');
  }
}

async function main() {
  const workerBaseUrl = String(process.env.WORKER_BASE_URL || '').trim().replace(/\/+$/, '');
  const smokeOrigin = String(process.env.SMOKE_ORIGIN || '').trim();
  const password = String(process.env.ADVISOR_SMOKE_PASSWORD || '').trim();
  const workerUrl = new URL(workerBaseUrl);
  const smokeOriginUrl = new URL(smokeOrigin);
  assert.equal(workerUrl.protocol, 'https:', 'WORKER_BASE_URL must use HTTPS.');
  assert.equal(workerUrl.origin, workerBaseUrl, 'WORKER_BASE_URL must be an origin without a path.');
  assert.equal(smokeOriginUrl.protocol, 'https:', 'SMOKE_ORIGIN must use HTTPS.');
  assert.equal(smokeOriginUrl.origin, smokeOrigin, 'SMOKE_ORIGIN must be an origin without a path.');
  assert.ok(
    ['planeir.ie', 'www.planeir.ie'].includes(smokeOriginUrl.hostname),
    'SMOKE_ORIGIN must be a Planéir production origin.'
  );
  assert.ok(password, 'ADVISOR_SMOKE_PASSWORD is required for the authenticated bridge smoke.');

  const cookieJar = new CookieJar();
  const session = await requestJson(workerBaseUrl, '/api/auth/session', {
    origin: smokeOrigin,
    cookieJar
  });
  assert.equal(session.payload?.authEnabled, true, 'Adviser authentication must be enabled for the private beta.');

  const login = await requestJson(workerBaseUrl, '/api/auth/login', {
    method: 'POST',
    origin: smokeOrigin,
    cookieJar,
    body: { password }
  });
  assert.equal(login.payload?.authenticated, true, 'Adviser smoke login did not authenticate.');
  const csrfToken = String(login.payload?.csrfToken || '');
  assert.match(csrfToken, /^[A-Za-z0-9_-]{32,}$/, 'Adviser smoke login did not return a valid CSRF token.');

  const inviteResult = await requestJson(workerBaseUrl, '/api/advisor/consumer-invite', {
    method: 'POST',
    origin: smokeOrigin,
    cookieJar,
    headers: { 'X-Advisor-CSRF': csrfToken }
  });
  assert.equal(inviteResult.payload?.ok, true, 'The adviser bridge did not issue a planning invite.');
  assert.equal(inviteResult.payload?.maxUses, 1, 'The adviser bridge invite must be one-use.');
  assert.equal(inviteResult.payload?.mode, 'rules_only', 'The adviser bridge must remain rules-only.');
  const inviteUrl = new URL(String(inviteResult.payload?.url || ''));
  assert.equal(inviteUrl.origin, 'https://planeir.ie', 'The adviser bridge returned an unapproved site origin.');
  assert.equal(inviteUrl.pathname, '/plan/', 'The adviser bridge returned an unapproved path.');
  assert.equal(inviteUrl.search, '', 'The planning invite must not be placed in the query string.');
  const inviteToken = new URLSearchParams(inviteUrl.hash.slice(1)).get('invite') || '';
  assert.match(inviteToken, /^ci1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'The private invite token is malformed.');
  const expiresAt = Date.parse(String(inviteResult.payload?.expiresAt || ''));
  assert.ok(Number.isFinite(expiresAt) && expiresAt > Date.now(), 'The private invite is already expired.');
  assert.ok(expiresAt <= Date.now() + (4 * 60 * 60 * 1000) + 60_000, 'The private invite exceeds the four-hour maximum.');

  const bootstrap = (await requestJson(workerBaseUrl, '/api/consumer/bootstrap', {
    origin: smokeOrigin
  })).payload;
  assertBetaBootstrap(bootstrap);

  const credential = buildProposedCredential();
  const sessionId = credential.slice(0, credential.indexOf('.'));
  let creationAttempted = false;
  let primaryError = null;
  let cleanupError = null;
  try {
    creationAttempted = true;
    const created = await requestJson(workerBaseUrl, '/api/consumer/sessions', {
      method: 'POST',
      origin: smokeOrigin,
      headers: {
        'X-Consumer-Invite': inviteToken,
        'X-Consumer-Session': credential
      },
      body: {
        consent: {
          analysis: true,
          aiProcessing: false,
          adultConfirmed: true,
          educationOnlyAcknowledged: true,
          manifestId: bootstrap.consentManifestId,
          policyVersion: bootstrap.consentPolicyVersion,
          analysisNoticeId: bootstrap.analysisNoticeId,
          aiNoticeId: bootstrap.ai.noticeId,
          privacyNoticeUrl: bootstrap.privacyNoticeUrl
        }
      },
      acceptedStatuses: [200, 201]
    });
    assert.equal(created.payload?.session?.id, sessionId, 'The bridge session ID changed unexpectedly.');
    assert.equal(created.payload?.credential, credential, 'The bridge session credential changed unexpectedly.');
    assert.equal(created.payload?.session?.aiProcessingConsented, false, 'The bridge smoke must remain rules-only.');
    assert.equal(created.payload?.session?.consent?.aiProcessing, false, 'The bridge smoke must decline AI processing.');
  } catch (error) {
    primaryError = error;
  } finally {
    if (creationAttempted) {
      try {
        const deleted = await requestJson(workerBaseUrl, `/api/consumer/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          origin: smokeOrigin,
          headers: { 'X-Consumer-Session': credential },
          acceptedStatuses: [200, 404],
          retryOnServerError: true,
          diagnosticPath: '/api/consumer/sessions/[synthetic]'
        });
        if (deleted.status === 200) {
          assert.equal(deleted.payload?.ok, true, 'Synthetic bridge-session deletion was not acknowledged.');
        }
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  if (primaryError && cleanupError) {
    throw new Error(
      `Bridge smoke failed (${primaryError instanceof Error ? primaryError.message : String(primaryError)}); `
      + `synthetic-session cleanup also failed (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}).`
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  console.log('Authenticated adviser-to-consumer bridge smoke passed; the synthetic session was deleted.');
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
