import {
  ConsumerApiError,
  createRealtimeVoiceCall,
  deleteRealtimeVoiceActivation,
  deleteRealtimeVoiceCall,
  getRealtimeVoiceCall,
  speakRealtimeAuthorized,
  updateRealtimeVoiceConsent
} from './api.js';
import {
  clearRealtimeVoiceConsent,
  getRealtimeVoiceConsent,
  getSessionId,
  hasCurrentRealtimeVoiceConsent,
  mergeVoicePayload,
  state
} from './store.js';
import { getSemanticFactDefinition } from '../planning/semantic_facts.js';
import {
  consumerLanguageForModule,
  containsInternalModuleTerminology
} from '../planning/module_offers.js';
import { RealtimeOrb } from './realtime_orb.js';

const ADVISER_TEST_COHORT = 'adviser_test';
const DEFAULT_SESSION_LIMIT_MICRO_EUR = 2_000_000;
const LOW_BUDGET_MICRO_EUR = 300_000;
const DEFAULT_LIVE_SECONDS = 300;
const MAX_TRANSCRIPT_ITEMS = 500;
const COMPLETION_PLAYBACK_TIMEOUT_MS = 15_000;
const MAX_CAPTION_LENGTH = 3_000;
const CONNECTION_GRACE_MS = 8_000;
const MICROPHONE_PREFERENCE_STORAGE_KEY = 'planeir.consumer.realtime-microphone.v1';
const BUILT_IN_MICROPHONE_PATTERN = /(?:\bmacbook\b|\bbuilt[\s-]?in\b|\binternal\b|\bintegrated\b|\bmicrophone array\b)/i;
const CONTINUITY_MICROPHONE_PATTERN = /(?:\biphone\b|\bipad\b|\bcontinuity\b)/i;
const MICROPHONE_ORTHOGONAL_PHASES = new Set([
  'user_speaking',
  'thinking',
  'responding',
  'assistant_speaking',
  'interrupted',
  'reconnecting'
]);
function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function unwrap(payload) {
  const root = asObject(payload) || {};
  return asObject(root.data) || root;
}

function cleanText(value, maximum = MAX_CAPTION_LENGTH) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maximum);
}

export function isLikelyIncompleteVoiceCaption(value) {
  const raw = cleanText(value, 500);
  if (!raw || /[?!]\s*$/.test(raw)) return false;
  const normalized = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[.…]+$/g, '')
    .replace(/[^a-z0-9€£$%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  if (/^(?:yes|yeah|yep|correct|no|nope|none|it is|yes it is|that is|yes there is|no there is not|i do|i dont|i do not)$/.test(normalized)) {
    return false;
  }
  if (/^(?:what|why|how|when|where|who|is|are|do|does|can|could|would|will|should)\b/.test(normalized)) {
    return false;
  }
  if (/\bwhat\b.*\b(?:is|worth)$/.test(normalized)) return false;
  return /\b(?:is|are|was|were|about|around|roughly|approximately|worth)$/.test(normalized);
}

function newIdempotencyKey(prefix = 'voice-realtime') {
  if (typeof crypto?.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  const random = crypto?.getRandomValues
    ? crypto.getRandomValues(new Uint32Array(4)).join('-')
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${Date.now()}-${random}`;
}

function newRealtimePrivateId(prefix) {
  if (typeof crypto?.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  const random = crypto?.getRandomValues
    ? [...crypto.getRandomValues(new Uint32Array(6))]
      .map((value) => value.toString(36))
      .join('_')
    : `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

function headerValue(headers, names) {
  if (!headers || typeof headers.get !== 'function') return '';
  for (const name of names) {
    const value = String(headers.get(name) || '').trim();
    if (value) return value;
  }
  return '';
}

function headerNumber(headers, names) {
  const raw = headerValue(headers, names);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function budgetFromHeaders(headers) {
  const limitMicroEur = headerNumber(headers, [
    'X-Voice-Limit-Micro-Eur',
    'X-Realtime-Voice-Limit-Micro-Eur'
  ]);
  const spentMicroEur = headerNumber(headers, [
    'X-Voice-Spent-Micro-Eur',
    'X-Realtime-Voice-Spent-Micro-Eur'
  ]);
  const remainingMicroEur = headerNumber(headers, [
    'X-Voice-Remaining-Micro-Eur',
    'X-Realtime-Voice-Remaining-Micro-Eur',
    'X-Realtime-Budget-Micro-Eur'
  ]);
  if (limitMicroEur === null && spentMicroEur === null && remainingMicroEur === null) return null;
  return { limitMicroEur, spentMicroEur, remainingMicroEur };
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || ''));
  } catch (_error) {
    return null;
  }
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function normaliseRealtimeCallResponse(response) {
  const rawBody = String(response?.body || '');
  const body = rawBody.trim();
  const contentType = String(response?.contentType || '').toLowerCase();
  const parsed = contentType.includes('json') || body.startsWith('{')
    ? parseJson(body)
    : null;
  const root = unwrap(parsed);
  const answer = asObject(firstDefined(root.answer, root.sessionDescription, root.remoteDescription)) || {};
  const lease = asObject(firstDefined(root.lease, root.realtimeLease, root.call)) || {};
  // SDP is line-oriented protocol text. Preserve its CRLF framing exactly;
  // treating it like a caption would trim the final line terminator and can
  // make otherwise valid answers fail in stricter WebRTC implementations.
  const sdp = String(firstDefined(
    root.sdp,
    root.answerSdp,
    root.answer_sdp,
    answer.sdp,
    body.startsWith('v=0') ? rawBody : ''
  ) || '').slice(0, 120_000);
  const leaseId = cleanText(firstDefined(
    root.leaseId,
    root.lease_id,
    lease.leaseId,
    lease.lease_id,
    lease.id,
    headerValue(response?.headers, [
      'X-Voice-Realtime-Lease-Id',
      'X-Realtime-Voice-Lease-Id',
      'X-Voice-Lease-Id',
      'X-Realtime-Lease-Id',
      'X-Lease-Id'
    ])
  ), 200);
  const expiresAt = firstDefined(
    root.expiresAt,
    root.expires_at,
    lease.expiresAt,
    lease.expires_at,
    headerValue(response?.headers, [
      'X-Voice-Realtime-Expires-At',
      'X-Voice-Lease-Expires-At',
      'X-Realtime-Lease-Expires-At',
      'X-Realtime-Hard-Expires-At'
    ])
  );
  const maxDurationSeconds = Number(firstDefined(
    root.maxDurationSeconds,
    lease.maxDurationSeconds,
    0
  )) || 0;
  const maxDurationMs = Number(firstDefined(
    root.maxDurationMs,
    lease.maxDurationMs,
    maxDurationSeconds > 0 ? maxDurationSeconds * 1_000 : undefined,
    headerNumber(response?.headers, ['X-Voice-Realtime-Max-Duration-Ms']),
    0
  )) || 0;
  const headerBudget = budgetFromHeaders(response?.headers);
  const controlCapability = cleanText(headerValue(response?.headers, [
    'X-Realtime-Control-Capability'
  ]), 120);
  const activationId = cleanText(headerValue(response?.headers, [
    'X-Realtime-Activation-Id'
  ]), 120);
  const conversationVersion = cleanText(headerValue(response?.headers, [
    'X-Realtime-Conversation-Version'
  ]), 8).toLowerCase() === 'v2' ? 'v2' : 'v1';
  const payload = parsed || (headerBudget ? { realtimeVoiceBudget: headerBudget } : null);
  return {
    sdp,
    leaseId,
    expiresAt,
    maxDurationMs,
    payload,
    budget: headerBudget,
    controlCapability,
    activationId,
    conversationVersion
  };
}

function eventText(event) {
  const delta = firstDefined(
    event?.delta,
    event?.transcript,
    event?.text,
    event?.item?.transcript,
    event?.item?.content?.[0]?.transcript,
    event?.item?.content?.[0]?.text,
    ''
  );
  if (typeof delta === 'string') return cleanText(delta);
  return cleanText(firstDefined(asObject(delta)?.text, asObject(delta)?.transcript, ''));
}

function eventItemId(event) {
  return cleanText(firstDefined(
    event?.item_id,
    event?.itemId,
    event?.item?.id,
    event?.response_id,
    event?.response?.id,
    'current'
  ), 200);
}

function eventResponseId(event) {
  return cleanText(firstDefined(
    event?.response_id,
    event?.responseId,
    event?.response?.id,
    ''
  ), 200);
}

export function classifyRealtimeEvent(event) {
  const value = asObject(event) || {};
  const type = String(value.type || '').toLowerCase();
  const base = { type, itemId: eventItemId(value), text: eventText(value), event: value };
  if (type === 'input_audio_buffer.speech_started') return { ...base, kind: 'speech_started' };
  if (type === 'input_audio_buffer.speech_stopped') return { ...base, kind: 'speech_stopped' };
  if ([
    'conversation.item.input_audio_transcription.delta',
    'input_audio_transcription.delta'
  ].includes(type)) return { ...base, kind: 'user_delta' };
  if ([
    'conversation.item.input_audio_transcription.completed',
    'input_audio_transcription.completed'
  ].includes(type)) return { ...base, kind: 'user_final' };
  if ([
    'response.output_audio_transcript.delta',
    'response.audio_transcript.delta'
  ].includes(type)) return { ...base, kind: 'assistant_delta', responseId: eventResponseId(value) };
  if ([
    'response.output_audio_transcript.done',
    'response.audio_transcript.done'
  ].includes(type)) return { ...base, kind: 'assistant_final', responseId: eventResponseId(value) };
  // Stray assistant TEXT is tolerated: the Worker keeps the meeting alive (a
  // tool call is still mandatory per response) and this text is never
  // rendered or spoken. Only unauthorized AUDIO output hard-stops the call.
  if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
    return { ...base, kind: 'ignored' };
  }
  if (type === 'response.created') return { ...base, kind: 'response_started', responseId: eventResponseId(value) };
  if (type === 'response.done') return { ...base, kind: 'response_done', responseId: eventResponseId(value) };
  if (type === 'output_audio_buffer.started') return { ...base, kind: 'assistant_playback_started' };
  if (type === 'output_audio_buffer.stopped') return { ...base, kind: 'assistant_playback_stopped' };
  if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
    return { ...base, kind: 'assistant_audio', responseId: eventResponseId(value) };
  }
  if (type === 'response.output_audio.failed' || type === 'response.audio.failed') {
    return { ...base, kind: 'assistant_audio_failed', responseId: eventResponseId(value) };
  }
  if (type === 'response.function_call_arguments.done') return { ...base, kind: 'tool_running' };
  if (type === 'error' || type.endsWith('.failed')) return { ...base, kind: 'error' };
  if (type.startsWith('planeir.') && (value.planning || value.context || value.facts || value.modules)) {
    return { ...base, kind: 'planning_update', payload: firstDefined(value.planning, value.context, value) };
  }
  if (['conversation.item.created', 'conversation.item.added', 'conversation.item.done'].includes(type)
    && value.item?.type === 'function_call_output') {
    const output = parseJson(value.item.output);
    return output
      ? { ...base, kind: 'planning_update', payload: output }
      : { ...base, kind: 'ignored' };
  }
  return { ...base, kind: 'ignored' };
}

function humanise(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

function formatFactValue(value, path = '') {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const objectValue = asObject(value);
  if (objectValue) {
    if (typeof objectValue.amount === 'number' && Number.isFinite(objectValue.amount)) {
      const currency = /^[A-Z]{3}$/.test(String(objectValue.currency || '').toUpperCase())
        ? String(objectValue.currency).toUpperCase()
        : 'EUR';
      return new Intl.NumberFormat('en-IE', {
        style: 'currency',
        currency,
        maximumFractionDigits: objectValue.amount % 1 === 0 ? 0 : 2
      }).format(objectValue.amount);
    }
    const minimum = firstDefined(objectValue.min, objectValue.minimum);
    const maximum = firstDefined(objectValue.max, objectValue.maximum);
    if (Number.isFinite(Number(minimum)) && Number.isFinite(Number(maximum))) {
      return `${formatFactValue(Number(minimum), path)}–${formatFactValue(Number(maximum), path)}`;
    }
    return cleanText(firstDefined(objectValue.label, objectValue.name, objectValue.text, '—'), 120);
  }
  if (Array.isArray(value)) {
    return cleanText(value.map((item) => formatFactValue(item, path)).filter(Boolean).join(', '), 120);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (/(?:amount|balance|cost|debt|deposit|expense|income|price|salary|saving|value)/i.test(path)) {
      return new Intl.NumberFormat('en-IE', {
        style: 'currency',
        currency: 'EUR',
        maximumFractionDigits: 0
      }).format(value);
    }
    return new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(value);
  }
  const cleaned = cleanText(value, 120);
  return /[_-]/.test(cleaned) ? humanise(cleaned) : cleaned;
}

function factBadge(metadata = {}) {
  const certainty = String(firstDefined(metadata.certainty, metadata.confidence, '') || '').toLowerCase();
  const status = String(firstDefined(metadata.status, '') || '').toLowerCase();
  if (certainty.includes('approx') || certainty.includes('estimate') || ['low', 'medium'].includes(certainty)) {
    return { key: 'approximate', label: 'Approximate' };
  }
  if (metadata.confirmed === true || metadata.confirmedAt || status.includes('confirm') || certainty === 'exact') {
    return { key: 'exact', label: 'Exact' };
  }
  return { key: 'pending', label: 'Pending confirmation' };
}

const PROFILE_KEYS_TO_SKIP = new Set([
  'consent',
  'createdAt',
  'fieldMetadata',
  'id',
  'missingInformation',
  'profileId',
  'revision',
  'schemaVersion',
  'source',
  'updatedAt'
]);

function collectProfileFacts(value, profile, path = '', output = [], depth = 0) {
  if (output.length >= 30 || depth > 7 || value === null || value === undefined || value === '') return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectProfileFacts(item, profile, `${path}/${index}`, output, depth + 1));
    return output;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      // Collection identifiers are implementation details, not information a
      // consumer meaningfully told Planéir. Keep them out of the visible
      // understanding panel while retaining the associated labelled values.
      if (!PROFILE_KEYS_TO_SKIP.has(key) && !/Id$/.test(key)) {
        collectProfileFacts(item, profile, `${path}/${key}`, output, depth + 1);
      }
    });
    return output;
  }
  const cleanValue = formatFactValue(value, path);
  if (!cleanValue) return output;
  const metadataEntry = Object.entries(profile?.fieldMetadata || {})
    .filter(([metadataPath]) => path === metadataPath || path.startsWith(`${metadataPath}/`))
    .sort(([left], [right]) => right.length - left.length)[0];
  const metadata = asObject(metadataEntry?.[1]);
  // A pristine canonical profile contains identifiers, defaults and policy
  // settings that Planéir did not learn from the consumer. Only show values
  // carrying explicit provenance; live tool facts use the server `facts`
  // collection above and therefore do not rely on this fallback.
  if (!metadata) return output;
  const segments = path.split('/').filter(Boolean);
  const key = segments.filter((segment) => !/^\d+$/.test(segment)).at(-1) || 'Detail';
  output.push({
    path,
    label: humanise(key),
    value: cleanValue,
    badge: factBadge(metadata)
  });
  return output;
}

