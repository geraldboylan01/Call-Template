// Shared planning-path regressions.
//
// These cover the three divergences the A0/A1 extraction uncovered, recorded as
// D-01, D-02 and D-03 in docs/agent-testing-parity-contract.md. Every assertion
// drives the PRODUCTION shared planning path — the same functions the Realtime
// Durable Object and the future text/agent transport both call — so a defect
// cannot be fixed for one transport and left broken in the other.
//
// No network, no API key, no database.

import assert from 'node:assert/strict';

import {
  MODULE_IDS,
  buildGoalModulePlan,
  createHouseholdProfile,
  normalizeHouseholdProfile
} from '../js/planning/index.js';
import {
  composeCapacityChoice,
  confirmationSummary,
  containsInternalModuleTerminology,
  nextModuleOffer
} from '../js/planning/module_offers.js';
import { describeConversationState } from '../worker/src/consumer/conversation.js';
import { composeMeetingBrief } from '../worker/src/consumer/realtime_planner.js';
import { realtimeToolsForState } from '../worker/src/consumer/realtime_provider.js';
import {
  buildPlanningStateSlice,
  resolveConfirmationCandidateModuleIds,
  resolveExecutionModuleIds
} from '../worker/src/consumer/planning_context.js';
import {
  mapPlannerExtractionToCandidates,
  planFactProposal
} from '../worker/src/consumer/planning_facts.js';
import { applyProfilePatch } from '../worker/src/consumer/validators.js';

const NOW = '2026-07-25T09:00:00.000Z';
const ALL_RELEASED_FOR_TEST = Object.values(MODULE_IDS);
const ENV = { CONSUMER_RATE_LIMIT_HASH_KEY: 'c2ltdWxhdG9yLXRlc3Qta2V5LTMyLWJ5dGVzLW9rMDA' };
const CONFIG = Object.freeze({
  goalRoutingEnabled: true,
  moduleRoutingEnabled: true,
  allowedModules: ALL_RELEASED_FOR_TEST,
  realtimeSpokenCompletionEnabled: false,
  realtimeConversationV2Enabled: true,
  moduleOffersEnabled: true
});
// The same config with the shared rollout control off. Used to prove the flag
// suppresses offers for EVERY transport rather than creating a divergence.
const CONFIG_OFFERS_OFF = Object.freeze({ ...CONFIG, moduleOffersEnabled: false });

const passes = [];
function pass(message) {
  passes.push(message);
  console.info(`[SharedPlanning] PASS: ${message}`);
}

function freshProfile(profileId = 'shared-planning') {
  return normalizeHouseholdProfile({
    ...createHouseholdProfile({
      profileId,
      nowIso: NOW,
      calculationDateIso: NOW.slice(0, 10)
    }),
    revision: 1
  });
}

function stateFor(profile) {
  return describeConversationState(profile, CONFIG);
}

function planFor(profile) {
  return buildGoalModulePlan(profile, { allowedModuleIds: ALL_RELEASED_FOR_TEST });
}

/** Drive the production planner-candidate path for one extraction. */
function applyExtraction(profile, extraction) {
  let next = profile;
  const rejected = [];
  for (const candidate of mapPlannerExtractionToCandidates(extraction)) {
    try {
      next = planFactProposal({
        config: CONFIG,
        profile: next,
        state: stateFor(next),
        fact: {
          factId: candidate.factId,
          value: candidate.value,
          certainty: candidate.certainty
        },
        plannerBatch: true
      }).profile;
    } catch (error) {
      rejected.push({ factId: candidate.factId, code: error?.code || error?.message });
    }
  }
  return { profile: next, rejected };
}

