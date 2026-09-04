import {
  ConsumerApiError,
  addTurn,
  confirmProfile,
  createHandoff,
  createSession,
  deleteSession,
  getBootstrap,
  getRealtimeVoiceMeetingTranscript,
  getSession,
  patchProfile,
  putAnalysisPlan,
  revokeHandoff,
  withdrawAiConsent
} from './api.js';
import { buildSubscriptionAssistPrompt } from './subscription_assist.js';
import {
  canUseSessionStorage,
  clearSessionAccess,
  consumeConsumerInvite,
  captureInviteFromUrlFragment,
  getConsumerInvite,
  getAnalysisPlanNonce,
  getRealtimeVoiceConsent,
  getSessionId,
  getStoredSessionAccess,
  mergePayload,
  preparePendingSessionAccess,
  resetJourneyState,
  setAiConsent,
  setBootstrap,
  setBusy,
  setView,
  state,
  storeSessionAccess
} from './store.js';
import { createLiveVoiceLaneController } from './voice_lane.js';
import {
  findProfileField,
  getAvailableViews,
  getProfileFieldGroups,
  renderJourney,
  renderMeetingBackdrop,
  renderOnboarding,
  renderUnavailable
} from './views.js';

const appRoot = document.getElementById('appRoot');
const planMain = document.getElementById('planMain');
const headerSessionStatus = document.getElementById('headerSessionStatus');
const deleteSessionButton = document.getElementById('deleteSessionButton');
const privacyControlsButton = document.getElementById('privacyControlsButton');
const deleteSessionDialog = document.getElementById('deleteSessionDialog');
const confirmDeleteButton = document.getElementById('confirmDeleteButton');
const editFieldDialog = document.getElementById('editFieldDialog');
const editFieldForm = document.getElementById('editFieldForm');
const editFieldTitle = document.getElementById('editFieldTitle');
const editFieldContext = document.getElementById('editFieldContext');
const editFieldInput = document.getElementById('editFieldInput');
const editFieldError = document.getElementById('editFieldError');
const cancelEditButton = document.getElementById('cancelEditButton');
const termsDialog = document.getElementById('termsDialog');
const termsBody = document.getElementById('termsBody');
const termsVersion = document.getElementById('termsVersion');
const termsRetentionDays = document.getElementById('termsRetentionDays');
const termsPrivacyLink = document.getElementById('termsPrivacyLink');
const closeTermsButton = document.getElementById('closeTermsButton');
const privacyControlsDialog = document.getElementById('privacyControlsDialog');
const privacyControlsCopy = document.getElementById('privacyControlsCopy');
const privacyControlsError = document.getElementById('privacyControlsError');
const closePrivacyControlsButton = document.getElementById('closePrivacyControlsButton');
const withdrawAiConsentButton = document.getElementById('withdrawAiConsentButton');
const revokeHandoffButton = document.getElementById('revokeHandoffButton');
const handoffPrivacyCopy = document.getElementById('handoffPrivacyCopy');
const realtimeVoicePrivacyCopy = document.getElementById('realtimeVoicePrivacyCopy');
const withdrawRealtimeVoiceConsentButton = document.getElementById('withdrawRealtimeVoiceConsentButton');
const removeItemDialog = document.getElementById('removeItemDialog');
const removeItemTitle = document.getElementById('removeItemTitle');
const removeItemContext = document.getElementById('removeItemContext');
const removeItemError = document.getElementById('removeItemError');
const cancelRemoveItemButton = document.getElementById('cancelRemoveItemButton');
const confirmRemoveItemButton = document.getElementById('confirmRemoveItemButton');
const toastRegion = document.getElementById('toastRegion');

let editingField = null;
let removingItem = null;
let pendingTurn = null;
let pendingPlanPrepare = null;
let pendingPlanConfirm = null;
let planPrepareGeneration = 0;
let realtimeRenderQueued = false;

const realtimeVoiceControllerOptions = {
  root: document.getElementById('realtimeVoiceCompanion'),
  onVoicePayload: (payload) => {
    const previousRevision = currentProfileRevision();
    mergePayload(payload);
    if (currentProfileRevision() !== previousRevision) invalidatePendingAnalysisPlan();
  },
  onPlanningPayload: (payload) => scheduleRealtimeJourneyRender(payload),
  onNavigate: async (view) => {
    const destination = view || 'review';
    // The controller has already received matching results and confirmed hang-up.
    // Secondary transcript/history reads must not hold the completed call here.
    setView(destination);
    renderCurrentJourney({ focus: true });
    if (destination === 'results') {
      refreshSavedSession({ keepView: true }).then(async () => {
        const latestMeeting = state.realtimeMeetings?.[0];
        if (latestMeeting?.meetingId) await loadRealtimeMeetingTranscript(latestMeeting.meetingId);
      }).catch(() => {});
    }
  },
  onToast: (message, options) => showToast(message, options),
  onSessionUnavailable: (error) => recoverUnavailableSession(error),
  onFailure: ({ message = '', reason = 'runtime-failure', transcript = '' } = {}) => {
    console.warn('[planeir] live call failed', { reason });
    renderUnavailable(appRoot, { message, liveMeetingFailure: true, transcript });
    syncHeader();
  }
};

// There is no runtime lane selection. The live controller is the only active
// browser call implementation; the previous controlled client is archived.
const realtimeVoiceController = createLiveVoiceLaneController(realtimeVoiceControllerOptions);

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function unwrap(payload) {
  if (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload && typeof payload === 'object' ? payload : {};
}

function captureConversationDraft(root = document) {
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

function restoreConversationDraft(root = document, snapshot = null) {
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
    input.setSelectionRange(start, end, snapshot.selectionDirection || 'none');
  }
  input.dispatchEvent?.(new Event('input', { bubbles: true }));
  return true;
}

function newIdempotencyKey() {
  if (typeof crypto?.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const random = crypto?.getRandomValues
    ? crypto.getRandomValues(new Uint32Array(4)).join('-')
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `consumer-${Date.now()}-${random}`;
}

function formatExpiry(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Private session';
  }
  return `Private session · expires ${new Intl.DateTimeFormat('en-IE', {
    day: 'numeric',
    month: 'short'
  }).format(date)}`;
}

function syncHeader() {
  const hasSession = Boolean(getSessionId());
  deleteSessionButton.hidden = !hasSession;
  privacyControlsButton.hidden = !hasSession;
  headerSessionStatus.hidden = !hasSession;
  headerSessionStatus.textContent = hasSession
    ? formatExpiry(firstDefined(state.session?.expiresAt, state.session?.expiry))
    : '';
}

function currentProfileRevision() {
  return Number(firstDefined(
    state.session?.currentProfileRevision,
    state.session?.profileRevision,
    state.profile?.revision,
    0
  ) || 0);
}

function showToast(message, { error = false, timeout = 5000 } = {}) {
  if (!message) {
    return;
  }
  const toast = document.createElement('div');
  toast.className = `toast${error ? ' is-error' : ''}`;
  toast.textContent = String(message);
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), timeout);
}