function normaliseProposedFact(item, index) {
  const value = asObject(item) || { value: item };
  const factId = cleanText(firstDefined(value.factId, value.id, ''), 120);
  const definition = factId ? getSemanticFactDefinition(factId) : null;
  const path = cleanText(firstDefined(value.path, value.key, factId, `proposed-${index}`), 200);
  return {
    path,
    factId: factId || null,
    label: cleanText(firstDefined(value.label, value.name, definition?.label, humanise(path.split('/').filter(Boolean).at(-1)), 'Proposed detail'), 100),
    value: formatFactValue(firstDefined(value.displayValue, value.value, value.text, '—'), factId || path),
    badge: factBadge(value)
  };
}

function moduleBadge(item) {
  const value = asObject(item) || {};
  const availability = String(firstDefined(value.availability, value.readiness?.status, '') || '').toLowerCase();
  if (availability === 'adviser_review_required') {
    return { key: 'pending', label: 'Gerry review' };
  }
  if (availability === 'unsupported') {
    return { key: 'pending', label: 'Not automated' };
  }
  if (availability === 'needs_facts') {
    return { key: 'pending', label: 'Needs information' };
  }
  if (availability === 'ready' || availability === 'ready_with_assumptions') {
    return { key: 'exact', label: 'Released' };
  }
  const certainty = String(firstDefined(value.certainty, value.confidence, '') || '').toLowerCase();
  const status = String(firstDefined(value.status, value.selectionStatus, '') || '').toLowerCase();
  if (certainty.includes('approx') || certainty === 'likely') {
    return { key: 'approximate', label: 'Approximate' };
  }
  if (value.confirmed === true || ['selected', 'required', 'confirmed'].includes(status)) {
    return { key: 'exact', label: 'Exact' };
  }
  return { key: 'pending', label: 'Pending confirmation' };
}

function normaliseModule(item, index) {
  const value = asObject(item) || { moduleId: item };
  const moduleId = cleanText(firstDefined(value.moduleId, value.id, value.module?.id, `module-${index}`), 120);
  const consumerDescription = consumerLanguageForModule(moduleId)?.shortDescription;
  if (!consumerDescription) return null;
  const reasons = Array.isArray(value.reasons)
    ? value.reasons.filter((reason) => typeof reason === 'string' && reason.trim())
    : [];
  const reason = cleanText(firstDefined(
    value.reason,
    reasons[0],
    value.description,
    Array.isArray(value.rationale) ? value.rationale[0] : value.rationale,
    ''
  ), 220);
  return {
    moduleId,
    label: cleanText(firstDefined(
      consumerDescription,
      value.consumerShortLabel,
      'an analysis'
    ), 100),
    reason: containsInternalModuleTerminology(reason) ? '' : reason,
    badge: moduleBadge(value)
  };
}

export function extractRealtimePlanningContext(payload, currentState = state) {
  const root = unwrap(payload);
  const guide = asObject(firstDefined(
    root.conversationGuide,
    root.planningState?.conversationGuide,
    root.realtime?.conversationGuide
  )) || {};
  const realtime = asObject(firstDefined(
    root.realtime,
    root.realtimeVoice,
    root.voice?.realtime,
    root.lease?.planning,
    root.planning,
    root.planningState,
    root.context
  )) || {};
  const proposedFacts = firstDefined(
    root.proposedFacts,
    root.facts,
    realtime.proposedFacts,
    realtime.facts,
    root.toolState?.facts
  );
  const proposedModules = firstDefined(
    guide.analyses,
    root.moduleSlots,
    realtime.moduleSlots,
    root.analysisPlan?.moduleSlots,
    root.proposedModules,
    root.modules,
    root.recommendations,
    realtime.proposedModules,
    realtime.modules,
    realtime.recommendations,
    root.toolState?.modules
  );
  const facts = Array.isArray(proposedFacts)
    ? proposedFacts.map(normaliseProposedFact)
    : collectProfileFacts(currentState?.profile, currentState?.profile);
  const sourceModules = Array.isArray(proposedModules)
    ? proposedModules
    : (Array.isArray(currentState?.recommendations) ? currentState.recommendations : []);
  return {
    facts,
    modules: sourceModules.map(normaliseModule).filter(Boolean),
    narrativeSummary: cleanText(guide.narrativeSummary, 500),
    nextObjective: asObject(guide.nextObjective) || null,
    progress: asObject(guide.progress) || null,
    readyForReview: firstDefined(
      root.readyForReview,
      realtime.readyForReview,
      realtime.confirmationReady,
      false
    ) === true
  };
}

export function isRealtimeVoiceSupported(win = window, nav = navigator) {
  return Boolean(
    win?.isSecureContext
    && typeof win?.RTCPeerConnection === 'function'
    && nav?.mediaDevices
    && typeof nav.mediaDevices.getUserMedia === 'function'
  );
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
  const budget = state.voice?.realtimeBudget
    || state.bootstrap?.realtimeVoiceBudget
    || state.voice?.budget
    || state.bootstrap?.voiceBudget
    || {};
  const limitMicroEur = Math.max(0, Number(firstDefined(
    budget.limitMicroEur,
    DEFAULT_SESSION_LIMIT_MICRO_EUR
  )) || DEFAULT_SESSION_LIMIT_MICRO_EUR);
  const spentMicroEur = Math.max(0, Number(firstDefined(budget.spentMicroEur, 0)) || 0);
  const remainingMicroEur = Math.max(0, Number(firstDefined(
    budget.remainingMicroEur,
    limitMicroEur - spentMicroEur
  )) || 0);
  return { limitMicroEur, spentMicroEur, remainingMicroEur };
}

function safePrivacyUrl(value) {
  try {
    const url = new URL(String(value || ''), window.location.href);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      return url.href;
    }
  } catch (_error) {
    // Invalid disclosure configuration is handled as unavailable.
  }
  return '';
}

function realtimeContext() {
  const bootstrap = state.bootstrap || {};
  const savedConsent = getRealtimeVoiceConsent() || {};
  const noticeId = String(bootstrap.voiceRealtimeNoticeId || savedConsent.noticeId || '');
  const policyVersion = String(bootstrap.voiceRealtimePolicyVersion || savedConsent.policyVersion || '');
  const privacyNoticeUrl = safePrivacyUrl(
    bootstrap.voiceRealtimePrivacyNoticeUrl
    || bootstrap.privacyNoticeUrl
    || savedConsent.privacyNoticeUrl
    || ''
  );
  // A locally stored credential can outlive a failed session creation (5xx
  // responses deliberately keep it for retry). The meeting must only appear
  // for a session the server has actually confirmed, otherwise every voice
  // route would fail against a session that does not exist.
  const serverSessionConfirmed = Boolean(state.session?.id || state.session?.sessionId);
  return {
    eligible: bootstrap.enabled === true
      && bootstrap.voiceRealtimeEnabled === true
      && String(bootstrap.cohort || '').toLowerCase() === ADVISER_TEST_COHORT,
    configured: Boolean(noticeId && policyVersion && privacyNoticeUrl),
    noticeId,
    policyVersion,
    privacyNoticeUrl,
    consentGranted: hasCurrentRealtimeVoiceConsent(),
    sessionId: serverSessionConfirmed ? getSessionId() : '',
    journeyBusy: state.busy === true,
    consentRefreshRequired: state.consentRefreshRequired === true,
    maxDurationMs: Math.min(900_000, Math.max(15_000, Number(
      bootstrap.voiceRealtimeMaxSeconds || DEFAULT_LIVE_SECONDS
    ) * 1_000)),
    pollMs: Math.min(60_000, Math.max(10_000, Number(
      bootstrap.voiceRealtimePollSeconds || 20
    ) * 1_000)),
    budget: currentBudget(),
    // The warning threshold is expressed as spend (e.g. €7.50 of €10). The UI
    // warns once the remaining allowance drops below limit − threshold.
    lowBudgetMicroEur: (() => {
      const budget = currentBudget();
      const warnSpendMicroEur = Number(bootstrap.voiceRealtimeWarnMicroEur || 0);
      return warnSpendMicroEur > 0 && warnSpendMicroEur < budget.limitMicroEur
        ? Math.max(0, budget.limitMicroEur - warnSpendMicroEur)
        : LOW_BUDGET_MICRO_EUR;
    })()
  };
}

function stopTracks(stream) {
  stream?.getTracks?.().forEach((track) => {
    try { track.stop(); } catch (_error) { /* best-effort privacy cleanup */ }
  });
}

function microphoneConstraints(deviceId = '') {
  const selectedDeviceId = String(deviceId || '').trim();
  return {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {})
  };
}

function microphonePreferenceStorage() {
  try {
    return window.sessionStorage || null;
  } catch (_error) {
    return null;
  }
}

function readMicrophonePreference() {
  try {
    const parsed = parseJson(microphonePreferenceStorage()?.getItem(MICROPHONE_PREFERENCE_STORAGE_KEY));
    const deviceId = cleanText(parsed?.deviceId, 500);
    if (!deviceId) return null;
    return {
      deviceId,
      label: cleanText(parsed?.label, 120)
    };
  } catch (_error) {
    return null;
  }
}

function writeMicrophonePreference(preference) {
  try {
    const storage = microphonePreferenceStorage();
    if (!storage) return;
    const deviceId = cleanText(preference?.deviceId, 500);
    if (!deviceId) {
      storage.removeItem(MICROPHONE_PREFERENCE_STORAGE_KEY);
      return;
    }
    storage.setItem(MICROPHONE_PREFERENCE_STORAGE_KEY, JSON.stringify({
      deviceId,
      label: cleanText(preference?.label, 120)
    }));
  } catch (_error) {
    // Device choice is a convenience only; blocked storage must not block voice.
  }
}

function microphoneCandidates(devices) {
  return (Array.isArray(devices) ? devices : []).filter((device) => (
    device?.kind === 'audioinput'
    && String(device.deviceId || '').trim()
    && !['default', 'communications'].includes(String(device.deviceId || '').trim().toLowerCase())
  ));
}

function microphoneLabel(device) {
  return cleanText(device?.label, 120);
}

function findSavedMicrophone(devices, preference) {
  const candidates = microphoneCandidates(devices);
  const savedId = cleanText(preference?.deviceId, 500);
  const exact = savedId && candidates.find((device) => device.deviceId === savedId);
  if (exact) return exact;
  const savedLabel = microphoneLabel(preference).toLowerCase();
  return savedLabel
    ? candidates.find((device) => microphoneLabel(device).toLowerCase() === savedLabel) || null
    : null;
}

function findAutomaticMicrophone(devices) {
  const named = microphoneCandidates(devices).filter((device) => microphoneLabel(device));
  return named.find((device) => (
    BUILT_IN_MICROPHONE_PATTERN.test(microphoneLabel(device))
    && !CONTINUITY_MICROPHONE_PATTERN.test(microphoneLabel(device))
  )) || named.find((device) => !CONTINUITY_MICROPHONE_PATTERN.test(microphoneLabel(device))) || null;
}

function hasUsableMicrophoneLabels(devices) {
  return microphoneCandidates(devices).some((device) => Boolean(microphoneLabel(device)));
}

function isMissingMicrophoneError(error) {
  return ['OverconstrainedError', 'NotFoundError', 'DevicesNotFoundError'].includes(String(error?.name || ''));
}

function requireLiveMicrophoneStream(stream) {
  const track = stream?.getAudioTracks?.()[0] || null;
  if (!track || track.readyState === 'ended') {
    stopTracks(stream);
    throw new Error('The selected microphone did not provide a live audio track. Choose another source or continue by typing.');
  }
  return stream;
}

function microphoneAbortError() {
  const error = new Error('Microphone setup was cancelled.');
  error.name = 'AbortError';
  return error;
}

function connectionErrorMessage(error) {
  if (error instanceof ConsumerApiError) return error.message;
  switch (String(error?.name || '')) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was not allowed. Allow it in browser settings, use short voice, or continue by typing.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found. Connect one or continue by typing.';
    case 'OverconstrainedError':
      return 'That microphone is no longer available. Choose another source or use Automatic (built-in preferred).';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The microphone is already in use or could not be opened. Close other recording apps and try again.';
    default:
      return error instanceof Error && error.message
        ? error.message
        : 'Live voice could not connect. Short voice and typing remain available.';
  }
}

function leaseStatus(payload) {
  const root = unwrap(payload);
  const lease = asObject(firstDefined(root.lease, root.realtimeLease, root.call)) || {};
  return String(firstDefined(root.status, lease.status, '') || '').toLowerCase();
}

export class RealtimeVoiceController {
  constructor({
    root,
    onVoicePayload = () => {},
    onPlanningPayload = () => {},
    onNavigate = () => {},
    onStopBoundedVoice = () => {},
    onToast = () => {},
    onSessionUnavailable = () => false
  } = {}) {
    this.root = root;
    this.onVoicePayload = onVoicePayload;
    this.onPlanningPayload = onPlanningPayload;
    this.onNavigate = onNavigate;
    this.onStopBoundedVoice = onStopBoundedVoice;
    this.onToast = onToast;
    this.onSessionUnavailable = onSessionUnavailable;
    this.phase = 'off';
    this.statusText = '';
    this.active = false;
    this.muted = false;
    this.peerConnection = null;
    this.dataChannel = null;
    this.localStream = null;
    this.remoteAudioStream = null;
    this.orb = null;
    this.leaseId = '';
    this.controlCapability = '';
    this.conversationVersion = 'v1';
    this.leaseExpiresAtMs = null;
    this.sessionId = '';
    this.startController = null;
    this.pollController = null;
    this.pollTimer = null;
    this.expiryTimer = null;
    this.countdownTimer = null;
    this.disconnectTimer = null;
    this.interruptTimer = null;
    this.completionTimer = null;
    this.generation = 0;
    this.bound = false;
    this.responseInProgress = false;
    this.activeResponseId = '';
    this.awaitingWorkerSpeech = false;
    this.welcomePending = false;
    this.welcomePlaybackStarted = false;
    this.controlledSpeechController = null;
    this.controlledSpeechUrl = '';
    this.controlledSpeechReader = null;
    this.controlledSpeechMediaSource = null;
    this.controlledSpeechStreamTask = null;
    this.currentControlledSpeech = null;
    this.playedSpeechIds = new Set();
    this.userDeltas = new Map();
    this.assistantDeltas = new Map();
    this.seenFinalItems = new Set();
    this.transcriptHistory = [];
    this.completionSpeechId = '';
    this.completionNavigationInFlight = false;
    this.planningContext = null;
    this.lastState = state;
    this.expanded = false;
    this.lastFocusedElement = null;
    this.backgroundInertStates = new Map();
    this.microphoneDevices = [];
    this.microphonePreference = readMicrophonePreference();
    this.selectedMicrophoneId = this.microphonePreference?.deviceId || '';
    this.activeMicrophoneLabel = '';
    this.microphonePermissionStream = null;
    this.microphoneRecoveryRequired = false;
    this.microphoneSwitchTask = Promise.resolve();
    this.microphoneSwitchInFlight = false;
    this.deviceRefreshInFlight = false;
    this.deviceChangeHandler = () => this.refreshMicrophones();
  }

