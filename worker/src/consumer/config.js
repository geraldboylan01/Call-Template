import { validInviteSigningKey } from './invite.js';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const SAFE_MODEL_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const SAFE_VOICE_NAMES = new Set([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'marin', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'cedar'
]);
const REALTIME_MODEL = 'gpt-realtime-2.1';
const REALTIME_VOICE = 'marin';
const REALTIME_REASONING_EFFORT = 'low';
const REALTIME_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
// Environment-configurable per-session allowance for the protected adviser
// canary, hard-capped in code at €10 so no deployment mistake can raise a
// single session above that.
const REALTIME_SESSION_BUDGET_MAX_CENTS = 1_000;
// UTC-day circuit breaker cap: the environment may configure up to €100/day;
// the protected adviser canary keeps €50.
const REALTIME_DAILY_BUDGET_MAX_CENTS = 10_000;
const REALTIME_SAFETY_RESERVE_MICRO_EUR = 300_000;
const REALTIME_SPEECH_EUR_MICROS_PER_MILLION_CHARACTERS = 30_000_000;

// The planner models this deployment is allowed to use. A server-side
// allowlist: the planner model is never client-selectable, and a typo or an
// unreviewed model cannot reach the provider.
//
// Verified against the OpenAI model catalogue: each supports /v1/responses and
// structured outputs, which extractRealtimePlannerTurn requires.
const APPROVED_PLANNER_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna'
]);
// Luna is the cost-appropriate tier for a per-turn extraction call.
const DEFAULT_PLANNER_MODEL = 'gpt-5.6-luna';

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

/**
 * Resolve the planner model against the approved allowlist.
 *
 * An unrecognised value falls back to the approved default rather than being
 * passed through: an unreviewed model must never reach the provider, and a
 * deployment typo must not take the planner down.
 */
function plannerModel(value) {
  const candidate = text(value);
  return APPROVED_PLANNER_MODELS.has(candidate) ? candidate : DEFAULT_PLANNER_MODEL;
}

/** Whether the configured value was explicitly approved, for diagnostics. */
function plannerModelConfigured(value) {
  const candidate = text(value);
  return candidate === '' || APPROVED_PLANNER_MODELS.has(candidate);
}

