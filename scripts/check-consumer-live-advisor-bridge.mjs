import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runRealtimeInfrastructureProof } from './run-consumer-realtime-infrastructure-proof.mjs';
import { APPROVED_CONSUMER_MODULE_IDS } from '../worker/src/consumer/config.js';

const MAX_ATTEMPTS = 5;
const MAX_INVITE_PROPAGATION_ATTEMPTS = 12;
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

export function paidVoiceProviderSmokeEnabled(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'false') return false;
  if (normalized === 'true') return true;
  throw new Error('RUN_PAID_VOICE_PROVIDER_SMOKE must be exactly true or false.');
}

export function paidRealtimeInfrastructureProofEnabled(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'false') return false;
  if (normalized === 'true') return true;
  throw new Error('RUN_PAID_REALTIME_INFRASTRUCTURE_PROOF must be exactly true or false.');
}

/**
 * The consumer's own view of its allowance: whether it has one, never how big.
 *
 * The Worker used to send limit/spent/remaining to the browser, and to echo them
 * in x-voice-* response headers. Both are gone deliberately -- a person on a
 * planning call must never be shown what their call costs -- so the only thing
 * left to assert on a consumer surface is availability. Asserting the absence is
 * the point: if a figure ever comes back, this fails.
 */
export function assertConsumerSeesNoFigures(value, label) {
  assert.ok(value && typeof value === 'object', `${label} must report availability.`);
  assert.equal(value.available, true, `${label} must be available for a fresh smoke session.`);
  assert.equal(value.status, 'available', `${label} must report an available status.`);
  for (const field of ['limitMicroEur', 'spentMicroEur', 'remainingMicroEur', 'limitEurMicros']) {
    assert.equal(value[field], undefined, `${label} must not expose ${field} to the consumer.`);
  }
}

/**
 * The session ledger charged what it should have, and still holds its ceiling.
 *
 * The figures come from the protected envelope, never from a consumer response,
 * so verifying the ledger costs the consumer no visibility into the money.
 */
export function assertLedgerAccrued(session, expectedSpentMicroEur, limitMicroEur) {
  assert.equal(session?.providerCostLimitMicroEur, limitMicroEur,
    'The paid smoke session provider ceiling changed unexpectedly.');
  assert.equal(session?.spentMicroEur, expectedSpentMicroEur,
    'The paid smoke reservation total changed unexpectedly.');
}

/**
 * The ceiling the live session actually received, read privately.
 *
 * Verified against the session row rather than the config, because the row is
 * written at creation and a bug there is exactly what this smoke check is for.
 * Served only to a caller holding the deploy verification credential.
 */
