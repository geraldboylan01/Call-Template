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
const {
  classifyRealtimeEvent,
  extractRealtimePlanningContext,
  normaliseRealtimeCallResponse,
  RealtimeVoiceController
} = await import('../js/plan/realtime_voice.js');
const {
  getAnalysisPlanNonce,
  mergePayload,
  normaliseBootstrap,
  state: journeyState
} = await import('../js/plan/store.js');

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
const realtimeSource = readFileSync(`${rootPath}/js/plan/realtime_voice.js`, 'utf8');
const storeSource = readFileSync(`${rootPath}/js/plan/store.js`, 'utf8');
const viewsSource = readFileSync(`${rootPath}/js/plan/views.js`, 'utf8');
const planCssSource = readFileSync(`${rootPath}/styles/plan.css`, 'utf8');
const privacySource = readFileSync(`${rootPath}/plan/privacy.html`, 'utf8');
const planIndexSource = readFileSync(`${rootPath}/plan/index.html`, 'utf8');
assert.match(appSource, /const draft = captureConversationDraft\(appRoot\)[\s\S]*renderCurrentJourney\(\)[\s\S]*restoreConversationDraft\(appRoot, draft\)/);
assert.match(appSource, /async function handleDeleteSession\(\) \{\s*await realtimeVoiceController\.end\(\{ reason: 'deletion' \}\);\s*voiceController\.cancelActiveVoice\(\{ reason: 'deletion', refreshBudget: false \}\)/);
assert.match(appSource, /deleteSessionButton\.addEventListener\('click',[\s\S]*realtimeVoiceController\.end\(\{ reason: 'deletion' \}\)[\s\S]*voiceController\.cancelActiveVoice\(\{ reason: 'deletion', refreshBudget: false \}\)[\s\S]*openDialog\(deleteSessionDialog\)/);
assert.match(viewsSource, /app allowance/);
assert.match(viewsSource, /fixed conservative reservation/);
assert.match(privacySource, /conservative application reservation rather than promising an exact provider/);
assert.match(privacySource, /separately billed Realtime-response and input-transcription usage/);
assert.match(privacySource, /Partial caption streams are not retained/);
assert.match(privacySource, /final, it is processed automatically as the next live turn/);
assert.match(privacySource, /one final profile-and-module review/);
assert.match(planIndexSource, /id="realtimeVoiceShell"/);
assert.ok(
  planIndexSource.indexOf('id="realtimeVoiceShell"') > planIndexSource.indexOf('id="appRoot"'),
  'The persistent realtime shell must live after and outside the rerendered appRoot.'
);
assert.match(planIndexSource, /id="realtimeVoiceTranscriptHistory"[\s\S]*aria-live="polite"/);
assert.match(planIndexSource, /id="realtimeVoiceFactsList"/);
assert.match(planIndexSource, /id="realtimeVoiceModulesList"/);
assert.match(planIndexSource, /id="realtimeVoiceConsentDialog"/);
assert.doesNotMatch(realtimeSource, /appendTranscriptForReview|\/turns/);
assert.doesNotMatch(realtimeSource, /sendEvent\(\{\s*type:\s*'response\.cancel'/);
assert.match(realtimeSource, /input_audio_buffer\.speech_started/);
assert.match(realtimeSource, /MAX_TRANSCRIPT_ITEMS/);
assert.match(realtimeSource, /classList\.toggle\('is-budget-low', budgetLow\)/);
assert.match(realtimeSource, /setPhase\('interrupted', 'Planéir stopped speaking\./);
assert.match(planCssSource, /\.realtime-voice-shell\.is-budget-low \.realtime-budget-card/);
const outboundRealtimeEventTypes = [...realtimeSource.matchAll(/sendEvent\(\{\s*type:\s*'([^']+)'/g)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(outboundRealtimeEventTypes, ['input_audio_buffer.clear']);
assert.match(realtimeSource, /'complete'[\s\S]*'withdrawn'[\s\S]*'deleted'[\s\S]*'budget_exhausted'/);
assert.doesNotMatch(realtimeSource, /sendEvent\(\{\s*type:\s*'(?:response\.create|session\.update)'/);
assert.match(apiSource, /\/voice\/realtime\/consent/);
assert.match(apiSource, /\/voice\/realtime\/calls/);
assert.match(appSource, /action:\s*'prepare'[\s\S]*expectedRevision:[\s\S]*moduleIds:/);
assert.match(appSource, /action:\s*'confirm_and_run'[\s\S]*planId,[\s\S]*planNonce,[\s\S]*confirmation:\s*true/);
assert.doesNotMatch(appSource, /runAnalyses\(/);
const confirmPlanRequestSource = appSource.slice(
  appSource.indexOf("action: 'confirm_and_run'"),
  appSource.indexOf("action: 'confirm_and_run'") + 420
);
assert.doesNotMatch(confirmPlanRequestSource, /moduleIds|scenarioOverrides/);
assert.doesNotMatch(appSource, /planNonce:\s*newIdempotencyKey|planNonce:\s*crypto\./);
assert.match(storeSource, /state\.selectedModuleIds = \[\.\.\.new Set\(state\.analysisPlan\.moduleIds\)\]/);
const transcriptionApiSource = apiSource.slice(
  apiSource.indexOf('export function transcribeVoice'),
  apiSource.indexOf('export function speakNextQuestion')
);
assert.doesNotMatch(transcriptionApiSource, /FormData|formData/);
assert.match(transcriptionApiSource, /rawBody:\s*audio/);
assert.match(transcriptionApiSource, /'X-Voice-Duration-Ms'/);
assert.match(transcriptionApiSource, /'X-Voice-Request-Id'/);

const rawRealtimeCall = normaliseRealtimeCallResponse({
  body: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n',
  contentType: 'application/sdp',
  headers: new Headers({
    'X-Realtime-Lease-Id': 'rt_lease_frontend_001',
    'X-Realtime-Hard-Expires-At': '2030-01-01T00:00:00.000Z',
    'X-Realtime-Budget-Micro-Eur': '1750000'
  })
});
assert.match(rawRealtimeCall.sdp, /^v=0/);
assert.equal(rawRealtimeCall.leaseId, 'rt_lease_frontend_001');
assert.equal(rawRealtimeCall.expiresAt, '2030-01-01T00:00:00.000Z');
assert.equal(rawRealtimeCall.budget.remainingMicroEur, 1_750_000);
assert.deepEqual(rawRealtimeCall.payload, {
  realtimeVoiceBudget: {
    limitMicroEur: null,
    spentMicroEur: null,
    remainingMicroEur: 1_750_000
  }
});

const headerDurationCall = normaliseRealtimeCallResponse({
  body: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n',
  contentType: 'application/sdp',
  headers: new Headers({ 'X-Voice-Realtime-Max-Duration-Ms': '90000' })
});
assert.equal(headerDurationCall.maxDurationMs, 90_000);

const jsonRealtimeCall = normaliseRealtimeCallResponse({
  body: JSON.stringify({
    data: {
      answer: { sdp: 'v=0\r\no=- 2 3 IN IP4 127.0.0.1\r\n' },
      lease: { id: 'rt_json_lease', maxDurationMs: 120000 }
    }
  }),
  contentType: 'application/json',
  headers: new Headers()
});
assert.equal(jsonRealtimeCall.leaseId, 'rt_json_lease');
assert.equal(jsonRealtimeCall.maxDurationMs, 120000);

assert.deepEqual(
  classifyRealtimeEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_1',
    transcript: 'We have about €50,000 saved.'
  }),
  {
    type: 'conversation.item.input_audio_transcription.completed',
    kind: 'user_final',
    itemId: 'item_1',
    text: 'We have about €50,000 saved.',
    event: {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_1',
      transcript: 'We have about €50,000 saved.'
    }
  }
);
assert.equal(classifyRealtimeEvent({ type: 'input_audio_buffer.speech_started' }).kind, 'speech_started');
assert.equal(classifyRealtimeEvent({ type: 'response.output_audio.delta' }).kind, 'assistant_audio');

const planningContext = extractRealtimePlanningContext({
  planning: {
    facts: [{ path: '/goals/0/targetAmount', label: 'Target', value: 350000, certainty: 'approximate' }],
    modules: [{ moduleId: 'house_purchase', status: 'recommended' }],
    readyForReview: true
  }
}, { profile: null, recommendations: [] });
assert.equal(planningContext.facts[0].badge.label, 'Approximate');
assert.equal(planningContext.modules[0].label, 'House purchase');
assert.equal(planningContext.readyForReview, true);

const independentRealtimeBootstrap = normaliseBootstrap({
  flags: {
    consumerJourneyEnabled: true,
    consumerVoiceEnabled: false,
    consumerRealtimeVoiceEnabled: true
  },
  cohort: 'adviser_test',
  voice: { enabled: false, sessionBudgetMicroEur: 0 },
  realtimeVoice: {
    enabled: true,
    noticeId: 'realtime-notice-v1',
    policyVersion: 'consumer-v1',
    privacyNoticeUrl: 'https://planeir.ie/privacy',
    sessionBudgetMicroEur: 2_000_000
  }
});
assert.equal(independentRealtimeBootstrap.voiceEnabled, false);
assert.equal(independentRealtimeBootstrap.voiceRealtimeEnabled, true);
assert.equal(independentRealtimeBootstrap.realtimeVoiceBudget.limitMicroEur, 2_000_000);

storage.set('planeir.consumer.analysis-plan-id.v1', 'realtime_plan_stale');
storage.set('planeir.consumer.analysis-plan-nonce.v1', 'plan_nonce_stale');
journeyState.session = { id: 'cs_frontend_voice_contract', currentProfileRevision: 7 };
journeyState.analysisPlan = null;
journeyState.selectedModuleIds = [];
mergePayload({
  session: { id: 'cs_frontend_voice_contract', currentProfileRevision: 7 },
  analysisPlan: {
    planId: 'realtime_plan_restored',
    moduleIds: ['house_purchase'],
    profileRevision: 7,
    status: 'prepared'
  }
});
assert.deepEqual(journeyState.selectedModuleIds, ['house_purchase']);
assert.equal(getAnalysisPlanNonce('realtime_plan_restored'), '');
assert.equal(storage.has('planeir.consumer.analysis-plan-nonce.v1'), false);
mergePayload({
  analysisPlan: {
    planId: 'realtime_plan_restored',
    planNonce: 'plan_nonce_server_issued_only',
    moduleIds: ['house_purchase'],
    profileRevision: 7,
    status: 'prepared'
  }
});
assert.equal(getAnalysisPlanNonce('realtime_plan_restored'), 'plan_nonce_server_issued_only');

const realtimeClassStates = new Map();
const realtimeControllerRoot = {
  dataset: {},
  classList: {
    toggle: (name, enabled) => realtimeClassStates.set(name, enabled === true)
  },
  querySelector: () => null
};
journeyState.bootstrap = {
  enabled: true,
  voiceRealtimeEnabled: true,
  cohort: 'adviser_test',
  voiceRealtimeMaxSeconds: 600,
  voiceRealtimePollSeconds: 20
};
journeyState.voice.realtimeBudget = {
  limitMicroEur: 2_000_000,
  spentMicroEur: 1_750_000,
  remainingMicroEur: 250_000
};
const realtimeController = new RealtimeVoiceController({ root: realtimeControllerRoot });
realtimeController.updateUi();
assert.equal(realtimeClassStates.get('is-budget-low'), true);
assert.equal(realtimeControllerRoot.dataset.budgetState, 'low');
journeyState.voice.realtimeBudget.remainingMicroEur = 350_000;
realtimeController.updateUi();
assert.equal(realtimeClassStates.get('is-budget-low'), false);
assert.equal(realtimeControllerRoot.dataset.budgetState, 'available');

const sentRealtimeEvents = [];
realtimeController.active = true;
realtimeController.responseInProgress = true;
realtimeController.phase = 'assistant_speaking';
realtimeController.dataChannel = {
  readyState: 'open',
  send: (value) => sentRealtimeEvents.push(JSON.parse(value)),
  close: () => {}
};
realtimeController.handleRealtimeEvent({ type: 'input_audio_buffer.speech_started' });
assert.equal(sentRealtimeEvents.length, 0);
assert.equal(realtimeController.phase, 'interrupted');
assert.notEqual(realtimeController.interruptTimer, null);
realtimeController.handleRealtimeEvent({ type: 'input_audio_buffer.speech_stopped' });
assert.equal(realtimeController.interruptTimer, null);
assert.equal(realtimeController.phase, 'thinking');
realtimeController.cleanupLocal();

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

const {
  createRealtimeVoiceCall,
  deleteRealtimeVoiceCall,
  getRealtimeVoiceCall
} = await import('../js/plan/api.js');
const realtimeRequests = [];
try {
  globalThis.fetch = async (url, init) => {
    realtimeRequests.push({ url: String(url), init });
    if (init.method === 'POST') {
      return new Response('v=0\r\no=- 4 5 IN IP4 127.0.0.1\r\n', {
        status: 200,
        headers: {
          'Content-Type': 'application/sdp',
          'X-Voice-Lease-Id': 'rt_api_contract_001'
        }
      });
    }
    return new Response(JSON.stringify({ lease: { id: 'rt_api_contract_001', status: 'active' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const offerSdp = 'v=0\r\no=- 7 8 IN IP4 127.0.0.1\r\n';
  const created = await createRealtimeVoiceCall('cs_frontend_voice_contract', {
    sdp: offerSdp,
    idempotencyKey: 'voice-realtime-contract-0001'
  });
  assert.match(created.body, /^v=0/);
  await getRealtimeVoiceCall('cs_frontend_voice_contract', 'rt_api_contract_001');
  await deleteRealtimeVoiceCall('cs_frontend_voice_contract', 'rt_api_contract_001');
  assert.equal(realtimeRequests[0].url, 'http://127.0.0.1:8787/api/consumer/sessions/cs_frontend_voice_contract/voice/realtime/calls');
  assert.equal(realtimeRequests[0].init.body, offerSdp);
  const realtimeHeaders = new Headers(realtimeRequests[0].init.headers);
  assert.equal(realtimeHeaders.get('content-type'), 'application/sdp');
  assert.equal(realtimeHeaders.get('x-consumer-session'), 'cs_frontend_voice_contract.test-secret');
  assert.equal(realtimeRequests[1].url, 'http://127.0.0.1:8787/api/consumer/sessions/cs_frontend_voice_contract/voice/realtime/calls/rt_api_contract_001');
  assert.equal(realtimeRequests[1].init.method, 'GET');
  assert.equal(realtimeRequests[2].init.method, 'DELETE');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Consumer bounded and realtime voice lifecycle, SDP, consent, transcript, planning-context, and accessibility checks passed.');