  element(id) {
    return this.root?.querySelector?.(`#${id}`) || null;
  }

  isLive() {
    return this.active;
  }

  // True when the live meeting can actually run for this confirmed session:
  // the cohort is eligible, the disclosure is configured, a server session
  // exists, the browser supports it, and no consent refresh is outstanding.
  // The app uses this to decide between the orb meeting and the "failed to
  // load" page — there is no typed-journey fallback anymore.
  isMeetingAvailable() {
    const context = realtimeContext();
    return context.eligible
      && context.configured
      && Boolean(context.sessionId)
      && isRealtimeVoiceSupported()
      && !context.consentRefreshRequired;
  }

  // Why the meeting cannot open, so the failure page can say something the
  // person can act on instead of the generic "try again in a moment".
  meetingUnavailableReason() {
    const context = realtimeContext();
    if (!isRealtimeVoiceSupported()) return 'unsupported-browser';
    if (!context.eligible || !context.configured) return 'service-off';
    if (!context.sessionId) return 'no-session';
    if (context.consentRefreshRequired) return 'consent-refresh';
    return '';
  }

  // Per-gate breakdown for diagnosing a meeting that will not open. Booleans and
  // identifiers only: no profile, transcript, or other personal data, so it is
  // safe to log. `eligible` is split out because a single false there is the
  // most common cause and the hardest to tell apart from the others.
  meetingUnavailableDetail() {
    const context = realtimeContext();
    const bootstrap = state.bootstrap || {};
    return {
      reason: this.meetingUnavailableReason(),
      journeyEnabled: bootstrap.enabled === true,
      realtimeFlagEnabled: bootstrap.voiceRealtimeEnabled === true,
      cohort: String(bootstrap.cohort || ''),
      cohortMatches: String(bootstrap.cohort || '').toLowerCase() === ADVISER_TEST_COHORT,
      noticesConfigured: context.configured,
      browserSupported: isRealtimeVoiceSupported(),
      serverSessionConfirmed: Boolean(context.sessionId),
      consentRefreshRequired: context.consentRefreshRequired === true
    };
  }

  isCompletionLocked() {
    return Boolean(this.completionSpeechId || this.completionNavigationInFlight);
  }

  ownsRealtimeResponseEvent(event) {
    if (this.conversationVersion !== 'v2') return true;
    const responseId = cleanText(event?.responseId, 200);
    // Keep compatibility with provider/test envelopes that predate response_id,
    // while strictly gating every identified GA response envelope.
    return !responseId || Boolean(this.activeResponseId && responseId === this.activeResponseId);
  }

  bind() {
    if (this.bound || !this.root) return;
    this.bound = true;
    this.element('realtimeVoiceLauncher')?.addEventListener('click', () => this.openCompanion());
    this.element('realtimeVoiceCollapseButton')?.addEventListener('click', () => this.collapseCompanion());
    this.element('realtimeVoiceBackdrop')?.addEventListener('click', () => this.collapseCompanion());
    this.element('realtimeVoiceStartButton')?.addEventListener('click', () => this.start());
    this.element('realtimeVoiceTurnButton')?.addEventListener('click', () => this.commitTurn());
    this.keydownHandler = (event) => {
      if (event.code !== 'Space' || event.repeat || !this.active) return;
      const target = event.target;
      const tag = String(target?.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select', 'button'].includes(tag) || target?.isContentEditable) return;
      if (document.body.classList.contains('dialog-open')) return;
      event.preventDefault();
      this.commitTurn();
    };
    window.addEventListener('keydown', this.keydownHandler);
    this.element('realtimeVoiceMuteButton')?.addEventListener('click', () => this.toggleMute());
    this.element('realtimeVoiceEndButton')?.addEventListener('click', () => this.end({ reason: 'user' }));
    this.element('realtimeVoiceResumeAudioButton')?.addEventListener('click', () => this.resumeAudio());
    this.element('realtimeVoiceFocusComposerButton')?.addEventListener('click', () => this.focusComposer());
    this.element('realtimeVoiceBoundedFallbackButton')?.addEventListener('click', () => this.focusBoundedVoice());
    this.element('realtimeVoiceReviewButton')?.addEventListener('click', () => this.reviewAndConfirm());
    this.element('realtimeVoiceTranscriptToggle')?.addEventListener('click', () => this.toggleTranscript());
    this.element('realtimeVoiceMicrophoneSelect')?.addEventListener('change', (event) => {
      this.selectMicrophone(event.currentTarget?.value || '');
    });
    this.element('realtimeVoiceRefreshDevicesButton')?.addEventListener('click', () => {
      if (this.active && this.microphoneRecoveryRequired) this.selectMicrophone('');
      else this.refreshMicrophones();
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', this.deviceChangeHandler);

    const form = document.getElementById('realtimeVoiceConsentForm');
    const cancel = document.getElementById('cancelRealtimeVoiceConsentButton');
    const dialog = document.getElementById('realtimeVoiceConsentDialog');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitConsent(form);
    });
    cancel?.addEventListener('click', () => this.closeConsentDialog());
    dialog?.addEventListener('cancel', (event) => {
      if (form?.querySelector('[type="submit"]')?.disabled) event.preventDefault();
    });
    dialog?.addEventListener('close', () => document.body.classList.remove('dialog-open'));

    window.addEventListener('pagehide', () => {
      this.end({ reason: 'pagehide', announce: false });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.end({ reason: 'hidden' });
        this.collapseCompanion({ restoreFocus: false });
      }
    });
    document.addEventListener('keydown', (event) => {
      if (!this.expanded || document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.collapseCompanion();
        return;
      }
      if (event.key === 'Tab') this.trapFocus(event);
    });
  }

  openCompanion({ focus = true } = {}) {
    if (!this.root || this.root.hidden) return;
    this.expanded = true;
    this.lastFocusedElement = document.activeElement || this.element('realtimeVoiceLauncher');
    const panel = this.element('realtimeVoiceShell');
    const backdrop = this.element('realtimeVoiceBackdrop');
    const launcher = this.element('realtimeVoiceLauncher');
    if (panel) panel.hidden = false;
    this.orb?.resize();
    if (backdrop) backdrop.hidden = false;
    if (launcher) launcher.setAttribute('aria-expanded', 'true');
    this.root.classList?.toggle?.('is-expanded', true);
    document.body?.classList?.toggle?.('realtime-companion-open', true);
    this.setBackgroundInert(true);
    if (focus) {
      window.requestAnimationFrame(() => {
        this.element('realtimeVoiceCollapseButton')?.focus?.({ preventScroll: true });
      });
    }
    this.refreshMicrophones();
  }

  collapseCompanion({ restoreFocus = true } = {}) {
    if (!this.root) return;
    this.expanded = false;
    const panel = this.element('realtimeVoiceShell');
    const backdrop = this.element('realtimeVoiceBackdrop');
    const launcher = this.element('realtimeVoiceLauncher');
    if (panel) panel.hidden = true;
    if (backdrop) backdrop.hidden = true;
    if (launcher) launcher.setAttribute('aria-expanded', 'false');
    this.root.classList?.toggle?.('is-expanded', false);
    document.body?.classList?.toggle?.('realtime-companion-open', false);
    this.setBackgroundInert(false);
    if (restoreFocus) {
      const target = this.lastFocusedElement?.isConnected === false
        ? launcher
        : (this.lastFocusedElement || launcher);
      window.requestAnimationFrame(() => target?.focus?.({ preventScroll: true }));
    }
  }

  setBackgroundInert(enabled) {
    if (enabled) {
      if (this.backgroundInertStates.size > 0) return;
      const targets = [
        document.querySelector?.('.plan-header'),
        document.getElementById?.('appRoot'),
        document.querySelector?.('.plan-footer'),
        this.element('realtimeVoiceLauncher')
      ].filter(Boolean);
      targets.forEach((target) => {
        const wasInert = target.inert === true || target.hasAttribute?.('inert') === true;
        this.backgroundInertStates.set(target, wasInert);
        target.inert = true;
        target.setAttribute?.('inert', '');
      });
      return;
    }
    this.backgroundInertStates.forEach((wasInert, target) => {
      target.inert = wasInert;
      if (!wasInert) target.removeAttribute?.('inert');
    });
    this.backgroundInertStates.clear();
  }