function focusCurrentHeading() {
  window.requestAnimationFrame(() => {
    const heading = appRoot.querySelector('h1');
    if (!heading) {
      return;
    }
    heading.tabIndex = -1;
    heading.focus({ preventScroll: false });
  });
}

let realtimeMeetingAutoOpenedForSession = '';

// An adviser invitation with the live meeting enabled should land on the
// calm meeting screen, not the typed journey. Open the meeting surface once
// per session as soon as it is eligible; collapsing it reveals the typed
// journey, and the launcher reopens it at any time. Keying on the session id
// (not a per-page-load flag) means a fresh session started after a consent
// refresh or deletion lands back on the meeting screen without a reload.
function maybeAutoOpenRealtimeMeeting() {
  const sessionId = getSessionId();
  if (!sessionId || realtimeMeetingAutoOpenedForSession === sessionId) return;
  const companion = document.getElementById('realtimeVoiceCompanion');
  if (!companion || companion.hidden) return;
  realtimeMeetingAutoOpenedForSession = sessionId;
  realtimeVoiceController.openCompanion({ focus: false });
}

function renderCurrentJourney({ focus = false } = {}) {
  renderJourney(appRoot, state);
  realtimeVoiceController.sync(state);
  maybeAutoOpenRealtimeMeeting();
  syncHeader();
  window.requestAnimationFrame(() => {
    appRoot.querySelector('.step-button[aria-current="step"]')?.scrollIntoView({
      block: 'nearest',
      inline: 'center'
    });
  });
  if (focus) {
    focusCurrentHeading();
  }
}

// The test planner lands on exactly one of two surfaces: the live orb meeting
// (when the realtime service can run it) or the "Failed to load" page. There is
// no typed-journey fallback. The meeting view uses a non-'conversation' view so
// the retired journey never re-renders behind the orb.
const MEETING_UNAVAILABLE_MESSAGES = Object.freeze({
  'unsupported-browser': 'This browser can’t run the live meeting. Please try again in a recent version of Chrome, Edge, or Safari.',
  'service-off': 'Your live meeting isn’t switched on at the moment. Nothing you have entered has been lost — get in touch and we’ll open it for you.',
  'no-session': 'The live meeting could not find an active planning session. Please try again.',
  'consent-refresh': 'Please review the updated privacy notice before your meeting starts.'
});

function enterMeetingOrFail({ focus = false } = {}) {
  if (!realtimeVoiceController.isMeetingAvailable()) {
    const reason = realtimeVoiceController.meetingUnavailableReason();
    // Flags only, no personal data. Without this the failure page cannot tell
    // an operator which gate closed.
    console.warn('[planeir] live meeting unavailable', realtimeVoiceController.meetingUnavailableDetail());
    renderUnavailable(appRoot, {
      message: MEETING_UNAVAILABLE_MESSAGES[reason] || '',
      liveMeetingFailure: true
    });
    syncHeader();
    return;
  }
  setView('meeting');
  renderMeetingBackdrop(appRoot);
  realtimeVoiceController.sync(state);
  maybeAutoOpenRealtimeMeeting();
  syncHeader();
  if (focus) {
    focusCurrentHeading();
  }
}

function scheduleRealtimeJourneyRender(payload) {
  const root = unwrap(payload);
  const session = root.session && typeof root.session === 'object' ? root.session : {};
  const affectsJourney = [
    'profile',
    'householdProfile',
    'turns',
    'conversationTurns',
    'nextQuestion',
    'question',
    'recommendations',
    'analysisPlan',
    'analysis'
  ].some((key) => Object.hasOwn(root, key))
    || ['profile', 'turns', 'nextQuestion', 'recommendations', 'analysisPlan', 'stage']
      .some((key) => Object.hasOwn(session, key));
  if (!affectsJourney || realtimeRenderQueued || !state.bootstrap?.enabled) return;
  realtimeRenderQueued = true;
  window.requestAnimationFrame(() => {
    realtimeRenderQueued = false;
    if (!realtimeVoiceController.isLive() || state.view !== 'conversation') return;
    const draft = captureConversationDraft(appRoot);
    renderCurrentJourney();
    restoreConversationDraft(appRoot, draft);
  });
}

function responseIncludes(payload, field) {
  const root = unwrap(payload);
  return root[field] !== undefined
    || root.session?.[field] !== undefined
    || root.data?.[field] !== undefined;
}

function mergeTurnHistory(previous, current) {
  const seen = new Set();
  return [...previous, ...current].filter((turn) => {
    const id = String(turn?.id || '').trim();
    const signature = id || [turn?.role, turn?.text, turn?.userMessage, turn?.assistantMessage, turn?.createdAt].join('|');
    if (seen.has(signature)) {
      return false;
    }
    seen.add(signature);
    return true;
  }).slice(-100);
}

function chooseViewFromServer({ action = '', payload = null, profileChanged = true } = {}) {
  const stage = String(firstDefined(state.session?.stage, state.session?.conversationStage, '') || '');
  const available = getAvailableViews(state);

  if (action === 'handoff' && available.handoff) {
    return 'handoff';
  }
  if (action === 'analysis' || responseIncludes(payload, 'analysis') || responseIncludes(payload, 'analysisRun')) {
    return available.results ? 'results' : (available.recommendations ? 'recommendations' : 'review');
  }
  if (action === 'confirm') {
    return 'recommendations';
  }
  if (action === 'turn'
    && !profileChanged
    && ['goal_discovery', 'goal_clarification', 'goal_specific_questions', 'targeted_fact_gathering'].includes(stage)) {
    return 'conversation';
  }
  if (stage === 'human_handoff' && available.handoff) {
    return 'handoff';
  }
  if (available.results) {
    return 'results';
  }
  if (['module_recommendation', 'missing_information', 'analysis'].includes(stage)) {
    return state.recommendations.length > 0 ? 'recommendations' : 'conversation';
  }
  if (stage === 'review') {
    return 'review';
  }
  return available.review ? 'review' : 'conversation';
}