export const PLANNER_MODEL_ALLOWLIST = Object.freeze([...APPROVED_PLANNER_MODELS]);

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
  const realtimeRequested = enabled(env.CONSUMER_REALTIME_VOICE_ENABLED);
  const realtimeNoticeId = policyId(env.CONSUMER_REALTIME_NOTICE_ID);
  const realtimeDataPolicyId = policyId(env.CONSUMER_REALTIME_DATA_POLICY_ID);
  const realtimeModel = modelId(env.CONSUMER_REALTIME_MODEL, '');
  const realtimeVoice = voiceName(env.CONSUMER_REALTIME_VOICE, '');
  const realtimeReasoningEffort = reasoningEffort(env.CONSUMER_REALTIME_REASONING_EFFORT, '');
  const realtimeTranscriptionModel = modelId(env.CONSUMER_REALTIME_TRANSCRIPTION_MODEL, '');
  const realtimePromptVersion = policyId(env.CONSUMER_REALTIME_PROMPT_VERSION);
  const realtimeToolsetVersion = policyId(env.CONSUMER_REALTIME_TOOLSET_VERSION);
  const realtimePricingVersion = policyId(env.CONSUMER_REALTIME_PRICING_VERSION);
  const realtimeSessionBudgetCents = optionalBoundedInteger(
    env.CONSUMER_REALTIME_SESSION_BUDGET_EUR_CENTS,
    1,
    REALTIME_SESSION_BUDGET_MAX_CENTS
  ) || 0;
  const realtimeDailyBudgetCents = optionalBoundedInteger(
    env.CONSUMER_REALTIME_DAILY_BUDGET_EUR_CENTS,
    1,
    REALTIME_DAILY_BUDGET_MAX_CENTS
  ) || 0;
  const realtimeSessionWarnCents = optionalBoundedInteger(
    env.CONSUMER_REALTIME_SESSION_WARN_EUR_CENTS,
    1,
    REALTIME_SESSION_BUDGET_MAX_CENTS
  ) || 0;
  const realtimeUsageRates = Object.freeze({
    textInput: optionalBoundedInteger(env.CONSUMER_REALTIME_TEXT_INPUT_EUR_MICROS_PER_MILLION, 1, 1_000_000_000) || 0,
    textCachedInput: optionalBoundedInteger(env.CONSUMER_REALTIME_TEXT_CACHED_INPUT_EUR_MICROS_PER_MILLION, 1, 1_000_000_000) || 0,
    textOutput: optionalBoundedInteger(env.CONSUMER_REALTIME_TEXT_OUTPUT_EUR_MICROS_PER_MILLION, 1, 1_000_000_000) || 0,
    audioInput: optionalBoundedInteger(env.CONSUMER_REALTIME_AUDIO_INPUT_EUR_MICROS_PER_MILLION, 1, 1_000_000_000) || 0,
    audioCachedInput: optionalBoundedInteger(env.CONSUMER_REALTIME_AUDIO_CACHED_INPUT_EUR_MICROS_PER_MILLION, 1, 1_000_000_000) || 0,
    audioOutput: optionalBoundedInteger(env.CONSUMER_REALTIME_AUDIO_OUTPUT_EUR_MICROS_PER_MILLION, 1, 1_000_000_000) || 0,
    transcriptionInput: optionalBoundedInteger(env.CONSUMER_REALTIME_TRANSCRIPTION_INPUT_EUR_MICROS_PER_MILLION, 1, 1_000_000_000) || 0,
    transcriptionOutput: optionalBoundedInteger(env.CONSUMER_REALTIME_TRANSCRIPTION_OUTPUT_EUR_MICROS_PER_MILLION, 1, 1_000_000_000) || 0
  });
  const realtimeSpeechRateMicroEurPerMillionCharacters = optionalBoundedInteger(
    env.CONSUMER_REALTIME_SPEECH_EUR_MICROS_PER_MILLION_CHARACTERS,
    1,
    1_000_000_000
  ) || 0;
  const realtimeConfigured = Boolean(
    text(env.OPENAI_API_KEY)
    && env.CONSUMER_REALTIME_SESSIONS
    && realtimeNoticeId
    && realtimeDataPolicyId
    && realtimeModel === REALTIME_MODEL
    && realtimeVoice === REALTIME_VOICE
    && realtimeReasoningEffort === REALTIME_REASONING_EFFORT
    && realtimeTranscriptionModel === REALTIME_TRANSCRIPTION_MODEL
    && realtimePromptVersion
    && realtimeToolsetVersion
    && realtimePricingVersion
    && realtimeSessionBudgetCents > 0
    && realtimeDailyBudgetCents >= realtimeSessionBudgetCents
    && (realtimeSessionWarnCents === 0 || realtimeSessionWarnCents < realtimeSessionBudgetCents)
    && voiceSpeechModel === 'tts-1-hd'
    && configuredVoiceName === 'nova'
    && realtimeSpeechRateMicroEurPerMillionCharacters === REALTIME_SPEECH_EUR_MICROS_PER_MILLION_CHARACTERS
    && Object.values(realtimeUsageRates).every((rate) => rate > 0)
  );
  const realtimeEnabled = journeyEnabled && realtimeRequested && realtimeConfigured;
  const realtimeConversationV2Enabled = realtimeEnabled
    && enabled(env.CONSUMER_REALTIME_CONVERSATION_V2_ENABLED);
  const realtimeSpokenCompletionEnabled = realtimeConversationV2Enabled
    && enabled(env.CONSUMER_REALTIME_SPOKEN_COMPLETION_ENABLED);
  // The live conversational lane. It shares the realtime lease, consent, cost
  // ledger and provider configuration — hence `realtimeEnabled` — but it is
  // deliberately INDEPENDENT of the v1/v2 conversation switch: the two lanes
  // are alternative conversation layers over the same infrastructure, and
  // exactly one runs a given meeting. It is never derived from
  // `realtimeConversationV2Enabled`, so turning one on can never imply the
  // other.
  const liveVoiceEnabled = realtimeEnabled && enabled(env.CONSUMER_LIVE_VOICE_ENABLED);
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
    realtimeRequested,
    realtimeConfigured,
    realtimeEnabled,
    realtimeConversationV2Enabled,
    realtimeSpokenCompletionEnabled,
    liveVoiceEnabled,
    // The compliance supervisor (§2.3 L4). Reuses the validated planner model
    // allowlist rather than introducing a second unvalidated model setting.
    liveSupervisorModel: plannerModel(env.CONSUMER_LIVE_SUPERVISOR_MODEL || env.CONSUMER_REALTIME_PLANNER_MODEL),
    realtimeNoticeId,
    realtimeDataPolicyId,
    // Offering an optional analysis, and the three-analysis capacity decision
    // that follows when a fourth becomes relevant. ONE shared rule: when this is
    // on, every transport offers; when off, none does. It is a rollout control,
    // never a per-transport difference — the planning state itself is always
    // identical. Enable in the consumer-test environment first, then canary
    // voice separately.
    moduleOffersEnabled: journeyEnabled
      && enabled(env.CONSUMER_MODULE_ROUTING_ENABLED)
      && enabled(env.CONSUMER_MODULE_OFFERS_ENABLED),
    // The protected agent-test transport: a text channel over the same shared
    // planning engine, for adviser/developer testing only. Never a public
    // consumer chat surface. Defaults off; enabled in the consumer-test
    // environment. Turning it off makes every agent route 404 immediately.
    agentTestEnabled: journeyEnabled && enabled(env.CONSUMER_AGENT_TEST_ENABLED),
    agentTestMaxTurns: boundedInteger(env.CONSUMER_AGENT_TEST_MAX_TURNS, 40, 1, 120),
    agentTestMaxSessions: boundedInteger(env.CONSUMER_AGENT_TEST_MAX_SESSIONS, 20, 1, 200),
    // Per-session ceiling on model spend, checked BEFORE each dispatch.
    agentTestSessionBudgetMicroEur: boundedInteger(
      env.CONSUMER_AGENT_TEST_SESSION_BUDGET_EUR_CENTS, 50, 1, 500
    ) * 10_000,
    moduleRoutingEnabled: journeyEnabled && enabled(env.CONSUMER_MODULE_ROUTING_ENABLED),
    goalRoutingEnabled: journeyEnabled
      && enabled(env.CONSUMER_MODULE_ROUTING_ENABLED)
      && enabled(env.CONSUMER_GOAL_ROUTING_ENABLED),
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
    aiPromptVersion: text(env.CONSUMER_AI_PROMPT_VERSION) || 'consumer-intake-goal-routing-v2',
    aiSchemaVersion: 'consumer-goal-profile-patch-v2',
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
    realtimeModel,
    realtimeVoice,
    realtimeReasoningEffort,
    realtimeTranscriptionModel,
    realtimePromptVersion,
    realtimeToolsetVersion,
    realtimePricingVersion,
    realtimeSessionBudgetMicroEur: realtimeSessionBudgetCents * 10_000,
    realtimeDailyBudgetMicroEur: realtimeDailyBudgetCents * 10_000,
    realtimeSafetyReserveMicroEur: REALTIME_SAFETY_RESERVE_MICRO_EUR,
    realtimeDispatchStopMicroEur: Math.max(
      0,
      realtimeSessionBudgetCents * 10_000 - REALTIME_SAFETY_RESERVE_MICRO_EUR
    ),
    // Optional early-warning threshold for the live allowance display; when
    // unset the UI warns at 75% of the session allowance.
    realtimeSessionWarnMicroEur: realtimeSessionWarnCents > 0
      ? realtimeSessionWarnCents * 10_000
      : Math.floor((realtimeSessionBudgetCents * 10_000 * 3) / 4),
    realtimeMaxDurationSeconds: boundedInteger(env.CONSUMER_REALTIME_MAX_DURATION_SECONDS, 600, 60, 900),
    realtimeIdleTimeoutSeconds: boundedInteger(env.CONSUMER_REALTIME_IDLE_TIMEOUT_SECONDS, 90, 30, 300),
    realtimeSilencePromptSeconds: boundedInteger(env.CONSUMER_REALTIME_SILENCE_PROMPT_SECONDS, 45, 0, 120),
    realtimeMaxSdpBytes: boundedInteger(env.CONSUMER_REALTIME_MAX_SDP_BYTES, 32_768, 4_096, 32_768),
    realtimeMaxResponses: boundedInteger(env.CONSUMER_REALTIME_MAX_RESPONSES, 40, 1, 40),
    realtimeMaxToolCalls: boundedInteger(env.CONSUMER_REALTIME_MAX_TOOL_CALLS, 24, 1, 24),
    // The structured planner regularly takes longer than 2.5 seconds in paid
    // probes. A timeout must be exceptional: timing out an ordinary turn used
    // to leave the previous MeetingBrief active and made the voice repeat the
    // question the client had just answered.
    realtimePlannerTimeoutMs: boundedInteger(env.CONSUMER_REALTIME_PLANNER_TIMEOUT_MS, 8_000, 2_500, 12_000),
    realtimePlannerCatchupTimeoutMs: boundedInteger(env.CONSUMER_REALTIME_PLANNER_CATCHUP_TIMEOUT_MS, 12_000, 5_000, 20_000),
    // The planner previously inherited config.defaultModel — the AI *intake*
    // model. Two unrelated features shared one setting, so retuning intake
    // would silently retune the planner. It is now explicit, validated against
    // a server-side allowlist, and never client-selectable.
    realtimePlannerModel: plannerModel(env.CONSUMER_REALTIME_PLANNER_MODEL),
    realtimePlannerModelConfigured: plannerModelConfigured(env.CONSUMER_REALTIME_PLANNER_MODEL),
    realtimePlannerPromptVersion: text(env.CONSUMER_REALTIME_PLANNER_PROMPT_VERSION) || 'realtime-planner-v3',
    realtimeUsageRates,
    // The conversation director is a bounded, fail-open-to-template text-model
    // pass that phrases Worker-owned speech naturally. It never changes what
    // may be saved or which analyses run.
    realtimeDirectorEnabled: journeyEnabled
      && realtimeRequested
      && realtimeConfigured
      && !realtimeConversationV2Enabled
      && enabled(env.CONSUMER_REALTIME_DIRECTOR_ENABLED),
    realtimeSpeechModel: 'gpt-4o-mini-tts',
    realtimeSpeechVoice: 'marin',
    realtimeSpeechRateMicroEurPerMillionCharacters,
    realtimeSpeechPricingVersion: `${realtimePricingVersion}:gpt-4o-mini-tts-marin-char-v1`,
    providerCostLimitEurMicros: Math.max(
      voiceEnabled ? voiceSessionBudgetCents * 10_000 : 0,
      realtimeEnabled ? realtimeSessionBudgetCents * 10_000 : 0
    )
  });
}

