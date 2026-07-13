const STORAGE_KEYS = Object.freeze({
  sessionId: 'planeir.consumer.session-id.v1',
  credential: 'planeir.consumer.credential.v1',
  aiConsent: 'planeir.consumer.ai-consent.v1'
});
const INVITE_STORAGE_KEY = 'planeir.consumer.invite.v1';

function getSessionStorage() {
  try {
    return window.sessionStorage;
  } catch (_error) {
    return null;
  }
}

function storageGet(key) {
  try {
    return getSessionStorage()?.getItem(key) || '';
  } catch (_error) {
    return '';
  }
}

function storageRemove(key) {
  try {
    getSessionStorage()?.removeItem(key);
  } catch (_error) {
    // Best-effort cleanup only.
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : null;
}

function unwrap(payload) {
  const root = asObject(payload) || {};
  return asObject(root.data) || root;
}

export const state = {
  bootstrap: null,
  session: null,
  profile: null,
  turns: [],
  nextQuestion: null,
  recommendations: [],
  analysis: null,
  handoff: null,
  consentRefreshRequired: false,
  ai: null,
  voice: {
    consent: null,
    budget: null
  },
  selectedModuleIds: [],
  knownRecommendationIds: [],
  view: 'conversation',
  busy: false
};

export function normaliseBootstrap(payload) {
  const root = unwrap(payload);
  const flags = asObject(firstDefined(root.flags, root.featureFlags, root.publicFlags)) || root;
  const limits = asObject(firstDefined(root.limits, root.publicLimits)) || {};
  const links = asObject(root.links) || {};
  const access = asObject(root.access) || {};
  const disclosures = asObject(firstDefined(root.disclosures, root.disclosureVersions)) || {};
  const voice = asObject(root.voice) || {};
  const voiceBudget = normaliseVoiceBudget(firstDefined(
    voice.budget,
    root.voiceBudget,
    root.consumerVoiceBudget,
    voice.sessionBudgetMicroEur !== undefined
      ? {
          limitMicroEur: voice.sessionBudgetMicroEur,
          spentMicroEur: 0,
          remainingMicroEur: voice.sessionBudgetMicroEur
        }
      : null
  ));
  const rawAllowedModules = asArray(firstDefined(
    flags.consumerAllowedModuleIds,
    root.allowedModules,
    root.consumerAllowedModuleIds
  )) || [];
  const allowedModuleIds = rawAllowedModules.map((item) => {
    if (typeof item === 'string') {
      return item;
    }
    return String(firstDefined(item?.moduleId, item?.id, '') || '');
  }).filter(Boolean);

  return {
    enabled: flags.consumerJourneyEnabled === true,
    aiEnabled: flags.consumerAiIntakeEnabled === true,
    routingEnabled: flags.consumerModuleRoutingEnabled !== false,
    handoffEnabled: flags.consumerHumanHandoffEnabled === true,
    handoffPolicyVersion: String(firstDefined(root.handoff?.policyVersion, '') || ''),
    handoffPolicyUrl: String(firstDefined(root.handoff?.policyUrl, '') || ''),
    handoffRetentionPolicyId: String(firstDefined(root.handoff?.retentionPolicyId, '') || ''),
    handoffRetentionDays: Number(firstDefined(root.handoff?.packageRetentionDays, 0) || 0),
    analysisNoticeId: String(firstDefined(root.analysisNoticeId, '') || ''),
    aiNoticeId: String(firstDefined(root.ai?.noticeId, '') || ''),
    privacyNoticeUrl: String(firstDefined(root.privacyNoticeUrl, '') || ''),
    inviteRequired: access.inviteRequired === true,
    voiceEnabled: flags.consumerVoiceEnabled === true || voice.enabled === true,
    voiceNoticeId: String(firstDefined(
      voice.noticeId,
      root.voiceNoticeId,
      disclosures.voiceNoticeId,
      ''
    ) || ''),
    voicePolicyVersion: String(firstDefined(
      voice.policyVersion,
      root.voicePolicyVersion,
      disclosures.voicePolicyVersion,
      disclosures.consumerPolicyVersion,
      root.consentPolicyVersion,
      root.policyVersion,
      ''
    ) || ''),
    voicePrivacyNoticeUrl: String(firstDefined(
      voice.privacyNoticeUrl,
      root.voicePrivacyNoticeUrl,
      root.privacyNoticeUrl,
      ''
    ) || ''),
    voiceDataPolicyId: String(firstDefined(voice.dataPolicyId, root.voiceDataPolicyId, '') || ''),
    voicePricingVersion: String(firstDefined(voice.pricingVersion, root.voicePricingVersion, '') || ''),
    voiceAiGeneratedDisclosure: String(firstDefined(
      voice.aiGeneratedDisclosure,
      root.voiceAiGeneratedDisclosure,
      'The playback voice is AI-generated.'
    ) || ''),
    voiceTranscriptionModel: String(firstDefined(voice.transcriptionModel, '') || ''),
    voiceSpeechModel: String(firstDefined(voice.speechModel, '') || ''),
    voiceName: String(firstDefined(voice.voice, '') || ''),
    voiceMaxRecordingSeconds: Math.min(45, Math.max(1, Number(firstDefined(
      voice.maxRecordingSeconds,
      voice.maxDurationSeconds,
      root.voiceMaxRecordingSeconds,
      45
    )) || 45)),
    voiceBudget,
    allowedModuleIds,
    cohort: String(firstDefined(flags.cohort, root.cohort, 'private_beta')),
    bookingUrl: String(firstDefined(root.bookingUrl, links.bookingUrl, '') || '').trim(),
    policyVersion: String(firstDefined(
      disclosures.consumerPolicyVersion,
      disclosures.policyVersion,
      root.consentPolicyVersion,
      root.policyVersion,
      'consumer-v1'
    )),
    consentManifestId: String(firstDefined(root.consentManifestId, '') || ''),
    limits
  };
}

export function setBootstrap(payload) {
  state.bootstrap = normaliseBootstrap(payload);
  if (state.bootstrap.voiceBudget) {
    state.voice.budget = state.bootstrap.voiceBudget;
  }
  return state.bootstrap;
}

function normaliseMicroEur(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : null;
}

export function normaliseVoiceBudget(value) {
  const budget = asObject(value);
  if (!budget) return null;
  const limitMicroEur = normaliseMicroEur(firstDefined(
    budget.limitMicroEur,
    budget.sessionLimitMicroEur
  ));
  const spentMicroEur = normaliseMicroEur(firstDefined(budget.spentMicroEur, 0));
  let remainingMicroEur = normaliseMicroEur(budget.remainingMicroEur);
  if (remainingMicroEur === null && limitMicroEur !== null && spentMicroEur !== null) {
    remainingMicroEur = Math.max(0, limitMicroEur - spentMicroEur);
  }
  if (limitMicroEur === null && spentMicroEur === null && remainingMicroEur === null) {
    return null;
  }
  return {
    limitMicroEur,
    spentMicroEur,
    remainingMicroEur
  };
}

export function mergeVoicePayload(payload) {
  const root = unwrap(payload);
  const voice = asObject(root.voice) || {};
  const session = asObject(root.session) || {};
  const consent = asObject(firstDefined(
    root.voiceConsent,
    voice.consent,
    session.voiceConsent
  ));
  if (consent) {
    state.voice.consent = {
      ...(state.voice.consent || {}),
      ...consent,
      granted: consent.granted === true
    };
  }
  const budget = normaliseVoiceBudget(firstDefined(
    root.voiceBudget,
    voice.budget,
    session.voiceBudget
  ));
  if (budget) {
    state.voice.budget = {
      ...(state.voice.budget || {}),
      ...budget
    };
  }
  return state.voice;
}

export function mergePayload(payload) {
  const root = unwrap(payload);
  const incomingSession = asObject(root.session);
  const previousRevision = Number(firstDefined(
    state.session?.currentProfileRevision,
    state.session?.profileRevision,
    state.profile?.revision,
    0
  ) || 0);

  if (incomingSession) {
    state.session = {
      ...(state.session || {}),
      ...incomingSession
    };
  } else if (root.sessionId || root.id) {
    state.session = {
      ...(state.session || {}),
      id: firstDefined(root.sessionId, root.id)
    };
  }
  if (Object.hasOwn(root, 'consentRefreshRequired')) {
    state.consentRefreshRequired = root.consentRefreshRequired === true;
  }

  const profile = asObject(firstDefined(
    root.profile,
    root.householdProfile,
    incomingSession?.profile
  ));
  if (profile) {
    state.profile = profile;
  }
  const currentRevision = Number(firstDefined(
    state.session?.currentProfileRevision,
    state.session?.profileRevision,
    state.profile?.revision,
    0
  ) || 0);
  if (previousRevision > 0 && currentRevision > 0 && previousRevision !== currentRevision) {
    state.analysis = null;
  }

  const turns = asArray(firstDefined(
    root.turns,
    root.conversationTurns,
    asObject(root.conversation)?.turns,
    incomingSession?.turns
  ));
  if (turns) {
    state.turns = turns;
  }

  const nextQuestion = firstDefined(
    root.nextQuestion,
    root.question,
    asObject(root.conversation)?.nextQuestion,
    incomingSession?.nextQuestion
  );
  if (nextQuestion !== undefined && nextQuestion !== null) {
    state.nextQuestion = nextQuestion;
  } else if ('nextQuestion' in root || 'question' in root) {
    state.nextQuestion = null;
  }

  const analysisPlan = asObject(firstDefined(root.analysisPlan, root.plan, incomingSession?.analysisPlan));
  const recommendations = asArray(firstDefined(
    root.recommendations,
    analysisPlan?.recommendations,
    incomingSession?.recommendations
  ));
  if (recommendations) {
    const previousSelection = new Set(state.selectedModuleIds);
    const previousKnown = new Set(state.knownRecommendationIds);
    const nextSelection = new Set();
    const nextKnown = [];
    recommendations.forEach((item) => {
      const moduleId = String(firstDefined(item?.moduleId, item?.id, item?.module?.id, '') || '');
      if (!moduleId) {
        return;
      }
      nextKnown.push(moduleId);
      const recommendationStatus = String(firstDefined(item?.status, 'recommended'));
      const readinessStatus = String(firstDefined(item?.readiness?.status, '') || '');
      const consumerRunnable = !['adviser_review_required', 'unsupported', 'not_relevant'].includes(readinessStatus);
      if (consumerRunnable && (recommendationStatus === 'required'
          || previousSelection.has(moduleId)
          || (!previousKnown.has(moduleId) && recommendationStatus === 'recommended'))) {
        nextSelection.add(moduleId);
      }
    });
    state.selectedModuleIds = [...nextSelection];
    state.knownRecommendationIds = nextKnown;
    state.recommendations = recommendations;
  }

  const analysis = firstDefined(
    root.analysis,
    root.analysisRun,
    root.analysisResult,
    incomingSession?.analysis
  );
  if (analysis !== undefined && analysis !== null) {
    state.analysis = {
      ...(asObject(analysis) || { results: analysis }),
      ...(root.summary !== undefined ? { summary: root.summary } : {}),
      ...(root.errors !== undefined ? { errors: root.errors } : {}),
      ...(root.results !== undefined ? { results: root.results } : {}),
      ...(root.plan !== undefined ? { plan: root.plan } : {}),
      ...(root.analysisPlan !== undefined ? { analysisPlan: root.analysisPlan } : {})
    };
  } else if (Array.isArray(root.results)) {
    state.analysis = {
      results: root.results,
      summary: root.summary,
      errors: root.errors,
      plan: root.plan,
      analysisPlan: root.analysisPlan
    };
  } else if (Object.hasOwn(root, 'analysis') || Object.hasOwn(root, 'analysisRun') || Object.hasOwn(root, 'analysisResult')) {
    state.analysis = null;
  }

  const handoff = asObject(firstDefined(root.handoff, root.handoffRequest));
  if (handoff) {
    state.handoff = handoff;
  }
  if (Object.hasOwn(root, 'bookingUrl') && state.bootstrap) {
    state.bootstrap.bookingUrl = String(root.bookingUrl || '').trim();
  }

  const ai = asObject(firstDefined(root.ai, root.aiStatus, incomingSession?.ai));
  if (ai) {
    state.ai = ai;
  }
  const extraction = asObject(root.extraction);
  if (extraction?.mode) {
    const mode = String(extraction.mode);
    state.ai = {
      ...(state.ai || {}),
      mode,
      status: mode === 'ai' ? 'active' : extraction.aiFallbackCode ? 'fallback' : 'rules_only',
      fallbackCode: extraction.aiFallbackCode || null
    };
  }

  mergeVoicePayload(payload);

  return state;
}

export function getSessionId() {
  const liveId = firstDefined(state.session?.id, state.session?.sessionId);
  if (liveId) {
    return String(liveId);
  }

  return storageGet(STORAGE_KEYS.sessionId).trim();
}

export function getSessionCredential() {
  return storageGet(STORAGE_KEYS.credential).trim();
}

export function canUseSessionStorage() {
  const storage = getSessionStorage();
  if (!storage) return false;
  const key = `planeir.consumer.probe.${Date.now()}`;
  try {
    storage.setItem(key, 'ok');
    const available = storage.getItem(key) === 'ok';
    storage.removeItem(key);
    return available;
  } catch (_error) {
    try { storage.removeItem(key); } catch (_cleanupError) { /* noop */ }
    return false;
  }
}

export function captureInviteFromUrlFragment() {
  const rawHash = String(window.location.hash || '').replace(/^#/, '');
  if (!rawHash) return '';
  const params = new URLSearchParams(rawHash);
  const invite = String(params.get('invite') || '').trim();
  let capturedInvite = '';
  if (/^ci1\.[A-Za-z0-9_-]{20,900}\.[A-Za-z0-9_-]{43}$/.test(invite)) {
    try {
      getSessionStorage()?.setItem(INVITE_STORAGE_KEY, invite);
      capturedInvite = invite;
    } catch (_error) {
      capturedInvite = '';
    }
  }
  if (params.has('invite')) {
    params.delete('invite');
    const remaining = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`);
  }
  return capturedInvite;
}

export function getConsumerInvite() {
  return storageGet(INVITE_STORAGE_KEY).trim();
}

export function consumeConsumerInvite() {
  storageRemove(INVITE_STORAGE_KEY);
}

export function getStoredSessionAccess() {
  const sessionId = getSessionId();
  const credential = getSessionCredential();
  return sessionId && credential ? { sessionId, credential } : null;
}

export function storeSessionAccess(session, credential) {
  const sessionId = String(firstDefined(session?.id, session?.sessionId, '') || '').trim();
  const cleanCredential = String(credential || '').trim();
  if (!sessionId || !cleanCredential) {
    throw new Error('The session response did not include valid private access details.');
  }

  const storage = getSessionStorage();
  if (!storage) {
    throw new Error('This browser cannot keep private session access for this tab.');
  }

  try {
    storage.setItem(STORAGE_KEYS.sessionId, sessionId);
    storage.setItem(STORAGE_KEYS.credential, cleanCredential);
  } catch (error) {
    storageRemove(STORAGE_KEYS.sessionId);
    storageRemove(STORAGE_KEYS.credential);
    throw error;
  }
}

function randomBase64Url(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function preparePendingSessionAccess() {
  const existing = getStoredSessionAccess();
  if (existing && /^cs_[A-Za-z0-9_-]{20,80}\.[A-Za-z0-9_-]{40,80}$/.test(existing.credential)) {
    return existing;
  }
  const sessionId = `cs_${randomBase64Url(18)}`;
  const credential = `${sessionId}.${randomBase64Url(32)}`;
  storeSessionAccess({ sessionId }, credential);
  return { sessionId, credential };
}

export function setAiConsent(granted) {
  try {
    getSessionStorage()?.setItem(STORAGE_KEYS.aiConsent, granted ? 'true' : 'false');
  } catch (_error) {
    // The server-side consent record remains authoritative.
  }
}

export function getAiConsent() {
  const stored = storageGet(STORAGE_KEYS.aiConsent);
  if (stored === 'true' || stored === 'false') {
    return stored === 'true';
  }

  const consent = state.session?.consent;
  if (Array.isArray(consent)) {
    return consent.some((item) => item?.purpose === 'ai_processing' && item?.granted === true);
  }

  if (consent && typeof consent === 'object') {
    return consent.aiProcessing === true;
  }

  return false;
}

export function getVoiceConsent() {
  if (state.voice?.consent && typeof state.voice.consent === 'object') {
    return state.voice.consent;
  }

  const direct = state.session?.voiceConsent;
  if (direct && typeof direct === 'object') {
    return direct;
  }

  const consent = state.session?.consent;
  if (Array.isArray(consent)) {
    return consent.find((item) => item?.purpose === 'voice_processing') || null;
  }
  if (consent && typeof consent === 'object' && Object.hasOwn(consent, 'voiceProcessing')) {
    return {
      granted: consent.voiceProcessing === true,
      noticeId: consent.voiceNoticeId,
      policyVersion: consent.voicePolicyVersion
    };
  }
  return null;
}

export function hasCurrentVoiceConsent() {
  const consent = getVoiceConsent();
  if (consent?.granted !== true) return false;
  const expectedNoticeId = String(state.bootstrap?.voiceNoticeId || '');
  const expectedPolicyVersion = String(state.bootstrap?.voicePolicyVersion || '');
  const actualNoticeId = String(consent.noticeId || '');
  const actualPolicyVersion = String(consent.policyVersion || '');
  if (expectedNoticeId && actualNoticeId !== expectedNoticeId) return false;
  if (expectedPolicyVersion && actualPolicyVersion !== expectedPolicyVersion) return false;
  return true;
}

export function clearSessionAccess() {
  Object.values(STORAGE_KEYS).forEach(storageRemove);
}

export function resetJourneyState() {
  state.session = null;
  state.profile = null;
  state.turns = [];
  state.nextQuestion = null;
  state.recommendations = [];
  state.analysis = null;
  state.handoff = null;
  state.consentRefreshRequired = false;
  state.ai = null;
  state.voice = {
    consent: null,
    budget: state.bootstrap?.voiceBudget || null
  };
  state.selectedModuleIds = [];
  state.knownRecommendationIds = [];
  state.view = 'conversation';
  state.busy = false;
}

export function setView(view) {
  state.view = view;
}

export function setBusy(busy) {
  state.busy = busy === true;
}

export function setModuleSelected(moduleId, selected) {
  const cleanId = String(moduleId || '').trim();
  if (!cleanId) {
    return;
  }
  const selectedIds = new Set(state.selectedModuleIds);
  if (selected) {
    selectedIds.add(cleanId);
  } else {
    selectedIds.delete(cleanId);
  }
  state.selectedModuleIds = [...selectedIds];
}