function applyResponse(payload, { action = '', focus = false } = {}) {
  const previousTurns = action === 'turn' ? [...state.turns] : null;
  const previousRevision = currentProfileRevision();
  mergePayload(payload);
  if (previousTurns) {
    state.turns = mergeTurnHistory(previousTurns, state.turns);
  }
  const profileChanged = currentProfileRevision() !== previousRevision;
  if (profileChanged) invalidatePendingAnalysisPlan();
  setView(chooseViewFromServer({ action, payload, profileChanged }));
  renderCurrentJourney({ focus });
  return { profileChanged };
}

function invalidatePendingAnalysisPlan() {
  pendingPlanPrepare = null;
  pendingPlanConfirm = null;
  planPrepareGeneration += 1;
}

function setFormBusy(form, busy, busyLabel = '') {
  [...form.elements].forEach((control) => {
    control.disabled = busy;
  });
  const submit = form.querySelector('[type="submit"]');
  if (submit && busyLabel) {
    if (!submit.dataset.defaultLabel) {
      submit.dataset.defaultLabel = submit.textContent;
    }
    submit.textContent = busy ? busyLabel : submit.dataset.defaultLabel;
  }
}

function showFormError(form, message) {
  let error = form.querySelector('.form-error');
  if (!error) {
    error = document.createElement('p');
    error.className = 'form-error';
    error.setAttribute('role', 'alert');
    const submit = form.querySelector('[type="submit"]');
    form.insertBefore(error, submit || null);
  }
  error.textContent = message;
}

function getErrorMessage(error) {
  if (error instanceof ConsumerApiError || error instanceof Error) {
    return error.message;
  }
  return 'Planéir could not complete that request. Please try again.';
}

function openDialog(dialog) {
  document.body.classList.add('dialog-open');
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function' && dialog.open) {
    dialog.close();
  } else {
    dialog.removeAttribute('open');
  }
  document.body.classList.remove('dialog-open');
}

/** Keeps the static Terms of Use copy aligned with the live policy version and retention config. */
function syncTermsDialog(bootstrap) {
  if (!termsDialog) {
    return;
  }
  if (termsVersion) {
    termsVersion.textContent = String(bootstrap?.policyVersion || '').trim() || 'demo';
  }
  const ttlDays = Number(bootstrap?.limits?.sessionTtlDays || 0);
  if (termsRetentionDays && ttlDays > 0) {
    termsRetentionDays.textContent = String(ttlDays);
  }
  if (termsPrivacyLink) {
    const url = String(bootstrap?.privacyNoticeUrl || '');
    termsPrivacyLink.href = /^https:\/\//i.test(url) ? url : './privacy.html';
  }
}

function activeConversationQuestion() {
  const question = state.nextQuestion;
  if (typeof question === 'string') {
    return question;
  }
  if (question && typeof question === 'object') {
    return String(firstDefined(question.prompt, question.question, question.text, question.message, '') || '');
  }
  return 'What financial goal or concern would you like to explore?';
}

async function copyTextToClipboard(value) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.className = 'clipboard-fallback-input';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('Your browser did not allow clipboard access.');
  }
}

async function copySubscriptionAssistPrompt() {
  const input = document.getElementById('conversationInput');
  try {
    const prompt = buildSubscriptionAssistPrompt({
      question: activeConversationQuestion(),
      draft: input?.value
    });
    await copyTextToClipboard(prompt);
    showToast('Prompt copied. Paste it into Codex or ChatGPT, then paste the rewritten answer back here.', {
      timeout: 8000
    });
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'The prompt could not be copied.', { error: true });
    input?.focus();
  }
}

// Match session-auth codes, not every HTTP 404: feature errors such as
// module_routing_disabled must remain recoverable within the current journey.
const SESSION_UNAVAILABLE_CODES = new Set(['consumer_session_expired']);

function isSessionUnavailableError(error) {
  return error instanceof ConsumerApiError
    && SESSION_UNAVAILABLE_CODES.has(String(error.code || '').toLowerCase());
}

function renderNewSessionEntry({ error = '' } = {}) {
  if (state.bootstrap?.inviteRequired && !getConsumerInvite()) {
    renderUnavailable(appRoot, {
      message: error
        ? `${error} A new valid invitation link is required to begin another session.`
        : 'This private beta requires a new valid invitation link. Your previous session access has been cleared.'
    });
    return;
  }
  renderOnboarding(appRoot, state.bootstrap, { error });
}

function renderProcessingPaused() {
  renderUnavailable(appRoot, {
    message: 'Planning updates are temporarily paused. Your private access is still available, and Privacy controls remain open for AI or adviser-handoff withdrawal and permanent deletion.'
  });
  realtimeVoiceController.sync(state);
  syncHeader();
}

function resetToOnboarding({ error = '', toast = '' } = {}) {
  [editFieldDialog, removeItemDialog, privacyControlsDialog, deleteSessionDialog].forEach((dialog) => {
    if (dialog?.open || dialog?.hasAttribute('open')) {
      closeDialog(dialog);
    }
  });
  document.body.classList.remove('dialog-open');
  clearSessionAccess();
  realtimeVoiceController.reset({ notifyServer: false });
  resetJourneyState();
  editingField = null;
  removingItem = null;
  pendingTurn = null;
  pendingPlanPrepare = null;
  pendingPlanConfirm = null;
  planPrepareGeneration += 1;
  confirmDeleteButton.disabled = false;
  confirmDeleteButton.textContent = 'Delete permanently';
  syncHeader();
  renderNewSessionEntry({ error });
  focusCurrentHeading();
  if (toast) showToast(toast, { timeout: 7000 });
}

