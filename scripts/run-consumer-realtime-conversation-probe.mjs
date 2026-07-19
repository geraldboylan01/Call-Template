import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// A real-model live conversation probe. Unlike the infrastructure proof (which
// proves the WebRTC/sideband/hang-up plumbing with a silent fake mic), this
// harness actually *talks*: it overrides the browser microphone with a Web
// Audio destination and injects per-turn OpenAI text-to-speech, so the real
// gpt-realtime model transcribes genuine speech, chooses tools, and the
// conversation director speaks back. It captures the full transcript and
// asserts the meeting probes naturally instead of stalling or repeating.
//
// Runs only from a protected, manually dispatched workflow with the production
// OPENAI_API_KEY (for TTS) and ADVISOR_SMOKE_PASSWORD (to mint a session).
const PROBE_TIMEOUT_MS = 60_000;
const TURN_REPLY_TIMEOUT_MS = 30_000;
const PROPAGATION_RETRY_MS = 12_000;
const MAX_START_ATTEMPTS = 5;
const REALTIME_FLAG_SETTLE_SAMPLES = 3;
const REALTIME_FLAG_SETTLE_INTERVAL_MS = 5_000;
const REALTIME_FLAG_SETTLE_MAX_ATTEMPTS = 30;
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3_000;
const TTS_MODEL = 'tts-1';
const TTS_VOICE = 'alloy';

