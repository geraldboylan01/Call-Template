import { getAvailableConsumerModules, runStoredConsumerAnalysis } from './analysis.js';
import {
  APPROVED_CONSUMER_MODULE_KEY,
  deploymentCostEnvelope,
  getConsumerConfig,
  publicConsumerConfig
} from './config.js';
import {
  constantTimeEqual,
  createConsumerCredential,
  randomId,
  sha256Base64Url
} from './crypto.js';
import { describeConversationState, processTurn } from './conversation.js';
import { toPublicGoalAssessment } from '../../../js/planning/goal_plan.js';
import { ConsumerError, notFound, unavailable } from './errors.js';
import { requestAdviserHandoff, toPublicHandoff } from './handoff.js';
import { publishConsumerAnalysis } from './publish.js';
import { confirmAndRunRealtimeAnalysisPlan } from './realtime_analysis.js';
import { confirmPlanSelection } from './planning_turn.js';
import { createConsumerInvite, verifyConsumerInvite } from './invite.js';
import {
  checkConsumerRateLimit,
  cleanupExpiredConsumerSessions,
  createSessionRecord,
  deleteSessionData,
  getCurrentProfile,
  getHandoff,
  getLatestAnalysis,
  getConsumerProviderBudget,
  getSessionRow,
  listTurns,
  recordEvent,
  releaseConsumerProviderCostNotSent,
  reserveConsumerProviderCost,
  rotateConsumerEncryptionBatch,
  revokeHandoff,
  saveProfileRevision,
  settleConsumerProviderCostUnknown,
  toConsumerSession,
  withdrawAiConsent
} from './repository.js';
import {
  activateRealtimeLease,
  closeRealtimeLease,
  completeRealtimeAnalysisPlan,
  confirmRealtimeAnalysisPlan,
  createRealtimeLease,
  assertRealtimeControlMessage,
  claimRealtimeControlMessage,
  finalizeRealtimeControlMessage,
  getActiveRealtimeLease,
  getRealtimeControlPlaneProof,
  getNextRealtimeControlMessage,
  getCurrentRealtimeAnalysisPlan,
  getLatestRealtimeMeetingBrief,
  getPublicRealtimeAnalysisPlan,
  getLatestRealtimeLease,
  getRealtimeConsent,
  getRealtimeLeaseByActivationHash,
  listRealtimeFactProposalSummaries,
  listRealtimeFinalTurns,
  getRealtimeLease,
  getRealtimeMeetingTranscript,
  listRealtimeMeetings,
  markRealtimeAnalysisPlanRunning,
  markRealtimeProviderCostInFlight,
  prepareRealtimeAnalysisPlan,
  realtimeConsentIsCurrent,
  setRealtimeConsent,
  setRealtimeMeetingPhase,
  toPublicRealtimeAnalysisPlan,
  toPublicRealtimeConsent,
  toPublicRealtimeLease,
  verifyRealtimeControlCapability
} from './realtime_repository.js';
import {
  buildConfirmedRealtimeFactSummary,
  buildRealtimeFactReadBack
} from './realtime_fact_mapper.js';
import { terminateActiveRealtimeSession, terminateRealtimeLease } from './realtime_lifecycle.js';
import {
  createOpenAiRealtimeCall,
  hangupOpenAiRealtimeCall,
  readRealtimeSdpOffer
} from './realtime_provider.js';
import { renderAuthorizedRealtimeSpeech } from './realtime_speech.js';
import { toConversationGuide } from './realtime_planner.js';
import { conversationLaneStub } from './live/lane.js';
import { buildLiveSessionConfig } from './live/live_provider.js';
import { requireConsumerSession } from './session_auth.js';
import {
  getVoiceConsent,
  setVoiceConsent,
  toPublicVoiceConsent,
  voiceConsentIsCurrent
} from './voice_repository.js';
import { speakConsumerQuestion, transcribeConsumerVoice } from './voice_provider.js';
import {
  applyProfilePatch,
  validateAnalysisBody,
  validateConfirmBody,
  validateConsentBody,
  validateCreateSessionBody,
  validateHandoffBody,
  validateProfilePatchBody,
  validateRealtimeAnalysisPlanBody,
  validateRealtimeConsentBody,
  validateTurnBody,
  validateVoiceConsentBody,
  validateVoiceSpeechBody
} from './validators.js';

const MAX_REQUEST_BODY_BYTES = 100_000;
const DEFAULT_CONSUMER_PLAN_BASE_URL = 'https://planeir.ie/plan/';
const REALTIME_ACTIVATION_ID_PATTERN = /^rt_activation_[A-Za-z0-9_-]{20,80}$/;
const REALTIME_CONTROL_CAPABILITY_PATTERN = /^rt_control_[A-Za-z0-9_-]{20,80}$/;

