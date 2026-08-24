/**
 * The shared consumer planning turn.
 *
 * One finalized consumer statement — spoken or typed — becomes: extracted
 * candidates, validated profile changes, a re-derived deterministic plan, and a
 * freshly signed meeting brief. None of that depends on how the words arrived.
 *
 * This module is the single implementation. The Realtime Durable Object calls
 * it after transcription; a protected text/agent transport calls it after an
 * HTTP turn. Neither owns a second copy of the routing, question or offer
 * logic.
 *
 * Transport concerns the caller still owns:
 *   voice — audio metering, VAD/turn segmentation, barge-in recovery, the
 *           provider session policy, speech authorisation, hang-up
 *   text   — HTTP authorisation, quotas, and rendering the assistant's words
 */

import { hmacSha256Base64Url, stableStringify } from './crypto.js';
import { resolveSemanticFact } from '../../../js/planning/semantic_facts.js';
import {
  boundedUncoveredValueEvidence,
  groundPlannerExtraction,
  valueEvidenceCoverage
} from '../../../js/planning/value_evidence.js';
import { ConsumerError } from './errors.js';
import { confirmProfileRevision, recordEvent } from './repository.js';
import { resolveConfirmationCandidateModuleIds } from './planning_context.js';
import {
  bindCandidateToAskedEntity,
  mapPlannerExtractionToCandidates,
  planFactProposal
} from './planning_facts.js';
import { prepareRealtimeVoiceAnalysisPlan } from './realtime_analysis.js';
import { buildVoiceConfirmationSummary } from './realtime_completion.js';
import { composeMeetingBrief } from './realtime_planner.js';
import {
  commitRealtimeFactConfirmation,
  createRealtimeFactProposal,
  recordRealtimeCapacityDecision,
  recordRealtimeModuleDecision,
  saveRealtimeMeetingBrief,
  setRealtimeMeetingPhase
} from './realtime_repository.js';
import { describeConversationState } from './conversation.js';

const POSITION_FACT_IDS = new Set([
  'asset_position', 'property_position', 'pension_positions',
  'liability_position', 'mortgage_position', 'loan_position',
  'business_position', 'income_sources', 'dependants'
]);

const POSITION_NOTE_PROJECTIONS = Object.freeze({
  asset_position: { collection: 'assets', idKey: 'assetId' },
  property_position: { collection: 'properties', idKey: 'propertyId' },
  pension_positions: { collection: 'pensions', idKey: 'pensionId' },
  liability_position: { collection: 'liabilities', idKey: 'liabilityId' },
  mortgage_position: { collection: 'liabilities', idKey: 'liabilityId' },
  loan_position: { collection: 'liabilities', idKey: 'liabilityId' },
  business_position: { collection: 'businesses', idKey: 'businessId' },
  income_sources: { collection: 'incomeSources', idKey: 'incomeId' },
  dependants: { collection: 'dependants', idKey: 'dependantId' }
});

function ownerForFact(profile, fact, resolved) {
  const explicitOwnerId = fact?.value?.ownerId;
  if (typeof explicitOwnerId === 'string' && explicitOwnerId) return explicitOwnerId;
  const owner = fact?.value?.owner;
  if (owner === 'primary') return profile?.primaryPerson?.personId || null;
  if (owner === 'partner') return profile?.partner?.personId || null;
  if (owner === 'joint' || owner === 'household') return 'household';
  if (resolved?.entityId === profile?.primaryPerson?.personId) return resolved.entityId;
  if (resolved?.entityId === profile?.partner?.personId) return resolved.entityId;
  for (const collection of [
    profile?.pensions,
    profile?.assets,
    profile?.properties,
    profile?.liabilities,
    profile?.incomeSources,
    profile?.businesses
  ]) {
    const record = (collection || []).find((item) => (
      item && Object.entries(item).some(([key, value]) => key.endsWith('Id') && value === resolved?.entityId)
    ));
    if (typeof record?.ownerId === 'string' && record.ownerId) return record.ownerId;
  }
  return null;
}