function goalExtraction(goals) {
  return {
    sourceTurnId: 'shared-planning-turn',
    goalCandidates: goals.map((goal, index) => ({
      candidateId: `goal-${index + 1}`,
      goalType: goal.type,
      confidence: 'high',
      priorityHint: goal.priorityHint || 'unspecified',
      evidenceText: 'fixture evidence',
      correctionTarget: ''
    })),
    semanticFacts: [],
    positions: [],
    sectionCompletions: [],
    invalidCandidates: [],
    clientQuestion: { present: false, intent: 'none', topic: '', questionText: '' },
    ambiguities: [],
    narrativeSummary: { summary: '', evidence: [] }
  };
}

async function briefFor(profile, config = CONFIG) {
  const state = stateFor(profile);
  return composeMeetingBrief({
    env: ENV,
    context: {
      state: buildPlanningStateSlice({
        state,
        profile,
        sessionRow: { current_profile_revision: profile.revision },
        config
      }),
      profile,
      config,
      sessionRow: { current_profile_revision: profile.revision }
    },
    extraction: {},
    sourceTurnId: 'shared-planning-turn'
  });
}

// ---------------------------------------------------------------------------
// D-03 — a client's explicitly stated primary goal must persist and must rank.
// ---------------------------------------------------------------------------

{
  const base = freshProfile('d03-fresh');
  assert.ok(
    Object.hasOwn(base.assumptions.values, 'planning'),
    'a fresh profile must expose assumptions.values.planning so scalar planning facts can be written'
  );
  assert.deepEqual(base.assumptions.values.planning, {}, 'the guaranteed planning object starts empty');
  pass('a fresh profile exposes an empty planning object, like persona');
}

{
  // The scalar path the semantic-fact mapper produces for primary_goal_focus.
  const patched = applyProfilePatch(
    freshProfile('d03-scalar'),
    { '/assumptions/values/planning/primaryGoalType': 'improve_pension' },
    [],
    'ai_extraction'
  );
  assert.equal(patched.assumptions.values.planning.primaryGoalType, 'improve_pension');
  pass('primary_goal_focus persists on a fresh profile through the scalar planning path');
}

{
  // A fresh profile, several goals stated in one turn, with the SECOND named as
  // the client's focus. Mention order and stated preference disagree on purpose.
  const extraction = goalExtraction([
    { type: 'buy_home' },
    { type: 'improve_pension', priorityHint: 'primary' },
    { type: 'fund_education' }
  ]);
  const { profile, rejected } = applyExtraction(freshProfile('d03-multi'), extraction);

  assert.deepEqual(rejected, [], `no planner candidate may be rejected: ${JSON.stringify(rejected)}`);
  assert.equal(
    profile.assumptions.values.planning.primaryGoalType,
    'improve_pension',
    'the stated primary goal is persisted'
  );

  const plan = planFor(profile);
  assert.equal(
    plan.goalAssessment.primaryGoalType,
    'improve_pension',
    'goal assessment follows the stated preference, not mention order'
  );
  const pensionRank = plan.moduleSlots.findIndex((slot) => slot.moduleId === MODULE_IDS.PENSION_PROJECTION);
  const homeRank = plan.moduleSlots.findIndex((slot) => slot.moduleId === MODULE_IDS.HOUSE_PURCHASE);
  assert.ok(pensionRank >= 0, `the primary goal's analysis is selected: [${plan.moduleSlots.map((s) => s.moduleId).join(', ')}]`);
  assert.ok(
    homeRank === -1 || pensionRank < homeRank,
    'the stated primary goal outranks a goal that was merely mentioned first'
  );
  // The unanswered-priority question must not reappear once the client answered it.
  assert.equal(plan.requiresGoalPriorityQuestion, false, 'a stated focus resolves the priority question');
  pass('a stated primary goal outranks mention order and resolves the priority question');
}

{
  // Control: with no stated preference, mention order still decides. This is the
  // assertion that keeps the fix from changing existing journeys.
  const extraction = goalExtraction([{ type: 'buy_home' }, { type: 'improve_pension' }]);
  const { profile } = applyExtraction(freshProfile('d03-control'), extraction);
  assert.deepEqual(
    profile.assumptions.values.planning,
    {},
    'no stated preference writes no planning focus'
  );
  const plan = planFor(profile);
  assert.equal(plan.goalAssessment.primaryGoalType, 'buy_home', 'mention order still decides without a stated focus');
  assert.equal(plan.requiresGoalPriorityQuestion, true, 'the priority question is still asked when nothing was stated');
  pass('with no stated preference, mention order and the priority question are unchanged');
}

