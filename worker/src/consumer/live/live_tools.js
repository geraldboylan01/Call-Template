/**
 * The live lane's three tools.
 *
 * DESIGN RULE: EVERY EXECUTOR IS PURE JS PLUS AT MOST A FEW D1 WRITES.
 *
 * The v2 lane put an 8-second LLM call between the client finishing a sentence
 * and the model being allowed to reply (plus a serialized 12-second retry). The
 * work that call was doing — deciding what the client said — is done here by
 * the model itself, inside the same response it speaks. What is left on the
 * server is validation, which is deterministic and fast.
 *
 * If anything in this file ever grows a network call to a model, the latency
 * bug is back.
 *
 * The versioned-tool machinery from the v2 lane is deliberately NOT ported:
 * no per-call `expectedRevision`, no tool-attempt rows, no nonce binding, no
 * retry loop on rejection. Once nothing but confirm_and_run can mutate money,
 * optimistic concurrency on that one call is sufficient, and every other
 * rejection can simply be ignored by a conversation that keeps moving.
 */

import { ConsumerError } from '../errors.js';
import { applyPlannerCandidates, confirmPlanSelection } from '../planning_turn.js';
import { buildPlanningContext } from '../planning_context.js';
import {
  confirmAndRunRealtimeAnalysisPlan,
  prepareRealtimeVoiceAnalysisPlan
} from '../realtime_analysis.js';
import { classifySpokenPlanConfirmation } from '../realtime_completion.js';
import { getCurrentProfile, getSessionRow } from '../repository.js';
import { getSemanticFactDefinition } from '../../../../js/planning/semantic_facts.js';

const MAX_FACTS_PER_CALL = 10;

export const LIVE_TOOL_DEFINITIONS = Object.freeze([
  {
    type: 'function',
    name: 'save_facts',
    description:
      'Record what the client just told you. Batch everything from one answer into a single call. '
      + 'This never interrupts you — keep talking; the drafts appear on the client\'s screen. '
      + 'Use the exact factId values from your instructions. Monetary values are '
      + '{"amount": <number>, "currency": "EUR"}. The primary_goal value is {"type": "<goal>"}. '
      + 'Certainty is "exact" when they stated it plainly, "approximate" when they hedged or you '
      + 'inferred it from context, "range" for {"min":..,"max":..}, "unknown" when they genuinely '
      + 'do not know. Numbers and money must come from what they actually said — never estimate. '
      + 'Life-stage and household context may be inferred from a clear narrative at "approximate". '
      + 'If a fact comes back rejected, that is not the client\'s fault: say nothing about it and '
      + 'carry on.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['facts'],
      properties: {
        facts: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_FACTS_PER_CALL,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['factId', 'value', 'certainty'],
            properties: {
              factId: { type: 'string', minLength: 1, maxLength: 120 },
              value: {},
              certainty: { type: 'string', enum: ['exact', 'approximate', 'range', 'unknown'] }
            }
          }
        }
      }
    }
  },
  {
    type: 'function',
    name: 'get_state',
    description:
      'See what you have captured so far, which analyses are in play, and what is still missing. '
      + 'Use it whenever you are deciding what to ask next, or to check you are not about to '
      + 'repeat yourself. It is cheap — use it freely. It returns plain descriptions only; there '
      + 'are no internal names to read out.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} }
  },
  {
    type: 'function',
    name: 'confirm_and_run',
    description:
      'Run the analyses. Call this ONLY after you have said out loud what you are going to run '
      + 'and the client has clearly agreed in their own words. The server checks their actual '
      + 'last words and refuses if they did not clearly say yes. Never call it on an assumption, '
      + 'a maybe, or to move things along.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} }
  }
]);

export const LIVE_TOOL_NAMES = Object.freeze(LIVE_TOOL_DEFINITIONS.map((tool) => tool.name));

