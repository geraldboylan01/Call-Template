/**
 * The protected agent-test session.
 *
 * A text meeting over the SAME planning engine the live voice meeting uses.
 * Every planning decision — goal routing, question selection, fact validation,
 * module offers, the three-analysis capacity flow, final confirmation and
 * execution — is made by the shared services in planning_context.js,
 * planning_facts.js and planning_turn.js. This module owns only what is
 * genuinely transport-specific: HTTP-shaped session lifecycle, quotas, and the
 * two visibility projections.
 *
 * It is a TESTING facility, not a consumer product surface. It is adviser
 * authenticated, feature flagged off by default, and synthetic-data only.
 */

import { ConsumerError } from './errors.js';
import { randomId } from './crypto.js';
import {
  getCurrentProfile,
  getSessionRow,
  recordEvent
} from './repository.js';
import {
  beginRealtimeToolAttempt,
  completeRealtimeToolAttempt,
  getLatestRealtimeMeetingBrief,
  listRealtimeFinalTurns,
  listRecentRealtimeFinalTurns,
  recordRealtimeFinalTurn,
  setRealtimeMeetingPhase
} from './realtime_repository.js';
import { extractRealtimePlannerTurn } from './realtime_planner.js';
import { buildPlanningContext } from './planning_context.js';
import {
  applyPlannerCandidates,
  composeAndPersistBrief,
  confirmPlanSelection,
  recordPlanEvaluation,
  resolveCapacityDecision,
  resolveModuleOffer
} from './planning_turn.js';
import { confirmAndRunRealtimeAnalysisPlan, prepareRealtimeVoiceAnalysisPlan } from './realtime_analysis.js';
import { renderAssistantText } from './agent_text_channel.js';
import {
  addAgentMeetingSpend,
  agentMeetingSpendMicroEur,
  closeAgentMeeting,
  countAgentTurns,
  createAgentMeeting,
  getActiveAgentMeeting
} from './agent_repository.js';
import { deterministicFallbackExtraction } from './planning_facts.js';
import { redactSensitiveIdentifiers } from './validators.js';

export const AGENT_CHANNEL = 'agent_test';

function assertAgentTestEnabled(config) {
  if (!config.agentTestEnabled) {
    throw new ConsumerError(404, 'agent_test_disabled', 'The agent-test environment is not available.');
  }
}

/**
 * Build the shared planning context for an agent meeting.
 *
 * Note what is NOT here: realtime consent and a realtime lease. Those are the
 * voice transport's gates, and this is exactly the separation A1 extracted.
 */
export async function loadAgentContext(env, config, sessionId, meetingId) {
  const sessionRow = await getSessionRow(env, sessionId);
  if (!sessionRow || sessionRow.deleted_at) {
    throw new ConsumerError(404, 'agent_session_not_found', 'That test session does not exist.');
  }
  const profile = await getCurrentProfile(env, sessionRow);
  const storedBrief = await getLatestRealtimeMeetingBrief(env, sessionId, meetingId);
  return {
    ...buildPlanningContext({
      config,
      sessionRow,
      profile,
      pendingProposals: [],
      meetingPhase: storedBrief?.brief?.phase || null,
      latestMeetingBrief: storedBrief?.brief || null,
      channel: AGENT_CHANNEL
    }),
    meetingId
  };
}

/* ------------------------------------------------------------------ */
/* Projections                                                         */
/* ------------------------------------------------------------------ */

/**
 * TIER 1 — what the simulated client (or a human tester playing the client)
 * may see. Natural language plus `phase` and `revision` only.
 *
 * Deliberately absent: module ids, goal codes, fact ids, readiness reasons,
 * capacity internals, brief signatures, plan nonces and — above all —
 * `withheldOpportunities`. The external model is playing the consumer; giving
 * it any of that would invalidate the test.
 */
export function toAgentConsumerView({ assistantText, context, turnId = null }) {
  return {
    turnId,
    revision: Number(context.sessionRow.current_profile_revision),
    phase: context.state.meetingBrief?.phase || context.state.realtimePhase || 'discovery',
    assistantMessage: assistantText
  };
}

