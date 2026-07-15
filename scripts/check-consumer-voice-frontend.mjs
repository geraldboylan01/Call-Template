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
const { getAvailableViews } = await import('../js/plan/views.js');

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
assert.match(privacySource, /Realtime-response, input-transcription, and character-priced approved speech/);
assert.match(privacySource, /direct\s+model audio is disabled and never attached for\s+playback/);
assert.match(privacySource, /content-bound\s+by a signed\s+authorization/);
assert.match(privacySource, /Partial caption streams are not retained/);
assert.match(privacySource, /final, it is processed automatically as the next live turn/);
assert.match(privacySource, /one final profile-and-module review/);
assert.match(planIndexSource, /id="realtimeVoiceShell"/);
assert.ok(
  planIndexSource.indexOf('id="realtimeVoiceShell"') > planIndexSource.indexOf('id="appRoot"'),
  'The persistent realtime shell must live after and outside the rerendered appRoot.'
);
assert.match(planIndexSource, /id="realtimeVoiceCompanion"/);
assert.match(planIndexSource, /id="realtimeVoiceLauncher"[\s\S]*Talk to Planéir/);
assert.match(planIndexSource, /id="realtimeVoiceLauncher"[\s\S]*aria-controls="realtimeVoiceShell"/);
assert.match(planIndexSource, /id="realtimeVoiceShell"[\s\S]*role="dialog"[\s\S]*aria-modal="true"/);
assert.match(planIndexSource, /id="realtimeVoiceCollapseButton"/);
assert.match(planIndexSource, /id="realtimeVoiceMuteButton"[\s\S]*id="realtimeVoiceEndButton"[\s\S]*id="realtimeVoiceFocusComposerButton"[\s\S]*id="realtimeVoiceReviewButton"/);
assert.match(planIndexSource, /id="realtimeVoiceBoundedFallbackButton"/);
assert.equal(
  [...planIndexSource.matchAll(/class="is-empty is-module-slot"/g)].length,
  3,
  'The unopened companion must reserve exactly three visible analysis slots.'
);
assert.match(planIndexSource, /id="realtimeVoiceTranscriptHistory"[\s\S]*aria-live="polite"/);
assert.match(planIndexSource, /id="realtimeVoiceFactsList"/);
assert.match(planIndexSource, /id="realtimeVoiceModulesList"/);
assert.match(planIndexSource, /id="realtimeVoiceConsentDialog"/);
assert.match(appSource, /root:\s*document\.getElementById\('realtimeVoiceCompanion'\)/);
assert.match(realtimeSource, /openCompanion\(\{ focus = true \} = \{\}\)/);
assert.match(realtimeSource, /collapseCompanion\(\{ restoreFocus = true \} = \{\}\)/);
const collapseCompanionSource = realtimeSource.slice(
  realtimeSource.indexOf('collapseCompanion({ restoreFocus = true } = {})'),
  realtimeSource.indexOf('trapFocus(event)')
);
assert.doesNotMatch(collapseCompanionSource, /this\.end\(/, 'Minimising the drawer must not stop an active microphone session.');
const reviewAndConfirmSource = realtimeSource.slice(
  realtimeSource.indexOf('\n  reviewAndConfirm() {'),
  realtimeSource.indexOf('configureLeaseExpiry(')
);
assert.doesNotMatch(reviewAndConfirmSource, /this\.end\(/, 'Opening the profile-and-module review must not stop an active voice session.');
assert.match(realtimeSource, /if \(event\.key === 'Escape'\)[\s\S]*this\.collapseCompanion\(\)/);
assert.match(realtimeSource, /if \(event\.key === 'Tab'\) this\.trapFocus\(event\)/);
assert.match(realtimeSource, /if \(document\.hidden\)[\s\S]*this\.end\(\{ reason: 'hidden' \}\)[\s\S]*this\.collapseCompanion/);
assert.match(realtimeSource, /modules\.slice\(0, 3\)/);
assert.match(realtimeSource, /for \(let index = 0; index < 3; index \+= 1\)/);
assert.doesNotMatch(realtimeSource, /appendTranscriptForReview|\/turns/);
assert.doesNotMatch(realtimeSource, /sendEvent\(\{\s*type:\s*'response\.cancel'/);
assert.match(realtimeSource, /input_audio_buffer\.speech_started/);
assert.match(realtimeSource, /MAX_TRANSCRIPT_ITEMS/);
assert.match(realtimeSource, /classList\.toggle\('is-budget-low', budgetLow\)/);
assert.match(realtimeSource, /setPhase\('interrupted', 'Planéir stopped speaking\./);
assert.match(planCssSource, /\.realtime-voice-shell\.is-budget-low \.realtime-budget-card/);
assert.match(planCssSource, /\.realtime-voice-launcher\s*\{/);
assert.match(planCssSource, /body\.realtime-companion-open/);
assert.match(planCssSource, /\.realtime-voice-shell\s*\{[\s\S]*width:\s*min\(33rem/);
assert.match(planCssSource, /@media \(max-width: 720px\)[\s\S]*\.realtime-voice-shell\s*\{[\s\S]*max-height:\s*100dvh/);
assert.match(planCssSource, /env\(safe-area-inset-bottom/);
assert.match(planCssSource, /min-height:\s*44px/);
assert.match(planCssSource, /@media \(prefers-reduced-motion: reduce\)/);
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
assert.match(appSource, /state\.selectedModuleIds\.length === 0 && state\.recommendations\.length !== 3/);
assert.match(viewsSource, /Confirm profile & save review plan/);
assert.match(viewsSource, /Your authoritative three-analysis plan is shown below/);
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
for (const type of ['conversation.item.created', 'conversation.item.added']) {
  const planningUpdate = classifyRealtimeEvent({
    type,
    item: {
      type: 'function_call_output',
      output: JSON.stringify({ ok: true, assistantSpeech: { speechId: 'speech_test', text: 'Approved.' } })
    }
  });
  assert.equal(planningUpdate.kind, 'planning_update');
  assert.equal(planningUpdate.payload.assistantSpeech.text, 'Approved.');
}

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

const workerFactContext = extractRealtimePlanningContext({
  planningState: {
    facts: [{
      factId: 'gross_household_income',
      value: { amount: 65000, currency: 'EUR' },
      certainty: 'approximate',
      status: 'saved_draft'
    }]
  }
}, { profile: null, recommendations: [] });
assert.equal(workerFactContext.facts[0].factId, 'gross_household_income');
assert.equal(workerFactContext.facts[0].label, 'Gross household income');
assert.equal(workerFactContext.facts[0].value, '€65,000');
assert.equal(workerFactContext.facts[0].badge.label, 'Approximate');
assert.doesNotMatch(workerFactContext.facts[0].value, /\[object Object\]/);

const authoritativeSlots = extractRealtimePlanningContext({
  planningState: {
    moduleSlots: [
      {
        slot: 1,
        moduleId: 'personal_balance_sheet',
        availability: 'adviser_review_required',
        reasons: ['This deterministic analysis is waiting for its consumer release gate.']
      },
      {
        slot: 2,
        moduleId: 'house_purchase',
        availability: 'ready',
        reasons: ['The immediate home-purchase goal requires this analysis.']
      },
      {
        slot: 3,
        moduleId: 'liquidity_analysis',
        availability: 'needs_facts',
        reasons: ['More confirmed information is required.']
      }
    ],
    recommendations: [
      { moduleId: 'mortgage_analysis', status: 'recommended' },
      { moduleId: 'college_funding', status: 'recommended' }
    ]
  }
}, { profile: null, recommendations: [] });
assert.deepEqual(
  authoritativeSlots.modules.map((item) => item.moduleId),
  ['personal_balance_sheet', 'house_purchase', 'liquidity_analysis'],
  'The companion must render the Worker-authoritative three slots, not the broader recommendation list.'
);
assert.equal(authoritativeSlots.modules[0].badge.label, 'Gerry review');
assert.equal(authoritativeSlots.modules[1].badge.label, 'Released');
assert.equal(authoritativeSlots.modules[2].badge.label, 'Needs information');

const pristineProfileContext = extractRealtimePlanningContext({}, {
  profile: {
    primaryPerson: { personId: 'primary', role: 'primary', employmentStatus: 'unknown' },
    preferences: { baseCurrency: 'EUR', riskDiscussionCompleted: false },
    assumptions: { calculationDateIso: '2026-07-14', values: { persona: {} } },
    fieldMetadata: {}
  },
  recommendations: []
});
assert.equal(
  pristineProfileContext.facts.length,
  0,
  'System identifiers and default policy/calculation values must not appear as facts Planéir understood.'
);
const userSuppliedProfileContext = extractRealtimePlanningContext({}, {
  profile: {
    primaryPerson: { age: 38 },
    fieldMetadata: {
      '/primaryPerson/age': {
        source: 'consumer_edit', certainty: 'exact', confirmedByUser: false
      }
    }
  },
  recommendations: []
});
assert.equal(userSuppliedProfileContext.facts.length, 1);
assert.equal(userSuppliedProfileContext.facts[0].label, 'Age');

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

const gatedViewAvailability = getAvailableViews({
  session: { currentProfileRevision: 7, confirmedProfileRevision: 7 },
  profile: { revision: 7 },
  analysis: null,
  analysisPlan: {
    profileRevision: 7,
    status: 'complete',
    moduleIds: [],
    moduleSlots: [
      { slot: 1, moduleId: 'personal_balance_sheet', availability: 'adviser_review_required' },
      { slot: 2, moduleId: 'business_owner_analysis', availability: 'adviser_review_required' },
      { slot: 3, moduleId: 'business_relief_analysis', availability: 'adviser_review_required' }
    ]
  },
  bootstrap: { handoffEnabled: true }
});
assert.equal(gatedViewAvailability.results, true, 'a completed all-gated plan has a deterministic review outcome');
assert.equal(gatedViewAvailability.handoff, true, 'the explicit consented handoff remains reachable after an all-gated plan');

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

storage.set('planeir.consumer.session-id.v1', 'cs_frontend_voice_contract');
journeyState.view = 'review';
realtimeController.sync(journeyState);
assert.equal(
  realtimeControllerRoot.hidden,
  false,
  'The floating companion must remain available while the consumer reviews their information.'
);
journeyState.view = 'results';
realtimeController.sync(journeyState);
assert.equal(
  realtimeControllerRoot.hidden,
  false,
  'The floating companion must remain available to present verified results.'
);
journeyState.view = 'conversation';

const remoteAudioElement = { srcObject: 'worker-controlled-audio-only' };
const remotePeerListeners = new Map();
const remoteTrackController = new RealtimeVoiceController({
  root: {
    querySelector: (selector) => selector === '#realtimeVoiceAudio' ? remoteAudioElement : null
  }
});
const remotePeer = {
  addEventListener: (type, listener) => remotePeerListeners.set(type, listener)
};
remoteTrackController.bindPeerConnection(remotePeer, remoteTrackController.generation);
const providerAudioTrack = { enabled: true };
remotePeerListeners.get('track')?.({ track: providerAudioTrack, streams: [{ id: 'provider-stream' }] });
assert.equal(providerAudioTrack.enabled, false, 'A provider audio track must be disabled before it can become audible.');
assert.equal(
  remoteAudioElement.srcObject,
  'worker-controlled-audio-only',
  'The provider media stream must never be assigned to the companion audio element.'
);

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

const floatingPanel = { hidden: true };
const floatingBackdrop = { hidden: true };
const floatingLauncherAttributes = new Map();
const floatingLauncher = {
  setAttribute: (name, value) => floatingLauncherAttributes.set(name, value),
  focus: () => {}
};
const floatingElements = new Map([
  ['#realtimeVoiceShell', floatingPanel],
  ['#realtimeVoiceBackdrop', floatingBackdrop],
  ['#realtimeVoiceLauncher', floatingLauncher]
]);
const floatingRoot = {
  hidden: false,
  classList: { toggle: () => {} },
  querySelector: (selector) => floatingElements.get(selector) || null
};
const floatingController = new RealtimeVoiceController({ root: floatingRoot });
floatingController.active = true;
floatingController.openCompanion({ focus: false });
assert.equal(floatingController.expanded, true);
assert.equal(floatingPanel.hidden, false);
assert.equal(floatingBackdrop.hidden, false);
assert.equal(floatingLauncherAttributes.get('aria-expanded'), 'true');
floatingController.collapseCompanion({ restoreFocus: false });
assert.equal(floatingController.expanded, false);
assert.equal(floatingPanel.hidden, true);
assert.equal(floatingBackdrop.hidden, true);
assert.equal(floatingLauncherAttributes.get('aria-expanded'), 'false');
assert.equal(floatingController.active, true, 'Minimising the companion must keep the active microphone lifecycle intact.');

let fallbackView = '';
const fallbackController = new RealtimeVoiceController({
  root: floatingRoot,
  onNavigate: (view) => { fallbackView = view; }
});
fallbackController.focusComposer();
assert.equal(fallbackView, 'conversation', 'Type instead must return to the written conversation from review or results.');
fallbackView = '';
fallbackController.focusBoundedVoice();
assert.equal(fallbackView, 'conversation', 'The bounded voice fallback must return to the conversation before focusing its controls.');

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
  getRealtimeVoiceCall,
  speakRealtimeAuthorized
} = await import('../js/plan/api.js');
const realtimeRequests = [];
try {
  globalThis.fetch = async (url, init) => {
    realtimeRequests.push({ url: String(url), init });
    if (String(url).endsWith('/speech')) {
      return new Response(new Uint8Array([73, 68, 51]), {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
          'X-Realtime-Speech-Id': 'speech_api_contract_1234567890'
        }
      });
    }
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
  const speechAuthorization = {
    speechId: 'speech_api_contract_1234567890',
    kind: 'question',
    profileRevision: 7,
    bindingId: 'tool_attempt_api_contract_001',
    text: 'What would you like help planning first?',
    token: 'signed_api_contract_token_1234567890'
  };
  const speechResponse = await speakRealtimeAuthorized(
    'cs_frontend_voice_contract',
    'rt_api_contract_001',
    speechAuthorization
  );
  assert.equal(speechResponse.contentType, 'audio/mpeg');
  assert.equal(realtimeRequests[0].url, 'http://127.0.0.1:8787/api/consumer/sessions/cs_frontend_voice_contract/voice/realtime/calls');
  assert.equal(realtimeRequests[0].init.body, offerSdp);
  const realtimeHeaders = new Headers(realtimeRequests[0].init.headers);
  assert.equal(realtimeHeaders.get('content-type'), 'application/sdp');
  assert.equal(realtimeHeaders.get('x-consumer-session'), 'cs_frontend_voice_contract.test-secret');
  assert.equal(realtimeRequests[1].url, 'http://127.0.0.1:8787/api/consumer/sessions/cs_frontend_voice_contract/voice/realtime/calls/rt_api_contract_001');
  assert.equal(realtimeRequests[1].init.method, 'GET');
  assert.equal(realtimeRequests[2].init.method, 'DELETE');
  assert.equal(
    realtimeRequests[3].url,
    'http://127.0.0.1:8787/api/consumer/sessions/cs_frontend_voice_contract/voice/realtime/calls/rt_api_contract_001/speech'
  );
  assert.equal(realtimeRequests[3].init.method, 'POST');
  assert.deepEqual(JSON.parse(realtimeRequests[3].init.body), speechAuthorization);
} finally {
  globalThis.fetch = originalFetch;
}

const approvedAudio = {
  dataset: {},
  muted: true,
  paused: true,
  src: '',
  srcObject: 'must-be-cleared-before-playback',
  onended: null,
  onerror: null,
  playCalls: 0,
  pauseCalls: 0,
  async play() {
    this.playCalls += 1;
    this.paused = false;
  },
  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  },
  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
};
const approvedCaption = { textContent: '' };
const approvedResumeButton = { hidden: true };
const approvedElements = new Map([
  ['#realtimeVoiceAudio', approvedAudio],
  ['#realtimeVoiceAssistantCaption', approvedCaption],
  ['#realtimeVoiceResumeAudioButton', approvedResumeButton]
]);
const approvedRoot = {
  dataset: {},
  classList: { toggle: () => {} },
  querySelector: (selector) => approvedElements.get(selector) || null
};
const approvedController = new RealtimeVoiceController({ root: approvedRoot });
approvedController.active = true;
approvedController.sessionId = 'cs_frontend_voice_contract';
approvedController.leaseId = 'rt_api_contract_001';
const approvedSpeech = {
  speechId: 'speech_frontend_playback_123456',
  kind: 'question',
  profileRevision: 7,
  bindingId: 'tool_attempt_frontend_001',
  text: 'What would you like help planning first?',
  token: 'signed_frontend_contract_token_1234567890'
};
const originalWindowUrl = window.URL;
const controlledSpeechRequests = [];
const revokedSpeechUrls = [];
try {
  window.URL = {
    createObjectURL: (blob) => {
      assert.ok(blob instanceof Blob);
      return 'blob:worker-controlled-speech';
    },
    revokeObjectURL: (url) => revokedSpeechUrls.push(url)
  };
  globalThis.fetch = async (url, init) => {
    controlledSpeechRequests.push({ url: String(url), init });
    return new Response(new Uint8Array([73, 68, 51]), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'X-Realtime-Speech-Id': approvedSpeech.speechId
      }
    });
  };
  await approvedController.playWorkerSpeechFromPayload({ assistantSpeech: approvedSpeech });
  assert.equal(controlledSpeechRequests.length, 1);
  assert.match(controlledSpeechRequests[0].url, /\/rt_api_contract_001\/speech$/);
  assert.deepEqual(JSON.parse(controlledSpeechRequests[0].init.body), approvedSpeech);
  assert.equal(approvedAudio.srcObject, null);
  assert.equal(approvedAudio.src, 'blob:worker-controlled-speech');
  assert.equal(approvedAudio.muted, false);
  assert.equal(approvedAudio.playCalls, 1);
  assert.equal(approvedAudio.dataset.controlledSpeechId, approvedSpeech.speechId);
  assert.equal(approvedAudio.dataset.controlledSpeechPlayed, 'true');
  assert.equal(approvedCaption.textContent, approvedSpeech.text);
  assert.deepEqual(approvedController.transcriptHistory, [{ role: 'assistant', text: approvedSpeech.text }]);
  assert.equal(approvedController.phase, 'assistant_speaking');

  approvedController.handleRealtimeEvent({ type: 'input_audio_buffer.speech_started' });
  assert.equal(approvedAudio.paused, true, 'Barge-in must stop the separately generated speech audio.');
  assert.equal(approvedAudio.src, '');
  assert.equal(approvedAudio.srcObject, null);
  assert.equal(approvedController.currentControlledSpeech, null);
  assert.equal(approvedController.phase, 'interrupted');
  assert.deepEqual(revokedSpeechUrls, ['blob:worker-controlled-speech']);
} finally {
  approvedController.cleanupLocal();
  window.URL = originalWindowUrl;
  globalThis.fetch = originalFetch;
}

console.log('Consumer bounded and controlled-realtime voice lifecycle, SDP, speech authorization, transcript, planning-context, and accessibility checks passed.');