/**
 * The config the shared planning core sees.
 *
 * `realtimeConversationV2Enabled` is what the core uses to mean "this is a
 * free conversation, not the controlled v1 question journey". Two behaviours
 * hang off it and the live lane needs both:
 *
 *   1. planFactProposal skips the module-relevance gate, so an orientation
 *      fact can be saved BEFORE the analyses that would need it are chosen.
 *      Gating it the other way round is the circular-fact-gate defect from
 *      docs/realtime-conversation-intelligence-plan.md §0 Defect 3.
 *   2. facts save as reviewable drafts rather than waiting for a spoken
 *      read-back, which the live lane does not have.
 *
 * The live lane's own rollout flag is separate and is never conflated with it.
 */
export function livePlanningConfig(config) {
  return { ...config, realtimeConversationV2Enabled: true };
}

/** Load the planning context for the current session state. */
export async function loadLiveContext({ env, config, sessionId }) {
  const sessionRow = await getSessionRow(env, sessionId);
  if (!sessionRow) throw new ConsumerError(404, 'session_not_found', 'That planning session no longer exists.');
  const profile = await getCurrentProfile(env, sessionRow);
  return buildPlanningContext({
    config: livePlanningConfig(config),
    sessionRow,
    profile,
    channel: 'live'
  });
}

function factLabel(factId) {
  return getSemanticFactDefinition(factId)?.label || factId;
}

/* ------------------------------------------------------------- save_facts */

function normalizedFacts(args) {
  const facts = Array.isArray(args?.facts) ? args.facts : [];
  if (!facts.length) {
    throw new ConsumerError(400, 'live_facts_required', 'save_facts needs at least one fact.');
  }
  return facts.slice(0, MAX_FACTS_PER_CALL).map((fact, index) => ({
    candidateId: `live-${index}`,
    operation: 'upsert',
    factId: String(fact?.factId || '').slice(0, 120),
    value: fact?.value,
    certainty: String(fact?.certainty || 'exact'),
    evidenceText: '',
    correctionTarget: ''
  }));
}

/**
 * Shape the model's own extraction into the candidate list the shared core
 * already consumes, then reuse applyPlannerCandidates wholesale.
 *
 * That reuse is the point: each candidate is proposed against a freshly
 * reloaded profile, so one bad fact cannot discard the rest of a good answer —
 * the behaviour the v2 lane spent several incidents arriving at.
 */
async function executeSaveFacts(args, deps) {
  const candidates = normalizedFacts(args);
  const context = await deps.loadContext();
  const applied = await applyPlannerCandidates({
    env: deps.env,
    config: livePlanningConfig(deps.config),
    context,
    extraction: {
      goalCandidates: [],
      semanticFacts: candidates,
      positions: [],
      sectionCompletions: [],
      invalidCandidates: []
    },
    evidenceRef: deps.evidenceRef || null,
    leaseId: deps.leaseId || null,
    toolAttemptId: null,
    loadContext: deps.loadContext
  });

  const saved = applied.outcomes.filter((item) => item.accepted).map((item) => item.factId);
  const rejected = applied.outcomes
    .filter((item) => !item.accepted && item.factId)
    .map((item) => ({ factId: item.factId, reason: item.errorCode }));

  return {
    ok: true,
    saved,
    rejected,
    // Anything that saved is now a figure the model is allowed to say out loud.
    // The Durable Object folds these into the compliance sourced-figure set.
    sourcedValues: candidates
      .filter((candidate) => saved.includes(candidate.factId))
      .map((candidate) => candidate.value),
    context: applied.context
  };
}

/* -------------------------------------------------------------- get_state */

/**
 * NO INTERNAL IDS LEAVE THIS FUNCTION.
 *
 * The model is told never to say a module id out loud; not returning one makes
 * that structurally impossible rather than a rule it has to remember. Module
 * selection is server-owned, so the model never needs to name one back to us.
 */