export async function readLiveSessionCeiling(workerBaseUrl, origin, sessionId) {
  const key = String(process.env.CONSUMER_DEPLOY_VERIFICATION_KEY || '').trim();
  assert.ok(key.length >= 32, 'CONSUMER_DEPLOY_VERIFICATION_KEY is required to read the live ceiling.');
  const url = `${workerBaseUrl}/api/consumer/deployment-envelope`
    + `?session=${encodeURIComponent(sessionId)}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: origin,
      'x-planeir-deploy-verification': key
    }
  });
  const text = await response.text();
  assert.equal(response.status, 200, `The protected envelope returned ${response.status}: ${text}`);
  return JSON.parse(text).session;
}

export function buildProposedCredential() {
  return `cs_${randomBase64Url(18)}.${randomBase64Url(32)}`;
}

function assertLiveResponse(response, origin, method, diagnosticPath) {
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
    assertLiveResponse(response, origin, method, diagnosticPath);
    return { payload, status: response.status };
  }
  throw lastError || new Error(`${method} ${diagnosticPath} failed.`);
}

async function requestBinaryOnce(baseUrl, pathname, {
  method = 'POST',
  origin,
  headers = {},
  body,
  cookieJar,
  diagnosticPath = pathname
} = {}) {
  const requestHeaders = cookieJar
    ? cookieJar.apply({ Origin: origin, Accept: 'audio/mpeg', ...headers })
    : new Headers({ Origin: origin, Accept: 'audio/mpeg', ...headers });
  requestHeaders.set('Content-Type', 'application/json');
  const response = await fetch(new URL(pathname, `${baseUrl}/`), {
    method,
    headers: requestHeaders,
    body: JSON.stringify(body)
  });
  cookieJar?.capture(response.headers);
  const bytes = await response.arrayBuffer();
  assert.equal(response.status, 200, `${method} ${diagnosticPath} returned ${response.status}; expected 200.`);
  assertLiveResponse(response, origin, method, diagnosticPath);
  return { bytes, headers: response.headers };
}

async function requestRawAudioJsonOnce(baseUrl, pathname, {
  origin,
  headers = {},
  audio,
  contentType,
  durationMs,
  idempotencyKey,
  cookieJar,
  diagnosticPath = pathname
} = {}) {
  const method = 'POST';
  const requestHeaders = cookieJar
    ? cookieJar.apply({ Origin: origin, Accept: 'application/json', ...headers })
    : new Headers({ Origin: origin, Accept: 'application/json', ...headers });
  requestHeaders.set('Content-Type', contentType);
  requestHeaders.set('X-Voice-Duration-Ms', String(durationMs));
  requestHeaders.set('X-Voice-Request-Id', idempotencyKey);
  const response = await fetch(new URL(pathname, `${baseUrl}/`), {
    method,
    headers: requestHeaders,
    body: audio
  });
  cookieJar?.capture(response.headers);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    throw new Error(`${method} ${diagnosticPath} returned invalid JSON.`);
  }
  assert.equal(response.status, 200, `${method} ${diagnosticPath} returned ${response.status}; expected 200.`);
  assertLiveResponse(response, origin, method, diagnosticPath);
  return payload;
}

export function assertBetaBootstrap(payload, {
  realtimeExpected = false,
  expectedVoiceNoticeId = String(process.env.CONSUMER_BETA_VOICE_NOTICE_ID || '').trim()
} = {}) {
  assert.equal(payload?.flags?.consumerJourneyEnabled, true, 'Consumer journey is not live.');
  assert.equal(payload?.flags?.consumerAiIntakeEnabled, false, 'AI must remain disabled.');
  assert.equal(payload?.flags?.consumerVoiceEnabled, true, 'Reviewed voice transport is not live.');
  assert.equal(payload?.flags?.consumerModuleRoutingEnabled, true, 'Rules-only routing is not live.');
  assert.equal(payload?.flags?.consumerHumanHandoffEnabled, false, 'Human handoff must remain disabled.');
  assert.equal(payload?.access?.publicAccessEnabled, false, 'Public access must remain disabled.');
  assert.equal(payload?.access?.inviteRequired, true, 'Signed invites must remain required.');
  assert.equal(payload?.cohort, 'adviser_test', 'The live cohort must be adviser_test.');
  assert.deepEqual(
    [...(payload?.allowedModules || [])].sort(),
    [...APPROVED_CONSUMER_MODULE_IDS].sort(),
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
  assert.equal(payload?.voice?.enabled, true, 'Voice is not configured in the protected bootstrap.');
  // Read from the protected environment, never restated here. This assertion
  // held 'voice-adviser-test-v1' long after the deployment moved to the
  // OpenAI-audio notice, so it failed a Worker that was correctly disclosing
  // MORE than the notice it was compared against. The notice id is also the
  // consent key -- voice_repository rejects a stored acknowledgement whose
  // notice_id differs from the running config -- so changing it forces every
  // caller to re-consent, and a check that pins the old one is checking that
  // re-consent never happened.
  assert.ok(expectedVoiceNoticeId, 'CONSUMER_BETA_VOICE_NOTICE_ID is required to verify the live notice.');
  assert.equal(payload?.voice?.noticeId, expectedVoiceNoticeId, 'The voice notice changed unexpectedly.');
  assert.equal(payload?.voice?.dataPolicyId, 'openai-audio-adviser-test-v1', 'The voice data policy changed unexpectedly.');
  assert.equal(payload?.voice?.transcriptionModel, 'gpt-4o-mini-transcribe', 'The transcription model changed unexpectedly.');
  assert.equal(payload?.voice?.speechModel, 'tts-1-hd', 'The speech model changed unexpectedly.');
  assert.equal(payload?.voice?.voice, 'nova', 'The reviewed voice changed unexpectedly.');
  assert.equal(payload?.voice?.pricingVersion, 'openai-audio-eur-safety-2026-07-13-v2', 'The voice pricing catalogue changed unexpectedly.');
  // The spend ceilings are deliberately absent from this payload. They are
  // verified on every deploy against the protected deployment-envelope route,
  // which is the only place they are served.
  assert.equal(payload?.voice?.sessionBudgetMicroEur, undefined,
    'The public bootstrap must not expose the voice spend ceiling.');
  assert.ok(typeof payload?.voice?.privacyNoticeUrl === 'string' && payload.voice.privacyNoticeUrl.length > 0);
  assert.ok(typeof payload?.voice?.policyVersion === 'string' && payload.voice.policyVersion.length > 0);
  assert.equal(
    payload?.flags?.consumerRealtimeVoiceEnabled === true,
    realtimeExpected,
    'The realtime voice flag does not match the protected canary mode.'
  );
  if (realtimeExpected) {
    assert.equal(payload?.realtimeVoice?.enabled, true, 'Realtime voice is not configured.');
    assert.equal(payload?.realtimeVoice?.model, 'gpt-realtime-2.1', 'The realtime model changed unexpectedly.');
    assert.equal(payload?.realtimeVoice?.voice, 'marin', 'The realtime voice changed unexpectedly.');
    assert.equal(payload?.realtimeVoice?.reasoningEffort, 'low', 'The default realtime reasoning effort changed unexpectedly.');
    assert.equal(payload?.realtimeVoice?.transcriptionModel, 'gpt-4o-mini-transcribe', 'The realtime transcription model changed unexpectedly.');
    assert.equal(
      payload?.realtimeVoice?.pricingVersion,
      'openai-gpt-realtime-2.1-usd-parity-eur-safety-2026-07-14-v1',
      'The realtime pricing catalogue changed unexpectedly.'
    );
    assert.equal(payload?.realtimeVoice?.maxDurationSeconds, 900, 'The realtime duration limit changed unexpectedly.');
    assert.equal(payload?.realtimeVoice?.idleTimeoutSeconds, 180, 'The realtime idle timeout changed unexpectedly.');
    for (const field of ['sessionBudgetMicroEur', 'dispatchStopMicroEur', 'safetyReserveMicroEur']) {
      assert.equal(payload?.realtimeVoice?.[field], undefined,
        `The public bootstrap must not expose realtimeVoice.${field}.`);
    }
    assert.equal(payload?.handoff?.enabled, false, 'Human handoff must remain disabled for the voice-only canary.');
    assert.equal(payload?.handoff?.policyVersion, null, 'Disabled handoff must expose no policy.');
    assert.equal(payload?.handoff?.policyUrl, null, 'Disabled handoff must expose no policy URL.');
    assert.equal(payload?.handoff?.retentionPolicyId, null, 'Disabled handoff must expose no retention policy.');
    assert.equal(payload?.handoff?.packageRetentionDays, null, 'Disabled handoff must expose no retention period.');
  } else {
    assert.equal(payload?.realtimeVoice?.enabled === true, false, 'Realtime voice must fail closed outside its canary.');
    assert.equal(payload?.handoff?.enabled === true, false, 'Handoff must fail closed outside the realtime canary.');
  }
}

async function main() {
  const workerBaseUrl = String(process.env.WORKER_BASE_URL || '').trim().replace(/\/+$/, '');
  const smokeOrigin = String(process.env.SMOKE_ORIGIN || '').trim();
  const password = String(process.env.ADVISOR_SMOKE_PASSWORD || '').trim();
  const runPaidProviderSmoke = paidVoiceProviderSmokeEnabled(process.env.RUN_PAID_VOICE_PROVIDER_SMOKE);
  const runPaidRealtimeProof = paidRealtimeInfrastructureProofEnabled(
    process.env.RUN_PAID_REALTIME_INFRASTRUCTURE_PROOF
  );
  const realtimeExpected = String(process.env.CONSUMER_REALTIME_ADVISER_CANARY_ENABLED || '').trim() === 'true';
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
  const realtimeStandingPreserved = String(
    process.env.CONSUMER_REALTIME_STANDING_PRESERVED || ''
  ).trim() === 'true';
  if (realtimeStandingPreserved) {
    // A push carrying standing approval preserves an already proof-activated
    // canary: Realtime stays enabled and the paid proof is deliberately not
    // re-run. First activation still couples both flags below.
    assert.equal(realtimeExpected, true, 'Standing preservation requires the Realtime canary to remain enabled.');
    assert.equal(runPaidRealtimeProof, false, 'A standing-preservation push must not re-run the paid infrastructure proof.');
  } else {
    assert.equal(
      runPaidRealtimeProof,
      realtimeExpected,
      'Realtime activation and its paid infrastructure proof must be enabled together.'
    );
  }

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

  const expectedInviteMode = realtimeExpected ? 'realtime_voice_rules_only' : 'voice_assisted_rules_only';
  let inviteResult = null;
  for (let attempt = 1; attempt <= MAX_INVITE_PROPAGATION_ATTEMPTS; attempt += 1) {
    inviteResult = await requestJson(workerBaseUrl, '/api/advisor/consumer-invite', {
      method: 'POST',
      origin: smokeOrigin,
      cookieJar,
      headers: { 'X-Advisor-CSRF': csrfToken }
    });
    if (inviteResult.payload?.mode === expectedInviteMode) break;
    if (attempt < MAX_INVITE_PROPAGATION_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  assert.equal(inviteResult.payload?.ok, true, 'The adviser bridge did not issue a planning invite.');
  assert.equal(inviteResult.payload?.maxUses, 1, 'The adviser bridge invite must be one-use.');
  assert.equal(
    inviteResult.payload?.mode,
    expectedInviteMode,
    'The adviser bridge returned an unexpected consumer mode.'
  );
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
  assertBetaBootstrap(bootstrap, { realtimeExpected });

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

    const consentPayload = {
      noticeId: bootstrap.voice.noticeId,
      policyVersion: bootstrap.voice.policyVersion,
      privacyNoticeUrl: bootstrap.voice.privacyNoticeUrl
    };
    const voiceGranted = await requestJson(
      workerBaseUrl,
      `/api/consumer/sessions/${encodeURIComponent(sessionId)}/voice/consent`,
      {
        method: 'PATCH',
        origin: smokeOrigin,
        headers: { 'X-Consumer-Session': credential },
        body: { granted: true, ...consentPayload },
        diagnosticPath: '/api/consumer/sessions/[synthetic]/voice/consent'
      }
    );
    assert.equal(voiceGranted.payload?.voiceConsent?.granted, true, 'Voice consent could not be granted.');
    assertConsumerSeesNoFigures(voiceGranted.payload?.voiceAvailability, 'The voice allowance');
    const liveCeiling = await readLiveSessionCeiling(workerBaseUrl, smokeOrigin, sessionId);
    assert.equal(
      liveCeiling?.providerCostLimitMicroEur,
      realtimeExpected ? 10_000_000 : 2_000_000,
      'The live session does not have the expected provider ceiling.'
    );
    assert.equal(liveCeiling?.spentMicroEur, 0, 'A new smoke session unexpectedly has provider spend.');

    let realtimeConsentPayload = null;
    if (runPaidRealtimeProof) {
      realtimeConsentPayload = {
        noticeId: bootstrap.realtimeVoice.noticeId,
        policyVersion: bootstrap.realtimeVoice.policyVersion,
        privacyNoticeUrl: bootstrap.realtimeVoice.privacyNoticeUrl
      };
      const realtimeGranted = await requestJson(
        workerBaseUrl,
        `/api/consumer/sessions/${encodeURIComponent(sessionId)}/voice/realtime/consent`,
        {
          method: 'PATCH',
          origin: smokeOrigin,
          headers: { 'X-Consumer-Session': credential },
          body: { granted: true, ...realtimeConsentPayload },
          diagnosticPath: '/api/consumer/sessions/[synthetic]/voice/realtime/consent'
        }
      );
      assert.equal(realtimeGranted.payload?.realtimeConsent?.granted, true, 'Realtime consent could not be granted.');
      assertConsumerSeesNoFigures(
        realtimeGranted.payload?.realtimeVoiceAvailability, 'The realtime allowance'
      );
      assert.equal(
        (await readLiveSessionCeiling(workerBaseUrl, smokeOrigin, sessionId))?.providerCostLimitMicroEur,
        10_000_000,
        'The Realtime proof does not have the €10 adviser-demo application allowance.'
      );
      const proof = await runRealtimeInfrastructureProof({
        workerBaseUrl,
        smokeOrigin,
        sessionId,
        credential
      });
      // Shared by every lane: the entry point, the transport and the hang-up.
      assert.equal(proof.launcherVisible, true, 'The production Talk to Planéir launcher was not proven.');
      assert.equal(proof.companionStartWired, true, 'The production Start voice control was not proven.');
      assert.equal(proof.webRtcConnected, true, 'The production WebRTC connection was not proven.');
      assert.equal(proof.sidebandConnected, true, 'The production sideband connection was not proven.');
      // Lane-specific, because the lanes genuinely put different things on the
      // wire. Each branch asserts its own lane's evidence and nothing else, so
      // a lane can never be certified by another lane's proof.
      if (proof.conversationVersion === 'live') {
        assert.equal(proof.liveLaneActivated, true, 'The production live conversation lane was not proven to activate.');
        assert.equal(proof.liveTransportConnected, true, 'The production live WebRTC transport was not proven to connect.');
        assert.equal(proof.directProviderAudioAttached, true, 'The production direct live audio stream was not proven.');
        assert.equal(
          proof.promptVersion,
          'planeir-live-conversation-v7',
          'The production live meeting did not run the pinned live prompt.'
        );
        assert.equal(
          proof.toolsetVersion,
          'planeir-live-tools-v1',
          'The production live meeting did not run the pinned live tool surface.'
        );
        assert.equal(
          proof.readOnlyToolSucceeded,
          false,
          'A production live meeting ran the v2 read-only tool, so the lanes are crossed.'
        );
        assert.equal(
          proof.controlledSpeechObserved,
          false,
          'A production live meeting produced v1 Worker-composed speech, so the lanes are crossed.'
        );
      } else if (proof.conversationVersion === 'v2') {
        assert.equal(proof.audibleGreetingObserved, true, 'The production companion greeting was not proven.');
        assert.equal(proof.directProviderAudioAttached, true, 'The production direct Marin audio stream was not proven.');
        assert.equal(proof.initialWelcomeSucceeded, true, 'The production server-authorized Marin welcome was not proven.');
      } else {
        assert.equal(proof.audibleGreetingObserved, true, 'The production companion greeting was not proven.');
        assert.equal(proof.readOnlyToolSucceeded, true, 'The production read-only planning tool was not proven.');
      }
      assert.equal(proof.providerHangupConfirmed, true, 'The production provider hang-up was not proven.');
    }

    if (runPaidProviderSmoke) {
      const speechResult = await requestBinaryOnce(
        workerBaseUrl,
        `/api/consumer/sessions/${encodeURIComponent(sessionId)}/voice/speech`,
        {
          origin: smokeOrigin,
          headers: { 'X-Consumer-Session': credential },
          body: { idempotencyKey: `voice-smoke-speech-${randomBase64Url(12)}` },
          diagnosticPath: '/api/consumer/sessions/[synthetic]/voice/speech'
        }
      );
      assert.match(
        String(speechResult.headers.get('content-type') || '').toLowerCase(),
        /^audio\/mpeg(?:;|$)/,
        'The paid speech smoke did not return MP3 audio.'
      );
      assert.ok(speechResult.bytes.byteLength > 0, 'The paid speech smoke returned no audio.');
      assert.ok(speechResult.bytes.byteLength <= 1_000_000, 'The paid speech smoke audio is too large for the bounded transcription route.');
      // Spend must actually accrue against the session ledger. Read from the
      // protected route: the speech response is audio, and the x-voice-* budget
      // headers it used to carry were removed so a browser could not read them.
      assertLedgerAccrued(
        await readLiveSessionCeiling(workerBaseUrl, smokeOrigin, sessionId),
        100_000,
        realtimeExpected ? 10_000_000 : 2_000_000
      );

      const transcription = await requestRawAudioJsonOnce(
        workerBaseUrl,
        `/api/consumer/sessions/${encodeURIComponent(sessionId)}/voice/transcriptions`,
        {
          origin: smokeOrigin,
          headers: { 'X-Consumer-Session': credential },
          audio: speechResult.bytes,
          contentType: 'audio/mpeg',
          durationMs: 15_000,
          idempotencyKey: `voice-smoke-transcription-${randomBase64Url(12)}`,
          diagnosticPath: '/api/consumer/sessions/[synthetic]/voice/transcriptions'
        }
      );
      assert.ok(
        typeof transcription?.transcript === 'string' && transcription.transcript.trim().length > 0,
        'The paid transcription smoke returned no reviewable transcript.'
      );
      assertConsumerSeesNoFigures(transcription.voiceAvailability, 'The transcription allowance');
      assertLedgerAccrued(
        await readLiveSessionCeiling(workerBaseUrl, smokeOrigin, sessionId),
        200_000,
        realtimeExpected ? 10_000_000 : 2_000_000
      );
    }

    if (realtimeConsentPayload) {
      const realtimeWithdrawn = await requestJson(
        workerBaseUrl,
        `/api/consumer/sessions/${encodeURIComponent(sessionId)}/voice/realtime/consent`,
        {
          method: 'PATCH',
          origin: smokeOrigin,
          headers: { 'X-Consumer-Session': credential },
          body: { granted: false, ...realtimeConsentPayload },
          diagnosticPath: '/api/consumer/sessions/[synthetic]/voice/realtime/consent'
        }
      );
      assert.equal(realtimeWithdrawn.payload?.realtimeConsent?.granted, false, 'Realtime consent could not be withdrawn.');
    }

    const voiceWithdrawn = await requestJson(
      workerBaseUrl,
      `/api/consumer/sessions/${encodeURIComponent(sessionId)}/voice/consent`,
      {
        method: 'PATCH',
        origin: smokeOrigin,
        headers: { 'X-Consumer-Session': credential },
        body: { granted: false, ...consentPayload },
        diagnosticPath: '/api/consumer/sessions/[synthetic]/voice/consent'
      }
    );
    assert.equal(voiceWithdrawn.payload?.voiceConsent?.granted, false, 'Voice consent could not be withdrawn.');
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
  console.log(
    runPaidRealtimeProof
      ? 'Authenticated adviser bridge and paid Realtime SDP, sideband-tool, and server-hangup proof passed; the synthetic session was deleted.'
      : runPaidProviderSmoke
        ? 'Authenticated adviser bridge and paid TTS-to-transcription round trip passed; the synthetic session was deleted.'
        : 'Authenticated adviser-to-consumer voice-consent bridge smoke passed without provider spend; the synthetic session was deleted.'
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
