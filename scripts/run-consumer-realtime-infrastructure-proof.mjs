import assert from 'node:assert/strict';

import { LIVE_PROMPT_VERSION } from '../worker/src/consumer/live/catalogue_prompt.js';
import { LIVE_TOOLSET_VERSION } from '../worker/src/consumer/live/live_tools.js';

const PROOF_TIMEOUT_MS = 45_000;
const PROPAGATION_RETRY_MS = 12_000;
const MAX_PROPAGATION_ATTEMPTS = 5;
const MAX_BOOTSTRAP_PROPAGATION_ATTEMPTS = 10;
// The live lane's WebRTC negotiation, measured from the SDP answer. Separate
// from PROOF_TIMEOUT_MS because it is a transport wait, not a provider wait.
const LIVE_TRANSPORT_TIMEOUT_MS = 30_000;
// How long the live lane is watched for model speech. This is an OBSERVATION,
// not a gate — see LANE_PROOFS.live.assistantSpeechIsProof.
const LIVE_SPEECH_OBSERVATION_MS = 6_000;

/** The prompt and toolset the non-live lanes are pinned to (router.js). */
const CONTROLLED_PROMPT_VERSION = 'consumer-realtime-orchestrator-v9';
const CONTROLLED_TOOLSET_VERSION = 'consumer-realtime-tools-v7';

/**
 * WHAT EACH LANE HAS TO PROVE, AND WHY THEY DIFFER.
 *
 * The three lanes are not three configurations of one flow. They put different
 * things on the wire, so a proof written for one is silently vacuous against
 * another — which is exactly how Deploy Worker run #295 failed: `live` was
 * folded into `v1` by a `=== 'v2' ? 'v2' : 'v1'` expression, and the proof
 * then sat waiting 45 seconds for a `POST .../speech` that only the v1 lane
 * has ever sent.
 *
 * So the lane is data, and every lane-shaped decision below reads it from
 * here. Adding a fourth lane means adding a row; it can never mean falling
 * back to someone else's proof.
 */
export const LANE_PROOFS = Object.freeze({
  v1: Object.freeze({
    lane: 'v1',
    promptVersion: CONTROLLED_PROMPT_VERSION,
    toolsetVersion: CONTROLLED_TOOLSET_VERSION,
    // Worker-composed TTS, fetched over `POST .../speech` and played from a
    // blob. Nothing else produces that request.
    expectsControlledSpeech: true,
    expectsDirectProviderAudio: false,
    expectsMicBadge: true,
    // Server-composed copy, so the wording is the Worker's and can be asserted.
    assistantSpeechIsProof: true,
    expectsLiveTransportState: false,
    transcriptToggleIsWired: true,
    requiredControlPlaneFields: Object.freeze(['sidebandConnected', 'readOnlyToolSucceeded'])
  }),
  v2: Object.freeze({
    lane: 'v2',
    promptVersion: CONTROLLED_PROMPT_VERSION,
    toolsetVersion: CONTROLLED_TOOLSET_VERSION,
    expectsControlledSpeech: false,
    expectsDirectProviderAudio: true,
    expectsMicBadge: true,
    // The welcome is server-authorized, so it is guaranteed to arrive.
    assistantSpeechIsProof: true,
    expectsLiveTransportState: false,
    transcriptToggleIsWired: true,
    requiredControlPlaneFields: Object.freeze(['sidebandConnected', 'initialWelcomeSucceeded'])
  }),
  live: Object.freeze({
    lane: 'live',
    promptVersion: LIVE_PROMPT_VERSION,
    toolsetVersion: LIVE_TOOLSET_VERSION,
    expectsControlledSpeech: false,
    expectsDirectProviderAudio: true,
    // `realtimeMicBadge` is driven by the v2 controller's state machine.
    // live_voice.js has none: the microphone is live from the moment the
    // answer is applied, and the badge is never touched.
    expectsMicBadge: false,
    // THE ONE THING THIS LANE CANNOT PROMISE. live_provider.js sets
    // `create_response: true` and live_session.js deliberately sends no
    // `response.create` — the provider replies when the CLIENT stops speaking.
    // The proof drives a fake microphone that says nothing, so requiring model
    // speech here would be a coin toss dressed up as a gate. What replaces it
    // is stricter, not looser: the lane's own activation and sideband events,
    // the negotiated peer connection, and the prompt/toolset pinned on the
    // lease the meeting actually ran under.
    assistantSpeechIsProof: false,
    expectsLiveTransportState: true,
    // The live adapter binds the launcher, collapse and backdrop only; the
    // transcript toggle belongs to the v2 controller. Clicking it here does
    // nothing, so the transcript is read from the DOM instead.
    transcriptToggleIsWired: false,
    requiredControlPlaneFields: Object.freeze(['liveCallActivated', 'liveSidebandConnected'])
  })
});