function recoverUnavailableSession(error, { deletionAttempt = false } = {}) {
  if (deletionAttempt
    && error instanceof ConsumerApiError
    && String(error.code || '').toLowerCase() === 'not_found') {
    resetToOnboarding({
      toast: 'This private session was already deleted or unavailable. Local access has been cleared.'
    });
    return true;
  }
  if (!isSessionUnavailableError(error)) {
    return false;
  }
  if (deletionAttempt) {
    resetToOnboarding({
      toast: 'This private session was already deleted or unavailable. Local access has been cleared.'
    });
    return true;
  }
  const invitationNote = state.bootstrap?.inviteRequired && !getConsumerInvite()
    ? ' Open a valid invitation link to begin a new one.'
    : ' You can begin a new one.';
  resetToOnboarding({
    error: `That private session has expired or is no longer available.${invitationNote}`
  });
  return true;
}

function blockForConsentRefresh() {
  if (!state.consentRefreshRequired) return false;
  renderCurrentJourney({ focus: true });
  const message = state.bootstrap?.inviteRequired && !getConsumerInvite()
    ? 'Processing is paused because the disclosure changed. Saved information remains read-only; after deletion, a new valid invitation is required.'
    : 'Processing is paused because the disclosure changed. Saved information remains read-only; delete and start again to continue.';
  showToast(message, {
    error: true,
    timeout: 8000
  });
  return true;
}

async function handleStartSession(form) {
  if (!form.reportValidity()) {
    return;
  }
  const data = new FormData(form);
  const adultConfirmed = data.get('adultConfirmed') === 'on';
  const privacyNoticeAcknowledged = data.get('privacyNoticeAcknowledged') === 'on';
  const educationAcknowledged = data.get('educationAcknowledged') === 'on';
  const aiProcessing = state.bootstrap?.aiEnabled === true && data.get('aiProcessing') === 'on';
  if (!adultConfirmed || !privacyNoticeAcknowledged || !educationAcknowledged) {
    showFormError(form, 'Please confirm the three required statements before beginning.');
    return;
  }
  if (!canUseSessionStorage()) {
    showFormError(form, 'This browser cannot keep private access for this tab. Allow session storage, then reload before beginning.');
    return;
  }

  setFormBusy(form, true, 'Creating your space…');
  try {
    preparePendingSessionAccess();
    const payload = await createSession({
      privacyNoticeAcknowledged: true,
      aiProcessing,
      adultConfirmed: true,
      educationOnlyAcknowledged: true,
      manifestId: state.bootstrap?.consentManifestId || '',
      policyVersion: state.bootstrap?.policyVersion || '',
      analysisNoticeId: state.bootstrap?.analysisNoticeId || '',
      aiNoticeId: state.bootstrap?.aiNoticeId || '',
      privacyNoticeUrl: state.bootstrap?.privacyNoticeUrl || ''
    });
    const root = unwrap(payload);
    const session = root.session;
    const credential = root.credential;
    storeSessionAccess(session, credential);
    consumeConsumerInvite();
    setAiConsent(session?.aiProcessingConsented === true);
    mergePayload(payload);

    try {
      const hydrated = await getSession(getSessionId());
      mergePayload(hydrated);
    } catch (hydrationError) {
      if (recoverUnavailableSession(hydrationError)) return;
      // The creation response is sufficient to start; a later turn will refresh the session.
    }

    setBusy(false);
    enterMeetingOrFail({ focus: true });
    showToast('Your private session is ready.');
  } catch (error) {
    if (error instanceof ConsumerApiError
      && error.status > 0
      && error.status < 500
      && !['request_timeout', 'network_error'].includes(error.code)) {
      clearSessionAccess();
    }
    setFormBusy(form, false);
    showFormError(form, getErrorMessage(error));
  }
}

async function submitTurn(message) {
  if (blockForConsentRefresh()) return;
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage || state.busy) {
    return;
  }

  if (realtimeVoiceController.isLive()) {
    void realtimeVoiceController.end({ reason: 'typed_fallback' });
  }
  setBusy(true);
  renderCurrentJourney();
  if (!pendingTurn || pendingTurn.message !== cleanMessage) {
    pendingTurn = { message: cleanMessage, idempotencyKey: newIdempotencyKey() };
  }
  try {
    const payload = await addTurn(getSessionId(), {
      message: cleanMessage,
      idempotencyKey: pendingTurn.idempotencyKey
    });
    const responseRoot = unwrap(payload);
    if (!Array.isArray(responseRoot.turns)) {
      state.turns.push({
        id: `local-${pendingTurn.idempotencyKey}`,
        userMessage: cleanMessage,
        assistantMessage: String(firstDefined(
          responseRoot.assistantMessage,
          responseRoot.nextQuestion?.prompt,
          ''
        ) || '')
      });
    }
    pendingTurn = null;
    setBusy(false);
    const { profileChanged } = applyResponse(payload, { action: 'turn', focus: true });
    if (!profileChanged) {
      showToast('That answer did not add a reviewable detail. Try one figure or a short answer to the question shown.', {
        error: true,
        timeout: 7000
      });
    }
  } catch (error) {
    if (recoverUnavailableSession(error)) return;
    setBusy(false);
    renderCurrentJourney();
    const input = document.getElementById('conversationInput');
    if (input) {
      input.value = cleanMessage;
      input.focus();
    }
    showToast(getErrorMessage(error), { error: true });
  }
}

function rawEditValue(field) {
  if (typeof field.value === 'boolean') {
    return field.value ? 'Yes' : 'No';
  }
  return String(field.value ?? '');
}

function openFieldEditor(path) {
  if (blockForConsentRefresh()) return;
  const field = findProfileField(state.profile, path);
  if (!field) {
    showToast('That detail could not be opened. Refresh and try again.', { error: true });
    return;
  }
  editingField = field;
  editFieldTitle.textContent = `Edit ${field.label}`;
  const certainty = field.metadata?.certainty ? ` It is currently marked ${field.metadata.certainty}.` : '';
  editFieldContext.textContent = `This correction will create a new reviewed profile revision.${certainty}`;
  editFieldInput.type = typeof field.value === 'number' ? 'number' : 'text';
  editFieldInput.step = typeof field.value === 'number' ? 'any' : '';
  editFieldInput.value = rawEditValue(field);
  editFieldError.hidden = true;
  editFieldError.textContent = '';
  openDialog(editFieldDialog);
  window.requestAnimationFrame(() => {
    editFieldInput.focus();
    editFieldInput.select();
  });
}

