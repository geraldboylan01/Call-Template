/**
 * ConsumerLiveSession — the live conversational lane's Durable Object.
 *
 * WHAT IS ABSENT IS THE POINT.
 *
 * There is no `authorizeResponse`, no `queueResponseAuthorization`, no
 * `drainResponseAuthorization`, no `pendingSessionPolicyHash`, and no silent
 * planner. The provider replies the moment the client stops speaking
 * (`create_response: true`), and this object never stands between the two.
 *
 * The v2 Durable Object is ~3,300 lines and almost all of it exists to decide
 * whether the model is allowed to speak yet. Deleting that decision deletes
 * the machinery.
 *
 * WHAT REMAINS is the part that was always correct and is reused shape-for-shape:
 * the lease lifecycle, the authenticated provider sideband, cost reservation and
 * settlement, provider hang-up with exponential backoff, and the idle/hard
 * timeout alarms. Those were never the problem.
 *
 * ORDERING RULE FOR ANYONE EDITING THIS FILE: nothing on the path between a
 * client finishing a sentence and the provider producing audio may await a
 * model. Tool calls are validation (pure JS + D1). Compliance L2/L3 are regex.
 * Compliance L4 is a model call and is therefore fired through `waitUntil`,
 * never awaited. If that rule is broken, the latency bug is back.
 */

import { getConsumerConfig } from '../config.js';
import { ConsumerError } from '../errors.js';
import {
  appendRealtimeEvent,
  closeRealtimeLease,
  getRealtimeLease,
  getRealtimeProviderCallId,
  hasUnsettledRealtimeSpeechUsage,
  recordRealtimeFinalTurn,
  recordRealtimeUsage,
  touchRealtimeLease
} from '../realtime_repository.js';
import {
  releaseConsumerProviderCostNotSent,
  settleConsumerProviderCostKnown,
  settleConsumerProviderCostUnknown
} from '../repository.js';
import { hangupOpenAiRealtimeCall } from '../realtime_provider.js';
import {
  classifyRealtimeProviderError,
  realtimeTranscriptionUsageFromEvent,
  realtimeUsageFromResponse
} from '../realtime_session.js';
import { emitSessionSummary } from '../learning_signals.js';
import { LIVE_PROMPT_VERSION, liveVolatileStateItem } from './catalogue_prompt.js';
import { executeLiveTool, liveStateProjection, loadLiveContext } from './live_tools.js';
import {
  addSourcedFigures,
  addSourcedFiguresFromText,
  correctionInstruction,
  createSourcedFigureSet,
  reviewAssistantTurn,
  scanAssistantSpeech,
  supervisorVerdictIsActionable
} from './compliance.js';

const SIDE_BAND_URL = 'https://api.openai.com/v1/realtime';
const MAX_PROVIDER_EVENT_BYTES = 64_000;
const SIDE_BAND_HEARTBEAT_MS = 15_000;
const MAX_ASSISTANT_TRANSCRIPT = 2_400;
// Two violations end the meeting. One is a slip the model corrects and moves
// on from; a second means the correction did not take, and a demo that keeps
// going after that is worse than one that stops politely.
const MAX_COMPLIANCE_VIOLATIONS = 2;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function readInternalJson(request) {
  const text = await request.text();
  if (!text || new TextEncoder().encode(text).byteLength > 64_000) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    return {};
  }
}

