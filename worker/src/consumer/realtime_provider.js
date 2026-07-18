import { GOAL_TYPES } from '../../../js/planning/contracts.js';
import { hmacSha256Base64Url } from './crypto.js';
import { ConsumerError, badRequest } from './errors.js';

const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const MAX_PROVIDER_SDP_BYTES = 32_768;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;

export const REALTIME_TOOL_DEFINITIONS = Object.freeze([
  {
    type: 'function',
    name: 'get_planning_state',
    description: 'Read the current server-authoritative planning revision, journey state and exact next question. Never infer saved facts.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['expectedRevision'],
      properties: { expectedRevision: { type: 'integer', minimum: 1 } }
    }
  },
  {
    type: 'function',
    name: 'propose_facts',
    description: `Propose explicit facts only for server-approved semantic fact IDs. For an entity fact, send one object or {items:[...]} using operation upsert, remove or confirm_none and a stable entityId; use owner primary, partner or joint where requested. For Net Retirement, confirm no after-tax income with {operation:"confirm_none",scope:"net_retirement_income"} and no available cash/liquid investments with scope "retirement_available_assets" even when other records exist. The primary_goal value must be exactly one of: ${GOAL_TYPES.join(', ')} (a broad "how am I doing" review is understand_position). Choice facts accept only the values listed in get_planning_state factValueVocabulary. Call this as soon as the consumer states anything mappable — a goal, life stage, or figure — rather than waiting. The server binds the evidence to the current finalized turn, returns exact readBackText for material read-back facts, and saves ordinary facts as editable drafts for final visual confirmation.`,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['expectedRevision', 'facts'],
      properties: {
        expectedRevision: { type: 'integer', minimum: 1 },
        facts: {
          type: 'array', minItems: 1, maxItems: 8,
          items: {
            type: 'object', additionalProperties: false,
            required: ['factId', 'value', 'certainty', 'evidenceItemId'],
            properties: {
              factId: { type: 'string', minLength: 1, maxLength: 120 },
              value: {},
              certainty: { type: 'string', enum: ['exact', 'approximate', 'range', 'unknown'] },
              // The server binds every fact to the current finalized consumer
              // turn; this field is accepted for compatibility but its value is
              // not trusted. Pass the finalized user item id when known, else
              // any placeholder such as "latest".
              evidenceItemId: { type: 'string', minLength: 1, maxLength: 160 }
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    name: 'resolve_fact_confirmation',
    description: 'Resolve only the current server-owned readBackText using a separate finalized consumer confirmation item. Final profile and module execution still require the authenticated visual plan confirmation.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['proposalId', 'decision', 'expectedRevision', 'evidenceItemId'],
      properties: {
        proposalId: { type: 'string', minLength: 8, maxLength: 100 },
        decision: { type: 'string', enum: ['confirmed', 'rejected'] },
        expectedRevision: { type: 'integer', minimum: 1 },
        evidenceItemId: { type: 'string', minLength: 1, maxLength: 160 }
      }
    }
  },
  {
    type: 'function',
    name: 'get_module_plan',
    description: 'Ask the deterministic planning service which allowlisted modules are ready and which exact facts remain missing.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['expectedRevision'],
      properties: { expectedRevision: { type: 'integer', minimum: 1 } }
    }
  },
  {
    type: 'function',
    name: 'confirm_and_run_plan',
    description: 'Request a deterministic analysis. The server rejects this unless the consumer has independently confirmed the exact plan and profile revision in the UI.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['expectedRevision', 'planId', 'planNonce'],
      properties: {
        expectedRevision: { type: 'integer', minimum: 1 },
        planId: { type: 'string', minLength: 8, maxLength: 100 },
        planNonce: { type: 'string', minLength: 40, maxLength: 160 }
      }
    }
  },
  {
    type: 'function',
    name: 'get_result_summary',
    description: 'Read only the latest deterministic result summary supplied by the planning server. Never calculate or invent numbers.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['expectedRevision', 'planId'],
      properties: {
        expectedRevision: { type: 'integer', minimum: 1 },
        planId: { type: 'string', minLength: 8, maxLength: 100 }
      }
    }
  },
  {
    type: 'function',
    name: 'wait_for_user',
    description: 'Stay silent only when the consumer explicitly asks for a moment, is clearly mid-thought, or says they are reading the on-screen information. Never use this right after the consumer finishes an answer, asks a question, or expresses frustration — those always need a spoken reply through get_planning_state or propose_facts.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['expectedRevision', 'reason'],
      properties: {
        expectedRevision: { type: 'integer', minimum: 1 },
        reason: {
          type: 'string',
          enum: ['consumer_speaking', 'consumer_reviewing', 'confirmation_required', 'clarification_required']
        }
      }
    }
  }
]);

