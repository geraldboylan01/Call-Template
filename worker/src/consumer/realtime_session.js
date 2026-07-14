import { getConsumerConfig } from './config.js';
import { resolveSemanticFact } from '../../../js/planning/semantic_facts.js';
import { normalizeHouseholdProfile } from '../../../js/planning/profile.js';
import { getPlanningModuleDefinition } from '../../../js/planning/module_registry.js';
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
  closeRealtimeLease,
  commitRealtimeFactConfirmation,
  completeRealtimeToolAttempt,
  createRealtimeFactProposal,
  getPendingRealtimeFactProposal,
  getRealtimeAnalysisPlanResult,
  getRealtimeConsent,
  getRealtimeLease,
  getRealtimeProviderCallId,
  listRealtimeFactProposalSummaries,
  realtimeConsentIsCurrent,
  recordRealtimeFinalTurn,
  recordRealtimeUsage,
  rejectRealtimeFactProposal,
  touchRealtimeLease
} from './realtime_repository.js';
import {
  buildConfirmedRealtimeFactSummary,
  mapRealtimeFact,
  modulesEnabledByFacts,
  realtimeFactAllowed
} from './realtime_fact_mapper.js';
import {
  assertRealtimeToolName,
  buildRealtimeSessionConfig,
  hangupOpenAiRealtimeCall,
  realtimeJourneyPhase,
  realtimeToolsForState
} from './realtime_provider.js';
import {
  applyProfilePatch
} from './validators.js';

const MAX_INTERNAL_BODY_BYTES = 64_000;
const MAX_PROVIDER_EVENT_BYTES = 64_000;
const MAX_TOOL_ARGUMENT_BYTES = 20_000;
const TOOL_VERSION = '1';
const SIDE_BAND_URL = 'https://api.openai.com/v1/realtime';
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
    ...(tool.strict === undefined ? {} : { strict: tool.strict })
  }));
}

