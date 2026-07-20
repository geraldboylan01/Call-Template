import assert from 'node:assert/strict';

import {
  GOAL_ROUTING_POLICY_VERSION,
  MODULE_IDS,
  buildGoalModulePlan,
  createHouseholdProfile,
  getPlanningModuleDescriptors,
  getPlanningPlaybookManifestVersion,
  goalPlanRecommendations,
  listSelectablePlanningModuleDefinitions,
  normalizeHouseholdProfile,
  runPlanningModule
} from '../js/planning/index.js';
import { describeConversationState } from '../worker/src/consumer/conversation.js';
import { mapRealtimeFact, modulesEnabledByFacts } from '../worker/src/consumer/realtime_fact_mapper.js';
import { applyProfilePatch } from '../worker/src/consumer/validators.js';

const NOW = '2026-07-20T09:00:00.000Z';
const ALL_RELEASED_FOR_TEST = Object.values(MODULE_IDS);

function goal(type, index = 0, priority = 'high') {
  return { goalId: `goal-${type}-${index}`, type, title: type, priority, status: 'active' };
}

function profile({ id, age, goals = [], planning = {}, persona = {}, assets = [], liabilities = [], properties = [], pensions = [], businesses = [] }) {
  const base = createHouseholdProfile({
    profileId: id,
    nowIso: NOW,
    calculationDateIso: NOW.slice(0, 10)
  });
  return normalizeHouseholdProfile({
    ...base,
    revision: 1,
    primaryPerson: { ...base.primaryPerson, ...(Number.isInteger(age) ? { age } : {}) },
    goals,
    assets,
    liabilities,
    properties,
    pensions,
    businesses,
    assumptions: {
      ...base.assumptions,
      values: { ...base.assumptions.values, persona, planning }
    }
  });
}

function moduleIds(input) {
  return buildGoalModulePlan(input, { allowedModuleIds: ALL_RELEASED_FOR_TEST })
    .moduleSlots.map((slot) => slot.moduleId);
}

const cases = [
  {
    name: 'asset-light student cash goal',
    profile: profile({ id: 'goal-student-cash', age: 21, goals: [goal('maintain_liquidity')], persona: { lifeStage: 'student' } }),
    expected: [MODULE_IDS.LIQUIDITY]
  },
  {
    name: 'asset-light early-career cash goal',
    profile: profile({ id: 'goal-early-career-cash', goals: [goal('maintain_liquidity')], persona: { careerStage: 'early_career' } }),
    expected: [MODULE_IDS.LIQUIDITY]
  },
  {
    name: 'early-career first-time buyer',
    profile: profile({ id: 'goal-young-buyer', age: 26, goals: [goal('buy_home')] }),
    expected: [MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.LIQUIDITY]
  },
  {
    name: 'established first-time buyer with investments',
    profile: profile({
      id: 'goal-established-buyer', age: 38, goals: [goal('buy_home')],
      assets: [{ assetId: 'investment-1', ownerIds: ['primary'], type: 'investment', label: 'Investments', currentValue: { amount: 20_000, currency: 'EUR' }, liquid: true }]
    }),
    expected: [MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.LIQUIDITY, MODULE_IDS.PERSONAL_BALANCE_SHEET]
  },
  {
    name: 'pension review',
    profile: profile({ id: 'goal-pension', age: 40, goals: [goal('improve_pension')] }),
    expected: [MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.PERSONAL_BALANCE_SHEET]
  },
  {
    name: 'retirement',
    profile: profile({ id: 'goal-retirement', age: 52, goals: [goal('retire')] }),
    expected: [MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.NET_RETIREMENT, MODULE_IDS.PERSONAL_BALANCE_SHEET]
  },
  {
    name: 'existing mortgage',
    profile: profile({ id: 'goal-mortgage', age: 42, goals: [goal('optimise_mortgage')] }),
    expected: [MODULE_IDS.MORTGAGE, MODULE_IDS.PERSONAL_BALANCE_SHEET]
  },
  {
    name: 'personal loan',
    profile: profile({ id: 'goal-loan', age: 35, goals: [goal('manage_loan')] }),
    expected: [MODULE_IDS.LOAN, MODULE_IDS.PERSONAL_BALANCE_SHEET]
  },
  {
    name: 'education funding',
    profile: profile({ id: 'goal-education', age: 41, goals: [goal('fund_education')] }),
    expected: [MODULE_IDS.COLLEGE_FUNDING, MODULE_IDS.PERSONAL_BALANCE_SHEET]
  },
  {
    name: 'young explicit full-position review',
    profile: profile({ id: 'goal-young-position', age: 23, goals: [goal('understand_position')] }),
    expected: [MODULE_IDS.PERSONAL_BALANCE_SHEET]
  }
];

