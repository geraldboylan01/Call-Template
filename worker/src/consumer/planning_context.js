/**
 * Transport-independent planning context.
 *
 * `planningContext()` in the Realtime Durable Object used to do two unrelated
 * jobs at once: assert live-voice consent and fetch a live-voice lease, and
 * shape the deterministic planning state every transport needs. Only the first
 * is about voice. This module owns the second, so a text/agent meeting can build
 * exactly the same state without a microphone, a lease or realtime consent.
 *
 * Everything here was moved verbatim out of realtime_session.js. The voice
 * transport keeps its consent and lease checks and passes the results in.
 */

import { toPublicGoalAssessment } from '../../../js/planning/goal_plan.js';
import {
  consumerLanguageForModule,
  containsInternalModuleTerminology
} from '../../../js/planning/module_offers.js';
import { assumptionLabel } from '../../../js/planning/planeir_assumptions.js';
import {
  completionResponseFor,
  resolveSemanticFact
} from '../../../js/planning/semantic_facts.js';
import { describeConversationState } from './conversation.js';
import { buildConfirmedRealtimeFactSummary, buildRealtimeFactReadBack } from './realtime_fact_mapper.js';
import { toConsumerMeetingBrief, toConversationGuide } from './realtime_planner.js';
import { realtimeJourneyPhase } from './realtime_provider.js';

/** Meeting phases that must not be rolled back by a later state refresh. */
export const TERMINAL_MEETING_PHASES = Object.freeze([
  'awaiting_voice_confirmation', 'generating_modules', 'closing', 'completed',
  'analysis', 'results'
]);

/**
 * D15 — THE TWO EXECUTION-SET RULES.
 *
 * These had been conflated, because two filters both looked like "which modules
 * run" and one was an un-updated copy of the other. They are answers to two
 * genuinely different questions, now named so neither can drift again. See
 * docs/agent-testing-parity-contract.md §4.
 *
 * Question 1 — which analyses do we READ OUT for the client to confirm?
 *   Every runnable slot, INCLUDING one just accepted from an offer. Excluding an
 *   accepted offer here would read back a list omitting the very analysis the
 *   client asked for a turn earlier.
 *
 * Question 2 — which analyses MAY EXECUTE?
 *   Only the set the client confirmed. `buildGoalModulePlan` expresses this as
 *   `executionModuleIds`, requiring `selectionState === 'selected'`.
 *
 * REGISTERED DIVERGENCE D-01: the link between them — writing `confirmedModuleIds`
 * at final confirmation — has never been implemented, so `executionModuleIds` is
 * currently dead in the voice path and Question 1's answer decides execution.
 * Correcting that is a live behaviour change, staged separately from the
 * mechanical extraction.
 */

/** Question 1: the candidate set offered to the client for confirmation. */
export function resolveConfirmationCandidateModuleIds(planningState, config) {
  return (planningState.moduleSlots || [])
    .filter((slot) => ['ready', 'needs_facts'].includes(slot.availability))
    .map((slot) => slot.moduleId)
    .filter((moduleId) => config.allowedModules.includes(moduleId));
}

/** Question 2: the set that may actually run. Confirmed selections only. */
export function resolveExecutionModuleIds(plan) {
  return [...(plan?.executionModuleIds || [])];
}

function safeConsumerPlanningText(value, maximumLength = 240) {
  const text = typeof value === 'string' ? value.trim().slice(0, maximumLength) : '';
  return text && !containsInternalModuleTerminology(text) ? text : '';
}

/**
 * Reduce deterministic internal routing state to the controlled fields that
 * may cross the consumer boundary. Exact approved module ids remain available
 * for protocol identity, while hidden catalogue entries and catalogue-authored
 * prose fail closed.
 */