/**
 * TIER 2 — what an authenticated tester may see. Internal module ids ARE
 * included here, because a tester's whole job is to check that the internal
 * routing and the client-facing language agree.
 *
 * Still absent (TIER 3, server only): brief signature, analysis plan nonce,
 * encryption material, raw planner prompts, provider ids and
 * `withheldOpportunities`.
 */
export function toAgentDiagnosticView(context) {
  const state = context.state;
  const brief = state.meetingBrief;
  return {
    revision: Number(context.sessionRow.current_profile_revision),
    confirmedRevision: state.confirmedProfileRevision,
    stage: state.stage,
    phase: brief?.phase || state.realtimePhase || 'discovery',
    goals: {
      primary: state.goalAssessment?.primaryGoalType ?? null,
      active: [...(state.goalAssessment?.activeGoalTypes || [])],
      deferred: [...(state.goalAssessment?.deferredGoalTypes || [])],
      confidence: state.goalAssessment?.confidence ?? null,
      priorityQuestionRequired: state.requiresGoalPriorityQuestion === true,
      decisionTopicQuestionRequired: state.requiresDecisionTopicQuestion === true
    },
    facts: (state.facts || []).map((fact) => ({
      factId: fact.factId,
      value: fact.value,
      certainty: fact.certainty ?? null,
      status: fact.status ?? null
    })),
    pendingQuestion: brief?.questionBatch
      ? {
          factId: brief.questionBatch.primaryFact?.factId ?? null,
          topic: brief.questionBatch.topic,
          prompt: brief.questionBatch.prompt
        }
      : null,
    stillNeeded: (brief?.stillNeeded || []).map((item) => ({
      factId: item.factId,
      moduleId: item.moduleId ?? null,
      reason: item.reason
    })),
    analyses: (state.moduleSlots || []).map((slot) => ({
      slot: slot.slot,
      moduleId: slot.moduleId,
      description: slot.description,
      selectionState: slot.selectionState,
      availability: slot.availability,
      intakeStatus: slot.intakeStatus
    })),
    opportunities: (state.moduleOpportunities || []).map((item) => ({
      moduleId: item.moduleId,
      state: item.state
    })),
    capacity: state.capacity
      ? {
          maximumAnalyses: state.capacity.maximumAnalyses,
          used: state.capacity.used,
          atLimit: state.capacity.atLimit === true,
          overflowModuleIds: [...(state.capacity.overflowModuleIds || [])]
        }
      : null,
    activeOffer: brief?.moduleOffer
      ? {
          moduleId: brief.moduleOffer.moduleId,
          anchor: brief.moduleOffer.anchor,
          spokenOffer: brief.moduleOffer.spokenOffer
        }
      : null,
    activeCapacityDecision: brief?.capacityDecision
      ? {
          candidateModuleId: brief.capacityDecision.candidateModuleId,
          currentModuleIds: [...brief.capacityDecision.currentModuleIds],
          replacementChoices: brief.capacityDecision.replacementChoices.map((choice) => ({
            choiceIndex: choice.choiceIndex,
            moduleId: choice.moduleId,
            description: choice.description
          })),
          spoken: brief.capacityDecision.spoken
        }
      : null,
    planningDecisions: {
      accepted: [...(context.profile?.assumptions?.values?.planning?.acceptedModuleIds || [])],
      declined: [...(context.profile?.assumptions?.values?.planning?.declinedModuleIds || [])],
      deferred: [...(context.profile?.assumptions?.values?.planning?.deferredModuleIds || [])],
      replaced: [...(context.profile?.assumptions?.values?.planning?.replacedModuleIds || [])],
      confirmed: [...(context.profile?.assumptions?.values?.planning?.confirmedModuleIds || [])]
    },
    readyToConfirm: brief?.readyToConfirm === true,
    confirmationSummary: brief?.confirmationSummary || '',
    analysisPlan: brief?.analysisPlan
      ? {
          planId: brief.analysisPlan.planId,
          status: brief.analysisPlan.status,
          moduleIds: [...(brief.analysisPlan.moduleIds || [])]
        }
      : null
  };
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

export async function createAgentTestSession(env, config, { scenarioId = null, createSession }) {
  assertAgentTestEnabled(config);
  const created = await createSession();
  const meeting = await createAgentMeeting(env, {
    sessionId: created.sessionId,
    config,
    scenarioId
  });
  await recordEvent(env, created.sessionId, 'agent_test_session_created', {
    scenarioId: scenarioId ? String(scenarioId).slice(0, 120) : null,
    cohort: config.cohort,
    channel: AGENT_CHANNEL
  }).catch(() => {});
  return {
    sessionId: created.sessionId,
    credential: created.credential,
    meetingId: meeting.id,
    scenarioId
  };
}

export async function deleteAgentTestSession(env, config, { sessionId, meetingId, deleteSession }) {
  assertAgentTestEnabled(config);
  const turnCount = await countAgentTurns(env, meetingId).catch(() => 0);
  await closeAgentMeeting(env, sessionId, meetingId).catch(() => {});
  await recordEvent(env, sessionId, 'agent_test_session_deleted', { turnCount }).catch(() => {});
  await deleteSession();
  return { ok: true, sessionId, turnCount };
}

/* ------------------------------------------------------------------ */
/* Turns                                                               */
/* ------------------------------------------------------------------ */

function assertMessage(message, config) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw new ConsumerError(400, 'agent_message_required', 'A consumer message is required.');
  if (text.length > config.maxMessageLength) {
    throw new ConsumerError(413, 'agent_message_too_long', 'That consumer message is too long.');
  }
  return redactSensitiveIdentifiers(text);
}

