const STORAGE_KEYS = Object.freeze({
  sessionId: 'planeir.consumer.session-id.v1',
  credential: 'planeir.consumer.credential.v1',
  aiConsent: 'planeir.consumer.ai-consent.v1',
  analysisPlanId: 'planeir.consumer.analysis-plan-id.v1',
  analysisPlanNonce: 'planeir.consumer.analysis-plan-nonce.v1'
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
  realtimeMeetings: [],
  realtimeTurns: [],
  selectedRealtimeMeeting: null,
  nextQuestion: null,
  recommendations: [],
  analysisPlan: null,
  analysis: null,
  handoff: null,
  consentRefreshRequired: false,
  ai: null,
  voice: {
    consent: null,
    realtimeConsent: null,
    budget: null,
    realtimeBudget: null
  },
  selectedModuleIds: [],
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
  const realtimeVoice = asObject(firstDefined(
    voice.realtime,
    root.realtimeVoice,
    root.voiceRealtime
  )) || {};
  const voiceBudget = normaliseVoiceBudget(firstDefined(
    voice.availability,
    voice.budget,
    root.voiceBudget,
    root.voiceAvailability,
    root.consumerVoiceBudget
  ));
  const realtimeVoiceBudget = normaliseVoiceBudget(firstDefined(
    realtimeVoice.availability,
    realtimeVoice.budget,
    root.realtimeVoiceBudget,
    root.realtimeVoiceAvailability,
    root.voiceRealtimeBudget
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
    voiceRealtimeEnabled: flags.consumerVoiceRealtimeEnabled === true
      || flags.consumerRealtimeVoiceEnabled === true
      || voice.realtimeEnabled === true
      || realtimeVoice.enabled === true,
    voiceRealtimeNoticeId: String(firstDefined(
      realtimeVoice.noticeId,
      root.voiceRealtimeNoticeId,
      disclosures.voiceRealtimeNoticeId,
      ''
    ) || ''),
    voiceRealtimePolicyVersion: String(firstDefined(
      realtimeVoice.policyVersion,
      root.voiceRealtimePolicyVersion,
      disclosures.voiceRealtimePolicyVersion,
      ''
    ) || ''),
    voiceRealtimePrivacyNoticeUrl: String(firstDefined(
      realtimeVoice.privacyNoticeUrl,
      root.voiceRealtimePrivacyNoticeUrl,
      root.privacyNoticeUrl,
      ''
    ) || ''),
    voiceRealtimeDataPolicyId: String(firstDefined(
      realtimeVoice.dataPolicyId,
      root.voiceRealtimeDataPolicyId,
      ''
    ) || ''),
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
    voiceRealtimeModel: String(firstDefined(
      realtimeVoice.model,
      voice.realtimeModel,
      root.voiceRealtimeModel,
      ''
    ) || ''),
    // Which conversation lane this deployment runs. Needed BEFORE a call is
    // created, because each lane has its own controller and the controller is
    // what creates the call. The call response echoes the same value back as
    // `X-Realtime-Conversation-Version` so the choice can be verified.
    voiceRealtimeConversationVersion: String(firstDefined(
      realtimeVoice.conversationVersion,
      ''
    ) || ''),
    voiceRealtimeMaxSeconds: Math.min(900, Math.max(15, Number(firstDefined(
      realtimeVoice.maxSessionSeconds,
      realtimeVoice.maxDurationSeconds,
      voice.realtimeMaxSeconds,
      root.voiceRealtimeMaxSeconds,
      300
    )) || 300)),
    voiceRealtimePollSeconds: Math.min(60, Math.max(10, Number(firstDefined(
      realtimeVoice.leasePollSeconds,
      voice.realtimePollSeconds,
      root.voiceRealtimePollSeconds,
      20
    )) || 20)),
    voiceMaxRecordingSeconds: Math.min(45, Math.max(1, Number(firstDefined(
      voice.maxRecordingSeconds,
      voice.maxDurationSeconds,
      root.voiceMaxRecordingSeconds,
      45
    )) || 45)),
    voiceBudget,
    realtimeVoiceBudget,
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
  if (state.bootstrap.realtimeVoiceBudget) {
    state.voice.realtimeBudget = state.bootstrap.realtimeVoiceBudget;
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
  if (typeof budget.available === 'boolean') {
    return {
      available: budget.available,
      status: String(budget.status || (budget.available ? 'available' : 'unavailable'))
    };
  }
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
    available: Number(remainingMicroEur || 0) > 0,
    status: Number(remainingMicroEur || 0) > 0 ? 'available' : 'unavailable'
  };
}

export function mergeVoicePayload(payload) {
  const root = unwrap(payload);
  const voice = asObject(root.voice) || {};
  const session = asObject(root.session) || {};
  const realtimeVoice = asObject(firstDefined(
    root.realtimeVoice,
    root.voiceRealtime,
    voice.realtime
  )) || {};
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
  const realtimeConsent = asObject(firstDefined(
    root.realtimeConsent,
    root.realtimeVoiceConsent,
    root.voiceRealtimeConsent,
    voice.realtimeConsent,
    asObject(session.voice)?.realtimeConsent,
    session.realtimeVoiceConsent
  ));
  if (realtimeConsent) {
    state.voice.realtimeConsent = {
      ...(state.voice.realtimeConsent || {}),
      ...realtimeConsent,
      granted: realtimeConsent.granted === true
    };
  }
  const budget = normaliseVoiceBudget(firstDefined(
    root.voiceAvailability,
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
  const realtimeBudget = normaliseVoiceBudget(firstDefined(
    root.realtimeVoiceAvailability,
    root.realtimeVoiceBudget,
    root.voiceRealtimeBudget,
    realtimeVoice.budget,
    voice.realtimeBudget,
    session.realtimeVoiceBudget
  ));
  if (realtimeBudget) {
    state.voice.realtimeBudget = {
      ...(state.voice.realtimeBudget || {}),
      ...realtimeBudget
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
    if (state.analysisPlan) {
      state.analysisPlan = {
        ...state.analysisPlan,
        planNonce: '',
        profileRevision: currentRevision,
        status: 'stale'
      };
      clearAnalysisPlanNonce();
    }
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
  const realtimeMeetings = asArray(root.realtimeMeetings);
  if (realtimeMeetings) state.realtimeMeetings = realtimeMeetings;
  const realtimeTurns = asArray(root.realtimeTurns);
  if (realtimeTurns) {
    const byId = new Map(state.realtimeTurns.map((turn) => [turn.id, turn]));
    realtimeTurns.forEach((turn) => byId.set(turn.id, turn));
    state.realtimeTurns = [...byId.values()].sort((left, right) => (
      String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
      || String(left.id || '').localeCompare(String(right.id || ''))
    ));
  }
  const transcriptMeeting = asObject(root.meeting);
  const transcriptTurns = asArray(root.transcriptTurns) || (
    transcriptMeeting && asArray(root.turns) ? root.turns : null
  );
  if (transcriptMeeting && transcriptTurns) {
    state.selectedRealtimeMeeting = {
      ...transcriptMeeting,
      turns: transcriptTurns,
      nextCursor: root.nextCursor || null
    };
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

  const persistedAnalysisPlan = asObject(firstDefined(root.analysisPlan, incomingSession?.analysisPlan));
  const recommendationPlan = asObject(firstDefined(root.analysisPlan, root.plan, incomingSession?.analysisPlan));
  const recommendations = asArray(firstDefined(
    root.recommendations,
    recommendationPlan?.recommendations,
    incomingSession?.recommendations
  ));
  if (recommendations) {
    const nextSelection = new Set();
    recommendations.forEach((item) => {
      const moduleId = String(firstDefined(item?.moduleId, item?.id, item?.module?.id, '') || '');
      if (!moduleId) {
        return;
      }
      const readinessStatus = String(firstDefined(item?.readiness?.status, '') || '');
      const availability = String(firstDefined(item?.availability, '') || '');
      const consumerRunnable = availability !== 'adviser_review_required'
        && !['adviser_review_required', 'unsupported', 'not_relevant'].includes(readinessStatus);
      if (consumerRunnable) nextSelection.add(moduleId);
    });
    state.selectedModuleIds = [...nextSelection];
    state.recommendations = recommendations;
  }
  if (persistedAnalysisPlan) {
    const rawPlanModuleIds = asArray(firstDefined(
      persistedAnalysisPlan.moduleIds,
      persistedAnalysisPlan.selectedModuleIds,
      persistedAnalysisPlan.modules
    ));
    const planId = String(firstDefined(
      persistedAnalysisPlan.planId,
      persistedAnalysisPlan.id,
      ''
    ) || '');
    const planNonce = String(firstDefined(
      persistedAnalysisPlan.planNonce,
      persistedAnalysisPlan.nonce,
      ''
    ) || '');
    state.analysisPlan = {
      ...persistedAnalysisPlan,
      planId,
      planNonce,
      moduleIds: (rawPlanModuleIds || [])
        .map((item) => String(firstDefined(item?.moduleId, item?.id, item, '') || ''))
        .filter(Boolean),
      profileRevision: Number(firstDefined(
        persistedAnalysisPlan.profileRevision,
        persistedAnalysisPlan.expectedRevision,
        currentRevision,
        0
      ) || 0),
      status: String(firstDefined(persistedAnalysisPlan.status, '') || '')
    };
    if (rawPlanModuleIds) {
      state.selectedModuleIds = [...new Set(state.analysisPlan.moduleIds)];
    }
    if (planId && planNonce) {
      storeAnalysisPlanNonce(planId, planNonce);
    } else {
      clearAnalysisPlanNonce();
    }
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

export function storeAnalysisPlanNonce(planId, planNonce) {
  const cleanPlanId = String(planId || '').trim();
  const cleanNonce = String(planNonce || '').trim();
  if (!cleanPlanId || !cleanNonce) {
    clearAnalysisPlanNonce();
    return;
  }
  try {
    const storage = getSessionStorage();
    storage?.setItem(STORAGE_KEYS.analysisPlanId, cleanPlanId);
    storage?.setItem(STORAGE_KEYS.analysisPlanNonce, cleanNonce);
  } catch (_error) {
    // State remains available for this page even when session storage is blocked.
  }
}

export function getAnalysisPlanNonce(planId = state.analysisPlan?.planId) {
  const cleanPlanId = String(planId || '').trim();
  if (!cleanPlanId) return '';
  const liveNonce = String(state.analysisPlan?.planId || '') === cleanPlanId
    ? String(state.analysisPlan?.planNonce || '')
    : '';
  if (liveNonce) return liveNonce;
  return storageGet(STORAGE_KEYS.analysisPlanId) === cleanPlanId
    ? storageGet(STORAGE_KEYS.analysisPlanNonce).trim()
    : '';
}

export function clearAnalysisPlanNonce() {
  storageRemove(STORAGE_KEYS.analysisPlanId);
  storageRemove(STORAGE_KEYS.analysisPlanNonce);
  if (state.analysisPlan && typeof state.analysisPlan === 'object') {
    state.analysisPlan.planNonce = '';
  }
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

export function getRealtimeVoiceConsent() {
  if (state.voice?.realtimeConsent && typeof state.voice.realtimeConsent === 'object') {
    return state.voice.realtimeConsent;
  }
  const direct = state.session?.realtimeVoiceConsent || state.session?.voiceRealtimeConsent;
  return direct && typeof direct === 'object' ? direct : null;
}

export function clearRealtimeVoiceConsent() {
  // CLEAR EVERY COPY THE READER CAN SEE.
  //
  // getRealtimeVoiceConsent falls back to the receipt restored with the
  // session, so nulling the voice copy alone left the fallback to hand the
  // same stale receipt straight back. The Worker would refuse the call, the
  // controller would "clear" the consent, the client would still believe it
  // held a current one, and openConsentDialog would take its already-granted
  // early return — so the disclosure never opened and the meeting could not
  // be started or re-agreed. Every retry repeated it.
  state.voice.realtimeConsent = null;
  if (state.session && typeof state.session === 'object') {
    delete state.session.realtimeVoiceConsent;
    delete state.session.voiceRealtimeConsent;
    if (state.session.voice && typeof state.session.voice === 'object') {
      delete state.session.voice.realtimeConsent;
    }
  }
}

export function hasCurrentRealtimeVoiceConsent() {
  const consent = getRealtimeVoiceConsent();
  if (consent?.granted !== true) return false;
  if (consent.current === false) return false;
  if (consent.withdrawnAt) return false;
  const expectedNoticeId = String(state.bootstrap?.voiceRealtimeNoticeId || '');
  const expectedPolicyVersion = String(state.bootstrap?.voiceRealtimePolicyVersion || '');
  if (!expectedNoticeId || !expectedPolicyVersion) return false;
  // COMPARE EVERY FIELD THE DISCLOSURE DECLARES, AND FAIL TOWARDS SHOWING IT.
  //
  // The Worker compares five things: granted, notice, data policy, policy
  // version and privacy URL. A receipt that predates one of them used to skip
  // the comparison and pass here while the Worker refused the call — an
  // unresolvable disagreement, because the only way to obtain a fresh receipt
  // is the dialog this function decides whether to skip.
  //
  // A field the bootstrap does not declare cannot be compared and is left
  // alone; a field it DOES declare must be present and equal. Being wrong in
  // this direction shows the disclosure one extra time, which costs a tap.
  // Being wrong in the other direction is the dead end above.
  const declared = [
    [expectedNoticeId, consent.noticeId],
    [expectedPolicyVersion, consent.policyVersion],
    [String(state.bootstrap?.voiceRealtimeDataPolicyId || ''), consent.dataPolicyId],
    [String(state.bootstrap?.voiceRealtimePrivacyNoticeUrl || ''), consent.privacyNoticeUrl]
  ];
  return declared.every(([expected, held]) => (
    !expected || String(held || '') === expected
  ));
}

export function clearSessionAccess() {
  Object.values(STORAGE_KEYS).forEach(storageRemove);
}

export function resetJourneyState() {
  state.session = null;
  state.profile = null;
  state.turns = [];
  state.realtimeMeetings = [];
  state.realtimeTurns = [];
  state.selectedRealtimeMeeting = null;
  state.nextQuestion = null;
  state.recommendations = [];
  state.analysisPlan = null;
  state.analysis = null;
  state.handoff = null;
  state.consentRefreshRequired = false;
  state.ai = null;
  state.voice = {
    consent: null,
    realtimeConsent: null,
    budget: state.bootstrap?.voiceBudget || null,
    realtimeBudget: state.bootstrap?.realtimeVoiceBudget || null
  };
  state.selectedModuleIds = [];
  state.view = 'conversation';
  state.busy = false;
}

export function setView(view) {
  state.view = view;
}

export function setBusy(busy) {
  state.busy = busy === true;
}