function canonicalOwnerId(profile, record, fallback = null) {
  if (typeof record?.ownerId === 'string' && record.ownerId) return record.ownerId;
  const ownerIds = Array.isArray(record?.ownerIds) ? record.ownerIds.filter(Boolean) : [];
  if (ownerIds.length === 1) return ownerIds[0];
  if (ownerIds.length > 1) return 'household';
  return fallback || null;
}

function confirmsNone(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.operation === 'confirm_none') return true;
  return Array.isArray(value.items)
    && value.items.length > 0
    && value.items.every((item) => confirmsNone(item));
}

function changedCanonicalPositions(previousProfile, profile, projection) {
  const before = new Map((previousProfile?.[projection.collection] || [])
    .filter((record) => record?.[projection.idKey])
    .map((record) => [record[projection.idKey], stableStringify(record)]));
  return (profile?.[projection.collection] || []).filter((record) => {
    const entityId = record?.[projection.idKey];
    return entityId && before.get(entityId) !== stableStringify(record);
  });
}

export function buildProvisionalPlanningNotes({ previousProfile, profile, fact, mapped }) {
  const resolved = resolveSemanticFact({
    factId: fact.factId,
    fieldPath: mapped?.fieldPath || '',
    entityId: fact?.value?.entityId || null
  }, { profile });
  const projection = POSITION_NOTE_PROJECTIONS[fact.factId];
  const rawEntityId = fact?.value?.entityId || null;
  const explicitNone = confirmsNone(fact.value);
  const rangeValue = mapped?.derivedFromRange || null;
  if (fact.certainty === 'unknown' || explicitNone || rangeValue) {
    return [{
      noteKind: 'completion',
      factId: fact.factId,
      factInstanceId: resolved.factInstanceId,
      entityId: resolved.entityId,
      ownerId: ownerForFact(profile, fact, resolved),
      value: explicitNone ? { resolution: 'confirmed_none' }
        : rangeValue || { resolution: 'unknown' },
      certainty: explicitNone ? 'none' : rangeValue ? 'range' : 'unknown',
      lifecycle: 'active',
      reviewStatus: 'provisional',
      source: 'realtime_note',
      evidenceRefs: [],
      replacesNoteIds: [],
      reviewedAt: null
    }];
  }

  let canonicalPositions = projection
    ? changedCanonicalPositions(previousProfile, profile, projection)
    : [];
  if (projection && canonicalPositions.length === 0) {
    canonicalPositions = (profile?.[projection.collection] || []).filter((record) => (
      record?.[projection.idKey] === resolved.entityId
      || (rawEntityId && String(record?.[projection.idKey] || '').endsWith(`_${rawEntityId}`))
      || (fact?.value?.label && record?.label === fact.value.label)
    ));
  }
  if (projection && canonicalPositions.length > 0) {
    return canonicalPositions.map((canonicalPosition) => {
      const entityId = canonicalPosition[projection.idKey];
      return {
        noteKind: 'position',
        factId: fact.factId,
        factInstanceId: `${fact.factId}:${entityId}`,
        entityId,
        ownerId: canonicalOwnerId(
          profile,
          canonicalPosition,
          ownerForFact(profile, fact, { ...resolved, entityId })
        ),
        value: canonicalPosition,
        certainty: mapped?.certainty || fact.certainty,
        lifecycle: 'active',
        reviewStatus: 'provisional',
        source: 'realtime_note',
        evidenceRefs: [],
        replacesNoteIds: [],
        reviewedAt: null
      };
    });
  }

  const entityId = resolved.entityId;
  const resolvedIdentity = {
    ...resolved,
    entityId,
    factInstanceId: entityId ? `${fact.factId}:${entityId}` : resolved.factInstanceId
  };
  return [{
    // If a collection mapper could not bind one stable canonical record, keep
    // the semantic write in the ledger but do not pretend it is projectable.
    noteKind: 'fact',
    factId: fact.factId,
    factInstanceId: resolvedIdentity.factInstanceId,
    entityId: resolvedIdentity.entityId,
    ownerId: ownerForFact(profile, fact, resolvedIdentity),
    value: fact.value,
    certainty: mapped?.certainty || fact.certainty,
    lifecycle: 'active',
    reviewStatus: 'provisional',
    source: 'realtime_note',
    // T1 knows which finalized turn caused the write but not a server-verified
    // exact span yet. Keep the provisional note span-free; T2 may only correct
    // or replace it after exact quote verification against that stored turn.
    evidenceRefs: [],
    replacesNoteIds: [],
    reviewedAt: null
  }];
}