// ---------------------------------------------------------------------------
// D-02 — offers and the capacity flow must reach the brief on every transport.
// ---------------------------------------------------------------------------

/** A homeowner with a mortgage whose stated goal is retirement. The mortgage
 *  review is a circumstance-driven OFFER, not a routed slot. */
function offerableProfile(profileId = 'd02-offer') {
  const base = freshProfile(profileId);
  return normalizeHouseholdProfile({
    ...base,
    goals: [{ goalId: 'g1', type: 'improve_pension', title: 'Improve pension readiness', priority: 'high', status: 'exploring' }],
    assumptions: {
      ...base.assumptions,
      values: {
        ...base.assumptions.values,
        persona: { ...(base.assumptions.values.persona || {}), propertyStatus: 'homeowner' }
      }
    },
    properties: [{
      propertyId: 'home', ownerIds: [base.primaryPerson.personId], use: 'home',
      label: 'Home', currentValue: { amount: 500_000, currency: 'EUR' }
    }],
    liabilities: [{
      liabilityId: 'mort', ownerIds: [base.primaryPerson.personId], type: 'mortgage',
      label: 'Mortgage', linkedPropertyId: 'home', currentBalance: { amount: 250_000, currency: 'EUR' }
    }]
  });
}

{
  const profile = offerableProfile();
  const plan = planFor(profile);
  const offerable = plan.moduleOpportunities.filter((item) => item.state === 'offerable');
  assert.ok(offerable.length > 0, 'the deterministic engine produces an offerable opportunity for this client');
  assert.ok(
    nextModuleOffer({ moduleOpportunities: plan.moduleOpportunities }, { profile }),
    'the deterministic offer composer produces an offer from it'
  );

  const brief = await briefFor(profile);
  assert.ok(
    brief.moduleOffer && brief.moduleOffer.moduleId,
    'the shared planning state must carry an offerable module through to the brief'
  );
  assert.equal(brief.moduleOffer.moduleId, MODULE_IDS.MORTGAGE);
  assert.ok(brief.moduleOffer.anchor, 'the offer is anchored to something the client supplied');
  assert.ok(brief.moduleOffer.spokenOffer.includes(brief.moduleOffer.anchor), 'the spoken offer quotes the anchor');
  pass('an offerable module produces a non-null module offer in the shared brief');
}

{
  // The rollout control is ONE shared rule. With it off, no transport offers —
  // this is what makes a staged voice canary safe without reintroducing a
  // per-transport state divergence.
  const profile = offerableProfile('d02-rollout');
  const off = await briefFor(profile, CONFIG_OFFERS_OFF);
  assert.equal(off.moduleOffer, null, 'the rollout control suppresses offers');
  assert.equal(off.capacityDecision, null, 'the rollout control suppresses capacity decisions');
  const atLimitOff = await briefFor(atCapacityProfile('d02-rollout-cap'), CONFIG_OFFERS_OFF);
  assert.equal(atLimitOff.capacityDecision, null, 'even at the limit, the control suppresses the decision');
  assert.ok(
    !realtimeToolsForState({ conversationVersion: 'v2', meetingBrief: off })
      .map((tool) => tool.name)
      .some((name) => ['record_module_decision', 'resolve_capacity_decision'].includes(name)),
    'with offers off, neither decision tool is exposed'
  );
  pass('the shared rollout control suppresses offers and capacity decisions for every transport');
}

