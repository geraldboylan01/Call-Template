import {
  ConsumerApiError,
  getSession,
  speakNextQuestion,
  transcribeVoice,
  updateVoiceConsent
} from './api.js';
import {
  getSessionId,
  getVoiceConsent,
  hasCurrentVoiceConsent,
  mergeVoicePayload,
  state
} from './store.js';

const ADVISER_TEST_COHORT = 'adviser_test';
const HARD_MAX_RECORDING_MS = 45_000;
const DEFAULT_SESSION_LIMIT_MICRO_EUR = 2_000_000;
const MAX_RECORDING_BYTES = 1_000_000;
const MIN_RECORDING_MS = 350;
const RECORDING_MIME_TYPES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/webm',
  'audio/ogg',
  'audio/mp4'
]);
const ACCESSIBLE_COUNTDOWN_THRESHOLDS = Object.freeze([15, 5]);

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function unwrap(payload) {
  if (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload && typeof payload === 'object' ? payload : {};
}

function newIdempotencyKey(prefix) {
  if (typeof crypto?.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  const random = crypto?.getRandomValues
    ? crypto.getRandomValues(new Uint32Array(4)).join('-')
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${Date.now()}-${random}`;
}

function cleanTranscript(value, maximum = 3_000) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maximum);
}

function formatEuroFromMicro(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return '—';
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount / 1_000_000);
}

function currentBudget() {
  const configured = state.voice?.budget || state.bootstrap?.voiceBudget || {};
  const limitMicroEur = Number(firstDefined(
    configured.limitMicroEur,
    DEFAULT_SESSION_LIMIT_MICRO_EUR
  ));
  const spentMicroEur = Number(firstDefined(configured.spentMicroEur, 0));
  const remainingMicroEur = Number(firstDefined(
    configured.remainingMicroEur,
    Math.max(0, limitMicroEur - spentMicroEur)
  ));
  return {
    limitMicroEur: Number.isFinite(limitMicroEur) ? Math.max(0, limitMicroEur) : DEFAULT_SESSION_LIMIT_MICRO_EUR,
    spentMicroEur: Number.isFinite(spentMicroEur) ? Math.max(0, spentMicroEur) : 0,
    remainingMicroEur: Number.isFinite(remainingMicroEur) ? Math.max(0, remainingMicroEur) : 0
  };
}

function voiceContext() {
  const bootstrap = state.bootstrap || {};
  const savedConsent = getVoiceConsent() || {};
  const cohort = String(bootstrap.cohort || '').toLowerCase();
  const noticeId = String(bootstrap.voiceNoticeId || savedConsent.noticeId || '');
  const policyVersion = String(bootstrap.voicePolicyVersion || savedConsent.policyVersion || '');
  const privacyNoticeUrl = safePrivacyUrl(
    bootstrap.voicePrivacyNoticeUrl
    || bootstrap.privacyNoticeUrl
    || savedConsent.privacyNoticeUrl
    || ''
  );
  return {
    eligible: bootstrap.voiceEnabled === true && cohort === ADVISER_TEST_COHORT,
    configured: Boolean(noticeId && policyVersion && privacyNoticeUrl),
    noticeId,
    policyVersion,
    privacyNoticeUrl,
    consentGranted: hasCurrentVoiceConsent(),
    sessionId: getSessionId(),
    journeyBusy: state.busy === true,
    maxRecordingMs: Math.min(
      HARD_MAX_RECORDING_MS,
      Math.max(1_000, Number(bootstrap.voiceMaxRecordingSeconds || 45) * 1_000)
    ),
    budget: currentBudget()
  };
}

export function selectSupportedRecordingMimeType(MediaRecorderClass = window.MediaRecorder) {
  if (typeof MediaRecorderClass !== 'function') return '';
  if (typeof MediaRecorderClass.isTypeSupported !== 'function') {
    return 'audio/webm';
  }
  return RECORDING_MIME_TYPES.find((type) => MediaRecorderClass.isTypeSupported(type)) || '';
}

function isMicrophoneSupported() {
  return Boolean(
    window.isSecureContext
    && navigator.mediaDevices?.getUserMedia
    && typeof window.MediaRecorder === 'function'
    && selectSupportedRecordingMimeType()
  );
}

export function captureConversationDraft(root = document) {
  const input = root?.querySelector?.('#conversationInput');
  if (!input) return null;
  return {
    value: String(input.value || ''),
    selectionStart: Number.isInteger(input.selectionStart) ? input.selectionStart : null,
    selectionEnd: Number.isInteger(input.selectionEnd) ? input.selectionEnd : null,
    selectionDirection: ['forward', 'backward', 'none'].includes(input.selectionDirection)
      ? input.selectionDirection
      : 'none'
  };
}

export function restoreConversationDraft(root = document, snapshot = null) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const input = root?.querySelector?.('#conversationInput');
  if (!input) return false;
  input.value = String(snapshot.value || '');
  if (typeof input.setSelectionRange === 'function'
    && Number.isInteger(snapshot.selectionStart)
    && Number.isInteger(snapshot.selectionEnd)) {
    const maximum = input.value.length;
    const start = Math.min(maximum, Math.max(0, snapshot.selectionStart));
    const end = Math.min(maximum, Math.max(start, snapshot.selectionEnd));
    try {
      input.setSelectionRange(start, end, snapshot.selectionDirection || 'none');
    } catch (_error) {
      // Selection restoration is a convenience; the draft itself is authoritative.
    }
  }
  input.dispatchEvent?.(new Event('input', { bubbles: true }));
  return true;
}

export function appendTranscriptForReview(input, transcript) {
  if (!input) {
    throw new Error('The transcript is ready, but the answer box is no longer open. Return to Your goals and record again.');
  }
  const clean = cleanTranscript(transcript);
  if (!clean) {
    throw new Error('No clear speech was found. Try again closer to the microphone, or type your answer.');
  }
  const existing = String(input.value || '');
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  const maximum = Math.max(0, Number(input.maxLength || 3_000));
  const available = Math.max(0, maximum - existing.length - separator.length);
  if (available === 0) {
    throw new Error('The answer box is already full. Edit it before adding a voice transcript.');
  }
  if (clean.length > available) {
    throw new Error('The transcript would not fit in the answer box. Shorten the existing draft, then record again.');
  }
  input.value = `${existing}${separator}${clean}`;
  input.dispatchEvent?.(new Event('input', { bubbles: true }));
  input.focus?.({ preventScroll: false });
  input.setSelectionRange?.(input.value.length, input.value.length);
  return input.value;
}

export function crossedAccessibleCountdownThreshold(previousSeconds, remainingSeconds) {
  const previous = Number(previousSeconds);
  const remaining = Number(remainingSeconds);
  if (!Number.isFinite(previous) || !Number.isFinite(remaining)) return null;
  let crossed = null;
  ACCESSIBLE_COUNTDOWN_THRESHOLDS.forEach((threshold) => {
    if (previous > threshold && remaining <= threshold) crossed = threshold;
  });
  return crossed;
}

function microphoneErrorMessage(error) {
  switch (String(error?.name || '')) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was not allowed. Use the text box, or allow microphone access in your browser settings and try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found. Connect a microphone or continue by typing.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The microphone is already in use or could not be opened. Close other recording apps and try again.';
    case 'OverconstrainedError':
      return 'This microphone could not meet the requested voice settings. Continue by typing or try another browser.';
    default:
      return error instanceof Error && error.message
        ? error.message
        : 'The microphone could not be opened. You can continue by typing.';
  }
}

function budgetFromHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const read = (name) => {
    const value = Number(headers.get(name));
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  };
  const limitMicroEur = read('X-Voice-Limit-Micro-Eur');
  const spentMicroEur = read('X-Voice-Spent-Micro-Eur');
  const remainingMicroEur = read('X-Voice-Remaining-Micro-Eur');
  if (limitMicroEur === null && spentMicroEur === null && remainingMicroEur === null) {
    return null;
  }
  return {
    limitMicroEur,
    spentMicroEur,
    remainingMicroEur
  };
}

function stopTracks(stream) {
  stream?.getTracks?.().forEach((track) => {
    try {
      track.stop();
    } catch (_error) {
      // Best-effort privacy cleanup.
    }
  });
}

function safePrivacyUrl(value) {
  try {
    const url = new URL(String(value || ''), window.location.href);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      return url.href;
    }
  } catch (_error) {
    // Invalid configuration is handled by the caller.
  }
  return '';
}

function responseTranscript(payload) {
  const root = unwrap(payload);
  return cleanTranscript(firstDefined(
    root.transcript,
    root.text,
    root.result?.transcript,
    root.transcription?.text,
    ''
  ));
}

export class ConsumerVoiceController {
  constructor({
    root,
    currentQuestion,
    onVoicePayload = () => {},
    onConsentChanged = () => {},
    onToast = () => {},
    onSessionUnavailable = () => false
  }) {
    this.root = root;
    this.currentQuestion = currentQuestion;
    this.onVoicePayload = onVoicePayload;
    this.onConsentChanged = onConsentChanged;
    this.onToast = onToast;
    this.onSessionUnavailable = onSessionUnavailable;
    this.phase = 'idle';
    this.statusText = '';
    this.recording = null;
    this.microphoneRequestId = 0;
    this.networkController = null;
    this.audioContext = null;
    this.audioSource = null;
    this.abortWithoutBudgetRefresh = new WeakSet();
    this.bound = false;
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    const form = document.getElementById('voiceConsentForm');
    const cancel = document.getElementById('cancelVoiceConsentButton');
    const dialog = document.getElementById('voiceConsentDialog');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitConsent(form);
    });
    cancel?.addEventListener('click', () => this.closeConsentDialog());
    dialog?.addEventListener('cancel', (event) => {
      if (form?.querySelector('[type="submit"]')?.disabled) event.preventDefault();
    });
    dialog?.addEventListener('close', () => document.body.classList.remove('dialog-open'));
    window.addEventListener('pagehide', () => this.reset({ refreshBudget: false }));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      this.cancelActiveVoice({ reason: 'hidden' });
    });
  }

  handles(action) {
    return ['voice-consent', 'voice-record', 'voice-speak'].includes(String(action || ''));
  }

  handleAction(action) {
    if (action === 'voice-consent') {
      this.openConsentDialog();
      return true;
    }
    if (action === 'voice-record') {
      this.toggleRecording();
      return true;
    }
    if (action === 'voice-speak') {
      this.toggleSpeech();
      return true;
    }
    return false;
  }

  afterRender() {
    const panel = this.root?.querySelector('[data-voice-panel]');
    if (!panel) {
      this.cancelActiveVoice();
      this.phase = 'idle';
      this.statusText = '';
      return;
    }
    if (!voiceContext().consentGranted
      && ['requesting_microphone', 'recording', 'transcribing', 'loading_speech', 'speaking'].includes(this.phase)) {
      this.cancelActiveVoice();
    }
    this.syncUi();
  }

  setPhase(phase, statusText = '') {
    this.phase = phase;
    this.statusText = String(statusText || '');
    this.syncUi();
  }

  syncUi() {
    const panel = this.root?.querySelector('[data-voice-panel]');
    if (!panel) return;
    const context = voiceContext();
    const supported = isMicrophoneSupported();
    const exhausted = context.budget.remainingMicroEur <= 0;
    const recordButton = panel.querySelector('[data-action="voice-record"]');
    const speechButton = panel.querySelector('[data-action="voice-speak"]');
    const status = panel.querySelector('[data-voice-status]');
    const timer = panel.querySelector('[data-voice-timer]');
    const budgetText = panel.querySelector('[data-voice-budget-text]');
    const budgetMeter = panel.querySelector('[data-voice-budget-meter]');

    panel.dataset.voicePhase = this.phase;
    panel.classList.toggle('is-recording', this.phase === 'recording');
    panel.classList.toggle('is-speaking', this.phase === 'speaking');

    if (recordButton) {
      const labels = {
        requesting_microphone: 'Cancel',
        recording: 'Stop and transcribe',
        transcribing: 'Transcribing…'
      };
      recordButton.textContent = context.consentGranted
        ? (labels[this.phase] || 'Tap to talk')
        : 'Set up voice';
      recordButton.disabled = context.journeyBusy
        || !context.configured
        || exhausted
        || this.phase === 'transcribing'
        || this.phase === 'loading_speech';
      recordButton.setAttribute('aria-pressed', this.phase === 'recording' ? 'true' : 'false');
      recordButton.setAttribute('aria-label', this.phase === 'recording'
        ? 'Stop recording and create a transcript'
        : (context.consentGranted ? 'Start a voice recording' : 'Review voice consent'));
      if (!supported && context.consentGranted) {
        recordButton.disabled = true;
      }
    }

    if (speechButton) {
      speechButton.textContent = ['loading_speech', 'speaking'].includes(this.phase)
        ? 'Stop voice'
        : 'Hear this question';
      speechButton.disabled = context.journeyBusy
        || !context.configured
        || !context.consentGranted
        || exhausted
        || ['requesting_microphone', 'recording', 'transcribing'].includes(this.phase)
        || !cleanTranscript(this.currentQuestion?.(), 1_500);
      speechButton.setAttribute('aria-pressed', this.phase === 'speaking' ? 'true' : 'false');
    }

    if (timer) {
      timer.hidden = this.phase !== 'recording';
    }

    if (budgetText) {
      budgetText.textContent = `${formatEuroFromMicro(context.budget.limitMicroEur)} app allowance · ${formatEuroFromMicro(context.budget.remainingMicroEur)} remaining`;
    }
    if (budgetMeter) {
      budgetMeter.max = Math.max(1, context.budget.limitMicroEur);
      budgetMeter.value = Math.min(context.budget.limitMicroEur, context.budget.remainingMicroEur);
      budgetMeter.setAttribute('aria-valuetext', `${formatEuroFromMicro(context.budget.remainingMicroEur)} app voice allowance remaining`);
    }

    let defaultStatus = 'Voice never starts automatically. Your transcript stays in the text box until you choose Continue.';
    if (!context.configured) {
      defaultStatus = 'Voice is temporarily unavailable because its disclosure configuration is incomplete. You can continue by typing.';
    } else if (!supported && context.consentGranted) {
      defaultStatus = 'This browser cannot create a supported short audio recording. You can continue by typing.';
    } else if (exhausted) {
      defaultStatus = 'The app voice allowance for this session has been used. You can continue by typing.';
    }
    if (status) {
      status.textContent = this.statusText || defaultStatus;
    }
  }

  updateTimer() {
    const recording = this.recording;
    const timer = this.root?.querySelector('[data-voice-timer]');
    if (!recording || !timer) return;
    const elapsed = Math.max(0, performance.now() - recording.startedAt);
    const remainingSeconds = Math.max(0, Math.ceil((recording.maxDurationMs - elapsed) / 1_000));
    timer.textContent = `0:${String(remainingSeconds).padStart(2, '0')} remaining`;
    const threshold = crossedAccessibleCountdownThreshold(
      recording.previousRemainingSeconds,
      remainingSeconds
    );
    recording.previousRemainingSeconds = remainingSeconds;
    if (threshold && !recording.announcedCountdownThresholds.has(threshold)) {
      recording.announcedCountdownThresholds.add(threshold);
      this.statusText = `${threshold} seconds of recording time remain. Tap Stop and transcribe when you are finished.`;
      const status = this.root?.querySelector('[data-voice-status]');
      if (status) status.textContent = this.statusText;
    }
  }

  openConsentDialog() {
    const context = voiceContext();
    if (!context.eligible) {
      this.onToast('Voice is available only inside the adviser-test journey.', { error: true });
      return;
    }
    if (!context.configured) {
      this.onToast('Voice cannot start until its privacy disclosure is configured.', { error: true });
      return;
    }
    if (!context.sessionId) {
      this.onToast('Open a private planning session before enabling voice.', { error: true });
      return;
    }
    if (context.consentGranted) {
      this.setPhase('idle', 'Voice consent is active for this disclosure version. Tap to talk when you are ready.');
      return;
    }
    const dialog = document.getElementById('voiceConsentDialog');
    const checkbox = document.getElementById('voiceConsentAcknowledgement');
    const policy = document.getElementById('voiceConsentPolicy');
    const budget = document.getElementById('voiceConsentBudget');
    const privacyLink = document.getElementById('voiceConsentPrivacyLink');
    const error = document.getElementById('voiceConsentError');
    if (!dialog || !checkbox) {
      this.onToast('The voice disclosure could not be opened. Continue by typing.', { error: true });
      return;
    }
    checkbox.checked = false;
    checkbox.disabled = false;
    if (policy) policy.textContent = `Disclosure ${context.noticeId} · policy ${context.policyVersion}`;
    if (budget) budget.textContent = `${formatEuroFromMicro(context.budget.limitMicroEur)} app voice allowance for this session.`;
    const privacyUrl = safePrivacyUrl(context.privacyNoticeUrl);
    if (privacyLink && privacyUrl) privacyLink.href = privacyUrl;
    if (error) {
      error.hidden = true;
      error.textContent = '';
    }
    document.body.classList.add('dialog-open');
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    window.requestAnimationFrame(() => checkbox.focus());
  }

  closeConsentDialog() {
    const dialog = document.getElementById('voiceConsentDialog');
    if (typeof dialog?.close === 'function' && dialog.open) {
      dialog.close();
    } else {
      dialog?.removeAttribute('open');
    }
    document.body.classList.remove('dialog-open');
  }

  async submitConsent(form) {
    if (!form?.reportValidity()) return;
    const context = voiceContext();
    if (!context.eligible || !context.configured || !context.sessionId) {
      this.showConsentError('Voice is not configured for this private session.');
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    const cancel = document.getElementById('cancelVoiceConsentButton');
    const checkbox = document.getElementById('voiceConsentAcknowledgement');
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'Saving consent…';
    }
    if (checkbox) checkbox.disabled = true;
    if (cancel) cancel.disabled = true;
    try {
      const payload = await updateVoiceConsent(context.sessionId, {
        granted: true,
        noticeId: context.noticeId,
        policyVersion: context.policyVersion,
        privacyNoticeUrl: context.privacyNoticeUrl
      });
      mergeVoicePayload(payload);
      this.onVoicePayload(payload);
      if (!hasCurrentVoiceConsent()) {
        throw new Error('The service did not confirm voice consent for the current disclosure.');
      }
      this.closeConsentDialog();
      this.setPhase('idle', 'Voice is ready. Tap to talk; you will review the transcript before anything is sent.');
      this.onConsentChanged(payload, { granted: true });
      this.onToast('Voice is ready for this private session. Recording still starts only when you press the microphone button.');
      window.requestAnimationFrame(() => {
        this.root?.querySelector('[data-action="voice-record"]')?.focus();
      });
    } catch (error) {
      if (this.onSessionUnavailable(error)) return;
      this.showConsentError(error instanceof Error ? error.message : 'Voice consent could not be saved.');
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = 'Agree and enable voice';
      }
      if (checkbox) checkbox.disabled = false;
      if (cancel) cancel.disabled = false;
    }
  }

  showConsentError(message) {
    const error = document.getElementById('voiceConsentError');
    if (!error) return;
    error.textContent = String(message || 'Voice consent could not be saved.');
    error.hidden = false;
  }

  async withdrawConsent() {
    const context = voiceContext();
    if (!context.sessionId || getVoiceConsent()?.granted !== true) return;
    const button = document.getElementById('withdrawVoiceConsentButton');
    if (button) {
      button.disabled = true;
      button.textContent = 'Turning off…';
    }
    this.cancelActiveVoice();
    try {
      const payload = await updateVoiceConsent(context.sessionId, {
        granted: false,
        noticeId: context.noticeId,
        policyVersion: context.policyVersion,
        privacyNoticeUrl: context.privacyNoticeUrl
      });
      mergeVoicePayload(payload);
      this.onVoicePayload(payload);
      this.onConsentChanged(payload, { granted: false });
      this.setPhase('idle', 'Voice is off. You can continue by typing.');
      this.onToast('Voice is off for this session. No microphone recording can start until you consent again.');
    } catch (error) {
      if (this.onSessionUnavailable(error)) return;
      this.onToast(error instanceof Error ? error.message : 'Voice could not be turned off.', { error: true });
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Stop voice processing';
      }
    }
  }

  toggleRecording() {
    const context = voiceContext();
    if (!context.consentGranted) {
      this.openConsentDialog();
      return;
    }
    if (this.phase === 'requesting_microphone') {
      this.microphoneRequestId += 1;
      this.setPhase('idle', 'Microphone request cancelled. Nothing was recorded.');
      return;
    }
    if (this.phase === 'recording') {
      this.stopRecording({ upload: true });
      return;
    }
    if (this.phase === 'transcribing') return;
    this.startRecording();
  }

  async startRecording() {
    const context = voiceContext();
    if (!context.eligible || !context.configured || !context.consentGranted) {
      this.openConsentDialog();
      return;
    }
    if (context.journeyBusy) return;
    if (context.budget.remainingMicroEur <= 0) {
      this.setPhase('idle', 'The app voice allowance has been used. Continue by typing.');
      return;
    }
    const mimeType = selectSupportedRecordingMimeType();
    if (!isMicrophoneSupported() || !mimeType) {
      this.setPhase('error', 'This browser cannot create a supported short audio recording. Continue by typing.');
      return;
    }

    this.stopSpeech();
    const requestId = ++this.microphoneRequestId;
    this.setPhase('requesting_microphone', 'Waiting for microphone permission…');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      if (requestId !== this.microphoneRequestId || !hasCurrentVoiceConsent()) {
        stopTracks(stream);
        return;
      }
      const liveAudioTrack = stream.getAudioTracks().find((track) => track.readyState === 'live');
      if (!liveAudioTrack) {
        throw new Error('The selected microphone did not provide a live audio track.');
      }
      let recorder;
      try {
        recorder = new window.MediaRecorder(stream, {
          mimeType,
          audioBitsPerSecond: 48_000
        });
      } catch (_error) {
        // Some otherwise-compatible MediaRecorder implementations reject an
        // explicit bitrate. Preserve the reviewed MIME type and let the browser
        // choose its safe default bitrate.
        recorder = new window.MediaRecorder(stream, { mimeType });
      }
      const recording = {
        recorder,
        stream,
        chunks: [],
        startedAt: performance.now(),
        maxDurationMs: context.maxRecordingMs,
        shouldUpload: true,
        mimeType: String(recorder.mimeType || mimeType).toLowerCase(),
        timeoutId: null,
        intervalId: null,
        error: null,
        previousRemainingSeconds: Math.ceil(context.maxRecordingMs / 1_000) + 1,
        announcedCountdownThresholds: new Set()
      };
      this.recording = recording;
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data?.size > 0) recording.chunks.push(event.data);
      });
      recorder.addEventListener('error', (event) => {
        recording.error = event.error || new Error('The browser stopped recording unexpectedly.');
        recording.shouldUpload = false;
        this.stopRecording({ upload: false });
      });
      recorder.addEventListener('stop', () => this.finishRecording(recording), { once: true });
      recorder.start(1_000);
      recording.timeoutId = window.setTimeout(() => {
        this.stopRecording({ upload: true, reachedLimit: true });
      }, context.maxRecordingMs);
      recording.intervalId = window.setInterval(() => this.updateTimer(), 250);
      this.setPhase('recording', 'Recording. Tap again when finished. The 45-second maximum is enforced automatically.');
      this.updateTimer();
    } catch (error) {
      stopTracks(stream);
      if (requestId !== this.microphoneRequestId) return;
      const message = microphoneErrorMessage(error);
      this.setPhase('error', message);
      this.onToast(message, { error: true });
    }
  }

  stopRecording({ upload = true, reachedLimit = false } = {}) {
    const recording = this.recording;
    if (!recording) return;
    recording.shouldUpload = upload;
    if (recording.timeoutId !== null) window.clearTimeout(recording.timeoutId);
    if (recording.intervalId !== null) window.clearInterval(recording.intervalId);
    recording.timeoutId = null;
    recording.intervalId = null;
    try {
      if (recording.recorder.state !== 'inactive') recording.recorder.stop();
    } catch (error) {
      recording.error = error;
      recording.shouldUpload = false;
    }
    stopTracks(recording.stream);
    this.setPhase(upload ? 'transcribing' : 'idle', upload
      ? (reachedLimit ? '45-second limit reached. Creating your transcript…' : 'Creating your transcript…')
      : 'Local recording discarded before upload.');
    if (recording.recorder.state === 'inactive' && recording.error) {
      this.finishRecording(recording);
    }
  }

  async finishRecording(recording) {
    if (recording.finished) return;
    recording.finished = true;
    if (this.recording === recording) this.recording = null;
    if (recording.timeoutId !== null) window.clearTimeout(recording.timeoutId);
    if (recording.intervalId !== null) window.clearInterval(recording.intervalId);
    stopTracks(recording.stream);
    if (recording.error) {
      const message = microphoneErrorMessage(recording.error);
      this.setPhase('error', message);
      this.onToast(message, { error: true });
      return;
    }
    if (!recording.shouldUpload) {
      this.setPhase('idle', 'Local recording discarded before upload.');
      return;
    }
    const durationMs = Math.min(
      recording.maxDurationMs,
      Math.max(0, Math.round(performance.now() - recording.startedAt))
    );
    const audio = new Blob(recording.chunks, { type: recording.mimeType });
    if (durationMs < MIN_RECORDING_MS || audio.size === 0) {
      this.setPhase('idle', 'That recording was too short to transcribe. Hold the thought a little longer, or type it below.');
      return;
    }
    if (audio.size > MAX_RECORDING_BYTES) {
      this.setPhase('error', 'That recording was too large to upload. No audio was sent; continue by typing.');
      return;
    }
    await this.uploadRecording(audio, durationMs);
  }

  async uploadRecording(audio, durationMs) {
    const sessionId = getSessionId();
    if (!sessionId || !hasCurrentVoiceConsent()) {
      this.setPhase('idle', 'Voice consent or private session access is no longer active. Nothing was uploaded.');
      return;
    }
    const controller = new AbortController();
    this.networkController = controller;
    this.setPhase('transcribing', 'Securely transcribing your recording…');
    try {
      const payload = await transcribeVoice(sessionId, {
        audio,
        durationMs,
        idempotencyKey: newIdempotencyKey('voice-stt'),
        signal: controller.signal
      });
      if (controller.signal.aborted) {
        await this.refreshVoiceBudgetAfterAbort(controller, sessionId);
        return;
      }
      if (sessionId !== getSessionId()) return;
      mergeVoicePayload(payload);
      this.onVoicePayload(payload);
      const transcript = responseTranscript(payload);
      const responseRoot = unwrap(payload);
      const sensitiveDetailsRemoved = responseRoot.sensitiveDetailsRemoved === true;
      if (!transcript) {
        throw new Error('No clear speech was found. Try again closer to the microphone, or type your answer.');
      }
      appendTranscriptForReview(document.getElementById('conversationInput'), transcript);
      this.setPhase(
        'ready',
        sensitiveDetailsRemoved
          ? 'Transcript added for review. A sensitive identifier was removed; check the wording before choosing Continue. Nothing was submitted automatically.'
          : 'Transcript added to the answer box. Review and edit it before choosing Continue. Nothing was submitted automatically.'
      );
      this.onToast(
        sensitiveDetailsRemoved
          ? 'Transcript added. Planéir removed a sensitive identifier; review the wording and figures carefully.'
          : 'Transcript added for review. Check names and figures carefully before continuing.',
        { timeout: 7000 }
      );
    } catch (error) {
      if (controller.signal.aborted || (error instanceof ConsumerApiError && error.code === 'request_aborted')) {
        await this.refreshVoiceBudgetAfterAbort(controller, sessionId);
        return;
      }
      if (this.onSessionUnavailable(error)) return;
      const message = error instanceof Error ? error.message : 'The recording could not be transcribed.';
      this.setPhase('error', `${message} You can continue by typing.`);
      this.onToast(message, { error: true });
      this.refreshVoiceBudget(sessionId);
    } finally {
      if (this.networkController === controller) this.networkController = null;
    }
  }

  toggleSpeech() {
    if (['loading_speech', 'speaking'].includes(this.phase)) {
      this.stopSpeech();
      return;
    }
    this.playCurrentQuestion();
  }

  async ensureAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error('This browser cannot play the generated voice. The question remains available as text.');
    }
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new AudioContextClass();
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    return this.audioContext;
  }

  decodeAudio(context, arrayBuffer) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      try {
        const result = context.decodeAudioData(arrayBuffer, done, fail);
        if (result && typeof result.then === 'function') result.then(done, fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  async playCurrentQuestion() {
    const context = voiceContext();
    const question = cleanTranscript(this.currentQuestion?.(), 1_500);
    if (!context.consentGranted) {
      this.openConsentDialog();
      return;
    }
    if (!question) {
      this.setPhase('idle', 'There is no current question to play.');
      return;
    }
    if (context.budget.remainingMicroEur <= 0) {
      this.setPhase('idle', 'The app voice allowance has been used. The question remains available as text.');
      return;
    }
    const audioContext = await this.ensureAudioContext().catch((error) => {
      this.setPhase('error', error.message);
      return null;
    });
    if (!audioContext) return;
    const controller = new AbortController();
    this.networkController = controller;
    this.setPhase('loading_speech', 'Preparing an AI-generated reading of the current Planéir question…');
    try {
      const response = await speakNextQuestion(context.sessionId, {
        idempotencyKey: newIdempotencyKey('voice-tts'),
        signal: controller.signal
      });
      if (controller.signal.aborted) {
        await this.refreshVoiceBudgetAfterAbort(controller, context.sessionId);
        return;
      }
      if (context.sessionId !== getSessionId()) return;
      const headerBudget = budgetFromHeaders(response.headers);
      if (headerBudget) {
        const payload = { voiceBudget: headerBudget };
        mergeVoicePayload(payload);
        this.onVoicePayload(payload);
      }
      if (!String(response.contentType || '').toLowerCase().startsWith('audio/')) {
        throw new Error('The service returned an unexpected voice response.');
      }
      if (!(response.blob instanceof Blob) || response.blob.size === 0) {
        throw new Error('The service returned no playable voice audio.');
      }
      const audioBuffer = await this.decodeAudio(audioContext, await response.blob.arrayBuffer());
      if (controller.signal.aborted) {
        await this.refreshVoiceBudgetAfterAbort(controller, context.sessionId);
        return;
      }
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      this.audioSource = source;
      source.onended = () => {
        if (this.audioSource !== source) return;
        this.audioSource = null;
        try { source.disconnect(); } catch (_error) { /* noop */ }
        this.setPhase('idle', 'Voice playback finished. The written question remains authoritative.');
      };
      source.start(0);
      this.setPhase('speaking', 'Playing an AI-generated voice. Press Stop voice at any time.');
    } catch (error) {
      if (controller.signal.aborted || (error instanceof ConsumerApiError && error.code === 'request_aborted')) {
        await this.refreshVoiceBudgetAfterAbort(controller, context.sessionId);
        return;
      }
      if (this.onSessionUnavailable(error)) return;
      const message = error instanceof Error ? error.message : 'The generated voice could not be played.';
      this.setPhase('error', `${message} The question remains available as text.`);
      this.onToast(message, { error: true });
      this.refreshVoiceBudget(context.sessionId);
    } finally {
      if (this.networkController === controller) this.networkController = null;
    }
  }

  stopSpeech() {
    if (this.networkController && this.phase === 'loading_speech') {
      this.networkController.abort('voice_stopped');
      this.networkController = null;
    }
    const source = this.audioSource;
    this.audioSource = null;
    if (source) {
      try { source.stop(0); } catch (_error) { /* already stopped */ }
      try { source.disconnect(); } catch (_error) { /* noop */ }
    }
    if (['loading_speech', 'speaking'].includes(this.phase)) {
      this.setPhase('idle', 'Voice playback stopped. The written question remains available.');
    }
  }

  async refreshVoiceBudget(sessionId) {
    if (!sessionId || sessionId !== getSessionId()) return;
    try {
      const payload = await getSession(sessionId);
      if (sessionId !== getSessionId()) return;
      const root = unwrap(payload);
      const voicePayload = {
        voiceConsent: root.voiceConsent,
        voiceBudget: root.voiceBudget
      };
      mergeVoicePayload(voicePayload);
      this.onVoicePayload(voicePayload);
      this.syncUi();
    } catch (_error) {
      // The original voice error remains authoritative; this is a best-effort
      // refresh so uncertain provider outcomes cannot leave the meter stale.
    }
  }

  async refreshVoiceBudgetAfterAbort(controller, sessionId) {
    if (!this.abortWithoutBudgetRefresh.has(controller)) {
      await this.refreshVoiceBudget(sessionId);
    }
  }

  cancelActiveVoice({ reason = 'user', refreshBudget = true } = {}) {
    const phaseAtCancellation = this.phase;
    this.microphoneRequestId += 1;
    if (this.networkController) {
      if (!refreshBudget) this.abortWithoutBudgetRefresh.add(this.networkController);
      this.networkController.abort('voice_cancelled');
      this.networkController = null;
    }
    if (this.recording) this.stopRecording({ upload: false });
    this.stopSpeech();
    if (['requesting_microphone', 'recording'].includes(phaseAtCancellation)) {
      this.setPhase('idle', reason === 'hidden'
        ? 'Voice stopped because this tab was hidden. The local recording was discarded before upload.'
        : 'Voice stopped. The local recording was discarded before upload.');
    } else if (['transcribing', 'loading_speech'].includes(phaseAtCancellation)) {
      const allowanceCopy = refreshBudget
        ? 'the app is rechecking the allowance.'
        : 'the server-side allowance remains authoritative.';
      this.setPhase('idle', reason === 'hidden'
        ? `Voice stopped because this tab was hidden. No planning answer was added. Provider processing may already have started; ${allowanceCopy}`
        : `Voice stopped. No planning answer was added. Provider processing may already have started; ${allowanceCopy}`);
    } else if (phaseAtCancellation === 'speaking') {
      this.setPhase('idle', 'Voice playback stopped. The written question remains available.');
    } else if (['ready', 'error'].includes(phaseAtCancellation)) {
      this.setPhase('idle', '');
    } else if (this.phase === 'idle' && this.statusText) {
      this.setPhase('idle', '');
    }
  }

  reset({ refreshBudget = false } = {}) {
    this.cancelActiveVoice({ reason: 'reset', refreshBudget });
    this.closeConsentDialog();
    this.statusText = '';
    this.phase = 'idle';
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
  }
}

export function createVoiceController(options) {
  return new ConsumerVoiceController(options);
}