for (const testCase of cases) {
  assert.deepEqual(moduleIds(testCase.profile), testCase.expected, testCase.name);
  console.info(`[ConsumerGoalRouting] PASS: ${testCase.name}`);
}

const overloaded = profile({
  id: 'goal-overloaded', age: 46,
  goals: [goal('buy_home', 0), goal('retire', 1)]
});
const overloadedPlan = buildGoalModulePlan(overloaded, { allowedModuleIds: ALL_RELEASED_FOR_TEST });
assert.equal(overloadedPlan.requiresGoalPriorityQuestion, true);
assert.deepEqual(overloadedPlan.moduleSlots, []);

const focused = profile({
  id: 'goal-focused', age: 46,
  goals: [goal('buy_home', 0), goal('retire', 1)],
  planning: { primaryGoalType: 'retire' }
});
const focusedPlan = buildGoalModulePlan(focused, { allowedModuleIds: ALL_RELEASED_FOR_TEST });
assert.deepEqual(
  focusedPlan.moduleSlots.map((slot) => slot.moduleId),
  [MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.NET_RETIREMENT, MODULE_IDS.PERSONAL_BALANCE_SHEET]
);
assert.deepEqual(focusedPlan.deferredGoalTypes, ['buy_home']);

const broadDecision = profile({ id: 'goal-broad-decision', age: 39, goals: [goal('assess_decision')] });
const broadPlan = buildGoalModulePlan(broadDecision, { allowedModuleIds: ALL_RELEASED_FOR_TEST });
assert.equal(broadPlan.requiresDecisionTopicQuestion, true);
assert.deepEqual(broadPlan.moduleSlots, []);

const unsupported = profile({ id: 'goal-unsupported', age: 55, goals: [goal('transfer_wealth')] });
const unsupportedPlan = buildGoalModulePlan(unsupported, { allowedModuleIds: ALL_RELEASED_FOR_TEST });
assert.deepEqual(unsupportedPlan.moduleSlots, []);
assert.deepEqual(unsupportedPlan.deferredGoalTypes, ['transfer_wealth']);
const unsupportedState = describeConversationState(unsupported, {
  goalRoutingEnabled: true,
  moduleRoutingEnabled: true,
  allowedModules: ALL_RELEASED_FOR_TEST
});
assert.equal(unsupportedState.stage, 'goal_clarification');
assert.match(unsupportedState.nextQuestion.prompt, /does not yet have a consumer analysis/i);

const establishedBuyer = cases.find((item) => item.name === 'established first-time buyer with investments').profile;
const gatedPlan = buildGoalModulePlan(establishedBuyer, {
  allowedModuleIds: [MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.LIQUIDITY]
});
assert.deepEqual(gatedPlan.executionModuleIds, [MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.LIQUIDITY]);
assert.equal(gatedPlan.moduleSlots[2].availability, 'adviser_review_required');
assert.equal(typeof gatedPlan.moduleSlots[2].intakeStatus, 'string');

const recommendations = goalPlanRecommendations(gatedPlan, cases[2].profile);
assert.equal(recommendations.length, 3);
assert.equal(recommendations[2].availability, 'adviser_review_required');