export function buildRealtimeInstructions(_state = {}) {
  return [
    'You are Planéir, a clearly disclosed AI conversational companion for financial education. Never pretend to be a human adviser.',
    'Interpret the consumer calmly and precisely. You are a silent tool interpreter: never emit assistant audio or assistant prose.',
    'You are not a financial adviser. Never calculate, recommend products, decide eligibility, or invent a saved fact.',
    'The Worker and deterministic module runtime are authoritative. Use only the versioned tools supplied by the server.',
    'Do not treat speech, tool arguments, or prior model text as confirmed data.',
    'Every authorized response must call exactly one supplied tool. The Worker returns signed assistantSpeech for separate playback; do not repeat it in model output.',
    'Treat response_text and require_repeat_verbatim in tool output as context only. Never produce a continuation after receiving a tool result.',
    'Do not reveal an internal persona label, invent a fourth module, reorder modules, or substitute your own selection.',
    'The Worker owns all explanations when the analyses change after a correction or priority choice.',
    'Never transform deterministic amounts or result text; return only the required tool call.',
    'Batch facts only when the consumer explicitly states them in the same finalized answer; never repeat a fact already shown as saved.',
    'Use semantic fact IDs only. Never send a JSON pointer, profile path, calculation, inference, or value that the consumer did not explicitly state.',
    'For a pending material fact, use the confirmation tool on the consumer’s next finalized answer. Never compose, shorten, or paraphrase factual copy.',
    'Use wait_for_user only when the consumer explicitly asks for a moment or is clearly still mid-thought. When they finish an answer, ask a question, or express frustration, always respond through get_planning_state or propose_facts so the server can speak.',
    'When a tool result returns ok:false, read its message and guidance (allowedValues, currentRevision, hints) plus get_planning_state factValueVocabulary, and submit one corrected tool call in the next authorized response. Never abandon the interview after a rejection.',
    'If the consumer asks you to repeat, re-explain, or says they missed or did not understand the question, call get_planning_state — the server speaks the current question again. Do the same for any meta-request about the conversation itself.',
    'When the planning service requests disambiguation or goal priority, use the applicable tool and let Worker-owned speech ask the approved question.',
    'Only the separate authenticated UI confirmation can confirm and run the plan.',
    'When a tool returns speakableText, treat it as immutable Worker-owned context. Never add, round, compare, recalculate or emit it yourself.',
    'For deferred, unsupported, regulated, or adviser-only topics, use planning-state tools. Never create a handoff, promise contact, run a gated analysis, or invent results.',
    'Never request PPS numbers, account/card numbers, passwords, credentials, documents, or an exact address.',
    'Get the current journey phase, exact three-analysis focus, pending read-back and next question from server tools. Never rely on an earlier instruction snapshot for mutable planning state.'
  ].join('\n');
}

export function realtimeJourneyPhase(state = {}) {
  if (['discovery', 'confirmation', 'analysis', 'results'].includes(state.realtimePhase)) {
    return state.realtimePhase;
  }
  return state.stage === 'review' ? 'confirmation' : 'discovery';
}

export function realtimeToolsForState(state = {}) {
  const phase = realtimeJourneyPhase(state);
  const names = phase === 'results'
    ? ['get_planning_state', 'get_result_summary', 'wait_for_user']
    : phase === 'analysis'
      ? ['get_planning_state', 'get_module_plan', 'confirm_and_run_plan', 'wait_for_user']
      : phase === 'confirmation'
        ? ['get_planning_state', 'propose_facts', 'resolve_fact_confirmation', 'get_module_plan', 'wait_for_user']
        : ['get_planning_state', 'propose_facts', 'wait_for_user'];
  return REALTIME_TOOL_DEFINITIONS.filter((tool) => names.includes(tool.name));
}