// The D15 execution rules live in planning_context.js (they are derivations of
// planning state, and keeping them there avoids an import cycle with the
// analysis layer). Re-exported here because this is where callers look.
export {
  resolveConfirmationCandidateModuleIds,
  resolveExecutionModuleIds
} from './planning_context.js';

/**
 * Apply one validated planner extraction to the profile.
 *
 * Each candidate is proposed independently against a freshly reloaded profile,
 * exactly as the Realtime tool loop has always done, so one bad candidate
 * cannot discard the rest of a good turn.
 *
 * @param {object} deps.loadContext  reload {sessionRow, profile, state} after each write
 * @param {object} deps.persistence  {leaseId, toolAttemptId, evidenceRef} or null for a
 *                                   transport that does not keep fact proposals
 */
/**
 * Which refusals a second, narrow planner pass could plausibly fix.
 *
 * Deliberately a closed list. A repair costs a planner call and the client's
 * patience, so it must only run where the FIRST pass produced something the
 * engine understood but could not use -- a value that would not parse, or one
 * that did not say which position it belonged to. A refusal that reflects a
 * settled rule is not a parsing problem and will refuse again.
 */
const REPAIRABLE_REJECTIONS = Object.freeze({
  realtime_pension_review_required: 'pension_ambiguous',
  realtime_planner_candidate_money_invalid: 'money_invalid',
  realtime_planner_candidate_invalid: 'value_invalid',
  realtime_planner_output_invalid: 'value_invalid',
  realtime_planner_candidate_evidence_unsupported: 'evidence_unsupported'
});

/**
 * The repair request for a turn, or null when nothing is worth re-reading.
 *
 * WHY A SECOND PASS AND NOT A BIGGER FIRST ONE. Extraction fails on dense turns:
 * a client who names two pensions and both contribution rates in one breath has
 * said something perfectly clear that the engine cannot place, because "30%"
 * does not say which pension. Asking the planner to try harder on every turn
 * would slow down the many turns that already work. Asking it once, narrowly,
 * about the specific items that failed costs nothing on a clean turn.
 *
 * Observed: the client stated both rates, they were refused as ambiguous, and
 * the identical restatement one turn later was accepted -- because by then the
 * meeting had asked about one pension and the answer bound to it. The
 * information was always there. Only the linkage was missing.
 */
/**
 * What a refused candidate is waiting for, in words the meeting can ask for.
 *
 * Some refusals are not "we could not read that" but "we cannot use that yet".
 * A client saying their partner pays the maximum has given a complete answer,
 * and the server can turn it into a percentage -- but only once it knows the
 * partner's age. Refusing without saying so left the meeting to move on and the
 * contribution was simply never recorded.
 */
const BLOCKED_ON = Object.freeze({
  realtime_pension_max_age_required: "the age of the person whose pension it is, because the maximum "
    + 'contribution depends on their age'
});

export function blockedOnFromOutcomes(outcomes = []) {
  for (const outcome of outcomes) {
    if (outcome?.accepted === true) continue;
    const need = BLOCKED_ON[outcome?.errorCode];
    if (need) return need;
  }
  return null;
}