function parseEditValue(field, inputValue) {
  const raw = String(inputValue || '').trim();
  if (!raw) {
    throw new Error('Enter a value before saving.');
  }
  const normalisedText = raw.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (field.path.endsWith('/lendingCategory')) {
    if (/^first time(?: buyer)?$/.test(normalisedText)) return 'first_time_buyer';
    if (/^(?:second|subsequent|second or subsequent)(?: buyer| purchase)?$/.test(normalisedText)) return 'second_or_subsequent';
    throw new Error('Enter First-time buyer or Second/subsequent purchase.');
  }
  if (field.path.endsWith('/schemeBuyerStatus')) {
    if (/^first time(?: buyer)?$/.test(normalisedText)) return 'first_time_buyer';
    if (/^fresh start(?: buyer)?$/.test(normalisedText)) return 'fresh_start';
    if (/^(?:previous owner|second time buyer)$/.test(normalisedText)) return 'previous_owner';
    throw new Error('Enter First-time buyer, Fresh start, or Previous owner.');
  }
  if (typeof field.value === 'number') {
    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value)) {
      throw new Error('Enter a valid number.');
    }
    return value;
  }
  if (typeof field.value === 'boolean') {
    if (['yes', 'true', '1'].includes(normalisedText)) {
      return true;
    }
    if (['no', 'false', '0'].includes(normalisedText)) {
      return false;
    }
    throw new Error('Enter Yes or No.');
  }
  return raw;
}

async function handleFieldEdit(event) {
  event.preventDefault();
  if (blockForConsentRefresh()) return;
  if (!editingField) {
    return;
  }
  let value;
  try {
    value = parseEditValue(editingField, editFieldInput.value);
  } catch (error) {
    editFieldError.textContent = getErrorMessage(error);
    editFieldError.hidden = false;
    return;
  }

  setFormBusy(editFieldForm, true, 'Saving…');
  try {
    const payload = await patchProfile(
      getSessionId(),
      { [editingField.path]: value },
      [editingField.path],
      currentProfileRevision()
    );
    mergePayload(payload);
    invalidatePendingAnalysisPlan();
    setView('review');
    closeDialog(editFieldDialog);
    editingField = null;
    setFormBusy(editFieldForm, false);
    renderCurrentJourney({ focus: true });
    showToast('That detail has been corrected and confirmed.');
  } catch (error) {
    setFormBusy(editFieldForm, false);
    if (recoverUnavailableSession(error)) return;
    editFieldError.textContent = getErrorMessage(error);
    editFieldError.hidden = false;
  }
}

function openRemoveItemDialog(path, label) {
  if (blockForConsentRefresh()) return;
  removingItem = { path: String(path || ''), label: String(label || 'this item') };
  removeItemTitle.textContent = `Remove ${removingItem.label}?`;
  removeItemContext.textContent = 'This removes the complete item from your profile. You will review and confirm the updated profile before running a fresh analysis.';
  removeItemError.hidden = true;
  removeItemError.textContent = '';
  openDialog(removeItemDialog);
}

async function handleRemoveItem() {
  if (blockForConsentRefresh()) return;
  if (!removingItem || state.busy) return;
  confirmRemoveItemButton.disabled = true;
  confirmRemoveItemButton.textContent = 'Removing…';
  try {
    const payload = await patchProfile(
      getSessionId(),
      {},
      [],
      currentProfileRevision(),
      [removingItem.path]
    );
    mergePayload(payload);
    invalidatePendingAnalysisPlan();
    setView('review');
    closeDialog(removeItemDialog);
    removingItem = null;
    renderCurrentJourney({ focus: true });
    showToast('The item has been removed. Review and confirm the updated information.');
  } catch (error) {
    if (recoverUnavailableSession(error)) return;
    removeItemError.textContent = getErrorMessage(error);
    removeItemError.hidden = false;
  } finally {
    confirmRemoveItemButton.disabled = false;
    confirmRemoveItemButton.textContent = 'Remove item';
  }
}

function openPrivacyControls() {
  const aiActive = state.session?.aiProcessingConsented === true
    || state.session?.consent?.aiProcessing === true;
  privacyControlsCopy.textContent = aiActive
    ? 'Stop AI assistance for this session. Future messages will use fixed questions and rules-only extraction; deterministic calculations remain available.'
    : 'AI assistance is off for this session. Messages use fixed questions and rules-only extraction; deterministic calculations remain available.';
  withdrawAiConsentButton.hidden = !aiActive && Boolean(state.session);
  const realtimeVoiceActive = getRealtimeVoiceConsent()?.granted === true;
  withdrawRealtimeVoiceConsentButton.hidden = !realtimeVoiceActive;
  realtimeVoicePrivacyCopy.hidden = !realtimeVoiceActive;
  if (realtimeVoiceActive) {
    realtimeVoicePrivacyCopy.textContent = 'Turning Live voice off immediately closes any live microphone session and stops future automatic spoken turns and voice-triggered planning tools; typed answers remain available.';
  }
  const handoffStatus = String(state.handoff?.status || '').toLowerCase();
  const canWithdrawHandoff = ['pending', 'failed', 'linked', 'delivered'].includes(handoffStatus);
  revokeHandoffButton.hidden = !canWithdrawHandoff;
  handoffPrivacyCopy.hidden = !canWithdrawHandoff;
  if (canWithdrawHandoff) {
    handoffPrivacyCopy.textContent = ['linked', 'delivered'].includes(handoffStatus)
      ? 'Your handoff has already reached Gerry. Withdrawing it purges the encrypted bridge copy and records your request to stop further use; contact hello@planeir.ie about the adviser record.'
      : 'You can withdraw the saved adviser handoff before delivery. Its encrypted package will be purged and it cannot be retried.';
  }
  privacyControlsError.hidden = true;
  privacyControlsError.textContent = '';
  openDialog(privacyControlsDialog);
}

