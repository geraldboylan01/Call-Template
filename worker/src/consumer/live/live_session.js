/**
 * ConsumerLiveSession — the live conversational lane's Durable Object.
 * This is the only active call session. Every v1/v2 or "controlled" reference
 * below describes archived history; it is never an alternative or fallback.
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
  getLatestRealtimeMeetingBrief,
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
import { runDirectModulePlanning } from '../direct_module_planner.js';
import { valueEvidenceCoverage } from '../../../../js/planning/value_evidence.js';
import { classifySpokenPlanConfirmation } from '../realtime_completion.js';
import {
  classifyRealtimeProviderError,
  realtimeTranscriptionUsageFromEvent,
  realtimeUsageFromResponse
} from '../realtime_session.js';
import { emitSessionSummary } from '../learning_signals.js';
import { LIVE_PROMPT_VERSION, liveDirectModuleStateItem, liveVolatileStateItem } from './catalogue_prompt.js';
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
// A response ends when it emits a function call. The Worker must explicitly
// ask the provider to continue after returning the tool output, but a faulty
// model must not be able to turn that protocol continuation into an unbounded
// tool loop. The third tool result therefore gets one final, tools-disabled
// response in which to speak.
const MAX_TOOL_CALLS_PER_ROOT_TURN = 3;

/** A finalized typed message echoed by the provider's sideband. */
export function typedClientTurnFromEvent(event) {
  const item = event?.item;
  if (String(event?.type || '') !== 'conversation.item.created'
    || String(item?.type || '') !== 'message'
    || String(item?.role || '') !== 'user') return null;
  const content = Array.isArray(item.content) ? item.content : [];
  const transcript = content
    .filter((part) => ['input_text', 'text'].includes(String(part?.type || '')))
    .map((part) => String(part?.text || ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4_000);
  const itemId = String(item.id || '').slice(0, 200);
  return transcript && itemId ? { itemId, transcript } : null;
}

/**
 * How many bounded reviews one uncovered occurrence may have before the
 * meeting stops asking about it.
 *
 * Two: one ordinary review, and one more in case the first pass was refused
 * for a reason a second look can fix (a stale base, a malformed operation).
 * A third would be a retry loop with extra steps, and every attempt is a paid
 * model call the client is not waiting on but is paying for.
 */
const MAX_VALUE_EVIDENCE_REVIEW_ATTEMPTS = 2;
/**
 * How many passes an outstanding review gets before the note is retracted.
 *
 * Higher than the evidence budget on purpose. An uncovered figure has one
 * chance to be placed and then stops being asked about; a provisional note is
 * a value already written into someone's profile, so it is worth more attempts
 * before deciding nobody can confirm it.
 */
const MAX_NOTE_REVIEW_ATTEMPTS = 3;
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

// This is equality, not language interpretation. The semantic planner writes
// the statement and the independent verifier approves it; the live lane merely
// proves the client heard that exact certified statement before accepting yes.
function confirmationReadbackKey(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/**
 * Confirmation may use only a profile that includes review of the causal
 * finalized client turn. Legacy mode deliberately preserves the previous
 * behavior; shadow/apply fail closed until that exact turn owns the durable
 * reconciliation watermark.
 */
/**
 * MAY THE ANALYSES RUN YET?
 *
 * THE RULE: no client turn that changed planning state may still be awaiting
 * review when a deterministic module runs. Nothing more, and nothing less.
 *
 * IT USED TO ASK SOMETHING STRICTER AND IMPOSSIBLE. The test was
 * `planner_reconciled_through_turn_id === causalTurnId` — the confirming turn
 * itself had to have been reconciled. But reconciliation for a turn is
 * scheduled from `response.done`, and the `confirm_and_run` call for that turn
 * arrives on `response.function_call_arguments.done`, which always comes first.
 * The watermark was therefore always exactly one turn behind the turn being
 * confirmed, on every attempt, forever:
 *
 *     attempt 1  causal=turn_10  watermark=turn_10   (advanced by the refusal)
 *     attempt 2  causal=turn_11  watermark=turn_11
 *     attempt 3  causal=turn_12  watermark=turn_12
 *
 * `confirm_and_run` could not succeed in `shadow` or `apply` at all, so the
 * deterministic module could never run with the reconciler on. It survived
 * because this function was unit-tested as a pure predicate against hand-built
 * lease rows — correct in isolation, unreachable in sequence — and because
 * production runs `legacy`, where the first line returns before any of it.
 *
 * WHY THE STRICTER TEST WAS ALSO THE WRONG QUESTION. "Yes, go ahead" carries no
 * facts. Demanding that a pure confirmation be reconciled asks the planner to
 * review a turn with nothing in it to review. What matters is whether anything
 * MATERIAL is outstanding — and the session tracks exactly that, because the
 * same note activity that marks a turn material is what schedules its
 * reconciliation in the first place.
 *
 * FAIL-CLOSED IS PRESERVED IN BOTH DIRECTIONS. A material turn leaves the
 * outstanding set only when a reconciliation through it reaches `shadow` or
 * `applied`; a stale, conflicted or failed pass clears nothing, so it still
 * blocks. And a confirming turn that DOES carry a correction marks itself
 * material before this runs, so it blocks itself.
 *
 * @param {string} mode
 * @param {object|null} lease
 * @param {Array<{turnId: string, ordinal: number}>} unreviewedMaterialTurns
 */
export function plannerReconciliationPreflight(
  mode,
  lease,
  unreviewedMaterialTurns = [],
  unresolvedIdentities = [],
  undispositionedNotes = []
) {
  if (mode === 'legacy') return { ready: true, reason: 'legacy' };
  // AN UNREVIEWED PROPOSAL IS OUTSTANDING WORK, AND THE TURN LEDGER CANNOT SEE
  // IT. A realtime note carries no evidence spans, so it belongs to no turn —
  // and a plan that returned `clean` while dispositioning nothing still had its
  // material turn retired by ordinal. That is how a note reading EUR 2 for
  // "two and a half thousand" stayed canonical with this gate open: the
  // checkpoint had completed, and completion was all this asked about.
  const outstandingNotes = (Array.isArray(undispositionedNotes) ? undispositionedNotes : [])
    .map((entry) => String(entry?.noteId || entry || '')).filter(Boolean);
  if (outstandingNotes.length > 0) {
    return {
      ready: false,
      reason: 'review_outstanding',
      outstandingNoteIds: outstandingNotes.slice(0, MAX_LIVE_TURN_LEDGER_ENTRIES)
    };
  }
  // AN UNRESOLVED IDENTITY IS OUTSTANDING MATERIAL WORK TOO. A pension the lane
  // could not tell apart from one already recorded may be the same holding or a
  // second, and running the analyses over that guess either double-counts a pot
  // the client does not have or loses one they do. Handled by the SAME gate,
  // not a second one — the answer is the same: not yet.
  const identities = (Array.isArray(unresolvedIdentities) ? unresolvedIdentities : [])
    .map((entry) => String(entry?.factId || '')).filter(Boolean);
  if (identities.length > 0) {
    return { ready: false, reason: 'identity_unresolved', outstandingFactIds: identities };
  }
  const outstanding = (Array.isArray(unreviewedMaterialTurns) ? unreviewedMaterialTurns : [])
    .map((entry) => String(entry?.turnId || ''))
    .filter(Boolean);
  if (outstanding.length > 0) {
    return {
      ready: false,
      reason: 'reconciliation_pending',
      outstandingTurnIds: outstanding.slice(0, MAX_LIVE_TURN_LEDGER_ENTRIES)
    };
  }
  // A reconciliation still in flight has not decided anything yet. It is only
  // ever material work that is queued here, so waiting one turn for it is the
  // same fail-closed answer, reached before its outcome is known.
  if (lease?.planner_pending_through_turn_id) {
    return {
      ready: false,
      reason: 'reconciliation_pending',
      outstandingTurnIds: [String(lease.planner_pending_through_turn_id)]
    };
  }
  return { ready: true, reason: 'reviewed' };
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

/**
 * A tool call this response emitted whose output has not reached the provider.
 *
 * A deferred evidence tool sits here for as long as ASR takes, and the whole
 * conversation is waiting on it: the response owes a continuation it cannot
 * request yet, and the tool itself still needs this response to find the
 * client turn its evidence comes from. Neither survives eviction.
 */
function hasUndeliveredToolOutput(response) {
  if (!response || response.toolCallIds.size === 0) return false;
  for (const callId of response.toolCallIds) {
    if (!response.deliveredToolCallIds.has(callId)) return true;
  }
  return false;
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
    this.directModulePlanningChain = Promise.resolve();
    this.directModulePlanningPersistenceChain = Promise.resolve();
    this.directModulePlanningPending = 0;
    // Finalized client turns whose direct module snapshot has not yet been
    // successfully rebuilt. This is distinct from an in-memory request count:
    // a failed request remains an obligation, including across hibernation.
    this.directModulePlanningOutstanding = [];
    this.directModulePlanningSequence = 0;
    this.directAwaitingConfirmationSnapshotRevision = null;
    // A final analysis confirmation is valid only when the client is answering
    // the exact assistant turn that presented a verified direct-module plan.
    // The opaque token is protocol state, never financial meaning: get_state
    // issues it, the post-tool continuation presents the plan, and that spoken
    // assistant turn arms it durably for one subsequent client answer.
    this.directConfirmationOffer = null;
    this.lastInjectedDirectSnapshotRevision = 0;
    this.reconciliationPersistenceChain = Promise.resolve();
    this.reconciliationDrainScheduled = false;
    this.pendingReconciliationTurn = null;
    this.queuedReconciliationTurn = null;
    // What the background planner could not settle from the transcript, held
    // for the speaking model to raise. Durable so a hibernated meeting does not
    // quietly forget an outstanding question.
    this.plannerRequests = [];
    // Client turns that changed planning state and have not yet been reviewed.
    // Durable for the same reason `plannerRequests` is: a hibernated meeting
    // that forgot them would let the analyses run over an unreviewed
    // correction, which is the one thing the confirmation gate exists to stop.
    this.unreviewedMaterialTurns = [];
    // Positions the lane could not tell apart from one already recorded.
    // Durable for the same reason the material turns are: a hibernated meeting
    // that forgot one would run the analyses over a possible double-count.
    this.unresolvedIdentities = [];
    // How many bounded reviews each uncovered occurrence has already had, and
    // which ones are finished being asked about. Durable for the same reason
    // the material turns are: a hibernated meeting that forgot them would
    // start the review budget again and could never finish.
    this.valueEvidenceReviewAttempts = {};
    this.terminallyUnresolvedEvidence = [];
    // The same bargain for review obligations: how many passes each outstanding
    // provisional note has already had, and which have run out. Durable, because
    // a hibernated meeting that forgot them would restart every budget.
    this.noteReviewAttempts = {};
    this.undispositionedNotes = [];
    this.notesPendingEscalation = [];
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
    // Every Worker-created continuation points back to one native Realtime
    // response. The shared chain object is what preserves the causal client
    // item and the assistant proposition it answered across tool-only response
    // boundaries without consuming a later VAD turn.
    this.continuationChainsByRootResponseId = new Map();
    this.deferredEvidenceToolsByItemId = new Map();
    this.deferredEvidenceToolCallIds = new Set();
    this.processedToolCallIds = new Set();
    this.clientNumericEvidenceIncomplete = false;
    this.openingRequested = false;
    // Responses the Worker has asked for and the provider has not created yet.
    // Server-requested responses not yet created. Keyed by the client event_id
    // the provider echoes back on error, so a failure can be attributed to the
    // ONE request that caused it — a bare counter could only be decremented by
    // a creation, and retiring everything on any error was equally wrong in
    // the other direction.
    // The assistant turn a new client turn will be answering.
    this.lastCompletedAssistantTurnId = null;
    this.pendingServerResponses = new Map();
    this.serverResponseEventSeq = 0;
    this.pendingTerminalization = null;

    this.state.blockConcurrencyWhile(async () => {
      this.meta = await this.state.storage.get('lease') || null;
      this.violationCount = Number(await this.state.storage.get('violationCount') || 0);
      this.latestClientTranscript = await this.state.storage.get('latestClientTranscript') || '';
      this.pendingTerminalization = await this.state.storage.get('pendingTerminalization') || null;
      this.plannerRequests = await this.state.storage.get('plannerRequests') || [];
      this.unreviewedMaterialTurns = await this.state.storage.get('unreviewedMaterialTurns') || [];
      this.unresolvedIdentities = await this.state.storage.get('unresolvedIdentities') || [];
      this.valueEvidenceReviewAttempts = await this.state.storage.get('valueEvidenceReviewAttempts') || {};
      this.terminallyUnresolvedEvidence = await this.state.storage.get('terminallyUnresolvedEvidence') || [];
      this.noteReviewAttempts = await this.state.storage.get('noteReviewAttempts') || {};
      this.undispositionedNotes = await this.state.storage.get('undispositionedNotes') || [];
      this.notesPendingEscalation = await this.state.storage.get('notesPendingEscalation') || [];
      this.openingRequested = await this.state.storage.get('openingRequested') === true;
      const directOutstanding = await this.state.storage.get('directModulePlanningOutstanding') || [];
      this.directModulePlanningOutstanding = (Array.isArray(directOutstanding) ? directOutstanding : [])
        .filter((item) => item?.turnId && Number.isSafeInteger(Number(item?.sequence)))
        .map((item) => ({ turnId: String(item.turnId), sequence: Number(item.sequence) }));
      this.directModulePlanningSequence = this.directModulePlanningOutstanding.reduce(
        (highest, item) => Math.max(highest, item.sequence),
        0
      );
      const awaitingDirectRevision = Number(
        await this.state.storage.get('directAwaitingConfirmationSnapshotRevision')
      );
      this.directAwaitingConfirmationSnapshotRevision = Number.isSafeInteger(awaitingDirectRevision)
        && awaitingDirectRevision > 0
        ? awaitingDirectRevision
        : null;
      const storedDirectOffer = await this.state.storage.get('directConfirmationOffer') || null;
      this.directConfirmationOffer = storedDirectOffer?.token
        && storedDirectOffer?.assistantTurnId
        && Number.isSafeInteger(Number(storedDirectOffer?.snapshotRevision))
        ? {
            token: String(storedDirectOffer.token),
            assistantTurnId: String(storedDirectOffer.assistantTurnId),
            snapshotRevision: Number(storedDirectOffer.snapshotRevision),
            certificateSignature: String(storedDirectOffer.certificateSignature || '')
          }
        : null;
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
    await this.requestOpeningResponse();
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

  /** Ask for the one tools-disabled opening turn, durably and at most once. */
  async requestOpeningResponse() {
    if (this.openingRequested) return false;
    const openingEventId = this.nextServerResponseEventId('opening');
    this.openingRequested = true;
    await this.state.storage.put('openingRequested', true);
    try {
      this.sendProvider({
        type: 'response.create',
        // The provider echoes this on any error it raises for this request,
        // which is what makes a failure attributable to one request instead of
        // to "something went wrong somewhere".
        event_id: openingEventId,
        response: {
          tool_choice: 'none',
          metadata: { kind: 'opening', continuation_index: '0' }
        }
      });
    } catch (error) {
      // A synchronous socket failure did not request anything. Let a later
      // activation retry instead of durably remembering a greeting that never
      // reached the provider.
      this.openingRequested = false;
      await this.state.storage.delete?.('openingRequested');
      throw error;
    }
    this.trackServerResponseRequest(openingEventId, { key: 'opening' });
    this.state.waitUntil(appendRealtimeEvent(this.env, {
      sessionId: this.meta?.sessionId,
      leaseId: this.meta?.leaseId,
      direction: 'server',
      eventType: 'live.opening.requested',
      payload: {}
    }).catch(() => {}));
    return true;
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
        stoppedAt: Date.now(),
        // Bound WHEN THE CLIENT STARTS SPEAKING, not when their words finish
        // being transcribed. By the time ASR lands the assistant may already
        // have asked something else.
        answersTurnId: this.lastCompletedAssistantTurnId || null
      };
      this.clientTurnsByItemId.set(itemId, turn);
      this.unboundAutoResponseTurnIds.push(itemId);
      this.pruneLiveTurnLedger();
    }
    return turn;
  }

  bindResponseContext(responseId, metadata = {}) {
    if (!responseId) return null;
    // A repeated response.created for the same id is the same response, not a
    // second one. Settling that first means the request check below never has
    // to treat a duplicate as unsolicited.
    if (this.responseContextsById.has(responseId)) {
      return this.responseContextsById.get(responseId);
    }
    let responseKind = String(metadata?.kind || 'auto');
    // RESERVED METADATA IS THE WORKER'S OWN VOCABULARY. `kind` decides which
    // client turn a response answers, so a response carrying it that the
    // Worker never asked for can bind itself to any earlier turn and schedule
    // that turn's review against speech it has nothing to do with. Honour it
    // only against an outstanding request; otherwise this is an ordinary
    // provider response and is bound like one.
    let issuedRequest = null;
    if (responseKind === 'opening' || responseKind === 'tool_continuation') {
      const requestKey = responseKind === 'opening'
        ? 'opening'
        : `continuation:${String(metadata?.parent_response_id || '')}`;
      issuedRequest = this.serverResponseRequestFor(requestKey);
      if (!issuedRequest) {
        this.state.waitUntil(appendRealtimeEvent(this.env, {
          sessionId: this.meta?.sessionId,
          leaseId: this.meta?.leaseId,
          direction: 'server',
          eventType: 'live.response.unsolicited_metadata',
          payload: { responseId, kind: responseKind }
        }).catch(() => {}));
        responseKind = 'auto';
        metadata = {};
      }
    }
    const continuation = responseKind === 'tool_continuation';
    const opening = responseKind === 'opening';
    const rootResponseId = continuation
      ? String(metadata?.root_response_id || '')
      : responseId;
    const parentResponseId = continuation
      ? String(metadata?.parent_response_id || '')
      : '';
    const parent = parentResponseId
      ? this.responseContextsById.get(parentResponseId) || null
      : null;
    // THE CHAIN COMES FROM THE REQUEST WE ISSUED, NOT FROM THE RESPONSE.
    //
    // Matching an outstanding parent proves only that SOME continuation was
    // expected. The root_* fields still say which client turn this answers, so
    // a response with a correct parent and forged roots could adopt a
    // different turn entirely — and then schedule that turn's review against
    // speech it never answered. The Worker recorded the chain when it asked;
    // that record is the authority, and metadata is never a fallback for it.
    let chain = continuation
      ? issuedRequest?.chain
        || this.continuationChainsByRootResponseId.get(rootResponseId)
        || null
      : null;
    const causeItemId = continuation
      ? String(chain?.rootCauseItemId || '') || null
      : opening ? null : this.unboundAutoResponseTurnIds.shift() || null;
    const pendingSourceItemIds = continuation && parent
      ? new Set(parent.pendingSourceItemIds)
      : new Set(
        [...this.clientTurnsByItemId.values()]
          .filter((turn) => turn.status === 'pending')
          .map((turn) => turn.itemId)
      );
    const cause = causeItemId ? this.clientTurnsByItemId.get(causeItemId) : null;
    const precedingAssistantTranscript = continuation
      ? String(chain?.precedingAssistantTranscript || parent?.precedingAssistantTranscript || '')
      : opening ? '' : this.lastCompletedAssistantTranscript;
    if (!chain) {
      chain = {
        rootResponseId,
        rootCauseItemId: causeItemId,
        precedingAssistantTranscript,
        toolCallCount: 0,
        invalidated: false,
        settled: false,
        // A chain's saves happen on the hops; its review happens at the end.
        // These carry each hop's outcome forward so the turn is scheduled on
        // everything it produced rather than on whatever the last hop did.
        noteAcceptedCount: 0,
        noteRejectedCount: 0,
        acceptedValueEvidence: [],
        reconciliationTrigger: null,
        reconciliationPriority: false
      };
      this.continuationChainsByRootResponseId.set(rootResponseId, chain);
    }
    const context = {
      responseId,
      causeItemId,
      responseKind,
      rootResponseId,
      parentResponseId,
      continuationIndex: continuation
        ? Math.max(1, Number(metadata?.continuation_index || 1))
        : 0,
      continuationChain: chain,
      continuationRequested: false,
      toolCallIds: new Set(),
      deliveredToolCallIds: new Set(),
      pendingSourceItemIds,
      sourcedFigures: { values: [...this.sourcedFigures.values] },
      assistantTranscript: '',
      // The assistant turn this response is REPLYING to, captured now because
      // this response is about to produce speech of its own and overwrite the
      // running value. A save on this response that carries a figure the client
      // affirmed needs the read-back they were saying yes to — see
      // affirmedReadBackValues in live_tools.js.
      precedingAssistantTranscript,
      assistantDone: false,
      assistantItemId: '',
      reviewScheduled: false,
      numericUnavailable: this.clientNumericEvidenceIncomplete,
      complianceTripped: false,
      done: false,
      noteAcceptedCount: 0,
      noteRejectedCount: 0,
      acceptedValueEvidence: [],
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
        // A deferred tool is drained AFTER its turn's transcript clears the
        // pending pin above, so for the length of that drain this response
        // looks settled while still owing an output. Evicting there strands
        // the continuation and loses the tool's own causal turn.
        && !hasUndeliveredToolOutput(response)
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

    while (this.continuationChainsByRootResponseId.size > MAX_LIVE_TURN_LEDGER_ENTRIES) {
      const removable = [...this.continuationChainsByRootResponseId.entries()]
        .find(([, chain]) => chain.settled || chain.invalidated);
      if (!removable) break;
      this.continuationChainsByRootResponseId.delete(removable[0]);
    }
  }

  /**
   * A server-requested response is no longer outstanding.
   *
   * Called on creation AND when the provider errors on that request. Retiring
   * only on creation left a rejected request outstanding forever, so a later
   * barge-in marked it superseded and every legitimate continuation after that
   * was cancelled on arrival.
   */
  retireServerResponseRequest(requestKey) {
    for (const [eventId, record] of this.pendingServerResponses) {
      if (record.key === requestKey) this.pendingServerResponses.delete(eventId);
    }
  }

  nextServerResponseEventId(kind) {
    this.serverResponseEventSeq += 1;
    return `planeir_${kind}_${this.serverResponseEventSeq}`;
  }

  trackServerResponseRequest(eventId, record) {
    this.pendingServerResponses.set(eventId, { ...record, superseded: false });
    while (this.pendingServerResponses.size > MAX_LIVE_TURN_LEDGER_ENTRIES) {
      this.pendingServerResponses.delete(this.pendingServerResponses.keys().next().value);
    }
  }

  serverResponseRequestFor(requestKey) {
    for (const record of this.pendingServerResponses.values()) {
      if (record.key === requestKey) return record;
    }
    return null;
  }

  /**
   * A response the Worker asked for will never exist.
   *
   * Its chain is then waiting for a continuation that is not coming, and
   * `awaitsContinuationChain` would hold that turn's review shut for the rest
   * of the meeting — which also holds the confirmation barrier shut. Settle the
   * chain and review the turn on what it did manage to write.
   */
  settleFailedServerResponse(eventId) {
    const record = this.pendingServerResponses.get(eventId);
    if (!record) return false;
    this.pendingServerResponses.delete(eventId);
    const chain = record.chain;
    if (!chain || chain.settled) return true;
    chain.settled = true;
    if (getConsumerConfig(this.env).plannerReconciliationMode === 'legacy') return true;
    const stranded = [...this.responseContextsById.values()]
      .filter((response) => response.continuationChain === chain && response.done)
      .at(-1);
    if (stranded) this.maybeScheduleReconciliation(stranded);
    return true;
  }

  /**
   * Carry one hop's review outcome onto the turn it belongs to.
   *
   * Folds DELTAS, so it is safe to call repeatedly. It has to be: a tool whose
   * evidence was deferred behind ASR reports its outcome onto a response that
   *has finished, long after that response's own response.done. Folding once at
   * done would lose exactly the saves this lane defers most often.
   */
  foldResponseIntoChain(response) {
    const chain = response?.continuationChain;
    if (!chain) return;
    const folded = response.foldedReviewSignals || { accepted: 0, rejected: 0, evidence: 0 };
    const accepted = Number(response.noteAcceptedCount || 0);
    const rejected = Number(response.noteRejectedCount || 0);
    const evidence = Array.isArray(response.acceptedValueEvidence)
      ? response.acceptedValueEvidence
      : [];
    chain.noteAcceptedCount += Math.max(0, accepted - folded.accepted);
    chain.noteRejectedCount += Math.max(0, rejected - folded.rejected);
    if (evidence.length > folded.evidence) {
      chain.acceptedValueEvidence = [
        ...chain.acceptedValueEvidence,
        ...evidence.slice(folded.evidence)
      ];
    }
    response.foldedReviewSignals = {
      accepted, rejected, evidence: evidence.length
    };
    // readiness_transition outranks the rest, exactly as it does per-response.
    if (response.reconciliationTrigger
      && (!chain.reconciliationTrigger
        || response.reconciliationTrigger === 'readiness_transition')) {
      chain.reconciliationTrigger = response.reconciliationTrigger;
    }
    if (response.reconciliationPriority === true) chain.reconciliationPriority = true;
  }

  /**
   * This response is one hop of a chain that has not finished.
   *
   * A THREE-HOP CHAIN IS ONE CONVERSATIONAL TURN. Reviewing at the first
   * response.done means reviewing the client's answer against a third of the
   * evidence it produced — and because queueReconciliation deduplicates by
   * turn id, the saves from hops two and three could never earn another look.
   * A dense answer would be permanently half-reviewed.
   *
   * An invalidated chain is NOT waiting: barge-in means no continuation is
   * coming, so that turn must be reviewed now rather than never.
   */
  awaitsContinuationChain(response) {
    if (!response || response.toolCallIds.size === 0) return false;
    const chain = response.continuationChain;
    if (!chain) return false;
    // Invalidated: barge-in, no continuation is coming. Settled: the chain
    // finished, or the request that would have continued it failed outright.
    // Either way nothing further will write to this turn, so waiting longer
    // just holds its review — and the confirmation barrier — shut forever.
    return chain.invalidated !== true && chain.settled !== true;
  }

  /**
   * A new client utterance wins over anything the Worker was about to say.
   *
   * A requested response does not exist until the provider creates it, so
   * there is a window — widest for the opening, which is requested before any
   * response has ever existed — where a chain cannot carry the invalidation.
   * The counter closes it: speech during that window marks the next
   * server-requested response for cancellation on arrival.
   */
  invalidatePendingContinuations() {
    for (const chain of this.continuationChainsByRootResponseId.values()) {
      if (!chain.settled) chain.invalidated = true;
    }
    // Everything already asked for, and not yet created, is superseded by the
    // client. Marking the records leaves a later legitimate request alone.
    for (const record of this.pendingServerResponses.values()) record.superseded = true;
  }

  registerResponseToolCall(event) {
    const callId = String(event?.call_id || '');
    const response = this.responseContextForEvent(event);
    if (!callId || !response) return response;
    if (!response.toolCallIds.has(callId)) {
      response.toolCallIds.add(callId);
      response.continuationChain.toolCallCount += 1;
    }
    return response;
  }

  markResponseToolOutputDelivered(response, callId) {
    if (!response || !callId) return false;
    response.deliveredToolCallIds.add(String(callId));
    // Fold NOW, while this response still exists. A deferred save reports its
    // outcome long after its own response.done, by which point ledger pressure
    // in a long meeting may already have retired that response — and the turn
    // would then be reviewed as though the save had never happened.
    this.foldResponseIntoChain(response);
    return this.maybeRequestToolContinuation(response);
  }

  /**
   * Continue a function-call response only after BOTH protocol halves settle:
   * response.done and every function_call_output (plus refreshed state) have
   * reached the provider. Assistant audio before the call is deliberately not
   * a predicate; a function call terminates that response regardless.
   */
  maybeRequestToolContinuation(response) {
    if (!response?.done
      || response.continuationRequested
      || response.continuationChain?.invalidated
      || response.toolCallIds.size === 0
      || hasUndeliveredToolOutput(response)) return false;
    const chain = response.continuationChain;
    const continuationIndex = Number(response.continuationIndex || 0) + 1;
    const toolChoice = chain.toolCallCount >= MAX_TOOL_CALLS_PER_ROOT_TURN
      ? 'none'
      : 'auto';
    response.continuationRequested = true;
    const continuationEventId = this.nextServerResponseEventId('continuation');
    try {
      this.sendProvider({
        type: 'response.create',
        event_id: continuationEventId,
        response: {
          tool_choice: toolChoice,
          metadata: {
            kind: 'tool_continuation',
            parent_response_id: String(response.responseId),
            root_response_id: String(chain.rootResponseId),
            root_item_id: String(chain.rootCauseItemId || ''),
            continuation_index: String(continuationIndex)
          }
        }
      });
    } catch (_error) {
      response.continuationRequested = false;
      return false;
    }
    this.trackServerResponseRequest(continuationEventId, {
      key: `continuation:${response.responseId}`,
      chain
    });
    this.state.waitUntil(appendRealtimeEvent(this.env, {
      sessionId: this.meta?.sessionId,
      leaseId: this.meta?.leaseId,
      direction: 'server',
      eventType: 'live.response.continuation_requested',
      payload: {
        rootItemId: chain.rootCauseItemId || null,
        continuationIndex,
        toolChoice
      }
    }).catch(() => {}));
    return true;
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

    if (type === 'input_audio_buffer.speech_started') {
      this.invalidatePendingContinuations();
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      return this.handleClientTurn(event);
    }

    if (type === 'conversation.item.input_audio_transcription.failed') {
      return this.markClientTranscriptionUnavailable(event);
    }

    // Typing is an input method inside this live call, not a second lane. The
    // provider echoes the browser-created user item to this authenticated
    // sideband before it creates the response, so the same persistence,
    // evidence and planning path used by a finalized audio transcript applies.
    if (type === 'conversation.item.created') {
      const typedTurn = typedClientTurnFromEvent(event);
      if (!typedTurn) return;
      // A typed answer is a barge-in. The client has moved on, and a queued
      // continuation would answer a question they have already left behind.
      this.invalidatePendingContinuations();
      this.turnFinalAt = Date.now();
      this.firstOutputRecorded = false;
      const turn = this.registerStoppedClientTurn({ item_id: typedTurn.itemId });
      this.pendingClientTranscription = turn?.status === 'pending';
      this.pendingClientTranscriptionUnavailable = !turn;
      return this.handleClientTurn({
        item_id: typedTurn.itemId,
        transcript: typedTurn.transcript,
        typed: true
      });
    }

    if (type === 'response.created') {
      this.inResponse = true;
      const context = this.bindResponseContext(
        String(event.response?.id || ''),
        event.response?.metadata || {}
      );
      if (!context) return;
      this.currentResponseAwaitingClientTranscription = context.pendingSourceItemIds.size > 0;
      this.currentResponseNumericContainmentUnavailable = context.numericUnavailable;
      this.pendingClientTranscriptionUnavailable = false;
      const serverRequested = context.responseKind === 'tool_continuation'
        || context.responseKind === 'opening';
      const requestKey = context.responseKind === 'opening'
        ? 'opening'
        : `continuation:${context.parentResponseId}`;
      const superseded = serverRequested
        && this.serverResponseRequestFor(requestKey)?.superseded === true;
      if (serverRequested) this.retireServerResponseRequest(requestKey);
      const supersededByClient = serverRequested
        && (superseded || context.continuationChain?.invalidated === true);
      if (supersededByClient) {
        try {
          this.sendProvider({ type: 'response.cancel', response_id: context.responseId });
        } catch (_error) { /* provider terminalization owns socket loss */ }
      }
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
      if (context) {
        context.done = true;
        context.status = String(event.response?.status || 'completed');
        if (context.status !== 'completed') context.continuationChain.invalidated = true;
        if (context.toolCallIds.size === 0) context.continuationChain.settled = true;
      }
      this.inResponse = [...this.responseContextsById.values()].some((response) => !response.done);
      if (context) this.foldResponseIntoChain(context);
      if (context) this.maybeRequestToolContinuation(context);
      if (context) await this.maybeArmDirectConfirmation(context);
      if (context && getConsumerConfig(this.env).plannerReconciliationMode !== 'legacy') {
        this.maybeScheduleReconciliation(context);
      }
      this.pruneLiveTurnLedger();
      return this.handleUsage(event.response || {});
    }
  }

  async handleProviderError(event) {
    const classified = classifyRealtimeProviderError(event);
    // Attribute the failure to the ONE request that caused it. Retiring every
    // outstanding request on any error was wrong twice over: an unrelated
    // error erased a pending opening's supersession, so a client who had
    // already started speaking got talked over; and a genuinely failed
    // continuation left its chain waiting forever, holding that turn's review
    // — and the confirmation barrier — shut.
    const failedEventId = String(event?.error?.event_id || event?.event_id || '');
    if (failedEventId) this.settleFailedServerResponse(failedEventId);
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
          {
            skipLeadInTripwires: true,
            // Direct apply has no deterministic English-number authority in
            // either half of L2. The first streaming pass already defers this
            // check; a late ASR event must not reintroduce the legacy parser
            // and cancel a correct semantic rendering after the fact.
            skipNumericContainment: getConsumerConfig(this.env).modulePlannerMode === 'apply'
          }
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
      transcript,
      // The response that CAUSED this turn knows which assistant question it
      // followed. Recording that link is what lets the semantic reader be given
      // the real conversational context instead of whichever row happened to be
      // written before this one.
      // ?? not ||: the turn captured its proposition when the client started
      // speaking, and an explicit null means there genuinely was none. Falling
      // through on null would attach whichever assistant turn finished while
      // ASR was still running — the very substitution this link exists to stop.
      answersTurnId: turn.answersTurnId ?? null
    }).catch(() => null);
    if (storedTurn?.id) turn.storedTurnId = storedTurn.id;

    await appendRealtimeEvent(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      direction: 'server',
      eventType: 'live.client.turn',
      payload: { itemId, inputMode: event.typed === true ? 'text' : 'audio' }
    }).catch(() => {});

    if (event.typed !== true) await this.meterTranscription(event);
    await this.touch();
    await this.drainDeferredEvidenceTools(itemId, transcript);
    this.scheduleReviewsForClientTurn(itemId, transcript);
    const confirmsPublishedDirectSnapshot = Boolean(
      this.directConfirmationOffer
      && turn.answersTurnId
      && turn.answersTurnId === this.directConfirmationOffer.assistantTurnId
      && Number(this.directConfirmationOffer.snapshotRevision)
        === Number(this.directAwaitingConfirmationSnapshotRevision)
      && classifySpokenPlanConfirmation(transcript) === 'affirmed'
    );
    // An answer to anything other than the exact armed plan proposition ends
    // that invitation. This is causal bookkeeping only; the semantic planner,
    // not this comparison, decides what the new utterance means financially.
    if (this.directConfirmationOffer && !confirmsPublishedDirectSnapshot) {
      await this.clearDirectConfirmationOffer();
    }
    if (storedTurn?.id && getConsumerConfig(this.env).modulePlannerMode !== 'off'
      && !confirmsPublishedDirectSnapshot) {
      this.scheduleDirectModulePlanning(storedTurn.id);
    }
    this.pruneLiveTurnLedger();

    // NOTE WHAT DOES NOT HAPPEN HERE: no brief, no `response.create`, and
    // nothing awaited. The provider is already replying.
    //
    // The fact audit below IS a planner call, and it is detached exactly like
    // the compliance review above it: `waitUntil` keeps it off the reply path,
    // so the v2 defect -- a model call BETWEEN the client finishing a sentence
    // and the model being allowed to speak -- cannot come back through it. Its
    // corrections land on a later turn, which is the whole point of an auditor.
    const turnConfig = getConsumerConfig(this.env);
    // Shadow is observational: it must not remove or alter the shipped planner
    // path. Only apply makes the direct snapshot the production authority.
    if (turnConfig.modulePlannerMode !== 'apply') {
      const reconciliationMode = turnConfig.plannerReconciliationMode;
      if (reconciliationMode === 'legacy' && storedTurn?.id) {
        this.state.waitUntil(this.auditTurnFacts(transcript, itemId, storedTurn.id).catch(() => {}));
      } else {
        const settledResponse = [...this.responseContextsById.values()].find((response) => (
          response.causeItemId === itemId && response.done
        ));
        if (settledResponse) this.maybeScheduleReconciliation(settledResponse);
      }
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
        // Direct mode deliberately has no deterministic English reader. The
        // Realtime model may acknowledge spoken-word figures immediately; the
        // independently verified certificate, not this regex, guards anything
        // that can enter a calculation. Recommendation tripwires still run.
        skipNumericContainment: getConsumerConfig(this.env).modulePlannerMode === 'apply'
          || response.pendingSourceItemIds.size > 0
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

    const storedAssistantTurn = await recordRealtimeFinalTurn(this.env, {
      sessionId: this.meta.sessionId,
      leaseId: this.meta.leaseId,
      providerItemId: response.assistantItemId,
      role: 'assistant',
      transcript
    }).catch(() => null);
    // The proposition a client turn will answer. Held here because only the
    // live session knows it: stored row order is ASR completion order, and
    // reconstructing the pairing from it later gets terse answers wrong.
    if (storedAssistantTurn?.id) {
      this.lastCompletedAssistantTurnId = storedAssistantTurn.id;
      response.storedAssistantTurnId = storedAssistantTurn.id;
    }

    // response.done and transcript.done are separate provider events and may
    // arrive in either order. Whichever arrives second arms the offer, but only
    // after the final post-get_state response has both completed and produced a
    // durable assistant proposition for the client's next turn to answer.
    await this.maybeArmDirectConfirmation(response);

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

  async clearDirectConfirmationOffer() {
    this.directConfirmationOffer = null;
    await this.state.storage.delete('directConfirmationOffer').catch(() => {});
  }

  async maybeArmDirectConfirmation(response) {
    const candidate = response?.continuationChain?.directConfirmationCandidate;
    if (!candidate
      || response?.responseId === candidate.sourceResponseId
      || response?.done !== true
      || response?.status !== 'completed'
      || response?.assistantDone !== true
      || !response?.storedAssistantTurnId
      || response?.toolCallIds?.size !== 0
      || response?.continuationChain?.invalidated === true
      || !candidate.confirmationPrompt
      || confirmationReadbackKey(response.assistantTranscript)
        !== confirmationReadbackKey(candidate.confirmationPrompt)
      || Number(candidate.snapshotRevision) !== Number(this.directAwaitingConfirmationSnapshotRevision)
      || this.directModulePlanningPending > 0
      || this.directModulePlanningOutstanding.length > 0) return false;
    const offer = {
      token: String(candidate.token),
      assistantTurnId: String(response.storedAssistantTurnId),
      snapshotRevision: Number(candidate.snapshotRevision),
      certificateSignature: String(candidate.certificateSignature || '')
    };
    this.directConfirmationOffer = offer;
    await this.state.storage.put('directConfirmationOffer', offer);
    return true;
  }

  persistDirectModulePlanningOutstanding() {
    const snapshot = this.directModulePlanningOutstanding.map((item) => ({ ...item }));
    this.directModulePlanningPersistenceChain = this.directModulePlanningPersistenceChain
      .catch(() => {})
      .then(() => this.state.storage.put('directModulePlanningOutstanding', snapshot));
    this.state.waitUntil(this.directModulePlanningPersistenceChain);
    return this.directModulePlanningPersistenceChain;
  }

  scheduleDirectModulePlanning(throughTurnId) {
    // Every finalized client turn becomes a durable review obligation, but a
    // full snapshot through the newest turn subsumes every earlier queued one.
    // Keep one active pass plus the newest watermark rather than paying for an
    // unbounded FIFO backlog while the conversation continues.
    const normalizedTurnId = String(throughTurnId || '');
    if (!normalizedTurnId) return;
    const existing = this.directModulePlanningOutstanding
      .find((item) => item.turnId === normalizedTurnId);
    const job = existing || {
      turnId: normalizedTurnId,
      sequence: ++this.directModulePlanningSequence
    };
    if (!existing) this.directModulePlanningOutstanding.push(job);
    // Any new semantic turn invalidates the confirmation invitation immediately.
    // It will be restored only after a fresh verified snapshot is persisted and
    // published to Realtime.
    this.directAwaitingConfirmationSnapshotRevision = null;
    this.directConfirmationOffer = null;
    this.state.waitUntil(Promise.all([
      this.state.storage.delete('directAwaitingConfirmationSnapshotRevision'),
      this.state.storage.delete('directConfirmationOffer'),
      this.persistDirectModulePlanningOutstanding()
    ]).catch(() => {}));
    if (this.directModulePlanningPending > 0) return this.directModulePlanningChain;

    this.directModulePlanningPending = 1;
    this.directModulePlanningChain = (async () => {
      for (;;) {
        const nextJob = [...this.directModulePlanningOutstanding]
          .sort((left, right) => right.sequence - left.sequence)[0];
        if (!nextJob) break;
        const config = getConsumerConfig(this.env);
        if (config.modulePlannerMode === 'off') break;
        try {
          await this.directModulePlanningPersistenceChain.catch(() => {});
          const context = await loadLiveContext({ env: this.env, config, sessionId: this.meta.sessionId });
          const planned = await runDirectModulePlanning({
            env: this.env,
            config,
            context,
            leaseId: this.meta.leaseId,
            throughTurnId: nextJob.turnId
          });
          // This full transcript snapshot settles every obligation at or before
          // its watermark. A turn arriving during the call remains and is the
          // only additional pass the drain will run.
          this.directModulePlanningOutstanding = this.directModulePlanningOutstanding
            .filter((item) => item.sequence > nextJob.sequence);
          await this.persistDirectModulePlanningOutstanding();
          if (config.modulePlannerMode === 'apply'
            && this.directModulePlanningOutstanding.length === 0) {
            const published = await this.injectVolatileState();
            this.directAwaitingConfirmationSnapshotRevision = published === true
              && planned?.brief?.readyToConfirm === true
                ? Number(planned.snapshot?.snapshotRevision || 0) || null
                : null;
            if (this.directAwaitingConfirmationSnapshotRevision) {
              await this.state.storage.put(
                'directAwaitingConfirmationSnapshotRevision',
                this.directAwaitingConfirmationSnapshotRevision
              );
            } else {
              await this.state.storage.delete('directAwaitingConfirmationSnapshotRevision');
            }
          }
        } catch (error) {
          await appendRealtimeEvent(this.env, {
            sessionId: this.meta?.sessionId,
            leaseId: this.meta?.leaseId,
            direction: 'server',
            eventType: 'live.modules.planning_failed',
            payload: { code: String(error?.code || 'module_planner_failed') }
          }).catch(() => {});
          // Keep the failed watermark durable. A later client turn, get_state,
          // or confirmation attempt may retry it; never spin a paid loop here.
          break;
        }
      }
    })().finally(() => { this.directModulePlanningPending = 0; });
    this.state.waitUntil(this.directModulePlanningChain);
    return this.directModulePlanningChain;
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
    if (getConsumerConfig(this.env).modulePlannerMode === 'apply') return;
    if (!response?.done || !response.causeItemId) return;
    // ONE PLACE, NOT FOUR. Reviewing a turn whose continuation chain is still
    // writing reviews it against part of its own evidence, and deduplication
    // by turn id means the rest never earns another look. Repeating that check
    // at each caller meant every new caller was a chance to forget it — and
    // one already had.
    if (this.awaitsContinuationChain(response)) return;
    const turn = this.clientTurnsByItemId.get(response.causeItemId);
    if (!turn || turn.status !== 'completed' || !turn.storedTurnId) return;
    // The turn is the unit of review, and a turn can span several responses.
    // Reading these off the last hop alone lost the saves that happened on the
    // earlier ones — which is the whole reason the chain accumulates them.
    const chain = response.continuationChain;
    // Pick up anything that landed on an earlier hop after its own done.
    if (chain) {
      for (const candidate of this.responseContextsById.values()) {
        if (candidate.continuationChain === chain) this.foldResponseIntoChain(candidate);
      }
    }
    const hasRejectedNote = Number(chain?.noteRejectedCount ?? response.noteRejectedCount ?? 0) > 0;
    const hasNoteActivity = Number(chain?.noteAcceptedCount ?? response.noteAcceptedCount ?? 0) > 0
      || hasRejectedNote;
    const valueCoverage = valueEvidenceCoverage(
      turn.transcript,
      chain?.acceptedValueEvidence || response.acceptedValueEvidence || []
    );
    // An occurrence that has spent its review budget is still uncovered and
    // still absent from the profile — but it is no longer outstanding WORK, so
    // it neither schedules another paid review nor holds the barrier. Whether
    // an analysis can run without the fact it would have supplied is a
    // readiness question, and readiness still answers it.
    const reviewableGap = this.reviewableValueEvidence(valueCoverage, turn.storedTurnId);
    const hasValueCoverageGap = reviewableGap.length > 0;
    if (hasValueCoverageGap) this.markMaterialTurn(turn);
    const periodic = Number(turn.ordinal || 0) % 3 === 0;
    const requestedTrigger = forcedTrigger
      || response.reconciliationTrigger
      || chain?.reconciliationTrigger
      || (hasValueCoverageGap ? 'value_coverage_gap' : null);
    // OUTSTANDING WORK IS ITSELF A REASON TO RUN.
    //
    // Material turns hold the confirmation barrier, and until now only NEW
    // note activity, a NEW value gap or the every-third-turn checkpoint could
    // schedule the review that retires them. A backlog therefore waited on
    // unrelated future activity to clear, which is how one refused recovery
    // could sit closed across a long stretch of conversation. Scheduling on
    // the backlog itself is what makes the barrier's opening a guarantee
    // rather than a hope; it cannot loop, because a job is deduplicated by
    // its turn id and only a new client turn creates a new one.
    const backlog = this.unreviewedMaterialTurns.length > 0;
    if (!requestedTrigger && !hasNoteActivity && !periodic && !backlog) return;
    const trigger = requestedTrigger
      || (hasRejectedNote ? 'rejected_note'
        : hasNoteActivity ? 'material_turn'
          : periodic ? 'periodic_checkpoint' : 'material_backlog');
    this.queueReconciliation({
      providerItemId: turn.itemId,
      throughTurnId: turn.storedTurnId,
      ordinal: turn.ordinal,
      trigger
    }, { priority: response.reconciliationPriority === true || chain?.reconciliationPriority === true });
    response.reconciliationTrigger = null;
    response.reconciliationPriority = false;
  }

  /**
   * Record that a client turn changed planning state.
   *
   * Deliberately the SAME condition that schedules the turn's reconciliation —
   * a note accepted or rejected — so the set of turns that must be reviewed and
   * the set of turns that get reviewed can never drift apart. A rejection
   * counts: the fast lane refusing a figure is precisely the case the auditor
   * exists to repair, and running the analyses over it would run them over a
   * gap the client has already filled aloud.
   */
  markMaterialTurn(turn) {
    if (!turn?.storedTurnId) return;
    if (this.unreviewedMaterialTurns.some((entry) => entry.turnId === turn.storedTurnId)) return;
    this.unreviewedMaterialTurns = [
      ...this.unreviewedMaterialTurns,
      { turnId: turn.storedTurnId, ordinal: Number(turn.ordinal || 0) }
    ].slice(-MAX_LIVE_TURN_LEDGER_ENTRIES);
    this.state.waitUntil(
      this.state.storage.put('unreviewedMaterialTurns', this.unreviewedMaterialTurns).catch(() => {})
    );
  }

  /**
   * Spend one bounded review attempt on every occurrence this pass presented.
   *
   * WHY A BUDGET AT ALL. The strict reconciliation validator refusing an
   * operation is the system working, not a transient fault — some figures
   * genuinely cannot be placed against a person, an entity and a collection
   * from what the client said. Treating that refusal as "still outstanding"
   * held the confirmation barrier shut for the rest of the meeting, so a
   * client who mentioned one awkward number could never run any analysis.
   *
   * An occurrence that survives its budget is recorded as terminally
   * unresolved: still NOT captured, still absent from the canonical profile,
   * and still blocking — through READINESS — any analysis that needs the fact
   * it would have supplied. What it stops doing is holding back the analyses
   * that never needed it.
   */
  async spendValueEvidenceReviews(reviewedIds, resolvedIds) {
    const reviewed = (Array.isArray(reviewedIds) ? reviewedIds : [])
      .map((id) => String(id || '')).filter(Boolean);
    if (reviewed.length === 0) return false;
    const resolved = new Set((Array.isArray(resolvedIds) ? resolvedIds : [])
      .map((id) => String(id || '')).filter(Boolean));
    const attempts = { ...this.valueEvidenceReviewAttempts };
    const terminal = new Set(this.terminallyUnresolvedEvidence);
    let stillReviewable = false;
    for (const evidenceId of reviewed) {
      // A resolved occurrence keeps no budget: it is either recovered into the
      // profile or reasoned away, and either answer is final.
      if (resolved.has(evidenceId)) {
        delete attempts[evidenceId];
        continue;
      }
      const spent = Number(attempts[evidenceId] || 0) + 1;
      if (spent >= MAX_VALUE_EVIDENCE_REVIEW_ATTEMPTS) {
        delete attempts[evidenceId];
        terminal.add(evidenceId);
      } else {
        attempts[evidenceId] = spent;
        stillReviewable = true;
      }
    }
    const trimmedTerminal = [...terminal].slice(-MAX_LIVE_TURN_LEDGER_ENTRIES);
    const changed = JSON.stringify(attempts) !== JSON.stringify(this.valueEvidenceReviewAttempts)
      || JSON.stringify(trimmedTerminal) !== JSON.stringify(this.terminallyUnresolvedEvidence);
    if (!changed) return stillReviewable;
    const newlyTerminal = trimmedTerminal
      .filter((id) => !this.terminallyUnresolvedEvidence.includes(id));
    this.valueEvidenceReviewAttempts = attempts;
    this.terminallyUnresolvedEvidence = trimmedTerminal;
    await this.state.storage.put('valueEvidenceReviewAttempts', attempts).catch(() => {});
    await this.state.storage.put('terminallyUnresolvedEvidence', trimmedTerminal).catch(() => {});
    if (newlyTerminal.length === 0) return stillReviewable;
    // Recorded, never silently dropped: an occurrence nothing could place is a
    // fact the client gave and the meeting did not keep.
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta?.sessionId,
      leaseId: this.meta?.leaseId,
      direction: 'server',
      eventType: 'live.value_evidence.unresolved',
      payload: {
        // Joined, not an array: the event schema is scalars only, and an array
        // field is dropped by the sanitizer — which is how this diagnostic
        // could be written and still say nothing.
        evidenceIds: newlyTerminal.slice(0, 12).join(','),
        attempts: MAX_VALUE_EVIDENCE_REVIEW_ATTEMPTS
      }
    }).catch(() => {});
    return stillReviewable;
  }

  /**
   * Spend one bounded attempt on every review obligation this pass left open.
   *
   * WHY A BUDGET, AGAIN. Some provisional notes genuinely cannot be settled: a
   * span-free realtime note whose evidence has scrolled out of the bounded
   * transcript can be neither verified by id nor replaced with an
   * evidence-backed correction. Holding `confirm_and_run` shut forever over one
   * of those ends the meeting, and confirming it by exhaustion is the hole this
   * whole mechanism exists to close.
   *
   * SO IT ENDS IN A QUESTION, NOT A DELETION. The first version retracted the
   * note. Run against the live harness that deleted a correct EUR 319,000
   * pension and a correct EUR 95,000 income, because the reviewer had not got
   * round to mentioning them — and a reviewer's silence is not evidence that a
   * figure is wrong. Nothing is deleted now: the client is asked to confirm
   * that specific figure, their answer settles it, and until then readiness
   * holds back exactly the analyses that need it. What it stops doing is
   * holding back the analyses that never needed it.
   */
  async spendNoteReviewObligations(undispositionedNoteIds, escalatedNoteIds = []) {
    const outstanding = [...new Set((Array.isArray(undispositionedNoteIds) ? undispositionedNoteIds : [])
      .map((noteId) => String(noteId || '')).filter(Boolean))];
    const escalated = new Set((Array.isArray(escalatedNoteIds) ? escalatedNoteIds : [])
      .map((noteId) => String(noteId || '')).filter(Boolean));
    // ATTEMPTS CARRY, EVEN WHEN A NOTE IS NOT ISSUED THIS PASS. Rebuilding this
    // map from the current round dropped the count for every obligation the
    // bounded list did not reach, so a note that was asked about, skipped, then
    // asked about again started from one each time and could never be settled.
    const attempts = { ...this.noteReviewAttempts };
    const pendingEscalation = [];
    const blocking = [];
    for (const noteId of outstanding) {
      // Already put to the client: no longer this pass's obligation, and no
      // longer blocking. The fact stays outstanding in readiness until they
      // answer, which is what keeps its analyses held.
      if (escalated.has(noteId)) continue;
      // ALREADY OUT OF ATTEMPTS AND WAITING TO BE ASKED. Re-counting it would
      // reset its budget to one every pass, so it would cycle forever: always
      // blocking, never escalated, and the meeting could not finish. Being
      // spent is a state, not an event.
      if (this.notesPendingEscalation.includes(noteId)) {
        pendingEscalation.push(noteId);
        blocking.push(noteId);
        continue;
      }
      const spent = Number(attempts[noteId] || 0) + 1;
      if (spent >= MAX_NOTE_REVIEW_ATTEMPTS) {
        // Out of attempts but NOT yet asked about — the question is raised by
        // the next pass, which is issued this list. Until it has actually been
        // asked the note still blocks: dropping it here would open the barrier
        // over a figure that is nobody's responsibility.
        delete attempts[noteId];
        pendingEscalation.push(noteId);
        blocking.push(noteId);
        continue;
      }
      attempts[noteId] = spent;
      blocking.push(noteId);
    }
    for (const noteId of escalated) delete attempts[noteId];
    const nextPending = pendingEscalation.filter((noteId) => !escalated.has(noteId));
    const nextBlocking = blocking
      .filter((noteId) => !escalated.has(noteId))
      .map((noteId) => ({ noteId }))
      .slice(-MAX_LIVE_TURN_LEDGER_ENTRIES);

    // A settled note simply stops appearing, so its count would linger.
    // Bounded rather than pruned, because "absent this pass" is exactly what
    // must NOT be read as "settled".
    for (const noteId of Object.keys(attempts).slice(0, -MAX_LIVE_TURN_LEDGER_ENTRIES)) {
      delete attempts[noteId];
    }
    const changed = JSON.stringify(attempts) !== JSON.stringify(this.noteReviewAttempts)
      || JSON.stringify(nextPending) !== JSON.stringify(this.notesPendingEscalation)
      || JSON.stringify(nextBlocking) !== JSON.stringify(this.undispositionedNotes);
    if (!changed) return;
    const newlyEscalated = [...escalated].filter((noteId) => (
      this.notesPendingEscalation.includes(noteId)
    ));
    this.noteReviewAttempts = attempts;
    this.notesPendingEscalation = nextPending;
    this.undispositionedNotes = nextBlocking;
    await this.state.storage.put('noteReviewAttempts', attempts).catch(() => {});
    await this.state.storage.put('notesPendingEscalation', nextPending).catch(() => {});
    await this.state.storage.put('undispositionedNotes', nextBlocking).catch(() => {});
    if (newlyEscalated.length === 0) return;
    // Recorded, never silent: a figure the fast lane wrote and no review could
    // settle is now being put back to the client.
    await appendRealtimeEvent(this.env, {
      sessionId: this.meta?.sessionId,
      leaseId: this.meta?.leaseId,
      direction: 'server',
      eventType: 'live.note_review.unresolved',
      payload: {
        noteIds: newlyEscalated.slice(0, 12).join(','),
        attempts: MAX_NOTE_REVIEW_ATTEMPTS
      }
    }).catch(() => {});
  }

  /** Whether an uncovered occurrence still has review budget left. */
  reviewableValueEvidence(coverage, turnId) {
    const terminal = new Set(this.terminallyUnresolvedEvidence);
    return (coverage?.uncovered || []).filter((item) => (
      !terminal.has(`${turnId}:${item.evidenceId}`)
    ));
  }

  /**
   * Retire the material turns a completed reconciliation has now reviewed.
   *
   * A pass through turn N reviews the whole transcript up to N, so it clears
   * every material turn at or before that ordinal — not just an exact id match.
   * Ordinals, not ids, because the reviewed turn is frequently not itself
   * material (a periodic checkpoint), and an id comparison would leave earlier
   * material turns outstanding for the rest of the meeting.
   *
   * EXCEPT the turns the pass says it could not settle. A stored note that
   * disagrees with an independent reading of its own evidence is a disputed
   * figure, and clearing its turn by ordinal would let `confirm_and_run` run an
   * analysis on a value both readers contradict.
   */
  async clearReviewedMaterialTurns(ordinal, unresolvedTurnIds = []) {
    const reviewedThrough = Number(ordinal || 0);
    if (!reviewedThrough) return;
    const unresolved = new Set((unresolvedTurnIds || []).map((turnId) => String(turnId)));
    const remaining = this.unreviewedMaterialTurns
      .filter((entry) => Number(entry.ordinal || 0) > reviewedThrough
        // Named as unsettled by the pass itself: keep blocking.
        || unresolved.has(String(entry.turnId)));
    if (remaining.length === this.unreviewedMaterialTurns.length) return;
    this.unreviewedMaterialTurns = remaining;
    await this.state.storage.put('unreviewedMaterialTurns', remaining).catch(() => {});
  }

  /**
   * Hold, or release, an unresolved position identity.
   *
   * Recorded when the lane cannot tell a newly mentioned holding from one it
   * already has, and cleared the moment a save for that fact succeeds — which
   * is exactly what happens once the client says "the same one" or "a separate
   * one", because either answer lets the write through. Nothing here inspects
   * amounts, and nothing merges: the conversation resolves it, not this.
   */
  async recordIdentityAmbiguities(ambiguities, savedFactIds) {
    const resolved = new Set(savedFactIds);
    const next = [
      ...this.unresolvedIdentities.filter((entry) => !resolved.has(entry.factId)),
      ...ambiguities
        .filter((entry) => entry?.factId && !resolved.has(entry.factId))
        .map((entry) => ({ factId: String(entry.factId), candidateId: entry.candidateId || null }))
    ].filter((entry, index, all) => all.findIndex((item) => item.factId === entry.factId) === index)
      .slice(-MAX_LIVE_PLANNER_REQUESTS);
    if (JSON.stringify(next) === JSON.stringify(this.unresolvedIdentities)) return;
    this.unresolvedIdentities = next;
    await this.state.storage.put('unresolvedIdentities', next).catch(() => {});
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
      reviewTurnIds: [...new Set((Array.isArray(job?.reviewTurnIds) ? job.reviewTurnIds : [])
        .map((turnId) => String(turnId || ''))
        .filter(Boolean))].slice(-MAX_LIVE_TURN_LEDGER_ENTRIES),
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
      // A later checkpoint may replace a queued earlier one. Carry the exact
      // outstanding material-turn identities so coalescing broadens the audit
      // watermark without erasing an earlier omission obligation.
      reviewTurnIds: this.unreviewedMaterialTurns
        .filter((entry) => Number(entry.ordinal || 0) <= Number(job.ordinal || 0))
        .map((entry) => entry.turnId)
        .concat(String(job.throughTurnId || '')),
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
      reviewTurnIds: job.reviewTurnIds,
      terminallyUnresolvedEvidenceIds: this.terminallyUnresolvedEvidence,
      // Obligations that have run out of attempts. This pass retracts them, and
      // only once it has do they stop blocking — so the figure is never out of
      // the barrier's sight while it is still in the profile.
      escalateNoteIds: this.notesPendingEscalation,
      trigger: job.trigger,
      retryAttempt: job.retryAttempt,
      // What lets a validated correction survive the client answering the next
      // question while the planner was still thinking. Deterministic re-
      // projection only: this never issues another model call, so it cannot
      // extend the background pass into anything the reply path waits on.
      loadContext: () => this.loadPlannerReconciliationContext(config)
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
      let errorReviewedValueEvidenceIds = [];
      try {
        if (config.plannerReconciliationMode === 'legacy') {
          result = { status: 'legacy' };
        } else {
          const context = await this.loadPlannerReconciliationContext(config);
          result = await this.executePlannerReconciliation(config, context, job);
        }
      } catch (error) {
        errorCode = String(error?.code || 'planner_reconciliation_failed');
        // A failed pass still consumed a look at these occurrences. Counting it
        // is what stops a model that reliably chokes on one awkward figure from
        // being asked about it for the rest of the meeting.
        errorReviewedValueEvidenceIds = Array.isArray(error?.reviewedValueEvidenceIds)
          ? error.reviewedValueEvidenceIds
          : [];
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
      // Only a pass that actually reached a reviewed verdict retires material
      // work. `pending`, `conflicted` and `failed` clear nothing, so unresolved
      // material state keeps blocking the analyses — which is the whole point.
      //
      // Every occurrence this pass put in front of the model spends one of its
      // bounded attempts, whether the pass succeeded, was refused or failed.
      // That is what guarantees the outstanding set shrinks, and with it that
      // the confirmation barrier always opens eventually.
      const valueEvidenceStillReviewable = await this.spendValueEvidenceReviews(
        result?.reviewedValueEvidenceIds ?? errorReviewedValueEvidenceIds,
        result?.resolvedValueEvidenceIds
      ).catch(() => false);
      // OBLIGATIONS ARE SPENT ON EVERY OUTCOME, including a failure. A pass that
      // crashed settled nothing, and the notes it was issued are still
      // outstanding — reporting them as discharged is how a failed
      // reconciliation would quietly open the barrier.
      await this.spendNoteReviewObligations(
        result?.undispositionedNoteIds,
        result?.escalatedNoteIds
      ).catch(() => {});
      if ((result?.status === 'shadow' || result?.status === 'applied')
        && !valueEvidenceStillReviewable) {
        // A pass can succeed overall and still have failed to settle a specific
        // turn: a review that found a stored note contradicting the independent
        // reading of its own evidence has discovered a disputed figure, not
        // reviewed one. Retiring that turn by ordinal would open the
        // confirmation barrier over a value both readers say is wrong.
        await this.clearReviewedMaterialTurns(
          job.ordinal,
          result?.unresolvedReviewTurnIds || []
        ).catch(() => {});
      }

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
          transcript,
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
          result: {
            ok: true,
            appliedCount: applied,
            sourcedValueEvidence: outcome.sourcedValueEvidence
          },
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
   * it. This is the only Worker-created response that changes substantive
   * speech for safety. The opening and post-tool response.create calls merely
   * start protocol turns; native VAD still owns ordinary conversational flow.
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
    this.registerResponseToolCall(event);

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
        const directOfferMatches = Boolean(
          affirmedConfirmation
          && this.directConfirmationOffer
          && causalTurn?.answersTurnId
          && causalTurn.answersTurnId === this.directConfirmationOffer.assistantTurnId
          && String(args?.confirmationToken || '') === this.directConfirmationOffer.token
          && Number(this.directConfirmationOffer.snapshotRevision)
            === Number(this.directAwaitingConfirmationSnapshotRevision)
        );
        const directPlanningUnsettled = this.directModulePlanningPending > 0
          || this.directModulePlanningOutstanding.length > 0
          || !this.directAwaitingConfirmationSnapshotRevision;
        if (affirmedConfirmation && config.modulePlannerMode === 'apply'
          && !directOfferMatches) {
          result = {
            ok: false,
            code: 'confirmation_context_invalid',
            retryable: true,
            message: 'The verified plan must be read back again before it can run. Call get_state, summarize that current plan, and ask for confirmation.'
          };
        } else if (directOfferMatches && directPlanningUnsettled) {
          if (this.directModulePlanningPending === 0
            && this.directModulePlanningOutstanding.length > 0) {
            this.scheduleDirectModulePlanning(
              this.directModulePlanningOutstanding.at(-1)?.turnId
            );
          } else if (this.directModulePlanningPending === 0) {
            // The semantic pass may have succeeded while its volatile-state
            // publication failed. Re-publish the stored snapshot; do not pay
            // for or invent a second interpretation merely to recover transport.
            const published = await this.injectVolatileState();
            if (published) {
              const latestDirect = await getLatestRealtimeMeetingBrief(
                this.env,
                this.meta.sessionId,
                this.meta.leaseId
              ).catch(() => null);
              if (latestDirect?.brief?.readyToConfirm === true) {
                this.directAwaitingConfirmationSnapshotRevision = Number(
                  latestDirect.brief.snapshotRevision || 0
                ) || null;
                if (this.directAwaitingConfirmationSnapshotRevision) {
                  await this.state.storage.put(
                    'directAwaitingConfirmationSnapshotRevision',
                    this.directAwaitingConfirmationSnapshotRevision
                  );
                }
              }
            }
          }
          result = {
            ok: false,
            code: 'module_planning_pending',
            retryable: true,
            message: 'I am completing the final input check before running the analyses. Please wait a moment and then confirm again.'
          };
        }
        if (affirmedConfirmation
          && config.modulePlannerMode !== 'apply'
          && config.plannerReconciliationMode !== 'legacy') {
          const lease = await getRealtimeLease(
            this.env,
            this.meta.sessionId,
            this.meta.leaseId
          ).catch(() => null);
          const preflight = plannerReconciliationPreflight(
            config.plannerReconciliationMode,
            lease,
            this.unreviewedMaterialTurns,
            this.unresolvedIdentities,
            this.undispositionedNotes
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
        if (!result && name === 'get_state' && config.modulePlannerMode === 'apply') {
          // A get_state call deliberately crosses the background boundary. It
          // never delays native turn-taking before the model starts replying;
          // it may, however, wait here at the explicit pre-confirmation tool
          // boundary so the following read-back reflects every finalized turn.
          if (this.directModulePlanningPending === 0
            && this.directModulePlanningOutstanding.length > 0) {
            this.scheduleDirectModulePlanning(
              this.directModulePlanningOutstanding.at(-1)?.turnId
            );
          }
          await this.directModulePlanningChain.catch(() => {});
          const direct = await getLatestRealtimeMeetingBrief(
            this.env,
            this.meta.sessionId,
            this.meta.leaseId
          );
          const brief = direct?.brief?.schemaVersion === 'MeetingBriefV3'
            ? direct.brief
            : null;
          const snapshotRevision = Number(brief?.snapshotRevision || 0);
          const readyForOffer = brief?.readyToConfirm === true
            && snapshotRevision > 0
            && snapshotRevision === Number(this.directAwaitingConfirmationSnapshotRevision)
            && this.directModulePlanningPending === 0
            && this.directModulePlanningOutstanding.length === 0
            && Boolean(brief?.verificationCertificate?.signature)
            && Boolean(brief?.confirmationPrompt)
            && Boolean(responseContext?.continuationChain);
          let confirmationToken = null;
          if (readyForOffer) {
            await this.clearDirectConfirmationOffer();
            confirmationToken = `dmc_${crypto.randomUUID()}`;
            responseContext.continuationChain.directConfirmationCandidate = {
              token: confirmationToken,
              snapshotRevision,
              certificateSignature: String(brief.verificationCertificate.signature),
              confirmationPrompt: String(brief.confirmationPrompt),
              sourceResponseId: responseContext.responseId
            };
          }
          result = {
            schemaVersion: 'DirectModuleToolStateV1',
            snapshotRevision,
            readyToConfirm: readyForOffer,
            confirmationToken,
            confirmationPrompt: readyForOffer ? String(brief.confirmationPrompt) : null,
            verificationStatus: brief?.verification?.verdict || 'pending',
            modules: (brief?.directModuleSnapshot?.modules || [])
              .filter((item) => item?.status !== 'not_relevant')
              .map((item) => ({
                moduleId: item.moduleId,
                status: item.status,
                knownSummary: item.steeringSummary,
                missing: item.missing || [],
                ambiguities: item.ambiguities || []
              })),
            generalAmbiguities: brief?.ambiguities || brief?.directModuleSnapshot?.generalAmbiguities || []
          };
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
      const savedCount = Array.isArray(result?.saved) ? result.saved.length : 0;
      const rejectedCount = Array.isArray(result?.rejected) ? result.rejected.length : 0;
      if (Array.isArray(result?.sourcedValueEvidence)) {
        responseContext.acceptedValueEvidence = [
          ...(responseContext.acceptedValueEvidence || []),
          ...result.sourcedValueEvidence
        ];
      }
      // An identity the lane could not resolve becomes outstanding; a later
      // save that DOES land for the same fact is the resolution, whichever way
      // the client answered, so it clears.
      await this.recordIdentityAmbiguities(
        result?.identityAmbiguities || [],
        Array.isArray(result?.saved) ? result.saved : []
      ).catch(() => {});
      responseContext.noteAcceptedCount += savedCount;
      responseContext.noteRejectedCount += rejectedCount;
      const reconciling = getConsumerConfig(this.env).plannerReconciliationMode !== 'legacy';
      // The turn becomes material from this moment, which is what lets note
      // activity on the confirming turn hold the barrier: the save runs before
      // the confirm in the same response, so the marker is already set when the
      // gate reads it.
      //
      // Not tracked in legacy at all. Nothing there ever reviews a turn, so a
      // legacy meeting would accumulate outstanding work it can never retire
      // and pay a durable write per turn for a set no one reads.
      if (reconciling && (savedCount > 0 || rejectedCount > 0)) {
        this.markMaterialTurn(responseContext.causeItemId
          ? this.clientTurnsByItemId.get(responseContext.causeItemId)
          : null);
      }
      // A save that lands after its own response.done must NOT review the turn
      // on its own: the continuation it just earned may still write more. The
      // chain's final response schedules once, for everything the turn did.
      if (responseContext.done && reconciling) {
        this.maybeScheduleReconciliation(responseContext);
      }
    }
    if (name === 'confirm_and_run'
      && responseContext?.done
      && responseContext.reconciliationTrigger === 'pre_confirmation') {
      this.maybeScheduleReconciliation(responseContext);
    }

    const {
      context: _context,
      sourcedValues: _values,
      sourcedValueEvidence: _evidence,
      result: _full,
      ...modelSafe
    } = result || {};
    try {
      this.sendProvider({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(modelSafe).slice(0, 8_000) }
      });
    } catch (_error) {
      return;
    }
    // After a save, hand the model a short refreshed state item instead of
    // rewriting `instructions`. The cached prefix has to survive the call.
    // The output is the protocol-critical half: once it has landed, a failed
    // best-effort state refresh must not strand the conversation forever.
    if (name === 'save_facts' && result?.ok) {
      await this.injectVolatileState().catch(() => {});
    }
    this.markResponseToolOutputDelivered(responseContext, callId);

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
      await this.clearDirectConfirmationOffer();
      this.directAwaitingConfirmationSnapshotRevision = null;
      await this.state.storage.delete('directAwaitingConfirmationSnapshotRevision').catch(() => {});
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
    const config = getConsumerConfig(this.env);
    if (config.modulePlannerMode === 'apply') {
      const direct = await getLatestRealtimeMeetingBrief(
        this.env,
        this.meta.sessionId,
        this.meta.leaseId
      ).catch(() => null);
      if (direct?.brief?.schemaVersion === 'MeetingBriefV3') {
        const snapshotRevision = Number(direct.brief.snapshotRevision || 0);
        if (snapshotRevision < this.lastInjectedDirectSnapshotRevision) return false;
        if (snapshotRevision === this.lastInjectedDirectSnapshotRevision) return true;
        try {
          this.sendProvider({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'system',
              content: [{ type: 'input_text', text: liveDirectModuleStateItem(direct.brief) }]
            }
          });
          this.lastInjectedDirectSnapshotRevision = snapshotRevision;
        } catch (_error) { return false; /* the model still has get_state */ }
        return true;
      }
      return false;
    }
    let projection;
    try {
      projection = liveStateProjection(await loadLiveContext({
        env: this.env,
        config,
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
              // The background planner's outstanding asks, plus any holding the
              // lane could not tell apart from one already recorded. The model
              // has to ask which it is before the analyses can run, so it has
              // to be told.
              plannerRequests: [
                ...this.plannerRequests,
                ...this.unresolvedIdentities.map((entry) => ({
                  factInstanceId: `${entry.factId}:identity`,
                  factId: entry.factId,
                  ownerId: null,
                  prompt: 'Is that the same pension already recorded, or a separate one?'
                }))
              ],
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