export function buildRepairRequest(outcomes = [], coverage = null) {
  const repairableFailures = outcomes
    .filter((outcome) => outcome.accepted !== true)
    .map((outcome) => {
      const reason = REPAIRABLE_REJECTIONS[outcome.errorCode];
      return reason
        ? { candidateId: outcome.candidateId || null, factId: outcome.factId || null, reason }
        : null;
    })
    .filter(Boolean);
  const failedItems = repairableFailures.slice(0, 8);
  const bounded = boundedUncoveredValueEvidence(coverage, {
    // One repair request has one eight-item budget. A full refusal batch must
    // not acquire a ninth item through the omission path.
    limit: Math.max(0, 8 - failedItems.length)
  });
  const uncoveredEvidence = bounded.items;
  if (failedItems.length === 0 && uncoveredEvidence.length === 0) return null;
  const failedCandidateIds = new Set(failedItems.map((item) => item.candidateId).filter(Boolean));
  const allowedEvidenceIds = [...new Set([
    ...uncoveredEvidence.map((item) => item.evidenceId),
    ...((coverage?.covered || [])
      .filter((item) => failedCandidateIds.has(item.candidateId))
      .map((item) => item.evidenceId))
  ])];
  return {
    instruction: 'Re-read the same finalized client turn once. Review ONLY the refused candidates and '
      + 'occurrence-addressed uncovered evidence listed here. Classify an uncovered occurrence from its '
      + 'exact context; it is not automatically a holding. Emit only canonical candidates supported by '
      + 'that turn, with exact evidence. Emit nothing else and never invent or calculate a value.',
    failedItems,
    uncoveredEvidence,
    allowedEvidenceIds,
    overflowCount: Math.max(0, repairableFailures.length - failedItems.length)
      + bounded.overflowCount
  };
}

/**
 * Fold a repair pass's results into the first pass's outcomes.
 *
 * A value recovered on the second pass must read as RECORDED, not as a
 * rejection that happened to be retried -- otherwise the renderer apologises
 * for something the client can see was understood.
 */
export function mergeRepairOutcomes(original = [], repaired = []) {
  const acceptedRepairs = repaired.filter((item) => item.accepted === true);
  const recoveredOriginalIndexes = new Set();
  const recoveredCandidateIds = new Map();
  const originalFailures = original
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.accepted !== true);
  for (const repair of acceptedRepairs) {
    // Extraction schemas number each pass from one, so a repair's position-1
    // can collide with an ACCEPTED position-1 from the first pass while really
    // recovering failed position-2. Candidate identity is authoritative only
    // when it names an outstanding failure of the same fact (or one side lacks
    // a fact id, as malformed money candidates often do).
    let recovered = originalFailures.find(({ item, index }) => (
      !recoveredOriginalIndexes.has(index)
      && repair.candidateId
      && item.candidateId === repair.candidateId
      && (!repair.factId || !item.factId || repair.factId === item.factId)
    ));
    if (!recovered && repair.factId) {
      // Fact-id fallback is a consumed multiset, not a Set. One accepted repair
      // removes one failed same-fact sibling and no more.
      recovered = originalFailures.find(({ item, index }) => (
        !recoveredOriginalIndexes.has(index) && item.factId === repair.factId
      ));
    }
    if (recovered) {
      recoveredOriginalIndexes.add(recovered.index);
      // Preserve first-pass identity in the merged audit/result. A repair pass
      // restarts schema numbering at one, so leaving its regenerated id intact
      // can create two accepted position-1 outcomes and no position-2.
      if (recovered.item.candidateId) {
        recoveredCandidateIds.set(repair, recovered.item.candidateId);
      }
    }
  }
  const stillFailing = original.filter((_item, index) => !recoveredOriginalIndexes.has(index));
  const usedCandidateIds = new Set(stillFailing.map((item) => item.candidateId).filter(Boolean));
  const normalizedRepairs = repaired.map((item) => {
    const recoveredId = recoveredCandidateIds.get(item);
    let candidateId = recoveredId || item.candidateId;
    if (candidateId && usedCandidateIds.has(candidateId)) {
      const base = `${candidateId}-repair`;
      candidateId = base;
      let suffix = 2;
      while (usedCandidateIds.has(candidateId)) {
        candidateId = `${base}-${suffix}`;
        suffix += 1;
      }
    }
    if (candidateId) usedCandidateIds.add(candidateId);
    return candidateId && candidateId !== item.candidateId ? { ...item, candidateId } : item;
  });
  return [...stillFailing, ...normalizedRepairs];
}