async function handleRevokeHandoff() {
  revokeHandoffButton.disabled = true;
  revokeHandoffButton.textContent = 'Withdrawing…';
  try {
    const payload = await revokeHandoff(getSessionId());
    mergePayload(payload);
    closeDialog(privacyControlsDialog);
    if (state.bootstrap?.enabled) {
      renderCurrentJourney({ focus: true });
    } else {
      renderProcessingPaused();
      focusCurrentHeading();
    }
    showToast(payload?.downstreamShared
      ? 'The bridge copy was purged and the handoff was marked withdrawn. Contact hello@planeir.ie about information already delivered to Gerry.'
      : 'The saved adviser handoff was withdrawn and its encrypted package was purged.', {
      timeout: 9000
    });
  } catch (error) {
    if (recoverUnavailableSession(error)) return;
    privacyControlsError.textContent = getErrorMessage(error);
    privacyControlsError.hidden = false;
  } finally {
    revokeHandoffButton.disabled = false;
    revokeHandoffButton.textContent = 'Withdraw adviser handoff';
  }
}

async function handleWithdrawAiConsent() {
  withdrawAiConsentButton.disabled = true;
  withdrawAiConsentButton.textContent = 'Turning off…';
  try {
    const payload = await withdrawAiConsent(getSessionId());
    setAiConsent(false);
    mergePayload(payload);
    closeDialog(privacyControlsDialog);
    if (state.bootstrap?.enabled) {
      renderCurrentJourney();
    } else {
      renderProcessingPaused();
    }
    showToast('AI assistance is off. Future messages will use rules-only questions.');
  } catch (error) {
    if (recoverUnavailableSession(error)) return;
    privacyControlsError.textContent = getErrorMessage(error);
    privacyControlsError.hidden = false;
  } finally {
    withdrawAiConsentButton.disabled = false;
    withdrawAiConsentButton.textContent = 'Stop AI assistance';
  }
}

async function refreshSavedSession({ keepView = true } = {}) {
  if (state.busy) return null;
  setBusy(true);
  renderCurrentJourney();
  try {
    const payload = await getSession(getSessionId());
    setBusy(false);
    mergePayload(payload);
    if (!keepView) setView(chooseViewFromServer({ payload }));
    renderCurrentJourney({ focus: true });
    return payload;
  } catch (error) {
    if (recoverUnavailableSession(error)) return;
    setBusy(false);
    renderCurrentJourney();
    showToast(getErrorMessage(error), { error: true });
    return null;
  }
}

