import { validInviteSigningKey } from './invite.js';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const SAFE_MODEL_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const SAFE_VOICE_NAMES = new Set([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'marin', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'cedar'
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function enabled(value) {
  if (value === true) return true;
  return TRUE_VALUES.has(text(value).toLowerCase());
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(text(value), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function optionalBoundedInteger(value, minimum, maximum) {
  const candidate = text(value);
  if (!candidate) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(candidate)) return null;
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function modelId(value, fallback) {
  const candidate = text(value);
  return SAFE_MODEL_ID.test(candidate) ? candidate : fallback;
}

function reasoningEffort(value, fallback) {
  const candidate = text(value).toLowerCase();
  return ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(candidate) ? candidate : fallback;
}

function voiceName(value, fallback = 'nova') {
  const candidate = text(value).toLowerCase();
  return SAFE_VOICE_NAMES.has(candidate) ? candidate : fallback;
}

function bookingUrl(value) {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch (_error) {
    return null;
  }
}

function policyId(value) {
  const candidate = text(value);
  return /^[A-Za-z0-9._:-]{1,120}$/.test(candidate) ? candidate : '';
}

function validEncryptionKey(value) {
  const candidate = text(value);
  if (!/^[A-Za-z0-9_-]{43,44}$/.test(candidate)) return false;
  try {
    const normalized = candidate.replace(/-/g, '+').replace(/_/g, '/');
    return atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4)).length === 32;
  } catch (_error) {
    return false;
  }
}

export function getConsumerConfig(env) {
  const requestedJourneyEnabled = enabled(env.CONSUMER_JOURNEY_ENABLED);
  const encryptionKeyConfigured = validEncryptionKey(env.CONSUMER_DATA_ENCRYPTION_KEY);
  const rateLimitHashKeyConfigured = validEncryptionKey(env.CONSUMER_RATE_LIMIT_HASH_KEY);
  const dbConfigured = Boolean(env.CONSUMER_DB);
  const consentPolicyVersion = policyId(env.CONSUMER_CONSENT_POLICY_VERSION);
  const consentManifestId = policyId(env.CONSUMER_CONSENT_MANIFEST_ID);
  const analysisNoticeId = policyId(env.CONSUMER_ANALYSIS_NOTICE_ID);
  const aiNoticeId = policyId(env.CONSUMER_AI_NOTICE_ID);
  const privacyNoticeUrl = bookingUrl(env.CONSUMER_PRIVACY_NOTICE_URL);
  const sessionTtlDays = optionalBoundedInteger(env.CONSUMER_SESSION_TTL_DAYS, 1, 90);
  const policyConfigured = Boolean(
    consentPolicyVersion
    && consentManifestId
    && analysisNoticeId
    && aiNoticeId
    && privacyNoticeUrl
    && sessionTtlDays
  );
  const journeyConfigured = encryptionKeyConfigured
    && rateLimitHashKeyConfigured
    && dbConfigured
    && policyConfigured;
  const journeyEnabled = requestedJourneyEnabled && journeyConfigured;
  const aiRequested = enabled(env.CONSUMER_AI_INTAKE_ENABLED);
  const aiDataPolicyId = policyId(env.CONSUMER_AI_DATA_POLICY_ID);
  const aiConfigured = Boolean(text(env.OPENAI_API_KEY) && aiDataPolicyId && aiNoticeId);
  const voiceRequested = enabled(env.CONSUMER_VOICE_ENABLED);
  const voiceNoticeId = policyId(env.CONSUMER_VOICE_NOTICE_ID);
  const voiceDataPolicyId = policyId(env.CONSUMER_VOICE_DATA_POLICY_ID);
  const voiceTranscriptionModel = modelId(env.CONSUMER_VOICE_TRANSCRIPTION_MODEL, '');
  const voiceSpeechModel = modelId(env.CONSUMER_VOICE_SPEECH_MODEL, '');
  const configuredVoiceName = voiceName(env.CONSUMER_VOICE_NAME, '');
  const voicePricingVersion = policyId(env.CONSUMER_VOICE_PRICING_VERSION);
  const voiceSessionBudgetCents = optionalBoundedInteger(
    env.CONSUMER_VOICE_SESSION_BUDGET_EUR_CENTS,
    1,
    2_000
  ) || 0;
  const voiceDailyBudgetCents = optionalBoundedInteger(
    env.CONSUMER_VOICE_DAILY_BUDGET_EUR_CENTS,
    1,
    100_000
  ) || 0;
  const voiceTranscriptionReservationCents = optionalBoundedInteger(
    env.CONSUMER_VOICE_TRANSCRIPTION_RESERVATION_EUR_CENTS,
    1,
    200
  ) || 0;
  const voiceSpeechReservationCents = optionalBoundedInteger(
    env.CONSUMER_VOICE_SPEECH_RESERVATION_EUR_CENTS,
    1,
    200
  ) || 0;
  const voiceConfigured = Boolean(
    text(env.OPENAI_API_KEY)
    && voiceNoticeId
    && voiceDataPolicyId
    && voiceTranscriptionModel
    && voiceSpeechModel
    && configuredVoiceName
    && voicePricingVersion
    && voiceSessionBudgetCents > 0
    && voiceDailyBudgetCents >= voiceSessionBudgetCents
    && voiceTranscriptionReservationCents > 0
    && voiceSpeechReservationCents > 0
    && voiceTranscriptionReservationCents <= voiceSessionBudgetCents
    && voiceSpeechReservationCents <= voiceSessionBudgetCents
  );
  const voiceEnabled = journeyEnabled && voiceRequested && voiceConfigured;
  const handoffRequested = enabled(env.CONSUMER_HANDOFF_ENABLED);
  const handoffRetentionDays = optionalBoundedInteger(env.CONSUMER_HANDOFF_RETENTION_DAYS, 1, 365);
  const handoffRetentionPolicyId = policyId(env.CONSUMER_HANDOFF_RETENTION_POLICY_ID);
  const handoffPolicyVersion = policyId(env.CONSUMER_HANDOFF_POLICY_VERSION);
  const handoffPolicyUrl = bookingUrl(env.CONSUMER_HANDOFF_POLICY_URL);
  const handoffConfigured = Boolean(
    handoffRetentionDays
    && handoffPolicyVersion
    && handoffRetentionPolicyId
    && handoffPolicyUrl
  );
  const allowedModules = text(env.CONSUMER_ALLOWED_MODULE_IDS)
    .split(',')
    .map((item) => item.trim())
    .filter((item, index, values) => /^[a-z0-9_]{2,80}$/.test(item) && values.indexOf(item) === index);

  return Object.freeze({
    requestedJourneyEnabled,
    journeyConfigured,
    journeyEnabled,
    aiRequested,
    aiConfigured,
    aiDataPolicyId,
    aiEnabled: journeyEnabled && aiRequested && aiConfigured,
    voiceRequested,
    voiceConfigured,
    voiceEnabled,
    voiceNoticeId,
    voiceDataPolicyId,
    moduleRoutingEnabled: journeyEnabled && enabled(env.CONSUMER_MODULE_ROUTING_ENABLED),
    handoffRequested,
    handoffConfigured,
    handoffEnabled: journeyEnabled && handoffRequested && handoffConfigured,
    handoffRetentionDays,
    handoffRetentionPolicyId,
    handoffPolicyVersion,
    handoffPolicyUrl,
    publicAccessEnabled: journeyEnabled && enabled(env.CONSUMER_PUBLIC_ACCESS_ENABLED),
    inviteAccessConfigured: validInviteSigningKey(env.CONSUMER_INVITE_SIGNING_KEY),
    inviteMaxTtlHours: boundedInteger(env.CONSUMER_INVITE_MAX_TTL_HOURS, 168, 1, 720),
    allowedModules,
    bookingUrl: bookingUrl(env.CONSUMER_BOOKING_URL),
    cohort: text(env.CONSUMER_COHORT) || 'internal',
    consentPolicyVersion,
    consentManifestId,
    analysisNoticeId,
    aiNoticeId,
    privacyNoticeUrl,
    profileSchemaVersion: 1,
    sessionTtlDays,
    maxMessageLength: boundedInteger(env.CONSUMER_MAX_MESSAGE_LENGTH, 4_000, 200, 12_000),
    maxTurnsPerSession: boundedInteger(env.CONSUMER_MAX_TURNS_PER_SESSION, 80, 5, 200),
    defaultModel: modelId(env.CONSUMER_AI_DEFAULT_MODEL, 'gpt-5.6-luna'),
    complexModel: modelId(env.CONSUMER_AI_COMPLEX_MODEL, 'gpt-5.6-terra'),
    defaultReasoningEffort: reasoningEffort(env.CONSUMER_AI_DEFAULT_REASONING_EFFORT, 'low'),
    complexReasoningEffort: reasoningEffort(env.CONSUMER_AI_COMPLEX_REASONING_EFFORT, 'medium'),
    aiPromptVersion: text(env.CONSUMER_AI_PROMPT_VERSION) || 'consumer-intake-v1',
    aiSchemaVersion: 'consumer-profile-patch-v1',
    aiTimeoutMs: boundedInteger(env.CONSUMER_AI_TIMEOUT_MS, 15_000, 3_000, 25_000),
    aiMaxOutputTokens: boundedInteger(env.CONSUMER_AI_MAX_OUTPUT_TOKENS, 1_200, 200, 3_000),
    aiRequestTokenReservation: boundedInteger(env.CONSUMER_AI_REQUEST_TOKEN_RESERVATION, 8_000, 2_000, 20_000),
    aiSessionRequestBudget: boundedInteger(env.CONSUMER_AI_SESSION_REQUEST_BUDGET, 24, 1, 100),
    aiDailyRequestBudget: boundedInteger(env.CONSUMER_AI_DAILY_REQUEST_BUDGET, 1_000, 10, 100_000),
    aiComplexSessionRequestBudget: boundedInteger(env.CONSUMER_AI_COMPLEX_SESSION_REQUEST_BUDGET, 4, 1, 20),
    aiComplexDailyRequestBudget: boundedInteger(env.CONSUMER_AI_COMPLEX_DAILY_REQUEST_BUDGET, 100, 1, 10_000),
    aiSessionTokenBudget: boundedInteger(env.CONSUMER_AI_SESSION_TOKEN_BUDGET, 25_000, 2_000, 200_000),
    aiDailyTokenBudget: boundedInteger(env.CONSUMER_AI_DAILY_TOKEN_BUDGET, 250_000, 10_000, 5_000_000),
    voiceTranscriptionModel,
    voiceSpeechModel,
    voiceName: configuredVoiceName,
    voiceTimeoutMs: boundedInteger(env.CONSUMER_VOICE_TIMEOUT_MS, 25_000, 5_000, 60_000),
    voiceMaxAudioBytes: boundedInteger(env.CONSUMER_VOICE_MAX_AUDIO_BYTES, 1_000_000, 250_000, 2_000_000),
    voiceMaxDurationSeconds: boundedInteger(env.CONSUMER_VOICE_MAX_DURATION_SECONDS, 45, 5, 60),
    voiceMaxSpeechCharacters: boundedInteger(env.CONSUMER_VOICE_MAX_SPEECH_CHARACTERS, 1_200, 100, 2_000),
    voiceSessionBudgetMicroEur: voiceSessionBudgetCents * 10_000,
    voiceDailyBudgetMicroEur: voiceDailyBudgetCents * 10_000,
    voiceTranscriptionReservationMicroEur: voiceTranscriptionReservationCents * 10_000,
    voiceSpeechReservationMicroEur: voiceSpeechReservationCents * 10_000,
    voicePricingVersion,
    providerCostLimitEurMicros: voiceEnabled ? voiceSessionBudgetCents * 10_000 : 0
  });
}

export function publicConsumerConfig(config) {
  return {
    flags: {
      consumerJourneyEnabled: config.journeyEnabled,
      consumerAiIntakeEnabled: config.aiEnabled,
      consumerVoiceEnabled: config.voiceEnabled,
      consumerModuleRoutingEnabled: config.moduleRoutingEnabled,
      consumerHumanHandoffEnabled: config.handoffEnabled
    },
    access: {
      publicAccessEnabled: config.publicAccessEnabled,
      inviteRequired: !config.publicAccessEnabled
    },
    allowedModules: config.allowedModules,
    cohort: config.cohort,
    consentPolicyVersion: config.consentPolicyVersion,
    consentManifestId: config.consentManifestId,
    analysisNoticeId: config.analysisNoticeId,
    privacyNoticeUrl: config.privacyNoticeUrl,
    profileSchemaVersion: config.profileSchemaVersion,
    limits: {
      maxMessageLength: config.maxMessageLength,
      maxTurnsPerSession: config.maxTurnsPerSession,
      sessionTtlDays: config.sessionTtlDays
    },
    ai: {
      configured: config.aiEnabled,
      noticeId: config.aiNoticeId || null,
      dataPolicyId: config.aiEnabled ? config.aiDataPolicyId : null,
      defaultModel: config.defaultModel,
      complexModel: config.complexModel,
      defaultReasoningEffort: config.defaultReasoningEffort,
      complexReasoningEffort: config.complexReasoningEffort,
      promptVersion: config.aiPromptVersion,
      schemaVersion: config.aiSchemaVersion
    },
    voice: {
      enabled: config.voiceEnabled,
      noticeId: config.voiceEnabled ? config.voiceNoticeId : null,
      dataPolicyId: config.voiceEnabled ? config.voiceDataPolicyId : null,
      policyVersion: config.voiceEnabled ? config.consentPolicyVersion : null,
      privacyNoticeUrl: config.voiceEnabled ? config.privacyNoticeUrl : null,
      transcriptionModel: config.voiceEnabled ? config.voiceTranscriptionModel : null,
      speechModel: config.voiceEnabled ? config.voiceSpeechModel : null,
      voice: config.voiceEnabled ? config.voiceName : null,
      pricingVersion: config.voiceEnabled ? config.voicePricingVersion : null,
      maxDurationSeconds: config.voiceMaxDurationSeconds,
      maxRecordingSeconds: config.voiceMaxDurationSeconds,
      sessionBudgetMicroEur: config.voiceEnabled ? config.voiceSessionBudgetMicroEur : 0,
      budget: {
        limitMicroEur: config.voiceEnabled ? config.voiceSessionBudgetMicroEur : 0,
        spentMicroEur: 0,
        remainingMicroEur: config.voiceEnabled ? config.voiceSessionBudgetMicroEur : 0
      },
      aiGeneratedDisclosure: config.voiceEnabled
        ? 'The voice you hear is AI-generated. Review each transcript before sending it.'
        : null
    },
    handoff: {
      enabled: config.handoffEnabled,
      policyVersion: config.handoffEnabled ? config.handoffPolicyVersion : null,
      policyUrl: config.handoffEnabled ? config.handoffPolicyUrl : null,
      retentionPolicyId: config.handoffEnabled ? config.handoffRetentionPolicyId : null,
      packageRetentionDays: config.handoffEnabled ? config.handoffRetentionDays : null
    }
  };
}
