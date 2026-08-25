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
// How long the live lane is watched for model speech. This is an observation,
// not an activation gate.
const LIVE_SPEECH_OBSERVATION_MS = 6_000;

/**
 * THE ONE ACTIVE CALL PROOF.
 *
 * Historical v1/v2 proof branches were removed with the controlled lane. An
 * activation which announces anything except `live` fails before a paid call;
 * it can never fall back to evidence from an archived implementation.
 */
export const LANE_PROOFS = Object.freeze({
  live: Object.freeze({
    lane: 'live',
    promptVersion: LIVE_PROMPT_VERSION,
    toolsetVersion: LIVE_TOOLSET_VERSION,
    // THE ONE THING THIS LANE CANNOT PROMISE. live_provider.js sets
    // `create_response: true` and live_session.js deliberately sends no
    // `response.create` — the provider replies when the CLIENT stops speaking.
    // The proof drives a fake microphone that says nothing, so requiring model
    // speech here would be a coin toss dressed up as a gate. What replaces it
    // is stricter, not looser: the lane's own activation and sideband events,
    // the negotiated peer connection, and the prompt/toolset pinned on the
    // lease the meeting actually ran under.
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
  assert.equal(proof.liveCallActivated, true, 'The live conversation lane never activated its meeting.');
  assert.equal(proof.liveSidebandConnected, true, 'The live provider sideband was not proven.');
  assert.equal(proof.readOnlyToolSucceeded, false,
    'A live meeting ran an archived controlled-lane tool, so the implementations are crossed.');
  return plan;
}

/**
 * The lane-consistency gate on the finished result.
 *
 * Separate from the per-step assertions on purpose: those prove the milestones
 * happened, this proves they were the RIGHT lane's milestones. It is the check
 * that a live run carrying evidence from an archived implementation fails.
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
  assert.equal(result.liveLaneActivated, true, 'The live activation marker is required.');
  assert.equal(result.liveTransportConnected, true, 'The live transport marker is required.');
  assert.equal(result.readOnlyToolSucceeded, false,
    'The live lane must never be certified by an archived controlled-lane tool.');
  assert.equal(result.controlledSpeechObserved, false,
    'The live lane must never produce archived Worker-composed speech.');
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
      // the loop and stops the activation. It is never defaulted.
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
    // Every proof decision from here reads this plan. Resolving it once,
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
      // recorded against an archived prompt would be describing a surface this lane
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
      await page.waitForFunction(() => (
        document.getElementById('realtimeVoiceCompanion')?.dataset?.liveTransport === 'connected'
      ), null, { timeout: LIVE_TRANSPORT_TIMEOUT_MS });
      await page.waitForFunction(() => {
        const shell = document.getElementById('realtimeVoiceShell');
        return ['listening', 'user_speaking', 'responding', 'assistant_speaking']
          .includes(String(shell?.dataset?.realtimePhase || ''));
      }, null, { timeout: LIVE_TRANSPORT_TIMEOUT_MS });

      // Observed, never gated: the fake microphone may remain silent.
      const speechDeadline = Date.now() + LIVE_SPEECH_OBSERVATION_MS;
      while (Date.now() < speechDeadline && !assistantSpeechObserved) {
        assistantSpeechObserved = await page.evaluate(() => Boolean(
          document.querySelector('#realtimeVoiceTranscriptHistory .is-assistant')
        ));
        if (!assistantSpeechObserved) await page.waitForTimeout(500);
      }

      const audioReady = await page.evaluate(() => {
        const audio = document.getElementById('realtimeVoiceAudio');
        if (!audio) return false;
        return audio.srcObject instanceof MediaStream
          && audio.srcObject.getAudioTracks().some((track) => track.readyState === 'live')
          && audio.paused === false;
      });
      assert.equal(
        audioReady,
        true,
        'The direct provider audio stream was not attached and playing on the live lane.'
      );

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
      controlledSpeechObserved: false,
      directProviderAudioAttached: true,
      webRtcConnected: true,
      sidebandConnected: controlPlaneProof.liveSidebandConnected === true,
      readOnlyToolSucceeded: controlPlaneProof.readOnlyToolSucceeded === true,
      liveLaneActivated: controlPlaneProof.liveCallActivated === true,
      liveTransportConnected: true,
      liveResponseCompleted: controlPlaneProof.liveResponseCompleted === true,
      liveToolSucceeded: controlPlaneProof.liveToolSucceeded === true,
      providerHangupConfirmed: true
    };
    return assertLaneProofResult(result);
  } finally {
    await browser.close();
  }
}