{
  const profile = offerableProfile('d02-tools');
  const withOffer = await briefFor(profile);
  const withoutOffer = await briefFor(freshProfile('d02-no-offer'));

  const toolsWithOffer = realtimeToolsForState({
    conversationVersion: 'v2', meetingBrief: withOffer
  }).map((tool) => tool.name);
  const toolsWithoutOffer = realtimeToolsForState({
    conversationVersion: 'v2', meetingBrief: withoutOffer
  }).map((tool) => tool.name);

  assert.ok(toolsWithOffer.includes('record_module_decision'), 'the decision tool is offered while an offer is active');
  assert.ok(!toolsWithoutOffer.includes('record_module_decision'), 'the decision tool is withheld when no offer is active');
  pass('record_module_decision is available only while an offer is active');
}

/** Four relevant analyses: three routed slots plus one more still offerable. */
function atCapacityProfile(profileId = 'd02-capacity') {
  const base = freshProfile(profileId);
  return normalizeHouseholdProfile({
    ...base,
    goals: [
      { goalId: 'g1', type: 'understand_position', title: 'Understand my current position', priority: 'high', status: 'exploring' },
      { goalId: 'g2', type: 'optimise_mortgage', title: 'Review the mortgage path', priority: 'high', status: 'exploring' },
      { goalId: 'g3', type: 'fund_education', title: 'Fund children’s education', priority: 'high', status: 'exploring' }
    ],
    assumptions: {
      ...base.assumptions,
      values: {
        ...base.assumptions.values,
        planning: { primaryGoalType: 'understand_position' },
        persona: {
          ...(base.assumptions.values.persona || {}),
          propertyStatus: 'homeowner',
          hasPension: true,
          dependantCount: 2
        }
      }
    },
    properties: [{
      propertyId: 'home', ownerIds: [base.primaryPerson.personId], use: 'home',
      label: 'Home', currentValue: { amount: 500_000, currency: 'EUR' }
    }],
    liabilities: [{
      liabilityId: 'mort', ownerIds: [base.primaryPerson.personId], type: 'mortgage',
      label: 'Mortgage', linkedPropertyId: 'home', currentBalance: { amount: 250_000, currency: 'EUR' }
    }],
    pensions: [{
      pensionId: 'p1', ownerId: base.primaryPerson.personId, type: 'occupational',
      label: 'Occupational pension', currentValue: { amount: 120_000, currency: 'EUR' }
    }],
    dependants: [
      { dependantId: 'dep1', displayName: 'Child one', currentAge: 8 },
      { dependantId: 'dep2', displayName: 'Child two', currentAge: 11 }
    ]
  });
}

{
  const profile = atCapacityProfile();
  const plan = planFor(profile);
  assert.equal(plan.capacity.maximumAnalyses, 3, 'the product limit stays at three');
  assert.equal(plan.moduleSlots.length, 3, `the plan is full: [${plan.moduleSlots.map((s) => s.moduleId).join(', ')}]`);
  assert.equal(plan.capacity.atLimit, true, 'the plan reports it is at the limit');
  assert.ok(
    composeCapacityChoice(
      { capacity: plan.capacity, moduleSlots: plan.moduleSlots, moduleOpportunities: plan.moduleOpportunities },
      { profile }
    ),
    'the deterministic composer produces a capacity choice for this client'
  );

  const brief = await briefFor(profile);
  assert.ok(brief.capacityDecision, 'the shared planning state carries the capacity decision through to the brief');
  assert.ok(brief.capacityDecision.candidateModuleId, 'the proposed fourth analysis is named internally');
  assert.equal(brief.capacityDecision.replacementChoices.length, 3, 'exactly the current three may be replaced');
  assert.equal(brief.capacityDecision.maximumAnalyses, 3);
  pass('reaching the three-analysis limit produces a capacity decision in the shared brief');
}