  trapFocus(event) {
    const panel = this.element('realtimeVoiceShell');
    if (!panel?.querySelectorAll) return;
    const focusable = [...panel.querySelectorAll(
      'button:not([disabled]):not([hidden]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"])'
    )].filter((element) => {
      if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
      const closedDetails = element.closest?.('details:not([open])');
      if (closedDetails && element !== closedDetails.querySelector?.(':scope > summary')) return false;
      if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false;
      return true;
    });
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (typeof panel.contains === 'function' && !panel.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  sync(currentState = state) {
    this.lastState = currentState;
    const context = realtimeContext();
    const shouldShow = context.eligible
      && Boolean(context.sessionId)
      && !context.consentRefreshRequired;
    if (this.root) this.root.hidden = !shouldShow;
    if (!shouldShow && this.active) {
      this.end({ reason: 'navigation', announce: false });
    }
    if (!shouldShow && this.expanded) this.collapseCompanion({ restoreFocus: false });
    this.updatePlanningContext(null, currentState);
    // The server owns the allowance while a meeting is live: it enforces the
    // dispatch stop and reports `budget_exhausted` on the lease when spend is
    // truly exhausted (handled in refreshLease). Never hang up an active call
    // from merged display-budget state — the open envelope reservation can
    // legitimately read as fully spent for the whole call.
    if (shouldShow && this.phase === 'off' && !this.statusText) {
      if (!context.configured) {
        this.statusText = 'Your meeting space is still being prepared. You can continue by typing for now.';
      } else if (!isRealtimeVoiceSupported()) {
        this.statusText = 'This browser cannot join a live meeting. You can continue by typing instead.';
      } else if (!context.consentGranted) {
        this.statusText = 'Press the button when you’re ready — we’ll show a short note before the meeting begins.';
      } else {
        this.statusText = 'Press the button when you’re ready to begin.';
      }
    }
    this.updateUi();
  }

  setPhase(phase, statusText = '', { error = '' } = {}) {
    this.phase = phase;
    this.statusText = String(statusText || '');
    const errorElement = this.element('realtimeVoiceError');
    if (errorElement) {
      const errorText = String(error || '');
      errorElement.textContent = errorText;
      // The main status is already announced and visible. Do not render the
      // exact same sentence a second time in the red error slot.
      errorElement.hidden = !errorText || errorText === this.statusText;
    }
    this.updateUi();
  }

  updateUi() {
    if (!this.root) return;
    const context = realtimeContext();
    const supported = isRealtimeVoiceSupported();
    const completionLocked = this.isCompletionLocked();
    const exhausted = context.budget.remainingMicroEur <= 0;
    const budgetLow = !exhausted && context.budget.remainingMicroEur <= context.lowBudgetMicroEur;
    const start = this.element('realtimeVoiceStartButton');
    const turn = this.element('realtimeVoiceTurnButton');
    const mute = this.element('realtimeVoiceMuteButton');
    const end = this.element('realtimeVoiceEndButton');
    const resume = this.element('realtimeVoiceResumeAudioButton');
    const typedFallback = this.element('realtimeVoiceFocusComposerButton');
    const orbLabel = this.element('realtimeVoiceOrbLabel');
    const micBadge = this.element('realtimeMicBadge');
    const status = this.element('realtimeVoiceStatus');
    const review = this.element('realtimeVoiceReviewButton');
    const launcher = this.element('realtimeVoiceLauncher');
    const launcherStatus = this.element('realtimeVoiceLauncherStatus');
    const panel = this.element('realtimeVoiceShell');
    const microphoneSelect = this.element('realtimeVoiceMicrophoneSelect');
    const refreshDevices = this.element('realtimeVoiceRefreshDevicesButton');

    if (!this.orb) {
      const canvas = this.element('realtimeVoiceOrbCanvas');
      if (canvas && panel) this.orb = new RealtimeOrb(canvas, { shell: panel });
    }

    [this.root, panel].filter(Boolean).forEach((element) => {
      element.dataset.realtimePhase = this.phase;
      element.dataset.budgetState = exhausted ? 'exhausted' : (budgetLow ? 'low' : 'available');
      element.classList.toggle('is-live', this.active);
      element.classList.toggle('is-muted', this.muted);
      element.classList.toggle('is-budget-low', budgetLow);
    });
    if (start) {
      start.disabled = this.active
        || context.journeyBusy
        || context.consentRefreshRequired
        || !context.configured
        || !supported
        || exhausted;
      start.setAttribute('aria-disabled', String(start.disabled));
    }
    if (turn) {
      turn.disabled = !this.active || this.welcomePending || completionLocked;
      turn.setAttribute('aria-disabled', String(turn.disabled));
    }
    if (orbLabel) {
      const labels = {
        connecting: 'Connecting…',
        listening: 'Listening',
        user_speaking: 'You’re speaking',
        thinking: 'Thinking',
        responding: 'Preparing to respond…',
        assistant_speaking: 'Planéir is speaking',
        interrupted: 'Listening',
        reconnecting: 'Reconnecting…',
        muted: 'Paused',
        audio_blocked: 'Paused',
        budget_exhausted: 'Meeting complete',
        error: 'Connection problem'
      };
      orbLabel.textContent = labels[this.phase] || 'Ready when you are';
    }
    if (mute) {
      mute.disabled = !this.active || this.welcomePending || completionLocked;
      mute.textContent = this.muted ? 'Unmute microphone' : 'Mute microphone';
      mute.setAttribute('aria-pressed', this.muted ? 'true' : 'false');
    }
    if (end) end.disabled = !this.active || completionLocked;
    if (resume && !this.active) resume.hidden = true;
    if (typedFallback) typedFallback.hidden = false;
    if (micBadge) {
      micBadge.textContent = this.active
        ? (this.welcomePending ? 'Mic starts after welcome' : (this.muted ? 'Mic muted' : 'Mic on'))
        : 'Mic off';
    }
    if (status) status.textContent = this.statusText || 'Press the button when you’re ready to begin.';
    if (launcher) {
      launcher.setAttribute('aria-label', this.active
        ? `Talk to Planéir, ${this.muted ? 'microphone muted' : 'voice active'}`
        : 'Talk to Planéir, private AI planning companion');
    }
    if (launcherStatus) {
      const launcherLabels = {
        connecting: 'Connecting…',
        listening: 'In a meeting · listening',
        user_speaking: 'In a meeting · hearing you',
        thinking: 'In a meeting · thinking',
        responding: 'Planéir is preparing to respond',
        assistant_speaking: 'Planéir is speaking',
        interrupted: 'In a meeting · listening',
        reconnecting: 'Reconnecting…',
        muted: 'Meeting paused',
        budget_exhausted: 'Meeting allowance used',
        error: 'Connection problem'
      };
      launcherStatus.textContent = launcherLabels[this.phase] || 'Your private planning meeting';
    }
    if (review) {
      const hasContext = (this.planningContext?.facts?.length || 0) > 0
        || (this.planningContext?.modules?.length || 0) > 0;
      review.hidden = false;
      review.disabled = completionLocked || !(this.planningContext?.readyForReview || hasContext);
    }
    if (microphoneSelect) microphoneSelect.disabled = this.deviceRefreshInFlight
      || this.microphoneSwitchInFlight
      || completionLocked
      || this.phase === 'connecting';
    if (refreshDevices) {
      refreshDevices.disabled = this.deviceRefreshInFlight
        || this.microphoneSwitchInFlight
        || completionLocked
        || this.phase === 'connecting';
      refreshDevices.textContent = this.active && this.microphoneRecoveryRequired
        ? 'Reconnect automatic microphone'
        : 'Refresh microphones';
    }
    this.renderMicrophoneState();

    const budgetValue = this.element('realtimeVoiceBudgetValue');
    const budgetMeter = this.element('realtimeVoiceBudgetMeter');
    if (budgetValue) budgetValue.textContent = `${formatEuroFromMicro(context.budget.remainingMicroEur)} remaining`;
    if (budgetMeter) {
      budgetMeter.max = Math.max(1, context.budget.limitMicroEur);
      budgetMeter.value = Math.min(context.budget.limitMicroEur, context.budget.remainingMicroEur);
      budgetMeter.setAttribute('aria-valuetext', `${formatEuroFromMicro(context.budget.remainingMicroEur)} Live voice allowance remaining`);
    }
    this.updateLeaseCountdown();
  }

  async start() {
    if (this.active) return;
    const context = realtimeContext();
    if (!context.eligible || !context.configured || !context.sessionId) {
      this.setPhase('error', 'Your meeting space is not available right now.', {
        error: 'The live meeting is unavailable. You can continue by typing.'
      });
      return;
    }
    if (!context.consentGranted) {
      this.openConsentDialog();
      return;
    }
    if (context.budget.remainingMicroEur <= 0) {
      this.setPhase('budget_exhausted', 'This session’s meeting allowance has been used. You can continue by typing.');
      return;
    }
    if (!isRealtimeVoiceSupported()) {
      this.setPhase('error', 'This browser cannot join a live meeting. You can continue by typing.', {
        error: 'Live audio is not supported in this browser.'
      });
      return;
    }

    this.onStopBoundedVoice();
    const generation = ++this.generation;
    this.active = true;
    this.muted = false;
    this.sessionId = context.sessionId;
    this.userDeltas.clear();
    this.assistantDeltas.clear();
    this.seenFinalItems.clear();
    this.playedSpeechIds.clear();
    this.transcriptHistory = [];
    this.completionSpeechId = '';
    this.completionNavigationInFlight = false;
    this.renderTranscriptHistory();
    this.setCaption('user', 'Your words will appear here while you speak.');
    this.setCaption('assistant', 'Planéir will welcome you in a moment.');
    this.setPhase('connecting', 'Connecting your private meeting…');
    const controller = new AbortController();
    this.startController = controller;

    let leaseId = '';
    const activationId = newRealtimePrivateId('rt_activation');
    const proposedControlCapability = newRealtimePrivateId('rt_control');
    let activationRequestSent = false;
    try {
      const stream = await this.openMicrophoneStream(this.selectedMicrophoneId, {
        signal: controller.signal
      });
      if (generation !== this.generation || controller.signal.aborted || !hasCurrentRealtimeVoiceConsent()) {
        stopTracks(stream);
        return;
      }
      this.localStream = stream;
      this.orb?.attachMicStream(stream);
      this.microphoneRecoveryRequired = false;
      this.monitorMicrophoneStream(stream, generation);
      await this.refreshMicrophones({ activeStream: stream });
      if (generation !== this.generation
        || controller.signal.aborted
        || !hasCurrentRealtimeVoiceConsent()) {
        if (this.localStream === stream) this.localStream = null;
        stopTracks(stream);
        return;
      }
      const PeerConnection = window.RTCPeerConnection;
      const peer = new PeerConnection();
      this.peerConnection = peer;
      this.bindPeerConnection(peer, generation);
      stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));

      const channel = peer.createDataChannel('oai-events');
      this.dataChannel = channel;
      this.bindDataChannel(channel, generation);

      const offer = await peer.createOffer({ offerToReceiveAudio: true });
      await peer.setLocalDescription(offer);
      const offerSdp = String(peer.localDescription?.sdp || offer.sdp || '');
      activationRequestSent = true;
      const response = await createRealtimeVoiceCall(context.sessionId, {
        sdp: offerSdp,
        idempotencyKey: newIdempotencyKey(),
        activationId,
        controlCapability: proposedControlCapability,
        signal: controller.signal
      });
      if (generation !== this.generation || controller.signal.aborted) return;
      const call = normaliseRealtimeCallResponse(response);
      if (!call.sdp.startsWith('v=0')) throw new Error('The service returned no valid Live voice answer.');
      if (!call.leaseId) throw new Error('The service returned no controllable Live voice lease.');
      if (call.activationId !== activationId) {
        throw new Error('The service returned a mismatched Live voice activation.');
      }
      if (call.controlCapability !== proposedControlCapability) {
        throw new Error('The service returned no authenticated Live voice control channel.');
      }
      leaseId = call.leaseId;
      this.leaseId = call.leaseId;
      this.controlCapability = call.controlCapability;
      this.conversationVersion = call.conversationVersion;
      this.setWelcomePending(call.conversationVersion === 'v2');
      if (call.payload) this.acceptServerPayload(call.payload);
      this.configureLeaseExpiry(call, context);
      await peer.setRemoteDescription({ type: 'answer', sdp: call.sdp });
      if (generation !== this.generation || controller.signal.aborted) return;
      this.setPhase(
        this.welcomePending ? 'thinking' : 'listening',
        this.welcomePending
          ? 'Planéir is about to welcome you. Your microphone will switch on afterwards.'
          : 'I’m listening — take your time.'
      );
      this.scheduleLeasePoll(1_500);
    } catch (error) {
      const sessionId = context.sessionId;
      let activationCleanupConfirmed = true;
      if (activationRequestSent && !leaseId && sessionId) {
        activationCleanupConfirmed = await this.cleanupLostActivation(
          sessionId,
          activationId,
          proposedControlCapability
        );
      }
      if (generation !== this.generation || controller.signal.aborted) return;
      const baseMessage = connectionErrorMessage(error);
      const message = activationCleanupConfirmed
        ? baseMessage
        : `${baseMessage} The meeting connection is still being closed automatically.`;
      const cleanupLeaseId = leaseId || this.leaseId;
      const cleanupControlCapability = this.controlCapability;
      this.cleanupLocal();
      if (cleanupLeaseId && sessionId) {
        deleteRealtimeVoiceCall(sessionId, cleanupLeaseId, {
          controlCapability: cleanupControlCapability
        }).then((payload) => {
          this.acceptServerPayload(payload);
        }).catch(() => {});
      }
      if (this.onSessionUnavailable(error)) return;
      // A stale voice disclosure must not dead-end the meeting. Clear the
      // outdated local consent and reopen the current disclosure so one tap
      // re-agrees and reconnects.
      if (error instanceof ConsumerApiError && error.code === 'realtime_consent_required') {
        clearRealtimeVoiceConsent();
        this.setPhase('off', 'The meeting notice was updated. Please review it again to continue.');
        this.openConsentDialog();
        return;
      }
      this.setPhase('error', `${message} You can try again or continue by typing.`, { error: message });
      this.onToast(message, { error: true, timeout: 7000 });
    } finally {
      if (this.startController === controller) this.startController = null;
    }
  }