async function loadRealtimeMeetingTranscript(meetingId) {
  const turns = [];
  let cursor = '';
  let meeting = null;
  const seenCursors = new Set();
  do {
    const payload = await getRealtimeVoiceMeetingTranscript(getSessionId(), meetingId, { cursor, limit: 50 });
    meeting = payload.meeting || meeting;
    turns.push(...(Array.isArray(payload.turns) ? payload.turns : []));
    cursor = String(payload.nextCursor || '');
    if (cursor && seenCursors.has(cursor)) throw new Error('The saved meeting transcript could not be paged safely.');
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  mergePayload({ meeting, transcriptTurns: turns, nextCursor: cursor || null });
  return turns;
}

async function retrySavedHandoff() {
  if (blockForConsentRefresh()) return;
  if (state.busy) return;
  setBusy(true);
  renderCurrentJourney();
  try {
    const payload = await createHandoff(getSessionId(), {
      retry: true,
      consent: true,
      policyVersion: state.bootstrap?.handoffPolicyVersion,
      policyUrl: state.bootstrap?.handoffPolicyUrl,
      expectedRevision: currentProfileRevision()
    });
    setBusy(false);
    mergePayload(payload);
    setView('handoff');
    renderCurrentJourney({ focus: true });
  } catch (error) {
    if (recoverUnavailableSession(error)) return;
    setBusy(false);
    renderCurrentJourney();
    showToast(getErrorMessage(error), { error: true, timeout: 7000 });
  }
}

async function handleConfirmProfile() {
  if (blockForConsentRefresh()) return;
  if (state.busy || !state.profile) {
    return;
  }
  const confirmedPaths = getProfileFieldGroups(state.profile)
    .flatMap((group) => group.fields.map((field) => field.path));
  setBusy(true);
  renderCurrentJourney();
  try {
    const payload = await confirmProfile(
      getSessionId(),
      confirmedPaths.length <= 100 ? confirmedPaths : [],
      currentProfileRevision()
    );
    setBusy(false);
    applyResponse(payload, { action: 'confirm', focus: true });
    showToast('Your information is confirmed for this analysis.');
  } catch (error) {
    if (recoverUnavailableSession(error)) return;
    setBusy(false);
    renderCurrentJourney();
    showToast(getErrorMessage(error), { error: true });
  }
}

function analysisPlanFromPayload(payload) {
  const root = unwrap(payload);
  const plan = firstDefined(root.analysisPlan, root.session?.analysisPlan, root.plan);
  return plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : null;
}

async function prepareDisplayedAnalysisPlan({
  background = false,
  generation = ++planPrepareGeneration
} = {}) {
  const revision = currentProfileRevision();
  const signature = String(Number(revision || 0));
  if (!pendingPlanPrepare || pendingPlanPrepare.signature !== signature) {
    pendingPlanPrepare = {
      signature,
      idempotencyKey: newIdempotencyKey()
    };
  }
  try {
    const payload = await putAnalysisPlan(getSessionId(), {
      action: 'prepare',
      idempotencyKey: pendingPlanPrepare.idempotencyKey,
      expectedRevision: revision
    });
    if (generation !== planPrepareGeneration) return null;
    const returnedPlan = analysisPlanFromPayload(payload);
    const planId = String(firstDefined(returnedPlan?.planId, returnedPlan?.id, '') || '');
    const planNonce = String(firstDefined(returnedPlan?.planNonce, returnedPlan?.nonce, '') || '');
    const profileRevision = Number(firstDefined(
      returnedPlan?.profileRevision,
      returnedPlan?.expectedRevision,
      0
    ) || 0);
    if (!returnedPlan || !planId || !planNonce || profileRevision !== revision) {
      throw new Error('The service did not return a current, confirmable analysis plan.');
    }
    mergePayload(payload);
    pendingPlanPrepare = null;
    if (background) {
      renderCurrentJourney();
    }
    if (background) {
      showToast('Your authoritative analysis plan is saved for this private session.', { timeout: 2800 });
    }
    return { plan: state.analysisPlan || returnedPlan };
  } catch (error) {
    if (generation !== planPrepareGeneration) return null;
    if (recoverUnavailableSession(error)) return null;
    if (background) {
      showToast('Your derived plan is still displayed, but the server could not save it yet. Planéir will retry before running.', {
        error: true,
        timeout: 6500
      });
      return null;
    }
    throw error;
  }
}

async function handleRunAnalysis() {
  if (blockForConsentRefresh()) return;
  if (state.busy) {
    return;
  }
  const generation = ++planPrepareGeneration;
  setBusy(true);
  renderCurrentJourney();
  try {
    if (state.recommendations.length < 1 || state.recommendations.length > 3) {
      setBusy(false);
      renderCurrentJourney();
      showToast('A valid one-to-three-analysis plan is required before continuing.', { error: true });
      return;
    }
    const prepared = await prepareDisplayedAnalysisPlan({ generation });
    if (!prepared) {
      throw new Error('The current analysis plan could not be prepared. Please try again.');
    }
    const plan = prepared.plan || {};
    const planId = String(firstDefined(plan.planId, plan.id, '') || '');
    const planNonce = getAnalysisPlanNonce(planId);
    const expectedRevision = currentProfileRevision();
    if (!planId || !planNonce || Number(plan.profileRevision || 0) !== expectedRevision) {
      throw new Error('The displayed analysis plan is no longer current. Review it and try again.');
    }
    const confirmSignature = `${planId}:${planNonce}:${expectedRevision}`;
    if (!pendingPlanConfirm || pendingPlanConfirm.signature !== confirmSignature) {
      pendingPlanConfirm = {
        signature: confirmSignature,
        idempotencyKey: newIdempotencyKey()
      };
    }
    const payload = await putAnalysisPlan(getSessionId(), {
      action: 'confirm_and_run',
      idempotencyKey: pendingPlanConfirm.idempotencyKey,
      expectedRevision,
      planId,
      planNonce,
      confirmation: true
    });
    pendingPlanConfirm = null;
    setBusy(false);
    applyResponse(payload, { action: 'analysis', focus: true });
    if (state.analysis) {
      showToast('Your educational analysis is ready.');
    }
  } catch (error) {
    if (recoverUnavailableSession(error)) return;
    setBusy(false);
    if (error instanceof ConsumerApiError && error.code === 'analysis_missing_information') {
      const details = error.details?.details;
      if (details && typeof details === 'object') {
        mergePayload({
          recommendations: details.recommendations,
          nextQuestion: details.requiredQuestions?.[0] || state.nextQuestion,
          analysis: null
        });
      }
      setView('conversation');
      renderCurrentJourney({ focus: true });
      showToast('A little more information is needed. We have taken you to the next question.', { error: true, timeout: 7000 });
      return;
    }
    renderCurrentJourney();
    showToast(getErrorMessage(error), { error: true, timeout: 7000 });
  }
}

async function handleHandoff(form) {
  if (blockForConsentRefresh()) return;
  if (!form.reportValidity() || state.busy) {
    return;
  }
  const data = new FormData(form);
  const email = String(data.get('email') || '').trim();
  const phone = String(data.get('phone') || '').trim();
  if (!email) {
    showFormError(form, 'Please provide an email address so Gerry can follow up.');
    return;
  }
  if (data.get('handoffConsent') !== 'on') {
    showFormError(form, 'Please explicitly consent before sending this package to Gerry.');
    return;
  }

  setBusy(true);
  setFormBusy(form, true, 'Sending securely…');
  try {
    const payload = await createHandoff(getSessionId(), {
      fullName: String(data.get('fullName') || '').trim(),
      email,
      phone,
      requestedHelp: String(data.get('requestedHelp') || '').trim(),
      consent: true,
      policyVersion: state.bootstrap?.handoffPolicyVersion,
      policyUrl: state.bootstrap?.handoffPolicyUrl,
      expectedRevision: currentProfileRevision()
    });
    setBusy(false);
    mergePayload(payload);
    setView('handoff');
    renderCurrentJourney({ focus: true });
  } catch (error) {
    setBusy(false);
    setFormBusy(form, false);
    if (recoverUnavailableSession(error)) return;
    if (error instanceof ConsumerApiError && error.details?.details?.handoff) {
      mergePayload({ handoff: error.details.details.handoff });
      setView('handoff');
      renderCurrentJourney({ focus: true });
      showToast(getErrorMessage(error), { error: true, timeout: 7000 });
      return;
    }
    showFormError(form, getErrorMessage(error));
  }
}

async function handleDeleteSession() {
  await realtimeVoiceController.end({ reason: 'deletion' });
  confirmDeleteButton.disabled = true;
  confirmDeleteButton.textContent = 'Deleting…';
  try {
    const deletion = await deleteSession(getSessionId());
    clearSessionAccess();
    resetJourneyState();
    pendingTurn = null;
    closeDialog(deleteSessionDialog);
    realtimeVoiceController.reset({ notifyServer: false });
    confirmDeleteButton.disabled = false;
    confirmDeleteButton.textContent = 'Delete permanently';
    syncHeader();
    renderNewSessionEntry();
    focusCurrentHeading();
    showToast(deletion?.retainedConsentedHandoff
      ? 'Your planning session was deleted. The separate request you consented to send remains under its handoff retention policy.'
      : 'Your consumer planning session and its saved journey data have been deleted.', { timeout: 8000 });
  } catch (error) {
    confirmDeleteButton.disabled = false;
    confirmDeleteButton.textContent = 'Delete permanently';
    if (recoverUnavailableSession(error, { deletionAttempt: true })) return;
    closeDialog(deleteSessionDialog);
    showToast(getErrorMessage(error), { error: true, timeout: 7000 });
  }
}

function handleRootClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button || !appRoot.contains(button)) {
    return;
  }
  const action = button.dataset.action;
  if (action === 'navigate') {
    setView(button.dataset.view || 'conversation');
    renderCurrentJourney({ focus: true });
    return;
  }
  if (action === 'reload-page') {
    window.location.reload();
    return;
  }
  if (action === 'copy-failed-live-transcript') {
    const transcript = document.getElementById('failedLiveCallTranscript')?.value || '';
    copyTextToClipboard(transcript)
      .then(() => showToast('The full transcript was copied to your clipboard.'))
      .catch((error) => showToast(getErrorMessage(error), { error: true }));
    return;
  }
  if (action === 'open-terms') {
    // This button sits inside a consent label; stop the click toggling the checkbox.
    event.preventDefault();
    event.stopPropagation();
    openDialog(termsDialog);
    if (termsBody) {
      termsBody.scrollTop = 0;
    }
    return;
  }
  if (action === 'open-delete-dialog') {
    openDialog(deleteSessionDialog);
    return;
  }
  if (action === 'send-choice') {
    submitTurn(button.dataset.message || '');
    return;
  }
  if (action === 'copy-subscription-prompt') {
    copySubscriptionAssistPrompt();
    return;
  }
  if (action === 'edit-field') {
    openFieldEditor(button.dataset.path || '');
    return;
  }
  if (action === 'remove-profile-item') {
    openRemoveItemDialog(button.dataset.path || '', button.dataset.label || 'this item');
    return;
  }
  if (action === 'confirm-profile') {
    handleConfirmProfile();
    return;
  }
  if (action === 'run-analysis') {
    handleRunAnalysis();
    return;
  }
  if (action === 'refresh-session') {
    refreshSavedSession();
    return;
  }
  if (action === 'load-meeting-transcript') {
    button.disabled = true;
    loadRealtimeMeetingTranscript(button.dataset.meetingId || '')
      .then(() => renderCurrentJourney({ focus: true }))
      .catch((error) => showToast(getErrorMessage(error), { error: true }))
      .finally(() => { button.disabled = false; });
    return;
  }
  if (action === 'retry-handoff') {
    retrySavedHandoff();
  }
}