{
  const atLimit = await briefFor(atCapacityProfile('d02-capacity-tools'));
  const notAtLimit = await briefFor(offerableProfile('d02-capacity-tools-no'));

  const toolsAtLimit = realtimeToolsForState({
    conversationVersion: 'v2', meetingBrief: atLimit
  }).map((tool) => tool.name);
  const toolsNotAtLimit = realtimeToolsForState({
    conversationVersion: 'v2', meetingBrief: notAtLimit
  }).map((tool) => tool.name);

  assert.ok(toolsAtLimit.includes('resolve_capacity_decision'), 'the capacity tool is offered while a decision is active');
  assert.ok(!toolsNotAtLimit.includes('resolve_capacity_decision'), 'the capacity tool is withheld otherwise');
  pass('resolve_capacity_decision is available only while a capacity decision is active');
}

{
  // Accept, defer and replace must all move shared planning state.
  const profile = offerableProfile('d02-decisions');
  const brief = await briefFor(profile);
  const offeredId = brief.moduleOffer.moduleId;
  const planning = profile.assumptions.values.planning || {};

  const accepted = normalizeHouseholdProfile({
    ...profile,
    assumptions: {
      ...profile.assumptions,
      values: { ...profile.assumptions.values, planning: { ...planning, acceptedModuleIds: [offeredId] } }
    }
  });
  assert.ok(
    planFor(accepted).moduleSlots.some((slot) => slot.moduleId === offeredId),
    'an accepted offer occupies a slot'
  );
  assert.equal(
    planFor(accepted).moduleSlots.find((slot) => slot.moduleId === offeredId).selectionState,
    'accepted',
    'an accepted offer is marked accepted, not selected, until the final confirmation'
  );

  const declined = normalizeHouseholdProfile({
    ...profile,
    assumptions: {
      ...profile.assumptions,
      values: { ...profile.assumptions.values, planning: { ...planning, declinedModuleIds: [offeredId] } }
    }
  });
  const declinedBrief = await briefFor(declined);
  assert.equal(declinedBrief.moduleOffer, null, 'a declined analysis is not offered again');

  const deferred = normalizeHouseholdProfile({
    ...profile,
    assumptions: {
      ...profile.assumptions,
      values: { ...profile.assumptions.values, planning: { ...planning, deferredModuleIds: [offeredId] } }
    }
  });
  const deferredBrief = await briefFor(deferred);
  assert.equal(deferredBrief.moduleOffer, null, 'a deferred analysis is not pressed again in the same cycle');

  const capacityProfile = atCapacityProfile('d02-replace');
  const capacityBrief = await briefFor(capacityProfile);
  const removeId = capacityBrief.capacityDecision.replacementChoices[0].moduleId;
  const candidateId = capacityBrief.capacityDecision.candidateModuleId;
  const replaced = normalizeHouseholdProfile({
    ...capacityProfile,
    assumptions: {
      ...capacityProfile.assumptions,
      values: {
        ...capacityProfile.assumptions.values,
        planning: {
          ...(capacityProfile.assumptions.values.planning || {}),
          replacedModuleIds: [removeId],
          acceptedModuleIds: [candidateId]
        }
      }
    }
  });
  const replacedIds = planFor(replaced).moduleSlots.map((slot) => slot.moduleId);
  assert.ok(!replacedIds.includes(removeId), 'the replaced analysis leaves the plan');
  assert.ok(replacedIds.includes(candidateId), 'the chosen analysis takes its place');
  assert.ok(replacedIds.length <= 3, 'replacement never exceeds the limit');
  pass('accepted, declined, deferred and replacement decisions update shared planning state');
}

{
  // Everything a client can hear or read must be client-safe.
  for (const [label, profile] of [['offer', offerableProfile('d02-lang')], ['capacity', atCapacityProfile('d02-lang-cap')]]) {
    const brief = await briefFor(profile);
    const clientFacing = [
      brief.moduleOffer?.spokenOffer,
      brief.moduleOffer?.anchor,
      brief.moduleOffer?.benefit,
      brief.capacityDecision?.spoken,
      brief.capacityDecision?.deferralAcknowledgement,
      brief.capacityDecision?.candidateDescription,
      ...(brief.capacityDecision?.replacementChoices || []).map((choice) => choice.description),
      ...(brief.analyses || []).map((item) => item.label),
      brief.questionBatch?.prompt
    ].filter(Boolean);
    assert.ok(clientFacing.length > 0, `${label}: there is client-facing copy to check`);
    for (const text of clientFacing) {
      assert.equal(
        containsInternalModuleTerminology(text),
        false,
        `${label}: internal module terminology leaked into client-facing copy: ${text}`
      );
    }
  }
  pass('consumer-visible offer and capacity copy contains no internal module names or ids');
}