function liveStateProjection(context) {
  const state = context.state || {};
  const captured = (state.facts || [])
    .filter((fact) => fact?.factId)
    .map((fact) => factLabel(fact.factId));

  const analyses = (state.recommendations || []).map((item) => ({
    description: item.description,
    status: item.status,
    stillNeeded: (item.requiredMissing || []).map((missing) => ({
      factId: missing.factId,
      why: missing.reason
    }))
  }));

  const missing = [...new Set(analyses.flatMap((analysis) => analysis.stillNeeded.map((item) => item.factId)))];

  return {
    ok: true,
    captured: [...new Set(captured)].slice(0, 40),
    analyses: analyses.slice(0, 3),
    missing: missing.slice(0, 20),
    goalsAgreed: !state.requiresGoalPriorityQuestion && (state.moduleSlots || []).length > 0,
    readyToConfirm: analyses.length > 0 && missing.length === 0,
    deferredTopics: (state.deferredOrAdviserTopics || []).map((topic) => ({
      description: topic.description,
      reason: topic.reason
    }))
  };
}

/* -------------------------------------------------------- confirm_and_run */

/**
 * THE ONE HARD GATE IN THE LANE.
 *
 * Everything else here is permissive by design; this is not. The model is an
 * untrusted caller: it does not get to assert that the client agreed. The
 * server reads the client's actual last words and classifies them with the
 * existing deterministic classifier, and a plan runs only against the exact
 * profile revision it was prepared for.
 */
async function executeConfirmAndRun(_args, deps) {
  const transcript = String(deps.latestClientTranscript || '');
  if (classifySpokenPlanConfirmation(transcript) !== 'affirmed') {
    return {
      ok: false,
      code: 'confirmation_required',
      message: 'The client has not clearly agreed yet. Ask a plain yes/no question and wait for their answer.'
    };
  }

  const context = await deps.loadContext();
  const config = livePlanningConfig(deps.config);
  const expectedRevision = Number(context.sessionRow.current_profile_revision);

  const prepared = await prepareRealtimeVoiceAnalysisPlan({
    env: deps.env,
    config,
    sessionRow: context.sessionRow,
    profile: context.profile,
    leaseId: deps.leaseId || null,
    idempotencyKey: `live-confirm-${context.sessionRow.id}-${expectedRevision}`
  });

  // Records the exact set the client just agreed to, then confirms the
  // revision in place (D-01). Only that set may execute.
  await confirmPlanSelection({
    env: deps.env,
    config,
    sessionRow: context.sessionRow,
    profile: context.profile,
    channel: 'live'
  });

  const executed = await confirmAndRunRealtimeAnalysisPlan({
    env: deps.env,
    config,
    sessionId: context.sessionRow.id,
    planId: prepared.row.id,
    planNonce: prepared.planNonce,
    expectedRevision
  });

  return {
    ok: executed.analysisPlan?.status === 'complete',
    status: executed.analysisPlan?.status || 'unknown',
    // Deterministic, server-owned copy. The model must speak it as given and
    // must never recompute or embellish anything in it.
    speakableText: executed.result?.speakableText || '',
    completedCount: (executed.result?.completedModuleIds || []).length,
    navigationTarget: '/plan/#results',
    result: executed.result || null
  };
}

/* ------------------------------------------------------------- dispatcher */

export function assertLiveToolName(name) {
  if (!LIVE_TOOL_NAMES.includes(name)) {
    throw new ConsumerError(400, 'live_tool_unknown', 'That tool is not available in this meeting.');
  }
  return name;
}

/**
 * Run one tool call.
 *
 * A rejection is a normal outcome, not an error: the conversation carries on
 * regardless. Only a genuinely broken call throws, and the caller turns that
 * into an ordinary tool result too — a tool failure must never stall speech.
 */
export async function executeLiveTool(name, args, deps) {
  assertLiveToolName(name);
  if (name === 'save_facts') return executeSaveFacts(args, deps);
  if (name === 'get_state') return liveStateProjection(await deps.loadContext());
  return executeConfirmAndRun(args, deps);
}

export { liveStateProjection };
