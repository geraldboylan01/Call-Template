import assert from 'node:assert/strict';

const PROOF_TIMEOUT_MS = 45_000;
const PROPAGATION_RETRY_MS = 12_000;
const MAX_PROPAGATION_ATTEMPTS = 5;
const MAX_BOOTSTRAP_PROPAGATION_ATTEMPTS = 10;
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
    for (let attempt = 1; attempt <= REALTIME_FLAG_SETTLE_MAX_ATTEMPTS; attempt += 1) {
      let enabled = false;
      try {
        const response = await fetch(`${workerOrigin}/api/consumer/bootstrap`, {
          headers: { Origin: siteOrigin }
        });
        const payload = response.ok ? await response.json() : null;
        enabled = payload?.flags?.consumerRealtimeVoiceEnabled === true;
      } catch (_error) {
        enabled = false;
      }
      consecutiveEnabledSamples = enabled ? consecutiveEnabledSamples + 1 : 0;
      if (consecutiveEnabledSamples >= REALTIME_FLAG_SETTLE_SAMPLES) break;
      await new Promise((resolve) => setTimeout(resolve, REALTIME_FLAG_SETTLE_INTERVAL_MS));
    }
    assert.equal(
      consecutiveEnabledSamples >= REALTIME_FLAG_SETTLE_SAMPLES,
      true,
      'The live Realtime flag did not settle across consecutive bootstrap samples before the paid Start attempt.'
    );

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
    try {
      const controlledSpeechPromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'POST'
          && url.pathname.startsWith(`${endpointPath}/rt_`)
          && url.pathname.endsWith('/speech');
      }, { timeout: PROOF_TIMEOUT_MS }).then(
        (response) => ({ response, error: null }),
        (error) => ({ response: null, error })
      );
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

      const proof = await page.evaluate(async ({
        workerOriginValue,
        endpointPathValue,
        leaseIdValue,
        credentialValue,
        controlCapabilityValue,
        timeoutMs
      }) => {
        const deadline = Date.now() + timeoutMs;
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
          if (control.sidebandConnected === true && control.readOnlyToolSucceeded === true) return control;
          const lease = payload.realtimeLease || {};
          if (lease.status && !['pending', 'active'].includes(lease.status)) {
            const reason = String(lease.closeReason || 'unknown').slice(0, 100);
            const code = String(lease.errorCode || 'none').slice(0, 120);
            throw new Error(`The Realtime control plane closed before proof completion (${lease.status}; ${reason}; ${code}).`);
          }
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
        throw new Error('The authenticated sideband tool proof did not complete in time.');
      }, {
        workerOriginValue: workerOrigin,
        endpointPathValue: endpointPath,
        leaseIdValue: leaseId,
        credentialValue: credential,
        controlCapabilityValue: controlCapability,
        timeoutMs: PROOF_TIMEOUT_MS
      });
      assert.equal(proof.sidebandConnected, true, 'The authenticated provider sideband was not proven.');
      assert.equal(proof.readOnlyToolSucceeded, true, 'The forced get_planning_state tool did not succeed.');

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
      assert.match(
        assistantGreeting,
        /^Hi, I’m Planéir, your AI planning companion\./,
        'The companion did not show the exact server-owned greeting caption.'
      );
      const audioReady = await page.evaluate(() => {
        const audio = document.getElementById('realtimeVoiceAudio');
        return Boolean(
          audio
          && audio.srcObject === null
          && /^speech_[A-Za-z0-9_-]{20,80}$/.test(String(audio.dataset.controlledSpeechId || ''))
          && audio.dataset.controlledSpeechPlayed === 'true'
          && String(audio.currentSrc || audio.src || '').startsWith('blob:')
        );
      });
      assert.equal(audioReady, true, 'The separately generated greeting MP3 was not played in the companion.');

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

    const result = {
      launcherVisible: true,
      companionStartWired: true,
      audibleGreetingObserved: true,
      controlledSpeechObserved: true,
      directProviderAudioAttached: false,
      webRtcConnected: true,
      sidebandConnected: true,
      readOnlyToolSucceeded: true,
      providerHangupConfirmed: true
    };
    assert.deepEqual(result, {
      launcherVisible: true,
      companionStartWired: true,
      audibleGreetingObserved: true,
      controlledSpeechObserved: true,
      directProviderAudioAttached: false,
      webRtcConnected: true,
      sidebandConnected: true,
      readOnlyToolSucceeded: true,
      providerHangupConfirmed: true
    });
    return result;
  } finally {
    await browser.close();
  }
}