export function toConsumerRealtimePlanningLists(state = {}, profile = {}) {
  const visibleSlots = (state.moduleSlots || [])
    .filter((slot) => Boolean(consumerLanguageForModule(slot?.moduleId, { profile })))
    .slice(0, 3)
    .map((slot) => {
      const language = consumerLanguageForModule(slot.moduleId, { profile });
      return {
        slot: Number.isSafeInteger(Number(slot.slot)) ? Number(slot.slot) : null,
        moduleId: slot.moduleId,
        description: language.shortDescription,
        availability: typeof slot.availability === 'string' ? slot.availability : 'unknown',
        intakeStatus: typeof slot.intakeStatus === 'string' ? slot.intakeStatus : 'unknown',
        selectionState: typeof slot.selectionState === 'string' ? slot.selectionState : 'selected',
        relatedGoalTypes: Array.isArray(slot.relatedGoalTypes)
          ? slot.relatedGoalTypes.filter((value) => typeof value === 'string').slice(0, 8)
          : [],
        blockingFactIds: Array.isArray(slot.blockingFactIds)
          ? slot.blockingFactIds.filter((value) => typeof value === 'string').slice(0, 12)
          : []
      };
    });

  const visibleRecommendations = (state.recommendations || [])
    .filter((item) => Boolean(consumerLanguageForModule(item?.moduleId, { profile })))
    .slice(0, 12);

  return Object.freeze({
    moduleSlots: Object.freeze(visibleSlots),
    likelyModules: Object.freeze(visibleSlots.map((slot) => slot.moduleId)),
    recommendations: Object.freeze(visibleRecommendations.map((item) => {
      const language = consumerLanguageForModule(item.moduleId, { profile });
      return Object.freeze({
        moduleId: item.moduleId,
        description: language.shortDescription,
        status: item.readiness?.status || item.status || 'unknown',
        availability: item.availability || 'unknown',
        assumptionsUsed: Object.freeze((item.readiness?.assumptionsUsed || item.assumptionsUsed || [])
          .slice(0, 8)
          .map((assumption) => Object.freeze({
            key: typeof assumption.key === 'string' ? assumption.key.slice(0, 100) : '',
            // The plain name comes from the ENGINE assumption registry. It used
            // to be looked up in the semantic fact registry by whoever consumed
            // this, which never matches — those are snake_case fact ids and
            // these are camelCase engine keys — so every optional input arrived
            // nameless and got filtered out downstream.
            label: safeConsumerPlanningText(assumptionLabel(assumption.key), 80),
            value: assumption.value,
            reason: safeConsumerPlanningText(assumption.reason)
          }))),
        requiredMissing: Object.freeze((item.readiness?.requiredMissing || item.requiredMissing || [])
          .slice(0, 20)
          .map((missing) => {
            const semantic = resolveSemanticFact(missing, { profile, moduleId: item.moduleId });
            const response = completionResponseFor(profile, {
              ...missing,
              factId: semantic.factId,
              factInstanceId: semantic.factInstanceId,
              entityId: semantic.entityId
            }, { moduleId: item.moduleId });
            const status = response?.resolution === 'unknown'
              ? 'estimate_requested'
              : response?.resolution === 'estimate_declined'
                ? 'blocked_unknown'
                : ['complete', 'confirmed_none', 'answered_range'].includes(response?.resolution)
                  ? 'satisfied'
                  : 'open';
            return Object.freeze({
              factId: semantic.factId,
              factInstanceId: semantic.factInstanceId,
              // WHOSE requirement this is. Without it a consumer projection can
              // only compare bare fact ids, so a pension value captured for the
              // client silently satisfies the partner's missing pension value —
              // or, worse, renders as captured AND still needed at once.
              entityId: semantic.entityId || null,
              entityLabel: safeConsumerPlanningText(semantic.entityLabel, 60),
              ownerId: semantic.ownerId || null,
              prompt: safeConsumerPlanningText(semantic.questionPrompt, 220),
              status,
              answerPolicy: ['value', 'value_or_none', 'unknown_allowed'].includes(missing.answerPolicy)
                ? missing.answerPolicy
                : 'unknown_allowed',
              reasonCode: typeof missing.reasonCode === 'string'
                ? missing.reasonCode.slice(0, 80)
                : 'required_input_missing',
              importance: missing.importance,
              reason: safeConsumerPlanningText(missing.reason)
            });
          }))
      });
    })),
    deferredOrAdviserTopics: Object.freeze(visibleRecommendations
      .filter((item) => (
        ['adviser_review_required', 'unsupported'].includes(item.readiness?.status || item.status)
      ))
      .slice(0, 8)
      .map((item) => {
        const language = consumerLanguageForModule(item.moduleId, { profile });
        const status = item.readiness?.status || item.status;
        return Object.freeze({
          moduleId: item.moduleId,
          description: language.shortDescription,
          status,
          reason: status === 'adviser_review_required'
            ? 'This outcome needs Gerry’s review before it can be completed.'
            : 'This outcome is not available for automated analysis in the current test.'
        });
      }))
  });
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

/**
 * The transport-independent planning state slice.
 *
 * This is the exact object `composeMeetingBrief`, the Realtime session policy
 * and the agent transport all read. Building it in one place is what stops an
 * offline harness from hand-copying the Durable Object's reshaping and then
 * drifting out of date.
 *
 * Voice supplies `pendingFacts`, `meetingPhase`, `storedMeetingBrief` and
 * `retainedTerminalPhase` from its lease. A text meeting passes the defaults.
 */
export function buildPlanningStateSlice({
  state,
  profile,
  sessionRow,
  config = {},
  pendingFacts = [],
  meetingPhase = null,
  latestMeetingBrief = null,
  retainedTerminalPhase = null,
  channel = 'voice'
}) {
  const conversationV2 = config.realtimeConversationV2Enabled === true;
  // `meetingPhase` is the caller's already-resolved persisted phase (voice: the
  // lease phase, else the stored brief's phase). The fallback chain below is
  // identical to the one the Durable Object has always applied.
  const realtimePhase = conversationV2
    ? (meetingPhase || retainedTerminalPhase || 'discovery')
    : (pendingFacts.length
      ? 'confirmation'
      : retainedTerminalPhase || realtimeJourneyPhase({ stage: state.stage }));
  const consumerPlanningLists = toConsumerRealtimePlanningLists(state, profile);
  const consumerMeetingBrief = conversationV2
    ? toConsumerMeetingBrief(latestMeetingBrief, { profile })
    : null;
  return {
    channel,
    profileRevision: Number(sessionRow.current_profile_revision),
    confirmedProfileRevision: sessionRow.confirmed_profile_revision === null
      || sessionRow.confirmed_profile_revision === undefined
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
    selectionPolicyVersion: state.selectionPolicyVersion || null,
    goalAssessment: toPublicGoalAssessment(state.goalAssessment),
    moduleSlots: consumerPlanningLists.moduleSlots,
    requiresGoalPriorityQuestion: state.requiresGoalPriorityQuestion === true,
    requiresDecisionTopicQuestion: state.requiresDecisionTopicQuestion === true,
    deferredGoalTypes: (state.deferredGoalTypes || []).slice(0, 8),
    likelyModules: consumerPlanningLists.likelyModules,
    recommendations: consumerPlanningLists.recommendations,
    deferredOrAdviserTopics: consumerPlanningLists.deferredOrAdviserTopics,
    // The deterministic inputs the offer and three-analysis capacity flows bind
    // to. Every transport receives these, unconditionally and identically —
    // whether an offer is then PRESENTED is a single shared rollout decision
    // made in composeMeetingBrief, not a difference in state shape. (D-02: the
    // voice path used to drop both fields here, which silently disabled both
    // flows end to end.)
    //
    // Consumer-visible opportunities only. `withheldOpportunities` is NEVER
    // carried here: a consumer must not learn a hidden analysis exists.
    moduleOpportunities: state.moduleOpportunities || [],
    capacity: state.capacity,
    reasoningEscalation: complexJourney(profile, state),
    conversationVersion: conversationV2 ? 'v2' : 'v1',
    spokenCompletionEnabled: config.realtimeSpokenCompletionEnabled === true,
    meetingBrief: consumerMeetingBrief,
    conversationGuide: conversationV2
      ? toConversationGuide(consumerMeetingBrief, { profile })
      : null
  };
}

/**
 * Build the full planning context for a turn.
 *
 * Consent and lease checks are the CALLER's responsibility — voice performs
 * them, a protected text/agent transport performs its own authorisation. This
 * function assumes it has already been given an authorised session.
 */
export function buildPlanningContext({
  config,
  sessionRow,
  profile,
  pendingProposals = [],
  meetingPhase = null,
  latestMeetingBrief = null,
  retainedTerminalPhase = null,
  channel = 'voice'
}) {
  const state = describeConversationState(profile, config);
  const pendingFacts = pendingProposals.map((proposal) => ({
    ...proposal,
    readBackText: buildRealtimeFactReadBack(
      proposal.factId,
      proposal.value,
      proposal.certainty,
      profile.preferences?.baseCurrency || 'EUR'
    )
  }));
  return {
    config,
    sessionRow,
    profile,
    state: buildPlanningStateSlice({
      state,
      profile,
      sessionRow,
      config,
      pendingFacts,
      meetingPhase,
      latestMeetingBrief,
      retainedTerminalPhase,
      channel
    })
  };
}
