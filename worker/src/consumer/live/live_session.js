/**
 * ConsumerLiveSession — the live conversational lane's Durable Object.
 *
 * WHAT IS ABSENT IS THE POINT.
 *
 * There is no `authorizeResponse`, no `queueResponseAuthorization`, no
 * `drainResponseAuthorization`, and no `pendingSessionPolicyHash`. The
 * provider replies the moment the client stops speaking (`create_response:
 * true`), and the asynchronous planning auditor never stands between the two.
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
  beginRealtimeToolAttempt,
  closeRealtimeLease,
  completeRealtimeToolAttempt,
  getRealtimeLease,
  getRealtimeProviderCallId,
  hasUnsettledRealtimeSpeechUsage,
  recoverStalePlannerReconciliation,
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
import { applyPlannerCandidates } from '../planning_turn.js';
import { extractRealtimePlannerTurn } from '../realtime_planner.js';
import { runPlannerReconciliation } from '../planner_reconciliation.js';
import { classifySpokenPlanConfirmation } from '../realtime_completion.js';
import {
  classifyRealtimeProviderError,
  realtimeTranscriptionUsageFromEvent,
  realtimeUsageFromResponse
} from '../realtime_session.js';
import { emitSessionSummary } from '../learning_signals.js';
import { LIVE_PROMPT_VERSION, liveVolatileStateItem } from './catalogue_prompt.js';
import {
  executeLiveTool,
  LIVE_TOOLSET_VERSION,
  liveStateProjection,
  loadLiveContext
} from './live_tools.js';
import { redundantQuestionVerdict } from './question_guard.js';
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
// The provider caps a meeting at 40 responses and 24 tool calls. Keep a little
// headroom for cancelled/correction responses while making every transient
// association structure explicitly bounded.
const MAX_LIVE_TURN_LEDGER_ENTRIES = 64;
const MAX_DEFERRED_EVIDENCE_TOOL_CALLS = 32;
const MAX_RECONCILIATION_RECOVERY_ATTEMPTS = 1;
const MIN_RECONCILIATION_STALE_MS = 30_000;
const RECONCILIATION_RETRY_BUFFER_MS = 5_000;
/**
 * Outstanding planner clarifications kept for the speaking model.
 *
 * Held slightly above what one turn renders so a request is not lost while a
 * busier one is in front of it, but still bounded: an unbounded queue of things
 * to ask is how a conversation turns into an interrogation.
 */
const MAX_LIVE_PLANNER_REQUESTS = 6;
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

/**
 * Confirmation may use only a profile that includes review of the causal
 * finalized client turn. Legacy mode deliberately preserves the previous
 * behavior; shadow/apply fail closed until that exact turn owns the durable
 * reconciliation watermark.
 */
export function plannerReconciliationPreflight(mode, causalTurnId, lease) {
  if (mode === 'legacy') return { ready: true, reason: 'legacy' };
  const status = String(lease?.planner_reconciliation_status || '');
  const reviewed = ['shadow', 'applied'].includes(status)
    && Boolean(causalTurnId)
    && lease?.planner_reconciled_through_turn_id === causalTurnId;
  return reviewed
    ? { ready: true, reason: 'reviewed' }
    : { ready: false, reason: 'reconciliation_pending' };
}