// ---------------------------------------------------------------------------
// D-01 — only the confirmed final set may execute.
// ---------------------------------------------------------------------------

{
  const profile = offerableProfile('d01-accepted');
  const brief = await briefFor(profile);
  const offeredId = brief.moduleOffer.moduleId;
  const planning = profile.assumptions.values.planning || {};

  const accepted = normalizeHouseholdProfile({
    ...profile,
    assumptions: {
      ...profile.assumptions,
      values: { ...profile.assumptions.values, planning: { ...planning, acceptedModuleIds: [offeredId] } }
    }
  });
  const acceptedPlan = planFor(accepted);
  const acceptedState = stateFor(accepted);

  assert.ok(
    !resolveExecutionModuleIds(acceptedPlan).includes(offeredId),
    'accepting an offer does not by itself authorise execution'
  );
  assert.ok(
    resolveConfirmationCandidateModuleIds(acceptedState, CONFIG).includes(offeredId),
    'the accepted analysis IS read out for confirmation'
  );
  pass('acceptance alone does not execute, but is included in the set read out to confirm');

  // After the client confirms that exact set, it executes.
  const confirmedIds = resolveConfirmationCandidateModuleIds(acceptedState, CONFIG);
  const confirmed = normalizeHouseholdProfile({
    ...accepted,
    assumptions: {
      ...accepted.assumptions,
      values: {
        ...accepted.assumptions.values,
        planning: { ...accepted.assumptions.values.planning, confirmedModuleIds: confirmedIds }
      }
    }
  });
  const confirmedPlan = planFor(confirmed);
  const confirmedState = stateFor(confirmed);
  assert.ok(
    resolveExecutionModuleIds(confirmedPlan).includes(offeredId),
    'after confirmation the accepted analysis may execute'
  );
  assert.deepEqual(
    [...resolveExecutionModuleIds(confirmedPlan)].sort(),
    [...resolveConfirmationCandidateModuleIds(confirmedState, CONFIG)].sort(),
    'the executed set equals the confirmed set exactly'
  );
  pass('after confirmation, the execution set equals the confirmed set exactly');
}

{
  // A confirmation is only valid for the set it described. Changing the set
  // clears it, so a stale confirmation can never authorise a different plan.
  const profile = offerableProfile('d01-stale');
  const state = stateFor(profile);
  const confirmedIds = resolveConfirmationCandidateModuleIds(state, CONFIG);
  const confirmed = normalizeHouseholdProfile({
    ...profile,
    assumptions: {
      ...profile.assumptions,
      values: {
        ...profile.assumptions.values,
        planning: { ...(profile.assumptions.values.planning || {}), confirmedModuleIds: confirmedIds }
      }
    }
  });
  assert.deepEqual(
    [...resolveExecutionModuleIds(planFor(confirmed))].sort(),
    [...confirmedIds].sort(),
    'the confirmed set executes'
  );

  const summary = confirmationSummary({ moduleSlots: planFor(confirmed).moduleSlots });
  assert.deepEqual(
    [...summary.moduleIds].sort(),
    [...confirmedIds].sort(),
    'the spoken confirmation describes exactly the set that will execute'
  );
  assert.equal(
    containsInternalModuleTerminology(summary.spoken),
    false,
    'the spoken confirmation uses client language only'
  );
  pass('the spoken confirmation describes exactly the set that will execute, in client language');
}

console.info(`\n[SharedPlanning] ${passes.length} assertions passed.`);