async function assertWithinLimits(env, config, meetingId) {
  const turns = await countAgentTurns(env, meetingId);
  if (turns >= config.agentTestMaxTurns) {
    throw new ConsumerError(429, 'agent_turn_limit_reached', 'This test session has reached its turn limit.');
  }
  const spend = await agentMeetingSpendMicroEur(env, meetingId);
  if (spend >= config.agentTestSessionBudgetMicroEur) {
    throw new ConsumerError(429, 'agent_cost_limit_reached', 'This test session has reached its cost limit.');
  }
  return { turns, spend };
}

/**
 * One consumer text turn, through the shared planning engine.
 *
 * The sequence is deliberately identical to the voice meeting's, minus audio:
 * persist the finalized turn → silent planner extraction → apply candidates →
 * re-derive the deterministic plan → compose and sign the brief → render the
 * assistant's words.
 *
 * `deps` exists so tests can drive the whole path with a scripted planner and
 * renderer, offline. Production uses the real ones.
 */
export async function processAgentTurn(env, config, {
  sessionId,
  meetingId,
  message,
  expectedRevision = null,
  deps = {}
}) {
  assertAgentTestEnabled(config);
  const extractTurn = deps.extractTurn || extractRealtimePlannerTurn;
  const renderText = deps.renderText || renderAssistantText;

  const safeMessage = assertMessage(message, config);
  await assertWithinLimits(env, config, meetingId);

  let context = await loadAgentContext(env, config, sessionId, meetingId);
  // Optimistic concurrency. A test session has exactly one driver, so a
  // mismatch is a bug signal rather than ordinary contention.
  if (expectedRevision !== null
    && Number(expectedRevision) !== Number(context.sessionRow.current_profile_revision)) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The planning state moved on. Refresh and resend.');
  }

  const turnRef = `agent_turn_${randomId('t')}`.slice(0, 160);
  const recorded = await recordRealtimeFinalTurn(env, {
    sessionId,
    leaseId: meetingId,
    providerItemId: turnRef,
    role: 'user',
    transcript: safeMessage
  });
  const turnIndex = await countAgentTurns(env, meetingId);
  await recordEvent(env, sessionId, 'agent_turn_submitted', {
    turnIndex,
    revision: Number(context.sessionRow.current_profile_revision),
    decisionMode: 'utterance',
    channel: AGENT_CHANNEL
  }).catch(() => {});

  const recentTurns = await listRecentRealtimeFinalTurns(env, sessionId, meetingId, 8);
  const before = context;

  let extraction = null;
  let plannerErrorCode = null;
  let degraded = false;
  try {
    const planned = await extractTurn({
      env,
      config,
      context,
      sourceTurnId: turnRef,
      transcript: safeMessage,
      recentTurns
    });
    extraction = planned.extraction;
    await addAgentMeetingSpend(env, meetingId, Number(planned.metadata?.costMicroEur || 0));
  } catch (error) {
    plannerErrorCode = error instanceof ConsumerError ? error.code : 'agent_planner_failed';
    // A planner outage is our problem, not the client's. The voice transport
    // already falls back to the deterministic rules extractor; this path must
    // do the same or the two transports degrade differently — which is exactly
    // the divergence the turn-parity diagnostic caught.
    extraction = deterministicFallbackExtraction({
      transcript: safeMessage,
      profile: context.profile,
      sourceTurnId: turnRef
    });
    degraded = Boolean(extraction);
  }

  let outcomes = [];
  if (extraction) {
    // The same silent-planner attempt row the voice meeting opens, so an agent
    // turn leaves an identical audit trail and fact proposals bind to it.
    const attempt = await beginRealtimeToolAttempt(env, {
      sessionId,
      leaseId: meetingId,
      providerToolCallId: `planner_${turnRef}`.slice(0, 160),
      toolName: 'silent_planner',
      toolVersion: `${config.realtimePlannerPromptVersion}:agent-1`,
      expectedProfileRevision: Number(context.sessionRow.current_profile_revision),
      arguments: { schemaVersion: extraction.schemaVersion, sourceTurnId: turnRef },
      maxToolCalls: config.realtimeMaxToolCalls
    });
    const applied = await applyPlannerCandidates({
      env,
      config,
      context,
      extraction,
      evidenceRef: turnRef,
      leaseId: meetingId,
      toolAttemptId: attempt.row.id,
      loadContext: () => loadAgentContext(env, config, sessionId, meetingId)
    });
    outcomes = applied.outcomes;
    context = applied.context;
    await completeRealtimeToolAttempt(env, {
      sessionId,
      leaseId: meetingId,
      toolAttemptId: attempt.row.id,
      status: 'succeeded',
      result: { ok: true, sourceTurnId: turnRef, outcomes },
      errorCode: null,
      latencyMs: 0
    }).catch(() => {});
  }

  await recordPlanEvaluation({
    env,
    sessionId,
    previousState: before.state,
    nextState: context.state
  });

  const composed = await composeAndPersistBrief({
    env,
    context,
    extraction: extraction || {},
    sourceTurnId: turnRef,
    leaseId: meetingId,
    // Text has no spoken confirmation: the tester or agent confirms through an
    // explicit endpoint, so the brief is never auto-advanced to
    // awaiting_voice_confirmation.
    spokenCompletionEnabled: false
  });
  context = await loadAgentContext(env, config, sessionId, meetingId);

  const rendered = await renderText({
    env,
    config,
    context,
    recentTurns: [...recentTurns, { role: 'user', transcript: safeMessage }],
    reloadContext: () => loadAgentContext(env, config, sessionId, meetingId),
    // Counts only -- never the values. The renderer needs to know whether the
    // answer it is about to respond to was actually captured.
    extractionOutcome: {
      acceptedCount: outcomes.filter((item) => item.accepted === true).length,
      rejectedCount: outcomes.filter((item) => item.accepted === false).length,
      plannerFailed: degraded === true || Boolean(plannerErrorCode)
    }
  });
  await addAgentMeetingSpend(env, meetingId, Number(rendered.usageMicroEur || 0));
  if (rendered.context) context = rendered.context;

  await recordRealtimeFinalTurn(env, {
    sessionId,
    leaseId: meetingId,
    providerItemId: `${turnRef}_assistant`.slice(0, 160),
    role: 'assistant',
    transcript: rendered.text
  }).catch(() => {});

  // A tool call may have moved planning state; re-read so both projections
  // describe the same moment.
  context = await loadAgentContext(env, config, sessionId, meetingId);

  return {
    consumer: toAgentConsumerView({
      assistantText: rendered.text,
      context,
      turnId: recorded.id
    }),
    diagnostics: {
      ...toAgentDiagnosticView(context),
      decisionMode: 'utterance',
      candidateOutcomes: outcomes,
      plannerErrorCode,
      // A degraded turn used the deterministic extractor, not the AI planner.
      // It must never be reported as a normal successful planner turn.
      degraded,
      rendererFallback: rendered.fallback === true,
      rendererErrorCode: rendered.errorCode || null,
      toolCalls: (rendered.decisions || []).map((item) => ({
        tool: item.tool,
        decision: item.args?.decision ?? null,
        ok: item.result?.ok === true,
        errorCode: item.result?.code || null
      }))
    },
    usage: {
      turnIndex,
      spendMicroEur: await agentMeetingSpendMicroEur(env, meetingId)
    }
  };
}