export function buildRealtimeSessionConfig(config, state = {}) {
  return {
    type: 'realtime',
    model: config.realtimeModel,
    instructions: buildRealtimeInstructions(state),
    reasoning: {
      effort: state.reasoningEscalation?.requested
        ? 'medium'
        : config.realtimeReasoningEffort
    },
    output_modalities: ['text'],
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24_000 },
        // The browser capture path primarily targets built-in laptop and
        // conference-room microphones; OpenAI recommends far-field reduction
        // for that pickup pattern. Explicitly selected phone microphones remain
        // valid inputs and are still handled through the same WebRTC track.
        noise_reduction: { type: 'far_field' },
        transcription: {
          model: config.realtimeTranscriptionModel,
          language: 'en'
        },
        turn_detection: {
          type: 'semantic_vad',
          // High eagerness commits the consumer's turn quickly instead of
          // waiting out ambiguous trailing silence. A too-early commit is
          // cheap here: facts accumulate across turns, the barge-in recovery
          // re-speaks cancelled lines, and the client's tap/space control
          // lets the consumer force-finish a turn the detector missed.
          eagerness: 'high',
          create_response: false,
          interrupt_response: true
        }
      },
      output: {
        // OpenAI documents PCM as 24 kHz and can materialize that default in
        // the full effective session returned by `session.updated`. Send it
        // explicitly so a journey-phase tool update cannot look like an
        // untrusted policy change merely because the provider filled a default.
        format: { type: 'audio/pcm', rate: 24_000 },
        speed: 1,
        voice: config.realtimeVoice
      }
    },
    tools: realtimeToolsForState(state),
    tool_choice: 'required',
    parallel_tool_calls: false,
    max_output_tokens: 800,
    truncation: {
      type: 'retention_ratio',
      retention_ratio: 0.8,
      token_limits: { post_instructions: 8_000 }
    }
  };
}

function boundedDiagnosticValue(value, maximumLength = 160) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maximumLength || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

async function readProviderRejectionMetadata(response) {
  const maximumBytes = 8_192;
  const reader = response.body?.getReader();
  let received = 0;
  const chunks = [];
  if (reader) {
    try {
      while (received <= maximumBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maximumBytes) break;
        chunks.push(value);
      }
    } catch (_error) {
      // Diagnostics must never interfere with the fail-closed provider path.
    } finally {
      reader.cancel().catch(() => {});
    }
  }
  let providerError = {};
  if (received <= maximumBytes && chunks.length) {
    try {
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      providerError = JSON.parse(new TextDecoder().decode(bytes))?.error || {};
    } catch (_error) {
      providerError = {};
    }
  }
  return {
    status: response.status,
    providerRequestId: boundedDiagnosticValue(response.headers.get('x-request-id')),
    providerErrorType: boundedDiagnosticValue(providerError.type),
    providerErrorCode: boundedDiagnosticValue(providerError.code),
    providerErrorParam: boundedDiagnosticValue(providerError.param)
  };
}

function providerKey(env) {
  const key = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
  if (!key) throw new ConsumerError(503, 'realtime_provider_unconfigured', 'Live voice is not configured.');
  return key;
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

export async function readRealtimeSdpOffer(request, maximumBytes) {
  const contentType = String(request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/sdp') {
    throw badRequest('A WebRTC SDP offer is required.', 'realtime_sdp_type_invalid');
  }
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/.test(declared.trim()) || Number(declared) > maximumBytes)) {
    throw new ConsumerError(413, 'realtime_sdp_too_large', 'The WebRTC offer is too large.');
  }
  const offer = await request.text();
  if (!offer || byteLength(offer) > maximumBytes || offer.includes('\0')) {
    throw new ConsumerError(offer ? 413 : 400, offer ? 'realtime_sdp_too_large' : 'realtime_sdp_required', offer ? 'The WebRTC offer is too large.' : 'A WebRTC offer is required.');
  }
  if (!/^v=0(?:\r?\n)/.test(offer) || !/(?:^|\r?\n)m=audio\s/m.test(offer)) {
    throw badRequest('The WebRTC offer is invalid.', 'realtime_sdp_invalid');
  }
  return offer;
}

function providerCallIdFromLocation(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 500) return '';
  try {
    const parsed = new URL(raw, OPENAI_REALTIME_CALLS_URL);
    if (parsed.origin !== 'https://api.openai.com') return '';
    const callId = parsed.pathname.split('/').filter(Boolean).at(-1) || '';
    return /^[A-Za-z0-9._:-]{1,160}$/.test(callId) ? callId : '';
  } catch (error) {
    return '';
  }
}