export function publicConsumerConfig(config) {
  return {
    flags: {
      consumerJourneyEnabled: config.journeyEnabled,
      consumerAiIntakeEnabled: config.aiEnabled,
      consumerVoiceEnabled: config.voiceEnabled,
      consumerRealtimeVoiceEnabled: config.realtimeEnabled,
      consumerRealtimeConversationV2Enabled: config.realtimeConversationV2Enabled,
      consumerModuleRoutingEnabled: config.moduleRoutingEnabled,
      consumerGoalRoutingEnabled: config.goalRoutingEnabled,
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
    realtimeVoice: {
      enabled: config.realtimeEnabled,
      conversationVersion: config.realtimeConversationV2Enabled ? 'v2' : 'v1',
      spokenCompletionEnabled: config.realtimeSpokenCompletionEnabled,
      noticeId: config.realtimeEnabled ? config.realtimeNoticeId : null,
      dataPolicyId: config.realtimeEnabled ? config.realtimeDataPolicyId : null,
      policyVersion: config.realtimeEnabled ? config.consentPolicyVersion : null,
      privacyNoticeUrl: config.realtimeEnabled ? config.privacyNoticeUrl : null,
      model: config.realtimeEnabled ? config.realtimeModel : null,
      voice: config.realtimeEnabled ? config.realtimeVoice : null,
      reasoningEffort: config.realtimeEnabled ? config.realtimeReasoningEffort : null,
      transcriptionModel: config.realtimeEnabled ? config.realtimeTranscriptionModel : null,
      promptVersion: config.realtimeEnabled ? config.realtimePromptVersion : null,
      toolsetVersion: config.realtimeEnabled ? config.realtimeToolsetVersion : null,
      pricingVersion: config.realtimeEnabled ? config.realtimePricingVersion : null,
      speechModel: config.realtimeEnabled ? config.realtimeSpeechModel : null,
      speechVoice: config.realtimeEnabled ? config.realtimeSpeechVoice : null,
      speechPricingVersion: config.realtimeEnabled ? config.realtimeSpeechPricingVersion : null,
      maxDurationSeconds: config.realtimeMaxDurationSeconds,
      idleTimeoutSeconds: config.realtimeIdleTimeoutSeconds,
      sessionBudgetMicroEur: config.realtimeEnabled ? config.realtimeSessionBudgetMicroEur : 0,
      warnThresholdMicroEur: config.realtimeEnabled ? config.realtimeSessionWarnMicroEur : 0,
      dispatchStopMicroEur: config.realtimeEnabled ? config.realtimeDispatchStopMicroEur : 0,
      safetyReserveMicroEur: config.realtimeEnabled ? config.realtimeSafetyReserveMicroEur : 0,
      aiGeneratedDisclosure: config.realtimeEnabled
        ? (config.realtimeConversationV2Enabled
            ? (config.realtimeSpokenCompletionEnabled
                ? 'Realtime AI speaks with you directly while a silent planner extracts reviewable draft facts. After Planéir reads the exact prepared plan, a clear spoken confirmation authorizes only that revision. Deterministic code controls the analyses, saved profile and calculations.'
                : 'Realtime AI speaks with you directly while a silent planner extracts reviewable draft facts. Deterministic code controls the three analyses, saved profile and calculations.')
            : 'Realtime AI interprets your completed speech and calls protected planning tools. Separate code-owned AI speech reads only Worker-approved copy; the planning service controls all saved facts and calculations.')
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