// The scripted consumer. Each turn speaks `say`; `expect` describes what a
// healthy meeting must do in reply, checked against the captured assistant
// transcript for that turn. `noiseOnly` simulates a cough-style false
// interruption (spoken then immediately committed with no real content is not
// possible here, so we assert the recovery path separately in unit tests).
const CONVERSATION = [
  {
    label: 'open',
    say: 'So I am 32 and I just had a baby. I really want a financial health check — '
      + 'where I stand, making sure I can look after the little one, get my mortgage paid off, '
      + 'and eventually get the baby into college.',
    expectReply: true,
    mustNotRepeatGreeting: true,
    // "Just had a baby" makes the classification obvious; an intelligent
    // interview infers new_parent as a reviewable draft instead of reading a
    // category menu back at the consumer.
    mustNotMatch: /which best describes your situation/i
  },
  {
    label: 'repeat_request',
    say: 'Sorry, could you say that again? I did not catch the question.',
    expectReply: true,
    mustNotBeSilent: true
  },
  {
    label: 'answer_income',
    say: 'Sure. Our household brings in about six thousand euro a month after tax, between the two of us.',
    expectReply: true
  }
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredHttpsOrigin(value, label) {
  const parsed = new URL(String(value || ''));
  assert.equal(parsed.protocol, 'https:', `${label} must use HTTPS.`);
  assert.equal(parsed.origin, String(value || '').replace(/\/+$/, ''), `${label} must be an origin without a path.`);
  return parsed.origin;
}

class CookieJar {
  constructor() { this.cookies = new Map(); }
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

async function requestJson(baseUrl, pathname, {
  method = 'GET', origin, headers = {}, body, cookieJar,
  acceptedStatuses = [200], diagnosticPath = pathname
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
    try { payload = text ? JSON.parse(text) : null; } catch (_error) {
      throw new Error(`${method} ${diagnosticPath} returned invalid JSON.`);
    }
    if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    assert.ok(
      acceptedStatuses.includes(response.status),
      `${method} ${diagnosticPath} returned ${response.status}; expected ${acceptedStatuses.join(' or ')}.`
    );
    return { payload, status: response.status };
  }
  throw lastError || new Error(`${method} ${diagnosticPath} failed.`);
}

async function mintSession({ workerBaseUrl, smokeOrigin, password }) {
  const cookieJar = new CookieJar();
  await requestJson(workerBaseUrl, '/api/auth/session', { origin: smokeOrigin, cookieJar });
  const login = await requestJson(workerBaseUrl, '/api/auth/login', {
    method: 'POST', origin: smokeOrigin, cookieJar, body: { password }
  });
  assert.equal(login.payload?.authenticated, true, 'Probe advisor login failed.');
  const csrfToken = String(login.payload?.csrfToken || '');
  assert.match(csrfToken, /^[A-Za-z0-9_-]{32,}$/, 'Probe advisor login returned no CSRF token.');

  let inviteResult = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    inviteResult = await requestJson(workerBaseUrl, '/api/advisor/consumer-invite', {
      method: 'POST', origin: smokeOrigin, cookieJar,
      headers: { 'X-Advisor-CSRF': csrfToken },
      acceptedStatuses: [200, 201]
    });
    if (inviteResult.payload?.ok === true) break;
    await sleep(RETRY_DELAY_MS);
  }
  const inviteUrl = new URL(String(inviteResult.payload?.url || ''));
  const inviteToken = new URLSearchParams(inviteUrl.hash.slice(1)).get('invite') || '';
  assert.match(inviteToken, /^ci1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'Probe invite token malformed.');

  const bootstrap = (await requestJson(workerBaseUrl, '/api/consumer/bootstrap', { origin: smokeOrigin })).payload;
  const credential = `cs_${randomBytes(18).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
  const sessionId = credential.slice(0, credential.indexOf('.'));
  await requestJson(workerBaseUrl, '/api/consumer/sessions', {
    method: 'POST', origin: smokeOrigin,
    headers: { 'X-Consumer-Invite': inviteToken, 'X-Consumer-Session': credential },
    body: {
      consent: {
        analysis: true, aiProcessing: false, adultConfirmed: true, educationOnlyAcknowledged: true,
        manifestId: bootstrap.consentManifestId, policyVersion: bootstrap.consentPolicyVersion,
        analysisNoticeId: bootstrap.analysisNoticeId, aiNoticeId: bootstrap.ai.noticeId,
        privacyNoticeUrl: bootstrap.privacyNoticeUrl
      }
    },
    acceptedStatuses: [200, 201]
  });
  await requestJson(workerBaseUrl, `/api/consumer/sessions/${encodeURIComponent(sessionId)}/voice/realtime/consent`, {
    method: 'PATCH', origin: smokeOrigin,
    headers: { 'X-Consumer-Session': credential },
    body: {
      granted: true,
      noticeId: bootstrap.realtimeVoice.noticeId,
      policyVersion: bootstrap.realtimeVoice.policyVersion,
      privacyNoticeUrl: bootstrap.realtimeVoice.privacyNoticeUrl
    },
    diagnosticPath: '/api/consumer/sessions/[probe]/voice/realtime/consent'
  });
  return { sessionId, credential, cookieJar };
}

async function synthesizeSpeechBase64(text, openaiKey) {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'wav' })
  });
  if (!response.ok) throw new Error(`TTS synthesis failed: HTTP ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString('base64');
}

async function settleRealtimeFlag(workerOrigin, siteOrigin) {
  let consecutive = 0;
  for (let attempt = 1; attempt <= REALTIME_FLAG_SETTLE_MAX_ATTEMPTS; attempt += 1) {
    let enabled = false;
    try {
      const response = await fetch(`${workerOrigin}/api/consumer/bootstrap`, { headers: { Origin: siteOrigin } });
      const payload = response.ok ? await response.json() : null;
      enabled = payload?.flags?.consumerRealtimeVoiceEnabled === true;
    } catch (_error) { enabled = false; }
    consecutive = enabled ? consecutive + 1 : 0;
    if (consecutive >= REALTIME_FLAG_SETTLE_SAMPLES) return;
    await sleep(REALTIME_FLAG_SETTLE_INTERVAL_MS);
  }
  throw new Error('The live Realtime flag did not settle before the conversation probe.');
}

export async function runRealtimeConversationProbe({ workerBaseUrl, smokeOrigin, password, openaiKey }) {
  const workerOrigin = requiredHttpsOrigin(workerBaseUrl, 'WORKER_BASE_URL');
  const siteOrigin = requiredHttpsOrigin(smokeOrigin, 'SMOKE_ORIGIN');
  assert.ok(password, 'ADVISOR_SMOKE_PASSWORD is required for the conversation probe.');
  assert.ok(openaiKey, 'OPENAI_API_KEY is required for the conversation probe (text-to-speech).');

  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch (_error) { throw new Error('The conversation probe requires the pinned playwright-core browser harness.'); }

  await settleRealtimeFlag(workerOrigin, siteOrigin);

  // Pre-synthesize every scripted turn so live turn-taking is not blocked on
  // TTS latency.
  const turnsAudio = [];
  for (const turn of CONVERSATION) {
    turnsAudio.push(await synthesizeSpeechBase64(turn.say, openaiKey));
  }

  const { sessionId, credential } = await mintSession({ workerBaseUrl, smokeOrigin, password });
  const transcript = [];
  const record = (role, text) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean) transcript.push({ role, text: clean });
  };

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream']
  });
  try {
    const context = await browser.newContext({ baseURL: siteOrigin });
    await context.grantPermissions(['microphone'], { origin: siteOrigin });
    const page = await context.newPage();
    const pageConsoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') pageConsoleErrors.push(message.text().slice(0, 300));
    });
    page.on('pageerror', (error) => pageConsoleErrors.push(`pageerror: ${String(error?.message || error).slice(0, 300)}`));

    // Override the microphone with a Web Audio destination we can push
    // per-turn speech into, so the real model transcribes genuine words.
    await page.addInitScript(({ sessionIdValue, credentialValue }) => {
      window.sessionStorage.setItem('planeir.consumer.session-id.v1', sessionIdValue);
      window.sessionStorage.setItem('planeir.consumer.credential.v1', credentialValue);
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContextCtor({ sampleRate: 48_000 });
      const destination = audioContext.createMediaStreamDestination();
      // Keep a faint noise floor so the track is continuously live.
      const floor = audioContext.createGain();
      floor.gain.value = 0.0001;
      const osc = audioContext.createOscillator();
      osc.frequency.value = 40;
      osc.connect(floor).connect(destination);
      osc.start();
      window.__probe = {
        audioContext,
        destination,
        speaking: false,
        async speak(base64Wav) {
          const binary = atob(base64Wav);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          const buffer = await audioContext.decodeAudioData(bytes.buffer);
          await audioContext.resume();
          const source = audioContext.createBufferSource();
          source.buffer = buffer;
          source.connect(destination);
          this.speaking = true;
          return new Promise((resolve) => {
            source.onended = () => { this.speaking = false; resolve(buffer.duration); };
            source.start();
          });
        }
      };
      const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (constraints && constraints.audio) {
          return destination.stream.clone();
        }
        return realGetUserMedia(constraints);
      };
      navigator.mediaDevices.enumerateDevices = async () => ([{
        deviceId: 'probe-microphone', groupId: 'probe', kind: 'audioinput', label: 'Probe Microphone',
        toJSON() { return this; }
      }]);
    }, { sessionIdValue: sessionId, credentialValue: credential });

    const probePageUrl = new URL('/plan/', `${siteOrigin}/`);
    probePageUrl.searchParams.set('realtime-proof', crypto.randomUUID());
    await page.goto(probePageUrl.href, { waitUntil: 'domcontentloaded', timeout: PROBE_TIMEOUT_MS });

    // An eligible session auto-opens the meeting surface and marks the
    // background launcher inert (Playwright reports it hidden), so the entry
    // point is ready when either the shell is open or the launcher is
    // actionable. Bootstrap propagation can lag, so retry-navigate like the
    // infrastructure proof does.
    const launcher = page.locator('#realtimeVoiceLauncher');
    const meetingEntryState = async () => page.evaluate(() => ({
      shellOpen: document.getElementById('realtimeVoiceShell')?.hidden === false,
      launcherShown: (() => {
        const element = document.getElementById('realtimeVoiceLauncher');
        return Boolean(element && element.closest('[hidden]') === null);
      })()
    }));
    let entry = { shellOpen: false, launcherShown: false };
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await page.waitForTimeout(3_000);
      entry = await meetingEntryState();
      if (entry.shellOpen || entry.launcherShown) break;
      if (attempt < 10) {
        probePageUrl.searchParams.set('realtime-proof', crypto.randomUUID());
        await page.goto(probePageUrl.href, { waitUntil: 'domcontentloaded', timeout: PROBE_TIMEOUT_MS });
      }
    }
    assert.ok(entry.shellOpen || entry.launcherShown, 'The meeting shell/launcher never became available.');
    if (!entry.shellOpen) await launcher.click().catch(() => {});
    const start = page.locator('#realtimeVoiceStartButton');
    await start.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(() => {
      const button = document.getElementById('realtimeVoiceStartButton');
      return button instanceof HTMLButtonElement && button.disabled === false;
    }, null, { timeout: PROBE_TIMEOUT_MS });

    const acceptConsentIfShown = async () => {
      const dialog = page.locator('#realtimeVoiceConsentDialog');
      if (!(await dialog.isVisible().catch(() => false))) return;
      await page.locator('#realtimeVoiceConsentAcknowledgement').check().catch(() => {});
      await page.locator('#realtimeVoiceConsentForm button[type="submit"]').click().catch(() => {});
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    };

    let connected = false;
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
      const createdPromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'POST'
          && /\/voice\/realtime\/calls$/.test(url.pathname);
      }, { timeout: PROBE_TIMEOUT_MS }).catch(() => null);
      await start.click();
      await page.waitForTimeout(250);
      await acceptConsentIfShown();
      const created = await createdPromise;
      if (created && created.status() === 201) { connected = true; break; }
      const code = created ? String((await created.json().catch(() => ({})))?.error?.code || created.status()) : 'no_response';
      if (created && created.status() !== 503) {
        throw new Error(`The meeting did not start (HTTP ${created.status()}, ${code}).`);
      }
      await page.waitForTimeout(PROPAGATION_RETRY_MS);
    }
    assert.equal(connected, true, 'The conversation probe could not start a meeting.');

    // The append-only transcript history is the stable record of every spoken
    // line (captions are transient). Read both roles after each turn.
    const readLines = async (role) => page.evaluate((r) => {
      const list = document.getElementById('realtimeVoiceTranscriptHistory');
      if (!list) return [];
      return [...list.querySelectorAll(`li.realtime-history-item.is-${r} p`)]
        .map((p) => p.textContent.trim())
        .filter(Boolean);
    }, role);
    const readServerTurns = async () => page.evaluate(async ({ workerOriginValue, sessionIdValue, credentialValue }) => {
      const response = await fetch(`${workerOriginValue}/api/consumer/sessions/${encodeURIComponent(sessionIdValue)}`, {
        headers: { Accept: 'application/json', 'X-Consumer-Session': credentialValue }
      });
      if (!response.ok) return { ok: false, status: response.status };
      const payload = await response.json();
      return {
        ok: true,
        realtimeTurns: Array.isArray(payload.realtimeTurns)
          ? payload.realtimeTurns.map((t) => ({ role: t.role, text: String(t.transcript || '').slice(0, 200) }))
          : [],
        leaseStatus: payload.realtimeLease?.status || null,
        closeReason: payload.realtimeLease?.closeReason || null
      };
    }, { workerOriginValue: workerOrigin, sessionIdValue: sessionId, credentialValue: credential }).catch((e) => ({ ok: false, error: String(e) }));

    // Wait for the greeting line to be spoken before the first turn.
    await page.waitForFunction(() => {
      const list = document.getElementById('realtimeVoiceTranscriptHistory');
      return list && list.querySelector('li.realtime-history-item.is-assistant p');
    }, null, { timeout: PROBE_TIMEOUT_MS }).catch(() => {});
    const greeting = (await readLines('assistant'))[0] || '';
    record('planéir', greeting || '(no greeting captured)');

    // Diagnostic-first: never throw mid-conversation. Record everything —
    // what the model transcribed of my speech (proves audio reached the
    // provider), what Planéir said back, and the server's turn ledger — then
    // assert at the very end so one run reveals the whole picture.
    const failures = [];
    for (let index = 0; index < CONVERSATION.length; index += 1) {
      const turn = CONVERSATION[index];
      const beforeAssistant = (await readLines('assistant')).length;
      const beforeUser = (await readLines('user')).length;
      record('you (intended)', turn.say);
      const duration = await page.evaluate((wav) => window.__probe.speak(wav), turnsAudio[index]);
      await page.waitForTimeout(Math.min(20_000, Math.ceil((duration || 3) * 1000) + 600));
      await start.click().catch(() => {}); // explicit "I've finished speaking"

      let newAssistant = [];
      const replyDeadline = Date.now() + TURN_REPLY_TIMEOUT_MS;
      while (Date.now() < replyDeadline) {
        await page.waitForTimeout(1_000);
        const current = await readLines('assistant');
        if (current.length > beforeAssistant) { newAssistant = current.slice(beforeAssistant); break; }
      }
      const heardUser = (await readLines('user')).slice(beforeUser);
      if (heardUser.length) record('you (model heard)', heardUser.join(' '));
      const reply = newAssistant.join(' ').trim();
      record('planéir', reply || '(no reply — dead air)');

      if (turn.expectReply && newAssistant.length === 0) {
        failures.push(`Turn "${turn.label}" received no spoken reply (dead air).`);
      }
      if (turn.mustNotRepeatGreeting && greeting && reply.slice(0, 40) === greeting.slice(0, 40)) {
        failures.push(`Turn "${turn.label}" repeated the greeting instead of responding.`);
      }
      if (turn.mustNotMatch && turn.mustNotMatch.test(reply)) {
        failures.push(`Turn "${turn.label}" asked a category menu instead of inferring the classification: "${reply.slice(0, 120)}"`);
      }
    }
    const serverTurns = await readServerTurns();
    const consoleErrors = pageConsoleErrors.slice(-8);
    return { transcript, serverTurns, consoleErrors, failures, sessionId };
  } finally {
    await browser.close().catch(() => {});
    // A diagnostic run can retain the disposable session so the server-side
    // tool ledger is inspectable; it still auto-expires on its short TTL.
    if (String(process.env.KEEP_PROBE_SESSION || '').trim() === 'true') {
      console.log(`\nKEEP_PROBE_SESSION set — retained session ${sessionId} for inspection.`);
    } else {
      await requestJson(workerBaseUrl, `/api/consumer/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE', origin: smokeOrigin,
        headers: { 'X-Consumer-Session': credential },
        acceptedStatuses: [200, 404], diagnosticPath: '/api/consumer/sessions/[probe]'
      }).catch(() => {});
    }
  }
}

function printResult(result) {
  console.log('\n===== CONVERSATION TRANSCRIPT =====');
  for (const line of result.transcript || []) {
    console.log(`\n[${line.role}] ${line.text}`);
  }
  console.log('\n===== SERVER TURN LEDGER =====');
  console.log(JSON.stringify(result.serverTurns, null, 2));
  if (result.consoleErrors?.length) {
    console.log('\n===== PAGE CONSOLE ERRORS =====');
    for (const line of result.consoleErrors) console.log(`- ${line}`);
  }
}

async function main() {
  const result = await runRealtimeConversationProbe({
    workerBaseUrl: String(process.env.WORKER_BASE_URL || '').trim().replace(/\/+$/, ''),
    smokeOrigin: String(process.env.SMOKE_ORIGIN || '').trim(),
    password: String(process.env.ADVISOR_SMOKE_PASSWORD || '').trim(),
    openaiKey: String(process.env.OPENAI_API_KEY || '').trim()
  });
  printResult(result);
  if (result.failures?.length) {
    console.log('\n===== FAILURES =====');
    for (const line of result.failures) console.log(`- ${line}`);
    throw new Error(`Conversation probe found ${result.failures.length} problem(s).`);
  }
  console.log('\nConversation probe passed — the meeting held a natural conversation.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nConversation probe failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
