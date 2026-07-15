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

    let leaseId = '';
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
      }, { timeout: PROOF_TIMEOUT_MS });
      await start.click();
      const created = await createdPromise;
      assert.equal(created.status(), 201, 'The companion Start voice action did not create a Realtime call.');
      assert.match(
        String(created.headers()['content-type'] || ''),
        /^application\/sdp(?:;|$)/i,
        'The companion did not receive a WebRTC SDP answer.'
      );
      leaseId = String(created.headers()['x-realtime-lease-id'] || '');
      assert.match(leaseId, /^rt_[A-Za-z0-9_-]{20,80}$/, 'The companion received no opaque Realtime lease.');

      const proof = await page.evaluate(async ({ workerOriginValue, endpointPathValue, leaseIdValue, credentialValue, timeoutMs }) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const response = await fetch(`${workerOriginValue}${endpointPathValue}/${encodeURIComponent(leaseIdValue)}`, {
            headers: {
              Accept: 'application/json',
              'X-Consumer-Session': credentialValue
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
        timeoutMs: PROOF_TIMEOUT_MS
      });
      assert.equal(proof.sidebandConnected, true, 'The authenticated provider sideband was not proven.');
      assert.equal(proof.readOnlyToolSucceeded, true, 'The forced get_planning_state tool did not succeed.');

      const controlledSpeech = await controlledSpeechPromise;
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
    } finally {
      if (leaseId) {
        await page.evaluate(async ({ workerOriginValue, endpointPathValue, leaseIdValue, credentialValue }) => {
          await fetch(`${workerOriginValue}${endpointPathValue}/${encodeURIComponent(leaseIdValue)}`, {
            method: 'DELETE',
            headers: { Accept: 'application/json', 'X-Consumer-Session': credentialValue }
          }).catch(() => {});
        }, {
          workerOriginValue: workerOrigin,
          endpointPathValue: endpointPath,
          leaseIdValue: leaseId,
          credentialValue: credential
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
