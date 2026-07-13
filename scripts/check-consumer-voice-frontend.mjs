import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootPath = fileURLToPath(new URL('..', import.meta.url));
const storage = new Map();

globalThis.window = {
  location: {
    hostname: 'localhost',
    href: 'http://localhost/plan/'
  },
  isSecureContext: true,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: (callback) => callback(),
  sessionStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  },
  MediaRecorder: class TestMediaRecorder {}
};
globalThis.document = {
  hidden: false,
  querySelector: () => null,
  getElementById: () => null,
  addEventListener: () => {},
  body: { classList: { add: () => {}, remove: () => {} } }
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { mediaDevices: { getUserMedia: async () => null } }
});

const {
  ConsumerVoiceController,
  appendTranscriptForReview,
  captureConversationDraft,
  crossedAccessibleCountdownThreshold,
  restoreConversationDraft,
  selectSupportedRecordingMimeType
} = await import('../js/plan/voice.js');

class WebmRecorder {
  static isTypeSupported(type) {
    return type === 'audio/webm;codecs=opus' || type === 'audio/webm';
  }
}
class OggRecorder {
  static isTypeSupported(type) {
    return type.startsWith('audio/ogg');
  }
}
class Mp4Recorder {
  static isTypeSupported(type) {
    return type.startsWith('audio/mp4');
  }
}
class UnsupportedRecorder {
  static isTypeSupported() {
    return false;
  }
}

assert.equal(selectSupportedRecordingMimeType(WebmRecorder), 'audio/webm;codecs=opus');
assert.equal(selectSupportedRecordingMimeType(OggRecorder), 'audio/ogg;codecs=opus');
assert.equal(selectSupportedRecordingMimeType(Mp4Recorder), 'audio/mp4;codecs=mp4a.40.2');
assert.equal(selectSupportedRecordingMimeType(UnsupportedRecorder), '');