export async function applyPlannerCandidates({
  env,
  config,
  context,
  extraction,
  transcript = null,
  allowedEvidenceIds = null,
  evidenceRef,
  leaseId = null,
  toolAttemptId = null,
  loadContext
}) {
  const groundedExtraction = transcript === null
    ? extraction
    : groundPlannerExtraction(extraction, transcript, { allowedEvidenceIds });
  const candidates = mapPlannerExtractionToCandidates(groundedExtraction);
  const outcomes = (groundedExtraction.invalidCandidates || []).map((item) => ({
    candidateId: item.candidateId,
    // The planner knows which fact it was trying to write even when the value
    // will not parse. Reporting null made every such rejection anonymous.
    factId: item.factId ?? null,
    accepted: false,
    errorCode: item.errorCode
  }));

  let current = context;
  for (const rawCandidate of candidates) {
    // An answer inherits the identity of whatever the meeting just asked about,
    // so "thirty percent" lands on the pension the question named.
    const candidate = bindCandidateToAskedEntity(rawCandidate, current.state, current.profile);
    const fact = {
      factId: candidate.factId,
      value: candidate.value,
      certainty: candidate.certainty,
      evidenceText: candidate.evidenceText || ''
    };
    try {
      const proposed = planFactProposal({
        config,
        profile: current.profile,
        state: current.state,
        fact,
        plannerBatch: true
      });
      const committed = await commitFactProposal({
        env,
        config,
        sessionRow: current.sessionRow,
        profile: current.profile,
        nextProfile: proposed.profile,
        fact,
        mapped: proposed.mapped,
        patch: proposed.patch,
        confirmationPolicy: proposed.confirmationPolicy,
        displayValue: proposed.displayValue,
        evidenceRef,
        leaseId,
        toolAttemptId
      });
      outcomes.push({
        candidateId: candidate.candidateId,
        factId: candidate.factId,
        accepted: true,
        profileRevision: committed.revision
      });
      current = await loadContext();
    } catch (error) {
      outcomes.push({
        candidateId: candidate.candidateId,
        factId: candidate.factId,
        accepted: false,
        errorCode: error instanceof ConsumerError ? error.code : 'realtime_planner_candidate_invalid'
      });
    }
  }
  const acceptedCandidateIds = new Set(
    outcomes.filter((item) => item.accepted === true && item.candidateId)
      .map((item) => item.candidateId)
  );
  const sourcedValueEvidence = transcript === null ? [] : valueEvidenceCoverage(
    transcript,
    groundedExtraction
  ).covered
    .filter((item) => acceptedCandidateIds.has(item.candidateId))
    .map((item) => ({ evidenceId: item.evidenceId, candidateId: item.candidateId }));
  return {
    context: current,
    outcomes,
    candidateCount: candidates.length,
    sourcedValueEvidence
  };
}

/**
 * Persist one accepted fact: a reviewable proposal row, then the revisioned
 * profile commit. The spoken read-back is retired: every fact saves as a
 * reviewable draft immediately and the authenticated visual confirmation is the
 * only gate.
 */
async function commitFactProposal({
  env,
  config,
  sessionRow,
  profile,
  nextProfile,
  fact,
  mapped,
  displayValue,
  patch,
  confirmationPolicy,
  evidenceRef,
  leaseId,
  toolAttemptId
}) {
  const created = await createRealtimeFactProposal(env, {
    sessionId: sessionRow.id,
    leaseId,
    toolAttemptId,
    factId: fact.factId,
    value: displayValue,
    readBackText: null,
    patch,
    baseProfileRevision: Number(sessionRow.current_profile_revision),
    evidenceItemId: evidenceRef,
    confidence: fact.certainty === 'exact' ? 'medium' : 'low',
    certainty: fact.certainty
  });

  const nextState = describeConversationState(nextProfile, config);
  const committed = await commitRealtimeFactConfirmation(env, {
    sessionId: sessionRow.id,
    leaseId,
    proposalId: created.id,
    confirmationEvidenceItemId: evidenceRef,
    sessionRow,
    profile: nextProfile,
    stage: nextState.stage,
    planningNotes: buildProvisionalPlanningNotes({
      previousProfile: profile,
      profile: nextProfile,
      fact,
      mapped
    })
  });
  return { revision: committed.revision, proposal: created, pending: false };
}

/**
 * Compose, sign and persist the meeting brief for the current planning state,
 * preparing the analysis plan when the set is ready to confirm.
 */
