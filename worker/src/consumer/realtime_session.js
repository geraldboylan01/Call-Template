import { getConsumerConfig } from './config.js';
import {
  getSemanticFactDefinition,
  resolveSemanticFact
} from '../../../js/planning/semantic_facts.js';
import { normalizeHouseholdProfile } from '../../../js/planning/profile.js';
import { getPlanningModuleDefinition } from '../../../js/planning/module_registry.js';
import { toPublicPersonaAssessment } from '../../../js/planning/persona_catalogue.js';
import { recommendModules } from '../../../js/planning/routing_rules.js';
import { hmacSha256Base64Url, stableStringify } from './crypto.js';
import { confirmAndRunRealtimeAnalysisPlan } from './realtime_analysis.js';
import { describeConversationState } from './conversation.js';
import { ConsumerError } from './errors.js';
import {
  getCurrentProfile,
  getSessionRow,
  releaseConsumerProviderCostNotSent,
  settleConsumerProviderCostKnown,
  settleConsumerProviderCostUnknown
} from './repository.js';
import {
  appendRealtimeEvent,
  beginRealtimeToolAttempt,
  cancelPendingRealtimeControlMessages,
  closeRealtimeLease,
  commitRealtimeFactConfirmation,
  completeRealtimeToolAttempt,
  createRealtimeFactProposal,
  getPendingRealtimeFactProposal,
  getRealtimeAnalysisPlanResult,
  getRealtimeConsent,
  getLatestRealtimeMeetingBrief,
  getRealtimeLease,
  getRealtimeProviderCallId,
  hasUnsettledRealtimeSpeechUsage,
  listRealtimeFactProposalSummaries,
  listRealtimeFinalTurns,
  realtimeConsentIsCurrent,
  recordRealtimeFinalTurn,
  recordRealtimeUsage,
  rejectRealtimeFactProposal,
  saveRealtimeMeetingBrief,
  touchRealtimeLease
} from './realtime_repository.js';
import {
  buildConfirmedRealtimeFactSummary,
  buildRealtimeFactReadBack,
  mapRealtimeFact,
  modulesEnabledByFacts,
  realtimeFactAllowed,
  realtimeFactValueVocabulary
} from './realtime_fact_mapper.js';
import {
  assertRealtimeToolName,
  buildRealtimeSessionConfig,
  hangupOpenAiRealtimeCall,
  realtimeJourneyPhase,
  realtimeToolsForState
} from './realtime_provider.js';
import { composeDirectedSpeech } from './realtime_director.js';
import { issueRealtimeSpeechAuthorization } from './realtime_speech.js';
import {
  composeMeetingBrief,
  extractRealtimePlannerTurn,
  intakeExplanation,
  positionCandidatesToRealtimeFacts,
  sectionCompletionToRealtimeFact,
  toConversationGuide
} from './realtime_planner.js';
import {
  applyProfilePatch
} from './validators.js';

const MAX_INTERNAL_BODY_BYTES = 64_000;
const MAX_PROVIDER_EVENT_BYTES = 64_000;
const MAX_TOOL_ARGUMENT_BYTES = 20_000;
const TOOL_VERSION = '1';
const SIDE_BAND_URL = 'https://api.openai.com/v1/realtime';
const REALTIME_V2_WELCOME_INSTRUCTIONS = [
  'Open with a warm, unhurried welcome in three or four short sentences.',
  'Introduce yourself as Planéir, an AI planning companion.',
  'Explain that this will be a relaxed conversation about what matters to the client, and that useful details will appear on screen as reviewable drafts.',
  'Reassure the client that they can ask questions at any time and that no analysis runs until they review and confirm the visible information.',
  'Finish with one open invitation to describe what they would like help understanding today.',
  'Do not list categories, ask for financial figures, call a tool, or mention internal systems.'
].join(' ');
// propose_facts rejections that a corrected retry of the same call can
// genuinely resolve. Everything else (a fact the routed analyses do not use,
// a duplicate, an out-of-order confirmation) speaks immediately and advances
// the interview instead of silently retrying.
export const RETRYABLE_TOOL_ERROR_CODES = new Set([
  'realtime_goal_invalid',
  'realtime_fact_value_invalid',
  'realtime_fact_certainty_invalid',
  'realtime_fact_range_invalid',
  'profile_revision_conflict'
]);
// Rejections where the consumer's statement was fine but the current analyses
// simply do not need it: acknowledge warmly and move on rather than apologise.
const INFORMATION_NOT_NEEDED_ERROR_CODES = new Set([
  'realtime_fact_not_routed',
  'realtime_fact_duplicate'
]);
const SIDE_BAND_HEARTBEAT_MS = 15_000;

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeTextEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ''));
  const b = new TextEncoder().encode(String(right || ''));
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index] || 0) ^ (b[index] || 0);
  }
  return mismatch === 0;
}

function assertBoundedJson(value, depth = 0, counter = { count: 0 }) {
  counter.count += 1;
  if (counter.count > 500 || depth > 8) throw new Error('tool_arguments_shape_invalid');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (value.length > 8_000) throw new Error('tool_arguments_shape_invalid');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('tool_arguments_shape_invalid');
    value.forEach((item) => assertBoundedJson(item, depth + 1, counter));
    return;
  }
  if (!value || typeof value !== 'object') throw new Error('tool_arguments_shape_invalid');
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error('tool_arguments_shape_invalid');
  for (const [key, item] of entries) {
    if (!key || key.length > 120 || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new Error('tool_arguments_shape_invalid');
    }
    assertBoundedJson(item, depth + 1, counter);
  }
}

function normalizedTools(value) {
  if (!Array.isArray(value)) return null;
  const allowedKeys = new Set(['type', 'name', 'description', 'parameters', 'strict']);
  if (value.some((tool) => !tool || typeof tool !== 'object'
    || Object.keys(tool).some((key) => !allowedKeys.has(key)))) return null;
  return value.map((tool) => ({
    type: tool.type,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // The provider may materialize its default `strict: false` in the
    // effective session even when the client omitted it.
    strict: tool.strict === true
  }));
}

function normalizedAudioFormat(value) {
  if (!value || typeof value !== 'object') return null;
  const type = value.type ?? null;
  return {
    type,
    // A Realtime PCM stream is always 24 kHz. Treat an omitted rate and the
    // provider-materialized documented default as the same effective policy,
    // while preserving any explicit non-default value so it still fails the
    // constant-time session-policy comparison.
    ...(type === 'audio/pcm'
      ? { rate: value.rate === undefined ? 24_000 : value.rate }
      : (value.rate === undefined ? {} : { rate: value.rate }))
  };
}

function normalizedToolChoice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
  return {
    type: value.type ?? null,
    name: value.name ?? null
  };
}

export function realtimeSessionPolicySnapshot(session = {}) {
  return {
    type: session.type,
    model: session.model,
    instructions: session.instructions,
    // Realtime reasoning sessions can add provider-owned accounting/default
    // fields. Effort is the Worker-controlled policy field.
    reasoning: { effort: session.reasoning?.effort ?? null },
    output_modalities: session.output_modalities,
    audio: {
      input: {
        format: normalizedAudioFormat(session.audio?.input?.format),
        noise_reduction: { type: session.audio?.input?.noise_reduction?.type ?? null },
        transcription: {
          model: session.audio?.input?.transcription?.model ?? null,
          language: session.audio?.input?.transcription?.language ?? null
        },
        turn_detection: {
          type: session.audio?.input?.turn_detection?.type ?? null,
          eagerness: session.audio?.input?.turn_detection?.eagerness ?? null,
          create_response: session.audio?.input?.turn_detection?.create_response ?? null,
          interrupt_response: session.audio?.input?.turn_detection?.interrupt_response ?? null
        }
      },
      output: {
        format: normalizedAudioFormat(session.audio?.output?.format),
        speed: session.audio?.output?.speed ?? null,
        voice: session.audio?.output?.voice ?? null
      }
    },
    tools: normalizedTools(session.tools),
    tool_choice: normalizedToolChoice(session.tool_choice),
    // The Worker pins parallel_tool_calls:false. The provider applies it but
    // has stopped echoing it in session.updated, so coerce like tool `strict`:
    // absent is the requested false, while an explicit provider-echoed true
    // still fails the policy comparison.
    parallel_tool_calls: session.parallel_tool_calls === true,
    max_output_tokens: session.max_output_tokens,
    truncation: session.truncation,
    include: Array.isArray(session.include) ? session.include : []
  };
}