/* ------------------------------------------------------------------ */
/* Action mode — deterministic, explicitly NOT parity-valid            */
/* ------------------------------------------------------------------ */

/**
 * Resolve the active offer directly, without going through the model.
 *
 * This exists so a test can reach a deep state (the three-analysis capacity
 * flow, for instance) without gambling on classifier behaviour four turns
 * earlier. It is NOT a parity path and every response says so.
 *
 * The safety properties are identical to the model route: the SERVER owns which
 * analysis is on the table, and the caller supplies only a decision value.
 */
export async function resolveAgentOffer(env, config, { sessionId, meetingId, decision, expectedRevision = null }) {
  assertAgentTestEnabled(config);
  let context = await loadAgentContext(env, config, sessionId, meetingId);
  if (expectedRevision !== null
    && Number(expectedRevision) !== Number(context.sessionRow.current_profile_revision)) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The planning state moved on. Refresh and resend.');
  }
  const result = await resolveModuleOffer({
    env,
    config,
    context,
    decision: String(decision || ''),
    activeOffer: context.state.meetingBrief?.moduleOffer || null
  });
  context = await refreshBriefAfterDecision(env, config, sessionId, meetingId);
  return {
    decisionMode: 'action',
    parityValid: false,
    result,
    diagnostics: { ...toAgentDiagnosticView(context), decisionMode: 'action' }
  };
}

