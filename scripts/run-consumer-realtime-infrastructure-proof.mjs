import assert from 'node:assert/strict';

const PROOF_TIMEOUT_MS = 45_000;

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
    const page = await context.newPage();
    await page.addInitScript(({ sessionIdValue, credentialValue }) => {
      window.sessionStorage.setItem('planeir.consumer.session-id.v1', sessionIdValue);
      window.sessionStorage.setItem('planeir.consumer.credential.v1', credentialValue);
    }, { sessionIdValue: sessionId, credentialValue: credential });
    await page.goto(new URL('/plan/', `${siteOrigin}/`).href, {
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
    const launcher = page.locator('#realtimeVoiceLauncher');
    await launcher.waitFor({ state: 'visible', timeout: PROOF_TIMEOUT_MS });
    await launcher.click();
    await page.locator('#realtimeVoiceShell').waitFor({ state: 'visible', timeout: 5_000 });
    const start = page.locator('#realtimeVoiceStartButton');
    await start.waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForFunction(() => {
      const button = document.getElementById('realtimeVoiceStartButton');
      return button instanceof HTMLButtonElement && button.disabled === false;
    }, null, { timeout: PROOF_TIMEOUT_MS });

    const consentStatus = String(await page.locator('#realtimeVoiceStatus').textContent() || '');
    if (consentStatus.includes('Review the Live voice disclosure')) {
      await start.click();
      const consentDialog = page.locator('#realtimeVoiceConsentDialog');
      await consentDialog.waitFor({ state: 'visible', timeout: 5_000 });
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
      await page.waitForFunction(() => {
        const button = document.getElementById('realtimeVoiceStartButton');
        const status = String(document.getElementById('realtimeVoiceStatus')?.textContent || '');
        return button instanceof HTMLButtonElement
          && button.disabled === false
          && status.includes('Live voice is ready');
      }, null, { timeout: PROOF_TIMEOUT_MS });
    } else {
      assert.match(consentStatus, /Ready\. Voice starts only when you press Start voice\./);
    }

    let leaseId = '';
    let controlCapability = '';
    try {
      const createdPromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'POST' && url.pathname === endpointPath;
      }, { timeout: PROOF_TIMEOUT_MS });
      const controlledSpeechPromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'POST'
          && url.pathname.startsWith(`${endpointPath}/rt_`)
          && url.pathname.endsWith('/speech');
      }, { timeout: PROOF_TIMEOUT_MS }).then(
        (response) => ({ response, error: null }),
        (error) => ({ response: null, error })
      );
      await start.click();
      const created = await createdPromise;
      if (created.status() !== 201) {
        const errorPayload = await created.json().catch(() => null);
        const errorCode = String(errorPayload?.error?.code || errorPayload?.code || 'unknown_error');
        throw new Error(`The companion Start voice action returned HTTP ${created.status()} (${errorCode}).`);
      }
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
      if (controlledSpeechOutcome.error) throw controlledSpeechOutcome.error;
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

      await page.locator('#realtimeVoiceTranscriptHistory .is-assistant').first().waitFor({
        state: 'visible',
        timeout: PROOF_TIMEOUT_MS
      });
      const assistantGreeting = String(await page.locator('#realtimeVoiceTranscriptHistory .is-assistant p').first().textContent() || '').trim();
      assert.match(
        assistantGreeting,
        /^Hello, I’m Planéir, an AI planning companion for financial education\./,
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