function consumerPlanBaseUrl(env) {
  const configured = typeof env?.CONSUMER_PLAN_BASE_URL === 'string'
    ? env.CONSUMER_PLAN_BASE_URL.trim()
    : '';
  let parsed;
  try {
    parsed = new URL(configured || DEFAULT_CONSUMER_PLAN_BASE_URL);
  } catch (_error) {
    throw unavailable('The adviser planning preview is not available right now.', 'consumer_adviser_preview_unavailable');
  }
  const localHttp = parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  const planeirHttps = parsed.origin === 'https://planeir.ie'
    || parsed.origin === 'https://www.planeir.ie';
  if ((!planeirHttps && !localHttp)
    || !/^\/plan\/?$/.test(parsed.pathname)
    || parsed.username
    || parsed.password) {
    throw unavailable('The adviser planning preview is not available right now.', 'consumer_adviser_preview_unavailable');
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

export function isAdvisorRulesOnlyPreviewConfig(config) {
  const allowedModules = [...(config?.allowedModules || [])].sort().join(',');
  return config?.journeyEnabled === true
    && config?.moduleRoutingEnabled === true
    && config?.aiRequested !== true
    && config?.aiEnabled !== true
    && config?.voiceRequested !== true
    && config?.voiceEnabled !== true
    && config?.handoffRequested !== true
    && config?.handoffEnabled !== true
    && config?.publicAccessEnabled !== true
    && config?.inviteAccessConfigured === true
    && config?.cohort === 'adviser_test'
    && allowedModules === APPROVED_CONSUMER_MODULE_KEY;
}

function hasApprovedAdvisorVoiceTransport(config) {
  const allowedModules = [...(config?.allowedModules || [])].sort().join(',');
  return config?.journeyEnabled === true
    && config?.moduleRoutingEnabled === true
    && config?.aiRequested !== true
    && config?.aiEnabled !== true
    && config?.voiceRequested === true
    && config?.voiceConfigured === true
    && config?.voiceEnabled === true
    && config?.publicAccessEnabled !== true
    && config?.inviteAccessConfigured === true
    && config?.cohort === 'adviser_test'
    && ['voice-adviser-test-v1', 'voice-openai-audio-adviser-test-v2'].includes(config?.voiceNoticeId)
    && config?.voiceDataPolicyId === 'openai-audio-adviser-test-v1'
    && config?.voiceTranscriptionModel === 'gpt-4o-mini-transcribe'
    && config?.voiceSpeechModel === 'tts-1-hd'
    && config?.voiceName === 'nova'
    && config?.voicePricingVersion === 'openai-audio-eur-safety-2026-07-13-v2'
    && config?.voiceSessionBudgetMicroEur === 2_000_000
    && config?.voiceDailyBudgetMicroEur === 20_000_000
    && config?.voiceTranscriptionReservationMicroEur === 100_000
    && config?.voiceSpeechReservationMicroEur === 100_000
    && config?.voiceMaxAudioBytes === 1_000_000
    && config?.voiceMaxDurationSeconds === 45
    && config?.voiceMaxSpeechCharacters === 1_200
    && allowedModules === APPROVED_CONSUMER_MODULE_KEY;
}

export function isAdvisorVoicePreviewConfig(config) {
  return hasApprovedAdvisorVoiceTransport(config)
    && config?.realtimeRequested !== true
    && config?.realtimeEnabled !== true
    && config?.handoffRequested !== true
    && config?.handoffEnabled !== true;
}

export function isAdvisorRealtimePreviewConfig(config) {
  return hasApprovedAdvisorVoiceTransport(config)
    && config?.realtimeRequested === true
    && config?.realtimeConfigured === true
    && config?.realtimeEnabled === true
    && config?.handoffRequested !== true
    && config?.handoffEnabled !== true
    && ['realtime-voice-adviser-test-v2', 'realtime-voice-openai-audio-adviser-test-v3'].includes(config?.realtimeNoticeId)
    && config?.realtimeDataPolicyId === 'openai-realtime-audio-adviser-test-v2'
    && config?.realtimeModel === 'gpt-realtime-2.1'
    && config?.realtimeVoice === 'marin'
    && config?.realtimeReasoningEffort === 'low'
    && config?.realtimeTranscriptionModel === 'gpt-4o-mini-transcribe'
    && config?.realtimePromptVersion === 'consumer-realtime-orchestrator-v9'
    && config?.realtimeToolsetVersion === 'consumer-realtime-tools-v7'
    && config?.realtimePricingVersion === 'openai-gpt-realtime-2.1-usd-parity-eur-safety-2026-07-14-v1'
    && config?.realtimeSpeechModel === 'gpt-4o-mini-tts'
    && config?.realtimeSpeechVoice === 'marin'
    && config?.realtimeSpeechRateMicroEurPerMillionCharacters === 30_000_000
    // Approved adviser-demo envelope: €10 session allowance (warn €7.50,
    // dispatch stop €9.70) inside the €50 UTC-day ceiling, 15-minute meetings,
    // 3-minute silence timeout with a spoken warning 45 seconds beforehand.
    && config?.realtimeSessionBudgetMicroEur === 10_000_000
    && config?.realtimeSessionWarnMicroEur === 7_500_000
    && config?.realtimeDailyBudgetMicroEur === 50_000_000
    && config?.realtimeDispatchStopMicroEur === 9_700_000
    && config?.realtimeSafetyReserveMicroEur === 300_000
    && config?.realtimeMaxDurationSeconds === 900
    && config?.realtimeIdleTimeoutSeconds === 180
    && config?.realtimeSilencePromptSeconds === 45
    && config?.realtimeMaxSdpBytes === 32_768
    && config?.realtimeMaxResponses === 100
    && config?.realtimeMaxToolCalls === 60;
}

export function isAdvisorProtectedPreviewConfig(config) {
  return isAdvisorRulesOnlyPreviewConfig(config)
    || isAdvisorVoicePreviewConfig(config)
    || isAdvisorRealtimePreviewConfig(config);
}

export async function createAdvisorConsumerInvite(env, options = {}) {
  const config = getConsumerConfig(env);
  if (!isAdvisorProtectedPreviewConfig(config)) {
    throw unavailable('The adviser planning preview is not available right now.', 'consumer_adviser_preview_unavailable');
  }

  const invite = await createConsumerInvite(env, config, {
    now: options.now,
    ttlHours: Math.min(4, config.inviteMaxTtlHours),
    maxUses: 1
  });
  const url = consumerPlanBaseUrl(env);
  url.hash = new URLSearchParams({ invite: invite.token }).toString();
  return Object.freeze({
    ok: true,
    url: url.toString(),
    expiresAt: invite.expiresAt,
    maxUses: 1,
    mode: config.realtimeEnabled
      ? 'realtime_voice_rules_only'
      : config.voiceEnabled
        ? 'voice_assisted_rules_only'
        : 'rules_only'
  });
}

async function readJson(request, { optional = false } = {}) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_REQUEST_BODY_BYTES) {
    throw new ConsumerError(413, 'request_too_large', 'Request body is too large.');
  }
  const text = await request.text();
  if (!text && optional) return {};
  if (!text || new TextEncoder().encode(text).length > MAX_REQUEST_BODY_BYTES) {
    throw new ConsumerError(text ? 413 : 400, text ? 'request_too_large' : 'invalid_json', text ? 'Request body is too large.' : 'A JSON body is required.');
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new ConsumerError(400, 'invalid_json', 'Invalid JSON body.');
  }
}

/** The header the deploy workflow presents. Never a cookie: no ambient authority. */
export const DEPLOY_VERIFICATION_HEADER = 'x-planeir-deploy-verification';

/**
 * Compare in time independent of how much of the value matched.
 *
 * A plain `===` on a secret leaks its prefix through response timing, which is
 * enough to recover it byte by byte given enough requests. Length is compared
 * first and the loop always runs to completion.
 */