/**
 * The lane this deployment announced — or a refusal to proceed.
 *
 * FAIL CLOSED. There is no default and no nearest match. An unrecognised
 * conversation version means a lane exists that nothing here knows how to
 * verify, and a proof that cannot verify the running lane must stop the
 * activation rather than certify someone else's behaviour.
 */
export function resolveConversationVersion(bootstrapPayload) {
  const announced = bootstrapPayload?.realtimeVoice?.conversationVersion;
  const version = typeof announced === 'string' ? announced.trim() : '';
  if (!Object.hasOwn(LANE_PROOFS, version)) {
    throw new Error(
      `The live deployment announced conversation version ${JSON.stringify(version || null)}, `
      + `which this activation proof cannot verify. Known lanes: ${Object.keys(LANE_PROOFS).join(', ')}. `
      + 'Add a lane proof before activating it.'
    );
  }
  return version;
}

/** The proof plan for a resolved lane. Unknown lanes never get one. */
export function laneProofPlan(conversationVersion) {
  const plan = LANE_PROOFS[conversationVersion];
  if (!plan) {
    throw new Error(`No activation proof is defined for conversation version ${JSON.stringify(conversationVersion)}.`);
  }
  return plan;
}

/**
 * The server-side gate, as a function so it can be tested without a browser,
 * a provider or ten euro of meeting.
 */
export function assertControlPlaneProvesLane(proof, conversationVersion) {
  const plan = laneProofPlan(conversationVersion);
  if (conversationVersion === 'live') {
    assert.equal(proof.liveCallActivated, true, 'The live conversation lane never activated its meeting.');
    assert.equal(proof.liveSidebandConnected, true, 'The live provider sideband was not proven.');
    // The live tool surface is save_facts/get_state/confirm_and_run. If the
    // v2 lane's read-only tool had somehow run, this meeting was not the lane
    // it claimed to be.
    assert.equal(
      proof.readOnlyToolSucceeded,
      false,
      'A live meeting ran the v2 lane\'s get_planning_state tool, so the lanes are crossed.'
    );
  } else {
    assert.equal(proof.sidebandConnected, true, 'The authenticated provider sideband was not proven.');
    if (conversationVersion === 'v2') {
      assert.equal(proof.initialWelcomeSucceeded, true, 'The server-authorized Marin welcome did not complete.');
    } else {
      assert.equal(proof.readOnlyToolSucceeded, true, 'The forced get_planning_state tool did not succeed.');
    }
  }
  return plan;
}

/**
 * The lane-consistency gate on the finished result.
 *
 * Separate from the per-step assertions on purpose: those prove the milestones
 * happened, this proves they were the RIGHT lane's milestones. It is the check
 * that a `live` run silently satisfying the v1 evidence would fail.
 */
export function assertLaneProofResult(result) {
  const plan = laneProofPlan(result?.conversationVersion);
  assert.equal(
    result.sidebandConnected,
    true,
    `The ${plan.lane} lane's authenticated provider sideband was not proven.`
  );
  assert.equal(
    result.promptVersion,
    plan.promptVersion,
    `The ${plan.lane} meeting did not run the ${plan.promptVersion} prompt.`
  );
  assert.equal(
    result.toolsetVersion,
    plan.toolsetVersion,
    `The ${plan.lane} meeting did not run the ${plan.toolsetVersion} tool surface.`
  );
  // THE FALLBACK THAT CAUSED THIS. A live meeting missing its own activation
  // marker means the live branch never ran; a live meeting carrying v1
  // evidence means the two lanes are crossed.
  assert.equal(
    result.liveLaneActivated,
    plan.lane === 'live',
    'The live activation marker must be set for exactly the live lane.'
  );
  assert.equal(
    result.liveTransportConnected,
    plan.expectsLiveTransportState,
    'The live transport marker must be set for exactly the live lane.'
  );
  assert.equal(
    plan.lane === 'live' && result.readOnlyToolSucceeded,
    false,
    'The live lane must never be certified by the v1 read-only tool proof.'
  );
  assert.equal(
    plan.lane === 'live' && result.controlledSpeechObserved,
    false,
    'The live lane must never be certified by v1 Worker-composed speech.'
  );
  return result;
}
// Cloudflare rolls a fresh Worker version out isolate-by-isolate, so the free
// bootstrap flag must read enabled on several consecutive samples before the
// six-per-hour Start budget is spent on a rate-limited realtime call.
const REALTIME_FLAG_SETTLE_SAMPLES = 3;
const REALTIME_FLAG_SETTLE_INTERVAL_MS = 5_000;
const REALTIME_FLAG_SETTLE_MAX_ATTEMPTS = 30;