const earlyBuyer = cases.find((item) => item.name === 'early-career first-time buyer').profile;
const state = describeConversationState(earlyBuyer, {
  goalRoutingEnabled: true,
  moduleRoutingEnabled: true,
  allowedModules: ALL_RELEASED_FOR_TEST
});
assert.equal(state.selectionPolicyVersion, GOAL_ROUTING_POLICY_VERSION);
assert.equal(state.personaAssessment, undefined);
assert.notEqual(state.stage, 'life_stage_scan');
assert.doesNotMatch(state.nextQuestion.prompt, /persona|which best describes/i);

const sameTurnBlank = profile({ id: 'goal-same-turn', age: 25 });
assert.deepEqual(
  [...modulesEnabledByFacts([], [{ factId: 'primary_goal', value: 'buy_home' }], sameTurnBlank)],
  [MODULE_IDS.HOUSE_PURCHASE, MODULE_IDS.LIQUIDITY]
);

let corrected = profile({ id: 'goal-correction', age: 44, goals: [goal('buy_home')] });
const mappedCorrection = mapRealtimeFact(corrected, {
  factId: 'primary_goal',
  value: { type: 'retire', correctionTarget: 'buy_home' }
});
corrected = applyProfilePatch(corrected, {
  ...(mappedCorrection.additionalPatch || {}),
  [mappedCorrection.fieldPath]: mappedCorrection.canonicalValue
}, [], 'ai_extraction');
assert.deepEqual(corrected.goals.filter((item) => item.status === 'active').map((item) => item.type), ['retire']);
assert.deepEqual(moduleIds(corrected), [MODULE_IDS.PENSION_PROJECTION, MODULE_IDS.NET_RETIREMENT, MODULE_IDS.PERSONAL_BALANCE_SHEET]);

const selectableIds = listSelectablePlanningModuleDefinitions().map((item) => item.id).sort();
assert.deepEqual(selectableIds, [
  MODULE_IDS.COLLEGE_FUNDING,
  MODULE_IDS.HOUSE_PURCHASE,
  MODULE_IDS.LIQUIDITY,
  MODULE_IDS.LOAN,
  MODULE_IDS.MORTGAGE,
  MODULE_IDS.NET_RETIREMENT,
  MODULE_IDS.PENSION_PROJECTION,
  MODULE_IDS.PERSONAL_BALANCE_SHEET
].sort());
const descriptors = new Map(getPlanningModuleDescriptors().map((item) => [item.id, item]));
assert.equal(descriptors.get(MODULE_IDS.PROTECTION).templateAvailable, true);
assert.equal(descriptors.get(MODULE_IDS.PROTECTION).planningSelectable, false);
assert.match(getPlanningPlaybookManifestVersion(), /^planning-playbooks-/);

const runnableLoan = profile({
  id: 'goal-runnable-loan',
  age: 35,
  goals: [goal('manage_loan')],
  liabilities: [{
    liabilityId: 'car-loan',
    ownerIds: ['primary'],
    type: 'loan',
    label: 'Car loan',
    currentBalance: { amount: 12_000, currency: 'EUR' },
    annualInterestRate: 0.072,
    remainingTermMonths: 48
  }]
});
const loanResult = await runPlanningModule(MODULE_IDS.LOAN, runnableLoan, {
  calculationVersion: 'goal-routing-test-v1',
  calculatedAt: NOW,
  scenarioOverrides: {}
});
assert.equal(loanResult.moduleId, MODULE_IDS.LOAN);
assert.equal(loanResult.semanticResult.openingBalance, 12_000);
assert.ok(loanResult.semanticResult.monthlyPayment > 0);
assert.match(loanResult.inputSnapshotHash, /^(sha256|fnv1a64):/);

for (const plan of [overloadedPlan, focusedPlan, broadPlan, unsupportedPlan, gatedPlan]) {
  assert.equal(plan.selectionPolicyVersion, GOAL_ROUTING_POLICY_VERSION);
  assert.ok(plan.moduleSlots.length <= 3);
  assert.equal(new Set(plan.moduleSlots.map((slot) => slot.moduleId)).size, plan.moduleSlots.length);
}

console.info('[ConsumerGoalRouting] Goal-led module policy, catalogue intersection, corrections and variable slots passed.');