  async cleanupLostActivation(sessionId, activationId, controlCapability) {
    for (const delay of [0, 400, 1_200]) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
      try {
        const result = await deleteRealtimeVoiceActivation(sessionId, activationId, {
          controlCapability
        });
        if (result?.cleanedUp === true && result?.providerHangupConfirmed === true) return true;
      } catch (_error) {
        // The cleanup route is idempotent, so an ambiguous network result can
        // be retried with the same activation capability.
      }
    }
    return false;
  }

  bindPeerConnection(peer, generation) {
    peer.addEventListener('track', (event) => {
      if (generation !== this.generation) return;
      if (this.conversationVersion !== 'v2') {
        // The v1 provider media channel stays silent; only authenticated
        // Worker-generated speech is audible on that rollback path.
        if (event.track) event.track.enabled = false;
        return;
      }
      const audio = this.element('realtimeVoiceAudio');
      const stream = event.streams?.[0];
      if (!audio || !stream) return;
      if (event.track) event.track.enabled = true;
      this.remoteAudioStream = stream;
      audio.srcObject = stream;
      this.orb?.attachRemoteStream(stream);
      audio.play?.().catch(() => {
        this.element('realtimeVoiceResumeAudioButton')?.removeAttribute('hidden');
      });
    });
    peer.addEventListener('connectionstatechange', () => {
      if (generation !== this.generation || !this.active) return;
      const connectionState = String(peer.connectionState || '');
      if (connectionState === 'connected') {
        if (this.disconnectTimer !== null) window.clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
        if (this.phase === 'connecting' || this.phase === 'reconnecting') {
          this.setPhase(
            this.welcomePending ? 'thinking' : (this.muted ? 'muted' : 'listening'),
            this.welcomePending
              ? 'Planéir is about to welcome you. Your microphone will switch on afterwards.'
              : this.muted
                ? 'Reconnected. Your microphone is still paused.'
                : 'I’m listening — take your time.'
          );
        }
        return;
      }
      if (connectionState === 'disconnected') {
        this.setPhase('reconnecting', 'The connection paused for a moment. Reconnecting…');
        if (this.disconnectTimer !== null) window.clearTimeout(this.disconnectTimer);
        this.disconnectTimer = window.setTimeout(() => {
          if (peer.connectionState === 'disconnected' && this.active) {
            this.end({ reason: 'connection_failed' });
          }
        }, CONNECTION_GRACE_MS);
        return;
      }
      if (connectionState === 'failed' || connectionState === 'closed') {
        this.end({ reason: 'connection_failed' });
      }
    });
  }

  async enumerateMicrophoneDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((device) => device.kind === 'audioinput');
    } catch (_error) {
      return [];
    }
  }

  async acquireMicrophoneStream(deviceId = '', { signal = null } = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: microphoneConstraints(deviceId)
    });
    if (signal?.aborted) {
      stopTracks(stream);
      throw microphoneAbortError();
    }
    return requireLiveMicrophoneStream(stream);
  }

  monitorMicrophoneStream(stream, generation = this.generation) {
    const track = stream?.getAudioTracks?.()[0] || null;
    track?.addEventListener?.('ended', () => {
      if (!this.active || generation !== this.generation || this.localStream !== stream) return;
      this.localStream = null;
      this.muted = true;
      this.microphoneRecoveryRequired = true;
      this.selectedMicrophoneId = '';
      stopTracks(stream);
      this.sendEvent({ type: 'input_audio_buffer.clear', event_id: newIdempotencyKey('microphone-ended') });
      const message = 'The microphone disconnected. Choose a source below, then unmute when you’re ready.';
      this.activeMicrophoneLabel = 'Microphone disconnected';
      this.setPhase('muted', message);
      this.onToast(message, { error: true, timeout: 7000 });
      Promise.resolve(this.refreshMicrophones({ activeStream: null })).finally(() => {
        if (!this.active || generation !== this.generation || this.localStream) return;
        this.activeMicrophoneLabel = 'Microphone disconnected';
        this.renderMicrophoneState();
      });
    }, { once: true });
  }

  setWelcomePending(pending) {
    this.welcomePending = pending === true && this.conversationVersion === 'v2';
    if (!this.welcomePending) this.welcomePlaybackStarted = false;
    const captureEnabled = this.active
      && !this.welcomePending
      && !this.muted
      && !this.microphoneRecoveryRequired;
    this.localStream?.getAudioTracks?.().forEach((track) => {
      track.enabled = captureEnabled;
    });
    this.updateUi();
  }

  async openMicrophoneStream(
    deviceId = this.selectedMicrophoneId,
    { allowAutomaticFallback = true, signal = null } = {}
  ) {
    const requested = cleanText(deviceId, 500);
    let devices = await this.enumerateMicrophoneDevices();
    this.microphoneDevices = devices;
    const saved = this.microphonePreference;
    const candidates = microphoneCandidates(devices);
    const requestedDevice = requested
      ? candidates.find((device) => device.deviceId === requested) || null
      : null;
    const savedDevice = findSavedMicrophone(devices, saved);
    const automaticDevice = findAutomaticMicrophone(devices);
    let target = requestedDevice;
    let targetUsesSavedPreference = false;

    if (!target && saved && (!requested || requested === saved.deviceId)) {
      target = savedDevice;
      targetUsesSavedPreference = Boolean(target);
    }
    if (!target && !requested) target = automaticDevice;

    const failedDeviceIds = new Set();
    if (target) {
      try {
        const stream = await this.acquireMicrophoneStream(target.deviceId, { signal });
        this.selectedMicrophoneId = target.deviceId;
        if (targetUsesSavedPreference && target.deviceId !== saved?.deviceId) {
          this.microphonePreference = {
            deviceId: target.deviceId,
            label: microphoneLabel(target)
          };
          writeMicrophonePreference(this.microphonePreference);
        }
        return stream;
      } catch (error) {
        if (!allowAutomaticFallback || !isMissingMicrophoneError(error)) throw error;
        failedDeviceIds.add(target.deviceId);
      }
    } else if (requested) {
      // Before permission is granted, some browsers return an incomplete device
      // list. Give an explicit saved/user selection one exact attempt before
      // treating it as unavailable.
      try {
        const stream = await this.acquireMicrophoneStream(requested, { signal });
        this.selectedMicrophoneId = requested;
        return stream;
      } catch (error) {
        if (!allowAutomaticFallback || !isMissingMicrophoneError(error)) throw error;
        failedDeviceIds.add(requested);
      }
    }

    const remainingDevices = devices.filter((device) => !failedDeviceIds.has(device.deviceId));
    if (hasUsableMicrophoneLabels(remainingDevices)) {
      const savedFallback = findSavedMicrophone(remainingDevices, saved);
      const fallback = savedFallback || findAutomaticMicrophone(remainingDevices);
      if (fallback) {
        const stream = await this.acquireMicrophoneStream(fallback.deviceId, { signal });
        this.selectedMicrophoneId = fallback.deviceId;
        if (saved && !savedFallback) {
          this.microphonePreference = null;
          writeMicrophonePreference(null);
        }
        if (requested && fallback.deviceId !== requested) {
          this.onToast(`That microphone is no longer available. Planéir will use ${microphoneLabel(fallback)}.`, {
            error: true,
            timeout: 5000
          });
        }
        return stream;
      }
    }

    // Device labels are normally withheld until the origin has microphone
    // permission. Open a short browser-selected permission stream, enumerate
    // again, then replace it with the deterministic laptop/saved choice before
    // the stream is ever attached to the meeting PeerConnection.
    const permissionStream = await this.acquireMicrophoneStream('', { signal });
    this.microphonePermissionStream = permissionStream;
    const stopPermissionOnAbort = () => stopTracks(permissionStream);
    signal?.addEventListener?.('abort', stopPermissionOnAbort, { once: true });
    try {
      if (signal?.aborted) throw microphoneAbortError();
      devices = await this.enumerateMicrophoneDevices();
      if (signal?.aborted) throw microphoneAbortError();
      this.microphoneDevices = devices;
      const postPermissionDevices = devices.filter((device) => !failedDeviceIds.has(device.deviceId));
      const savedAfterPermission = findSavedMicrophone(postPermissionDevices, saved);
      const preferredAfterPermission = savedAfterPermission || findAutomaticMicrophone(postPermissionDevices);
      const permissionTrack = permissionStream.getAudioTracks?.()[0] || null;
      const permissionDeviceId = cleanText(permissionTrack?.getSettings?.().deviceId, 500);
      const permissionLabel = cleanText(permissionTrack?.label, 120).toLowerCase();
      const preferredLabel = microphoneLabel(preferredAfterPermission).toLowerCase();
      const permissionAlreadyPreferred = preferredAfterPermission && (
        permissionDeviceId === preferredAfterPermission.deviceId
        || (permissionLabel && preferredLabel && permissionLabel === preferredLabel)
      );

      if (!preferredAfterPermission || permissionAlreadyPreferred) {
        this.selectedMicrophoneId = preferredAfterPermission?.deviceId
          || (['default', 'communications'].includes(permissionDeviceId.toLowerCase()) ? '' : permissionDeviceId);
        this.microphonePermissionStream = null;
        return permissionStream;
      }

      // Release the permission-only route before opening the exact source. Some
      // browsers and Continuity devices reject two simultaneous mic captures.
      stopTracks(permissionStream);
      this.microphonePermissionStream = null;
      const preferredStream = await this.acquireMicrophoneStream(preferredAfterPermission.deviceId, { signal });
      this.selectedMicrophoneId = preferredAfterPermission.deviceId;
      if (savedAfterPermission && preferredAfterPermission.deviceId !== saved?.deviceId) {
        this.microphonePreference = {
          deviceId: preferredAfterPermission.deviceId,
          label: microphoneLabel(preferredAfterPermission)
        };
        writeMicrophonePreference(this.microphonePreference);
      } else if (saved && !savedAfterPermission) {
        this.microphonePreference = null;
        writeMicrophonePreference(null);
      }
      if (requested && preferredAfterPermission.deviceId !== requested) {
        this.onToast(`That microphone is no longer available. Planéir will use ${microphoneLabel(preferredAfterPermission)}.`, {
          error: true,
          timeout: 5000
        });
      }
      return preferredStream;
    } catch (error) {
      stopTracks(permissionStream);
      throw error;
    } finally {
      signal?.removeEventListener?.('abort', stopPermissionOnAbort);
      if (this.microphonePermissionStream === permissionStream) {
        this.microphonePermissionStream = null;
      }
    }
  }

  async refreshMicrophones({ activeStream = this.localStream } = {}) {
    if (this.isCompletionLocked() || !navigator.mediaDevices?.enumerateDevices || this.deviceRefreshInFlight) return;
    this.deviceRefreshInFlight = true;
    this.renderMicrophoneState();
    try {
      this.microphoneDevices = await this.enumerateMicrophoneDevices();
      const activeTrack = activeStream?.getAudioTracks?.()[0] || null;
      const activeDeviceId = String(activeTrack?.getSettings?.().deviceId || '');
      const activeDevice = this.microphoneDevices.find((device) => device.deviceId === activeDeviceId);
      this.activeMicrophoneLabel = activeTrack
        ? cleanText(activeTrack.label || activeDevice?.label || 'Active microphone', 120)
        : '';
      const activeSelection = microphoneCandidates(this.microphoneDevices).find((device) => (
        device.deviceId === activeDeviceId
      ));
      const savedSelection = findSavedMicrophone(this.microphoneDevices, this.microphonePreference);
      const currentSelection = microphoneCandidates(this.microphoneDevices).find((device) => (
        device.deviceId === this.selectedMicrophoneId
      ));
      const automaticSelection = findAutomaticMicrophone(this.microphoneDevices);
      this.selectedMicrophoneId = this.microphoneRecoveryRequired && !activeTrack
        ? ''
        : (activeSelection?.deviceId
          || savedSelection?.deviceId
          || currentSelection?.deviceId
          || automaticSelection?.deviceId
          || '');
    } catch (_error) {
      this.microphoneDevices = [];
      this.activeMicrophoneLabel = activeStream?.getAudioTracks?.()[0]?.label || '';
    } finally {
      this.deviceRefreshInFlight = false;
      this.renderMicrophoneState();
    }
  }

  renderMicrophoneState() {
    const select = this.element('realtimeVoiceMicrophoneSelect');
    const status = this.element('realtimeVoiceDeviceStatus');
    const summary = this.element('realtimeVoiceDeviceSummary');
    if (select?.ownerDocument?.createElement) {
      const doc = select.ownerDocument;
      const options = [];
      const fallback = doc.createElement('option');
      fallback.value = '';
      fallback.textContent = 'Automatic (built-in preferred)';
      options.push(fallback);
      this.microphoneDevices.forEach((device, index) => {
        if (!device.deviceId || device.deviceId === 'default') return;
        const option = doc.createElement('option');
        option.value = device.deviceId;
        option.textContent = cleanText(device.label || `Microphone ${index + 1}`, 120);
        options.push(option);
      });
      select.replaceChildren(...options);
      select.value = this.selectedMicrophoneId;
    }
    const selectedDevice = this.microphoneDevices.find((device) => (
      device.deviceId === this.selectedMicrophoneId
    ));
    const selectedLabel = cleanText(selectedDevice?.label || '', 120);
    const displayLabel = this.activeMicrophoneLabel || selectedLabel || 'Automatic microphone';
    if (summary) summary.textContent = displayLabel;
    if (status) {
      status.textContent = this.deviceRefreshInFlight
        ? 'Checking available microphones…'
        : this.active
          ? this.welcomePending
            ? `Starts after Planéir’s welcome: ${displayLabel}`
            : `${this.muted ? 'Muted' : 'Using'}: ${displayLabel}`
          : selectedLabel
            ? `Ready to use: ${selectedLabel}`
            : this.microphoneDevices.length > 0
              ? 'Planéir will prefer this laptop’s built-in microphone. Choose another source if needed.'
              : 'Microphone names appear after browser permission is granted.';
    }
  }

  selectMicrophone(deviceId) {
    if (this.isCompletionLocked()) return Promise.resolve(false);
    const selected = cleanText(deviceId, 500);
    const queuedSwitch = this.microphoneSwitchTask
      .catch(() => {})
      .then(() => this.applyMicrophoneSelection(selected));
    this.microphoneSwitchTask = queuedSwitch;
    return queuedSwitch;
  }

  async applyMicrophoneSelection(selected) {
    if (selected === this.selectedMicrophoneId && !this.active) return;
    this.microphoneSwitchInFlight = true;
    this.updateUi();
    const previousSelectedMicrophoneId = this.selectedMicrophoneId;
    const previousMicrophonePreference = this.microphonePreference;
    const selectedDevice = this.microphoneDevices.find((device) => device.deviceId === selected);
    const proposedPreference = selected
      ? { deviceId: selected, label: microphoneLabel(selectedDevice) }
      : null;
    let replacementStream = null;
    this.selectedMicrophoneId = selected;
    this.renderMicrophoneState();
    try {
      if (!this.active || !this.peerConnection) {
        this.microphonePreference = proposedPreference;
        writeMicrophonePreference(proposedPreference);
        return;
      }
      // Use the newly selected mode for acquisition, but do not persist it until
      // the outbound track has actually been replaced.
      this.microphonePreference = proposedPreference;
      const generation = this.generation;
      const nextStream = await this.openMicrophoneStream(selected, {
        allowAutomaticFallback: selected === ''
      });
      replacementStream = nextStream;
      if (!this.active || generation !== this.generation) {
        stopTracks(nextStream);
        this.selectedMicrophoneId = previousSelectedMicrophoneId;
        this.microphonePreference = previousMicrophonePreference;
        return;
      }
      const nextTrack = nextStream.getAudioTracks?.()[0];
      const sender = this.peerConnection.getSenders?.().find((candidate) => candidate.track?.kind === 'audio');
      if (!nextTrack || !sender?.replaceTrack) {
        throw new Error('This browser cannot switch microphones during a meeting.');
      }
      nextTrack.enabled = !this.muted && !this.welcomePending;
      await sender.replaceTrack(nextTrack);
      if (!this.active || generation !== this.generation) {
        stopTracks(nextStream);
        replacementStream = null;
        try { await sender.replaceTrack(null); } catch (_error) { /* best-effort stale sender cleanup */ }
        this.selectedMicrophoneId = previousSelectedMicrophoneId;
        this.microphonePreference = previousMicrophonePreference;
        return;
      }
      const previousStream = this.localStream;
      this.localStream = nextStream;
      this.orb?.attachMicStream(nextStream);
      this.microphoneRecoveryRequired = false;
      this.monitorMicrophoneStream(nextStream, generation);
      replacementStream = null;
      stopTracks(previousStream);
      const confirmedDevice = this.microphoneDevices.find((device) => device.deviceId === selected);
      this.microphonePreference = selected
        ? { deviceId: selected, label: microphoneLabel(confirmedDevice) || proposedPreference?.label || '' }
        : null;
      writeMicrophonePreference(this.microphonePreference);
      await this.refreshMicrophones({ activeStream: nextStream });
      if (!this.active || generation !== this.generation) return;
      if (MICROPHONE_ORTHOGONAL_PHASES.has(this.phase)) {
        this.updateUi();
      } else {
        this.setPhase(this.muted ? 'muted' : 'listening', this.muted
          ? `Microphone changed to ${this.activeMicrophoneLabel || 'the selected source'} and remains muted.`
          : `Microphone changed to ${this.activeMicrophoneLabel || 'the selected source'}. I’m listening.`);
      }
    } catch (error) {
      stopTracks(replacementStream);
      this.selectedMicrophoneId = previousSelectedMicrophoneId;
      this.microphonePreference = previousMicrophonePreference;
      writeMicrophonePreference(previousMicrophonePreference);
      const message = connectionErrorMessage(error);
      this.onToast(message, { error: true, timeout: 6000 });
      await this.refreshMicrophones();
    } finally {
      this.microphoneSwitchInFlight = false;
      this.updateUi();
    }
  }

  bindDataChannel(channel, generation) {
    channel.addEventListener('open', () => {
      if (generation !== this.generation || !this.active) return;
      if (this.phase === 'connecting') {
        this.setPhase(
          this.welcomePending ? 'thinking' : 'listening',
          this.welcomePending
            ? 'Planéir is about to welcome you. Your microphone will switch on afterwards.'
            : 'I’m listening — take your time.'
        );
      }
    });
    channel.addEventListener('message', (event) => {
      if (generation !== this.generation || !this.active) return;
      const payload = parseJson(event.data);
      if (payload) this.handleRealtimeEvent(payload);
    });
    channel.addEventListener('close', () => {
      if (generation === this.generation && this.active && this.peerConnection?.connectionState !== 'closed') {
        this.setPhase('reconnecting', 'The connection hiccupped. Checking your meeting…');
        this.scheduleLeasePoll(0);
      }
    });
  }

  handleRealtimeEvent(rawEvent) {
    const event = classifyRealtimeEvent(rawEvent);
    switch (event.kind) {
      case 'speech_started':
        {
          this.awaitingWorkerSpeech = false;
          const wasSpeaking = Boolean(this.currentControlledSpeech);
          if (wasSpeaking) this.stopControlledSpeech({ interrupted: true });
          if (this.responseInProgress || wasSpeaking) {
          // The reviewed provider session owns interruption through semantic
          // VAD (`interrupt_response: true`). Sending a second browser-side
          // cancel races the sideband event stream and can turn a normal
          // barge-in into a provider error.
          this.responseInProgress = false;
          this.activeResponseId = '';
          if (this.interruptTimer !== null) window.clearTimeout(this.interruptTimer);
          this.setPhase('interrupted', 'Planéir stopped speaking. Listening to you now…');
          this.interruptTimer = window.setTimeout(() => {
            this.interruptTimer = null;
            if (this.active && this.phase === 'interrupted') {
              this.setPhase('user_speaking', 'Listening to you… Tap the circle or press space when you’ve finished.');
            }
          }, 650);
            return;
          }
        }
        this.setPhase('user_speaking', 'Listening to you… Tap the circle or press space when you’ve finished.');
        return;
      case 'speech_stopped':
        if (this.interruptTimer !== null) window.clearTimeout(this.interruptTimer);
        this.interruptTimer = null;
        this.setPhase('thinking', 'Planéir is thinking…');
        return;
      case 'user_delta':
        this.appendCaptionDelta('user', event.itemId, event.text);
        return;
      case 'user_final':
        if (!event.text) {
          this.awaitingWorkerSpeech = false;
          this.setPhase(this.muted ? 'muted' : 'listening', this.muted
            ? 'I didn’t catch that. Unmute or choose another microphone, then try again.'
            : 'I didn’t catch that — one moment.');
          // The server re-speaks a line that was cancelled by a false
          // interruption; poll immediately so the recovery plays promptly.
          this.scheduleLeasePoll(0);
          return;
        }
        this.finalizeCaption('user', event.itemId, event.text);
        if (this.conversationVersion === 'v2' && isLikelyIncompleteVoiceCaption(event.text)) {
          this.setPhase('listening', 'Take your time — finish that thought when you’re ready.');
          this.scheduleLeasePoll(0);
          return;
        }
        this.setPhase('thinking', 'Planéir is thinking…');
        this.scheduleLeasePoll(0);
        return;
      case 'response_started':
        if (event.responseId) this.activeResponseId = event.responseId;
        this.responseInProgress = true;
        this.awaitingWorkerSpeech = this.conversationVersion !== 'v2';
        this.assistantDeltas.clear();
        this.setCaption('assistant', 'Planéir is thinking…');
        this.setPhase('thinking', 'Planéir is thinking…');
        return;
      case 'assistant_delta':
        if (this.conversationVersion !== 'v2') {
          this.handleUnauthorizedProviderOutput();
          return;
        }
        if (!this.ownsRealtimeResponseEvent(event)) return;
        this.appendCaptionDelta('assistant', event.itemId, event.text);
        this.setPhase('assistant_speaking', this.welcomePending
          ? 'Planéir is welcoming you. Your microphone will switch on when he finishes.'
          : 'Planéir is speaking… You can interrupt naturally.');
        return;
      case 'assistant_audio':
        if (this.conversationVersion !== 'v2') {
          this.handleUnauthorizedProviderOutput();
          return;
        }
        if (!this.ownsRealtimeResponseEvent(event)) return;
        this.awaitingWorkerSpeech = false;
        this.setPhase('assistant_speaking', this.welcomePending
          ? 'Planéir is welcoming you. Your microphone will switch on when he finishes.'
          : 'Planéir is speaking… You can interrupt naturally.');
        return;
      case 'assistant_playback_started':
        if (this.conversationVersion === 'v2' && this.welcomePending) {
          this.welcomePlaybackStarted = true;
          this.setPhase('assistant_speaking', 'Planéir is welcoming you. Your microphone will switch on when he finishes.');
        }
        return;
      case 'assistant_playback_stopped':
        if (this.conversationVersion === 'v2' && this.welcomePending) {
          this.setWelcomePending(false);
          if (!this.responseInProgress && !['user_speaking', 'interrupted'].includes(this.phase)) {
            this.setPhase(this.muted ? 'muted' : 'listening', this.muted
              ? 'Your microphone is paused. Unmute when you’re ready to continue.'
              : 'I’m listening — take your time.');
          }
        }
        return;
      case 'assistant_final':
        if (this.conversationVersion !== 'v2') {
          this.handleUnauthorizedProviderOutput();
          return;
        }
        if (!this.ownsRealtimeResponseEvent(event)) return;
        this.awaitingWorkerSpeech = false;
        this.finalizeCaption('assistant', event.itemId, event.text);
        return;
      case 'assistant_audio_failed':
        if (this.conversationVersion !== 'v2') {
          this.handleProviderError(event.event);
          return;
        }
        if (!this.ownsRealtimeResponseEvent(event)) return;
        this.awaitingWorkerSpeech = true;
        this.setPhase('thinking', 'Switching to the backup voice…');
        this.scheduleLeasePoll(0);
        return;
      case 'tool_running':
        this.awaitingWorkerSpeech = true;
        this.setPhase('thinking', 'Planéir is noting that down…');
        return;
      case 'planning_update':
        {
          const planningUpdate = asObject(event.payload) || {};
          const isFinalToolOutput = [
            'conversation.item.created',
            'conversation.item.added',
            'conversation.item.done'
          ].includes(event.type) && event.event?.item?.type === 'function_call_output';
          if (asObject(planningUpdate.assistantSpeech) && !this.currentControlledSpeech) {
            // A provider-mirrored tool output is only a hint that authenticated
            // Worker speech is pending. Playback still requires the separate
            // realtimeControl payload fetched with the control capability.
            this.awaitingWorkerSpeech = true;
          } else if (isFinalToolOutput) {
            // A final function result without assistantSpeech is explicit: the
            // Worker either chose silence (wait_for_user) or could not authorize
            // spoken output. Do not leave the orb waiting forever for a control
            // message that will never exist.
            this.awaitingWorkerSpeech = false;
            if (!this.responseInProgress
              && !this.currentControlledSpeech
              && !['user_speaking', 'interrupted'].includes(this.phase)) {
              this.setPhase(this.muted ? 'muted' : 'listening', this.muted
                ? 'Your microphone is paused. Unmute when you’re ready to continue.'
                : 'I’m listening — take your time.');
            }
          }
          this.updatePlanningContext(event.payload, this.lastState);
        }
        this.scheduleLeasePoll(0);
        return;
      case 'response_done':
        if (!this.ownsRealtimeResponseEvent(event)) return;
        this.responseInProgress = false;
        this.activeResponseId = '';
        if (this.conversationVersion === 'v2') {
          this.awaitingWorkerSpeech = false;
          // WebRTC emits output_audio_buffer.stopped after buffered playback
          // finishes. Keep the microphone gated until then when playback was
          // observed; response.done remains the compatibility fallback.
          if (!this.welcomePlaybackStarted) this.setWelcomePending(false);
        }
        if (this.welcomePending) {
          this.setPhase('assistant_speaking', 'Planéir is welcoming you. Your microphone will switch on when he finishes.');
        } else if (!this.currentControlledSpeech
          && !this.awaitingWorkerSpeech
          && !['user_speaking', 'interrupted'].includes(this.phase)) {
          this.setPhase(this.muted ? 'muted' : 'listening', this.muted
            ? 'Your microphone is paused. Unmute when you’re ready to continue.'
            : 'I’m listening — take your time.');
        } else if (!this.currentControlledSpeech
          && !['user_speaking', 'interrupted'].includes(this.phase)) {
          this.setPhase('thinking', 'Planéir is preparing a response…');
        }
        this.scheduleLeasePoll(0);
        return;
      case 'error':
        this.handleProviderError(event.event);
        return;
      default:
        return;
    }
  }

  handleUnauthorizedProviderOutput() {
    if (!this.active) return;
    this.stopControlledSpeech();
    this.end({ reason: 'unauthorized_output', announce: false }).finally(() => {
      this.setPhase('error', 'Live voice closed because an unapproved provider response was blocked.', {
        error: 'Only Worker-approved Planéir speech can be played.'
      });
    });
  }

  ownsControlledSpeechPlayback({ audio, controller, generation, leaseId, speechId }) {
    return Boolean(
      audio
      && controller
      && !controller.signal.aborted
      && this.active
      && generation === this.generation
      && leaseId === this.leaseId
      && this.controlledSpeechController === controller
      && this.currentControlledSpeech?.speechId === speechId
      && this.element('realtimeVoiceAudio') === audio
    );
  }

  async playWorkerSpeechFromPayload(payload) {
    const root = unwrap(payload);
    const control = asObject(root.realtimeControl);
    const speech = control?.type === 'authorized_speech'
      ? asObject(control.assistantSpeech)
      : null;
    if (!speech || !this.active || !this.sessionId || !this.leaseId) return;
    const speechId = cleanText(speech.speechId, 100);
    const text = typeof speech.text === 'string' ? speech.text : '';
    if (!/^speech_[A-Za-z0-9_-]{20,80}$/.test(speechId)
      || !text
      || text !== text.trim()
      || text.length > 2_400
      || this.playedSpeechIds.has(speechId)) return;
    this.awaitingWorkerSpeech = false;
    this.playedSpeechIds.add(speechId);
    this.stopControlledSpeech();
    const controller = new AbortController();
    const generation = this.generation;
    const leaseId = this.leaseId;
    this.controlledSpeechController = controller;
    this.currentControlledSpeech = { speechId, text, loading: true };
    this.setPhase('responding', 'Planéir is preparing to respond…');
    try {
      const result = await speakRealtimeAuthorized(
        this.sessionId,
        leaseId,
        speech,
        {
          signal: controller.signal,
          controlCapability: this.controlCapability
        }
      );
      if (controller.signal.aborted
        || generation !== this.generation
        || !this.active
        || leaseId !== this.leaseId) return;
      const returnedSpeechId = headerValue(result.headers, ['X-Realtime-Speech-Id']);
      if (returnedSpeechId !== speechId
        || !String(result.contentType || '').toLowerCase().startsWith('audio/')) {
        throw new Error('The approved speech response could not be verified.');
      }
      // The Worker response authenticates the exact text independently of
      // audio decode/playback. Keep that caption visible if audio later fails.
      this.finalizeWorkerSpeech(speechId, text);
      const budget = budgetFromHeaders(result.headers);
      if (budget) this.onVoicePayload({ realtimeVoiceBudget: budget });
      const audio = this.element('realtimeVoiceAudio');
      if (!audio || typeof window.URL?.createObjectURL !== 'function') {
        throw new Error('Approved voice playback is unavailable in this browser.');
      }
      audio.srcObject = null;
      audio.muted = false;
      await this.attachControlledSpeechAudio({ result, audio, controller, speechId });
      if (controller.signal.aborted
        || generation !== this.generation
        || !this.active
        || leaseId !== this.leaseId
        || this.controlledSpeechController !== controller
        || this.currentControlledSpeech?.speechId !== speechId) {
        controller.abort('controlled_speech_stale');
        return;
      }
      audio.onended = () => this.finishControlledSpeech(speechId);
      audio.onerror = () => this.finishControlledSpeech(speechId, { error: true });
      this.currentControlledSpeech = { speechId, text, loading: false };
      try {
        await audio.play();
        if (!this.ownsControlledSpeechPlayback({
          audio,
          controller,
          generation,
          leaseId,
          speechId
        })) return;
        this.setPhase('assistant_speaking', 'Planéir is speaking — feel free to interrupt at any time.');
        audio.dataset.controlledSpeechId = speechId;
        audio.dataset.controlledSpeechPlayed = 'true';
        const resume = this.element('realtimeVoiceResumeAudioButton');
        if (resume) resume.hidden = true;
      } catch (_error) {
        if (!this.ownsControlledSpeechPlayback({
          audio,
          controller,
          generation,
          leaseId,
          speechId
        })) return;
        const resume = this.element('realtimeVoiceResumeAudioButton');
        if (resume) resume.hidden = false;
        this.setPhase('responding', 'The approved caption is ready. Press Play voice audio if your browser paused it.');
      }
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return;
      this.stopControlledSpeech();
      const message = error instanceof ConsumerApiError
        ? error.message
        : 'The approved spoken response could not be played. Continue with the visible journey.';
      this.setPhase('error', message, { error: message });
    } finally {
      if (this.controlledSpeechController === controller
        && this.currentControlledSpeech?.speechId !== speechId) {
        this.controlledSpeechController = null;
      }
    }
  }

  async attachControlledSpeechAudio({ result, audio, controller, speechId }) {
    const contentType = String(result.contentType || 'audio/mpeg').split(';')[0].trim().toLowerCase();
    const stream = result.stream && typeof result.stream.getReader === 'function'
      ? result.stream
      : null;
    const MediaSourceConstructor = window.MediaSource;
    const canStream = stream
      && typeof MediaSourceConstructor === 'function'
      && typeof MediaSourceConstructor.isTypeSupported === 'function'
      && MediaSourceConstructor.isTypeSupported(contentType);
    if (!canStream) {
      const blob = result.blob instanceof Blob
        ? result.blob
        : await new Response(stream, { headers: { 'Content-Type': contentType } }).blob();
      if (controller.signal.aborted) throw new Error('Approved speech playback was cancelled.');
      this.controlledSpeechUrl = window.URL.createObjectURL(blob);
      audio.src = this.controlledSpeechUrl;
      return;
    }

    const mediaSource = new MediaSourceConstructor();
    this.controlledSpeechMediaSource = mediaSource;
    this.controlledSpeechUrl = window.URL.createObjectURL(mediaSource);
    audio.src = this.controlledSpeechUrl;
    try {
      await this.waitForMediaSourceOpen(mediaSource, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw error;
      this.releaseControlledSpeechUrl();
      audio.removeAttribute?.('src');
      const blob = await new Response(stream, { headers: { 'Content-Type': contentType } }).blob();
      if (controller.signal.aborted) throw new Error('Approved speech playback was cancelled.');
      this.controlledSpeechUrl = window.URL.createObjectURL(blob);
      audio.src = this.controlledSpeechUrl;
      return;
    }
    if (controller.signal.aborted) throw new Error('Approved speech playback was cancelled.');
    const sourceBuffer = mediaSource.addSourceBuffer(contentType);
    const reader = stream.getReader();
    this.controlledSpeechReader = reader;
    const first = await reader.read();
    if (first.done || !(first.value instanceof Uint8Array) || first.value.byteLength < 1) {
      throw new Error('The approved speech response was empty.');
    }
    await this.appendMediaSourceChunk(sourceBuffer, first.value, controller.signal);
    const task = (async () => {
      try {
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) {
            if (mediaSource.readyState === 'open') mediaSource.endOfStream();
            return;
          }
          await this.appendMediaSourceChunk(sourceBuffer, chunk.value, controller.signal);
        }
      } catch (_error) {
        if (!controller.signal.aborted && this.currentControlledSpeech?.speechId === speechId) {
          this.finishControlledSpeech(speechId, { error: true });
        }
      } finally {
        if (this.controlledSpeechReader === reader) this.controlledSpeechReader = null;
        if (this.controlledSpeechStreamTask === task) this.controlledSpeechStreamTask = null;
      }
    })();
    this.controlledSpeechStreamTask = task;
  }

  waitForMediaSourceOpen(mediaSource, signal) {
    if (signal.aborted) return Promise.reject(new Error('Approved speech playback was cancelled.'));
    if (mediaSource.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Approved speech streaming took too long to start.'));
      }, 10_000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        mediaSource.removeEventListener('sourceopen', onOpen);
        mediaSource.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('Approved speech streaming could not start.')); };
      const onAbort = () => { cleanup(); reject(new Error('Approved speech playback was cancelled.')); };
      mediaSource.addEventListener('sourceopen', onOpen, { once: true });
      mediaSource.addEventListener('error', onError, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  appendMediaSourceChunk(sourceBuffer, chunk, signal) {
    if (signal.aborted) return Promise.reject(new Error('Approved speech playback was cancelled.'));
    if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Approved speech streaming stalled.'));
      }, 10_000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        sourceBuffer.removeEventListener('updateend', onUpdateEnd);
        sourceBuffer.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const onUpdateEnd = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('Approved speech streaming stopped.')); };
      const onAbort = () => { cleanup(); reject(new Error('Approved speech playback was cancelled.')); };
      sourceBuffer.addEventListener('updateend', onUpdateEnd, { once: true });
      sourceBuffer.addEventListener('error', onError, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        sourceBuffer.appendBuffer(chunk);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  finishControlledSpeech(speechId, { error = false } = {}) {
    if (this.currentControlledSpeech?.speechId !== speechId) return;
    this.awaitingWorkerSpeech = false;
    const approvedText = this.currentControlledSpeech.text;
    if (error) {
      this.controlledSpeechController?.abort('controlled_speech_error');
      this.controlledSpeechReader?.cancel('controlled_speech_error').catch(() => {});
    }
    this.controlledSpeechController = null;
    this.controlledSpeechReader = null;
    this.controlledSpeechMediaSource = null;
    this.controlledSpeechStreamTask = null;
    this.currentControlledSpeech = null;
    this.releaseControlledSpeechUrl();
    this.restoreRealtimeAudioStream();
    if (speechId === this.completionSpeechId) {
      void this.completeSpokenMeeting();
      return;
    }
    if (error) {
      this.setCaption('assistant', approvedText);
      this.setPhase('error', 'The approved audio stopped unexpectedly. Continue with the written journey.', {
        error: 'Approved voice playback stopped.'
      });
      return;
    }
    this.setCaption('assistant', '…');
    this.setPhase(this.muted ? 'muted' : 'listening', this.muted
      ? 'Your microphone is paused. Unmute when you’re ready to continue.'
      : 'I’m listening — take your time.');
  }

  releaseControlledSpeechUrl() {
    if (this.controlledSpeechUrl && typeof window.URL?.revokeObjectURL === 'function') {
      window.URL.revokeObjectURL(this.controlledSpeechUrl);
    }
    this.controlledSpeechUrl = '';
    this.controlledSpeechMediaSource = null;
  }

  restoreRealtimeAudioStream() {
    if (!this.active || this.conversationVersion !== 'v2' || !this.remoteAudioStream) return;
    const audio = this.element('realtimeVoiceAudio');
    if (!audio) return;
    audio.removeAttribute?.('src');
    audio.srcObject = this.remoteAudioStream;
    this.orb?.attachRemoteStream(this.remoteAudioStream);
    audio.play?.().catch(() => {
      this.element('realtimeVoiceResumeAudioButton')?.removeAttribute('hidden');
    });
  }

  stopControlledSpeech({ interrupted = false } = {}) {
    this.controlledSpeechController?.abort('controlled_speech_stopped');
    this.controlledSpeechController = null;
    this.controlledSpeechReader?.cancel('controlled_speech_stopped').catch(() => {});
    this.controlledSpeechReader = null;
    this.controlledSpeechStreamTask = null;
    const audio = this.element('realtimeVoiceAudio');
    if (audio) {
      try { audio.pause(); } catch (_error) { /* noop */ }
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute?.('src');
      delete audio.dataset?.controlledSpeechId;
      delete audio.dataset?.controlledSpeechPlayed;
      audio.srcObject = null;
    }
    this.releaseControlledSpeechUrl();
    this.currentControlledSpeech = null;
    this.restoreRealtimeAudioStream();
    if (interrupted) this.setCaption('assistant', 'Interrupted. Listening to you…');
  }

  appendCaptionDelta(role, itemId, delta) {
    const text = cleanText(delta);
    if (!text) return;
    const map = role === 'user' ? this.userDeltas : this.assistantDeltas;
    const current = String(map.get(itemId) || '');
    const combined = cleanText(`${current}${text}`, MAX_CAPTION_LENGTH);
    map.set(itemId, combined);
    this.setCaption(role, combined);
  }

  finalizeCaption(role, itemId, finalText) {
    const map = role === 'user' ? this.userDeltas : this.assistantDeltas;
    const text = cleanText(finalText || map.get(itemId));
    map.delete(itemId);
    if (!text) return;
    const key = `${role}:${itemId}:${text}`;
    if (this.seenFinalItems.has(key)) return;
    this.seenFinalItems.add(key);
    this.transcriptHistory.push({ role, text });
    const removed = Math.max(0, this.transcriptHistory.length - MAX_TRANSCRIPT_ITEMS);
    if (removed > 0) this.transcriptHistory.splice(0, removed);
    this.appendTranscriptHistoryItem({ role, text }, removed);
    this.setCaption(role, role === 'user'
      ? '…'
      : '…');
  }

  finalizeWorkerSpeech(speechId, text) {
    const key = `assistant:${speechId}:${text}`;
    if (this.seenFinalItems.has(key)) return;
    this.seenFinalItems.add(key);
    this.transcriptHistory.push({ role: 'assistant', text });
    const removed = Math.max(0, this.transcriptHistory.length - MAX_TRANSCRIPT_ITEMS);
    if (removed > 0) this.transcriptHistory.splice(0, removed);
    this.appendTranscriptHistoryItem({ role: 'assistant', text }, removed);
    const caption = this.element('realtimeVoiceAssistantCaption');
    if (caption) caption.textContent = text;
  }

  setCaption(role, text) {
    const element = this.element(role === 'user'
      ? 'realtimeVoiceUserCaption'
      : 'realtimeVoiceAssistantCaption');
    if (element) element.textContent = cleanText(text) || '…';
  }

  renderTranscriptHistory() {
    const list = this.element('realtimeVoiceTranscriptHistory');
    if (!list) return;
    const doc = list.ownerDocument || document;
    const fragment = doc.createDocumentFragment();
    this.transcriptHistory.forEach((item) => {
      const row = doc.createElement('li');
      row.className = `realtime-history-item is-${item.role}`;
      const label = doc.createElement('span');
      label.textContent = item.role === 'user' ? 'You' : 'Planéir voice · AI';
      const text = doc.createElement('p');
      text.textContent = item.text;
      row.append(label, text);
      fragment.append(row);
    });
    list.replaceChildren(fragment);
    list.scrollTop = list.scrollHeight;
  }

  appendTranscriptHistoryItem(item, removeCount = 0) {
    const list = this.element('realtimeVoiceTranscriptHistory');
    if (!list) return;
    for (let index = 0; index < removeCount; index += 1) list.firstElementChild?.remove();
    const doc = list.ownerDocument || document;
    const row = doc.createElement('li');
    row.className = `realtime-history-item is-${item.role}`;
    const label = doc.createElement('span');
    label.textContent = item.role === 'user' ? 'You' : 'Planéir voice · AI';
    const text = doc.createElement('p');
    text.textContent = item.text;
    row.append(label, text);
    list.append(row);
    list.scrollTop = list.scrollHeight;
  }

  updatePlanningContext(payload, currentState = state) {
    if (payload) this.planningContext = extractRealtimePlanningContext(payload, currentState);
    if (!this.planningContext || !this.active) {
      this.planningContext = extractRealtimePlanningContext({}, currentState);
    }
    const facts = this.planningContext.facts || [];
    const modules = this.planningContext.modules || [];
    const factCount = this.element('realtimeVoiceFactsValue');
    const moduleCount = this.element('realtimeVoiceModulesValue');
    if (factCount) factCount.textContent = String(facts.length);
    if (moduleCount) moduleCount.textContent = String(Math.min(modules.length, 3));
    this.renderContextList(this.element('realtimeVoiceFactsList'), facts.slice(0, 6), {
      empty: 'Proposed facts will appear here as we talk.',
      type: 'fact'
    });
    this.renderContextList(this.element('realtimeVoiceModulesList'), modules.slice(0, 3), {
      empty: 'Relevant Planéir analyses will appear here.',
      type: 'module'
    });
    const narrative = this.element('realtimeVoiceNarrative');
    const nextNeed = this.element('realtimeVoiceNextNeed');
    const planStatus = this.element('realtimeVoicePlanStatus');
    if (narrative) {
      narrative.textContent = this.planningContext.narrativeSummary
        || 'I’ll build a short, reviewable picture of what matters to you as we talk.';
    }
    if (nextNeed) {
      const objective = this.planningContext.nextObjective;
      const labels = Array.isArray(objective?.facts)
        ? objective.facts.slice(0, 2).map((item) => humanise(item?.factId || '')).filter(Boolean)
        : [];
      nextNeed.textContent = labels.length
        ? `${labels.join(' and ')}${objective?.reason ? ` — ${cleanText(objective.reason, 220)}` : ''}`
        : 'Nothing else is currently required for the selected analyses.';
    }
    if (planStatus) {
      const progress = this.planningContext.progress;
      planStatus.textContent = progress?.readyToConfirm
        ? 'Ready for your visual review and confirmation.'
        : 'Provisional — the analysis plan may update transparently as your goals or facts change.';
    }
    this.updateUi();
  }

  renderContextList(list, items, { empty, type }) {
    if (!list) return;
    if (type === 'module') {
      this.renderModuleSlots(list, items);
      return;
    }
    const doc = list.ownerDocument || document;
    const fragment = doc.createDocumentFragment();
    if (items.length === 0) {
      const row = doc.createElement('li');
      row.className = 'is-empty';
      row.textContent = empty;
      fragment.append(row);
    } else {
      items.forEach((item) => {
        const row = doc.createElement('li');
        const copy = doc.createElement('div');
        const label = doc.createElement('strong');
        label.textContent = item.label;
        copy.append(label);
        const detailValue = type === 'fact' ? item.value : item.reason;
        if (detailValue) {
          const detail = doc.createElement('span');
          detail.textContent = detailValue;
          copy.append(detail);
        }
        const badge = doc.createElement('span');
        badge.className = `realtime-context-badge is-${item.badge.key}`;
        badge.textContent = item.badge.label;
        row.append(copy, badge);
        fragment.append(row);
      });
    }
    list.replaceChildren(fragment);
  }

  renderModuleSlots(list, items) {
    const doc = list.ownerDocument || document;
    const fragment = doc.createDocumentFragment();
    const placeholders = [
      'Listening for your goals…',
      'Listening for your life stage…',
      'Listening for your priorities…'
    ];
    for (let index = 0; index < 3; index += 1) {
      const item = items[index];
      const row = doc.createElement('li');
      row.className = `is-module-slot${item ? '' : ' is-empty'}`;
      const slot = doc.createElement('span');
      slot.className = 'realtime-module-slot-number';
      slot.textContent = String(index + 1);
      const copy = doc.createElement('div');
      const label = doc.createElement('strong');
      label.textContent = item?.label || placeholders[index];
      copy.append(label);
      if (item?.reason) {
        const detail = doc.createElement('span');
        detail.textContent = item.reason;
        copy.append(detail);
      }
      row.append(slot, copy);
      if (item?.badge) {
        const badge = doc.createElement('span');
        badge.className = `realtime-context-badge is-${item.badge.key}`;
        badge.textContent = item.badge.label;
        row.append(badge);
      }
      fragment.append(row);
    }
    list.replaceChildren(fragment);
  }

  handleProviderError(event) {
    this.awaitingWorkerSpeech = false;
    const eventType = String(event?.type || '').toLowerCase();
    if (eventType === 'conversation.item.input_audio_transcription.failed') {
      this.setPhase(this.muted ? 'muted' : 'listening', this.muted
        ? 'That answer could not be heard. Unmute or choose another microphone, then try again.'
        : 'I couldn’t hear that clearly. Check the microphone source and try again.');
      return;
    }
    const error = asObject(event?.error) || event || {};
    const code = String(firstDefined(error.code, error.type, '') || '').toLowerCase();
    const message = cleanText(firstDefined(error.message, 'Live voice reported an error.'));
    // A manual "I've finished" press with nothing captured is harmless noise.
    if (/commit_empty|buffer_too_small|input_audio_buffer_commit/.test(code)) return;
    if (/(?:budget|expired|session_closed|lease|maximum_duration)/.test(code)) {
      this.end({ reason: code.includes('budget') ? 'budget' : 'expired' });
      return;
    }
    this.setPhase('error', `${message} The session remains open; you can retry speaking or end voice.`, {
      error: message
    });
  }

  sendEvent(event) {
    if (this.dataChannel?.readyState !== 'open') return false;
    try {
      this.dataChannel.send(JSON.stringify(event));
      return true;
    } catch (_error) {
      return false;
    }
  }

  // The consumer's explicit "I've finished speaking": force-commit the audio
  // buffer instead of waiting for voice-activity detection to decide. A
  // mistimed press is harmless — an empty-buffer commit is a benign,
  // recoverable provider error on both ends.
  commitTurn() {
    if (!this.active || this.muted || this.welcomePending || this.isCompletionLocked()) return false;
    const sent = this.sendEvent({
      type: 'input_audio_buffer.commit',
      event_id: newIdempotencyKey('turn')
    });
    if (sent && ['user_speaking', 'interrupted', 'listening'].includes(this.phase)) {
      this.setPhase('thinking', 'Planéir is thinking…');
    }
    return sent;
  }

  toggleMute() {
    if (!this.active || !this.localStream || this.welcomePending || this.isCompletionLocked()) return;
    const preserveVoicePhase = MICROPHONE_ORTHOGONAL_PHASES.has(this.phase);
    this.muted = !this.muted;
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !this.muted;
    });
    if (this.muted) {
      this.sendEvent({ type: 'input_audio_buffer.clear', event_id: newIdempotencyKey('mute') });
      if (preserveVoicePhase) this.updateUi();
      else this.setPhase('muted', 'Meeting paused. Your microphone is off until you unmute.');
    } else {
      if (preserveVoicePhase) this.updateUi();
      else this.setPhase('listening', 'I’m listening — take your time.');
    }
  }

  async resumeAudio() {
    const audio = this.element('realtimeVoiceAudio');
    if (this.conversationVersion === 'v2' && audio?.srcObject) {
      try {
        await audio.play();
        this.element('realtimeVoiceResumeAudioButton')?.setAttribute('hidden', '');
      } catch (_error) {
        this.setPhase('audio_blocked', 'Tap “Play response” to hear Planéir.');
      }
      return;
    }
    const controller = this.controlledSpeechController;
    const generation = this.generation;
    const leaseId = this.leaseId;
    const speechId = this.currentControlledSpeech?.speechId || '';
    if (!this.ownsControlledSpeechPlayback({
      audio,
      controller,
      generation,
      leaseId,
      speechId
    })) return;
    try {
      await audio.play();
      if (!this.ownsControlledSpeechPlayback({
        audio,
        controller,
        generation,
        leaseId,
        speechId
      })) return;
      const resume = this.element('realtimeVoiceResumeAudioButton');
      if (resume) resume.hidden = true;
      this.setPhase('assistant_speaking', this.muted
        ? 'Approved Planéir audio is playing. The microphone remains muted.'
        : 'Approved Planéir audio is playing. Start talking to interrupt.');
    } catch (_error) {
      if (!this.ownsControlledSpeechPlayback({
        audio,
        controller,
        generation,
        leaseId,
        speechId
      })) return;
      this.setPhase('error', 'Your browser is still blocking audio. The captions and written journey remain available.', {
        error: 'Voice audio could not start.'
      });
    }
  }

  focusComposer() {
    if (this.active) this.end({ reason: 'typed_fallback' });
    this.collapseCompanion({ restoreFocus: false });
    this.onNavigate('conversation');
    window.requestAnimationFrame(() => {
      const input = document.getElementById('conversationInput');
      input?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      input?.focus?.({ preventScroll: true });
    });
  }

  focusBoundedVoice() {
    if (this.active) this.end({ reason: 'typed_fallback' });
    this.collapseCompanion({ restoreFocus: false });
    this.onNavigate('conversation');
    window.requestAnimationFrame(() => {
      const fallback = document.querySelector('.voice-fallback');
      if (fallback && 'open' in fallback) fallback.open = true;
      const target = fallback?.querySelector?.('summary') || fallback;
      target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      target?.focus?.({ preventScroll: true });
    });
  }

  reviewAndConfirm() {
    this.collapseCompanion({ restoreFocus: false });
    this.onNavigate('review');
  }

  toggleTranscript() {
    const card = this.element('realtimeVoiceCaptionCard');
    const toggle = this.element('realtimeVoiceTranscriptToggle');
    if (!card) return;
    const show = card.hidden;
    card.hidden = !show;
    if (toggle) {
      toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
      toggle.textContent = show ? 'Hide transcript' : 'Show transcript';
    }
  }

  configureLeaseExpiry(call, context) {
    const configuredExpiry = timestampMs(call.expiresAt);
    const responseDuration = Number(call.maxDurationMs || 0);
    const durationMs = responseDuration > 0
      ? Math.min(context.maxDurationMs, responseDuration)
      : context.maxDurationMs;
    this.leaseExpiresAtMs = Math.min(
      configuredExpiry || Number.POSITIVE_INFINITY,
      Date.now() + durationMs
    );
    if (!Number.isFinite(this.leaseExpiresAtMs)) this.leaseExpiresAtMs = Date.now() + durationMs;
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer);
    this.expiryTimer = window.setTimeout(() => this.end({ reason: 'expired' }), Math.max(0, this.leaseExpiresAtMs - Date.now()));
    this.countdownTimer = window.setInterval(() => this.updateLeaseCountdown(), 1_000);
    this.updateLeaseCountdown();
  }

  updateLeaseCountdown() {
    const element = this.element('realtimeVoiceLeaseTime');
    if (!element) return;
    if (!this.active || !this.leaseExpiresAtMs) {
      element.hidden = true;
      element.textContent = '';
      return;
    }
    const seconds = Math.max(0, Math.ceil((this.leaseExpiresAtMs - Date.now()) / 1_000));
    const minutes = Math.floor(seconds / 60);
    element.textContent = `${minutes}:${String(seconds % 60).padStart(2, '0')} left`;
    element.hidden = false;
  }

  scheduleLeasePoll(delayMs = realtimeContext().pollMs) {
    if (!this.active || !this.leaseId || !this.sessionId) return;
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    this.pollTimer = window.setTimeout(() => this.refreshLease(), Math.max(0, delayMs));
  }

  async refreshLease() {
    if (!this.active || !this.leaseId || !this.sessionId || this.pollController) return;
    const leaseId = this.leaseId;
    const sessionId = this.sessionId;
    const controller = new AbortController();
    this.pollController = controller;
    try {
      const payload = await getRealtimeVoiceCall(sessionId, leaseId, {
        signal: controller.signal,
        controlCapability: this.controlCapability
      });
      if (!this.active || leaseId !== this.leaseId || sessionId !== this.sessionId) return;
      this.acceptServerPayload(payload);
      const status = leaseStatus(payload);
      if (['closed', 'complete', 'completed', 'expired', 'revoked', 'withdrawn', 'deleted', 'budget_exhausted', 'failed'].includes(status)) {
        this.end({
          reason: status === 'budget_exhausted' ? 'budget' : (status === 'failed' ? 'connection_failed' : 'expired'),
          notifyServer: false
        });
        return;
      }
      const root = unwrap(payload);
      const lease = asObject(firstDefined(root.lease, root.realtimeLease, root.call)) || {};
      const expiresAt = timestampMs(firstDefined(root.expiresAt, lease.expiresAt, lease.expires_at));
      if (expiresAt && (!this.leaseExpiresAtMs || expiresAt < this.leaseExpiresAtMs)) {
        this.configureLeaseExpiry({ expiresAt, maxDurationMs: expiresAt - Date.now() }, realtimeContext());
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (this.onSessionUnavailable(error)) return;
      if (this.active) this.scheduleLeasePoll();
      return;
    } finally {
      if (this.pollController === controller) this.pollController = null;
    }
    this.scheduleLeasePoll();
  }

  acceptServerPayload(payload) {
    if (!payload) return;
    const root = unwrap(payload);
    this.mergeServerTranscript(root.realtimeTurns);
    mergeVoicePayload(payload);
    this.onVoicePayload(payload);
    this.updatePlanningContext(payload, this.lastState);
    this.onPlanningPayload(payload);
    const lease = asObject(firstDefined(root.realtimeLease, root.lease, root.call)) || {};
    const meetingPhase = String(firstDefined(lease.meetingPhase, lease.meeting_phase, '') || '');
    if (meetingPhase === 'closing') {
      this.beginCompletionPlayback(lease);
    }
    this.playWorkerSpeechFromPayload(payload);
    this.updateUi();
  }

  async end({ reason = 'user', notifyServer = true, announce = true } = {}) {
    const hadLiveState = this.active || Boolean(this.leaseId);
    const leaseId = this.leaseId;
    const sessionId = this.sessionId;
    const controlCapability = this.controlCapability;
    ++this.generation;
    // Stop capture and playback immediately, but keep the WebRTC transport
    // alive until the Worker has invoked OpenAI's server-side hangup endpoint.
    // Closing the peer first can make the provider call cease to be "active"
    // before the authoritative hangup is issued, which makes termination
    // impossible to prove even though the browser microphone is already off.
    const preserveProviderTransport = Boolean(notifyServer && leaseId && sessionId);
    this.cleanupLocal({ preserveProviderTransport });
    const messages = {
      budget: 'This meeting’s allowance has been used. Everything you shared is saved — you can continue by typing.',
      connection_failed: 'The meeting connection ended. Everything you shared is saved; you can start again or continue by typing.',
      expired: 'Your meeting time ended. Everything you shared is saved — you can start a new meeting if allowance remains.',
      hidden: 'The meeting ended because this tab was hidden. The microphone is off.',
      pagehide: 'The meeting ended. The microphone is off.',
      review: 'The meeting ended. Review and confirm what Planéir understood.',
      typed_fallback: 'The meeting ended. Continue in the typed answer box.',
      completed: 'Your analyses are ready.',
      user: 'The meeting ended. The microphone is off.'
    };
    if (reason === 'budget') {
      this.setPhase('budget_exhausted', messages.budget);
    } else if (reason === 'connection_failed') {
      this.setPhase('error', messages.connection_failed, { error: messages.connection_failed });
    } else {
      this.setPhase('off', messages[reason] || 'Live voice ended. The microphone is off.');
    }
    if (announce && hadLiveState && ['budget', 'connection_failed'].includes(reason)) {
      this.onToast(messages[reason], { error: true, timeout: 7000 });
    }
    if (notifyServer && leaseId && sessionId) {
      try {
        const payload = await deleteRealtimeVoiceCall(sessionId, leaseId, { controlCapability });
        this.acceptServerPayload(payload);
      } catch (error) {
        if (!this.onSessionUnavailable(error) && reason === 'user') {
          this.onToast('The microphone is off. The server lease will still expire automatically.', {
            error: true,
            timeout: 6000
          });
        }
      } finally {
        this.cleanupLocal();
      }
    }
  }

  cleanupLocal({ preserveProviderTransport = false } = {}) {
    this.active = false;
    this.muted = false;
    this.responseInProgress = false;
    this.activeResponseId = '';
    this.awaitingWorkerSpeech = false;
    this.welcomePending = false;
    this.welcomePlaybackStarted = false;
    this.stopControlledSpeech();
    this.startController?.abort('realtime_voice_ended');
    this.pollController?.abort('realtime_voice_ended');
    this.startController = null;
    this.pollController = null;
    [
      ['pollTimer', 'clearTimeout'],
      ['expiryTimer', 'clearTimeout'],
      ['countdownTimer', 'clearInterval'],
      ['disconnectTimer', 'clearTimeout'],
      ['interruptTimer', 'clearTimeout'],
      ['completionTimer', 'clearTimeout']
    ].forEach(([property, method]) => {
      if (this[property] !== null) window[method](this[property]);
      this[property] = null;
    });
    if (!preserveProviderTransport) {
      try { this.dataChannel?.close(); } catch (_error) { /* noop */ }
      try { this.peerConnection?.close(); } catch (_error) { /* noop */ }
      this.dataChannel = null;
      this.peerConnection = null;
    }
    stopTracks(this.microphonePermissionStream);
    this.microphonePermissionStream = null;
    stopTracks(this.localStream);
    this.localStream = null;
    this.orb?.destroy();
    this.orb = null;
    this.remoteAudioStream = null;
    this.microphoneRecoveryRequired = false;
    this.activeMicrophoneLabel = '';
    this.playedSpeechIds.clear();
    this.completionSpeechId = '';
    this.completionNavigationInFlight = false;
    this.leaseId = '';
    this.controlCapability = '';
    this.conversationVersion = 'v1';
    this.leaseExpiresAtMs = null;
    this.sessionId = '';
    this.updateUi();
  }

  mergeServerTranscript(turns) {
    if (!Array.isArray(turns)) return;
    const existingIds = new Set(this.transcriptHistory.map((item) => item.id).filter(Boolean));
    turns.forEach((turn) => {
      const id = cleanText(turn?.id, 120);
      const role = turn?.role === 'assistant' ? 'assistant' : turn?.role === 'user' ? 'user' : '';
      const text = cleanText(turn?.transcript || turn?.text);
      if (!role || !text || (id && existingIds.has(id))) return;
      const duplicate = this.transcriptHistory.some((item) => item.role === role && item.text === text);
      if (duplicate) return;
      this.transcriptHistory.push({ id, role, text, createdAt: turn.createdAt || null });
      if (id) existingIds.add(id);
    });
    const removed = Math.max(0, this.transcriptHistory.length - MAX_TRANSCRIPT_ITEMS);
    if (removed > 0) this.transcriptHistory.splice(0, removed);
    this.renderTranscriptHistory();
  }

  beginCompletionPlayback(lease) {
    const speechId = cleanText(lease.outroSpeechId || lease.completion_outro_speech_id, 100);
    if (!speechId || this.completionSpeechId === speechId || this.completionNavigationInFlight) return;
    this.completionSpeechId = speechId;
    this.muted = true;
    this.localStream?.getAudioTracks?.().forEach((track) => { track.enabled = false; });
    this.microphonePermissionStream?.getAudioTracks?.().forEach((track) => { track.enabled = false; });
    this.setPhase('assistant_speaking', 'Planéir is finishing the meeting and taking you to your analyses…');
    if (this.completionTimer !== null) window.clearTimeout(this.completionTimer);
    this.completionTimer = window.setTimeout(() => {
      this.completionTimer = null;
      void this.completeSpokenMeeting();
    }, COMPLETION_PLAYBACK_TIMEOUT_MS);
  }

  async completeSpokenMeeting() {
    if (this.completionNavigationInFlight) return;
    this.completionNavigationInFlight = true;
    if (this.completionTimer !== null) window.clearTimeout(this.completionTimer);
    this.completionTimer = null;
    await this.end({ reason: 'completed', notifyServer: true, announce: false });
    await this.onNavigate('results');
  }

  openConsentDialog() {
    const context = realtimeContext();
    if (!context.eligible || !context.configured || !context.sessionId) {
      this.onToast('Live voice cannot start until its separate disclosure is configured.', { error: true });
      return;
    }
    if (context.consentGranted) {
      this.statusText = 'You’re ready to go. Press the button to begin your meeting.';
      this.updateUi();
      return;
    }
    const dialog = document.getElementById('realtimeVoiceConsentDialog');
    const checkbox = document.getElementById('realtimeVoiceConsentAcknowledgement');
    const policy = document.getElementById('realtimeVoiceConsentPolicy');
    const budget = document.getElementById('realtimeVoiceConsentBudget');
    const privacyLink = document.getElementById('realtimeVoiceConsentPrivacyLink');
    const error = document.getElementById('realtimeVoiceConsentError');
    if (!dialog || !checkbox) {
      this.onToast('The Live voice disclosure could not be opened. Continue by typing.', { error: true });
      return;
    }
    checkbox.checked = false;
    checkbox.disabled = false;
    if (policy) policy.textContent = `Disclosure ${context.noticeId} · policy ${context.policyVersion}`;
    if (budget) budget.textContent = `${formatEuroFromMicro(context.budget.limitMicroEur)} app voice allowance for this session.`;
    if (privacyLink) privacyLink.href = context.privacyNoticeUrl;
    if (error) {
      error.hidden = true;
      error.textContent = '';
    }
    document.body.classList.add('dialog-open');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    window.requestAnimationFrame(() => checkbox.focus());
  }

  closeConsentDialog() {
    const dialog = document.getElementById('realtimeVoiceConsentDialog');
    if (typeof dialog?.close === 'function' && dialog.open) dialog.close();
    else dialog?.removeAttribute('open');
    document.body.classList.remove('dialog-open');
  }

  async submitConsent(form) {
    if (!form?.reportValidity()) return;
    const context = realtimeContext();
    if (!context.eligible || !context.configured || !context.sessionId) {
      this.showConsentError('Live voice is not configured for this private session.');
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    const cancel = document.getElementById('cancelRealtimeVoiceConsentButton');
    const checkbox = document.getElementById('realtimeVoiceConsentAcknowledgement');
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'One moment…';
    }
    if (cancel) cancel.disabled = true;
    if (checkbox) checkbox.disabled = true;
    try {
      const payload = await updateRealtimeVoiceConsent(context.sessionId, {
        granted: true,
        noticeId: context.noticeId,
        policyVersion: context.policyVersion,
        privacyNoticeUrl: context.privacyNoticeUrl
      });
      mergeVoicePayload(payload);
      this.onVoicePayload(payload);
      if (!hasCurrentRealtimeVoiceConsent()) {
        throw new Error('The service did not confirm Live voice consent for the current disclosure.');
      }
      this.closeConsentDialog();
      this.statusText = 'Connecting your meeting…';
      this.sync(this.lastState);
      // The consumer pressed Start and accepted the disclosure: continue
      // straight into the microphone permission and connection instead of
      // asking for a second press.
      window.requestAnimationFrame(() => this.start());
    } catch (error) {
      if (this.onSessionUnavailable(error)) return;
      this.showConsentError(error instanceof Error ? error.message : 'Your agreement could not be saved. Please try again.');
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = 'Agree and start my meeting';
      }
      if (cancel) cancel.disabled = false;
      if (checkbox) checkbox.disabled = false;
    }
  }

  showConsentError(message) {
    const error = document.getElementById('realtimeVoiceConsentError');
    if (!error) return;
    error.textContent = String(message || 'Live voice consent could not be saved.');
    error.hidden = false;
  }

  async withdrawConsent() {
    const context = realtimeContext();
    if (!context.sessionId || getRealtimeVoiceConsent()?.granted !== true) return;
    const button = document.getElementById('withdrawRealtimeVoiceConsentButton');
    if (button) {
      button.disabled = true;
      button.textContent = 'Turning off…';
    }
    await this.end({ reason: 'consent_withdrawn' });
    try {
      const payload = await updateRealtimeVoiceConsent(context.sessionId, {
        granted: false,
        noticeId: context.noticeId,
        policyVersion: context.policyVersion,
        privacyNoticeUrl: context.privacyNoticeUrl
      });
      mergeVoicePayload(payload);
      this.onVoicePayload(payload);
      this.closeConsentDialog();
      this.setPhase('off', 'Live voice is off. Short voice and typing remain available.');
      this.onToast('Live voice is off for this session.');
    } catch (error) {
      if (this.onSessionUnavailable(error)) return;
      this.onToast(error instanceof Error ? error.message : 'Live voice could not be turned off.', { error: true });
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Stop Live voice';
      }
    }
  }

  reset({ notifyServer = false } = {}) {
    this.end({ reason: 'reset', notifyServer, announce: false });
    this.collapseCompanion({ restoreFocus: false });
    this.closeConsentDialog();
    this.transcriptHistory = [];
    this.planningContext = null;
    this.phase = 'off';
    this.statusText = '';
    this.renderTranscriptHistory();
    if (this.root) this.root.hidden = true;
    document.body?.classList?.remove('realtime-companion-open');
  }
}

export function createRealtimeVoiceController(options) {
  return new RealtimeVoiceController(options);
}