function handleRootSubmit(event) {
  const form = event.target.closest('form[data-action]');
  if (!form) {
    return;
  }
  event.preventDefault();
  const action = form.dataset.action;
  if (action === 'start-session') {
    handleStartSession(form);
    return;
  }
  if (action === 'send-turn') {
    const data = new FormData(form);
    submitTurn(data.get('message'));
    return;
  }
  if (action === 'create-handoff') {
    handleHandoff(form);
  }
}

function handleComposerShortcut(event) {
  if (event.target.id !== 'conversationInput') {
    return;
  }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    event.target.form?.requestSubmit();
  }
}

function bindEvents() {
  // The one live controller binds in `boot` after its bootstrap gates exist.
  // There is no runtime lane selection.
  appRoot.addEventListener('click', handleRootClick);
  appRoot.addEventListener('submit', handleRootSubmit);
  appRoot.addEventListener('keydown', handleComposerShortcut);
  editFieldForm.addEventListener('submit', handleFieldEdit);
  cancelEditButton.addEventListener('click', () => {
    editingField = null;
    closeDialog(editFieldDialog);
  });
  editFieldDialog.addEventListener('close', () => {
    editingField = null;
    document.body.classList.remove('dialog-open');
  });
  removeItemDialog.addEventListener('close', () => {
    removingItem = null;
    document.body.classList.remove('dialog-open');
  });
  cancelRemoveItemButton.addEventListener('click', () => {
    removingItem = null;
    closeDialog(removeItemDialog);
  });
  confirmRemoveItemButton.addEventListener('click', handleRemoveItem);
  privacyControlsDialog.addEventListener('close', () => {
    document.body.classList.remove('dialog-open');
  });
  privacyControlsButton.addEventListener('click', openPrivacyControls);
  closePrivacyControlsButton.addEventListener('click', () => closeDialog(privacyControlsDialog));
  withdrawAiConsentButton.addEventListener('click', handleWithdrawAiConsent);
  withdrawRealtimeVoiceConsentButton.addEventListener('click', async () => {
    await realtimeVoiceController.withdrawConsent();
    if (privacyControlsDialog?.open || privacyControlsDialog?.hasAttribute('open')) {
      closeDialog(privacyControlsDialog);
    }
    renderCurrentJourney();
  });
  revokeHandoffButton.addEventListener('click', handleRevokeHandoff);
  closeTermsButton?.addEventListener('click', () => closeDialog(termsDialog));
  termsDialog?.addEventListener('close', () => {
    document.body.classList.remove('dialog-open');
  });
  deleteSessionDialog.addEventListener('close', () => {
    document.body.classList.remove('dialog-open');
  });
  deleteSessionButton.addEventListener('click', () => {
    void realtimeVoiceController.end({ reason: 'deletion' });
    openDialog(deleteSessionDialog);
  });
  confirmDeleteButton.addEventListener('click', handleDeleteSession);
}

async function boot() {
  bindEvents();
  try {
    const capturedInvite = captureInviteFromUrlFragment();
    if (capturedInvite) {
      clearSessionAccess();
    }
    const bootstrapPayload = await getBootstrap();
    const bootstrap = setBootstrap(bootstrapPayload);
    realtimeVoiceController.bind();
    syncTermsDialog(bootstrap);
    const bootstrapRoot = unwrap(bootstrapPayload);
    if (bootstrapRoot.ai && typeof bootstrapRoot.ai === 'object') {
      state.ai = bootstrapRoot.ai;
    }
    const access = getStoredSessionAccess();
    if (!bootstrap.enabled) {
      if (access) {
        try {
          const sessionPayload = await getSession(access.sessionId);
          mergePayload(sessionPayload);
          const latestMeeting = state.realtimeMeetings?.[0];
          if (latestMeeting?.meetingId) await loadRealtimeMeetingTranscript(latestMeeting.meetingId);
        } catch (error) {
          if (recoverUnavailableSession(error)) return;
        }
        renderProcessingPaused();
      } else {
        renderUnavailable(appRoot);
        syncHeader();
      }
      return;
    }

    if (!access) {
      if (bootstrap.inviteRequired && !getConsumerInvite()) {
        renderUnavailable(appRoot, {
          message: 'This private beta requires a valid invitation link. No information has been submitted.'
        });
        syncHeader();
        return;
      }
      renderOnboarding(appRoot, bootstrap);
      syncHeader();
      return;
    }

    try {
      const sessionPayload = await getSession(access.sessionId);
      mergePayload(sessionPayload);
      const latestMeeting = state.realtimeMeetings?.[0];
      if (latestMeeting?.meetingId) await loadRealtimeMeetingTranscript(latestMeeting.meetingId);
      enterMeetingOrFail();
    } catch (error) {
      if (recoverUnavailableSession(error)) return;
      renderUnavailable(appRoot, { message: getErrorMessage(error) });
      syncHeader();
    }
  } catch (error) {
    renderUnavailable(appRoot, { message: getErrorMessage(error) });
    syncHeader();
  }
}

boot();