export async function composeAndPersistBrief({
  env,
  context,
  extraction,
  sourceTurnId,
  leaseId = null,
  spokenCompletionEnabled = null,
  // Optional staleness guard. Composition can take long enough for a newer
  // consumer turn to arrive; when it has, this brief must not go on to prepare
  // an analysis plan or become the active brief.
  isStale = () => false
}) {
  const config = context.config;
  const completionEnabled = spokenCompletionEnabled === null
    ? config.realtimeSpokenCompletionEnabled === true
    : spokenCompletionEnabled;
  let brief = await composeMeetingBrief({
    env,
    context,
    extraction,
    sourceTurnId
  });
  let analysisPlan = null;
  if (isStale()) return { brief: null, analysisPlan: null, stale: true };

  if (brief.readyToConfirm && completionEnabled) {
    const prepared = await prepareRealtimeVoiceAnalysisPlan({
      env,
      config,
      sessionRow: context.sessionRow,
      profile: context.profile,
      leaseId,
      idempotencyKey: `spoken-completion:${leaseId}:${brief.profileRevision}:${sourceTurnId}`
    });
    analysisPlan = prepared;
    const enriched = {
      ...brief,
      phase: 'awaiting_voice_confirmation',
      moduleState: 'prepared',
      analysisPlan: {
        planId: prepared.publicPlan.planId,
        profileRevision: prepared.publicPlan.profileRevision,
        status: prepared.publicPlan.status,
        moduleIds: prepared.publicPlan.moduleIds
      },
      confirmationSummary: buildVoiceConfirmationSummary({
        narrativeSummary: brief.narrativeSummary,
        analyses: brief.analyses,
        statePensionRule: brief.statePensionRule,
        understood: brief.understood
      })
    };
    const signature = await hmacSha256Base64Url(
      env.CONSUMER_RATE_LIMIT_HASH_KEY,
      `consumer/realtime/meeting-brief/v2/${stableStringify(enriched)}`
    );
    brief = Object.freeze({ ...enriched, signature });
    await setRealtimeMeetingPhase(env, {
      sessionId: context.sessionRow.id,
      leaseId,
      phase: 'awaiting_voice_confirmation',
      planId: prepared.publicPlan.planId,
      profileRevision: prepared.publicPlan.profileRevision,
      navigationTarget: '/plan/#results'
    });
  } else {
    await setRealtimeMeetingPhase(env, {
      sessionId: context.sessionRow.id,
      leaseId,
      phase: brief.phase === 'discovery' ? 'discovery' : 'intake'
    }).catch(() => {});
  }

  await saveRealtimeMeetingBrief(env, {
    sessionId: context.sessionRow.id,
    leaseId,
    sourceTurnId,
    profileRevision: brief.profileRevision,
    plannerPromptVersion: config.realtimePlannerPromptVersion,
    brief
  });
  // What the client is about to be offered, recorded once per brief. Without
  // this the offer and capacity flows are invisible in analytics, which is what
  // let them stay dead in live voice unnoticed.
  const channel = context.state?.channel || 'voice';
  if (brief.moduleOffer?.moduleId) {
    await recordEvent(env, context.sessionRow.id, 'module_offer_presented', {
      moduleId: brief.moduleOffer.moduleId,
      channel
    }).catch(() => {});
  }
  if (brief.capacityDecision?.candidateModuleId) {
    await recordEvent(env, context.sessionRow.id, 'capacity_decision_presented', {
      candidateModuleId: brief.capacityDecision.candidateModuleId,
      currentModuleIds: [...(brief.capacityDecision.currentModuleIds || [])],
      channel
    }).catch(() => {});
  }
  return { brief, analysisPlan, stale: false };
}

/**
 * Record the client's final confirmation of the analysis set, then confirm the
 * profile revision.
 *
 * This is the missing link of the P3 flow (OFFER → RECORD → COLLECT → CONFIRM →
 * EXECUTE). Its spoken half shipped; its persistence half did not, so
 * `confirmedModuleIds` was never written and `executionModuleIds` stayed dead
 * (D-01). Without this, an accepted-but-unconfirmed analysis could only execute
 * because a stale duplicate of the execution rule allowed it.
 *
 * Revision safety: `confirmProfileRevision` rewrites the SAME revision in place
 * rather than bumping it, so folding the confirmed set into the profile first
 * keeps `current_profile_revision` stable. Every `expectedRevision` equality
 * check and the analysis plan nonce binding therefore continue to hold.
 *
 * @returns {{profile, session, confirmedModuleIds}}
 */