function requiredHttpsOrigin(value, label) {
  const parsed = new URL(String(value || ''));
  assert.equal(parsed.protocol, 'https:', `${label} must use HTTPS.`);
  assert.equal(parsed.origin, String(value || '').replace(/\/+$/, ''), `${label} must be an origin without a path.`);
  return parsed.origin;
}

/**
 * Runs only from a protected, manually dispatched production workflow. The
 * browser supplies a real WebRTC offer and a fake microphone track; the
 * authenticated Worker still owns provider creation, sideband tools, budget,
 * and hang-up. No OpenAI credential is exposed to this harness.
 */
export async function runRealtimeInfrastructureProof({
  workerBaseUrl,
  smokeOrigin,
  sessionId,
  credential
}) {
  const workerOrigin = requiredHttpsOrigin(workerBaseUrl, 'WORKER_BASE_URL');
  const siteOrigin = requiredHttpsOrigin(smokeOrigin, 'SMOKE_ORIGIN');
  assert.match(sessionId, /^cs_[A-Za-z0-9_-]{20,80}$/, 'The proof session ID is invalid.');
  assert.equal(credential.startsWith(`${sessionId}.`), true, 'The proof credential does not match its session.');

  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch (_error) {
    throw new Error('The protected Realtime proof requires the pinned playwright-core browser harness.');
  }

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream'
    ]
  });
  try {
    const context = await browser.newContext({ baseURL: siteOrigin });
    await context.grantPermissions(['microphone'], { origin: siteOrigin });

    // The page bootstrap can observe Realtime enabled while the calls route
    // still executes a stale pre-activation configuration on another isolate.
    // Settle the live flag across consecutive samples before any paid, rate
    // limited Start attempt.
    let consecutiveEnabledSamples = 0;
    let conversationVersion = '';
    let previousEnabledVersion = '';
    for (let attempt = 1; attempt <= REALTIME_FLAG_SETTLE_MAX_ATTEMPTS; attempt += 1) {
      let enabled = false;
      let payload = null;
      try {
        const response = await fetch(`${workerOrigin}/api/consumer/bootstrap`, {
          headers: { Origin: siteOrigin }
        });
        payload = response.ok ? await response.json() : null;
        enabled = payload?.flags?.consumerRealtimeVoiceEnabled === true;
      } catch (_error) {
        enabled = false;
        payload = null;
      }
      // Resolved OUTSIDE the transport guard, and only for a bootstrap that
      // reports Realtime enabled. A network failure costs one sample; a
      // deployment announcing a lane this proof cannot verify throws out of
      // the loop and stops the activation. Neither is ever defaulted to v1.
      const sampledVersion = enabled ? resolveConversationVersion(payload) : '';
      if (enabled) {
        consecutiveEnabledSamples = sampledVersion === previousEnabledVersion
          ? consecutiveEnabledSamples + 1
          : 1;
        previousEnabledVersion = sampledVersion;
        conversationVersion = sampledVersion;
      } else {
        consecutiveEnabledSamples = 0;
        previousEnabledVersion = '';
      }
      if (consecutiveEnabledSamples >= REALTIME_FLAG_SETTLE_SAMPLES) break;
      await new Promise((resolve) => setTimeout(resolve, REALTIME_FLAG_SETTLE_INTERVAL_MS));
    }
    assert.equal(
      consecutiveEnabledSamples >= REALTIME_FLAG_SETTLE_SAMPLES,
      true,
      'The live Realtime flag did not settle across consecutive bootstrap samples before the paid Start attempt.'
    );
    // Every lane-shaped decision from here reads this plan. Resolving it once,
    // before the first paid Start attempt, means an unverifiable lane costs
    // nothing and an unknown one has already thrown.
    const plan = laneProofPlan(conversationVersion);

    const page = await context.newPage();
    await page.addInitScript(({ sessionIdValue, credentialValue }) => {
      window.sessionStorage.setItem('planeir.consumer.session-id.v1', sessionIdValue);
      window.sessionStorage.setItem('planeir.consumer.credential.v1', credentialValue);
    }, { sessionIdValue: sessionId, credentialValue: credential });
    const proofPageUrl = new URL('/plan/', `${siteOrigin}/`);
    proofPageUrl.searchParams.set('realtime-proof', crypto.randomUUID());
    await page.goto(proofPageUrl.href, {
      waitUntil: 'domcontentloaded',
      timeout: PROOF_TIMEOUT_MS
    });
    const endpointPath = `/api/consumer/sessions/${encodeURIComponent(sessionId)}/voice/realtime/calls`;
    const requestDiagnostics = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith(endpointPath)) return;
      requestDiagnostics.push(`${response.request().method()} ${url.pathname.slice(endpointPath.length) || '/'} -> ${response.status()}`);
    });
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith(endpointPath)) return;
      requestDiagnostics.push(`${request.method()} ${url.pathname.slice(endpointPath.length) || '/'} -> ${request.failure()?.errorText || 'request failed'}`);
    });
    // An eligible session auto-opens the meeting surface and marks the
    // background launcher inert (which Playwright reports as hidden), so the
    // entry point is proven when either the meeting shell is open or the
    // collapsed launcher is actionable.
    const launcher = page.locator('#realtimeVoiceLauncher');
    const meetingEntryState = async () => page.evaluate(() => ({
      shellOpen: document.getElementById('realtimeVoiceShell')?.hidden === false,
      launcherShown: (() => {
        const element = document.getElementById('realtimeVoiceLauncher');
        return Boolean(element && element.closest('[hidden]') === null);
      })()
    }));
    let entry = { shellOpen: false, launcherShown: false };
    for (let attempt = 1; attempt <= MAX_BOOTSTRAP_PROPAGATION_ATTEMPTS; attempt += 1) {
      await page.waitForTimeout(PROPAGATION_RETRY_MS);
      entry = await meetingEntryState();
      if (entry.shellOpen || entry.launcherShown) break;
      if (attempt < MAX_BOOTSTRAP_PROPAGATION_ATTEMPTS) {
        proofPageUrl.searchParams.set('realtime-proof', crypto.randomUUID());
        await page.goto(proofPageUrl.href, {
          waitUntil: 'domcontentloaded',
          timeout: PROOF_TIMEOUT_MS
        });
      }
    }
    assert.equal(
      entry.shellOpen || entry.launcherShown,
      true,
      'Neither the auto-opened meeting shell nor the Talk to Planéir launcher became available.'
    );
    if (!entry.shellOpen) {
      await launcher.click();
    }
    await page.locator('#realtimeVoiceShell').waitFor({ state: 'visible', timeout: 5_000 });
    const start = page.locator('#realtimeVoiceStartButton');
    await start.waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForFunction(() => {
      const button = document.getElementById('realtimeVoiceStartButton');
      return button instanceof HTMLButtonElement && button.disabled === false;
    }, null, { timeout: PROOF_TIMEOUT_MS });

    // The redesigned meeting flow shows the concise disclosure on the first
    // Start press and connects automatically once it is accepted, so consent
    // acceptance is handled inside the start/retry loop below when the
    // dialog appears.
    const acceptConsentIfShown = async () => {
      const consentDialog = page.locator('#realtimeVoiceConsentDialog');
      const shown = await consentDialog.isVisible().catch(() => false);
      if (!shown) return false;
      await page.locator('#realtimeVoiceConsentAcknowledgement').check();
      const consentEndpointPath = `/api/consumer/sessions/${encodeURIComponent(sessionId)}/voice/realtime/consent`;
      const consentSavedPromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'PATCH' && url.pathname === consentEndpointPath;
      }, { timeout: PROOF_TIMEOUT_MS });
      await page.locator('#realtimeVoiceConsentForm button[type="submit"]').click();
      const consentSaved = await consentSavedPromise;
      assert.equal(consentSaved.status(), 200, 'The visible Realtime disclosure could not be accepted.');
      await consentDialog.waitFor({ state: 'hidden', timeout: 5_000 });
      return true;
    };

    let leaseId = '';
    let controlCapability = '';
    let controlPlaneProof = {};
    let leaseIdentity = { promptVersion: '', toolsetVersion: '' };
    let assistantSpeechObserved = false;
    try {
      // ARMED FOR THE v1 LANE ONLY. `POST .../speech` is Worker-composed TTS,
      // which exists in no other lane. Arming it for `live` is what turned a
      // healthy deployment into a 45-second timeout in run #295.
      const controlledSpeechPromise = plan.expectsControlledSpeech
        ? page.waitForResponse((response) => {
            const url = new URL(response.url());
            return response.request().method() === 'POST'
              && url.pathname.startsWith(`${endpointPath}/rt_`)
              && url.pathname.endsWith('/speech');
          }, { timeout: PROOF_TIMEOUT_MS }).then(
            (response) => ({ response, error: null }),
            (error) => ({ response: null, error })
          )
        : null;
      let created = null;
      for (let attempt = 1; attempt <= MAX_PROPAGATION_ATTEMPTS; attempt += 1) {
        const createdPromise = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return response.request().method() === 'POST' && url.pathname === endpointPath;
        }, { timeout: PROOF_TIMEOUT_MS });
        await start.click();
        // First press may surface the concise disclosure; accepting it
        // auto-connects the meeting, which resolves the armed call promise.
        await page.waitForTimeout(250);
        await acceptConsentIfShown();
        created = await createdPromise;
        if (created.status() === 201) break;
        const errorPayload = await created.json().catch(() => null);
        const errorCode = String(errorPayload?.error?.code || errorPayload?.code || 'unknown_error');
        const providerDetails = errorPayload?.error?.details || errorPayload?.details || {};
        const providerDiagnostic = [
          providerDetails.providerStatus ? `provider HTTP ${providerDetails.providerStatus}` : '',
          providerDetails.providerErrorType ? `type ${providerDetails.providerErrorType}` : '',
          providerDetails.providerErrorCode ? `code ${providerDetails.providerErrorCode}` : '',
          providerDetails.providerErrorParam ? `parameter ${providerDetails.providerErrorParam}` : '',
          providerDetails.providerContentType ? `content type ${providerDetails.providerContentType}` : '',
          Number.isInteger(providerDetails.providerBodyBytes) ? `body bytes ${providerDetails.providerBodyBytes}` : '',
          providerDetails.providerBodyStartsWithV0 === true ? 'body starts with v=0' : '',
          providerDetails.providerRequestId ? `request ${providerDetails.providerRequestId}` : ''
        ].filter(Boolean).join(', ');
        const safePropagationRetry = created.status() === 503
          && ['consumer_realtime_unavailable', 'realtime_unavailable'].includes(errorCode)
          && attempt < MAX_PROPAGATION_ATTEMPTS;
        if (!safePropagationRetry) {
          throw new Error(
            `The companion Start voice action returned HTTP ${created.status()} (${errorCode})${providerDiagnostic ? ` [${providerDiagnostic}]` : ''}.`
          );
        }
        await page.waitForTimeout(PROPAGATION_RETRY_MS);
        await page.waitForFunction(() => {
          const button = document.getElementById('realtimeVoiceStartButton');
          return button instanceof HTMLButtonElement && button.disabled === false;
        }, null, { timeout: PROOF_TIMEOUT_MS });
      }
      assert.equal(created?.status(), 201, 'The Realtime call route did not converge after bounded propagation retries.');
      assert.match(
        String(created.headers()['content-type'] || ''),
        /^application\/sdp(?:;|$)/i,
        'The companion did not receive a WebRTC SDP answer.'
      );
      leaseId = String(created.headers()['x-realtime-lease-id'] || '');
      assert.match(leaseId, /^rt_[A-Za-z0-9_-]{20,80}$/, 'The companion received no opaque Realtime lease.');
      controlCapability = String(created.headers()['x-realtime-control-capability'] || '');
      assert.match(
        controlCapability,
        /^rt_control_[A-Za-z0-9_-]{20,80}$/,
        'The companion received no authenticated Realtime control capability.'
      );
      // THE LANE THE CALL ACTUALLY RAN. The bootstrap announces a lane before
      // the call; the call route echoes the lane it opened. If those disagree,
      // the browser prepared one controller and the Worker ran another, and
      // nothing proven after this point would describe the same meeting.
      assert.equal(
        String(created.headers()['x-realtime-conversation-version'] || ''),
        conversationVersion,
        `The Realtime call ran a different conversation lane than the bootstrap announced (${conversationVersion}).`
      );

      const observed = await page.evaluate(async ({
        workerOriginValue,
        endpointPathValue,
        leaseIdValue,
        credentialValue,
        controlCapabilityValue,
        timeoutMs,
        requiredControlFieldsValue,
        conversationVersionValue
      }) => {
        const deadline = Date.now() + timeoutMs;
        let latestControl = {};
        while (Date.now() < deadline) {
          const response = await fetch(`${workerOriginValue}${endpointPathValue}/${encodeURIComponent(leaseIdValue)}`, {
            headers: {
              Accept: 'application/json',
              'X-Consumer-Session': credentialValue,
              'X-Realtime-Control-Capability': controlCapabilityValue
            }
          });
          if (!response.ok) throw new Error(`Realtime proof status returned HTTP ${response.status}.`);
          const payload = await response.json();
          const control = payload.controlPlane || payload.infrastructureProof || {};
          latestControl = control;
          const lease = payload.realtimeLease || {};
          // Every field the LANE requires, and only those. A lane whose
          // milestones are all absent can never satisfy another lane's list.
          if (requiredControlFieldsValue.every((field) => control[field] === true)) {
            return {
              control,
              lease: {
                promptVersion: String(lease.promptVersion || ''),
                toolsetVersion: String(lease.toolsetVersion || ''),
                status: String(lease.status || '')
              }
            };
          }
          if (lease.status && !['pending', 'active'].includes(lease.status)) {
            const reason = String(lease.closeReason || 'unknown').slice(0, 100);
            const code = String(lease.errorCode || 'none').slice(0, 120);
            throw new Error(`The Realtime control plane closed before proof completion (${lease.status}; ${reason}; ${code}).`);
          }
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
        const missing = requiredControlFieldsValue.filter((field) => latestControl[field] !== true);
        throw new Error(
          `The authenticated ${conversationVersionValue} control-plane proof did not complete in time `
          + `(missing: ${missing.join(', ') || 'none'}).`
        );
      }, {
        workerOriginValue: workerOrigin,
        endpointPathValue: endpointPath,
        leaseIdValue: leaseId,
        credentialValue: credential,
        controlCapabilityValue: controlCapability,
        timeoutMs: PROOF_TIMEOUT_MS,
        requiredControlFieldsValue: [...plan.requiredControlPlaneFields],
        conversationVersionValue: conversationVersion
      });
      const proof = observed.control;
      controlPlaneProof = proof;
      leaseIdentity = observed.lease;
      // THE LANE IDENTITY ON THE LEASE THE MEETING RAN UNDER. Not the
      // bootstrap's advertised configuration — the row the Worker wrote when
      // it reserved the budget and opened the provider call. A live meeting
      // recorded against the v2 prompt would be describing a surface this lane
      // has never had.
      assert.equal(
        observed.lease.promptVersion,
        plan.promptVersion,
        `The ${conversationVersion} meeting did not run the ${plan.promptVersion} prompt.`
      );
      assert.equal(
        observed.lease.toolsetVersion,
        plan.toolsetVersion,
        `The ${conversationVersion} meeting did not run the ${plan.toolsetVersion} tool surface.`
      );
      assertControlPlaneProvesLane(proof, conversationVersion);

      // WHAT THE LIVE LANE PROVES INSTEAD OF A SCRIPTED WELCOME: that media
      // actually negotiated. An SDP answer only says the offer was accepted;
      // `data-live-transport` is the peer connection's own state, published by
      // live_voice.js, and it reaches `connected` only when audio is flowing.
      if (plan.expectsLiveTransportState) {
        await page.waitForFunction(() => (
          document.getElementById('realtimeVoiceCompanion')?.dataset?.liveTransport === 'connected'
        ), null, { timeout: LIVE_TRANSPORT_TIMEOUT_MS });
        await page.waitForFunction(() => {
          const shell = document.getElementById('realtimeVoiceShell');
          return ['listening', 'user_speaking', 'responding', 'assistant_speaking']
            .includes(String(shell?.dataset?.realtimePhase || ''));
        }, null, { timeout: LIVE_TRANSPORT_TIMEOUT_MS });
      }

      if (plan.expectsControlledSpeech) {
        const controlledSpeechOutcome = await controlledSpeechPromise;
        if (controlledSpeechOutcome.error) {
          const leaseDiagnostic = await page.evaluate(async ({
            workerOriginValue,
            endpointPathValue,
            leaseIdValue,
            credentialValue,
            controlCapabilityValue
          }) => {
            const response = await fetch(`${workerOriginValue}${endpointPathValue}/${encodeURIComponent(leaseIdValue)}`, {
              headers: {
                Accept: 'application/json',
                'X-Consumer-Session': credentialValue,
                'X-Realtime-Control-Capability': controlCapabilityValue
              }
            });
            const payload = response.ok ? await response.json() : {};
            const lease = payload.realtimeLease || {};
            return {
              httpStatus: response.status,
              status: String(lease.status || 'unknown').slice(0, 40),
              closeReason: String(lease.closeReason || 'unknown').slice(0, 100),
              errorCode: String(lease.errorCode || 'none').slice(0, 120),
              controlPresent: Boolean(payload.realtimeControl)
            };
          }, {
            workerOriginValue: workerOrigin,
            endpointPathValue: endpointPath,
            leaseIdValue: leaseId,
            credentialValue: credential,
            controlCapabilityValue: controlCapability
          }).catch(() => ({
            httpStatus: 0,
            status: 'unavailable',
            closeReason: 'unavailable',
            errorCode: 'unavailable',
            controlPresent: false
          }));
          throw new Error(
            `${controlledSpeechOutcome.error.message} `
            + `(lease HTTP ${leaseDiagnostic.httpStatus}; ${leaseDiagnostic.status}; `
            + `${leaseDiagnostic.closeReason}; ${leaseDiagnostic.errorCode}; `
            + `control present: ${leaseDiagnostic.controlPresent}).`
          );
        }
        const controlledSpeech = controlledSpeechOutcome.response;
        assert.equal(controlledSpeech.status(), 200, 'The Worker-owned greeting speech request failed.');
        assert.match(
          String(controlledSpeech.headers()['content-type'] || ''),
          /^audio\/mpeg(?:;|$)/i,
          'The Worker-owned greeting did not return MP3 audio.'
        );
        assert.match(
          String(controlledSpeech.headers()['x-realtime-speech-id'] || ''),
          /^speech_[A-Za-z0-9_-]{20,80}$/,
          'The greeting response was not bound to a Worker-issued speech ID.'
        );
      }

      if (plan.assistantSpeechIsProof) {
        // The transcript is collapsed by default in the meeting layout; open it
        // before verifying the greeting caption.
        const captionCardHidden = await page.evaluate(() => (
          document.getElementById('realtimeVoiceCaptionCard')?.hidden === true
        ));
        if (captionCardHidden) {
          await page.locator('#realtimeVoiceTranscriptToggle').click();
        }
        await page.locator('#realtimeVoiceTranscriptHistory .is-assistant').first().waitFor({
          state: 'visible',
          timeout: PROOF_TIMEOUT_MS
        });
        const assistantGreeting = String(await page.locator('#realtimeVoiceTranscriptHistory .is-assistant p').first().textContent() || '').trim();
        assert.match(assistantGreeting, /Planéir/i, 'The greeting did not introduce Planéir.');
        assistantSpeechObserved = true;
      } else {
        // OBSERVED, NEVER GATED. This lane speaks when the client does, and
        // the proof's microphone is a fake device that says nothing. Recorded
        // so an operator reading the run can tell "the model chose not to
        // open" from "the meeting never connected" — which the transport and
        // control-plane assertions above have already decided. Read from the
        // DOM rather than through the collapse toggle, which no live-lane
        // controller binds.
        const speechDeadline = Date.now() + LIVE_SPEECH_OBSERVATION_MS;
        while (Date.now() < speechDeadline && !assistantSpeechObserved) {
          assistantSpeechObserved = await page.evaluate(() => Boolean(
            document.querySelector('#realtimeVoiceTranscriptHistory .is-assistant')
          ));
          if (!assistantSpeechObserved) await page.waitForTimeout(500);
        }
      }

      const audioReady = await page.evaluate((expectsDirectProviderAudioValue) => {
        const audio = document.getElementById('realtimeVoiceAudio');
        if (!audio) return false;
        if (expectsDirectProviderAudioValue) {
          // The provider's own track, live on the shared companion element.
          return audio.srcObject instanceof MediaStream
            && audio.srcObject.getAudioTracks().some((track) => track.readyState === 'live')
            && audio.paused === false;
        }
        return audio.srcObject === null
          && /^speech_[A-Za-z0-9_-]{20,80}$/.test(String(audio.dataset.controlledSpeechId || ''))
          && audio.dataset.controlledSpeechPlayed === 'true'
          && String(audio.currentSrc || audio.src || '').startsWith('blob:');
      }, plan.expectsDirectProviderAudio);
      assert.equal(
        audioReady,
        true,
        plan.expectsDirectProviderAudio
          ? `The direct provider audio stream was not attached and playing on the ${conversationVersion} lane.`
          : 'The separately generated greeting MP3 was not played in the companion.'
      );
      if (plan.expectsMicBadge && conversationVersion === 'v2') {
        await page.waitForFunction(() => (
          document.getElementById('realtimeMicBadge')?.textContent === 'Mic on'
        ), null, { timeout: PROOF_TIMEOUT_MS });
      }

      const closedPromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'DELETE'
          && url.pathname === `${endpointPath}/${encodeURIComponent(leaseId)}`;
      }, { timeout: PROOF_TIMEOUT_MS });
      await page.locator('#realtimeVoiceEndButton').click();
      const closed = await closedPromise;
      assert.equal(closed.status(), 200, 'The companion End voice control did not close the lease.');
      const closedPayload = await closed.json();
      assert.equal(closedPayload.providerHangupConfirmed, true, 'The provider did not confirm server-side hang-up.');
      leaseId = '';
    } catch (error) {
      const uiDiagnostic = await page.evaluate(() => ({
        phase: String(document.getElementById('realtimeVoiceShell')?.dataset?.realtimePhase || ''),
        status: String(document.getElementById('realtimeVoiceStatus')?.textContent || '').trim(),
        error: String(document.getElementById('realtimeVoiceError')?.textContent || '').trim()
      })).catch(() => ({ phase: '', status: '', error: '' }));
      const diagnosticSuffix = [
        requestDiagnostics.length ? `requests: ${requestDiagnostics.join('; ')}` : 'requests: none',
        uiDiagnostic.phase ? `phase: ${uiDiagnostic.phase}` : '',
        uiDiagnostic.status ? `status: ${uiDiagnostic.status}` : '',
        uiDiagnostic.error ? `ui error: ${uiDiagnostic.error}` : ''
      ].filter(Boolean).join(' | ');
      throw new Error(`${error instanceof Error ? error.message : String(error)} (${diagnosticSuffix})`);
    } finally {
      if (leaseId) {
        await page.evaluate(async ({
          workerOriginValue,
          endpointPathValue,
          leaseIdValue,
          credentialValue,
          controlCapabilityValue
        }) => {
          await fetch(`${workerOriginValue}${endpointPathValue}/${encodeURIComponent(leaseIdValue)}`, {
            method: 'DELETE',
            headers: {
              Accept: 'application/json',
              'X-Consumer-Session': credentialValue,
              'X-Realtime-Control-Capability': controlCapabilityValue
            }
          }).catch(() => {});
        }, {
          workerOriginValue: workerOrigin,
          endpointPathValue: endpointPath,
          leaseIdValue: leaseId,
          credentialValue: credential,
          controlCapabilityValue: controlCapability
        }).catch(() => {});
      }
    }

    // Every boolean below is what the run OBSERVED, not what the lane was
    // expected to do. The invariants are asserted afterwards, against the
    // lane plan, so a proof that quietly satisfied the wrong lane's evidence
    // fails here rather than reporting a green activation.
    const result = {
      conversationVersion,
      // Read off the lease the meeting actually ran under, never copied from
      // the plan: a value taken from the expectation cannot contradict it.
      promptVersion: leaseIdentity.promptVersion,
      toolsetVersion: leaseIdentity.toolsetVersion,
      launcherVisible: true,
      companionStartWired: true,
      audibleGreetingObserved: assistantSpeechObserved,
      controlledSpeechObserved: plan.expectsControlledSpeech,
      directProviderAudioAttached: plan.expectsDirectProviderAudio,
      webRtcConnected: true,
      sidebandConnected: conversationVersion === 'live'
        ? controlPlaneProof.liveSidebandConnected === true
        : controlPlaneProof.sidebandConnected === true,
      readOnlyToolSucceeded: controlPlaneProof.readOnlyToolSucceeded === true,
      initialWelcomeSucceeded: controlPlaneProof.initialWelcomeSucceeded === true,
      liveLaneActivated: controlPlaneProof.liveCallActivated === true,
      liveTransportConnected: plan.expectsLiveTransportState,
      liveResponseCompleted: controlPlaneProof.liveResponseCompleted === true,
      liveToolSucceeded: controlPlaneProof.liveToolSucceeded === true,
      providerHangupConfirmed: true
    };
    return assertLaneProofResult(result);
  } finally {
    await browser.close();
  }
}