/** Map a deterministic before/after state projection to one scheduler cause. */
export function reconciliationTriggerForProjection(before, after, savedFactIds = []) {
  const readinessSignature = (projection) => JSON.stringify({
    readyToConfirm: projection?.readyToConfirm === true,
    analyses: (projection?.analyses || []).map((analysis) => analysis.status)
  });
  if (readinessSignature(before) !== readinessSignature(after)) return 'readiness_transition';
  const neededFactIds = new Set((before?.analyses || [])
    .flatMap((analysis) => analysis.stillNeeded || [])
    .map((need) => need.factId)
    .filter(Boolean));
  return (savedFactIds || []).some((factId) => neededFactIds.has(factId))
    ? 'answered_need'
    : null;
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

/**
 * Provider auto-response can emit `response.created` before the finalized
 * client transcription. In that ordering, the response-start snapshot does
 * not yet contain figures the client just spoke. Add only those transcript
 * figures to the active snapshot; tool-saved values remain global and become
 * available to the next response, never retroactively to this one.
 */
export function sourceClientFiguresForActiveResponse(
  currentResponseSourcedFigures,
  transcript,
  responseInProgress
) {
  if (responseInProgress) {
    addSourcedFiguresFromText(currentResponseSourcedFigures, transcript);
  }
  return currentResponseSourcedFigures;
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
    this.reconciliationChain = Promise.resolve();
    this.reconciliationPersistenceChain = Promise.resolve();
    this.reconciliationDrainScheduled = false;
    this.pendingReconciliationTurn = null;
    this.queuedReconciliationTurn = null;
    // What the background planner could not settle from the transcript, held
    // for the speaking model to raise. Durable so a hibernated meeting does not
    // quietly forget an outstanding question.
    this.plannerRequests = [];
    this.activeReconciliationTurn = null;
    this.scheduledReconciliationTurnIds = new Set();
    this.currentResponseId = null;
    this.currentAssistantTranscript = '';
    this.lastCompletedAssistantTranscript = '';
    this.latestClientTranscript = '';
    this.turnFinalAt = 0;
    this.firstOutputRecorded = false;
    this.lastTouchAt = 0;
    this.activeToolCalls = 0;
    this.violationCount = 0;
    this.sourcedFigures = createSourcedFigureSet();
    this.currentResponseSourcedFigures = createSourcedFigureSet();
    this.pendingClientTranscription = false;
    this.pendingClientTranscriptionUnavailable = false;
    this.currentResponseAwaitingClientTranscription = false;
    this.currentResponseNumericContainmentUnavailable = false;
    // Input transcription is asynchronous with response generation. Provider
    // item/response ids, not "latest" globals, own every association below.
    this.clientTurnOrdinal = 0;
    this.latestClientTranscriptOrdinal = 0;
    this.clientTurnsByItemId = new Map();
    this.unboundAutoResponseTurnIds = [];
    this.responseContextsById = new Map();
    this.deferredEvidenceToolsByItemId = new Map();
    this.deferredEvidenceToolCallIds = new Set();
    this.processedToolCallIds = new Set();
    this.clientNumericEvidenceIncomplete = false;
    this.pendingTerminalization = null;

    this.state.blockConcurrencyWhile(async () => {
      this.meta = await this.state.storage.get('lease') || null;
      this.violationCount = Number(await this.state.storage.get('violationCount') || 0);
      this.latestClientTranscript = await this.state.storage.get('latestClientTranscript') || '';
      this.pendingTerminalization = await this.state.storage.get('pendingTerminalization') || null;
      this.plannerRequests = await this.state.storage.get('plannerRequests') || [];
      const storedReconciliationQueue = await this.state.storage.get('pendingReconciliationTurn') || null;
      if (storedReconciliationQueue?.schemaVersion === 1) {
        this.pendingReconciliationTurn = storedReconciliationQueue.current || null;
        this.queuedReconciliationTurn = storedReconciliationQueue.queued || null;
      } else {
        // Compatibility with jobs written by the first shadow scheduler.
        this.pendingReconciliationTurn = storedReconciliationQueue;
      }
      for (const job of [this.pendingReconciliationTurn, this.queuedReconciliationTurn]) {
        if (job?.throughTurnId) this.scheduledReconciliationTurnIds.add(job.throughTurnId);
      }
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
    if (this.pendingReconciliationTurn) this.queueReconciliationDrain();
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

  registerStoppedClientTurn(event) {
    const itemId = String(event?.item_id || '');
    if (!itemId) {
      // `item_id` is required by the provider schema. If it is absent, do not
      // guess which response owns the audio: numeric containment becomes
      // unavailable, and transcript-dependent tools will fail closed.
      this.clientNumericEvidenceIncomplete = true;
      return null;
    }
    let turn = this.clientTurnsByItemId.get(itemId);
    if (!turn) {
      turn = {
        itemId,
        ordinal: ++this.clientTurnOrdinal,
        status: 'pending',
        transcript: '',
        stoppedAt: Date.now()
      };
      this.clientTurnsByItemId.set(itemId, turn);
      this.unboundAutoResponseTurnIds.push(itemId);
      this.pruneLiveTurnLedger();
    }
    return turn;
  }

  bindResponseContext(responseId) {
    if (!responseId) return null;
    const causeItemId = this.unboundAutoResponseTurnIds.shift() || null;
    const pendingSourceItemIds = new Set(
      [...this.clientTurnsByItemId.values()]
        .filter((turn) => turn.status === 'pending')
        .map((turn) => turn.itemId)
    );
    const cause = causeItemId ? this.clientTurnsByItemId.get(causeItemId) : null;
    const context = {
      responseId,
      causeItemId,
      pendingSourceItemIds,
      sourcedFigures: { values: [...this.sourcedFigures.values] },
      assistantTranscript: '',
      // The assistant turn this response is REPLYING to, captured now because
      // this response is about to produce speech of its own and overwrite the
      // running value. A save on this response that carries a figure the client
      // affirmed needs the read-back they were saying yes to — see
      // affirmedReadBackValues in live_tools.js.
      precedingAssistantTranscript: this.lastCompletedAssistantTranscript,
      assistantDone: false,
      assistantItemId: '',
      reviewScheduled: false,
      numericUnavailable: this.clientNumericEvidenceIncomplete,
      complianceTripped: false,
      done: false,
      noteAcceptedCount: 0,
      noteRejectedCount: 0,
      reconciliationTrigger: null,
      reconciliationPriority: false,
      turnFinalAt: Number(cause?.stoppedAt || this.turnFinalAt || 0),
      firstOutputRecorded: false
    };
    this.responseContextsById.set(responseId, context);
    this.currentResponseId = responseId;
    this.syncCurrentResponseAliases(context);
    this.pruneLiveTurnLedger();
    return context;
  }

  responseContextForEvent(event) {
    const responseId = String(event?.response_id || event?.response?.id || '');
    if (responseId && this.responseContextsById.has(responseId)) {
      return this.responseContextsById.get(responseId);
    }
    if (!responseId && this.currentResponseId) {
      return this.responseContextsById.get(this.currentResponseId) || null;
    }
    return null;
  }

  syncCurrentResponseAliases(context) {
    if (!context || context.responseId !== this.currentResponseId) return;
    this.currentAssistantTranscript = context.assistantTranscript;
    this.currentResponseSourcedFigures = context.sourcedFigures;
    this.currentResponseAwaitingClientTranscription = context.pendingSourceItemIds.size > 0;
    this.currentResponseNumericContainmentUnavailable = context.numericUnavailable;
    this.firstOutputRecorded = context.firstOutputRecorded;
  }

  pendingEvidenceToolCount() {
    let count = 0;
    for (const calls of this.deferredEvidenceToolsByItemId.values()) count += calls.length;
    return count;
  }

  pruneLiveTurnLedger() {
    while (this.responseContextsById.size > MAX_LIVE_TURN_LEDGER_ENTRIES) {
      const removable = [...this.responseContextsById.entries()].find(([, response]) =>
        response.done
        && response.pendingSourceItemIds.size === 0
        && (response.reviewScheduled || !response.assistantDone)
      );
      if (!removable) break;
      this.responseContextsById.delete(removable[0]);
    }

    while (this.clientTurnsByItemId.size > MAX_LIVE_TURN_LEDGER_ENTRIES) {
      const responseTurnIds = new Set(
        [...this.responseContextsById.values()].flatMap((response) => [
          response.causeItemId,
          ...response.pendingSourceItemIds
        ]).filter(Boolean)
      );
      const removable = [...this.clientTurnsByItemId.entries()].find(([itemId, turn]) =>
        turn.status !== 'pending'
        && !responseTurnIds.has(itemId)
        && !this.unboundAutoResponseTurnIds.includes(itemId)
        && !this.deferredEvidenceToolsByItemId.has(itemId)
      );
      if (!removable) break;
      this.clientTurnsByItemId.delete(removable[0]);
    }

    while (this.processedToolCallIds.size > MAX_LIVE_TURN_LEDGER_ENTRIES) {
      this.processedToolCallIds.delete(this.processedToolCallIds.values().next().value);
    }
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
      const turn = this.registerStoppedClientTurn(event);
      this.pendingClientTranscription = turn?.status === 'pending';
      this.pendingClientTranscriptionUnavailable = !turn;
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      return this.handleClientTurn(event);
    }

    if (type === 'conversation.item.input_audio_transcription.failed') {
      return this.markClientTranscriptionUnavailable(event);
    }

    if (type === 'response.created') {
      this.inResponse = true;
      const context = this.bindResponseContext(String(event.response?.id || ''));
      if (!context) return;
      this.currentResponseAwaitingClientTranscription = context.pendingSourceItemIds.size > 0;
      this.currentResponseNumericContainmentUnavailable = context.numericUnavailable;
      this.pendingClientTranscriptionUnavailable = false;
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
      const context = this.responseContextForEvent(event);
      if (context) context.done = true;
      this.inResponse = [...this.responseContextsById.values()].some((response) => !response.done);
      if (context && getConsumerConfig(this.env).plannerReconciliationMode !== 'legacy') {
        this.maybeScheduleReconciliation(context);
      }
      this.pruneLiveTurnLedger();
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
    if (!transcript || !itemId) {
      await this.markClientTranscriptionUnavailable(event);
      return;
    }

    let turn = this.clientTurnsByItemId.get(itemId);
    if (!turn) {
      // Defensive support for an out-of-order provider envelope. Do not put it
      // in the auto-response queue: a response may already have been created.
      turn = {
        itemId,
        ordinal: ++this.clientTurnOrdinal,
        status: 'pending',
        transcript: '',
        stoppedAt: 0
      };
      this.clientTurnsByItemId.set(itemId, turn);
    }
    if (turn.status === 'completed') return;
    turn.status = 'completed';
    turn.transcript = transcript;

    // EVERY FIGURE THE CLIENT STATES IS SOURCED. Without this, L2 would cancel
    // the model for repeating back a number it was just told — which is the
    // acknowledge-and-confirm shape the conversation is supposed to have.
    addSourcedFiguresFromText(this.sourcedFigures, transcript);
    for (const response of this.responseContextsById.values()) {
      if (!response.pendingSourceItemIds.has(itemId)) continue;
      sourceClientFiguresForActiveResponse(
        response.sourcedFigures,
        transcript,
        true
      );
      response.pendingSourceItemIds.delete(itemId);

      // Output deltas may already have arrived. L3 was checked immediately;
      // once every pending input transcript for this response is known, run
      // the deferred L2 pass over that response's own buffered speech.
      if (response.pendingSourceItemIds.size === 0 && !response.numericUnavailable) {
        const verdict = scanAssistantSpeech(
          response.assistantTranscript,
          response.sourcedFigures,
          { skipLeadInTripwires: true }
        );
        if (verdict.tripped) {
          await this.tripCompliance(verdict.actId, verdict.layer, response.responseId);
        }
      }
      this.syncCurrentResponseAliases(response);
    }
    this.pendingClientTranscription = [...this.clientTurnsByItemId.values()]
      .some((clientTurn) => clientTurn.status === 'pending');
    this.pendingClientTranscriptionUnavailable = false;
    if (turn.ordinal >= this.latestClientTranscriptOrdinal) {
      this.latestClientTranscriptOrdinal = turn.ordinal;
      this.latestClientTranscript = transcript;
      await this.state.storage.put('latestClientTranscript', transcript);
    }
    await this.persistSourcedFigures();

    const storedTurn = await recordRealtimeFinalTurn(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      providerItemId: itemId,
      role: 'user',
      transcript
    }).catch(() => null);
    if (storedTurn?.id) turn.storedTurnId = storedTurn.id;

    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'live.client.turn',
      payload: { itemId }
    }).catch(() => {});

    await this.meterTranscription(event);
    await this.touch();
    await this.drainDeferredEvidenceTools(itemId, transcript);
    this.scheduleReviewsForClientTurn(itemId, transcript);
    this.pruneLiveTurnLedger();

    // NOTE WHAT DOES NOT HAPPEN HERE: no brief, no `response.create`, and
    // nothing awaited. The provider is already replying.
    //
    // The fact audit below IS a planner call, and it is detached exactly like
    // the compliance review above it: `waitUntil` keeps it off the reply path,
    // so the v2 defect -- a model call BETWEEN the client finishing a sentence
    // and the model being allowed to speak -- cannot come back through it. Its
    // corrections land on a later turn, which is the whole point of an auditor.
    const reconciliationMode = getConsumerConfig(this.env).plannerReconciliationMode;
    if (reconciliationMode === 'legacy' && storedTurn?.id) {
      this.state.waitUntil(this.auditTurnFacts(transcript, itemId, storedTurn.id).catch(() => {}));
    } else {
      const settledResponse = [...this.responseContextsById.values()].find((response) => (
        response.causeItemId === itemId && response.done
      ));
      if (settledResponse) this.maybeScheduleReconciliation(settledResponse);
    }
  }

  async markClientTranscriptionUnavailable(event = {}) {
    const itemId = String(event?.item_id || '');
    const turn = itemId ? this.clientTurnsByItemId.get(itemId) : null;
    if (turn && turn.status !== 'completed') {
      turn.status = 'failed';
      turn.transcript = '';
    }
    // Without this transcript there is no safe way to distinguish a figure
    // copied from client audio from an invented one. L3 and L4 remain active.
    this.clientNumericEvidenceIncomplete = true;
    for (const response of this.responseContextsById.values()) {
      if (turn && !response.pendingSourceItemIds.has(itemId)) continue;
      response.pendingSourceItemIds.delete(itemId);
      response.numericUnavailable = true;
      this.syncCurrentResponseAliases(response);
    }
    this.pendingClientTranscription = [...this.clientTurnsByItemId.values()]
      .some((clientTurn) => clientTurn.status === 'pending');
    this.pendingClientTranscriptionUnavailable = true;
    if (itemId) {
      await this.drainDeferredEvidenceTools(itemId, '');
      this.scheduleReviewsForClientTurn(itemId, '');
    }
    this.pruneLiveTurnLedger();
  }

  scheduleReviewsForClientTurn(itemId, transcript) {
    for (const response of this.responseContextsById.values()) {
      if (response.causeItemId !== itemId) continue;
      this.scheduleResponseReview(response, transcript);
    }
  }

  scheduleResponseReview(response, transcript) {
    if (!response?.assistantDone || response.reviewScheduled) return;
    const cause = response.causeItemId
      ? this.clientTurnsByItemId.get(response.causeItemId)
      : null;
    if (cause?.status === 'pending') return;
    response.reviewScheduled = true;
    // Still behind speech and deliberately detached. Delayed ASR changes only
    // which exact client turn L4 sees, never when the model may start speaking.
    this.state.waitUntil(this.reviewTurn(response.assistantTranscript, transcript || ''));
  }

  /** L2 + L3. Synchronous regex over the speech so far. */
  async handleSpeechDelta(event) {
    const delta = typeof event.delta === 'string' ? event.delta : '';
    if (!delta) return;
    const response = this.responseContextForEvent(event);
    if (!response) return;
    response.assistantTranscript =
      `${response.assistantTranscript}${delta}`.slice(0, MAX_ASSISTANT_TRANSCRIPT);
    this.syncCurrentResponseAliases(response);

    if (!response.firstOutputRecorded && response.turnFinalAt) {
      response.firstOutputRecorded = true;
      this.syncCurrentResponseAliases(response);
      await appendRealtimeEvent(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        direction: 'server',
        eventType: 'live.response.first_output',
        payload: { latencyMs: Math.max(0, Date.now() - response.turnFinalAt) }
      }).catch(() => {});
    }

    const verdict = scanAssistantSpeech(
      response.assistantTranscript,
      response.sourcedFigures,
      {
        skipNumericContainment: response.pendingSourceItemIds.size > 0
          || response.numericUnavailable
      }
    );
    if (verdict.tripped) {
      await this.tripCompliance(verdict.actId, verdict.layer, response.responseId);
    }
  }

  /** L4. Fired, never awaited. */
  async handleSpeechDone(event) {
    const transcript = String(event.transcript || '').trim();
    if (!transcript) return;
    const response = this.responseContextForEvent(event);
    if (!response) return;
    response.assistantTranscript = transcript.slice(0, MAX_ASSISTANT_TRANSCRIPT);
    response.assistantDone = true;
    // What the NEXT response will have been replying to.
    this.lastCompletedAssistantTranscript = response.assistantTranscript;
    response.assistantItemId = String(event.item_id || `${response.responseId}_assistant`);
    this.syncCurrentResponseAliases(response);

    await recordRealtimeFinalTurn(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      providerItemId: response.assistantItemId,
      role: 'assistant',
      transcript
    }).catch(() => {});

    // Deterministic, synchronous, no model call: did that turn ask for a figure
    // the state already holds? The response has finished, so nothing is
    // cancelled — the correction lands as a state item the next turn reads.
    this.state.waitUntil(this.guardRedundantQuestion(transcript).catch(() => {}));

    // THE SUPERVISOR NEVER GATES A RESPONSE. It runs concurrently with the
    // client's next turn and its verdict changes the NEXT one. This is the
    // same Responses API the v2 planner used, in the opposite position in the
    // loop — and that position was the whole bug.
    const cause = response.causeItemId
      ? this.clientTurnsByItemId.get(response.causeItemId)
      : null;
    if (!cause || cause.status !== 'pending') {
      this.scheduleResponseReview(response, cause?.status === 'completed' ? cause.transcript : '');
    }
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

  /**
   * The deterministic duplicate-question backstop.
   *
   * Pure regex over the finished assistant turn against the fact ids the
   * projection already holds a value for. No model call, no planner, and it
   * cannot delay a reply: the response it inspects is already spoken.
   *
   * When it trips, the model is told plainly what it already knows and what to
   * ask instead, so the redundancy cannot repeat on the next turn. See
   * question_guard.js for why suppressing the first occurrence is not
   * achievable in a lane whose audio the Worker never touches.
   */
  async guardRedundantQuestion(assistantTranscript) {
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
    const verdict = redundantQuestionVerdict(assistantTranscript, {
      capturedFactIds: projection.capturedFactIds,
      stillNeededFactIds: projection.missing
    });
    if (!verdict.tripped) return;
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta?.sessionId,
      leaseId: this.meta?.leaseId,
      direction: 'server',
      eventType: 'live.question.redundant',
      payload: { reason: verdict.reason, requested: verdict.requested.slice(0, 4) }
    }).catch(() => {});
    if (getConsumerConfig(this.env).plannerReconciliationMode !== 'legacy') {
      const response = [...this.responseContextsById.values()].reverse().find((item) => item.done);
      if (response) this.maybeScheduleReconciliation(response, 'redundant_question');
    }
    await this.injectVolatileState().catch(() => {});
  }

  /* ------------------------------------------ transcript/note reconciliation */

  maybeScheduleReconciliation(response, forcedTrigger = null) {
    if (!response?.done || !response.causeItemId) return;
    const turn = this.clientTurnsByItemId.get(response.causeItemId);
    if (!turn || turn.status !== 'completed' || !turn.storedTurnId) return;
    const hasRejectedNote = Number(response.noteRejectedCount || 0) > 0;
    const hasNoteActivity = Number(response.noteAcceptedCount || 0) > 0 || hasRejectedNote;
    const periodic = Number(turn.ordinal || 0) % 3 === 0;
    const requestedTrigger = forcedTrigger || response.reconciliationTrigger;
    if (!requestedTrigger && !hasNoteActivity && !periodic) return;
    const trigger = requestedTrigger
      || (hasRejectedNote ? 'rejected_note' : hasNoteActivity ? 'material_turn' : 'periodic_checkpoint');
    this.queueReconciliation({
      providerItemId: turn.itemId,
      throughTurnId: turn.storedTurnId,
      ordinal: turn.ordinal,
      trigger
    }, { priority: response.reconciliationPriority === true });
    response.reconciliationTrigger = null;
    response.reconciliationPriority = false;
  }

  reconciliationJobsMatch(left, right) {
    return Boolean(left?.throughTurnId)
      && left.throughTurnId === right?.throughTurnId
      && Number(left.retryAttempt || 0) === Number(right?.retryAttempt || 0);
  }

  normalizedReconciliationJob(job) {
    return {
      providerItemId: String(job?.providerItemId || ''),
      throughTurnId: String(job?.throughTurnId || ''),
      ordinal: Number(job?.ordinal || 0),
      trigger: String(job?.trigger || 'material_turn'),
      retryAttempt: Math.max(0, Math.min(
        MAX_RECONCILIATION_RECOVERY_ATTEMPTS,
        Number(job?.retryAttempt || 0)
      )),
      notBeforeAt: Math.max(0, Number(job?.notBeforeAt || 0))
    };
  }

  reconciliationQueueSnapshot() {
    if (!this.pendingReconciliationTurn && !this.queuedReconciliationTurn) return null;
    return {
      schemaVersion: 1,
      current: this.pendingReconciliationTurn,
      queued: this.queuedReconciliationTurn
    };
  }

  /** Persist every queue transition in order and attach it to the DO event. */
  persistReconciliationQueue() {
    const snapshot = this.reconciliationQueueSnapshot();
    const persistence = this.reconciliationPersistenceChain
      .catch(() => {})
      .then(() => (
        snapshot
          ? this.state.storage.put('pendingReconciliationTurn', snapshot)
          : this.state.storage.delete('pendingReconciliationTurn')
      ));
    this.reconciliationPersistenceChain = persistence;
    this.state.waitUntil(persistence.catch(() => {}));
    return persistence;
  }

  queueReconciliation(job, { priority = false } = {}) {
    if (!job?.throughTurnId) return;
    const alreadyScheduled = this.scheduledReconciliationTurnIds.has(job.throughTurnId);
    const alreadyQueued = [
      this.activeReconciliationTurn,
      this.pendingReconciliationTurn,
      this.queuedReconciliationTurn
    ].some((candidate) => candidate?.throughTurnId === job.throughTurnId);
    if (alreadyQueued) {
      this.queueReconciliationDrain();
      return;
    }
    if (alreadyScheduled && !priority) return;

    const normalized = this.normalizedReconciliationJob({
      ...job,
      // A priority checkpoint after a prior terminal failure gets one fresh
      // idempotency identity. Ordinary first attempts remain retry zero.
      retryAttempt: alreadyScheduled ? MAX_RECONCILIATION_RECOVERY_ATTEMPTS : 0
    });
    this.scheduledReconciliationTurnIds.add(normalized.throughTurnId);
    while (this.scheduledReconciliationTurnIds.size > MAX_LIVE_TURN_LEDGER_ENTRIES) {
      this.scheduledReconciliationTurnIds.delete(this.scheduledReconciliationTurnIds.values().next().value);
    }

    const currentMustRemainDurable = Boolean(this.activeReconciliationTurn)
      || Number(this.pendingReconciliationTurn?.notBeforeAt || 0) > 0
      || Number(this.pendingReconciliationTurn?.retryAttempt || 0) > 0;
    if (this.pendingReconciliationTurn && currentMustRemainDurable) {
      if (!this.queuedReconciliationTurn
        || priority
        || normalized.ordinal >= Number(this.queuedReconciliationTurn.ordinal || 0)) {
        this.queuedReconciliationTurn = normalized;
      }
    } else if (!this.pendingReconciliationTurn
      || priority
      || normalized.ordinal >= Number(this.pendingReconciliationTurn.ordinal || 0)) {
      this.pendingReconciliationTurn = normalized;
    }
    this.persistReconciliationQueue();
    this.queueReconciliationDrain();
  }

  queueReconciliationDrain() {
    if (this.reconciliationDrainScheduled || !this.pendingReconciliationTurn) return;
    if (Number(this.pendingReconciliationTurn.notBeforeAt || 0) > Date.now()) {
      const scheduled = this.scheduleAlarm().catch(() => {});
      this.state.waitUntil(scheduled);
      return;
    }
    this.reconciliationDrainScheduled = true;
    this.reconciliationChain = this.reconciliationChain
      .catch(() => {})
      .then(() => this.drainReconciliationQueue())
      .catch(async () => {
        // An unexpected scheduler/storage failure must not become a hot loop.
        // Retain the durable job and let the alarm make a bounded later pass.
        if (this.pendingReconciliationTurn) {
          this.pendingReconciliationTurn = {
            ...this.pendingReconciliationTurn,
            notBeforeAt: Date.now() + RECONCILIATION_RETRY_BUFFER_MS
          };
          await this.persistReconciliationQueue().catch(() => {});
        }
      })
      .finally(async () => {
        this.activeReconciliationTurn = null;
        this.reconciliationDrainScheduled = false;
        if (this.pendingReconciliationTurn
          && Number(this.pendingReconciliationTurn.notBeforeAt || 0) <= Date.now()) {
          this.queueReconciliationDrain();
        } else if (this.pendingReconciliationTurn) {
          await this.scheduleAlarm().catch(() => {});
        }
      });
    this.state.waitUntil(this.reconciliationChain.catch(() => {}));
  }

  async loadPlannerReconciliationContext(config) {
    return loadLiveContext({
      env: this.env,
      config,
      sessionId: this.meta.sessionId
    });
  }

  async executePlannerReconciliation(config, context, job) {
    return runPlannerReconciliation({
      env: this.env,
      config,
      context,
      leaseId: this.meta.leaseId,
      throughTurnId: job.throughTurnId,
      trigger: job.trigger,
      retryAttempt: job.retryAttempt
    });
  }

  async recoverPendingPlannerReconciliation(result, staleBefore) {
    return recoverStalePlannerReconciliation(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      reconciliationId: result.reconciliationId,
      staleBefore
    });
  }

  async recordPlannerReconciliationEvent(payload) {
    return appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'live.facts.reconciled',
      payload
    });
  }

  async replaceCurrentReconciliationJob(job, replacement) {
    if (!this.reconciliationJobsMatch(this.pendingReconciliationTurn, job)) return false;
    this.pendingReconciliationTurn = this.normalizedReconciliationJob(replacement);
    this.activeReconciliationTurn = null;
    await this.persistReconciliationQueue();
    return true;
  }

  async finishCurrentReconciliationJob(job) {
    if (!this.reconciliationJobsMatch(this.pendingReconciliationTurn, job)) return;
    this.pendingReconciliationTurn = this.queuedReconciliationTurn;
    this.queuedReconciliationTurn = null;
    this.activeReconciliationTurn = null;
    await this.persistReconciliationQueue();
  }

  async drainReconciliationQueue() {
    while (this.pendingReconciliationTurn
      && Number(this.pendingReconciliationTurn.notBeforeAt || 0) <= Date.now()) {
      const job = this.pendingReconciliationTurn;
      this.activeReconciliationTurn = job;
      // Mark the exact current job active before awaiting its latest queued
      // write. New triggers now coalesce behind it instead of replacing it,
      // and the model cannot start until that durable write has settled.
      await this.reconciliationPersistenceChain;
      const startedAt = Date.now();
      const config = getConsumerConfig(this.env);
      let result = null;
      let errorCode = '';
      let disposition = 'terminal';
      try {
        if (config.plannerReconciliationMode === 'legacy') {
          result = { status: 'legacy' };
        } else {
          const context = await this.loadPlannerReconciliationContext(config);
          result = await this.executePlannerReconciliation(config, context, job);
        }
      } catch (error) {
        errorCode = String(error?.code || 'planner_reconciliation_failed');
      }

      if (result?.status === 'pending') {
        const staleAfterMs = Math.max(
          MIN_RECONCILIATION_STALE_MS,
          Number(config.plannerReconciliationTimeoutMs || 0) * 2 + RECONCILIATION_RETRY_BUFFER_MS
        );
        try {
          if (!result.reconciliationId) throw new Error('planner_reconciliation_pending_identity_missing');
          const recovery = await this.recoverPendingPlannerReconciliation(
            result,
            new Date(Date.now() - staleAfterMs).toISOString()
          );
          if (recovery.recovered === true) {
            errorCode = recovery.errorCode || 'planner_reconciliation_stale_pending';
            disposition = Number(job.retryAttempt || 0) < MAX_RECONCILIATION_RECOVERY_ATTEMPTS
              ? 'retry'
              : 'terminal';
          } else if (recovery.status === 'pending') {
            const createdAt = Date.parse(String(recovery.createdAt || result.createdAt || ''));
            const notBeforeAt = Number.isFinite(createdAt)
              ? Math.max(Date.now() + 1_000, createdAt + staleAfterMs)
              : Date.now() + staleAfterMs;
            await this.replaceCurrentReconciliationJob(job, { ...job, notBeforeAt });
            disposition = 'wait';
          } else if (recovery.status === 'conflicted') {
            errorCode = recovery.errorCode || 'planner_reconciliation_stale';
            disposition = Number(job.retryAttempt || 0) < MAX_RECONCILIATION_RECOVERY_ATTEMPTS
              ? 'retry'
              : 'terminal';
          } else {
            // A completion raced the stale check. Its durable terminal row is
            // authoritative, so this queue item is finished without a rerun.
            result = { ...result, status: recovery.status || 'failed' };
          }
        } catch (error) {
          // Repository inspection can fail transiently. Retain the job and
          // retry the status check later; do not issue another model call now.
          errorCode = String(error?.code || error?.message || 'planner_reconciliation_recovery_failed');
          await this.replaceCurrentReconciliationJob(job, {
            ...job,
            notBeforeAt: Date.now() + RECONCILIATION_RETRY_BUFFER_MS
          });
          disposition = 'wait';
        }
      }

      const resultConflict = result?.status === 'conflicted'
        || result?.errorCode === 'planner_reconciliation_stale';
      const errorConflict = [
        'planner_reconciliation_conflict',
        'planner_reconciliation_stale',
        'profile_revision_conflict'
      ].includes(errorCode);
      if (disposition === 'terminal'
        && (resultConflict || errorConflict)
        && Number(job.retryAttempt || 0) < MAX_RECONCILIATION_RECOVERY_ATTEMPTS) {
        disposition = 'retry';
      }

      await this.recordPlannerReconciliationEvent({
        mode: config.plannerReconciliationMode,
        status: String(result?.status || (errorCode ? 'failed' : 'unknown')),
        acceptedGroupCount: Number(result?.validation?.acceptedGroupIds?.length || 0),
        rejectedGroupCount: Number(result?.validation?.rejectedGroups?.length || 0),
        retryAttempt: Number(job.retryAttempt || 0),
        errorCode,
        latencyMs: Date.now() - startedAt
      }).catch(() => {});

      // The planner's half of the division of labour: it reads the finished
      // transcript against what each analysis still needs and hands back the
      // gaps it could not close itself. Refreshed whenever it corrected the
      // record OR asked for something -- an applied-only refresh meant a
      // clarification the planner raised never reached the speaking model.
      const reconciled = await this.absorbPlannerRequests(result).catch(() => false);
      if (result?.status === 'applied' || reconciled) {
        await this.injectVolatileState().catch(() => {});
      }
      if (disposition === 'wait') break;
      if (disposition === 'retry') {
        const replaced = await this.replaceCurrentReconciliationJob(job, {
          ...job,
          retryAttempt: Number(job.retryAttempt || 0) + 1,
          notBeforeAt: 0
        });
        if (replaced) continue;
      }
      await this.finishCurrentReconciliationJob(job);
    }
  }

  /* ----------------------------------------------------- asynchronous audit */

  /**
   * THE PLANNER IS AN AUDITOR HERE, NOT A GATE.
   *
   * The model already saved what it heard, in the same response it spoke, and
   * that write is authoritative the moment it lands. This pass runs AFTER the
   * turn, detached through waitUntil, and exists only to catch what the fast
   * path missed — a figure buried in a long answer, a value that belongs to the
   * partner's pension rather than the client's, a contradiction.
   *
   * It writes through applyPlannerCandidates, the same function the v2 lane and
   * the agent transport use, so there is exactly one fact memory. Every write in
   * that path is guarded by `current_profile_revision`, which is what makes a
   * late audit safe: if the client has corrected something in the meantime, this
   * batch fails the revision predicate instead of overwriting them.
   *
   * NOTHING ON THE REPLY PATH AWAITS THIS. If it is slow, or fails, or the
   * provider has already moved on, the meeting is unaffected — the next turn
   * simply reads whatever did land.
   */
  async auditTurnFacts(clientTranscript, providerItemId, storedTurnId) {
    const transcript = String(clientTranscript || '').trim();
    if (!transcript || !storedTurnId || !this.meta?.sessionId) return;
    const config = getConsumerConfig(this.env);
    const startedAt = Date.now();
    const loadContext = () => loadLiveContext({
      env: this.env,
      config,
      sessionId: this.meta.sessionId
    });
    let applied = 0;
    let errorCode = '';
    let attempt = null;
    try {
      const context = await loadContext();
      const extraction = await extractRealtimePlannerTurn({
        env: this.env,
        config: context.config,
        context,
        sourceTurnId: providerItemId,
        transcript,
        recentTurns: []
      });
      attempt = await beginRealtimeToolAttempt(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        providerToolCallId: `planner_${storedTurnId}`.slice(0, 160),
        toolName: 'silent_planner',
        toolVersion: `${context.config.realtimePlannerPromptVersion}:live-audit-1`,
        expectedProfileRevision: Number(context.sessionRow.current_profile_revision),
        sourceTurnId: storedTurnId,
        arguments: {
          schemaVersion: extraction.schemaVersion,
          sourceTurnId: providerItemId
        },
        maxToolCalls: context.config.realtimeMaxToolCalls
      });
      if (attempt.replayed) {
        applied = Number(attempt.result?.appliedCount || 0);
      } else {
        const outcome = await applyPlannerCandidates({
          env: this.env,
          config: context.config,
          context,
          extraction,
          evidenceRef: providerItemId,
          leaseId: this.meta.leaseId,
          toolAttemptId: attempt.row.id,
          loadContext
        });
        applied = outcome.outcomes.filter((item) => item.accepted).length;
        await completeRealtimeToolAttempt(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          toolAttemptId: attempt.row.id,
          status: 'succeeded',
          result: { ok: true, appliedCount: applied },
          errorCode: null,
          latencyMs: Date.now() - startedAt
        });
      }
    } catch (error) {
      errorCode = String(error?.code || 'live_fact_audit_failed');
      if (attempt && !attempt.replayed) {
        await completeRealtimeToolAttempt(this.env, {
          sessionId: this.meta.sessionId,
          leaseId: this.meta.leaseId,
          toolAttemptId: attempt.row.id,
          status: 'failed',
          result: { ok: false, errorCode },
          errorCode,
          latencyMs: Date.now() - startedAt
        }).catch(() => {});
      }
    }
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta?.sessionId,
      leaseId: this.meta?.leaseId,
      direction: 'server',
      eventType: 'live.facts.audited',
      payload: { applied, errorCode, latencyMs: Date.now() - startedAt }
    }).catch(() => {});
    // A correction the client can see on their next turn. Only when the audit
    // actually changed something -- an audit that found nothing must not cost a
    // per-turn item.
    if (applied > 0) await this.injectVolatileState().catch(() => {});
  }

  /* ------------------------------------------------------------ compliance */

  /**
   * A deterministic detector fired mid-sentence. Cancel the response before the
   * substantive claim lands, then instruct a correction and let the model speak
   * it. This is the ONE place the server creates a response, and it is a
   * correction rather than the normal conversational flow.
   */
  async tripCompliance(actId, layer, responseId = null) {
    const targetResponseId = String(responseId || '');
    const targetResponse = targetResponseId
      ? this.responseContextsById.get(targetResponseId)
      : null;
    // Audio transcript events are cumulative and already-queued deltas may
    // arrive after cancellation. One unsafe response is one violation, even
    // if the same detector sees that response again.
    if (targetResponse?.complianceTripped) return;
    if (targetResponse) targetResponse.complianceTripped = true;
    const targetIsActive = targetResponse?.done === false;
    const targetIsCurrent = targetIsActive && targetResponseId === this.currentResponseId;
    this.violationCount += 1;
    await this.state.storage.put('violationCount', this.violationCount);
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'live.compliance.tripped',
      payload: {
        actId,
        layer,
        responseId: targetResponseId || null,
        violationCount: this.violationCount
      }
    }).catch(() => {});

    // Delayed ASR can discover an L2 violation after a newer response has
    // started. Cancel only the response that produced the offending speech;
    // never let a late verdict issue a bare cancel against the current turn.
    if (targetIsActive) {
      try {
        this.sendProvider({ type: 'response.cancel', response_id: targetResponseId });
      } catch (_error) { /* terminal path owns loss */ }
    }

    if (this.violationCount >= MAX_COMPLIANCE_VIOLATIONS) {
      await this.terminalize('failed', 'compliance_limit', 'live_compliance_limit', true).catch(() => {});
      return;
    }
    await this.correctNextTurn(actId, { speakNow: targetIsCurrent }).catch(() => {});
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
    if (!callId
      || this.processedToolCallIds.has(callId)
      || this.deferredEvidenceToolCallIds.has(callId)) return;

    // Both mutating tools derive authority from what the client just said.
    // Their result may wait for ASR because this path is behind already-started
    // speech; the provider event chain itself must return immediately so that
    // the future transcription event can be processed.
    if (name === 'save_facts' || name === 'confirm_and_run') {
      const responseId = String(event.response_id || '');
      const response = responseId ? this.responseContextsById.get(responseId) : null;
      const turn = response?.causeItemId
        ? this.clientTurnsByItemId.get(response.causeItemId)
        : null;
      if (turn?.status === 'pending') {
        if (this.pendingEvidenceToolCount() < MAX_DEFERRED_EVIDENCE_TOOL_CALLS) {
          const pending = this.deferredEvidenceToolsByItemId.get(turn.itemId) || [];
          pending.push(event);
          this.deferredEvidenceToolsByItemId.set(turn.itemId, pending);
          this.deferredEvidenceToolCallIds.add(callId);
          return;
        }
        // The bounded queue is full. Empty evidence preserves ordinary
        // conversation while categorical-none and run confirmation fail closed.
        return this.runToolCallWithTranscript(event, '');
      }
      return this.runToolCallWithTranscript(
        event,
        turn?.status === 'completed' ? turn.transcript : ''
      );
    }

    return this.runToolCallWithTranscript(event, '');
  }

  async drainDeferredEvidenceTools(itemId, transcript) {
    const pending = this.deferredEvidenceToolsByItemId.get(itemId) || [];
    this.deferredEvidenceToolsByItemId.delete(itemId);
    for (const event of pending) {
      this.deferredEvidenceToolCallIds.delete(String(event.call_id || ''));
      await this.runToolCallWithTranscript(event, transcript);
    }
  }

  async runToolCallWithTranscript(event, clientTranscript) {
    const callId = String(event.call_id || '');
    if (!callId || this.processedToolCallIds.has(callId)) return;
    this.processedToolCallIds.add(callId);
    this.deferredEvidenceToolCallIds.delete(callId);
    this.pruneLiveTurnLedger();
    return this.executeToolCallWithTranscript(event, clientTranscript);
  }

  async executeToolCallWithTranscript(event, clientTranscript) {
    const name = String(event.name || '');
    const callId = String(event.call_id || '');
    const startedAt = Date.now();
    this.activeToolCalls += 1;

    let args = {};
    try {
      args = event.arguments ? JSON.parse(event.arguments) : {};
    } catch (_error) {
      args = {};
    }

    let result;
    let attempt = null;
    try {
      const config = getConsumerConfig(this.env);
      const responseContext = this.responseContextsById.get(String(event.response_id || '')) || null;
      const causalTurn = responseContext?.causeItemId
        ? this.clientTurnsByItemId.get(responseContext.causeItemId)
        : null;
      const context = await loadLiveContext({
        env: this.env,
        config,
        sessionId: this.meta.sessionId
      });
      attempt = await beginRealtimeToolAttempt(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        providerToolCallId: callId,
        toolName: name || 'invalid',
        toolVersion: LIVE_TOOLSET_VERSION,
        expectedProfileRevision: Number(context.sessionRow.current_profile_revision),
        sourceTurnId: causalTurn?.storedTurnId || null,
        arguments: args,
        maxToolCalls: config.realtimeMaxToolCalls
      });
      if (attempt.replayed) {
        result = attempt.result;
      } else {
        const affirmedConfirmation = name === 'confirm_and_run'
          && classifySpokenPlanConfirmation(clientTranscript) === 'affirmed';
        if (affirmedConfirmation && config.plannerReconciliationMode !== 'legacy') {
          const lease = await getRealtimeLease(
            this.env,
            this.meta.sessionId,
            this.meta.leaseId
          ).catch(() => null);
          const preflight = plannerReconciliationPreflight(
            config.plannerReconciliationMode,
            causalTurn?.storedTurnId || '',
            lease
          );
          if (!preflight.ready) {
            if (causalTurn?.storedTurnId && responseContext) {
              // The response.done handler launches this after the confirming
              // tool response has settled. The marker itself is synchronous,
              // so no reconciler/model call enters the tool response path.
              responseContext.reconciliationTrigger = 'pre_confirmation';
              responseContext.reconciliationPriority = true;
            }
            result = {
              ok: false,
              code: 'reconciliation_pending',
              retryable: true,
              message: 'I am completing one final notes check before running the analyses. Please wait for that check and then ask for confirmation again.'
            };
          }
        }
        if (!result) {
          result = await executeLiveTool(name, args, {
            env: this.env,
            config,
            leaseId: this.meta.leaseId,
            toolAttemptId: attempt.row.id,
            // The proposal audit row keeps the provider item identity. Exact
            // quote offsets remain a T2 responsibility against the stored turn.
            evidenceRef: causalTurn?.status === 'completed' ? causalTurn.itemId : null,
            // Keep the existing dependency name for the tool contract, but pass
            // only the transcript bound to this response's causal user item.
            latestClientTranscript: clientTranscript,
            // Evidence for a figure the client affirmed rather than restated. Both
            // are required together and neither is model-controlled: the sourced set
            // holds only what the CLIENT has said, and the read-back is the turn
            // they were answering.
            clientSourcedFigures: this.sourcedFigures,
            assistantReadBack: responseContext?.precedingAssistantTranscript || '',
            loadContext: () => loadLiveContext({
              env: this.env,
              config: getConsumerConfig(this.env),
              sessionId: this.meta.sessionId
            })
          });
        }
        if (name === 'save_facts' && result?.context && responseContext) {
          try {
            const derivedTrigger = reconciliationTriggerForProjection(
              liveStateProjection(context),
              liveStateProjection(result.context),
              result.saved
            );
            if (derivedTrigger && (
              !responseContext.reconciliationTrigger
              || derivedTrigger === 'readiness_transition'
            )) {
              responseContext.reconciliationTrigger = derivedTrigger;
            }
          } catch (_error) {
            // Trigger inference is observability/scheduling only. A projection
            // failure cannot turn an already-committed fact write into a tool
            // failure or enter the voice response path.
          }
        }
      }
    } catch (error) {
      // A BROKEN TOOL CALL IS NEVER A BROKEN CONVERSATION. The model gets an
      // ordinary result telling it to carry on, not an error that stalls it.
      result = {
        ok: false,
        code: error instanceof ConsumerError ? error.code : 'live_tool_failed',
        message: 'That did not save. Do not mention it and do not ask again — keep going.'
      };
    }
    if (attempt && !attempt.replayed) {
      const { context: _context, ...persistedResult } = result || {};
      await completeRealtimeToolAttempt(this.env, {
        sessionId: this.meta.sessionId,
        leaseId: this.meta.leaseId,
        toolAttemptId: attempt.row.id,
        status: result?.ok === true ? 'succeeded' : 'rejected',
        result: persistedResult,
        errorCode: result?.ok === true ? null : String(result?.code || 'live_tool_rejected'),
        latencyMs: Date.now() - startedAt
      }).catch(() => {});
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

    const responseContext = this.responseContextsById.get(String(event.response_id || '')) || null;
    if (name === 'save_facts' && responseContext) {
      responseContext.noteAcceptedCount += Array.isArray(result?.saved) ? result.saved.length : 0;
      responseContext.noteRejectedCount += Array.isArray(result?.rejected) ? result.rejected.length : 0;
      if (responseContext.done && getConsumerConfig(this.env).plannerReconciliationMode !== 'legacy') {
        this.maybeScheduleReconciliation(responseContext);
      }
    }
    if (name === 'confirm_and_run'
      && responseContext?.done
      && responseContext.reconciliationTrigger === 'pre_confirmation') {
      this.maybeScheduleReconciliation(responseContext);
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

  /**
   * Take the clarifications the reconciler could not resolve from the
   * transcript and hold them for the speaking model.
   *
   * A request is retired once the fact instance it names is no longer
   * outstanding, so answering the client's way — in a later turn, in passing,
   * without being asked again — clears it. Only the deterministic needs decide
   * that; the planner never marks its own request satisfied.
   */
  async absorbPlannerRequests(result) {
    const raw = Array.isArray(result?.validation?.clarificationNeeds)
      ? result.validation.clarificationNeeds
      : [];
    const incoming = raw
      .filter((need) => need?.factInstanceId && need?.prompt)
      .map((need) => ({
        factInstanceId: String(need.factInstanceId),
        factId: String(need.factId || ''),
        ownerId: need.ownerId ? String(need.ownerId) : null,
        prompt: String(need.prompt)
      }));
    const byInstance = new Map(this.plannerRequests.map((item) => [item.factInstanceId, item]));
    for (const need of incoming) byInstance.set(need.factInstanceId, need);
    if (byInstance.size === 0) return false;

    let outstanding = new Set();
    try {
      const projection = liveStateProjection(await loadLiveContext({
        env: this.env,
        config: getConsumerConfig(this.env),
        sessionId: this.meta.sessionId
      }));
      outstanding = new Set((projection.analyses || [])
        .flatMap((analysis) => analysis.stillNeeded || [])
        .map((need) => need.instanceId));
    } catch (_error) {
      // Without a readable projection nothing can be retired safely, so the
      // existing requests simply stand until the next pass.
      outstanding = new Set(byInstance.keys());
    }
    const next = [...byInstance.values()]
      .filter((request) => outstanding.has(request.factInstanceId))
      .slice(-MAX_LIVE_PLANNER_REQUESTS);
    const changed = JSON.stringify(next) !== JSON.stringify(this.plannerRequests);
    this.plannerRequests = next;
    if (changed) await this.state.storage.put('plannerRequests', next).catch(() => {});
    return incoming.length > 0 || changed;
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
              // PASSED WHOLE, NOT FLATTENED TO DESCRIPTIONS. Mapping these to
              // their descriptions used to discard `status`, `stillNeeded` and
              // the `why` behind each need, so the pushed state could only say
              // what was missing globally -- never which analysis wanted it.
              // The model was left to infer the justification for its own
              // questions, which is what turns a focused meeting into generic
              // fact finding. The structure was already being built here; it
              // just never survived this call.
              analyses: projection.analyses,
              missing: projection.missing,
              unknown: projection.unknown,
              // Requirements the client has said they cannot answer. Dropped
              // from the ask list but still holding the plan, so the note has
              // to carry them or the model sees a shorter list and no reason.
              blocked: projection.blocked,
              // The background planner's outstanding asks.
              plannerRequests: this.plannerRequests,
              goalsAgreed: projection.goalsAgreed,
              readyToConfirm: projection.readyToConfirm
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
    const reconciliationDeadline = this.pendingReconciliationTurn
      && !this.reconciliationDrainScheduled
      ? Math.max(Date.now() + 1, Number(this.pendingReconciliationTurn.notBeforeAt || Date.now()))
      : Number.POSITIVE_INFINITY;
    const deadline = Math.min(
      Date.parse(this.meta.hardExpiresAt),
      Date.parse(this.meta.idleExpiresAt),
      Date.now() + SIDE_BAND_HEARTBEAT_MS,
      reconciliationDeadline
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
    if (this.pendingReconciliationTurn
      && Number(this.pendingReconciliationTurn.notBeforeAt || 0) <= Date.now()) {
      this.queueReconciliationDrain();
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
    const noUnmeteredWork = speechUsageSettled
      && !this.inResponse
      && this.activeToolCalls === 0
      && this.pendingEvidenceToolCount() === 0;
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