// Diagnostic only: report which policy-snapshot fields differ between what the
// Worker pinned and what the provider echoed, so a provider-side default
// change is identified precisely instead of guessed. Values are bounded config
// fields (model, voice, turn detection, tool shapes) — never user content.
export function diffPolicySnapshot(expected, actual, base = '') {
  const differences = [];
  const brief = (value) => {
    if (value === undefined) return '(absent)';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return String(text).length > 140 ? `${String(text).slice(0, 140)}…` : String(text);
  };
  const walk = (left, right, path) => {
    if (differences.length > 25) return;
    const leftObj = left && typeof left === 'object' && !Array.isArray(left);
    const rightObj = right && typeof right === 'object' && !Array.isArray(right);
    if (leftObj && rightObj) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        walk(left[key], right[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      differences.push({ path: path || '(root)', expected: brief(left), actual: brief(right) });
    }
  };
  walk(expected, actual, base);
  return differences;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function cleanProviderCode(value) {
  const candidate = typeof value === 'string' ? value : '';
  return /^[A-Za-z0-9._:-]{1,120}$/.test(candidate) ? candidate : 'provider_error';
}

function cleanProviderParam(value) {
  const candidate = typeof value === 'string' ? value : '';
  return /^[A-Za-z0-9._:\[\]-]{1,120}$/.test(candidate) ? candidate : null;
}

const FATAL_PROVIDER_ERROR_PATTERN = /(?:auth(?:entication|orization)?|unauthori[sz]ed|forbidden|permission|api[_-]?key|session(?:[_:.-](?:closed|expired|invalid|not_found|update))|connection|websocket|sideband|maximum[_:.-]?duration|rate[_:.-]?limit|quota|billing|pricing|usage|policy)/i;
const FATAL_PROVIDER_PARAM_PATTERN = /^(?:session(?:\.|$)|model$|instructions$|reasoning(?:\.|$)|tools?(?:\.|$)|tool_choice$|parallel_tool_calls$|max_output_tokens$|truncation(?:\.|$)|output_modalities$|audio\.(?:input|output)\.(?:format|noise_reduction|transcription|turn_detection|voice|speed)(?:\.|$))/i;
const RESPONSE_PROVIDER_SCOPE_PATTERN = /(?:^|[._:-])response(?:[._:-]|$)/i;
const INPUT_PROVIDER_SCOPE_PATTERN = /(?:input_audio|audio_unintelligible|transcription)/i;
const ITEM_PROVIDER_SCOPE_PATTERN = /(?:^|[._:-])(?:conversation[._:-]?)?item(?:[._:-]|$)/i;

export function classifyRealtimeProviderError(event = {}) {
  const error = event?.error && typeof event.error === 'object' && !Array.isArray(event.error)
    ? event.error
    : {};
  const code = cleanProviderCode(error.code || error.type);
  const type = cleanProviderCode(error.type);
  const param = cleanProviderParam(error.param);
  const clientEventId = validProviderId(error.event_id) ? String(error.event_id) : null;
  const descriptor = [code, type, param].filter(Boolean).join(':');
  const fatal = FATAL_PROVIDER_ERROR_PATTERN.test(descriptor)
    || (param ? FATAL_PROVIDER_PARAM_PATTERN.test(param) : false);
  let scope = null;
  if (RESPONSE_PROVIDER_SCOPE_PATTERN.test(descriptor)) scope = 'response';
  else if (INPUT_PROVIDER_SCOPE_PATTERN.test(descriptor)) scope = 'input';
  else if (ITEM_PROVIDER_SCOPE_PATTERN.test(descriptor)) scope = 'item';
  else if (clientEventId) scope = 'request';
  return {
    code,
    type,
    param,
    clientEventId,
    scope: scope || 'session',
    recoverable: Boolean(scope) && !fatal
  };
}

function validProviderId(value) {
  return /^[A-Za-z0-9._:-]{1,160}$/.test(String(value || ''));
}

function isAudioOnlyUserItem(item) {
  if (!item || item.type !== 'message' || item.role !== 'user' || !validProviderId(item.id)) return false;
  if (!Array.isArray(item.content) || item.content.length < 1 || item.content.length > 4) return false;
  return item.content.every((part) => (
    part && typeof part === 'object'
    && ['input_audio', 'input_audio_transcription'].includes(part.type)
    && typeof part.text !== 'string'
  ));
}

function boundedProposalRange(value) {
  const source = value?.range && typeof value.range === 'object' ? value.range : value;
  const comparable = (item) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Number(item.amount)
      : Number(item)
  );
  const min = comparable(source?.min);
  const max = comparable(source?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  return { min: source.min, max: source.max };
}

// The bounded value vocabulary for the facts the interview is asking about
// right now (plus the goal vocabulary, which anchors the whole journey). The
// model can only map free speech onto server-owned enumerations it can see.
function planningStateValueVocabulary(state = {}) {
  const factIds = new Set(['primary_goal']);
  const questionFactIds = Array.isArray(state.nextQuestion?.factIds) ? state.nextQuestion.factIds : [];
  questionFactIds.forEach((factId) => factIds.add(String(factId || '')));
  const vocabulary = {};
  for (const factId of factIds) {
    const values = realtimeFactValueVocabulary(factId);
    if (values) vocabulary[factId] = values;
  }
  return vocabulary;
}

// Bounded, non-content guidance that lets the model correct a rejected call
// instead of abandoning the interview.
function rejectedToolGuidance(errorCode, context) {
  if (errorCode === 'realtime_goal_invalid') {
    return { guidance: { allowedValues: realtimeFactValueVocabulary('primary_goal') } };
  }
  if (errorCode === 'profile_revision_conflict') {
    const revision = Number(context?.sessionRow?.current_profile_revision);
    return Number.isSafeInteger(revision) ? { guidance: { currentRevision: revision } } : {};
  }
  if (['realtime_fact_value_invalid', 'realtime_fact_certainty_invalid'].includes(errorCode)) {
    return {
      guidance: {
        hint: 'Use the exact values from get_planning_state factValueVocabulary and resubmit one corrected call.'
      }
    };
  }
  if (errorCode === 'realtime_fact_not_routed') {
    return {
      guidance: {
        hint: 'Propose only the semantic facts requested by the current get_planning_state question plan.'
      }
    };
  }
  return {};
}

function controlledQuestionText(state = {}) {
  const text = typeof state.nextQuestion?.prompt === 'string'
    ? state.nextQuestion.prompt.trim()
    : '';
  return text && text.length <= 500 ? text : '';
}

function controlledModuleList(moduleSlots = []) {
  const labels = moduleSlots.slice(0, 3).map((slot) => (
    getPlanningModuleDefinition(slot?.moduleId)?.label
    || String(slot?.moduleId || '').replace(/_/g, ' ')
  )).filter(Boolean);
  if (labels.length < 1) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

function completionFactMapping(profile, fact, normalizedRange = null) {
  const definition = getSemanticFactDefinition(fact.factId);
  if (!definition || !['money', 'number'].includes(definition.valueType)) {
    throw new ConsumerError(
      400,
      'realtime_fact_certainty_invalid',
      'Only a numerical or monetary fact may be recorded as unknown or as a range.'
    );
  }
  const completionFacts = {
    ...(profile.assumptions?.values?.completionFacts || {}),
    unknownFactIds: {
      ...(profile.assumptions?.values?.completionFacts?.unknownFactIds || {})
    },
    rangedFactValues: {
      ...(profile.assumptions?.values?.completionFacts?.rangedFactValues || {})
    }
  };
  if (fact.certainty === 'unknown') {
    completionFacts.unknownFactIds[fact.factId] = true;
    delete completionFacts.rangedFactValues[fact.factId];
    return {
      fieldPath: '/assumptions/values/completionFacts',
      metadataPath: `/assumptions/values/completionFacts/unknownFactIds/${fact.factId}`,
      canonicalValue: completionFacts,
      displayValue: 'Unknown'
    };
  }
  delete completionFacts.unknownFactIds[fact.factId];
  completionFacts.rangedFactValues[fact.factId] = normalizedRange;
  return {
    fieldPath: '/assumptions/values/completionFacts',
    metadataPath: `/assumptions/values/completionFacts/rangedFactValues/${fact.factId}`,
    canonicalValue: completionFacts,
    displayValue: normalizedRange
  };
}

function mapRealtimeProposalFact(profile, fact) {
  if (fact.certainty === 'unknown') return completionFactMapping(profile, fact);
  if (fact.certainty !== 'range') return mapRealtimeFact(profile, fact);
  const range = boundedProposalRange(fact.value);
  if (!range) {
    throw new ConsumerError(400, 'realtime_fact_range_invalid', 'A ranged fact requires finite minimum and maximum values.');
  }
  const minimum = mapRealtimeFact(profile, { ...fact, certainty: 'exact', value: range.min });
  const maximum = mapRealtimeFact(profile, { ...fact, certainty: 'exact', value: range.max });
  if (minimum.fieldPath !== maximum.fieldPath) {
    throw new ConsumerError(409, 'realtime_fact_range_invalid', 'The ranged fact does not map to one stable profile field.');
  }
  const normalizedRange = { min: minimum.displayValue, max: maximum.displayValue };
  const checked = boundedProposalRange(normalizedRange);
  if (!checked) {
    throw new ConsumerError(400, 'realtime_fact_range_invalid', 'The ranged fact minimum must not exceed its maximum.');
  }
  return completionFactMapping(profile, fact, normalizedRange);
}

function clearCompletionFactMarker(profile, factId, fieldPath = null) {
  const completionFacts = profile.assumptions?.values?.completionFacts;
  if (!completionFacts) return profile;
  if (completionFacts.unknownFactIds) delete completionFacts.unknownFactIds[factId];
  if (completionFacts.rangedFactValues) delete completionFacts.rangedFactValues[factId];
  if (fieldPath && completionFacts.confirmedNonePaths) {
    delete completionFacts.confirmedNonePaths[fieldPath];
  }
  if (fieldPath && completionFacts.completedPaths) {
    delete completionFacts.completedPaths[fieldPath];
  }
  return profile;
}

function patchForMappedRealtimeFact(mapped) {
  return {
    ...(mapped.additionalPatch || {}),
    [mapped.fieldPath]: mapped.canonicalValue
  };
}

function applyMappedRealtimeFact(profile, fact, mapped) {
  const patch = patchForMappedRealtimeFact(mapped);
  let nextProfile = applyProfilePatch(profile, patch, [], 'consumer_edit');
  const metadataPath = mapped.metadataPath || mapped.fieldPath;
  const certainty = String(fact.certainty || 'unknown');
  const storedRange = certainty === 'range' ? boundedProposalRange(mapped.displayValue) : null;
  const rangeNumber = (value) => Number(value && typeof value === 'object' ? value.amount : value);
  const range = storedRange
    ? { min: rangeNumber(storedRange.min), max: rangeNumber(storedRange.max) }
    : null;
  Object.keys(nextProfile.fieldMetadata || {})
    .filter((path) => path === metadataPath || path.startsWith(`${metadataPath}/`))
    .forEach((path) => {
      nextProfile.fieldMetadata[path] = {
        ...nextProfile.fieldMetadata[path],
        source: 'user_statement',
        confidence: certainty === 'exact' ? 'high' : certainty === 'unknown' ? 'low' : 'medium',
        certainty,
        confirmedByUser: false,
        ...(range ? { range } : {})
      };
    });
  if (!['unknown', 'range'].includes(certainty)) {
    clearCompletionFactMarker(nextProfile, fact.factId, mapped.fieldPath);
  }
  return normalizeHouseholdProfile(nextProfile);
}

function realtimeFactDependencyRank(fact) {
  const factId = String(fact?.factId || '');
  if (factId === 'primary_goal' || factId === 'self_description') return 0;

  const definition = getSemanticFactDefinition(factId);
  if (definition?.profilePathTemplate?.startsWith('/assumptions/values/persona/')) return 10;
  if (factId === 'partner_person') return 20;

  // Collection/root entity proposals establish stable identities and owners.
  // They must be projected before any scalar proposal that selects or updates
  // one of those records, regardless of the model's submitted array order.
  if (definition?.valueType === 'entity') return 30;

  // Reconciliation reads both the generic asset and specialist collection, so
  // it is the final dependency layer rather than an ordinary scalar/choice.
  if (factId === 'specialist_asset_reconciliation') return 50;
  return 40;
}

function orderRealtimeFactsByDependency(facts) {
  return [...facts].sort((left, right) => {
    const rankDifference = realtimeFactDependencyRank(left) - realtimeFactDependencyRank(right);
    if (rankDifference !== 0) return rankDifference;
    const leftId = String(left?.factId || '');
    const rightId = String(right?.factId || '');
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

function parseTokenCount(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function realtimeUsageFromResponse(response = {}) {
  const usage = response.usage || {};
  if (!usage || typeof usage !== 'object'
    || !Number.isSafeInteger(usage.input_tokens)
    || usage.input_tokens < 0
    || !Number.isSafeInteger(usage.output_tokens)
    || usage.output_tokens < 0) {
    return null;
  }
  const input = usage.input_token_details || usage.input_tokens_details || {};
  const output = usage.output_token_details || usage.output_tokens_details || {};
  const cached = input.cached_tokens_details || {};
  const cachedText = parseTokenCount(cached.text_tokens);
  const cachedAudio = parseTokenCount(cached.audio_tokens);
  const cachedTotal = parseTokenCount(input.cached_tokens);
  const unclassifiedCached = Math.max(0, cachedTotal - cachedText - cachedAudio);
  const textInput = parseTokenCount(input.text_tokens);
  const audioInput = parseTokenCount(input.audio_tokens);
  const uncachedTotal = Math.max(0, usage.input_tokens - cachedTotal);
  const unclassifiedInput = Math.max(0, uncachedTotal - textInput - audioInput);
  const textOutput = parseTokenCount(output.text_tokens);
  const audioOutput = parseTokenCount(output.audio_tokens);
  const unclassifiedOutput = Math.max(0, usage.output_tokens - textOutput - audioOutput);
  return {
    inputTextTokens: textInput,
    inputAudioTokens: audioInput + unclassifiedInput,
    cachedTextTokens: cachedText,
    cachedAudioTokens: cachedAudio + unclassifiedCached,
    outputTextTokens: textOutput,
    outputAudioTokens: audioOutput + unclassifiedOutput
  };
}

export function realtimeTranscriptionUsageFromEvent(event = {}) {
  const usage = event.usage;
  if (!usage || typeof usage !== 'object'
    || !Number.isSafeInteger(usage.input_tokens)
    || usage.input_tokens < 0
    || !Number.isSafeInteger(usage.output_tokens)
    || usage.output_tokens < 0) {
    return null;
  }
  return {
    inputTextTokens: 0,
    inputAudioTokens: 0,
    cachedTextTokens: 0,
    cachedAudioTokens: 0,
    outputTextTokens: 0,
    outputAudioTokens: 0,
    transcriptionInputTokens: usage.input_tokens,
    transcriptionOutputTokens: usage.output_tokens
  };
}

export function complexJourney(profile, state = {}) {
  const values = profile?.assumptions?.values || {};
  const persona = values.persona || {};
  const contradictions = (
    Array.isArray(values.unresolvedContradictions) && values.unresolvedContradictions.length > 0
  ) || (
    Array.isArray(persona.unresolvedContradictions) && persona.unresolvedContradictions.length > 0
  );
  const multipleGoals = Array.isArray(profile?.goals) && profile.goals.length > 1;
  const complexBusiness = (profile?.businesses?.length || 0) > 0
    || ['company_director', 'owner_manager', 'business_owner', 'farmer'].includes(persona.businessContext)
    || ['company_director', 'owner_manager', 'business_owner'].includes(persona.employmentContext)
    || persona.companyDirector === true
    || persona.ownerManager === true
    || persona.businessExit === true
    || persona.agriculturalAssets === true;
  const complexHousehold = Boolean(profile?.partner)
    || (profile?.dependants?.length || 0) > 1
    || (profile?.properties?.length || 0) > 1
    || (profile?.incomeSources?.length || 0) > 2;
  return {
    requested: contradictions || multipleGoals || complexBusiness || complexHousehold,
    applied: contradictions || multipleGoals || complexBusiness || complexHousehold,
    reason: contradictions
      ? 'contradictory_facts'
      : multipleGoals
        ? 'multiple_goals'
        : complexBusiness
          ? 'complex_business'
          : complexHousehold
            ? 'complex_household'
            : 'not_required',
    stage: state.stage
  };
}

async function readInternalJson(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_INTERNAL_BODY_BYTES) throw new Error('internal_body_too_large');
  const text = await request.text();
  if (!text || new TextEncoder().encode(text).byteLength > MAX_INTERNAL_BODY_BYTES) {
    throw new Error('internal_body_invalid');
  }
  return JSON.parse(text);
}

export class ConsumerRealtimeSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.webSocket = null;
    this.meta = null;
    this.closing = false;
    this.inResponse = false;
    this.finalizedEvidenceItems = new Set();
    this.currentPhase = null;
    this.lastTouchAt = 0;
    this.turnFinalAt = 0;
    this.bargeInStartedAt = 0;
    this.firstOutputRecorded = false;
    this.eventChain = Promise.resolve();
    this.pendingResponseAuthorization = null;
    this.currentAuthorizedResponseId = null;
    this.currentResponseReason = null;
    this.currentResponseToolCalls = 0;
    this.toolContinuationPending = false;
    this.toolRejectionRetryArmed = false;
    this.lastAuthorizedSpeech = null;
    this.interruptedSpeechCandidate = null;
    this.lastResumedSpeechText = null;
    this.lastFinalizedTurnAt = 0;
    this.cancelledTurnReason = null;
    // The opaque provider item id of the most recently finalized consumer
    // turn. gpt-realtime cannot reliably echo an exact opaque id back as a
    // tool argument, so the server — not the model — binds proposed facts to
    // this authoritative evidence. Persisted so it survives Durable Object
    // eviction between the transcription and the tool call.
    this.latestFinalizedEvidenceItemId = null;
    this.pendingSessionPolicyHash = null;
    this.pendingSessionPolicySnapshot = null;
    this.currentSessionPolicyHash = null;
    this.queuedResponseAuthorization = null;
    this.initialProbePending = false;
    this.committedAudioItemIds = new Set();
    this.serverFunctionOutputs = new Map();
    this.activeToolCallCount = 0;
    this.pendingTerminalization = null;
    this.silencePromptIssuedForIdleExpiresAt = null;
    this.latestMeetingBrief = null;
    this.plannerCatchupSourceTurnId = null;
    this.currentAssistantTranscript = '';
    this.state.blockConcurrencyWhile(async () => {
      this.meta = await this.state.storage.get('lease') || null;
      this.currentPhase = await this.state.storage.get('phase') || null;
      this.pendingResponseAuthorization = await this.state.storage.get('pendingResponseAuthorization') || null;
      this.currentAuthorizedResponseId = await this.state.storage.get('currentAuthorizedResponseId') || null;
      this.pendingSessionPolicyHash = await this.state.storage.get('pendingSessionPolicyHash') || null;
      this.pendingSessionPolicySnapshot = await this.state.storage.get('pendingSessionPolicySnapshot') || null;
      this.currentSessionPolicyHash = await this.state.storage.get('currentSessionPolicyHash') || null;
      this.pendingTerminalization = await this.state.storage.get('pendingTerminalization') || null;
      this.queuedResponseAuthorization = await this.state.storage.get('queuedResponseAuthorization') || null;
      this.latestFinalizedEvidenceItemId = await this.state.storage.get('latestFinalizedEvidenceItemId') || null;
      this.latestMeetingBrief = await this.state.storage.get('latestMeetingBrief') || null;
      this.plannerCatchupSourceTurnId = await this.state.storage.get('plannerCatchupSourceTurnId') || null;
      if (this.latestFinalizedEvidenceItemId) {
        this.finalizedEvidenceItems.add(this.latestFinalizedEvidenceItemId);
      }
    });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/activate' && request.method === 'POST') {
        const body = await readInternalJson(request);
        await this.activate(body);
        return json({ ok: true, leaseId: this.meta.leaseId });
      }
      if (path === '/lease' && request.method === 'GET') {
        if (!this.meta) return json({ ok: false, code: 'realtime_lease_unavailable' }, 404);
        const row = await getRealtimeLease(this.env, this.meta.sessionId, this.meta.leaseId);
        return row ? json({ ok: true, status: row.status }) : json({ ok: false }, 404);
      }
      if (path === '/close' && request.method === 'POST') {
        const body = await readInternalJson(request);
        const closed = await this.terminalize(
          body.status || 'complete',
          body.reason || 'consumer_closed',
          body.errorCode || null,
          body.usageKnown === true
        );
        return json({ ok: true, providerHangupConfirmed: closed?.providerHangupConfirmed === true });
      }
      if (path === '/analysis-plan' && request.method === 'POST') {
        const body = await readInternalJson(request);
        const update = await this.setAnalysisPhase(body);
        return json({
          ok: true,
          phase: this.currentPhase,
          ...(update?.assistantSpeech ? { assistantSpeech: update.assistantSpeech } : {})
        });
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      return json({
        ok: false,
        code: error instanceof ConsumerError ? error.code : 'realtime_durable_object_failed'
      }, error instanceof ConsumerError ? error.status : 503);
    }
  }

  async activate(body) {
    if (!body || typeof body !== 'object') throw new Error('activation_invalid');
    const sessionId = String(body.sessionId || '');
    const leaseId = String(body.leaseId || '');
    const costEntryId = String(body.costEntryId || '');
    if (!/^cs_[A-Za-z0-9_-]{20,80}$/.test(sessionId)
      || !/^rt_[A-Za-z0-9_-]{20,80}$/.test(leaseId)
      || !/^cost_[A-Za-z0-9_-]{20,80}$/.test(costEntryId)) {
      throw new Error('activation_invalid');
    }
    const lease = await getRealtimeLease(this.env, sessionId, leaseId);
    if (!lease || lease.status !== 'active' || lease.provider_cost_id !== costEntryId) {
      throw new ConsumerError(409, 'realtime_lease_conflict', 'The live voice lease is not active.');
    }
    const providerCallId = await getRealtimeProviderCallId(this.env, sessionId, leaseId);
    if (!providerCallId) throw new Error('provider_call_missing');
    this.meta = {
      sessionId,
      leaseId,
      costEntryId,
      hardExpiresAt: lease.hard_expires_at,
      idleExpiresAt: lease.idle_expires_at
    };
    await this.state.storage.put('lease', this.meta);
    await this.connectSideband(providerCallId);
    await this.scheduleAlarm();
    await appendRealtimeEvent(this.env, {
      sessionId,
      leaseId,
      direction: 'server',
      eventType: 'realtime.call.activated',
      payload: {
        model: lease.model,
        promptVersion: lease.prompt_version,
        toolsetVersion: lease.toolset_version
      }
    });
    // The call was created moments ago with the Worker-owned session policy.
    // Do not send a redundant full session.update here: OpenAI returns the
    // effective session (including provider-normalized defaults), and waiting
    // for a byte-equivalent echo can deadlock the first server-authorized tool
    // call. Dynamic journey changes still use refreshJourneyState() and its
    // normalized policy acknowledgement below.
    const context = await this.planningContext();
    this.currentPhase = context.state.realtimePhase;
    this.initialProbePending = false;
    const initialSession = buildRealtimeSessionConfig(
      context.config,
      describeConversationState(context.profile, context.config)
    );
    this.currentSessionPolicyHash = await hmacSha256Base64Url(
      this.env.CONSUMER_RATE_LIMIT_HASH_KEY,
      `consumer/realtime/session-policy/v1/${stableStringify(realtimeSessionPolicySnapshot(initialSession))}`
    );
    await this.state.storage.put({
      phase: this.currentPhase,
      currentSessionPolicyHash: this.currentSessionPolicyHash
    });
    if (context.config.realtimeConversationV2Enabled) {
      const brief = await composeMeetingBrief({
        env: this.env,
        context,
        extraction: null,
        sourceTurnId: 'initial'
      });
      await saveRealtimeMeetingBrief(this.env, {
        sessionId,
        leaseId,
        sourceTurnId: 'initial',
        profileRevision: brief.profileRevision,
        plannerPromptVersion: context.config.realtimePlannerPromptVersion,
        brief
      });
      this.latestMeetingBrief = brief;
      this.initialProbePending = true;
      await this.state.storage.put({ latestMeetingBrief: brief });
      await this.refreshJourneyState();
    } else {
      await this.authorizeResponse('initial_state_probe', { forceTool: 'get_planning_state' });
    }
  }

  async connectSideband(providerCallId) {
    const key = typeof this.env.OPENAI_API_KEY === 'string' ? this.env.OPENAI_API_KEY.trim() : '';
    if (!key) throw new Error('provider_key_missing');
    let response;
    try {
      const url = `${SIDE_BAND_URL}?call_id=${encodeURIComponent(providerCallId)}`;
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${key}`,
          Upgrade: 'websocket'
        }
      });
    } catch (_error) {
      throw new ConsumerError(502, 'realtime_sideband_unavailable', 'The live planning controls could not connect.');
    }
    const socket = response.webSocket;
    if (response.status !== 101 || !socket) {
      response.body?.cancel().catch(() => {});
      throw new ConsumerError(502, 'realtime_sideband_unavailable', 'The live planning controls could not connect.');
    }
    socket.accept();
    this.webSocket = socket;
    socket.addEventListener('message', (event) => {
      this.eventChain = this.eventChain
        .then(() => this.handleProviderMessage(event.data))
        .catch(() => this.terminalize('failed', 'provider_event_processing_failed', 'realtime_provider_event_failed', false));
      this.state.waitUntil(this.eventChain);
    });
    socket.addEventListener('close', () => {
      if (!this.closing) this.state.waitUntil(this.terminalize('failed', 'sideband_lost', 'realtime_sideband_lost', false));
    });
    socket.addEventListener('error', () => {
      if (!this.closing) this.state.waitUntil(this.terminalize('failed', 'sideband_error', 'realtime_sideband_error', false));
    });
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'realtime.provider.connected',
      payload: {}
    });
  }

  sendProvider(event) {
    if (!this.webSocket || this.webSocket.readyState !== 1) {
      throw new ConsumerError(503, 'realtime_sideband_unavailable', 'The live planning controls are disconnected.');
    }
    const text = JSON.stringify(event);
    if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_EVENT_BYTES) {
      throw new Error('provider_event_too_large');
    }
    this.webSocket.send(text);
  }

  async handleProviderMessage(data) {
    if (this.closing || typeof data !== 'string'
      || new TextEncoder().encode(data).byteLength > MAX_PROVIDER_EVENT_BYTES) {
      if (!this.closing) await this.terminalize('failed', 'provider_event_invalid', 'realtime_provider_event_invalid', false);
      return;
    }
    let event;
    try {
      event = JSON.parse(data);
    } catch (_error) {
      await this.terminalize('failed', 'provider_event_invalid', 'realtime_provider_event_invalid', false);
      return;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'input_audio_buffer.committed') {
      const itemId = String(event.item_id || '');
      if (!validProviderId(itemId)) {
        await this.terminalize('failed', 'audio_commit_item_invalid', 'realtime_audio_commit_item_invalid', false);
        return;
      }
      this.committedAudioItemIds.add(itemId);
      this.turnFinalAt = Date.now();
      this.firstOutputRecorded = false;
      await this.touch();
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const itemId = String(event.item_id || event.item?.id || '');
      if (!validProviderId(itemId) || !this.committedAudioItemIds.has(itemId)) {
        await this.terminalize('failed', 'transcription_item_invalid', 'realtime_transcription_item_invalid', false);
        return;
      }
      const transcript = typeof event.transcript === 'string' ? event.transcript.trim() : '';
      const tokens = realtimeTranscriptionUsageFromEvent(event);
      if (!tokens) {
        await this.terminalize('failed', 'transcription_usage_missing', 'realtime_transcription_usage_missing', false);
        return;
      }
      const config = getConsumerConfig(this.env);
      const lease = await getRealtimeLease(this.env, this.meta.sessionId, this.meta.leaseId);
      if (lease?.pricing_version !== config.realtimePricingVersion) {
        await this.terminalize('failed', 'pricing_version_mismatch', 'realtime_pricing_version_mismatch', false);
        return;
      }
      this.committedAudioItemIds.delete(itemId);
      const usage = await recordRealtimeUsage(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        // The finalized item id is stable across sideband envelope replays;
        // event ids are not and would double-charge the same transcription.
        providerResponseId: itemId,
        usageKind: 'transcription',
        tokens,
        rates: config.realtimeUsageRates,
        pricingVersion: config.realtimePricingVersion
      });
      if (usage.estimatedCostMicroEur >= Number(lease?.dispatch_stop_eur_micros || 0)) {
        await this.terminalize('budget_exhausted', 'dispatch_stop_reached', null, !this.inResponse);
        return;
      }
      if (!transcript) {
        await appendRealtimeEvent(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          providerEventId: event.event_id,
          direction: 'provider_in',
          eventType: 'realtime.provider.error',
          payload: {
            code: 'empty_transcript',
            param: 'item_id',
            recoverable: true,
            scope: 'item'
          }
        }).catch(() => {});
        // The interruption carried no words. Recovering the consumer's lost
        // answer outranks re-speaking a cancelled line.
        if (this.cancelledTurnReason) {
          const reason = this.cancelledTurnReason;
          this.cancelledTurnReason = null;
          this.interruptedSpeechCandidate = null;
          await this.queueResponseAuthorization(reason);
          await this.drainResponseAuthorization();
        } else {
          await this.resumeInterruptedSpeech(lease);
        }
        await this.touch();
        return;
      }
      // A real utterance means the interruption was intentional; the
      // conversation moves on rather than replaying the cancelled line, and
      // the new turn supersedes any turn the barge-in cancelled.
      this.interruptedSpeechCandidate = null;
      this.cancelledTurnReason = null;
      this.lastFinalizedTurnAt = Date.now();
      this.finalizedEvidenceItems.add(itemId);
      this.latestFinalizedEvidenceItemId = itemId;
      await this.state.storage.put('latestFinalizedEvidenceItemId', itemId).catch(() => {});
      await recordRealtimeFinalTurn(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        providerItemId: itemId,
        role: 'user',
        transcript
      });
      // A fresh consumer answer starts a fresh correction budget.
      this.toolRejectionRetryArmed = false;
      await this.touch();
      if (config.realtimeConversationV2Enabled) {
        await this.processPlannerTurn({ itemId, transcript });
      }
      await this.authorizeResponse('finalized_user_item');
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.failed') {
      const itemId = String(event.item_id || '');
      if (!validProviderId(itemId)) {
        await this.terminalize('failed', 'transcription_item_invalid', 'realtime_transcription_item_invalid', false);
        return;
      }
      this.committedAudioItemIds.delete(itemId);
      if (this.committedAudioItemIds.size === 0) {
        this.turnFinalAt = 0;
        this.firstOutputRecorded = false;
      }
      const code = cleanProviderCode(event.error?.code || event.error?.type || 'transcription_failed');
      const param = cleanProviderParam(event.error?.param) || 'item_id';
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        providerEventId: event.event_id,
        direction: 'provider_in',
        eventType: 'realtime.provider.error',
        payload: { code, param, recoverable: true, scope: 'item' }
      }).catch(() => {});
      if (this.cancelledTurnReason) {
        const reason = this.cancelledTurnReason;
        this.cancelledTurnReason = null;
        this.interruptedSpeechCandidate = null;
        await this.queueResponseAuthorization(reason);
        await this.drainResponseAuthorization();
      } else {
        await this.resumeInterruptedSpeech();
      }
      await this.touch();
      return;
    }
    if (type === 'conversation.item.created' || type === 'conversation.item.added') {
      const item = event.item || {};
      if (item.type === 'function_call_output') {
        const providerItemId = String(item.id || '');
        const providerToolCallId = String(item.call_id || '');
        const expected = this.serverFunctionOutputs.get(providerToolCallId);
        if (!expected
          || !validProviderId(providerItemId)
          || !constantTimeTextEqual(expected.callId, item.call_id)
          || (expected.itemId && !constantTimeTextEqual(expected.itemId, providerItemId))
          || !constantTimeTextEqual(expected.output, item.output)) {
          await this.terminalize('failed', 'conversation_item_injected', 'realtime_conversation_item_injected', false);
          return;
        }
        // OpenAI owns this optional item identifier. Bind the first echoed ID
        // to the Worker-authorized call so duplicate provider envelopes remain
        // idempotent while a mismatched replay still fails closed.
        expected.itemId ||= providerItemId;
        return;
      }
      if (item.role === 'user') {
        if (!isAudioOnlyUserItem(item)) {
          await this.terminalize('failed', 'conversation_item_injected', 'realtime_conversation_item_injected', false);
          return;
        }
        await this.touch();
        return;
      }
      // GPT-Realtime intermittently adds an assistant message item alongside
      // the mandated function call even under tool_choice "required". That
      // text is never played or rendered (all consumer-facing speech is
      // Worker-owned), so tolerate it inside an authorized response instead of
      // ending the meeting. response.done still requires the tool call.
      const toleratedAssistantMessage = this.inResponse
        && item.type === 'message'
        && item.role === 'assistant';
      const responseOwned = (this.inResponse && item.type === 'function_call')
        || toleratedAssistantMessage;
      if (!responseOwned) {
        await this.terminalize('failed', 'conversation_item_injected', 'realtime_conversation_item_injected', false);
        return;
      }
      if (toleratedAssistantMessage) {
        await appendRealtimeEvent(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          providerEventId: event.event_id,
          direction: 'provider_in',
          eventType: 'realtime.provider.error',
          payload: {
            code: 'assistant_message_tolerated',
            param: 'item',
            recoverable: true,
            scope: 'item'
          }
        }).catch(() => {});
      }
      return;
    }
    if (['conversation.item.deleted', 'conversation.item.truncated', 'conversation.item.retrieved'].includes(type)) {
      // conversation.item.truncated is the provider's normal signal that an
      // assistant audio item was cut short by a barge-in. The conversational
      // v2 flow has the model produce that audio, so interruption is expected
      // and must not tear the meeting down. v1 never produces provider audio,
      // so any item mutation there stays fail-closed, as do genuine deletions
      // or retrievals the Worker never requests.
      const conversationConfig = getConsumerConfig(this.env);
      if (type === 'conversation.item.truncated' && conversationConfig.realtimeConversationV2Enabled) {
        await appendRealtimeEvent(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          providerEventId: event.event_id,
          direction: 'provider_in',
          eventType: 'realtime.provider.error',
          payload: { code: 'assistant_item_truncated', param: 'item', recoverable: true, scope: 'item' }
        }).catch(() => {});
        await this.touch();
        return;
      }
      console.warn('Realtime conversation history mutated', {
        type,
        v2: conversationConfig.realtimeConversationV2Enabled === true
      });
      await this.terminalize('failed', 'conversation_history_mutated', 'realtime_conversation_history_mutated', false);
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.delta') {
      // Partial transcripts are intentionally neither stored nor trusted.
      await this.touch();
      return;
    }
    // v1 keeps model AUDIO fail-closed. Conversational v2 accepts audio only
    // inside a server-authorized response; transcript events remain bounded
    // and an audio failure can fall back to controlled streaming TTS.
    if (/^response\.(?:output_audio|output_audio_transcript|audio|audio_transcript)(?:\.|$)/.test(type)) {
      const config = getConsumerConfig(this.env);
      if (config.realtimeConversationV2Enabled
        && this.inResponse
        && this.currentAuthorizedResponseId) {
        if (['response.output_audio_transcript.delta', 'response.audio_transcript.delta'].includes(type)) {
          const delta = typeof event.delta === 'string' ? event.delta : '';
          this.currentAssistantTranscript = `${this.currentAssistantTranscript}${delta}`.slice(0, 2_400);
        }
        if (!this.firstOutputRecorded) {
          this.firstOutputRecorded = true;
          await appendRealtimeEvent(this.env, {
            sessionId: this.meta.sessionId,
            leaseId: this.meta.leaseId,
            direction: 'server',
            eventType: 'realtime.response.first_output',
            payload: { latencyMs: Math.max(0, Date.now() - this.turnFinalAt) }
          }).catch(() => {});
        }
        if (['response.output_audio_transcript.done', 'response.audio_transcript.done'].includes(type)) {
          const transcript = typeof event.transcript === 'string' ? event.transcript.trim() : '';
          const itemId = String(event.item_id || `${this.currentAuthorizedResponseId}_assistant`);
          if (transcript && validProviderId(itemId)) {
            this.currentAssistantTranscript = transcript.slice(0, 2_400);
            await recordRealtimeFinalTurn(this.env, {
              sessionId: this.meta.sessionId,
              leaseId: this.meta.leaseId,
              providerItemId: itemId,
              role: 'assistant',
              transcript
            }).catch(() => {});
          }
        }
        if (['response.output_audio.failed', 'response.audio.failed'].includes(type)) {
          const context = await this.planningContext();
          const fallbackText = this.currentAssistantTranscript.trim()
            || 'I hit an audio problem, but I’m still with you. Please use the visible review or continue by typing while live voice recovers.';
          await issueRealtimeSpeechAuthorization({
            env: this.env,
            sessionId: this.meta.sessionId,
            leaseId: this.meta.leaseId,
            kind: 'status',
            profileRevision: Number(context.sessionRow.current_profile_revision),
            text: fallbackText
          }).catch(() => {});
        }
        await this.touch();
        return;
      }
      try { this.sendProvider({ type: 'response.cancel', response_id: this.currentAuthorizedResponseId || undefined }); } catch (_error) { /* terminal path owns loss */ }
      await this.terminalize('failed', 'assistant_output_unauthorized', 'realtime_assistant_output_unauthorized', false);
      return;
    }
    if (type === 'input_audio_buffer.speech_started') {
      // Semantic VAD interrupts on any sound — including coughs and background
      // noise. Remember the line that was (or was about to be) spoken so a
      // false interruption (an utterance that transcribes to nothing) can be
      // re-spoken — but only a line the consumer plausibly has not heard yet:
      // it must be fresher than their last real answer and recent. A stale
      // greeting must never resurrect mid-conversation.
      const speech = this.lastAuthorizedSpeech;
      this.interruptedSpeechCandidate = speech
        && speech.authorizedAt > (this.lastFinalizedTurnAt || 0)
        && Date.now() - speech.authorizedAt < 60_000
        ? speech
        : null;
      try {
        await cancelPendingRealtimeControlMessages(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          errorCode: 'consumer_barge_in'
        });
      } catch (_error) {
        await this.terminalize('failed', 'control_cancel_failed', 'realtime_control_cancel_failed', false);
        return;
      }
      this.bargeInStartedAt = this.inResponse ? Date.now() : 0;
      this.silencePromptIssuedForIdleExpiresAt = null;
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'provider_in',
        eventType: 'realtime.vad.speech_started',
        payload: { duringResponse: this.inResponse === true }
      }).catch(() => {});
      await this.touch();
      return;
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'provider_in',
        eventType: 'realtime.vad.speech_stopped',
        payload: {}
      }).catch(() => {});
      await this.touch();
      return;
    }
    if (type === 'response.created') {
      const responseId = String(event.response?.id || '');
      const metadata = event.response?.metadata || {};
      const pending = this.pendingResponseAuthorization;
      if (!pending
        || !validProviderId(responseId)
        || metadata.authorization !== 'planeir_server'
        || !constantTimeTextEqual(metadata.authorization_nonce, pending.nonce)
        || !constantTimeTextEqual(metadata.reason, pending.reason)) {
        if (validProviderId(responseId)) {
          try { this.sendProvider({ type: 'response.cancel', response_id: responseId }); } catch (_error) { /* terminal path owns loss */ }
        }
        await this.terminalize('failed', 'unsolicited_response', 'realtime_unsolicited_response', false);
        return;
      }
      this.pendingResponseAuthorization = null;
      this.currentAuthorizedResponseId = responseId;
      this.currentResponseReason = pending.reason;
      this.currentResponseToolCalls = 0;
      this.currentAssistantTranscript = '';
      this.inResponse = true;
      await this.state.storage.delete('pendingResponseAuthorization');
      await this.state.storage.put('currentAuthorizedResponseId', responseId);
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'provider_in',
        eventType: 'realtime.response.started',
        payload: {}
      });
      return;
    }
    if (type === 'response.done') {
      const responseId = String(event.response?.id || '');
      if (!this.currentAuthorizedResponseId || responseId !== this.currentAuthorizedResponseId) {
        await this.terminalize('failed', 'response_id_mismatch', 'realtime_response_id_mismatch', false);
        return;
      }
      const interruptionStartedAt = this.bargeInStartedAt;
      const wasInterrupted = interruptionStartedAt > 0 && this.inResponse;
      this.inResponse = false;
      this.currentAuthorizedResponseId = null;
      await this.state.storage.delete('currentAuthorizedResponseId');
      if (wasInterrupted) {
        await appendRealtimeEvent(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          direction: 'provider_in',
          eventType: 'realtime.response.interrupted',
          payload: { latencyMs: Math.max(0, Date.now() - interruptionStartedAt) }
        });
      }
      this.bargeInStartedAt = 0;
      // A response that a barge-in cancelled before ANY tool ran means the
      // consumer's finalized answer was never processed. Remember why it was
      // authorized: if the interrupting sound transcribes to nothing, the
      // same authorization is replayed so the answer is not silently lost.
      if (String(event.response?.status || '') === 'cancelled'
        && !getConsumerConfig(this.env).realtimeConversationV2Enabled
        && this.currentResponseToolCalls < 1
        && ['finalized_user_item', 'tool_output'].includes(this.currentResponseReason || '')) {
        this.cancelledTurnReason = this.currentResponseReason;
      }
      const responseStatus = String(event.response?.status || '');
      if (!['completed', 'cancelled', 'incomplete'].includes(responseStatus)) {
        await this.terminalize(
          'failed',
          'provider_response_failed',
          cleanProviderCode(event.response?.status_details?.error?.code || responseStatus),
          false
        );
        return;
      }
      const responseOutput = Array.isArray(event.response?.output) ? event.response.output : [];
      const conversationalV2 = getConsumerConfig(this.env).realtimeConversationV2Enabled;
      // Assistant message and provider-internal reasoning items are tolerated
      // (their text is never played or shown). A completed response must still
      // contain the mandated tool call and no other output kinds.
      const toleratedOutputTypes = new Set(['function_call', 'message', 'reasoning']);
      if (!conversationalV2 && responseStatus === 'completed' && (
        this.currentResponseToolCalls < 1
        || responseOutput.some((item) => !toleratedOutputTypes.has(item?.type))
      )) {
        await this.terminalize('failed', 'response_without_required_tool', 'realtime_response_without_required_tool', false);
        return;
      }
      // A token-capped (incomplete) response is recoverable: usage is metered
      // below, and when the truncation swallowed the mandated tool call the
      // same server reason is re-authorized. realtimeMaxResponses bounds the
      // total number of paid attempts.
      const reauthorizeReason = !conversationalV2
        && responseStatus === 'incomplete'
        && this.currentResponseToolCalls < 1
        ? this.currentResponseReason
        : null;
      if (responseStatus === 'incomplete') {
        await appendRealtimeEvent(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          providerEventId: event.event_id,
          direction: 'provider_in',
          eventType: 'realtime.provider.error',
          payload: {
            code: 'response_incomplete',
            param: null,
            recoverable: true,
            scope: 'response'
          }
        }).catch(() => {});
      }
      const continued = await this.handleUsage(event.response || {});
      this.currentResponseReason = null;
      this.currentResponseToolCalls = 0;
      this.toolContinuationPending = false;
      if (continued) {
        if (reauthorizeReason) await this.queueResponseAuthorization(reauthorizeReason);
        await this.drainResponseAuthorization();
      }
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      await this.handleToolCall(event);
      return;
    }
    if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
      await this.handleToolCall({
        response_id: event.response_id,
        call_id: event.item.call_id,
        name: event.item.name,
        arguments: event.item.arguments
      });
      return;
    }
    if (type === 'session.updated') {
      const valid = await this.providerSessionMatchesPolicy(event.session || {});
      if (!valid || !this.pendingSessionPolicyHash) {
        try { this.sendProvider({ type: 'response.cancel' }); } catch (_error) { /* terminal path owns loss */ }
        await this.terminalize('failed', 'session_policy_changed', 'realtime_session_policy_changed', false);
        return;
      }
      this.currentSessionPolicyHash = this.pendingSessionPolicyHash;
      this.pendingSessionPolicyHash = null;
      this.pendingSessionPolicySnapshot = null;
      await this.state.storage.put('currentSessionPolicyHash', this.currentSessionPolicyHash);
      await this.state.storage.delete(['pendingSessionPolicyHash', 'pendingSessionPolicySnapshot']);
      if (this.initialProbePending) {
        this.initialProbePending = false;
        const config = getConsumerConfig(this.env);
        await this.authorizeResponse(
          'initial_state_probe',
          config.realtimeConversationV2Enabled ? {} : { forceTool: 'get_planning_state' }
        );
      }
      await this.drainResponseAuthorization();
      return;
    }
    if (type === 'error') {
      const disposition = classifyRealtimeProviderError(event);
      const { code, param } = disposition;
      const diagnosticCode = param ? cleanProviderCode(`${code}:${param}`) : code;
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        providerEventId: event.event_id,
        direction: 'provider_in',
        eventType: 'realtime.provider.error',
        payload: {
          code,
          param,
          recoverable: disposition.recoverable,
          scope: disposition.scope
        }
      });
      if (disposition.recoverable) {
        if (disposition.scope === 'response' && !this.inResponse && this.pendingResponseAuthorization) {
          this.pendingResponseAuthorization = null;
          await this.state.storage.delete('pendingResponseAuthorization');
        }
        await this.touch();
        return;
      }
      try { this.sendProvider({ type: 'response.cancel' }); } catch (_error) { /* best effort */ }
      await this.terminalize('failed', 'provider_error', diagnosticCode, false);
    }
  }

  async providerSessionMatchesPolicy(session) {
    if (!this.pendingSessionPolicyHash || !this.pendingSessionPolicySnapshot) return false;
    const actualSnapshot = realtimeSessionPolicySnapshot(session);
    const actualSerialized = stableStringify(actualSnapshot);
    const [actualHash, expectedSnapshotHash] = await Promise.all([
      hmacSha256Base64Url(
        this.env.CONSUMER_RATE_LIMIT_HASH_KEY,
        `consumer/realtime/session-policy/v1/${actualSerialized}`
      ),
      hmacSha256Base64Url(
        this.env.CONSUMER_RATE_LIMIT_HASH_KEY,
        `consumer/realtime/session-policy/v1/${stableStringify(this.pendingSessionPolicySnapshot)}`
      )
    ]);
    const matches = constantTimeTextEqual(this.pendingSessionPolicyHash, actualHash)
      && constantTimeTextEqual(this.pendingSessionPolicyHash, expectedSnapshotHash)
      && constantTimeTextEqual(
        stableStringify(this.pendingSessionPolicySnapshot),
        actualSerialized
      );
    if (!matches) {
      try {
        console.warn('Realtime session policy mismatch', {
          differences: diffPolicySnapshot(this.pendingSessionPolicySnapshot, actualSnapshot)
        });
      } catch (_error) { /* diagnostics are best effort */ }
    }
    return matches;
  }

  responseAuthorizationPriority(reason) {
    if (reason === 'finalized_user_item') return 5;
    if (reason === 'tool_output') return 4;
    if (reason === 'initial_state_probe') return 3;
    return 1;
  }

  async queueResponseAuthorization(reason, options = {}) {
    if (this.closing) return false;
    const candidate = {
      reason: String(reason || 'server_authorized').slice(0, 80),
      options: { ...(options || {}) }
    };
    const current = this.queuedResponseAuthorization;
    if (!current || this.responseAuthorizationPriority(candidate.reason) >= this.responseAuthorizationPriority(current.reason)) {
      this.queuedResponseAuthorization = {
        ...candidate,
        options: {
          ...(current?.options || {}),
          ...candidate.options,
          ...((current?.options?.forceTool || candidate.options.forceTool)
            ? { forceTool: candidate.options.forceTool || current.options.forceTool }
            : {})
        }
      };
    } else if (candidate.options.forceTool && !current.options?.forceTool) {
      this.queuedResponseAuthorization = {
        ...current,
        options: { ...(current.options || {}), forceTool: candidate.options.forceTool }
      };
    }
    await this.state.storage.put('queuedResponseAuthorization', this.queuedResponseAuthorization);
    return true;
  }

  async authorizeResponse(reason, options = {}) {
    const queued = await this.queueResponseAuthorization(reason, options);
    if (!queued) return false;
    await this.drainResponseAuthorization();
    return true;
  }

  async drainResponseAuthorization() {
    if (this.closing
      || this.inResponse
      || this.pendingResponseAuthorization
      || this.pendingSessionPolicyHash
      || !this.queuedResponseAuthorization) return false;
    const authorization = this.queuedResponseAuthorization;
    const context = await this.planningContext();
    const lease = await getRealtimeLease(this.env, this.meta.sessionId, this.meta.leaseId);
    if (!lease || lease.status !== 'active') {
      await this.terminalize('failed', 'lease_lost', 'realtime_lease_lost', false);
      return false;
    }
    if (lease.pricing_version !== context.config.realtimePricingVersion) {
      await this.terminalize('failed', 'pricing_version_mismatch', 'realtime_pricing_version_mismatch', false);
      return false;
    }
    if (Number(lease.response_count || 0) >= context.config.realtimeMaxResponses
      || Number(lease.estimated_cost_eur_micros || 0) >= Number(lease.dispatch_stop_eur_micros || 0)) {
      await this.terminalize('budget_exhausted', 'dispatch_stop_reached', null, true);
      return false;
    }
    const authorizationReason = authorization.reason;
    const nonce = randomNonce();
    this.pendingResponseAuthorization = { nonce, reason: authorizationReason };
    await this.state.storage.put('pendingResponseAuthorization', this.pendingResponseAuthorization);
    try {
      const conversationalV2 = context.config.realtimeConversationV2Enabled;
      const forceTool = authorization.options?.forceTool === 'get_planning_state'
        ? 'get_planning_state'
        : null;
      this.sendProvider({
        type: 'response.create',
        response: {
          metadata: {
            authorization: 'planeir_server',
            authorization_nonce: nonce,
            reason: authorizationReason
          },
          ...(conversationalV2
            ? {
                instructions: authorizationReason === 'tool_output'
                  ? 'Continue the same turn naturally using the reviewed tool output. Keep the answer concise, then bridge to the signed brief nextObjective. Do not repeat the previous wording.'
                  : authorizationReason === 'initial_state_probe'
                    ? REALTIME_V2_WELCOME_INSTRUCTIONS
                    : authorizationReason === 'silence_prompt'
                      ? 'Offer one gentle, brief reassurance that there is no rush, and ask whether rephrasing the current objective would help. Do not repeat the previous question verbatim.'
                      : 'Respond naturally to the finalized client turn using the current signed MeetingBriefV1. Answer any client question first, then continue with the next objective. Do not repeat a failed prompt.',
                // The first response is a spoken welcome, not an intake or
                // planner turn. Disallow tools for that response so Marin is
                // guaranteed to speak before the microphone starts sending.
                tool_choice: authorizationReason === 'initial_state_probe' ? 'none' : 'auto'
              }
            : forceTool
            ? {
                instructions: `Call get_planning_state with expectedRevision ${Number(context.sessionRow.current_profile_revision)}. Emit no assistant text or audio.`,
                tool_choice: { type: 'function', name: forceTool }
              }
            : {
                instructions: 'Call exactly one supplied planning tool. Emit no assistant text or audio; Worker-owned speech is delivered separately.',
                tool_choice: 'required'
              })
        }
      });
      this.queuedResponseAuthorization = null;
      await this.state.storage.delete('queuedResponseAuthorization');
      return true;
    } catch (_error) {
      this.pendingResponseAuthorization = null;
      await this.state.storage.delete('pendingResponseAuthorization');
      await this.terminalize('failed', 'sideband_lost', 'realtime_sideband_lost', false);
      return false;
    }
  }

  async handleUsage(response) {
    const providerResponseId = String(response.id || '');
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(providerResponseId)) {
      await this.terminalize('failed', 'usage_missing', 'realtime_usage_missing', false);
      return false;
    }
    const config = getConsumerConfig(this.env);
    const tokens = realtimeUsageFromResponse(response);
    const leaseBefore = await getRealtimeLease(this.env, this.meta.sessionId, this.meta.leaseId);
    if (!tokens || leaseBefore?.pricing_version !== config.realtimePricingVersion) {
      await this.terminalize(
        'failed',
        !tokens ? 'usage_missing' : 'pricing_version_mismatch',
        !tokens ? 'realtime_usage_missing' : 'realtime_pricing_version_mismatch',
        false
      );
      return false;
    }
    const usage = await recordRealtimeUsage(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      providerResponseId,
      tokens,
      rates: config.realtimeUsageRates,
      pricingVersion: config.realtimePricingVersion
    });
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'provider_in',
      eventType: 'realtime.response.completed',
      payload: usage
    });
    const lease = await getRealtimeLease(this.env, this.meta.sessionId, this.meta.leaseId);
    if (usage.estimatedCostMicroEur >= Number(lease?.dispatch_stop_eur_micros || 0)
      || usage.responseCount >= config.realtimeMaxResponses) {
      await this.terminalize('budget_exhausted', 'dispatch_stop_reached', null, true);
      return false;
    }
    await this.touch(true);
    return true;
  }

  async applyPlannerExtraction(extraction) {
    const context = await this.planningContext();
    const mappedPositions = positionCandidatesToRealtimeFacts(extraction.positions);
    const mappedCompletions = extraction.sectionCompletions
      .map(sectionCompletionToRealtimeFact)
      .filter(Boolean);
    const candidates = [
      ...extraction.semanticFacts,
      ...mappedPositions,
      ...mappedCompletions
    ].slice(0, 24);
    const outcomes = (extraction.invalidCandidates || []).map((item) => ({
      candidateId: item.candidateId,
      factId: null,
      accepted: false,
      errorCode: item.errorCode
    }));
    if (candidates.length > 0) {
      const attempt = await beginRealtimeToolAttempt(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        providerToolCallId: `planner_${extraction.sourceTurnId}`.slice(0, 160),
        toolName: 'silent_planner',
        toolVersion: `${context.config.realtimePlannerPromptVersion}:${TOOL_VERSION}`,
        expectedProfileRevision: Number(context.sessionRow.current_profile_revision),
        arguments: {
          schemaVersion: extraction.schemaVersion,
          sourceTurnId: extraction.sourceTurnId,
          candidates: candidates.map((candidate) => ({
            candidateId: candidate.candidateId,
            factId: candidate.factId,
            value: candidate.value,
            certainty: candidate.certainty,
            correctionTarget: candidate.correctionTarget || ''
          }))
        },
        maxToolCalls: context.config.realtimeMaxToolCalls
      });
      if (!attempt.replayed) {
        this.applyingPlannerBatch = true;
        try {
          for (const candidate of candidates) {
            try {
              const current = await this.planningContext();
              const output = await this.executeTool('propose_facts', {
                expectedRevision: Number(current.sessionRow.current_profile_revision),
                facts: [{
                  factId: candidate.factId,
                  value: candidate.value,
                  certainty: candidate.certainty,
                  evidenceItemId: extraction.sourceTurnId
                }]
              }, current, attempt.row.id);
              outcomes.push({
                candidateId: candidate.candidateId,
                factId: candidate.factId,
                accepted: output?.ok === true,
                profileRevision: output?.profileRevision || null
              });
            } catch (error) {
              outcomes.push({
                candidateId: candidate.candidateId,
                factId: candidate.factId,
                accepted: false,
                errorCode: error instanceof ConsumerError ? error.code : 'realtime_planner_candidate_invalid'
              });
            }
          }
        } finally {
          this.applyingPlannerBatch = false;
        }
        await completeRealtimeToolAttempt(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          toolAttemptId: attempt.row.id,
          status: 'succeeded',
          result: {
            ok: true,
            schemaVersion: extraction.schemaVersion,
            sourceTurnId: extraction.sourceTurnId,
            outcomes
          },
          errorCode: null,
          latencyMs: 0
        });
      }
    }
    const refreshed = await this.planningContext();
    const brief = await composeMeetingBrief({
      env: this.env,
      context: refreshed,
      extraction,
      sourceTurnId: extraction.sourceTurnId
    });
    await saveRealtimeMeetingBrief(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      sourceTurnId: extraction.sourceTurnId,
      profileRevision: brief.profileRevision,
      plannerPromptVersion: refreshed.config.realtimePlannerPromptVersion,
      brief
    });
    this.latestMeetingBrief = brief;
    await this.state.storage.put('latestMeetingBrief', brief);
    return { brief, outcomes };
  }

  async recordPlannerUsage(metadata, config) {
    if (!metadata?.providerResponseId) return;
    await recordRealtimeUsage(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      providerResponseId: metadata.providerResponseId,
      usageKind: 'planner',
      tokens: {
        inputTextTokens: Math.max(0, Number(metadata.inputTokens || 0) - Number(metadata.cachedInputTokens || 0)),
        inputAudioTokens: 0,
        cachedTextTokens: Number(metadata.cachedInputTokens || 0),
        cachedAudioTokens: 0,
        outputTextTokens: Number(metadata.outputTokens || 0),
        outputAudioTokens: 0
      },
      rates: config.realtimeUsageRates,
      pricingVersion: config.realtimePricingVersion
    });
  }

  async catchUpPlannerTurn({ itemId, transcript }) {
    try {
      const context = await this.planningContext();
      const recentTurns = await listRealtimeFinalTurns(
        this.env,
        this.meta.sessionId,
        this.meta.leaseId,
        8
      );
      const planned = await extractRealtimePlannerTurn({
        env: this.env,
        config: context.config,
        context,
        sourceTurnId: itemId,
        transcript,
        recentTurns,
        timeoutMs: context.config.realtimePlannerCatchupTimeoutMs
      });
      await this.recordPlannerUsage(planned.metadata, context.config);
      await this.applyPlannerExtraction(planned.extraction);
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'server',
        eventType: 'realtime.planner.catchup_completed',
        payload: { sourceTurnId: itemId, latencyMs: planned.metadata.latencyMs }
      });
      if (!this.inResponse && !this.pendingSessionPolicyHash) {
        await this.refreshJourneyState();
      }
    } catch (error) {
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'server',
        eventType: 'realtime.planner.catchup_failed',
        payload: {
          sourceTurnId: itemId,
          code: error instanceof ConsumerError ? error.code : 'realtime_planner_catchup_failed'
        }
      }).catch(() => {});
    } finally {
      await this.state.storage.delete('plannerCatchupSourceTurnId').catch(() => {});
      if (this.plannerCatchupSourceTurnId === itemId) this.plannerCatchupSourceTurnId = null;
    }
  }

  async processPlannerTurn({ itemId, transcript }) {
    const context = await this.planningContext();
    const recentTurns = await listRealtimeFinalTurns(
      this.env,
      this.meta.sessionId,
      this.meta.leaseId,
      8
    );
    try {
      const planned = await extractRealtimePlannerTurn({
        env: this.env,
        config: context.config,
        context,
        sourceTurnId: itemId,
        transcript,
        recentTurns
      });
      await this.recordPlannerUsage(planned.metadata, context.config);
      const applied = await this.applyPlannerExtraction(planned.extraction);
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'server',
        eventType: 'realtime.planner.completed',
        payload: {
          sourceTurnId: itemId,
          latencyMs: planned.metadata.latencyMs,
          acceptedCandidates: applied.outcomes.filter((item) => item.accepted).length,
          rejectedCandidates: applied.outcomes.filter((item) => !item.accepted).length
        }
      });
      await this.refreshJourneyState();
    } catch (error) {
      const code = error instanceof ConsumerError ? error.code : 'realtime_planner_failed';
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'server',
        eventType: 'realtime.planner.deferred',
        payload: { sourceTurnId: itemId, code }
      }).catch(() => {});
      if (code === 'realtime_planner_timeout' && this.plannerCatchupSourceTurnId !== itemId) {
        this.plannerCatchupSourceTurnId = itemId;
        await this.state.storage.put('plannerCatchupSourceTurnId', itemId);
        this.state.waitUntil(this.catchUpPlannerTurn({ itemId, transcript }));
      }
    }
  }

  async planningContext() {
    const config = getConsumerConfig(this.env);
    if (!config.realtimeEnabled) throw new ConsumerError(503, 'realtime_unavailable', 'Live voice is not available.');
    const [sessionRow, consent] = await Promise.all([
      getSessionRow(this.env, this.meta.sessionId),
      getRealtimeConsent(this.env, this.meta.sessionId)
    ]);
    if (!sessionRow || sessionRow.deleted_at || !realtimeConsentIsCurrent(consent, config)) {
      throw new ConsumerError(403, 'realtime_consent_required', 'Live voice consent is no longer current.');
    }
    const profile = await getCurrentProfile(this.env, sessionRow);
    const state = describeConversationState(profile, config);
    const allDeterministicRecommendations = recommendModules(profile, { text: '' });
    const proposedFacts = await listRealtimeFactProposalSummaries(
      this.env,
      this.meta.sessionId,
      this.meta.leaseId
    );
    const storedMeetingBrief = config.realtimeConversationV2Enabled
      ? await getLatestRealtimeMeetingBrief(this.env, this.meta.sessionId, this.meta.leaseId)
      : null;
    if (storedMeetingBrief?.brief) this.latestMeetingBrief = storedMeetingBrief.brief;
    const pendingFacts = proposedFacts.map((proposal) => ({
      ...proposal,
      readBackText: buildRealtimeFactReadBack(
        proposal.factId,
        proposal.value,
        proposal.certainty,
        profile.preferences?.baseCurrency || 'EUR'
      )
    }));
    const retainedTerminalPhase = ['analysis', 'results'].includes(this.currentPhase)
      ? this.currentPhase
      : null;
    const realtimePhase = pendingFacts.length
      ? 'confirmation'
      : retainedTerminalPhase || realtimeJourneyPhase({ stage: state.stage });
    const reasoningEscalation = complexJourney(profile, state);
    const publicState = {
      profileRevision: Number(sessionRow.current_profile_revision),
      confirmedProfileRevision: sessionRow.confirmed_profile_revision === null
        ? null
        : Number(sessionRow.confirmed_profile_revision),
      stage: state.stage,
      realtimePhase,
      nextQuestion: state.nextQuestion,
      nextApprovedFact: state.nextQuestion?.factId
        ? {
            factId: state.nextQuestion.factId,
            factInstanceId: state.nextQuestion.factInstanceId || null,
            prompt: state.nextQuestion.prompt,
            confirmationPolicy: state.nextQuestion.confirmationPolicy || 'final_review'
          }
        : null,
      facts: [
        ...pendingFacts,
        ...buildConfirmedRealtimeFactSummary(profile)
      ].slice(0, 16),
      currentPendingProposal: pendingFacts[0] || null,
      personaAssessment: toPublicPersonaAssessment(state.personaAssessment),
      moduleSlots: (state.moduleSlots || []).slice(0, 3),
      overrides: (state.overrides || []).slice(0, 6),
      requiresGoalPriorityQuestion: state.requiresGoalPriorityQuestion === true,
      requiresDecisionTopicQuestion: state.requiresDecisionTopicQuestion === true,
      requiresPersonaScan: state.requiresPersonaScan === true,
      deferredGoalTypes: (state.deferredGoalTypes || []).slice(0, 8),
      likelyModules: (state.moduleSlots || [])
        .map((item) => item.moduleId)
        .slice(0, 3),
      recommendations: (state.recommendations || []).slice(0, 12).map((item) => ({
        moduleId: item.moduleId,
        status: item.readiness?.status || item.status || 'unknown',
        requiredMissing: (item.readiness?.requiredMissing || []).slice(0, 20).map((missing) => {
          const semantic = resolveSemanticFact(missing, { profile, moduleId: item.moduleId });
          return {
            factId: semantic.factId,
            factInstanceId: semantic.factInstanceId,
            importance: missing.importance,
            reason: typeof missing.reason === 'string' ? missing.reason.slice(0, 240) : ''
          };
        })
      })),
      deferredOrAdviserTopics: allDeterministicRecommendations
        .filter((item) => (
          getPlanningModuleDefinition(item.moduleId)?.consumerAvailable === false
          || ['adviser_review_required', 'unsupported'].includes(item.readiness?.status || item.status)
        ))
        .slice(0, 8)
        .map((item) => ({
          moduleId: item.moduleId,
          status: item.readiness?.status || item.status,
          reason: Array.isArray(item.rationale) && typeof item.rationale[0] === 'string'
            ? item.rationale[0].slice(0, 240)
            : 'This topic is not available for automated analysis in the current test.'
        })),
      reasoningEscalation,
      conversationVersion: config.realtimeConversationV2Enabled ? 'v2' : 'v1',
      meetingBrief: config.realtimeConversationV2Enabled ? this.latestMeetingBrief : null,
      conversationGuide: config.realtimeConversationV2Enabled
        ? toConversationGuide(this.latestMeetingBrief)
        : null
    };
    return { config, sessionRow, profile, state: publicState };
  }

  async refreshJourneyState(overridePhase = null) {
    if (this.pendingSessionPolicyHash) {
      throw new ConsumerError(409, 'realtime_policy_update_pending', 'The live planning policy update is still being verified.');
    }
    const context = await this.planningContext();
    if (overridePhase) this.currentPhase = overridePhase;
    else this.currentPhase = context.state.realtimePhase;
    await this.state.storage.put('phase', this.currentPhase);
    const state = { ...context.state, realtimePhase: this.currentPhase };
    const safetyIdentifier = await hmacSha256Base64Url(
      this.env.CONSUMER_RATE_LIMIT_HASH_KEY,
      `openai-safety/realtime/v1/${this.meta.sessionId}`
    );
    const expectedSession = buildRealtimeSessionConfig(context.config, state, safetyIdentifier);
    const policySnapshot = realtimeSessionPolicySnapshot(expectedSession);
    const policyHash = await hmacSha256Base64Url(
      this.env.CONSUMER_RATE_LIMIT_HASH_KEY,
      `consumer/realtime/session-policy/v1/${stableStringify(policySnapshot)}`
    );
    if (this.currentSessionPolicyHash
      && constantTimeTextEqual(this.currentSessionPolicyHash, policyHash)) {
      return context;
    }
    this.pendingSessionPolicySnapshot = policySnapshot;
    this.pendingSessionPolicyHash = policyHash;
    await this.state.storage.put({
      pendingSessionPolicySnapshot: policySnapshot,
      pendingSessionPolicyHash: policyHash
    });
    this.sendProvider({
      type: 'session.update',
      session: expectedSession
    });
    if (state.reasoningEscalation.requested) {
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'server',
        eventType: 'realtime.reasoning.escalation',
        payload: {
          requested: 'medium',
          applied: true,
          reason: state.reasoningEscalation.reason
        }
      });
    }
    return context;
  }

  async handleToolCall(event) {
    const responseId = String(event.response_id || '');
    if (!this.inResponse
      || !this.currentAuthorizedResponseId
      || !constantTimeTextEqual(responseId, this.currentAuthorizedResponseId)) {
      await this.terminalize('failed', 'tool_response_unauthorized', 'realtime_tool_response_unauthorized', false);
      return;
    }
    const providerToolCallId = String(event.call_id || event.item_id || '');
    if (!validProviderId(providerToolCallId)) {
      await this.terminalize('failed', 'tool_call_invalid', 'realtime_tool_call_invalid', false);
      return;
    }
    this.activeToolCallCount += 1;
    let args;
    const raw = typeof event.arguments === 'string' ? event.arguments : '';
    if (!raw || new TextEncoder().encode(raw).byteLength > MAX_TOOL_ARGUMENT_BYTES) {
      args = null;
    } else {
      try {
        args = JSON.parse(raw);
        assertBoundedJson(args);
      } catch (_error) {
        args = null;
      }
    }
    const startedAt = Date.now();
    let toolName = 'invalid';
    let attempt = null;
    let output;
    let speechContext = null;
    let status = 'succeeded';
    let errorCode = null;
    let fatalToolError = false;
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new ConsumerError(400, 'realtime_tool_arguments_invalid', 'Live planning tool arguments are invalid.');
      }
      toolName = assertRealtimeToolName(event.name);
      const context = await this.planningContext();
      speechContext = context;
      const allowedNames = new Set(realtimeToolsForState(context.state).map((tool) => tool.name));
      if (!allowedNames.has(toolName)) {
        throw new ConsumerError(409, 'realtime_tool_state_invalid', 'That planning action is not available at the current journey stage.');
      }
      attempt = await beginRealtimeToolAttempt(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        providerToolCallId,
        toolName,
        toolVersion: `${getConsumerConfig(this.env).realtimeToolsetVersion}:${TOOL_VERSION}`,
        expectedProfileRevision: Number.isSafeInteger(args.expectedRevision) ? args.expectedRevision : null,
        arguments: args,
        maxToolCalls: getConsumerConfig(this.env).realtimeMaxToolCalls
      });
      if (attempt.replayed && attempt.result) output = attempt.result;
      else {
        output = await this.executeTool(toolName, args, context, attempt.row.id);
        if (!context.config.realtimeConversationV2Enabled) {
          output = await this.attachWorkerSpeech(toolName, output, context);
        }
      }
    } catch (error) {
      status = error instanceof ConsumerError && error.status < 500 ? 'rejected' : 'failed';
      errorCode = error instanceof ConsumerError ? error.code : 'realtime_tool_failed';
      fatalToolError = ['realtime_tool_replay_conflict', 'realtime_tool_replay_incomplete'].includes(errorCode);
      output = {
        ok: false,
        errorCode,
        message: error instanceof ConsumerError && error.message
          ? String(error.message).slice(0, 300)
          : 'The planning service could not complete that action.',
        ...rejectedToolGuidance(errorCode, speechContext)
      };
    }
    // A genuinely fixable rejection (a mis-mapped value or a stale revision)
    // gets exactly one silent correction pass: the enriched tool output goes
    // back and a follow-up response is authorized. Rejections that re-running
    // the same call cannot fix — a fact the current analyses do not use, a
    // duplicate — must instead speak immediately and keep the conversation
    // moving, never fall into a silent wait.
    const silentRetry = status === 'rejected'
      && RETRYABLE_TOOL_ERROR_CODES.has(errorCode)
      && speechContext?.config?.realtimeConversationV2Enabled !== true
      && !fatalToolError
      && !attempt?.replayed
      && !this.toolRejectionRetryArmed
      && !this.closing;
    if (!attempt?.replayed
      && toolName !== 'invalid'
      && !output?.assistantSpeech
      && !silentRetry
      && speechContext?.config?.realtimeConversationV2Enabled !== true) {
      try {
        output = await this.attachWorkerSpeech(
          toolName,
          output,
          speechContext || await this.planningContext()
        );
      } catch (_error) {
        // If code-owned speech cannot be authorized, return the bounded tool
        // error without allowing any model-owned continuation.
      }
    }
    if (attempt && !attempt.replayed) {
      await completeRealtimeToolAttempt(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        toolAttemptId: attempt.row.id,
        status,
        result: output,
        errorCode,
        latencyMs: Date.now() - startedAt
      }).catch(() => {});
    }
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'realtime.tool.completed',
      payload: { toolName, status, errorCode }
    });
    if (fatalToolError) {
      this.activeToolCallCount = Math.max(0, this.activeToolCallCount - 1);
      await this.terminalize('failed', 'tool_replay_invalid', errorCode, false);
      return;
    }
    if (attempt?.replayed) {
      this.activeToolCallCount = Math.max(0, this.activeToolCallCount - 1);
      return;
    }
    this.activeToolCallCount = Math.max(0, this.activeToolCallCount - 1);
    try {
      const serializedOutput = JSON.stringify(output);
      this.serverFunctionOutputs.set(providerToolCallId, {
        callId: providerToolCallId,
        itemId: null,
        output: serializedOutput
      });
      this.sendProvider({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: providerToolCallId,
          output: serializedOutput
        }
      });
      this.currentResponseToolCalls += 1;
      this.toolContinuationPending = false;
      if (status === 'succeeded') {
        this.toolRejectionRetryArmed = false;
      } else if (silentRetry) {
        this.toolRejectionRetryArmed = true;
        await this.queueResponseAuthorization('tool_output');
      }
      if (speechContext?.config?.realtimeConversationV2Enabled === true
        && toolName !== 'wait_for_user') {
        this.toolContinuationPending = true;
        await this.queueResponseAuthorization('tool_output');
      }
      if (this.turnFinalAt && !this.firstOutputRecorded) {
        this.firstOutputRecorded = true;
        await appendRealtimeEvent(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          direction: 'server',
          eventType: 'realtime.response.first_output',
          payload: { latencyMs: Math.max(0, Date.now() - this.turnFinalAt) }
        });
      }
    } catch (_error) {
      await this.terminalize('failed', 'sideband_lost', 'realtime_sideband_lost', false);
    }
  }

  // A barge-in that produced no words (a cough, a knock, room noise) cancelled
  // a line the consumer never chose to skip. Speak it again once so the
  // meeting does not strand them mid-question.
  async resumeInterruptedSpeech(lease = null) {
    const candidate = this.interruptedSpeechCandidate;
    this.interruptedSpeechCandidate = null;
    if (!candidate?.text || this.closing || candidate.text === this.lastResumedSpeechText) return;
    const profileRevision = Number.isSafeInteger(candidate.profileRevision) && candidate.profileRevision >= 1
      ? candidate.profileRevision
      : Math.max(1, Number(lease?.latest_profile_revision || 1));
    const text = candidate.kind === 'read_back'
      ? candidate.text
      : `As I was saying: ${candidate.text}`;
    try {
      await issueRealtimeSpeechAuthorization({
        env: this.env,
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        kind: candidate.kind || 'status',
        profileRevision,
        text
      });
      this.lastResumedSpeechText = candidate.text;
    } catch (_error) {
      // Best effort — the consumer can always ask Planéir to repeat.
    }
  }

  async attachWorkerSpeech(toolName, output, originalContext) {
    const safeOutput = output && typeof output === 'object' && !Array.isArray(output)
      ? output
      : { ok: false, errorCode: 'realtime_tool_failed' };
    if (toolName === 'wait_for_user' && safeOutput.ok === true) {
      return { ...safeOutput, response_text: '', require_repeat_verbatim: false };
    }
    const context = safeOutput.ok === true
      ? await this.planningContext()
      : originalContext;
    const state = context?.state || {};
    const question = controlledQuestionText(state);
    let kind = 'status';
    let text = '';

    if (safeOutput.ok !== true) {
      kind = 'acknowledgement';
      // Keep the interview moving after a rejection. When the consumer's
      // statement was simply not needed by the current analyses, acknowledge
      // it warmly and steer to the next question rather than apologising; only
      // a genuine capture problem gets a soft apology.
      if (INFORMATION_NOT_NEEDED_ERROR_CODES.has(String(safeOutput.errorCode || ''))) {
        text = question
          ? `Thanks — that's useful to know. ${question}`
          : 'Thanks — that’s useful to know. Let’s keep going.';
      } else {
        text = question
          ? `Sorry — I couldn’t quite record that. ${question}`
          : 'Sorry — I couldn’t quite record that. Could you put it another way for me?';
      }
    } else if (toolName === 'get_result_summary' || (
      toolName === 'confirm_and_run_plan' && typeof safeOutput.speakableText === 'string' && safeOutput.speakableText
    )) {
      kind = 'result';
      text = safeOutput.speakableText;
    } else if (toolName === 'propose_facts') {
      const readBack = safeOutput.currentPendingProposal?.readBackText
        || safeOutput.currentReadBackText
        || '';
      if (safeOutput.readBackRequired && readBack) {
        kind = 'read_back';
        text = readBack;
      } else {
        kind = 'acknowledgement';
        text = question
          ? `Got it — you’ll be able to review that. ${question}`
          : 'Got it. Please review the three analyses on screen.';
      }
    } else if (toolName === 'resolve_fact_confirmation') {
      const nextReadBack = safeOutput.currentPendingProposal?.readBackText || '';
      if (nextReadBack) {
        kind = 'read_back';
        text = nextReadBack;
      } else {
        kind = 'acknowledgement';
        const prefix = safeOutput.status === 'confirmed'
          ? 'That’s confirmed.'
          : 'No problem — I won’t use that figure.';
        text = question
          ? `${prefix} ${question}`
          : `${prefix} Please review the information and three analyses shown on screen.`;
      }
    } else if (toolName === 'get_module_plan') {
      kind = 'plan';
      const modules = controlledModuleList(state.moduleSlots || safeOutput.moduleSlots || []);
      text = modules
        ? `Based on what you told me, the three analyses most relevant to you are ${modules}. ${question || 'Please review them on screen before anything runs.'}`
        : (question || 'I need one more detail before I can show the three most relevant analyses.');
    } else if (toolName === 'get_planning_state') {
      kind = this.currentResponseReason === 'initial_state_probe' ? 'greeting' : 'question';
      const next = question || 'Please review the information and three analyses shown on screen before anything runs.';
      const returning = Number(
        safeOutput.profileRevision
        || context?.sessionRow?.current_profile_revision
        || 1
      ) > 1;
      text = kind !== 'greeting'
        ? next
        : returning
          ? `Welcome back — let’s pick up where we left off. ${next}`
          : 'Hi, I’m Planéir, your AI planning companion. '
            + 'Here’s how our chat works: you talk, I listen and note the key facts — '
            + 'everything appears on screen, and nothing is saved without your say-so. '
            + 'Once I understand your situation, I’ll line up the analyses that fit you best. '
            + 'Interrupt me whenever you like, and ask me to repeat anything you miss. '
            + 'And if I don’t notice you’ve finished speaking, tap the circle — or press the space bar — to send your answer. '
            + 'To start: tell me a bit about yourself and what’s brought you here today.';
    } else if (toolName === 'confirm_and_run_plan') {
      kind = 'status';
      text = 'Your plan is running. I’ll read the verified result when it’s ready.';
    } else {
      kind = 'question';
      text = question || 'Please continue with the visible planning step.';
    }

    // The conversation director rephrases question/acknowledgement/status
    // lines into natural dialogue (acknowledging context, answering repeat
    // and clarify requests) while the deterministic template stays the
    // guaranteed fallback. Greeting, read-back and result copy remain exact.
    const directorConfig = context?.config || getConsumerConfig(this.env);
    if (directorConfig.realtimeDirectorEnabled === true
      && ['question', 'acknowledgement', 'status'].includes(kind)) {
      const recentTurns = await listRealtimeFinalTurns(
        this.env,
        this.meta.sessionId,
        this.meta.leaseId,
        40
      ).catch(() => []);
      const directed = await composeDirectedSpeech({
        env: this.env,
        config: directorConfig,
        kind,
        templateText: text,
        question,
        journeyPhase: realtimeJourneyPhase(state),
        toolName,
        toolOk: safeOutput.ok === true,
        toolErrorCode: safeOutput.errorCode || null,
        recentTurns,
        previousAssistantLine: this.lastAuthorizedSpeech?.text || ''
      });
      if (directed.directed) {
        text = directed.text;
        if (directed.tokens && directed.responseId) {
          await recordRealtimeUsage(this.env, {
            sessionId: this.meta.sessionId,
            leaseId: this.meta.leaseId,
            providerResponseId: directed.responseId,
            tokens: directed.tokens,
            rates: directorConfig.realtimeUsageRates,
            pricingVersion: directorConfig.realtimePricingVersion
          }).catch(() => {});
        }
      }
    }

    const profileRevision = Number(
      safeOutput.profileRevision
      || context?.sessionRow?.current_profile_revision
      || originalContext?.sessionRow?.current_profile_revision
    );
    const assistantSpeech = await issueRealtimeSpeechAuthorization({
      env: this.env,
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      kind,
      profileRevision,
      text
    });
    this.lastAuthorizedSpeech = { kind, text, profileRevision, authorizedAt: Date.now() };
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: kind === 'greeting'
        ? 'realtime.greeting.authorized'
        : 'realtime.speech.authorized',
      payload: { kind, characterCount: text.length }
    }).catch(() => {});
    return {
      ...safeOutput,
      response_text: text,
      require_repeat_verbatim: true,
      assistantSpeech
    };
  }

  requireExpectedRevision(args, context) {
    if (!Number.isSafeInteger(args.expectedRevision)
      || args.expectedRevision !== Number(context.sessionRow.current_profile_revision)) {
      throw new ConsumerError(409, 'profile_revision_conflict', 'The profile changed. Refresh the planning state.');
    }
  }

  requireFinalizedEvidence(itemId) {
    if (typeof itemId !== 'string' || !this.finalizedEvidenceItems.has(itemId)) {
      throw new ConsumerError(409, 'realtime_evidence_not_final', 'Wait for the consumer input item to finish before proposing or confirming facts.');
    }
  }

  // The server-authoritative evidence for the current turn is the most
  // recently finalized consumer item, not whatever opaque id the model echoed
  // back (it cannot reproduce those reliably). Returns null only when no
  // consumer turn has been finalized yet, which still fails closed.
  authoritativeEvidenceItemId() {
    const itemId = this.latestFinalizedEvidenceItemId;
    if (!itemId || !validProviderId(itemId)) return null;
    this.finalizedEvidenceItems.add(itemId);
    return itemId;
  }

  async executeTool(toolName, args, context, toolAttemptId) {
    if (toolName === 'get_meeting_brief') {
      if (!context.config.realtimeConversationV2Enabled || !context.state.meetingBrief) {
        throw new ConsumerError(409, 'realtime_meeting_brief_unavailable', 'The current meeting brief is not available yet.');
      }
      return {
        ok: true,
        meetingBrief: context.state.meetingBrief,
        conversationGuide: context.state.conversationGuide,
        instruction: 'Use this signed brief as steering context. Do not expose its signature or internal fields.'
      };
    }
    if (toolName === 'get_intake_explanation') {
      if (!context.config.realtimeConversationV2Enabled) {
        throw new ConsumerError(409, 'realtime_explanation_unavailable', 'Reviewed meeting explanations are not available in this voice version.');
      }
      const topic = String(args.topic || '').slice(0, 160);
      const clientIntent = context.state.meetingBrief?.clientQuestion?.intent || 'none';
      const boundaryTopic = clientIntent === 'recommendation'
        ? 'recommendation_boundary'
        : clientIntent === 'eligibility'
          ? 'eligibility_boundary'
          : clientIntent === 'regulated_or_time_sensitive'
            ? 'adviser_boundary'
          : topic;
      return {
        ok: true,
        topic: boundaryTopic,
        explanation: intakeExplanation(boundaryTopic, context.state.meetingBrief),
        instruction: 'Answer in one to three sentences, then bridge naturally to nextObjective. Do not add advice, eligibility claims, projections or calculations.'
      };
    }
    if (toolName === 'get_planning_state') {
      // A pure read tolerates a stale expectedRevision: it returns the current
      // server-authoritative state (including the live revision) so the model
      // re-syncs, instead of failing when it echoed a revision that advanced
      // after the last turn saved a fact. This is what makes "repeat that"
      // reliable right after facts were recorded.
      return {
        ok: true,
        ...context.state,
        factValueVocabulary: planningStateValueVocabulary(context.state)
      };
    }
    if (toolName === 'propose_facts') {
      this.requireExpectedRevision(args, context);
      if (!Array.isArray(args.facts) || args.facts.length < 1 || args.facts.length > 8) {
        throw new ConsumerError(400, 'realtime_fact_count_invalid', 'Propose between one and eight explicit facts from the finalized answer.');
      }
      // The model cannot reliably echo the opaque evidence item id, so the
      // server binds every proposed fact to the current finalized turn itself.
      // This still fails closed when no consumer turn has been finalized.
      const authoritativeEvidenceItemId = this.authoritativeEvidenceItemId();
      if (!authoritativeEvidenceItemId) {
        throw new ConsumerError(409, 'realtime_evidence_not_final', 'Wait for the consumer input item to finish before proposing or confirming facts.');
      }
      args.facts = args.facts.map((fact) => (
        fact && typeof fact === 'object' && !Array.isArray(fact)
          ? { ...fact, evidenceItemId: authoritativeEvidenceItemId }
          : fact
      ));
      const seenFactIds = new Set();
      const evidenceItems = new Set();
      args.facts.forEach((fact) => {
        if (!['exact', 'approximate', 'range', 'unknown'].includes(fact?.certainty)) {
          throw new ConsumerError(400, 'realtime_fact_certainty_invalid', 'Fact certainty is invalid.');
        }
        if (['range', 'unknown'].includes(fact.certainty)
          && !['money', 'number'].includes(getSemanticFactDefinition(fact.factId)?.valueType)) {
          throw new ConsumerError(
            400,
            'realtime_fact_certainty_invalid',
            'Only a numerical or monetary fact may be recorded as unknown or as a range.'
          );
        }
      });
      const enabledModules = modulesEnabledByFacts(context.state.recommendations, args.facts, context.profile);
      const orderedFacts = orderRealtimeFactsByDependency(args.facts);
      let projectedProfile = context.profile;
      const normalized = orderedFacts.map((fact) => {
        this.requireFinalizedEvidence(fact.evidenceItemId);
        evidenceItems.add(fact.evidenceItemId);
        if (seenFactIds.has(fact.factId)) {
          throw new ConsumerError(400, 'realtime_fact_duplicate', 'Each semantic fact may be proposed once per answer.');
        }
        seenFactIds.add(fact.factId);
        if (!realtimeFactAllowed(fact.factId, enabledModules)
          && !context.config.realtimeConversationV2Enabled) {
          throw new ConsumerError(409, 'realtime_fact_not_routed', 'That semantic fact is not used by the currently routed canary modules.');
        }
        if (!['exact', 'approximate', 'range', 'unknown'].includes(fact.certainty)) {
          throw new ConsumerError(400, 'realtime_fact_certainty_invalid', 'Fact certainty is invalid.');
        }
        const mapped = mapRealtimeProposalFact(projectedProfile, fact);
        const patch = patchForMappedRealtimeFact(mapped);
        projectedProfile = applyProfilePatch(projectedProfile, patch, [], 'ai_extraction');
        const configuredConfirmationPolicy = getSemanticFactDefinition(fact.factId)?.confirmationPolicy || 'final_review';
        // Conversational v2 has no mandatory spoken confirmation tool. The
        // silent planner therefore saves even legacy read-back values as
        // visibly reviewable drafts; the authenticated final profile/plan
        // confirmation remains the authoritative gate. The controlled v1
        // journey keeps its existing spoken read-back behaviour unchanged.
        const confirmationPolicy = context.config.realtimeConversationV2Enabled && this.applyingPlannerBatch
          ? 'final_review'
          : configuredConfirmationPolicy;
        const readBackText = confirmationPolicy === 'read_back'
          ? buildRealtimeFactReadBack(
              fact.factId,
              mapped.displayValue,
              fact.certainty,
              context.profile.preferences?.baseCurrency || 'EUR'
            )
          : null;
        return { fact, mapped, patch, confirmationPolicy, readBackText };
      });
      if (evidenceItems.size !== 1) {
        throw new ConsumerError(409, 'realtime_fact_evidence_mixed', 'Facts in one proposal batch must come from the same finalized consumer answer.');
      }
      const proposals = [];
      for (const { fact, mapped, patch, confirmationPolicy, readBackText } of normalized) {
        const created = await createRealtimeFactProposal(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          toolAttemptId,
          factId: fact.factId,
          value: mapped.proposalValue ?? mapped.displayValue,
          readBackText,
          patch,
          baseProfileRevision: Number(context.sessionRow.current_profile_revision),
          evidenceItemId: fact.evidenceItemId,
          confidence: fact.certainty === 'exact' ? 'medium' : 'low',
          certainty: fact.certainty
        });
        proposals.push({
          ...created,
          factId: fact.factId,
          value: mapped.proposalValue ?? mapped.displayValue,
          certainty: fact.certainty,
          confirmationPolicy,
          readBackText
        });
      }
      let currentProfile = context.profile;
      let currentSessionRow = context.sessionRow;
      for (const proposal of proposals.filter((item) => item.confirmationPolicy !== 'read_back')) {
        const fact = {
          factId: proposal.factId,
          value: proposal.value,
          certainty: proposal.certainty
        };
        const mapped = mapRealtimeProposalFact(currentProfile, fact);
        const nextProfile = applyMappedRealtimeFact(currentProfile, fact, mapped);
        const nextState = describeConversationState(nextProfile, context.config);
        const committed = await commitRealtimeFactConfirmation(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          proposalId: proposal.id,
          confirmationEvidenceItemId: orderedFacts[0].evidenceItemId,
          sessionRow: currentSessionRow,
          profile: nextProfile,
          stage: nextState.stage
        });
        currentProfile = committed.profile;
        currentSessionRow = committed.sessionRow;
        proposal.status = 'saved_draft';
        proposal.profileRevision = committed.revision;
      }
      const pending = proposals.filter((proposal) => proposal.confirmationPolicy === 'read_back');
      const refreshed = this.applyingPlannerBatch
        ? await this.planningContext()
        : await this.refreshJourneyState();
      const currentPendingProposal = refreshed.state.currentPendingProposal || null;
      return {
        ok: true,
        proposals,
        savedDrafts: proposals.filter((proposal) => proposal.confirmationPolicy !== 'read_back'),
        // The database order is authoritative. Several read-back facts from
        // one answer can share a timestamp, so a local insertion-order choice
        // could disagree with the stable database tie-break and make the very
        // next confirmation fail as out of order.
        currentProposalId: currentPendingProposal?.proposalId || null,
        currentReadBackText: currentPendingProposal?.readBackText || null,
        currentPendingProposal,
        profileRevision: Number(currentSessionRow.current_profile_revision),
        readBackRequired: pending.length > 0,
        instruction: pending.length
          ? 'Speak currentReadBackText verbatim, then wait for a separate consumer answer.'
          : 'Continue with the exact next server-selected question; do not ask for a separate spoken confirmation.'
      };
    }
    if (toolName === 'resolve_fact_confirmation') {
      this.requireExpectedRevision(args, context);
      // Bind to the server-authoritative finalized turn (the consumer's spoken
      // confirmation), not the opaque id the model echoed. The reuse guard
      // below still requires it to differ from the proposal's own evidence.
      const authoritativeEvidenceItemId = this.authoritativeEvidenceItemId();
      if (!authoritativeEvidenceItemId) {
        throw new ConsumerError(409, 'realtime_evidence_not_final', 'Wait for the consumer input item to finish before proposing or confirming facts.');
      }
      args.evidenceItemId = authoritativeEvidenceItemId;
      this.requireFinalizedEvidence(args.evidenceItemId);
      const proposal = await getPendingRealtimeFactProposal(
        this.env,
        this.meta.sessionId,
        this.meta.leaseId,
        args.proposalId
      );
      if (proposal.currentPendingId !== args.proposalId) {
        throw new ConsumerError(409, 'realtime_fact_confirmation_out_of_order', 'Resolve the current spoken read-back before later proposals.');
      }
      if (Number(proposal.row.base_profile_revision) !== Number(context.sessionRow.current_profile_revision)) {
        throw new ConsumerError(409, 'profile_revision_conflict', 'The fact proposal is stale.');
      }
      if (proposal.row.evidence_item_id === args.evidenceItemId) {
        throw new ConsumerError(409, 'realtime_confirmation_evidence_reused', 'A separate finalized consumer confirmation is required.');
      }
      const readBackText = proposal.readBackText || buildRealtimeFactReadBack(
        proposal.factId,
        proposal.value,
        proposal.row.certainty,
        context.profile.preferences?.baseCurrency || 'EUR'
      );
      if (args.decision === 'rejected') {
        const rejected = await rejectRealtimeFactProposal(
          this.env,
          this.meta.sessionId,
          this.meta.leaseId,
          args.proposalId,
          args.evidenceItemId
        );
        const refreshed = await this.refreshJourneyState();
        return {
          ok: true,
          proposal: rejected,
          readBackText,
          currentPendingProposal: refreshed.state.currentPendingProposal,
          instruction: refreshed.state.currentPendingProposal
            ? 'Speak currentPendingProposal.readBackText verbatim.'
            : 'Continue with the exact next server-selected question.'
        };
      }
      if (args.decision !== 'confirmed') {
        throw new ConsumerError(400, 'realtime_confirmation_decision_invalid', 'Fact confirmation decision is invalid.');
      }
      const certainty = String(proposal.row.certainty || 'unknown');
      const fact = { factId: proposal.factId, value: proposal.value, certainty };
      const mapped = mapRealtimeProposalFact(context.profile, fact);
      const nextProfile = applyMappedRealtimeFact(context.profile, fact, mapped);
      const nextState = describeConversationState(nextProfile, context.config);
      const committed = await commitRealtimeFactConfirmation(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        proposalId: args.proposalId,
        confirmationEvidenceItemId: args.evidenceItemId,
        sessionRow: context.sessionRow,
        profile: nextProfile,
        stage: nextState.stage
      });
      const refreshed = await this.refreshJourneyState();
      return {
        ok: true,
        proposalId: args.proposalId,
        status: 'confirmed',
        readBackText,
        profileRevision: committed.revision,
        currentPendingProposal: refreshed.state.currentPendingProposal,
        instruction: refreshed.state.currentPendingProposal
          ? 'Speak currentPendingProposal.readBackText verbatim.'
          : 'Continue with the exact next server-selected question.'
      };
    }
    if (toolName === 'get_module_plan') {
      // Read-only: tolerate a stale revision and return current state.
      return {
        ok: true,
        profileRevision: Number(context.sessionRow.current_profile_revision),
        confirmedProfileRevision: context.sessionRow.confirmed_profile_revision === null
          ? null
          : Number(context.sessionRow.confirmed_profile_revision),
        personaAssessment: context.state.personaAssessment,
        moduleSlots: context.state.moduleSlots,
        overrides: context.state.overrides,
        requiresGoalPriorityQuestion: context.state.requiresGoalPriorityQuestion,
        requiresDecisionTopicQuestion: context.state.requiresDecisionTopicQuestion,
        requiresPersonaScan: context.state.requiresPersonaScan,
        deferredGoalTypes: context.state.deferredGoalTypes,
        recommendations: context.state.recommendations,
        nextQuestion: context.state.nextQuestion
      };
    }
    if (toolName === 'confirm_and_run_plan') {
      this.requireExpectedRevision(args, context);
      if (!args.planId || !args.planNonce) {
        throw new ConsumerError(403, 'analysis_plan_confirmation_required', 'The authenticated analysis plan confirmation is required.');
      }
      // Verification is intentionally performed here even though the normal UI
      // path runs through PUT /analysis-plan. An unguessable server nonce and
      // exact confirmed revision are required; model assertion alone cannot run.
      const executed = await confirmAndRunRealtimeAnalysisPlan({
        env: this.env,
        config: context.config,
        sessionId: this.meta.sessionId,
        planId: args.planId,
        planNonce: args.planNonce,
        expectedRevision: args.expectedRevision
      });
      await this.setAnalysisPhase({
        planId: args.planId,
        status: executed.analysisPlan.status,
        profileRevision: args.expectedRevision
      });
      return {
        ok: true,
        planId: args.planId,
        status: executed.analysisPlan.status,
        speakableText: executed.result?.speakableText || ''
      };
    }
    if (toolName === 'get_result_summary') {
      this.requireExpectedRevision(args, context);
      if (typeof args.planId !== 'string' || !args.planId) {
        throw new ConsumerError(400, 'analysis_plan_id_required', 'The deterministic analysis plan id is required.');
      }
      const stored = await getRealtimeAnalysisPlanResult(this.env, this.meta.sessionId, args.planId);
      if (!stored) throw new ConsumerError(404, 'analysis_result_unavailable', 'The deterministic result is not ready.');
      const currentRevision = Number(context.sessionRow.current_profile_revision);
      if (Number(stored.row.profile_revision) !== currentRevision
        || Number(context.sessionRow.confirmed_profile_revision) !== currentRevision) {
        throw new ConsumerError(409, 'analysis_result_revision_conflict', 'The deterministic result is stale or the current profile still needs visual confirmation.');
      }
      const speakableText = typeof stored.result?.speakableText === 'string'
        ? stored.result.speakableText
        : '';
      if (!speakableText || speakableText !== speakableText.trim() || speakableText.length > 2_400) {
        throw new ConsumerError(409, 'analysis_speakable_summary_unavailable', 'The deterministic spoken summary is not ready.');
      }
      return {
        ok: true,
        planId: stored.row.id,
        status: stored.row.status,
        speakableText,
        promptVersion: stored.result.promptVersion || null,
        calculationVersion: stored.result.calculationVersion || null,
        instruction: 'Speak speakableText verbatim. Do not add or recalculate figures.'
      };
    }
    if (toolName === 'wait_for_user') {
      // A no-op pause never mutates state; a stale revision must not turn it
      // into an error that strands the meeting in silence.
      return { ok: true, waiting: true, reason: String(args.reason || 'consumer_reviewing').slice(0, 80) };
    }
    throw new ConsumerError(400, 'realtime_tool_not_allowed', 'That planning tool is not available.');
  }

  async setAnalysisPhase(body) {
    const status = String(body.status || '');
    const phase = status === 'complete' || status === 'needs_information'
      ? 'results'
      : status === 'prepared' || status === 'confirmed' || status === 'running'
        ? 'analysis'
        : 'confirmation';
    const context = await this.refreshJourneyState(phase);
    let assistantSpeech = null;
    const speakableText = typeof body.speakableText === 'string'
      ? body.speakableText
      : '';
    if (phase === 'results' && speakableText) {
      assistantSpeech = await issueRealtimeSpeechAuthorization({
        env: this.env,
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        kind: 'result',
        profileRevision: Number(
          body.profileRevision
          || context?.sessionRow?.current_profile_revision
        ),
        text: speakableText
      });
    }
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'realtime.analysis_plan.updated',
      payload: {
        planId: String(body.planId || '').slice(0, 100),
        status,
        profileRevision: Number(body.profileRevision || 0)
      }
    });
    return { assistantSpeech };
  }

  async touch(force = false) {
    if (!this.meta || this.closing) return;
    if (!force && Date.now() - this.lastTouchAt < 5_000) return;
    this.lastTouchAt = Date.now();
    const config = getConsumerConfig(this.env);
    const row = await touchRealtimeLease(
      this.env,
      this.meta.sessionId,
      this.meta.leaseId,
      config.realtimeIdleTimeoutSeconds
    );
    if (!row) {
      await this.terminalize('failed', 'lease_lost', 'realtime_lease_lost', false);
      return;
    }
    this.meta.idleExpiresAt = row.idle_expires_at;
    await this.state.storage.put('lease', this.meta);
    await this.scheduleAlarm();
  }

  async scheduleAlarm() {
    if (!this.meta) return;
    const deadline = Math.min(
      Date.parse(this.meta.hardExpiresAt),
      Date.parse(this.meta.idleExpiresAt),
      Date.now() + SIDE_BAND_HEARTBEAT_MS
    );
    if (Number.isFinite(deadline)) await this.state.storage.setAlarm(deadline);
  }

  // A quiet consumer is usually thinking, not gone. Before the idle timeout
  // can end the meeting, issue one code-owned reassurance so the consumer is
  // warned first; only continued silence then expires the lease.
  async maybeIssueSilencePrompt(now, idleExpiresAtMs) {
    const config = getConsumerConfig(this.env);
    const windowMs = Number(config.realtimeSilencePromptSeconds || 0) * 1_000;
    if (windowMs <= 0
      || this.inResponse
      || now < idleExpiresAtMs - windowMs
      || this.silencePromptIssuedForIdleExpiresAt === this.meta.idleExpiresAt) return;
    this.silencePromptIssuedForIdleExpiresAt = this.meta.idleExpiresAt;
    try {
      const lease = await getRealtimeLease(this.env, this.meta.sessionId, this.meta.leaseId);
      const profileRevision = Number(lease?.latest_profile_revision || 0);
      if (!lease || lease.status !== 'active' || profileRevision < 1) return;
      if (config.realtimeConversationV2Enabled) {
        await this.authorizeResponse('silence_prompt');
      } else {
        await issueRealtimeSpeechAuthorization({
          env: this.env,
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          kind: 'status',
          profileRevision,
          text: 'Take your time — there’s no rush. Would it help if I asked that in a different way? If you’re finished for now, you can end the meeting whenever you like.'
        });
      }
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'server',
        eventType: 'realtime.silence.prompt_authorized',
        payload: { idleExpiresAt: this.meta.idleExpiresAt }
      });
    } catch (_error) {
      // The gentle prompt is best-effort; the idle timeout remains authoritative.
    }
  }

  async alarm() {
    if (!this.meta || this.closing) return;
    if (this.pendingTerminalization) {
      const pending = this.pendingTerminalization;
      await this.terminalize(
        pending.status,
        pending.reason,
        pending.errorCode,
        pending.usageKnown === true
      );
      return;
    }
    if (!this.webSocket || this.webSocket.readyState !== 1) {
      await this.terminalize('failed', 'sideband_rehydration_lost', 'realtime_sideband_lost', false);
      return;
    }
    const now = Date.now();
    const hard = Date.parse(this.meta.hardExpiresAt);
    const idle = Date.parse(this.meta.idleExpiresAt);
    if (now >= hard || now >= idle) {
      await this.terminalize('expired', now >= hard ? 'hard_timeout' : 'idle_timeout', null, true);
    } else {
      await this.maybeIssueSilencePrompt(now, idle);
      await this.scheduleAlarm();
    }
  }

  // Terminalization retries back off exponentially (5s doubling to a 10-minute
  // cap). A flat 5-second alarm loop on a stuck close burned the entire
  // Durable Object free-tier duration quota overnight and took every meeting
  // down with it; a successful terminalize clears all storage, resetting the
  // counter.
  async scheduleTerminalizationRetry() {
    let attempts = 0;
    try {
      attempts = Number(await this.state.storage.get('terminalizationRetryAttempts') || 0);
    } catch (_error) {
      attempts = 0;
    }
    attempts += 1;
    await this.state.storage.put('terminalizationRetryAttempts', attempts).catch(() => {});
    const delayMs = Math.min(600_000, 5_000 * 2 ** Math.min(attempts - 1, 10));
    await this.state.storage.setAlarm(Date.now() + delayMs).catch(() => {});
  }

  async terminalize(status, reason, errorCode, usageKnown) {
    if (!this.meta) return { providerHangupConfirmed: true };
    if (this.closing) {
      throw new ConsumerError(409, 'realtime_close_in_progress', 'The live voice session is already closing.');
    }
    this.closing = true;
    const termination = {
      status,
      reason,
      errorCode: errorCode || null,
      usageKnown: usageKnown === true
    };
    this.pendingTerminalization = termination;
    await this.state.storage.put('pendingTerminalization', termination);
    let lease = null;
    let hangupConfirmed = false;
    try {
      lease = await getRealtimeLease(this.env, this.meta.sessionId, this.meta.leaseId);
      if (!lease) throw new ConsumerError(503, 'realtime_close_failed', 'The live voice lease could not be closed safely.');
      const providerCallId = await getRealtimeProviderCallId(
        this.env,
        this.meta.sessionId,
        this.meta.leaseId
      );
      const wasDispatched = Boolean(
        lease.activated_at
        || lease.provider_call_id_hash_b64u
        || lease.provider_call_id_encrypted
        || providerCallId
      );
      // Hours past the hard expiry the provider call is proven dead by time
      // alone (the provider hard-caps call duration); do not let a flaky
      // dead-call hangup endpoint keep this close retrying.
      const hardExpiresMs = Date.parse(String(lease.hard_expires_at || ''));
      const terminationTimeProven = Number.isFinite(hardExpiresMs)
        && Date.now() - hardExpiresMs > 2 * 60 * 60 * 1000;
      if (wasDispatched && !terminationTimeProven) {
        if (!providerCallId) {
          throw new ConsumerError(502, 'realtime_hangup_uncertain', 'The live provider call could not be terminated safely.');
        }
        await hangupOpenAiRealtimeCall({ env: this.env, providerCallId });
      }
      hangupConfirmed = true;
    } catch (error) {
      this.closing = false;
      await this.scheduleTerminalizationRetry();
      if (error instanceof ConsumerError) throw error;
      throw new ConsumerError(502, 'realtime_hangup_uncertain', 'The live provider call could not be terminated safely.');
    }
    if (this.webSocket && this.webSocket.readyState === 1) {
      try { this.webSocket.close(1000, String(reason).slice(0, 100)); } catch (_error) { /* best effort */ }
    }
    const activatedAtMs = Date.parse(lease?.activated_at || '');
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'realtime.call.closed',
      payload: {
        reason,
        status,
        errorCode: errorCode || null,
        durationMs: Number.isFinite(activatedAtMs) ? Math.max(0, Date.now() - activatedAtMs) : null,
        estimatedCostEurMicros: Number(lease?.estimated_cost_eur_micros || 0),
        responseCount: Number(lease?.response_count || 0),
        toolCallCount: Number(lease?.tool_call_count || 0)
      }
    }).catch(() => {});
    let row;
    try {
      row = await closeRealtimeLease(
        this.env,
        this.meta.sessionId,
        this.meta.leaseId,
        status,
        reason,
        errorCode
      );
    } catch (_error) {
      this.closing = false;
      await this.scheduleTerminalizationRetry();
      throw new ConsumerError(503, 'realtime_close_failed', 'The live voice session could not be closed safely.');
    }
    if (!row || ['pending', 'active', 'closing'].includes(row.status)) {
      this.closing = false;
      await this.scheduleTerminalizationRetry();
      throw new ConsumerError(503, 'realtime_close_failed', 'The live voice session could not be closed safely.');
    }
    let speechUsageSettled = false;
    try {
      speechUsageSettled = !(await hasUnsettledRealtimeSpeechUsage(
        this.env,
        this.meta.sessionId,
        this.meta.leaseId
      ));
    } catch (_error) {
      // Fail closed: if the speech ledger cannot prove settlement, retain the full reservation.
      speechUsageSettled = false;
    }
    const noUnmeteredWork = speechUsageSettled
      && !this.inResponse
      && !this.pendingResponseAuthorization
      && !this.toolContinuationPending
      && this.activeToolCallCount === 0
      && this.committedAudioItemIds.size === 0;
    try {
      if (!row.activated_at && !row.provider_call_id_hash_b64u && !row.provider_call_id_encrypted) {
        await releaseConsumerProviderCostNotSent(this.env, this.meta.costEntryId, { errorCode: errorCode || reason });
      } else if (hangupConfirmed && usageKnown === true && noUnmeteredWork) {
        await settleConsumerProviderCostKnown(
          this.env,
          this.meta.costEntryId,
          Number(row.estimated_cost_eur_micros || 0),
          { errorCode: errorCode || null }
        );
      } else {
        await settleConsumerProviderCostUnknown(this.env, this.meta.costEntryId, {
          errorCode: errorCode || reason,
          // The provider hangup is already confirmed on this path; the metered
          // estimate bounds the uncertain remainder instead of charging the
          // whole session envelope for a glitch.
          estimatedCostEurMicros: Number(row.estimated_cost_eur_micros || 0)
        });
      }
    } catch (_error) {
      // The full reservation remains charged while settlement is uncertain.
    }
    await this.state.storage.deleteAll();
    this.meta = null;
    this.webSocket = null;
    this.pendingTerminalization = null;
    return { providerHangupConfirmed: hangupConfirmed === true };
  }
}