export async function confirmPlanSelection({ env, config, sessionRow, profile, channel = 'voice' }) {
  const state = describeConversationState(profile, config);
  const confirmedModuleIds = resolveConfirmationCandidateModuleIds(state, config);
  const planning = profile?.assumptions?.values?.planning || {};
  const confirmedProfile = {
    ...profile,
    assumptions: {
      ...profile.assumptions,
      values: {
        ...profile.assumptions.values,
        planning: { ...planning, confirmedModuleIds }
      }
    }
  };
  const confirmed = await confirmProfileRevision(env, sessionRow, confirmedProfile);
  await recordEvent(env, sessionRow.id, 'analysis_set_confirmed', {
    moduleIds: confirmedModuleIds,
    profileRevision: Number(sessionRow.current_profile_revision),
    channel
  }).catch(() => {});
  return { ...confirmed, confirmedModuleIds };
}

/**
 * Emit the deterministic plan-change telemetry for a turn. Shared so a text
 * meeting produces the same analytics trail as a spoken one.
 */
export async function recordPlanEvaluation({ env, sessionId, previousState, nextState }) {
  const previousModuleIds = (previousState.moduleSlots || []).map((slot) => slot.moduleId);
  const moduleIds = (nextState.moduleSlots || []).map((slot) => slot.moduleId);
  const planChanged = previousModuleIds.join('|') !== moduleIds.join('|');
  await recordEvent(env, sessionId, 'goal_plan_evaluated', {
    selectionPolicyVersion: nextState.selectionPolicyVersion || null,
    goalTypes: nextState.goalAssessment?.activeGoalTypes || [],
    deferredGoalTypes: nextState.goalAssessment?.deferredGoalTypes || [],
    moduleIds,
    ruleIds: (nextState.recommendations || []).flatMap((item) => item.triggeredRuleIds || []),
    clarificationRequired: nextState.requiresGoalPriorityQuestion === true
      || nextState.requiresDecisionTopicQuestion === true,
    planChanged
  }).catch(() => {});
  if (planChanged) {
    await recordEvent(env, sessionId, 'goal_plan_changed', {
      selectionPolicyVersion: nextState.selectionPolicyVersion || null,
      previousModuleIds,
      moduleIds
    }).catch(() => {});
  }
  return { planChanged, previousModuleIds, moduleIds };
}

/**
 * Record the client's answer to the single analysis currently on the table.
 *
 * The SERVER owns which analysis that is. The caller supplies only a decision
 * value, so a bare "yes" can resolve to exactly one thing and an analysis that
 * was never offered can never be added.
 */
export async function resolveModuleOffer({ env, config, context, decision, activeOffer }) {
  if (!config.realtimeConversationV2Enabled) {
    throw new ConsumerError(409, 'realtime_module_decision_unavailable', 'Module decisions are not available in this voice version.');
  }
  if (!activeOffer?.moduleId) {
    throw new ConsumerError(409, 'realtime_no_active_module_offer', 'There is no analysis currently offered to decide on.');
  }
  if (!['accepted', 'declined', 'uncertain'].includes(decision)) {
    throw new ConsumerError(400, 'realtime_module_decision_invalid', 'That decision value is not supported.');
  }
  // An unclear answer changes nothing. It is recorded as an event so the
  // meeting can follow up, but it must never behave like an acceptance.
  if (decision === 'uncertain') {
    await recordEvent(env, context.sessionRow.id, 'module_offer_uncertain', {
      moduleId: activeOffer.moduleId,
      channel: context.state?.channel || 'voice'
    }).catch(() => {});
    return {
      ok: true,
      decision: 'uncertain',
      moduleId: activeOffer.moduleId,
      instruction: 'The client has not decided. Answer what they asked using get_intake_explanation, then ask again plainly. Do not treat this as a yes and do not start collecting facts for it.'
    };
  }
  const recorded = await recordRealtimeModuleDecision(env, {
    sessionId: context.sessionRow.id,
    sessionRow: context.sessionRow,
    profile: context.profile,
    moduleId: activeOffer.moduleId,
    decision
  });
  await recordEvent(env, context.sessionRow.id, 'module_offer_decided', {
    moduleId: activeOffer.moduleId,
    decision,
    profileRevision: recorded.revision,
    channel: context.state?.channel || 'voice'
  }).catch(() => {});
  return {
    ok: true,
    decision,
    moduleId: activeOffer.moduleId,
    profileRevision: recorded.revision,
    instruction: decision === 'accepted'
      ? 'Acknowledge briefly and continue with the next question the server gives you. The analysis is included but has not run; the full set is confirmed later.'
      : 'Acknowledge briefly without pressing, and continue. Do not offer this analysis again unless the client raises it themselves.'
  };
}