async function readBoundedSdpAnswer(response) {
  const contentType = String(response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const text = await response.text();
  const byteLength = new TextEncoder().encode(text).byteLength;
  const diagnostic = {
    providerContentType: contentType || null,
    providerBodyBytes: byteLength,
    providerBodyStartsWithV0: text.startsWith('v=0')
  };
  if (!['application/sdp', 'text/plain'].includes(contentType)) {
    const error = new Error('provider_sdp_type_invalid');
    error.diagnostic = diagnostic;
    throw error;
  }
  if (!text || byteLength > MAX_PROVIDER_SDP_BYTES || !/^v=0(?:\r?\n)/.test(text)) {
    const error = new Error('provider_sdp_invalid');
    error.diagnostic = diagnostic;
    throw error;
  }
  return text;
}

export async function createOpenAiRealtimeCall({ env, config, sessionId, offerSdp, state }) {
  const safetyIdentifier = await hmacSha256Base64Url(
    env.CONSUMER_RATE_LIMIT_HASH_KEY,
    `openai-safety/realtime/v1/${sessionId}`
  );
  const multipart = new FormData();
  // The unified Realtime WebRTC endpoint expects ordinary multipart fields.
  // File-like Blob parts are rejected as invalid_form_data by the provider.
  multipart.set('sdp', offerSdp);
  multipart.set('session', JSON.stringify(buildRealtimeSessionConfig(config, state)));
  let response;
  try {
    response = await fetch(OPENAI_REALTIME_CALLS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${providerKey(env)}`,
        'OpenAI-Safety-Identifier': safetyIdentifier,
        'X-Client-Request-Id': crypto.randomUUID()
      },
      body: multipart
    });
  } catch (error) {
    throw new ConsumerError(502, 'realtime_provider_unavailable', 'Live voice could not be started. Continue by typing.');
  }
  if (!response.ok) {
    const diagnostic = await readProviderRejectionMetadata(response);
    console.warn('OpenAI Realtime call rejected', diagnostic);
    throw new ConsumerError(
      502,
      'realtime_provider_rejected',
      'Live voice could not be started. Continue by typing.',
      {
        providerStatus: diagnostic.status,
        providerRequestId: diagnostic.providerRequestId,
        providerErrorType: diagnostic.providerErrorType,
        providerErrorCode: diagnostic.providerErrorCode,
        providerErrorParam: diagnostic.providerErrorParam
      }
    );
  }
  const providerCallId = providerCallIdFromLocation(response.headers.get('Location'));
  if (!providerCallId) {
    response.body?.cancel().catch(() => {});
    throw new ConsumerError(502, 'realtime_provider_call_id_missing', 'Live voice could not be safely controlled. Continue by typing.');
  }
  let answerSdp;
  try {
    answerSdp = await readBoundedSdpAnswer(response);
  } catch (error) {
    try {
      await hangupOpenAiRealtimeCall({ env, providerCallId });
    } catch (hangupError) {
      // Keep the provider id internal so the caller can persist/retry cleanup;
      // it is never included in the public ConsumerError details payload.
      hangupError.providerCallId = providerCallId;
      throw hangupError;
    }
    throw new ConsumerError(
      502,
      'realtime_provider_sdp_invalid',
      'Live voice returned an invalid connection response. Continue by typing.',
      {
        providerRequestId: boundedDiagnosticValue(response.headers.get('x-request-id')),
        providerContentType: error?.diagnostic?.providerContentType || null,
        providerBodyBytes: Number.isInteger(error?.diagnostic?.providerBodyBytes)
          ? error.diagnostic.providerBodyBytes
          : null,
        providerBodyStartsWithV0: error?.diagnostic?.providerBodyStartsWithV0 === true
      }
    );
  }
  return { answerSdp, providerCallId };
}

export async function hangupOpenAiRealtimeCall({ env, providerCallId, timeoutMs = 5_000 }) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(providerCallId || ''))) {
    throw new ConsumerError(502, 'realtime_hangup_invalid', 'The live provider call could not be terminated safely.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(10_000, timeoutMs)));
  try {
    const response = await fetch(
      `${OPENAI_REALTIME_CALLS_URL}/${encodeURIComponent(providerCallId)}/hangup`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${providerKey(env)}`,
          'X-Client-Request-Id': crypto.randomUUID()
        },
        signal: controller.signal
      }
    );
    response.body?.cancel().catch(() => {});
    if (!response.ok && response.status !== 404) {
      throw new ConsumerError(502, 'realtime_hangup_uncertain', 'The live provider call termination could not be confirmed.');
    }
    return { confirmed: true };
  } catch (error) {
    if (error instanceof ConsumerError) throw error;
    throw new ConsumerError(502, 'realtime_hangup_uncertain', 'The live provider call termination could not be confirmed.');
  } finally {
    clearTimeout(timeout);
  }
}

export function assertRealtimeToolName(name) {
  const value = typeof name === 'string' ? name : '';
  if (!TOOL_NAME_PATTERN.test(value) || !REALTIME_TOOL_DEFINITIONS.some((tool) => tool.name === value)) {
    throw new ConsumerError(400, 'realtime_tool_not_allowed', 'That live planning tool is not available.');
  }
  return value;
}