export function realtimeSessionPolicySnapshot(session = {}) {
  return {
    type: session.type,
    model: session.model,
    safety_identifier: session.safety_identifier,
    instructions: session.instructions,
    reasoning: session.reasoning,
    output_modalities: session.output_modalities,
    audio: {
      input: {
        format: session.audio?.input?.format,
        noise_reduction: session.audio?.input?.noise_reduction,
        transcription: session.audio?.input?.transcription,
        turn_detection: session.audio?.input?.turn_detection
      },
      output: {
        format: session.audio?.output?.format,
        speed: session.audio?.output?.speed,
        voice: session.audio?.output?.voice
      }
    },
    tools: normalizedTools(session.tools),
    tool_choice: session.tool_choice,
    parallel_tool_calls: session.parallel_tool_calls,
    max_output_tokens: session.max_output_tokens,
    truncation: session.truncation,
    include: Array.isArray(session.include) ? session.include : [],
    prompt: session.prompt ?? null,
    tracing: session.tracing ?? null,
    temperature: session.temperature ?? null
  };
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
  const min = Number(source?.min);
  const max = Number(source?.max);
  return Number.isFinite(min) && Number.isFinite(max) && min <= max
    ? { min, max }
    : null;
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

function complexJourney(profile, state) {
  const contradictions = Array.isArray(profile?.assumptions?.values?.unresolvedContradictions)
    && profile.assumptions.values.unresolvedContradictions.length > 0;
  const multipleGoals = Array.isArray(profile?.goals) && profile.goals.length > 1;
  const complexHousehold = Boolean(profile?.partner)
    || (profile?.dependants?.length || 0) > 1
    || (profile?.properties?.length || 0) > 1
    || (profile?.businesses?.length || 0) > 0
    || (profile?.incomeSources?.length || 0) > 2;
  return {
    requested: contradictions || multipleGoals || complexHousehold,
    applied: contradictions || multipleGoals || complexHousehold,
    reason: contradictions
      ? 'contradictory_facts'
      : multipleGoals
        ? 'multiple_goals'
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
    this.speechStartedAt = 0;
    this.firstOutputRecorded = false;
    this.eventChain = Promise.resolve();
    this.pendingResponseAuthorization = null;
    this.currentAuthorizedResponseId = null;
    this.toolContinuationPending = false;
    this.pendingSessionPolicyHash = null;
    this.pendingSessionPolicySnapshot = null;
    this.deferredResponseAuthorization = null;
    this.initialProbePending = false;
    this.committedAudioItemIds = new Set();
    this.serverFunctionOutputs = new Map();
    this.activeToolCallCount = 0;
    this.pendingTerminalization = null;
    this.state.blockConcurrencyWhile(async () => {
      this.meta = await this.state.storage.get('lease') || null;
      this.currentPhase = await this.state.storage.get('phase') || null;
      this.pendingResponseAuthorization = await this.state.storage.get('pendingResponseAuthorization') || null;
      this.currentAuthorizedResponseId = await this.state.storage.get('currentAuthorizedResponseId') || null;
      this.pendingSessionPolicyHash = await this.state.storage.get('pendingSessionPolicyHash') || null;
      this.pendingSessionPolicySnapshot = await this.state.storage.get('pendingSessionPolicySnapshot') || null;
      this.pendingTerminalization = await this.state.storage.get('pendingTerminalization') || null;
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
        await this.setAnalysisPhase(body);
        return json({ ok: true, phase: this.currentPhase });
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
    this.initialProbePending = true;
    await this.refreshJourneyState();
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
          Upgrade: 'websocket',
          'OpenAI-Beta': 'realtime=v1'
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
      this.committedAudioItemIds.delete(itemId);
      this.finalizedEvidenceItems.add(itemId);
      const transcript = typeof event.transcript === 'string' ? event.transcript : '';
      const tokens = realtimeTranscriptionUsageFromEvent(event);
      if (!transcript || !tokens) {
        await this.terminalize('failed', 'transcription_usage_missing', 'realtime_transcription_usage_missing', false);
        return;
      }
      const config = getConsumerConfig(this.env);
      const lease = await getRealtimeLease(this.env, this.meta.sessionId, this.meta.leaseId);
      if (lease?.pricing_version !== config.realtimePricingVersion) {
        await this.terminalize('failed', 'pricing_version_mismatch', 'realtime_pricing_version_mismatch', false);
        return;
      }
      await recordRealtimeFinalTurn(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        providerItemId: itemId,
        role: 'user',
        transcript
      });
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
      await this.touch();
      await this.authorizeResponse('finalized_user_item');
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.failed') {
      await this.terminalize('failed', 'transcription_failed', 'realtime_transcription_failed', false);
      return;
    }
    if (type === 'conversation.item.created' || type === 'conversation.item.added') {
      const item = event.item || {};
      if (item.type === 'function_call_output') {
        const expected = this.serverFunctionOutputs.get(String(item.id || ''));
        if (!expected
          || !constantTimeTextEqual(expected.callId, item.call_id)
          || !constantTimeTextEqual(expected.output, item.output)) {
          await this.terminalize('failed', 'conversation_item_injected', 'realtime_conversation_item_injected', false);
          return;
        }
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
      const responseOwned = this.inResponse
        && (item.role === 'assistant' || item.type === 'function_call');
      if (!responseOwned) {
        await this.terminalize('failed', 'conversation_item_injected', 'realtime_conversation_item_injected', false);
      }
      return;
    }
    if (['conversation.item.deleted', 'conversation.item.truncated', 'conversation.item.retrieved'].includes(type)) {
      await this.terminalize('failed', 'conversation_history_mutated', 'realtime_conversation_history_mutated', false);
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.delta') {
      // Partial transcripts are intentionally neither stored nor trusted.
      await this.touch();
      return;
    }
    if (type === 'response.output_audio_transcript.done') {
      const itemId = String(event.item_id || event.response_id || '');
      const responseId = String(event.response_id || '');
      const transcript = typeof event.transcript === 'string' ? event.transcript : '';
      if (!this.inResponse
        || !this.currentAuthorizedResponseId
        || !constantTimeTextEqual(responseId, this.currentAuthorizedResponseId)) {
        await this.terminalize('failed', 'assistant_transcript_unauthorized', 'realtime_assistant_transcript_unauthorized', false);
        return;
      }
      if (validProviderId(itemId) && transcript) {
        await recordRealtimeFinalTurn(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          providerItemId: itemId,
          role: 'assistant',
          transcript
        });
      }
      return;
    }
    if (type === 'input_audio_buffer.speech_started') {
      this.speechStartedAt = Date.now();
      await this.touch();
      return;
    }
    if ((type === 'response.audio.delta' || type === 'response.output_audio.delta')
      && this.turnFinalAt && !this.firstOutputRecorded) {
      this.firstOutputRecorded = true;
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'provider_in',
        eventType: 'realtime.response.first_output',
        payload: { latencyMs: Math.max(0, Date.now() - this.turnFinalAt) }
      });
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
      const wasInterrupted = this.speechStartedAt > 0 && this.inResponse;
      this.inResponse = false;
      this.currentAuthorizedResponseId = null;
      await this.state.storage.delete('currentAuthorizedResponseId');
      if (wasInterrupted) {
        await appendRealtimeEvent(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          direction: 'provider_in',
          eventType: 'realtime.response.interrupted',
          payload: { latencyMs: Math.max(0, Date.now() - this.speechStartedAt) }
        });
      }
      this.speechStartedAt = 0;
      const responseStatus = String(event.response?.status || '');
      if (!['completed', 'cancelled'].includes(responseStatus)) {
        await this.terminalize(
          'failed',
          'provider_response_failed',
          cleanProviderCode(event.response?.status_details?.error?.code || responseStatus),
          false
        );
        return;
      }
      const continued = await this.handleUsage(event.response || {});
      if (continued && this.toolContinuationPending) {
        this.toolContinuationPending = false;
        await this.authorizeResponse('tool_output');
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
      this.pendingSessionPolicyHash = null;
      this.pendingSessionPolicySnapshot = null;
      await this.state.storage.delete(['pendingSessionPolicyHash', 'pendingSessionPolicySnapshot']);
      if (this.initialProbePending) {
        this.initialProbePending = false;
        await this.authorizeResponse('initial_state_probe', { forceTool: 'get_planning_state' });
      } else if (this.deferredResponseAuthorization) {
        const deferred = this.deferredResponseAuthorization;
        this.deferredResponseAuthorization = null;
        await this.authorizeResponse(deferred.reason, deferred.options);
      }
      return;
    }
    if (type === 'error') {
      const code = cleanProviderCode(event.error?.code);
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'provider_in',
        eventType: 'realtime.provider.error',
        payload: { code }
      });
      try { this.sendProvider({ type: 'response.cancel' }); } catch (_error) { /* best effort */ }
      await this.terminalize('failed', 'provider_error', code, false);
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
    return constantTimeTextEqual(this.pendingSessionPolicyHash, actualHash)
      && constantTimeTextEqual(this.pendingSessionPolicyHash, expectedSnapshotHash)
      && constantTimeTextEqual(
        stableStringify(this.pendingSessionPolicySnapshot),
        actualSerialized
      );
  }

  async authorizeResponse(reason, options = {}) {
    if (this.closing || this.inResponse || this.pendingResponseAuthorization) return false;
    if (this.pendingSessionPolicyHash) {
      this.deferredResponseAuthorization = {
        reason: String(reason || 'server_authorized').slice(0, 80),
        options: { ...(options || {}) }
      };
      return true;
    }
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
    const authorizationReason = String(reason || 'server_authorized').slice(0, 80);
    const nonce = randomNonce();
    this.pendingResponseAuthorization = { nonce, reason: authorizationReason };
    await this.state.storage.put('pendingResponseAuthorization', this.pendingResponseAuthorization);
    try {
      const forceTool = options?.forceTool === 'get_planning_state'
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
          ...(forceTool
            ? {
                instructions: `Before speaking, call get_planning_state with expectedRevision ${Number(context.sessionRow.current_profile_revision)}. Do not infer or announce planning state before the tool result.`,
                tool_choice: { type: 'function', name: forceTool }
              }
            : {})
        }
      });
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
    const realtimePhase = this.currentPhase || realtimeJourneyPhase(state);
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
        ...buildConfirmedRealtimeFactSummary(profile),
        ...proposedFacts
      ].slice(0, 16),
      likelyModules: (state.recommendations || [])
        .map((item) => item.moduleId)
        .filter((moduleId, index, values) => (
          ['house_purchase', 'liquidity_analysis'].includes(moduleId)
          && values.indexOf(moduleId) === index
        )),
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
      reasoningEscalation
    };
    return { config, sessionRow, profile, state: publicState };
  }

  async refreshJourneyState(overridePhase = null) {
    if (this.pendingSessionPolicyHash) {
      throw new ConsumerError(409, 'realtime_policy_update_pending', 'The live planning policy update is still being verified.');
    }
    const context = await this.planningContext();
    if (overridePhase) this.currentPhase = overridePhase;
    else if (!this.currentPhase) this.currentPhase = realtimeJourneyPhase(context.state);
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
    let status = 'succeeded';
    let errorCode = null;
    let fatalToolError = false;
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new ConsumerError(400, 'realtime_tool_arguments_invalid', 'Live planning tool arguments are invalid.');
      }
      toolName = assertRealtimeToolName(event.name);
      const context = await this.planningContext();
      const stateWithPhase = { ...context.state, realtimePhase: this.currentPhase };
      const allowedNames = new Set(realtimeToolsForState(stateWithPhase).map((tool) => tool.name));
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
      else output = await this.executeTool(toolName, args, context, attempt.row.id);
    } catch (error) {
      status = error instanceof ConsumerError && error.status < 500 ? 'rejected' : 'failed';
      errorCode = error instanceof ConsumerError ? error.code : 'realtime_tool_failed';
      fatalToolError = ['realtime_tool_replay_conflict', 'realtime_tool_replay_incomplete'].includes(errorCode);
      output = { ok: false, errorCode, message: 'The planning service could not complete that action.' };
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
      const functionOutputId = `item_${randomNonce()}`;
      const serializedOutput = JSON.stringify(output);
      this.serverFunctionOutputs.set(functionOutputId, {
        callId: providerToolCallId,
        output: serializedOutput
      });
      this.sendProvider({
        type: 'conversation.item.create',
        item: {
          id: functionOutputId,
          type: 'function_call_output',
          call_id: providerToolCallId,
          output: serializedOutput
        }
      });
      this.toolContinuationPending = true;
      if (!this.inResponse) {
        this.toolContinuationPending = false;
        await this.authorizeResponse('tool_output');
      }
    } catch (_error) {
      await this.terminalize('failed', 'sideband_lost', 'realtime_sideband_lost', false);
    }
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

  async executeTool(toolName, args, context, toolAttemptId) {
    if (toolName === 'get_planning_state') {
      this.requireExpectedRevision(args, context);
      return { ok: true, ...context.state };
    }
    if (toolName === 'propose_facts') {
      this.requireExpectedRevision(args, context);
      if (!Array.isArray(args.facts) || args.facts.length < 1 || args.facts.length > 8) {
        throw new ConsumerError(400, 'realtime_fact_count_invalid', 'Propose between one and eight explicit facts from the finalized answer.');
      }
      const seenFactIds = new Set();
      const evidenceItems = new Set();
      const enabledModules = modulesEnabledByFacts(context.state.recommendations, args.facts);
      const orderedFacts = [...args.facts].sort((left, right) => (
        Number(right.factId === 'primary_goal') - Number(left.factId === 'primary_goal')
      ));
      let projectedProfile = context.profile;
      const normalized = orderedFacts.map((fact) => {
        this.requireFinalizedEvidence(fact.evidenceItemId);
        evidenceItems.add(fact.evidenceItemId);
        if (seenFactIds.has(fact.factId)) {
          throw new ConsumerError(400, 'realtime_fact_duplicate', 'Each semantic fact may be proposed once per answer.');
        }
        seenFactIds.add(fact.factId);
        if (!realtimeFactAllowed(fact.factId, enabledModules)) {
          throw new ConsumerError(409, 'realtime_fact_not_routed', 'That semantic fact is not used by the currently routed canary modules.');
        }
        if (!['exact', 'approximate', 'range', 'unknown'].includes(fact.certainty)) {
          throw new ConsumerError(400, 'realtime_fact_certainty_invalid', 'Fact certainty is invalid.');
        }
        const mapped = mapRealtimeFact(projectedProfile, fact);
        const patch = { [mapped.fieldPath]: mapped.canonicalValue };
        projectedProfile = applyProfilePatch(projectedProfile, patch, [], 'ai_extraction');
        return { fact, mapped, patch };
      });
      if (evidenceItems.size !== 1) {
        throw new ConsumerError(409, 'realtime_fact_evidence_mixed', 'Facts in one proposal batch must come from the same finalized consumer answer.');
      }
      const proposals = [];
      for (const { fact, mapped, patch } of normalized) {
        const range = fact.certainty === 'range' ? boundedProposalRange(fact.value) : null;
        if (fact.certainty === 'range' && !range) {
          throw new ConsumerError(400, 'realtime_fact_range_invalid', 'A ranged fact requires finite minimum and maximum values.');
        }
        proposals.push(await createRealtimeFactProposal(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          toolAttemptId,
          factId: fact.factId,
          value: range ? { value: mapped.displayValue, range } : mapped.displayValue,
          patch,
          baseProfileRevision: Number(context.sessionRow.current_profile_revision),
          evidenceItemId: fact.evidenceItemId,
          confidence: fact.certainty === 'exact' ? 'medium' : 'low',
          certainty: fact.certainty
        }));
      }
      return { ok: true, proposals, currentProposalId: proposals[0]?.id || null, readBackRequired: true };
    }
    if (toolName === 'resolve_fact_confirmation') {
      this.requireExpectedRevision(args, context);
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
      if (args.decision === 'rejected') {
        const rejected = await rejectRealtimeFactProposal(
          this.env,
          this.meta.sessionId,
          this.meta.leaseId,
          args.proposalId,
          args.evidenceItemId
        );
        return { ok: true, proposal: rejected };
      }
      if (args.decision !== 'confirmed') {
        throw new ConsumerError(400, 'realtime_confirmation_decision_invalid', 'Fact confirmation decision is invalid.');
      }
      const paths = Object.keys(proposal.patch);
      if (paths.length !== 1) throw new ConsumerError(409, 'realtime_fact_proposal_invalid', 'The fact proposal is invalid.');
      const fieldPath = paths[0];
      let nextProfile = applyProfilePatch(context.profile, proposal.patch, [], 'consumer_edit');
      const certainty = String(proposal.row.certainty || 'unknown');
      const range = certainty === 'range' ? boundedProposalRange(proposal.value) : null;
      if (certainty === 'range' && !range) {
        throw new ConsumerError(409, 'realtime_fact_proposal_invalid', 'The ranged fact proposal is invalid.');
      }
      Object.keys(nextProfile.fieldMetadata || {})
        .filter((path) => path === fieldPath || path.startsWith(`${fieldPath}/`))
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
      nextProfile = normalizeHouseholdProfile(nextProfile);
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
      await this.refreshJourneyState();
      return { ok: true, proposalId: args.proposalId, status: 'confirmed', profileRevision: committed.revision };
    }
    if (toolName === 'get_module_plan') {
      this.requireExpectedRevision(args, context);
      return {
        ok: true,
        profileRevision: Number(context.sessionRow.current_profile_revision),
        confirmedProfileRevision: context.sessionRow.confirmed_profile_revision === null
          ? null
          : Number(context.sessionRow.confirmed_profile_revision),
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
      this.requireExpectedRevision(args, context);
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
    await this.refreshJourneyState(phase);
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
      await this.scheduleAlarm();
    }
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
      if (wasDispatched && !providerCallId) {
        throw new ConsumerError(502, 'realtime_hangup_uncertain', 'The live provider call could not be terminated safely.');
      }
      if (wasDispatched) {
        await hangupOpenAiRealtimeCall({ env: this.env, providerCallId });
      }
      hangupConfirmed = true;
    } catch (error) {
      this.closing = false;
      await this.state.storage.setAlarm(Date.now() + 5_000).catch(() => {});
      if (error instanceof ConsumerError) throw error;
      throw new ConsumerError(502, 'realtime_hangup_uncertain', 'The live provider call could not be terminated safely.');
    }
    if (this.webSocket && this.webSocket.readyState === 1) {
      try { this.webSocket.close(1000, String(reason).slice(0, 100)); } catch (_error) { /* best effort */ }
    }
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'realtime.call.closed',
      payload: { reason, status }
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
      await this.state.storage.setAlarm(Date.now() + 5_000).catch(() => {});
      throw new ConsumerError(503, 'realtime_close_failed', 'The live voice session could not be closed safely.');
    }
    if (!row || ['pending', 'active', 'closing'].includes(row.status)) {
      this.closing = false;
      await this.state.storage.setAlarm(Date.now() + 5_000).catch(() => {});
      throw new ConsumerError(503, 'realtime_close_failed', 'The live voice session could not be closed safely.');
    }
    const noUnmeteredWork = !this.inResponse
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
        await settleConsumerProviderCostUnknown(this.env, this.meta.costEntryId, { errorCode: errorCode || reason });
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