export async function resolveAgentCapacity(env, config, {
  sessionId, meetingId, decision, replaceChoiceIndex, expectedRevision = null
}) {
  assertAgentTestEnabled(config);
  let context = await loadAgentContext(env, config, sessionId, meetingId);
  if (expectedRevision !== null
    && Number(expectedRevision) !== Number(context.sessionRow.current_profile_revision)) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The planning state moved on. Refresh and resend.');
  }
  const result = await resolveCapacityDecision({
    env,
    config,
    context,
    decision: String(decision || ''),
    replaceChoiceIndex,
    capacity: context.state.meetingBrief?.capacityDecision || null
  });
  context = await refreshBriefAfterDecision(env, config, sessionId, meetingId);
  return {
    decisionMode: 'action',
    parityValid: false,
    result,
    diagnostics: { ...toAgentDiagnosticView(context), decisionMode: 'action' }
  };
}

/**
 * A decision changes the deterministic plan, so the brief that carries the next
 * offer or capacity decision must be recomposed. Voice does this on the next
 * finalized turn; the action endpoints do it immediately so a test can chain
 * decisions without an intervening utterance.
 */
async function refreshBriefAfterDecision(env, config, sessionId, meetingId) {
  const context = await loadAgentContext(env, config, sessionId, meetingId);
  await composeAndPersistBrief({
    env,
    context,
    extraction: {},
    sourceTurnId: `agent_decision_${randomId('d')}`.slice(0, 160),
    leaseId: meetingId,
    spokenCompletionEnabled: false
  });
  return loadAgentContext(env, config, sessionId, meetingId);
}

/**
 * Confirm the final analysis set and run it.
 *
 * Uses the same `confirmPlanSelection` the voice meeting uses, so the confirmed
 * set is recorded identically and only that set may execute.
 */