function credentialMatches(presented, expected) {
  const a = new TextEncoder().encode(String(presented || ''));
  const b = new TextEncoder().encode(String(expected || ''));
  if (a.length === 0 || a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

/**
 * Whether this request may read the deployment cost envelope.
 *
 * Fail-closed in both directions: an unconfigured secret authorises nobody, and
 * a missing or wrong header is indistinguishable from the route not existing, so
 * probing cannot even confirm the endpoint is there.
 */
export function isDeployVerificationRequest(request, env) {
  const expected = String(env?.CONSUMER_DEPLOY_VERIFICATION_KEY || '');
  // A short or absent key must never authorise: without this, an unset secret
  // would let an empty header through.
  if (expected.length < 32) return false;
  return credentialMatches(request?.headers?.get?.(DEPLOY_VERIFICATION_HEADER), expected);
}

function routeMatch(pathname) {
  if (pathname === '/api/consumer/bootstrap') return { kind: 'bootstrap', methods: ['GET'] };
  if (pathname === '/api/consumer/deployment-envelope') {
    return { kind: 'deployment_envelope', methods: ['GET'] };
  }
  if (pathname === '/api/consumer/sessions') return { kind: 'create', methods: ['POST'] };
  const realtimeTranscriptMatch = /^\/api\/consumer\/sessions\/(cs_[A-Za-z0-9_-]{20,80})\/voice\/realtime\/meetings\/(rt_[A-Za-z0-9_-]{20,80})\/transcript$/.exec(pathname);
  if (realtimeTranscriptMatch) {
    return {
      kind: 'realtime_meeting_transcript',
      sessionId: realtimeTranscriptMatch[1],
      meetingId: realtimeTranscriptMatch[2],
      methods: ['GET']
    };
  }
  const realtimeMeetingsMatch = /^\/api\/consumer\/sessions\/(cs_[A-Za-z0-9_-]{20,80})\/voice\/realtime\/meetings$/.exec(pathname);
  if (realtimeMeetingsMatch) {
    return { kind: 'realtime_meetings', sessionId: realtimeMeetingsMatch[1], methods: ['GET'] };
  }
  const realtimeActivationMatch = /^\/api\/consumer\/sessions\/(cs_[A-Za-z0-9_-]{20,80})\/voice\/realtime\/activations\/(rt_activation_[A-Za-z0-9_-]{20,80})$/.exec(pathname);
  if (realtimeActivationMatch) {
    return {
      kind: 'realtime_activation',
      sessionId: realtimeActivationMatch[1],
      activationId: realtimeActivationMatch[2],
      methods: ['DELETE']
    };
  }
  const realtimeSpeechMatch = /^\/api\/consumer\/sessions\/(cs_[A-Za-z0-9_-]{20,80})\/voice\/realtime\/calls\/(rt_[A-Za-z0-9_-]{20,80})\/speech$/.exec(pathname);
  if (realtimeSpeechMatch) {
    return {
      kind: 'realtime_speech',
      sessionId: realtimeSpeechMatch[1],
      leaseId: realtimeSpeechMatch[2],
      methods: ['POST']
    };
  }
  const realtimeLeaseMatch = /^\/api\/consumer\/sessions\/(cs_[A-Za-z0-9_-]{20,80})\/voice\/realtime\/calls\/(rt_[A-Za-z0-9_-]{20,80})$/.exec(pathname);
  if (realtimeLeaseMatch) {
    return {
      kind: 'realtime_lease',
      sessionId: realtimeLeaseMatch[1],
      leaseId: realtimeLeaseMatch[2],
      methods: ['GET', 'DELETE']
    };
  }
  const realtimeMatch = /^\/api\/consumer\/sessions\/(cs_[A-Za-z0-9_-]{20,80})\/voice\/realtime\/(consent|calls)$/.exec(pathname);
  if (realtimeMatch) {
    return {
      kind: `realtime_${realtimeMatch[2]}`,
      sessionId: realtimeMatch[1],
      methods: realtimeMatch[2] === 'consent' ? ['PATCH'] : ['POST']
    };
  }
  const analysisPlanMatch = /^\/api\/consumer\/sessions\/(cs_[A-Za-z0-9_-]{20,80})\/analysis-plan$/.exec(pathname);
  if (analysisPlanMatch) {
    return { kind: 'analysis_plan', sessionId: analysisPlanMatch[1], methods: ['PUT'] };
  }
  const voiceMatch = /^\/api\/consumer\/sessions\/(cs_[A-Za-z0-9_-]{20,80})\/voice\/(consent|transcriptions|speech)$/.exec(pathname);
  if (voiceMatch) {
    const [, sessionId, operation] = voiceMatch;
    const voiceMethods = { consent: ['PATCH'], transcriptions: ['POST'], speech: ['POST'] };
    return { kind: `voice_${operation}`, sessionId, methods: voiceMethods[operation] };
  }
  const match = /^\/api\/consumer\/sessions\/(cs_[A-Za-z0-9_-]{20,80})(?:\/(turns|profile|confirm|analyses|publish|handoffs|consent))?$/.exec(pathname);
  if (!match) return null;
  const [, sessionId, child] = match;
  if (!child) return { kind: 'session', sessionId, methods: ['GET', 'DELETE'] };
  const methods = { turns: ['POST'], profile: ['PATCH'], confirm: ['POST'], analyses: ['POST'], publish: ['POST'], handoffs: ['POST', 'DELETE'], consent: ['PATCH'] };
  return { kind: child, sessionId, methods: methods[child] };
}

function assertFeatureAvailability(config) {
  if (!config.requestedJourneyEnabled) throw notFound();
  if (!config.journeyConfigured) throw unavailable();
  if (!config.journeyEnabled) throw unavailable();
}

function assertProcessingAvailability(config) {
  if (!config.requestedJourneyEnabled || !config.journeyEnabled) {
    throw new ConsumerError(503, 'consumer_processing_paused', 'Planning updates are temporarily paused. Privacy controls and deletion remain available.');
  }
}

async function assertAudienceAccess(request, env, config) {
  if (config.cohort === 'adviser_test' && !isAdvisorProtectedPreviewConfig(config)) {
    throw new ConsumerError(503, 'consumer_audience_unavailable', 'This planning journey is not accepting new sessions right now.');
  }
  if (config.publicAccessEnabled) return null;
  const provided = request.headers.get('X-Consumer-Invite')?.trim() || '';
  if (!config.inviteAccessConfigured) {
    throw new ConsumerError(503, 'consumer_audience_unavailable', 'This planning journey is not accepting new sessions right now.');
  }
  return verifyConsumerInvite(provided, env, config);
}

function assertVoiceAvailability(config) {
  if (!config.voiceEnabled
    || !(isAdvisorVoicePreviewConfig(config) || isAdvisorRealtimePreviewConfig(config))) {
    throw new ConsumerError(503, 'consumer_voice_unavailable', 'Voice is not available right now. You can continue by typing.');
  }
}

function assertRealtimeAvailability(config) {
  if (!config.realtimeEnabled || !isAdvisorRealtimePreviewConfig(config)) {
    throw new ConsumerError(503, 'consumer_realtime_unavailable', 'Live voice is not available right now. You can continue by typing.');
  }
}

function realtimeRequestId(request) {
  const value = request.headers.get('X-Voice-Request-Id')?.trim() || '';
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(value)) {
    throw new ConsumerError(400, 'realtime_request_id_invalid', 'A valid live voice request id is required.');
  }
  return value;
}

function realtimeActivationCredentials(request, {
  allowServerFallback = false,
  activationId: suppliedActivationId = ''
} = {}) {
  let activationId = String(suppliedActivationId || '').trim()
    || request.headers.get('X-Realtime-Activation-Id')?.trim()
    || '';
  let controlCapability = request.headers.get('X-Realtime-Control-Capability')?.trim() || '';
  if (!activationId && !controlCapability && allowServerFallback) {
    activationId = randomId('rt_activation');
    controlCapability = randomId('rt_control');
  }
  if (!REALTIME_ACTIVATION_ID_PATTERN.test(activationId)) {
    throw new ConsumerError(400, 'realtime_activation_id_invalid', 'A valid live voice activation id is required.');
  }
  if (!REALTIME_CONTROL_CAPABILITY_PATTERN.test(controlCapability)) {
    throw new ConsumerError(400, 'realtime_control_capability_invalid', 'A valid live voice control capability is required.');
  }
  return { activationId, controlCapability };
}

async function requireRealtimeControlCapability(request, env, sessionId, leaseId, options) {
  const token = request.headers.get('X-Realtime-Control-Capability')?.trim() || '';
  const lease = await verifyRealtimeControlCapability(env, sessionId, leaseId, token, options);
  if (!lease) throw notFound('This live voice control channel could not be found.');
  return lease;
}

function realtimeStub(env, leaseId) {
  const stub = conversationLaneStub(env, leaseId);
  if (!stub) {
    throw new ConsumerError(503, 'realtime_control_unavailable', 'Live voice controls are not available.');
  }
  return stub;
}

async function durableObjectRequest(env, leaseId, path, body, method = 'POST') {
  const response = await realtimeStub(env, leaseId).fetch(`https://consumer-realtime.internal${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  let payload = null;
  try { payload = await response.json(); } catch (_error) { payload = null; }
  if (!response.ok || payload?.ok !== true) {
    throw new ConsumerError(503, payload?.code || 'realtime_control_unavailable', 'Live voice controls are not available.');
  }
  return payload;
}

async function closeRealtimeControl(env, lease, options = {}) {
  return terminateRealtimeLease(env, lease, options);
}

function voiceBudgetPayload(value, config) {
  const limitMicroEur = Number(value?.limitMicroEur ?? value?.limitEurMicros ?? config.voiceSessionBudgetMicroEur ?? 0) || 0;
  const spentMicroEur = Number(value?.spentMicroEur ?? value?.spentEurMicros ?? 0) || 0;
  const remainingMicroEur = Number(
    value?.remainingMicroEur ?? value?.remainingEurMicros ?? Math.max(0, limitMicroEur - spentMicroEur)
  ) || 0;
  return {
    available: remainingMicroEur > 0,
    status: remainingMicroEur > 0 ? 'available' : 'unavailable'
  };
}

// While a realtime lease is open, the ledger conservatively holds the entire
// remaining session envelope as "reserved", so the raw provider budget reads
// as fully spent for the whole call. That pessimistic number is correct for
// enforcement but must never be displayed as the live allowance: the browser
// treats remaining ≤ 0 as an exhausted session. Report the lease's own
// envelope and current estimated usage instead, matching the speech route.
export function realtimeVoiceBudgetPayload(providerBudget, lease, config) {
  if (lease && ['pending', 'active', 'closing'].includes(String(lease.status || ''))) {
    const limitMicroEur = Number(lease.reservation_eur_micros || 0)
      || config.realtimeSessionBudgetMicroEur;
    const spentMicroEur = Math.max(0, Number(lease.estimated_cost_eur_micros || 0) || 0);
    return { available: true, status: 'available' };
  }
  return voiceBudgetPayload(providerBudget, {
    voiceSessionBudgetMicroEur: config.realtimeSessionBudgetMicroEur
  });
}

function questionText(question) {
  if (typeof question === 'string') return question.trim();
  if (!question || typeof question !== 'object') return '';
  return String(question.prompt || question.question || question.text || question.message || '').trim();
}

function publicConversationState(state) {
  return {
    ...state,
    ...(state?.goalAssessment ? { goalAssessment: toPublicGoalAssessment(state.goalAssessment) } : {})
  };
}

function realtimePlanModuleIds(profile, config) {
  const planningState = describeConversationState(profile, config);
  return (planningState.moduleSlots || [])
    .filter((slot) => ['ready', 'needs_facts'].includes(slot.availability))
    .map((slot) => slot.moduleId)
    .filter((moduleId) => config.allowedModules.includes(moduleId));
}

async function rateLimit(env, scope, key, windowMs, maximum) {
  const allowed = await checkConsumerRateLimit(env, scope, key, windowMs, maximum);
  if (!allowed) throw new ConsumerError(429, 'rate_limited', 'Too many requests. Please try again later.');
}

function errorPayload(error) {
  if (error instanceof ConsumerError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    };
  }
  console.error('Consumer route failed', {
    error: error instanceof Error ? error.message : String(error)
  });
  return {
    status: 500,
    body: { error: 'The planning request could not be completed.', code: 'consumer_internal_error' }
  };
}

export function getConsumerRouteMethods(pathname) {
  const route = routeMatch(pathname);
  return route ? `${route.methods.join(',')},OPTIONS` : null;
}

export { rotateConsumerEncryptionBatch };

export async function cleanupExpiredConsumerSessionsWithRealtime(env, dependencies = {}) {
  return cleanupExpiredConsumerSessions(env, {
    ...dependencies,
    terminateRealtimeSession: dependencies.terminateRealtimeSession
      || ((sessionId) => terminateActiveRealtimeSession(env, sessionId, {
        status: 'expired',
        reason: 'consumer_session_expired',
        errorCode: null,
        usageKnown: false
      })),
    terminateRealtimeLease: dependencies.terminateRealtimeLease
      || ((lease) => terminateRealtimeLease(env, lease, {
        status: 'expired',
        reason: 'realtime_lease_expired',
        errorCode: null,
        usageKnown: false
      }))
  });
}

// Preserve the existing scheduled-import contract while adding the mandatory
// provider termination dependency.
export { cleanupExpiredConsumerSessionsWithRealtime as cleanupExpiredConsumerSessions };

export async function handleConsumerRequest(request, env, dependencies = {}) {
  const {
    pathname, respond, respondBinary, clientIp = 'unknown', createPipelineHandoff,
    publishConsumerSession = null, notifyAdviserOfPublishedCall = null
  } = dependencies;
  const route = routeMatch(pathname);
  if (!route) return respond({ error: 'Not found.', code: 'not_found' }, 404, 'GET,POST,PATCH,DELETE,OPTIONS');
  const methods = `${route.methods.join(',')},OPTIONS`;
  if (!route.methods.includes(request.method)) {
    return respond({ error: 'Method not allowed.', code: 'method_not_allowed' }, 405, methods, { Allow: route.methods.join(', ') });
  }

  const baseConfig = getConsumerConfig(env);
  const availableModules = baseConfig.journeyEnabled ? getAvailableConsumerModules(baseConfig) : [];
  const config = Object.freeze({
    ...baseConfig,
    allowedModules: availableModules.map((module) => module.id)
  });
  try {
    if (route.kind === 'bootstrap') {
      return respond({
        ...publicConsumerConfig(config),
        modules: availableModules
      }, 200, methods);
    }

    // Deploy verification only. Answers 404 -- not 401 or 403 -- when the
    // credential is absent or wrong, so an unauthenticated caller cannot tell
    // this route apart from one that does not exist.
    if (route.kind === 'deployment_envelope') {
      if (!isDeployVerificationRequest(request, env)) {
        return respond({ error: 'Not found.', code: 'not_found' }, 404, methods);
      }
      const envelope = deploymentCostEnvelope(config);
      // Optionally, the ceiling a NAMED session actually received. The config
      // envelope only proves what the Worker would apply; a session row is
      // written at creation and could disagree, which is exactly the fault the
      // deploy smoke check exists to catch. The consumer's own session routes
      // deliberately report availability and never figures, so this credential
      // is the only way to see it.
      const sessionId = new URL(request.url).searchParams.get('session');
      if (sessionId) {
        const budget = await getConsumerProviderBudget(env, sessionId);
        envelope.session = {
          sessionId,
          providerCostLimitMicroEur: Number(budget?.limitMicroEur ?? budget?.limitEurMicros ?? 0) || 0,
          spentMicroEur: Number(budget?.spentMicroEur ?? budget?.spentEurMicros ?? 0) || 0
        };
      }
      return respond(envelope, 200, methods);
    }

    if (route.kind === 'create') {
      assertFeatureAvailability(config);
      await rateLimit(env, 'consumer-create-ip', clientIp, 60 * 60 * 1000, 12);
      const consent = validateCreateSessionBody(await readJson(request), {
        manifestId: config.consentManifestId,
        policyVersion: config.consentPolicyVersion,
        analysisNoticeId: config.analysisNoticeId,
        aiNoticeId: config.aiNoticeId,
        privacyNoticeUrl: config.privacyNoticeUrl
      });
      if (consent.aiProcessing && !config.aiEnabled) {
        throw new ConsumerError(409, 'ai_consent_unavailable', 'Optional AI processing is not available for new sessions right now.');
      }
      const proposedCredential = request.headers.get('X-Consumer-Session')?.trim() || '';
      const credential = await createConsumerCredential(proposedCredential);
      const existing = proposedCredential ? await getSessionRow(env, credential.id) : null;
      if (existing) {
        const matches = constantTimeEqual(existing.credential_hash_b64u, credential.credentialHashB64u);
        if (!matches || existing.deleted_at || !['active', 'completed'].includes(existing.status)) {
          throw new ConsumerError(409, 'consumer_creation_conflict', 'Private session setup could not be resumed.');
        }
        return respond({
          session: toConsumerSession(existing),
          credential: credential.credential,
          idempotentReplay: true
        }, 200, methods);
      }
      const inviteClaims = await assertAudienceAccess(request, env, config);
      const created = await createSessionRecord(env, credential, consent, config, inviteClaims);
      return respond({ session: created.session, credential: credential.credential }, 201, methods);
    }

    await rateLimit(env, 'consumer-session-ip', clientIp, 60 * 1000, 120);
    let sessionRow = await requireConsumerSession(request, env, route.sessionId);
    await rateLimit(env, 'consumer-session-id', sessionRow.id, 60 * 1000, 80);

    if (route.kind === 'session' && request.method === 'DELETE') {
      const activeRealtime = await getActiveRealtimeLease(env, sessionRow.id);
      if (activeRealtime) {
        await closeRealtimeControl(env, activeRealtime, {
          status: 'deleted',
          reason: 'consumer_deleted',
          errorCode: null,
          usageKnown: false,
          required: false
        });
      }
      await recordEvent(env, sessionRow.id, 'journey_deleted', {}).catch(() => {});
      const result = await deleteSessionData(env, sessionRow.id, 'deleted');
      return respond({ ok: true, retainedConsentedHandoff: result.retainedHandoff }, 200, methods);
    }

    if (route.kind === 'consent') {
      validateConsentBody(await readJson(request));
      const result = await withdrawAiConsent(env, sessionRow, config);
      return respond({ ...result, ai: { mode: 'rules_only', status: 'rules_only' } }, 200, methods);
    }

    if (route.kind === 'realtime_meetings') {
      const meetings = await listRealtimeMeetings(env, sessionRow.id);
      return respond({ meetings }, 200, methods);
    }

    if (route.kind === 'realtime_meeting_transcript') {
      const url = new URL(request.url);
      const cursor = url.searchParams.get('cursor');
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      const transcript = await getRealtimeMeetingTranscript(
        env,
        sessionRow.id,
        route.meetingId,
        { cursor, limit }
      );
      return respond(transcript, 200, methods);
    }

    if (route.kind === 'voice_consent') {
      const body = validateVoiceConsentBody(await readJson(request), {
        noticeId: config.voiceNoticeId,
        policyVersion: config.consentPolicyVersion,
        privacyNoticeUrl: config.privacyNoticeUrl
      });
      if (body.granted) {
        assertProcessingAvailability(config);
        assertVoiceAvailability(config);
      }
      const voiceConsent = await setVoiceConsent(env, sessionRow, config, body.granted);
      const budget = await getConsumerProviderBudget(env, sessionRow.id);
      return respond({
        voiceConsent: toPublicVoiceConsent(voiceConsent),
        voiceAvailability: voiceBudgetPayload(budget, config)
      }, 200, methods);
    }

    if (route.kind === 'realtime_consent') {
      const body = validateRealtimeConsentBody(await readJson(request), {
        noticeId: config.realtimeNoticeId,
        policyVersion: config.consentPolicyVersion,
        privacyNoticeUrl: config.privacyNoticeUrl
      });
      if (body.granted) {
        assertProcessingAvailability(config);
        assertRealtimeAvailability(config);
      }
      const realtimeConsent = await setRealtimeConsent(env, sessionRow, config, body.granted);
      let realtimeLease = await getActiveRealtimeLease(env, sessionRow.id);
      if (!body.granted && realtimeLease) {
        realtimeLease = await closeRealtimeControl(env, realtimeLease, {
          status: 'withdrawn',
          reason: 'consent_withdrawn',
          errorCode: null,
          usageKnown: false,
          required: false
        });
      }
      return respond({
        realtimeConsent: toPublicRealtimeConsent(realtimeConsent),
        realtimeLease: toPublicRealtimeLease(realtimeLease),
        realtimeVoiceAvailability: realtimeVoiceBudgetPayload(
          await getConsumerProviderBudget(env, sessionRow.id),
          realtimeLease,
          config
        )
      }, 200, methods);
    }

    if (route.kind === 'realtime_activation') {
      const { activationId } = realtimeActivationCredentials(request, {
        activationId: route.activationId
      });
      const activationIdHash = await sha256Base64Url(activationId);
      let realtimeLease = await getRealtimeLeaseByActivationHash(
        env,
        sessionRow.id,
        activationIdHash
      );
      if (!realtimeLease) {
        return respond({
          cleanedUp: true,
          leaseFound: false,
          leaseClosed: false,
          providerHangupConfirmed: true
        }, 200, methods);
      }
      realtimeLease = await requireRealtimeControlCapability(
        request,
        env,
        sessionRow.id,
        realtimeLease.id,
        { requireActive: false }
      );
      const wasOpen = ['pending', 'active', 'closing'].includes(realtimeLease.status);
      if (wasOpen) {
        realtimeLease = await closeRealtimeControl(env, realtimeLease, {
          status: 'complete',
          reason: 'activation_recovery',
          errorCode: null,
          usageKnown: false,
          required: false
        });
        if (realtimeLease?.providerHangupConfirmed !== true) {
          throw new ConsumerError(502, 'realtime_hangup_uncertain', 'The live provider call termination could not be confirmed. Please retry.');
        }
      }
      return respond({
        cleanedUp: true,
        leaseFound: true,
        leaseClosed: wasOpen,
        providerHangupConfirmed: true
      }, 200, methods);
    }

    if (route.kind === 'realtime_speech') {
      assertProcessingAvailability(config);
      assertRealtimeAvailability(config);
      if (typeof respondBinary !== 'function') {
        throw new ConsumerError(503, 'realtime_speech_unavailable', 'Approved voice playback is not available. Continue with the visible caption.');
      }
      await requireRealtimeControlCapability(request, env, sessionRow.id, route.leaseId);
      await rateLimit(env, 'consumer-realtime-speech-session', sessionRow.id, 60 * 1000, 30);
      const body = await readJson(request);
      await assertRealtimeControlMessage(env, {
        sessionId: sessionRow.id,
        leaseId: route.leaseId,
        authorization: body
      });
      await claimRealtimeControlMessage(env, {
        sessionId: sessionRow.id,
        leaseId: route.leaseId,
        controlId: body.controlId
      });
      let result;
      try {
        result = await renderAuthorizedRealtimeSpeech({
          env,
          config,
          sessionRow,
          leaseId: route.leaseId,
          body
        });
        const consumed = await finalizeRealtimeControlMessage(env, {
          sessionId: sessionRow.id,
          leaseId: route.leaseId,
          controlId: body.controlId,
          status: 'consumed'
        });
        if (!consumed) {
          throw new ConsumerError(409, 'realtime_control_replayed', 'That approved voice command was already processed.');
        }
      } catch (error) {
        await finalizeRealtimeControlMessage(env, {
          sessionId: sessionRow.id,
          leaseId: route.leaseId,
          controlId: body.controlId,
          status: 'failed',
          errorCode: error instanceof ConsumerError ? error.code : 'realtime_speech_failed'
        }).catch(() => {});
        throw error;
      }
      const speechHeaders = {
        'Content-Type': result.contentType || 'audio/mpeg',
        'X-Realtime-Speech-Id': result.speechId,
        'Access-Control-Expose-Headers': 'X-Realtime-Speech-Id'
      };
      if (!result.streaming
        && Number.isSafeInteger(result.contentLength)
        && result.contentLength > 0) {
        speechHeaders['Content-Length'] = String(result.contentLength);
      }
      return respondBinary(result.audio, 200, methods, speechHeaders);
    }

    if (route.kind === 'realtime_lease') {
      let realtimeLease = await requireRealtimeControlCapability(
        request,
        env,
        sessionRow.id,
        route.leaseId,
        { requireActive: false }
      );
      if (!realtimeLease) throw notFound('This live voice lease could not be found.');
      if (request.method === 'DELETE' && ['pending', 'active', 'closing'].includes(realtimeLease.status)) {
        if (realtimeLease.meeting_phase === 'closing') {
          realtimeLease = await setRealtimeMeetingPhase(env, {
            sessionId: sessionRow.id,
            leaseId: realtimeLease.id,
            phase: 'completed',
            navigationTarget: realtimeLease.completion_navigation_target || '/plan/#results'
          });
        }
        realtimeLease = await closeRealtimeControl(env, realtimeLease, {
          status: 'complete',
          reason: 'consumer_closed',
          errorCode: null,
          usageKnown: true,
          required: false
        });
        if (realtimeLease?.providerHangupConfirmed !== true) {
          throw new ConsumerError(502, 'realtime_hangup_uncertain', 'The live provider call termination could not be confirmed. Please retry.');
        }
      }
      if (request.method === 'DELETE') {
        return respond({
          realtimeLease: toPublicRealtimeLease(realtimeLease),
          providerHangupConfirmed: true
        }, 200, methods);
      }
      const [
        controlPlane,
        providerBudget,
        realtimeTurns,
        analysisPlan,
        currentProfile,
        proposedFacts,
        realtimeControl,
        latestMeetingBrief
      ] = await Promise.all([
        getRealtimeControlPlaneProof(env, sessionRow.id, route.leaseId),
        getConsumerProviderBudget(env, sessionRow.id),
        listRealtimeFinalTurns(env, sessionRow.id, route.leaseId, 200),
        getCurrentRealtimeAnalysisPlan(env, sessionRow.id),
        getCurrentProfile(env, sessionRow),
        listRealtimeFactProposalSummaries(env, sessionRow.id, route.leaseId),
        getNextRealtimeControlMessage(env, sessionRow.id, route.leaseId),
        config.realtimeConversationV2Enabled
          ? getLatestRealtimeMeetingBrief(env, sessionRow.id, route.leaseId)
          : null
      ]);
      const planningState = describeConversationState(currentProfile, config);
      const pendingFacts = proposedFacts.map((proposal) => ({
        ...proposal,
        readBackText: proposal.readBackText || buildRealtimeFactReadBack(
          proposal.factId,
          proposal.value,
          proposal.certainty,
          currentProfile.preferences?.baseCurrency || 'EUR'
        )
      }));
      const nextQuestion = planningState.nextQuestion
        ? {
            questionId: planningState.nextQuestion.questionId || null,
            factId: planningState.nextQuestion.factId || null,
            factInstanceId: planningState.nextQuestion.factInstanceId || null,
            prompt: planningState.nextQuestion.prompt,
            answerType: planningState.nextQuestion.answerType,
            confirmationPolicy: planningState.nextQuestion.confirmationPolicy || 'final_review'
          }
        : null;
      return respond({
        realtimeLease: toPublicRealtimeLease(realtimeLease),
        realtimeVoiceAvailability: realtimeVoiceBudgetPayload(providerBudget, realtimeLease, config),
        controlPlane,
        planningState: {
          profileRevision: Number(sessionRow.current_profile_revision),
          confirmedProfileRevision: sessionRow.confirmed_profile_revision === null
            ? null
            : Number(sessionRow.confirmed_profile_revision),
          stage: planningState.stage,
          nextQuestion,
          selectionPolicyVersion: planningState.selectionPolicyVersion || null,
          goalAssessment: toPublicGoalAssessment(planningState.goalAssessment),
          moduleSlots: (planningState.moduleSlots || []).slice(0, 3),
          requiresGoalPriorityQuestion: planningState.requiresGoalPriorityQuestion === true,
          requiresDecisionTopicQuestion: planningState.requiresDecisionTopicQuestion === true,
          deferredGoalTypes: (planningState.deferredGoalTypes || []).slice(0, 8),
          facts: [
            ...pendingFacts,
            ...buildConfirmedRealtimeFactSummary(currentProfile)
          ].slice(0, 16),
          currentPendingProposal: pendingFacts[0] || null
        },
        analysisPlan: await getPublicRealtimeAnalysisPlan(env, analysisPlan),
        conversationGuide: toConversationGuide(latestMeetingBrief?.brief),
        realtimeTurns,
        ...(realtimeControl ? { realtimeControl } : {})
      }, 200, methods);
    }

    if (route.kind === 'handoffs' && request.method === 'DELETE') {
      const result = await revokeHandoff(env, sessionRow.id);
      return respond({
        ok: true,
        handoff: result.row ? toPublicHandoff(result.row) : null,
        downstreamShared: result.downstreamShared,
        adviserContactRequired: result.downstreamShared
      }, 200, methods);
    }

    const consentRefreshRequired = sessionRow.consent_manifest_id !== config.consentManifestId
      || sessionRow.consent_policy_version !== config.consentPolicyVersion
      || sessionRow.consent_analysis_notice_id !== config.analysisNoticeId
      || sessionRow.consent_ai_notice_id !== config.aiNoticeId
      || sessionRow.consent_privacy_notice_url !== config.privacyNoticeUrl;
    let profile = await getCurrentProfile(env, sessionRow);

    if (route.kind === 'session' && request.method === 'GET') {
      const [
        turns,
        analysis,
        handoffRow,
        voiceConsent,
        voiceBudget,
        realtimeConsent,
        realtimeLease,
        analysisPlan,
        realtimeMeetings
      ] = await Promise.all([
        listTurns(env, sessionRow.id),
        getLatestAnalysis(env, sessionRow.id, sessionRow.current_profile_revision),
        getHandoff(env, sessionRow.id),
        getVoiceConsent(env, sessionRow.id),
        (config.voiceEnabled || config.realtimeEnabled) ? getConsumerProviderBudget(env, sessionRow.id) : null,
        getRealtimeConsent(env, sessionRow.id),
        getLatestRealtimeLease(env, sessionRow.id),
        getCurrentRealtimeAnalysisPlan(env, sessionRow.id),
        listRealtimeMeetings(env, sessionRow.id)
      ]);
      const realtimeTurns = realtimeLease
        ? await listRealtimeFinalTurns(env, sessionRow.id, realtimeLease.id)
        : [];
      const latestMeetingBrief = config.realtimeConversationV2Enabled && realtimeLease
        ? await getLatestRealtimeMeetingBrief(env, sessionRow.id, realtimeLease.id)
        : null;
      const state = describeConversationState(profile, config);
      return respond({
        session: toConsumerSession(sessionRow),
        profile,
        turns,
        analysis,
        handoff: handoffRow ? toPublicHandoff(handoffRow) : null,
        bookingUrl: handoffRow && ['linked', 'delivered'].includes(handoffRow.status) ? config.bookingUrl : null,
        consentRefreshRequired,
        processingPaused: !config.journeyEnabled,
        voiceConsent: toPublicVoiceConsent(voiceConsent),
        voiceAvailability: voiceBudgetPayload(voiceBudget, config),
        realtimeVoiceAvailability: realtimeVoiceBudgetPayload(voiceBudget, realtimeLease, config),
        realtimeConsent: toPublicRealtimeConsent(realtimeConsent),
        realtimeLease: toPublicRealtimeLease(realtimeLease),
        realtimeMeetings,
        realtimeTurns,
        analysisPlan: await getPublicRealtimeAnalysisPlan(env, analysisPlan),
        conversationGuide: toConversationGuide(latestMeetingBrief?.brief),
        ...publicConversationState(state)
      }, 200, methods);
    }

    // The master switch stops all new processing. Authenticated read access,
    // deletion, AI withdrawal, and handoff withdrawal remain available as a
    // narrow data-rights plane during an incident.
    assertProcessingAvailability(config);

    if (consentRefreshRequired) {
      throw new ConsumerError(428, 'consent_refresh_required', 'The planning disclosure has changed. Start a new session or delete this saved session.');
    }

    if (route.kind === 'realtime_calls') {
      assertRealtimeAvailability(config);
      if (typeof respondBinary !== 'function') {
        throw new ConsumerError(503, 'realtime_response_unavailable', 'Live voice is not available in this deployment.');
      }
      const realtimeConsent = await getRealtimeConsent(env, sessionRow.id);
      if (!realtimeConsentIsCurrent(realtimeConsent, config)) {
        throw new ConsumerError(403, 'realtime_consent_required', 'Review and accept the current live voice disclosure before starting.');
      }
      await rateLimit(env, 'consumer-realtime-call-session', sessionRow.id, 60 * 60 * 1000, 6);
      const requestId = realtimeRequestId(request);
      const { activationId, controlCapability } = realtimeActivationCredentials(request, {
        allowServerFallback: true
      });
      const [activationIdHash, controlCapabilityHash] = await Promise.all([
        sha256Base64Url(activationId),
        sha256Base64Url(controlCapability)
      ]);
      const offerSdp = await readRealtimeSdpOffer(request, config.realtimeMaxSdpBytes);
      const providerBudget = await getConsumerProviderBudget(env, sessionRow.id);
      const reservationAmount = Number(providerBudget.remainingEurMicros || 0);
      if (reservationAmount <= config.realtimeSafetyReserveMicroEur) {
        throw new ConsumerError(402, 'realtime_budget_exceeded', 'Voice is unavailable for the rest of this session. You can continue by typing.');
      }
      const reservation = await reserveConsumerProviderCost(env, {
        sessionId: sessionRow.id,
        operation: 'realtime_voice_session',
        idempotencyKey: requestId,
        provider: 'openai',
        model: config.realtimeModel,
        pricingVersion: config.realtimePricingVersion,
        reservedCostEurMicros: reservationAmount,
        dailyCostLimitEurMicros: config.realtimeDailyBudgetMicroEur
      });
      if (reservation.existing) {
        throw new ConsumerError(409, 'realtime_request_already_used', 'That live voice request id was already used. Create a new WebRTC offer.');
      }
      if (reservation.denied || !reservation.entry) {
        throw new ConsumerError(402, 'realtime_budget_exceeded', 'Voice is unavailable for the rest of this session. You can continue by typing.');
      }
      let lease = null;
      let dispatched = false;
      let providerCallId = null;
      try {
        lease = await createRealtimeLease(
          env,
          sessionRow,
          config,
          reservation.entry,
          controlCapabilityHash,
          activationIdHash
        );
        await markRealtimeProviderCostInFlight(env, reservation.entry.id, sessionRow.id, config);
        dispatched = true;
        const state = describeConversationState(profile, config);
        // The live lane differs only in the provider session policy it opens
        // the call with — `create_response: true`, its own toolset, and the
        // cached catalogue prompt. Everything above and below this point (the
        // budget reservation, the lease, the rollback and hang-up path) is
        // shared deliberately: two copies of that is exactly the code you do
        // not want to maintain twice.
        const providerCall = await createOpenAiRealtimeCall({
          env,
          config,
          sessionId: sessionRow.id,
          offerSdp,
          state,
          ...(config.liveVoiceEnabled ? { sessionConfig: buildLiveSessionConfig(config) } : {})
        });
        providerCallId = providerCall.providerCallId;
        lease = await activateRealtimeLease(env, sessionRow.id, lease.id, providerCallId);
        await durableObjectRequest(env, lease.id, '/activate', {
          sessionId: sessionRow.id,
          leaseId: lease.id,
          costEntryId: reservation.entry.id
        });
        return respondBinary(providerCall.answerSdp, 201, methods, {
          'Content-Type': 'application/sdp',
          'Content-Length': String(new TextEncoder().encode(providerCall.answerSdp).byteLength),
          'X-Realtime-Lease-Id': lease.id,
          'X-Realtime-Hard-Expires-At': lease.hard_expires_at,
          'X-Realtime-Idle-Timeout-Seconds': String(config.realtimeIdleTimeoutSeconds),
          'X-Realtime-Budget-Micro-Eur': String(lease.reservation_eur_micros),
          'X-Realtime-Dispatch-Stop-Micro-Eur': String(lease.dispatch_stop_eur_micros),
          'X-Realtime-Activation-Id': activationId,
          'X-Realtime-Control-Capability': controlCapability,
          'X-Realtime-Conversation-Version': config.liveVoiceEnabled
            ? 'live'
            : config.realtimeConversationV2Enabled ? 'v2' : 'v1',
          'Access-Control-Expose-Headers': [
            'X-Realtime-Lease-Id',
            'X-Realtime-Hard-Expires-At',
            'X-Realtime-Idle-Timeout-Seconds',
            'X-Realtime-Budget-Micro-Eur',
            'X-Realtime-Dispatch-Stop-Micro-Eur',
            'X-Realtime-Activation-Id',
            'X-Realtime-Control-Capability',
            'X-Realtime-Conversation-Version'
          ].join(', ')
        });
      } catch (error) {
        if (!providerCallId && typeof error?.providerCallId === 'string') {
          providerCallId = error.providerCallId;
        }
        let hangupError = null;
        if (providerCallId) {
          try {
            await hangupOpenAiRealtimeCall({ env, providerCallId });
          } catch (providerHangupError) {
            hangupError = providerHangupError;
          }
        }
        if (hangupError) {
          if (lease?.status === 'pending') {
            lease = await activateRealtimeLease(env, sessionRow.id, lease.id, providerCallId)
              .catch(() => lease);
          }
          throw new ConsumerError(
            502,
            'realtime_hangup_uncertain',
            'Live voice did not start and provider termination is still being verified. Retry ending the returned lease.',
            lease?.id ? { leaseId: lease.id } : undefined
          );
        }
        if (lease) {
          await closeRealtimeLease(
            env,
            sessionRow.id,
            lease.id,
            'failed',
            'activation_failed',
            error instanceof ConsumerError ? error.code : 'realtime_activation_failed'
          ).catch(() => {});
        }
        if (dispatched) {
          await settleConsumerProviderCostUnknown(env, reservation.entry.id, {
            errorCode: error instanceof ConsumerError ? error.code : 'realtime_activation_failed',
            estimatedCostEurMicros: Number(lease?.estimated_cost_eur_micros || 0)
          }).catch(() => {});
        } else {
          await releaseConsumerProviderCostNotSent(env, reservation.entry.id, {
            errorCode: error instanceof ConsumerError ? error.code : 'realtime_activation_failed'
          }).catch(() => {});
        }
        throw error;
      }
    }

    if (route.kind === 'analysis_plan') {
      if (!config.moduleRoutingEnabled) {
        throw new ConsumerError(404, 'module_routing_disabled', 'Consumer analysis is not available.');
      }
      await rateLimit(env, 'consumer-analysis-plan-session', sessionRow.id, 60 * 60 * 1000, 20);
      const body = validateRealtimeAnalysisPlanBody(await readJson(request), config.allowedModules);
      if (body.expectedRevision !== Number(sessionRow.current_profile_revision)) {
        throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed before this analysis plan could be processed.');
      }
      if (body.action === 'prepare') {
        let lease = null;
        if (body.leaseId) {
          lease = await getRealtimeLease(env, sessionRow.id, body.leaseId);
          if (!lease || lease.status !== 'active') {
            throw new ConsumerError(409, 'realtime_lease_conflict', 'The live voice lease is not active for this planning session.');
          }
        }
        const planningState = describeConversationState(profile, config);
        if (planningState.requiresDecisionTopicQuestion) {
          throw new ConsumerError(409, 'decision_topic_required', 'Name the specific financial decision before confirming the three-analysis plan.');
        }
        if (planningState.requiresGoalPriorityQuestion) {
          throw new ConsumerError(409, 'goal_priority_required', 'Choose which explicit goal this analysis plan should address first.');
        }
        const moduleIds = realtimePlanModuleIds(profile, config);
        if (!(planningState.moduleSlots || []).length) {
          throw new ConsumerError(409, 'analysis_plan_empty', 'Clarify a supported goal before preparing this analysis.');
        }
        const planInput = {
          moduleIds,
          scenarioOverrides: body.scenarioOverrides,
          selectionPolicyVersion: planningState.selectionPolicyVersion,
          goalAssessment: planningState.goalAssessment,
          ...(planningState.personaAssessment ? { personaAssessment: planningState.personaAssessment } : {}),
          moduleSlots: planningState.moduleSlots,
          requiresGoalPriorityQuestion: planningState.requiresGoalPriorityQuestion,
          deferredGoalTypes: planningState.deferredGoalTypes
        };
        const prepared = await prepareRealtimeAnalysisPlan(env, {
          sessionId: sessionRow.id,
          leaseId: lease?.id || null,
          idempotencyKey: body.idempotencyKey,
          profileRevision: body.expectedRevision,
          ...planInput
        });
        const analysisPlan = {
          ...toPublicRealtimeAnalysisPlan(prepared.row, planInput),
          planNonce: prepared.planNonce
        };
        if (lease) {
          await durableObjectRequest(env, lease.id, '/analysis-plan', {
            planId: prepared.row.id,
            status: prepared.row.status,
            profileRevision: body.expectedRevision
          });
        }
        return respond({ analysisPlan, idempotentReplay: prepared.idempotentReplay }, 200, methods);
      }

      const confirmed = await confirmAndRunRealtimeAnalysisPlan({
        env,
        config,
        sessionId: sessionRow.id,
        planId: body.planId,
        planNonce: body.planNonce,
        expectedRevision: body.expectedRevision
      });
      const leaseId = confirmed.analysisPlan?.leaseId || null;
      let assistantSpeech = null;
      if (leaseId) {
        const lease = await getRealtimeLease(env, sessionRow.id, leaseId);
        if (!lease) {
          throw new ConsumerError(409, 'realtime_lease_conflict', 'The analysis plan is not linked to this planning session.');
        }
        if (lease.status === 'active') {
          const realtimeUpdate = await durableObjectRequest(env, lease.id, '/analysis-plan', {
            planId: confirmed.analysisPlan.planId,
            status: confirmed.analysisPlan.status,
            profileRevision: body.expectedRevision,
            speakableText: confirmed.result?.speakableText || ''
          });
          assistantSpeech = realtimeUpdate.assistantSpeech || null;
        }
      }
      return respond({
        analysisPlan: confirmed.analysisPlan,
        analysis: confirmed.analysis || null,
        result: confirmed.result || null,
        requiredQuestions: confirmed.requiredQuestions || [],
        idempotentReplay: confirmed.idempotentReplay,
        ...(assistantSpeech ? { assistantSpeech } : {})
      }, 200, methods);
    }


    if (route.kind === 'voice_transcriptions' || route.kind === 'voice_speech') {
      assertVoiceAvailability(config);
      const voiceConsent = await getVoiceConsent(env, sessionRow.id);
      if (!voiceConsentIsCurrent(voiceConsent, config)) {
        throw new ConsumerError(403, 'voice_consent_required', 'Review and accept the current microphone disclosure before using voice.');
      }
      await rateLimit(env, 'consumer-voice-session', sessionRow.id, 60 * 1000, 12);
      if (route.kind === 'voice_transcriptions') {
        const { voiceBudget, ...result } = await transcribeConsumerVoice({
          env, config, sessionRow, request
        });
        // The provider figures stop here. The transcription route was still
        // handing the browser limit/spent/remaining after every other consumer
        // surface had been reduced to availability, so a person on a planning
        // call could read what their call was costing. The ledger still needs
        // the numbers; the client only needs to know it may continue.
        return respond({ ...result, voiceAvailability: voiceBudgetPayload(voiceBudget, config) }, 200, methods);
      }
      const body = validateVoiceSpeechBody(await readJson(request));
      const state = describeConversationState(profile, config);
      const result = await speakConsumerQuestion({
        env,
        config,
        sessionRow,
        idempotencyKey: body.idempotencyKey,
        text: questionText(state.nextQuestion)
      });
      if (typeof respondBinary !== 'function') {
        throw new ConsumerError(503, 'voice_response_unavailable', 'Spoken playback is not available. You can read the question on screen.');
      }
      return respondBinary(result.audio, 200, methods, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(result.audio.byteLength)
      });
    }

    if (route.kind === 'turns') {
      await rateLimit(env, 'consumer-turn-session', sessionRow.id, 60 * 1000, 15);
      const body = validateTurnBody(await readJson(request), config.maxMessageLength);
      const result = await processTurn({ env, config, sessionRow, profile, ...body });
      return respond(result, 200, methods);
    }

    if (route.kind === 'profile') {
      const body = validateProfilePatchBody(await readJson(request));
      if (body.expectedRevision !== Number(sessionRow.current_profile_revision)) {
        throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed in another request. Refresh and try again.');
      }
      const nextProfile = applyProfilePatch(profile, body.patch, body.confirmedPaths, 'consumer_edit', body.removePaths);
      const state = describeConversationState(nextProfile, config);
      const saved = await saveProfileRevision(env, sessionRow, nextProfile, state.stage);
      return respond({
        ...saved,
        ...publicConversationState(describeConversationState(saved.profile, config))
      }, 200, methods);
    }

    if (route.kind === 'confirm') {
      const body = validateConfirmBody(await readJson(request));
      if (body.expectedRevision !== Number(sessionRow.current_profile_revision)) {
        throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed in another request. Refresh and try again.');
      }
      if (body.confirmedPaths.length) {
        const marked = applyProfilePatch(profile, {}, body.confirmedPaths, 'consumer_edit');
        const saved = await saveProfileRevision(env, sessionRow, marked, 'review');
        sessionRow = await getSessionRow(env, sessionRow.id);
        profile = saved.profile;
      }
      // The same shared confirmation rule the voice meeting uses: record the
      // exact analysis set the client confirmed, so only that set may execute.
      const confirmed = await confirmPlanSelection({ env, config, sessionRow, profile });
      return respond({
        ...confirmed,
        ...publicConversationState(describeConversationState(confirmed.profile, config))
      }, 200, methods);
    }

    if (route.kind === 'analyses') {
      if (!config.moduleRoutingEnabled) throw new ConsumerError(404, 'module_routing_disabled', 'Consumer analysis is not available.');
      await rateLimit(env, 'consumer-analysis-session', sessionRow.id, 60 * 60 * 1000, 20);
      const body = validateAnalysisBody(await readJson(request, { optional: true }), config.allowedModules);
      const result = await runStoredConsumerAnalysis({ env, config, sessionRow, profile, ...body });
      return respond({ session: result.session, profile, analysis: result.analysis }, 200, methods);
    }

    if (route.kind === 'publish') {
      // THE SESSION AUTHORISES; THE SERVER WRITES. Reaching here proves the
      // caller holds this session's credential, and that is the only thing the
      // request decides. No body is read: the published payload is rebuilt from
      // the confirmed profile and the analysis the engine already ran, so this
      // route cannot be used to put chosen content in front of a client.
      if (!config.moduleRoutingEnabled) throw new ConsumerError(404, 'module_routing_disabled', 'Consumer analysis is not available.');
      if (typeof publishConsumerSession !== 'function') {
        throw new ConsumerError(503, 'publish_unconfigured', 'Publishing is not available.');
      }
      await rateLimit(env, 'consumer-publish-session', sessionRow.id, 60 * 60 * 1000, 6);
      const analysis = await getLatestAnalysis(env, sessionRow.id, sessionRow.current_profile_revision, {
        completedOnly: true
      });
      if (!analysis) {
        throw new ConsumerError(409, 'analysis_incomplete', 'There is no completed analysis to publish yet.');
      }
      const published = await publishConsumerAnalysis({
        env,
        config,
        sessionRow,
        profile,
        analysis,
        storePublishedSession: publishConsumerSession,
        notifyAdviser: notifyAdviserOfPublishedCall || null
      });
      // The adviser link is never returned to the caller: it is the key to the
      // adviser view and only reaches the configured adviser mailbox.
      return respond({
        publishedId: published.publishedId,
        clientUrl: published.clientUrl,
        moduleCount: published.moduleCount,
        expiresAt: published.expiresAt
      }, 201, methods);
    }

    if (route.kind === 'handoffs') {
      await rateLimit(env, 'consumer-handoff-session', sessionRow.id, 60 * 60 * 1000, 6);
      const handoff = validateHandoffBody(await readJson(request), {
        version: config.handoffPolicyVersion,
        url: config.handoffPolicyUrl
      });
      if (handoff.expectedRevision !== undefined
        && handoff.expectedRevision !== Number(sessionRow.current_profile_revision)) {
        throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed before the handoff was confirmed. Refresh and review it again.');
      }
      const result = await requestAdviserHandoff({
        env,
        config,
        sessionRow,
        profile,
        handoff,
        createPipelineHandoff
      });
      return respond({ session: toConsumerSession(await getSessionRow(env, sessionRow.id)), ...result }, 201, methods);
    }

    throw notFound();
  } catch (error) {
    const mapped = errorPayload(error);
    return respond(mapped.body, mapped.status, methods);
  }
}
