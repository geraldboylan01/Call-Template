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
    await page.goto(new URL('/plan/', `${siteOrigin}/`).href, {
      waitUntil: 'domcontentloaded',
      timeout: PROOF_TIMEOUT_MS
    });

    const result = await page.evaluate(async ({ workerOrigin, sessionId, credential, timeoutMs }) => {
      const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
      const deadline = Date.now() + timeoutMs;
      const endpoint = `${workerOrigin}/api/consumer/sessions/${encodeURIComponent(sessionId)}/voice/realtime/calls`;
      const tracks = [];
      let peer = null;
      let leaseId = '';
      let dataChannelOpened = false;

      const credentialHeaders = (extra = {}) => ({
        'X-Consumer-Session': credential,
        ...extra
      });
      const readJson = async (response, action) => {
        const text = await response.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (_error) { /* bounded error below */ }
        if (!response.ok || !payload) {
          throw new Error(`${action} returned HTTP ${response.status}.`);
        }
        return payload;
      };
      const waitFor = async (predicate, message) => {
        while (Date.now() < deadline) {
          if (predicate()) return;
          await sleep(100);
        }
        throw new Error(message);
      };

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        tracks.push(...stream.getTracks());
        peer = new RTCPeerConnection();
        tracks.forEach((track) => peer.addTrack(track, stream));
        const dataChannel = peer.createDataChannel('oai-events');
        dataChannel.addEventListener('open', () => { dataChannelOpened = true; });

        const offer = await peer.createOffer({ offerToReceiveAudio: true });
        await peer.setLocalDescription(offer);
        if (peer.iceGatheringState !== 'complete') {
          await Promise.race([
            new Promise((resolve) => {
              const listener = () => {
                if (peer.iceGatheringState === 'complete') {
                  peer.removeEventListener('icegatheringstatechange', listener);
                  resolve();
                }
              };
              peer.addEventListener('icegatheringstatechange', listener);
            }),
            sleep(8_000)
          ]);
        }
        const offerSdp = String(peer.localDescription?.sdp || offer.sdp || '');
        if (!offerSdp.startsWith('v=0')) throw new Error('The browser produced no SDP offer.');

        const created = await fetch(endpoint, {
          method: 'POST',
          headers: credentialHeaders({
            'Content-Type': 'application/sdp',
            'X-Voice-Request-Id': `realtime-proof-${crypto.randomUUID()}`
          }),
          body: offerSdp
        });
        const answerSdp = await created.text();
        if (created.status !== 201 || !answerSdp.startsWith('v=0')) {
          throw new Error(`Realtime call creation returned HTTP ${created.status}.`);
        }
        leaseId = String(created.headers.get('X-Realtime-Lease-Id') || '');
        if (!/^rt_[A-Za-z0-9_-]{20,80}$/.test(leaseId)) {
          throw new Error('Realtime call creation returned no opaque lease.');
        }
        await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
        await waitFor(
          () => peer.connectionState === 'connected' && dataChannelOpened,
          'The production WebRTC peer or event channel did not connect.'
        );

        let leasePayload = null;
        while (Date.now() < deadline) {
          const response = await fetch(`${endpoint}/${encodeURIComponent(leaseId)}`, {
            headers: credentialHeaders({ Accept: 'application/json' })
          });
          leasePayload = await readJson(response, 'Realtime proof status');
          const proof = leasePayload.controlPlane || leasePayload.infrastructureProof || {};
          if (proof.sidebandConnected === true && proof.readOnlyToolSucceeded === true) break;
          await sleep(500);
        }
        const proof = leasePayload?.controlPlane || leasePayload?.infrastructureProof || {};
        if (proof.sidebandConnected !== true) throw new Error('The authenticated provider sideband was not proven.');
        if (proof.readOnlyToolSucceeded !== true) throw new Error('The forced get_planning_state tool did not succeed.');

        const closed = await fetch(`${endpoint}/${encodeURIComponent(leaseId)}`, {
          method: 'DELETE',
          headers: credentialHeaders({ Accept: 'application/json' })
        });
        const closedPayload = await readJson(closed, 'Realtime server hang-up');
        if (closedPayload.providerHangupConfirmed !== true) {
          throw new Error('The provider did not confirm server-side hang-up.');
        }
        leaseId = '';
        return {
          webRtcConnected: true,
          sidebandConnected: true,
          readOnlyToolSucceeded: true,
          providerHangupConfirmed: true
        };
      } finally {
        if (leaseId) {
          await fetch(`${endpoint}/${encodeURIComponent(leaseId)}`, {
            method: 'DELETE',
            headers: credentialHeaders({ Accept: 'application/json' })
          }).catch(() => {});
        }
        try { peer?.close(); } catch (_error) { /* best effort */ }
        tracks.forEach((track) => {
          try { track.stop(); } catch (_error) { /* best effort */ }
        });
      }
    }, {
      workerOrigin,
      sessionId,
      credential,
      timeoutMs: PROOF_TIMEOUT_MS
    });

    assert.deepEqual(result, {
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