export async function confirmAgentPlan(env, config, { sessionId, meetingId, expectedRevision = null }) {
  assertAgentTestEnabled(config);
  const context = await loadAgentContext(env, config, sessionId, meetingId);
  if (expectedRevision !== null
    && Number(expectedRevision) !== Number(context.sessionRow.current_profile_revision)) {
    throw new ConsumerError(409, 'profile_revision_conflict', 'The planning state moved on. Refresh and resend.');
  }
  const prepared = await prepareRealtimeVoiceAnalysisPlan({
    env,
    config,
    sessionRow: context.sessionRow,
    profile: context.profile,
    leaseId: meetingId,
    idempotencyKey: `agent-confirm:${meetingId}:${context.sessionRow.current_profile_revision}`
  });
  await confirmPlanSelection({
    env,
    config,
    sessionRow: context.sessionRow,
    profile: context.profile,
    channel: AGENT_CHANNEL
  });
  await setRealtimeMeetingPhase(env, {
    sessionId,
    leaseId: meetingId,
    phase: 'generating_modules',
    planId: prepared.publicPlan.planId,
    profileRevision: prepared.publicPlan.profileRevision,
    navigationTarget: '/plan/#results'
  }).catch(() => {});

  const executed = await confirmAndRunRealtimeAnalysisPlan({
    env,
    config,
    sessionId,
    planId: prepared.publicPlan.planId,
    planNonce: prepared.planNonce,
    expectedRevision: Number(context.sessionRow.current_profile_revision)
  });
  const after = await loadAgentContext(env, config, sessionId, meetingId);
  return {
    decisionMode: 'action',
    parityValid: false,
    execution: {
      planId: executed.analysisPlan.planId,
      status: executed.analysisPlan.status,
      moduleIds: [...(executed.analysisPlan.moduleIds || [])],
      completedModuleIds: [...(executed.result?.completedModuleIds || [])],
      gatedModuleIds: [...(executed.result?.gatedModuleIds || [])],
      // What the analyses still needed, when they could not run. The voice path
      // has always returned this; the agent transport dropped it, which left a
      // tester with "needs_information" and no way to see what was missing.
      // That is the most actionable result a test call can produce: the meeting
      // promised an analysis it had not gathered enough to deliver.
      requiredQuestions: (executed.requiredQuestions || []).slice(0, 20).map((question) => ({
        factId: question.factId ?? null,
        fieldPath: question.fieldPath ?? null,
        moduleIds: [...(question.blockingModuleIds || [])],
        reason: typeof question.reason === 'string' ? question.reason.slice(0, 240) : ''
      })),
      analysisRunId: executed.analysis?.id ?? null
    },
    consumer: {
      revision: Number(after.sessionRow.current_profile_revision),
      phase: 'results',
      assistantMessage: executed.result?.speakableText || ''
    },
    diagnostics: { ...toAgentDiagnosticView(after), decisionMode: 'action' }
  };
}

/* ------------------------------------------------------------------ */
/* State and export                                                    */
/* ------------------------------------------------------------------ */

export async function getAgentSessionState(env, config, { sessionId, meetingId }) {
  assertAgentTestEnabled(config);
  const context = await loadAgentContext(env, config, sessionId, meetingId);
  return {
    sessionId,
    meetingId,
    diagnostics: toAgentDiagnosticView(context),
    usage: {
      turnCount: await countAgentTurns(env, meetingId),
      spendMicroEur: await agentMeetingSpendMicroEur(env, meetingId),
      limits: {
        maxTurns: config.agentTestMaxTurns,
        maxMessageLength: config.maxMessageLength,
        sessionBudgetMicroEur: config.agentTestSessionBudgetMicroEur
      }
    }
  };
}

export async function exportAgentSession(env, config, { sessionId, meetingId }) {
  assertAgentTestEnabled(config);
  const context = await loadAgentContext(env, config, sessionId, meetingId);
  const turns = await listRealtimeFinalTurns(env, sessionId, meetingId, 400);
  return {
    sessionId,
    meetingId,
    channel: AGENT_CHANNEL,
    cohort: config.cohort,
    versions: {
      selectionPolicyVersion: context.state.selectionPolicyVersion,
      plannerPromptVersion: config.realtimePlannerPromptVersion,
      moduleOffersEnabled: config.moduleOffersEnabled === true
    },
    transcript: turns.map((turn) => ({
      role: turn.role,
      text: turn.transcript
    })),
    diagnostics: toAgentDiagnosticView(context),
    exportedAt: new Date().toISOString()
  };
}

export { getActiveAgentMeeting };