/**
 * Record the client's answer when the plan is full and one more analysis has
 * become relevant. The server owns the proposed analysis and the exact list
 * that may be replaced; the caller supplies an INDEX into that list, never an
 * identifier, so it cannot name or invent an analysis.
 */
export async function resolveCapacityDecision({
  env,
  config,
  context,
  decision,
  replaceChoiceIndex,
  capacity
}) {
  if (!config.realtimeConversationV2Enabled) {
    throw new ConsumerError(409, 'realtime_capacity_decision_unavailable', 'Capacity decisions are not available in this voice version.');
  }
  if (!capacity?.candidateModuleId || !(capacity.replacementChoices || []).length) {
    throw new ConsumerError(409, 'realtime_no_active_capacity_decision', 'There is no capacity decision to resolve right now.');
  }
  if (!['replace', 'defer', 'unclear'].includes(decision)) {
    throw new ConsumerError(400, 'realtime_capacity_decision_invalid', 'That capacity decision value is not supported.');
  }

  // An unclear answer must not mutate planning state. The client is asked
  // again; nothing picks for them.
  if (decision === 'unclear') {
    await recordEvent(env, context.sessionRow.id, 'capacity_decision_unclear', {
      candidateModuleId: capacity.candidateModuleId,
      channel: context.state?.channel || 'voice'
    }).catch(() => {});
    return {
      ok: true,
      decision: 'unclear',
      instruction: 'The client has not chosen. Re-read the options from capacityDecision.spoken exactly and ask again. '
        + 'Never suggest which analysis they should drop, and do not change anything.'
    };
  }

  let removeModuleId = null;
  if (decision === 'replace') {
    const choice = (capacity.replacementChoices || [])
      .find((item) => Number(item.choiceIndex) === Number(replaceChoiceIndex));
    // A choice outside the server-owned list changes nothing.
    if (!choice) {
      throw new ConsumerError(400, 'realtime_capacity_choice_invalid', 'That is not one of the analyses currently outlined.');
    }
    removeModuleId = choice.moduleId;
  }

  const recorded = await recordRealtimeCapacityDecision(env, {
    sessionId: context.sessionRow.id,
    sessionRow: context.sessionRow,
    profile: context.profile,
    decision,
    candidateModuleId: capacity.candidateModuleId,
    removeModuleId
  });
  await recordEvent(env, context.sessionRow.id, 'capacity_decision_resolved', {
    decision,
    candidateModuleId: capacity.candidateModuleId,
    removedModuleId: removeModuleId,
    profileRevision: recorded.revision,
    channel: context.state?.channel || 'voice'
  }).catch(() => {});

  // Acknowledgements reuse the manifest-owned client descriptions, so no formal
  // analysis name is ever spoken back.
  const removedDescription = decision === 'replace'
    ? (capacity.replacementChoices.find((item) => item.moduleId === removeModuleId)?.description || '')
    : '';
  return {
    ok: true,
    decision,
    profileRevision: recorded.revision,
    ...(decision === 'replace'
      ? {
          acknowledgement: `Okay — we will leave out ${removedDescription} and include ${capacity.candidateDescription} instead.`,
          instruction: 'Read the acknowledgement, then continue with the next question the server gives you. '
            + 'The set has changed, so it must be confirmed again before anything runs.'
        }
      : {
          acknowledgement: capacity.deferralAcknowledgement,
          instruction: 'Read the acknowledgement and move on. Do not raise that analysis again in this session '
            + 'unless the client brings it up themselves.'
        })
  };
}