const draftEvents = [];
const draftInput = {
  value: 'About €40,000, but I need to check.',
  selectionStart: 6,
  selectionEnd: 13,
  selectionDirection: 'forward',
  dispatchEvent: (event) => draftEvents.push(event.type),
  setSelectionRange(start, end, direction) {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
};
const draftRoot = {
  querySelector: (selector) => selector === '#conversationInput' ? draftInput : null
};
const draftSnapshot = captureConversationDraft(draftRoot);
draftInput.value = '';
draftInput.selectionStart = 0;
draftInput.selectionEnd = 0;
assert.equal(restoreConversationDraft(draftRoot, draftSnapshot), true);
assert.equal(draftInput.value, 'About €40,000, but I need to check.');
assert.deepEqual([draftInput.selectionStart, draftInput.selectionEnd], [6, 13]);
assert.deepEqual(draftEvents, ['input']);

let submittedTurns = 0;
const transcriptEvents = [];
const transcriptInput = {
  value: 'My salary is approximate.',
  maxLength: 3000,
  form: { requestSubmit: () => { submittedTurns += 1; } },
  dispatchEvent: (event) => transcriptEvents.push(event.type),
  focus: () => {},
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
};
appendTranscriptForReview(transcriptInput, 'Our savings are about €50,000.');
assert.equal(transcriptInput.value, 'My salary is approximate.\nOur savings are about €50,000.');
assert.deepEqual(transcriptEvents, ['input']);
assert.equal(submittedTurns, 0, 'Adding a transcript must never submit the planning form.');

assert.equal(crossedAccessibleCountdownThreshold(16, 15), 15);
assert.equal(crossedAccessibleCountdownThreshold(15, 14), null);
assert.equal(crossedAccessibleCountdownThreshold(6, 5), 5);
assert.equal(crossedAccessibleCountdownThreshold(16, 4), 5);

const timer = { textContent: '' };
const status = { textContent: '' };
const controllerRoot = {
  querySelector(selector) {
    if (selector === '[data-voice-timer]') return timer;
    if (selector === '[data-voice-status]') return status;
    return null;
  }
};
const countdownController = new ConsumerVoiceController({
  root: controllerRoot,
  currentQuestion: () => 'Test question'
});
countdownController.recording = {
  startedAt: performance.now() - 30_100,
  maxDurationMs: 45_000,
  previousRemainingSeconds: 16,
  announcedCountdownThresholds: new Set()
};
countdownController.updateTimer();
assert.match(status.textContent, /15 seconds of recording time remain/);

let recorderStops = 0;
let trackStops = 0;
let networkAborts = 0;
let sourceStops = 0;
let sourceDisconnects = 0;
const lifecycleController = new ConsumerVoiceController({
  root: { querySelector: () => null },
  currentQuestion: () => 'Test question'
});
lifecycleController.phase = 'recording';
lifecycleController.recording = {
  recorder: {
    state: 'recording',
    stop() {
      recorderStops += 1;
      this.state = 'inactive';
    }
  },
  stream: { getTracks: () => [{ stop: () => { trackStops += 1; } }] },
  chunks: [],
  startedAt: performance.now(),
  maxDurationMs: 45_000,
  shouldUpload: true,
  mimeType: 'audio/webm;codecs=opus',
  timeoutId: null,
  intervalId: null,
  error: null
};
lifecycleController.cancelActiveVoice({ reason: 'deletion', refreshBudget: false });
assert.equal(recorderStops, 1);
assert.ok(trackStops >= 1);
assert.match(lifecycleController.statusText, /discarded before upload/);

lifecycleController.phase = 'loading_speech';
lifecycleController.networkController = { abort: () => { networkAborts += 1; } };
lifecycleController.audioSource = {
  stop: () => { sourceStops += 1; },
  disconnect: () => { sourceDisconnects += 1; }
};
lifecycleController.cancelActiveVoice({ reason: 'deletion', refreshBudget: false });
assert.equal(networkAborts, 1);
assert.equal(sourceStops, 1);
assert.equal(sourceDisconnects, 1);
assert.doesNotMatch(lifecycleController.statusText, /nothing was submitted/i);
assert.match(lifecycleController.statusText, /server-side allowance remains authoritative/);

let budgetRefreshes = 0;
lifecycleController.refreshVoiceBudget = async () => { budgetRefreshes += 1; };
const refreshableAbort = {};
await lifecycleController.refreshVoiceBudgetAfterAbort(refreshableAbort, 'session-test');
assert.equal(budgetRefreshes, 1);
const deletionAbort = {};
lifecycleController.abortWithoutBudgetRefresh.add(deletionAbort);
await lifecycleController.refreshVoiceBudgetAfterAbort(deletionAbort, 'session-test');
assert.equal(budgetRefreshes, 1, 'Deletion/reset cancellation must not race a session-budget refresh.');

const appSource = readFileSync(`${rootPath}/js/plan/app.js`, 'utf8');
const apiSource = readFileSync(`${rootPath}/js/plan/api.js`, 'utf8');
const viewsSource = readFileSync(`${rootPath}/js/plan/views.js`, 'utf8');
const privacySource = readFileSync(`${rootPath}/plan/privacy.html`, 'utf8');
assert.match(appSource, /const draft = captureConversationDraft\(appRoot\)[\s\S]*renderCurrentJourney\(\)[\s\S]*restoreConversationDraft\(appRoot, draft\)/);
assert.match(appSource, /async function handleDeleteSession\(\) \{\s*voiceController\.cancelActiveVoice\(\{ reason: 'deletion', refreshBudget: false \}\)/);
assert.match(appSource, /deleteSessionButton\.addEventListener\('click',[\s\S]*voiceController\.cancelActiveVoice\(\{ reason: 'deletion', refreshBudget: false \}\)[\s\S]*openDialog\(deleteSessionDialog\)/);
assert.match(viewsSource, /app allowance/);
assert.match(viewsSource, /fixed conservative reservation/);
assert.match(privacySource, /fixed conservative reservation rather than measuring an exact provider bill/);
const transcriptionApiSource = apiSource.slice(
  apiSource.indexOf('export function transcribeVoice'),
  apiSource.indexOf('export function speakNextQuestion')
);
assert.doesNotMatch(transcriptionApiSource, /FormData|formData/);
assert.match(transcriptionApiSource, /rawBody:\s*audio/);
assert.match(transcriptionApiSource, /'X-Voice-Duration-Ms'/);
assert.match(transcriptionApiSource, /'X-Voice-Request-Id'/);

storage.set('planeir.consumer.credential.v1', 'cs_frontend_voice_contract.test-secret');
const { transcribeVoice } = await import('../js/plan/api.js');
const originalFetch = globalThis.fetch;
let capturedVoiceRequest = null;
try {
  globalThis.fetch = async (url, init) => {
    capturedVoiceRequest = { url: String(url), init };
    return new Response(JSON.stringify({ transcript: 'Review this transcript.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const rawAudio = new Blob([new Uint8Array([1, 2, 3, 4])], {
    type: 'audio/ogg;codecs=opus'
  });
  await transcribeVoice('cs_frontend_voice_contract', {
    audio: rawAudio,
    durationMs: 1_234,
    idempotencyKey: 'voice-frontend-contract-0001'
  });
  assert.equal(capturedVoiceRequest?.url, 'http://127.0.0.1:8787/api/consumer/sessions/cs_frontend_voice_contract/voice/transcriptions');
  assert.equal(capturedVoiceRequest?.init?.body, rawAudio);
  const rawHeaders = new Headers(capturedVoiceRequest?.init?.headers);
  assert.equal(rawHeaders.get('content-type'), 'audio/ogg;codecs=opus');
  assert.equal(rawHeaders.get('x-voice-duration-ms'), '1234');
  assert.equal(rawHeaders.get('x-voice-request-id'), 'voice-frontend-contract-0001');
  assert.equal(rawHeaders.get('content-length'), null, 'Browser code must not try to set the forbidden Content-Length header.');
  assert.equal(rawHeaders.get('x-consumer-session'), 'cs_frontend_voice_contract.test-secret');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Consumer voice frontend lifecycle, draft, format, accessibility, and review-only transcript checks passed.');