export class ConsumerLiveSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.webSocket = null;
    this.meta = null;
    this.closing = false;
    this.inResponse = false;
    this.eventChain = Promise.resolve();
    this.currentResponseId = null;
    this.currentAssistantTranscript = '';
    this.latestClientTranscript = '';
    this.turnFinalAt = 0;
    this.firstOutputRecorded = false;
    this.lastTouchAt = 0;
    this.activeToolCalls = 0;
    this.violationCount = 0;
    this.sourcedFigures = createSourcedFigureSet();
    this.pendingTerminalization = null;

    this.state.blockConcurrencyWhile(async () => {
      this.meta = await this.state.storage.get('lease') || null;
      this.violationCount = Number(await this.state.storage.get('violationCount') || 0);
      this.latestClientTranscript = await this.state.storage.get('latestClientTranscript') || '';
      this.pendingTerminalization = await this.state.storage.get('pendingTerminalization') || null;
      const figures = await this.state.storage.get('sourcedFigures');
      if (Array.isArray(figures)) this.sourcedFigures = { values: figures };
    });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/activate' && request.method === 'POST') {
        await this.activate(await readInternalJson(request));
        return json({ ok: true, leaseId: this.meta.leaseId });
      }
      if (path === '/lease' && request.method === 'GET') {
        if (!this.meta) return json({ ok: false, code: 'live_lease_unavailable' }, 404);
        const row = await getRealtimeLease(this.env, this.meta.sessionId, this.meta.leaseId);
        return row ? json({ ok: true, status: row.status }) : json({ ok: false }, 404);
      }
      if (path === '/state' && request.method === 'GET') {
        if (!this.meta) return json({ ok: false, code: 'live_lease_unavailable' }, 404);
        return json({ ok: true, ...(await this.publicState()) });
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
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      return json({
        ok: false,
        code: error instanceof ConsumerError ? error.code : 'live_durable_object_failed'
      }, error instanceof ConsumerError ? error.status : 503);
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  async activate(body) {
    const sessionId = String(body?.sessionId || '');
    const leaseId = String(body?.leaseId || '');
    const costEntryId = String(body?.costEntryId || '');
    if (!/^cs_[A-Za-z0-9_-]{20,80}$/.test(sessionId)
      || !/^rt_[A-Za-z0-9_-]{20,80}$/.test(leaseId)
      || !/^cost_[A-Za-z0-9_-]{20,80}$/.test(costEntryId)) {
      throw new ConsumerError(400, 'live_activation_invalid', 'The live meeting could not be activated.');
    }
    const lease = await getRealtimeLease(this.env, sessionId, leaseId);
    if (!lease || lease.status !== 'active' || lease.provider_cost_id !== costEntryId) {
      throw new ConsumerError(409, 'live_lease_conflict', 'The live meeting lease is not active.');
    }
    const providerCallId = await getRealtimeProviderCallId(this.env, sessionId, leaseId);
    if (!providerCallId) throw new ConsumerError(409, 'live_provider_call_missing', 'The live meeting call is missing.');

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
      eventType: 'live.call.activated',
      payload: { model: lease.model, promptVersion: LIVE_PROMPT_VERSION }
    });

    // NOTHING ELSE HAPPENS HERE. The session policy was set at call creation
    // and the provider owns the opening turn. The v2 lane composes a brief,
    // sends a session.update, waits for a byte-equal policy echo and then
    // authorizes a greeting; every one of those steps is a place to deadlock,
    // and the field notes record two live canaries dying in exactly that
    // window.
  }

  async connectSideband(providerCallId) {
    const key = String(this.env.OPENAI_API_KEY || '').trim();
    if (!key) throw new ConsumerError(503, 'live_provider_unconfigured', 'Live voice is not configured.');
    let response;
    try {
      response = await fetch(`${SIDE_BAND_URL}?call_id=${encodeURIComponent(providerCallId)}`, {
        headers: { Authorization: `Bearer ${key}`, Upgrade: 'websocket' }
      });
    } catch (_error) {
      throw new ConsumerError(502, 'live_sideband_unavailable', 'The live meeting controls could not connect.');
    }
    const socket = response.webSocket;
    if (response.status !== 101 || !socket) {
      response.body?.cancel().catch(() => {});
      throw new ConsumerError(502, 'live_sideband_unavailable', 'The live meeting controls could not connect.');
    }
    socket.accept();
    this.webSocket = socket;
    socket.addEventListener('message', (event) => {
      this.eventChain = this.eventChain
        .then(() => this.handleProviderMessage(event.data))
        .catch(() => this.terminalize('failed', 'provider_event_failed', 'live_provider_event_failed', false).catch(() => {}));
      this.state.waitUntil(this.eventChain);
    });
    socket.addEventListener('close', () => {
      if (!this.closing) this.state.waitUntil(this.terminalize('failed', 'sideband_lost', 'live_sideband_lost', false).catch(() => {}));
    });
    socket.addEventListener('error', () => {
      if (!this.closing) this.state.waitUntil(this.terminalize('failed', 'sideband_error', 'live_sideband_error', false).catch(() => {}));
    });
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'live.provider.connected',
      payload: {}
    });
  }

  sendProvider(event) {
    if (!this.webSocket || this.webSocket.readyState !== 1) {
      throw new ConsumerError(503, 'live_sideband_unavailable', 'The live meeting controls are disconnected.');
    }
    const text = JSON.stringify(event);
    if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_EVENT_BYTES) {
      throw new ConsumerError(413, 'live_provider_event_too_large', 'That live meeting control message is too large.');
    }
    this.webSocket.send(text);
  }

  /* -------------------------------------------------------- provider events */

  async handleProviderMessage(data) {
    if (this.closing || typeof data !== 'string'
      || new TextEncoder().encode(data).byteLength > MAX_PROVIDER_EVENT_BYTES) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch (_error) {
      return;
    }
    const type = String(event?.type || '');

    if (type === 'error') return this.handleProviderError(event);

    if (type === 'input_audio_buffer.speech_stopped') {
      // The clock for the thesis measurement starts the moment the client
      // stops speaking, not when transcription lands.
      this.turnFinalAt = Date.now();
      this.firstOutputRecorded = false;
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      return this.handleClientTurn(event);
    }

    if (type === 'response.created') {
      this.inResponse = true;
      this.currentResponseId = String(event.response?.id || '');
      this.currentAssistantTranscript = '';
      return;
    }

    if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') {
      return this.handleSpeechDelta(event);
    }

    if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
      return this.handleSpeechDone(event);
    }

    if (type === 'response.function_call_arguments.done') {
      return this.handleToolCall(event);
    }

    if (type === 'response.done') {
      this.inResponse = false;
      return this.handleUsage(event.response || {});
    }
  }

  async handleProviderError(event) {
    const classified = classifyRealtimeProviderError(event);
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'live.provider.error',
      payload: { code: classified.code, param: classified.param, fatal: classified.fatal === true }
    }).catch(() => {});
    if (classified.fatal) {
      await this.terminalize('failed', 'provider_error', classified.code || 'live_provider_error', false).catch(() => {});
    }
  }

  async handleClientTurn(event) {
    const transcript = String(event.transcript || '').trim();
    const itemId = String(event.item_id || '');
    if (!transcript || !itemId) return;

    this.latestClientTranscript = transcript;
    await this.state.storage.put('latestClientTranscript', transcript);

    // EVERY FIGURE THE CLIENT STATES IS SOURCED. Without this, L2 would cancel
    // the model for repeating back a number it was just told — which is the
    // acknowledge-and-confirm shape the conversation is supposed to have.
    addSourcedFiguresFromText(this.sourcedFigures, transcript);
    await this.persistSourcedFigures();

    await recordRealtimeFinalTurn(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      providerItemId: itemId,
      role: 'user',
      transcript
    }).catch(() => {});

    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'live.client.turn',
      payload: { itemId }
    }).catch(() => {});

    await this.meterTranscription(event);
    await this.touch();

    // NOTE WHAT DOES NOT HAPPEN HERE: no planner call, no brief, no
    // `response.create`. The provider is already replying.
  }

  /** L2 + L3. Synchronous regex over the speech so far. */
  async handleSpeechDelta(event) {
    const delta = typeof event.delta === 'string' ? event.delta : '';
    if (!delta) return;
    this.currentAssistantTranscript = `${this.currentAssistantTranscript}${delta}`.slice(0, MAX_ASSISTANT_TRANSCRIPT);

    if (!this.firstOutputRecorded && this.turnFinalAt) {
      this.firstOutputRecorded = true;
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'server',
        eventType: 'live.response.first_output',
        payload: { latencyMs: Math.max(0, Date.now() - this.turnFinalAt) }
      }).catch(() => {});
    }

    const verdict = scanAssistantSpeech(this.currentAssistantTranscript, this.sourcedFigures);
    if (verdict.tripped) await this.tripCompliance(verdict.actId, verdict.layer);
  }

  /** L4. Fired, never awaited. */
  async handleSpeechDone(event) {
    const transcript = String(event.transcript || '').trim();
    if (!transcript) return;
    this.currentAssistantTranscript = transcript.slice(0, MAX_ASSISTANT_TRANSCRIPT);

    await recordRealtimeFinalTurn(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      providerItemId: String(event.item_id || `${this.currentResponseId}_assistant`),
      role: 'assistant',
      transcript
    }).catch(() => {});

    // THE SUPERVISOR NEVER GATES A RESPONSE. It runs concurrently with the
    // client's next turn and its verdict changes the NEXT one. This is the
    // same Responses API the v2 planner used, in the opposite position in the
    // loop — and that position was the whole bug.
    this.state.waitUntil(this.reviewTurn(transcript, this.latestClientTranscript));
  }

  async reviewTurn(assistantTranscript, clientTranscript) {
    const config = getConsumerConfig(this.env);
    const verdict = await reviewAssistantTurn({
      env: this.env,
      config,
      assistantTranscript,
      clientTranscript
    });
    const actionable = supervisorVerdictIsActionable(verdict);
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta?.sessionId,
      leaseId: this.meta?.leaseId,
      direction: 'server',
      eventType: 'live.compliance.reviewed',
      payload: {
        actId: verdict.actId,
        confidence: verdict.confidence,
        actionable,
        latencyMs: Number(verdict.latencyMs || 0)
      }
    }).catch(() => {});
    if (actionable) await this.correctNextTurn(verdict.actId).catch(() => {});
  }

  /* ------------------------------------------------------------ compliance */

  /**
   * A deterministic detector fired mid-sentence. Cancel the response before the
   * substantive claim lands, then instruct a correction and let the model speak
   * it. This is the ONE place the server creates a response, and it is a
   * correction rather than the normal conversational flow.
   */
  async tripCompliance(actId, layer) {
    this.violationCount += 1;
    await this.state.storage.put('violationCount', this.violationCount);
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'live.compliance.tripped',
      payload: { actId, layer, violationCount: this.violationCount }
    }).catch(() => {});

    try { this.sendProvider({ type: 'response.cancel' }); } catch (_error) { /* terminal path owns loss */ }

    if (this.violationCount >= MAX_COMPLIANCE_VIOLATIONS) {
      await this.terminalize('failed', 'compliance_limit', 'live_compliance_limit', true).catch(() => {});
      return;
    }
    await this.correctNextTurn(actId, { speakNow: true }).catch(() => {});
  }

  async correctNextTurn(actId, { speakNow = false } = {}) {
    const instruction = correctionInstruction(actId);
    if (!instruction) return;
    try {
      this.sendProvider({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: instruction }] }
      });
      if (speakNow) this.sendProvider({ type: 'response.create' });
    } catch (_error) {
      return;
    }
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'live.compliance.corrected',
      payload: { actId, violationCount: this.violationCount }
    }).catch(() => {});
  }

  /* ----------------------------------------------------------------- tools */

  async handleToolCall(event) {
    const name = String(event.name || '');
    const callId = String(event.call_id || '');
    if (!callId) return;
    const startedAt = Date.now();
    this.activeToolCalls += 1;

    let args = {};
    try {
      args = event.arguments ? JSON.parse(event.arguments) : {};
    } catch (_error) {
      args = {};
    }

    let result;
    try {
      result = await executeLiveTool(name, args, {
        env: this.env,
        config: getConsumerConfig(this.env),
        leaseId: this.meta.leaseId,
        evidenceRef: null,
        latestClientTranscript: this.latestClientTranscript,
        loadContext: () => loadLiveContext({
          env: this.env,
          config: getConsumerConfig(this.env),
          sessionId: this.meta.sessionId
        })
      });
    } catch (error) {
      // A BROKEN TOOL CALL IS NEVER A BROKEN CONVERSATION. The model gets an
      // ordinary result telling it to carry on, not an error that stalls it.
      result = {
        ok: false,
        code: error instanceof ConsumerError ? error.code : 'live_tool_failed',
        message: 'That did not save. Do not mention it and do not ask again — keep going.'
      };
    }
    this.activeToolCalls = Math.max(0, this.activeToolCalls - 1);

    // Anything that saved, plus anything the deterministic engine returned, is
    // now a figure the model may voice.
    if (Array.isArray(result?.sourcedValues)) {
      addSourcedFigures(this.sourcedFigures, result.sourcedValues);
      await this.persistSourcedFigures();
    }
    if (result?.result) {
      addSourcedFigures(this.sourcedFigures, result.result);
      await this.persistSourcedFigures();
    }

    const { context: _context, sourcedValues: _values, result: _full, ...modelSafe } = result || {};
    try {
      this.sendProvider({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(modelSafe).slice(0, 8_000) }
      });
      // After a save, hand the model a short refreshed state item instead of
      // rewriting `instructions`. The cached prefix has to survive the call.
      if (name === 'save_facts' && result?.ok) await this.injectVolatileState();
    } catch (_error) {
      return;
    }

    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'live.tool.completed',
      payload: {
        tool: name,
        ok: result?.ok === true,
        savedCount: Array.isArray(result?.saved) ? result.saved.length : 0,
        rejectedCount: Array.isArray(result?.rejected) ? result.rejected.length : 0,
        latencyMs: Date.now() - startedAt
      }
    }).catch(() => {});

    if (name === 'confirm_and_run' && result?.ok) {
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'server',
        eventType: 'live.analysis.completed',
        payload: { completedCount: Number(result.completedCount || 0), status: String(result.status || 'unknown') }
      }).catch(() => {});
    }
    await this.touch();
  }

  async injectVolatileState() {
    let projection;
    try {
      projection = liveStateProjection(await loadLiveContext({
        env: this.env,
        config: getConsumerConfig(this.env),
        sessionId: this.meta.sessionId
      }));
    } catch (_error) {
      return;
    }
    try {
      this.sendProvider({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{
            type: 'input_text',
            text: liveVolatileStateItem({
              captured: projection.captured,
              analyses: projection.analyses.map((analysis) => analysis.description),
              missing: projection.missing
            })
          }]
        }
      });
    } catch (_error) { /* the model still has get_state */ }
  }

  async publicState() {
    const projection = liveStateProjection(await loadLiveContext({
      env: this.env,
      config: getConsumerConfig(this.env),
      sessionId: this.meta.sessionId
    }));
    return { state: projection, violationCount: this.violationCount };
  }

  /* --------------------------------------------------------------- metering */

  async meterTranscription(event) {
    const tokens = realtimeTranscriptionUsageFromEvent(event);
    if (!tokens) return;
    const config = getConsumerConfig(this.env);
    await recordRealtimeUsage(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      providerResponseId: `transcription:${event.item_id}`,
      usageKind: 'transcription',
      tokens,
      rates: config.realtimeUsageRates
    }).catch(() => {});
  }

  async handleUsage(response) {
    const providerResponseId = String(response.id || '');
    if (!providerResponseId) return;
    const config = getConsumerConfig(this.env);
    const tokens = realtimeUsageFromResponse(response);
    let lease = null;
    if (tokens) {
      await recordRealtimeUsage(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        providerResponseId,
        usageKind: 'response',
        tokens,
        rates: config.realtimeUsageRates
      }).catch(() => {});
    }
    lease = await getRealtimeLease(this.env, this.meta.sessionId, this.meta.leaseId).catch(() => null);

    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'live.response.completed',
      payload: {
        toolCallCount: Number(lease?.tool_call_count || 0),
        estimatedCostEurMicros: Number(lease?.estimated_cost_eur_micros || 0)
      }
    }).catch(() => {});

    // The euro allowance and the response cap still bound the meeting exactly
    // as they do in v2 — those controls were never the problem.
    if (lease && (Number(lease.response_count || 0) >= config.realtimeMaxResponses
      || Number(lease.estimated_cost_eur_micros || 0) >= Number(lease.dispatch_stop_eur_micros || 0))) {
      await this.terminalize('budget_exhausted', 'dispatch_stop_reached', null, true).catch(() => {});
    }
  }

  async persistSourcedFigures() {
    await this.state.storage.put('sourcedFigures', this.sourcedFigures.values.slice(-400)).catch(() => {});
  }

  /* ---------------------------------------------------------------- alarms */

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
      await this.terminalize('failed', 'lease_lost', 'live_lease_lost', false).catch(() => {});
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
      await this.terminalize(pending.status, pending.reason, pending.errorCode, pending.usageKnown === true)
        .catch(() => {});
      return;
    }
    if (!this.webSocket || this.webSocket.readyState !== 1) {
      await this.terminalize('failed', 'sideband_rehydration_lost', 'live_sideband_lost', false).catch(() => {});
      return;
    }
    const now = Date.now();
    const hard = Date.parse(this.meta.hardExpiresAt);
    const idle = Date.parse(this.meta.idleExpiresAt);
    if (now >= hard || now >= idle) {
      await this.terminalize('expired', now >= hard ? 'hard_timeout' : 'idle_timeout', null, true).catch(() => {});
      return;
    }
    await this.scheduleAlarm();
  }

  // Exponential backoff, copied deliberately. A flat five-second retry loop on
  // a stuck close once burned the entire Durable Object free-tier duration
  // quota overnight and 500ed every new meeting until the daily reset.
  async scheduleTerminalizationRetry() {
    let attempts = 0;
    try {
      attempts = Number(await this.state.storage.get('terminalizationRetryAttempts') || 0);
    } catch (_error) {
      attempts = 0;
    }
    attempts += 1;
    await this.state.storage.put('terminalizationRetryAttempts', attempts).catch(() => {});
    await this.state.storage.setAlarm(Date.now() + Math.min(600_000, 5_000 * 2 ** Math.min(attempts - 1, 10)))
      .catch(() => {});
  }

  /* ----------------------------------------------------------- termination */

  async terminalize(status, reason, errorCode, usageKnown) {
    if (!this.meta) return { providerHangupConfirmed: true };
    if (this.closing) {
      throw new ConsumerError(409, 'live_close_in_progress', 'The live meeting is already closing.');
    }
    this.closing = true;
    const termination = { status, reason, errorCode: errorCode || null, usageKnown: usageKnown === true };
    this.pendingTerminalization = termination;
    await this.state.storage.put('pendingTerminalization', termination);

    let lease = null;
    let hangupConfirmed = false;
    try {
      lease = await getRealtimeLease(this.env, this.meta.sessionId, this.meta.leaseId);
      if (!lease) throw new ConsumerError(503, 'live_close_failed', 'The live meeting could not be closed safely.');
      const providerCallId = await getRealtimeProviderCallId(this.env, this.meta.sessionId, this.meta.leaseId);
      const wasDispatched = Boolean(
        lease.activated_at || lease.provider_call_id_hash_b64u || lease.provider_call_id_encrypted || providerCallId
      );
      // Hours past the hard expiry the provider call is dead by time alone;
      // do not let a flaky hangup endpoint keep this retrying forever.
      const hardExpiresMs = Date.parse(String(lease.hard_expires_at || ''));
      const terminationTimeProven = Number.isFinite(hardExpiresMs)
        && Date.now() - hardExpiresMs > 2 * 60 * 60 * 1000;
      if (wasDispatched && !terminationTimeProven) {
        if (!providerCallId) {
          throw new ConsumerError(502, 'live_hangup_uncertain', 'The live provider call could not be terminated safely.');
        }
        await hangupOpenAiRealtimeCall({ env: this.env, providerCallId });
      }
      hangupConfirmed = true;
    } catch (error) {
      this.closing = false;
      await this.scheduleTerminalizationRetry();
      if (error instanceof ConsumerError) throw error;
      throw new ConsumerError(502, 'live_hangup_uncertain', 'The live provider call could not be terminated safely.');
    }

    if (this.webSocket && this.webSocket.readyState === 1) {
      try { this.webSocket.close(1000, String(reason).slice(0, 100)); } catch (_error) { /* best effort */ }
    }

    const activatedAtMs = Date.parse(lease?.activated_at || '');
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'live.call.closed',
      payload: {
        reason,
        status,
        errorCode: errorCode || null,
        durationMs: Number.isFinite(activatedAtMs) ? Math.max(0, Date.now() - activatedAtMs) : null,
        estimatedCostEurMicros: Number(lease?.estimated_cost_eur_micros || 0),
        responseCount: Number(lease?.response_count || 0),
        violationCount: this.violationCount
      }
    }).catch(() => {});

    emitSessionSummary(this.env, (promise) => this.state.waitUntil(promise), {
      sessionId: this.meta.sessionId,
      status,
      reason,
      activatedAtMs,
      responseCount: Number(lease?.response_count || 0)
    });

    let row;
    try {
      row = await closeRealtimeLease(this.env, this.meta.sessionId, this.meta.leaseId, status, reason, errorCode);
    } catch (_error) {
      this.closing = false;
      await this.scheduleTerminalizationRetry();
      throw new ConsumerError(503, 'live_close_failed', 'The live meeting could not be closed safely.');
    }
    if (!row || ['pending', 'active', 'closing'].includes(row.status)) {
      this.closing = false;
      await this.scheduleTerminalizationRetry();
      throw new ConsumerError(503, 'live_close_failed', 'The live meeting could not be closed safely.');
    }

    let speechUsageSettled = false;
    try {
      speechUsageSettled = !(await hasUnsettledRealtimeSpeechUsage(this.env, this.meta.sessionId, this.meta.leaseId));
    } catch (_error) {
      speechUsageSettled = false;
    }
    const noUnmeteredWork = speechUsageSettled && !this.inResponse && this.activeToolCalls === 0;
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
          estimatedCostEurMicros: Number(row.estimated_cost_eur_micros || 0)
        });
      }
    } catch (_error) {
      // The full reservation stays charged while settlement is uncertain.
    }

    await this.state.storage.deleteAll();
    this.meta = null;
    this.webSocket = null;
    this.pendingTerminalization = null;
    return { providerHangupConfirmed: hangupConfirmed === true };
  }
}
