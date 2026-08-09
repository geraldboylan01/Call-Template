import assert from 'node:assert/strict';

import {
  buildGoalModulePlan,
  buildQuestionPlan as buildCanonicalQuestionPlan,
  completionResponseFor,
  createHouseholdProfile,
  goalPlanRecommendations,
  normalizeHouseholdProfile,
  resolveSemanticFact
} from '../js/planning/index.js';
import {
  buildPensionProjectionInput,
  getPensionProjectionReadiness
} from '../js/planning/adapters/retirement.js';
import {
  applyMappedRealtimeFact,
  bindCandidateToAskedEntity,
  mapRealtimeProposalFact,
  planFactProposal
} from '../worker/src/consumer/planning_facts.js';
import { toConsumerRealtimePlanningLists } from '../worker/src/consumer/planning_context.js';
import { buildQuestionPlan as buildWorkerQuestionPlan } from '../worker/src/consumer/question_plan.js';
import { mapRealtimeFact } from '../worker/src/consumer/realtime_fact_mapper.js';

const NOW = '2026-08-09T10:00:00.000Z';

function retirementProfile({ partner = false, pensions = [] } = {}) {
  const created = createHouseholdProfile({
    profileId: `phase2-${partner ? 'couple' : 'single'}`,
    nowIso: NOW,
    calculationDateIso: NOW.slice(0, 10)
  });
  const primaryId = created.primaryPerson.personId;
  const partnerPerson = partner
    ? {
        personId: 'person-partner',
        role: 'partner',
        displayName: 'Niamh',
        age: 59,
        intendedRetirementAge: 61,
        employmentStatus: 'employee'
      }
    : undefined;
  return normalizeHouseholdProfile({
    ...created,
    primaryPerson: {
      ...created.primaryPerson,
      displayName: 'Pat',
      age: 57,
      intendedRetirementAge: 58,
      employmentStatus: 'employee'
    },
    ...(partnerPerson ? { partner: partnerPerson } : {}),
    goals: [{
      goalId: 'goal-retire',
      type: 'retire_early',
      title: 'Explore early retirement',
      priority: 'high',
      status: 'active'
    }],
    incomeSources: [{
      incomeId: 'income-primary',
      ownerId: primaryId,
      type: 'employment',
      label: 'Primary employment',
      grossAnnual: { amount: 90_000, currency: 'EUR' }
    }, ...(partnerPerson ? [{
      incomeId: 'income-partner',
      ownerId: partnerPerson.personId,
      type: 'employment',
      label: 'Partner employment',
      grossAnnual: { amount: 60_000, currency: 'EUR' }
    }] : [])],
    expenses: { annualTotal: { amount: 70_000, currency: 'EUR' } },
    pensions: pensions.map((pension) => ({
      ...pension,
      ownerId: pension.ownerId === 'person-partner' ? 'person-partner' : primaryId
    })),
    assumptions: {
      ...created.assumptions,
      values: {
        ...created.assumptions.values,
        retirement: { targetIncomeToday: 70_000 }
      }
    }
  });
}

function updateCompletion(profile, completionFacts) {
  return normalizeHouseholdProfile({
    ...profile,
    assumptions: {
      ...profile.assumptions,
      values: {
        ...profile.assumptions.values,
        completionFacts
      }
    }
  });
}

function applyFact(profile, fact, state = null) {
  const mapped = mapRealtimeProposalFact(profile, fact, { state });
  return applyMappedRealtimeFact(profile, fact, mapped);
}

const primarySeed = createHouseholdProfile({
  profileId: 'phase2-owner-seed',
  nowIso: NOW,
  calculationDateIso: NOW.slice(0, 10)
});
const primaryId = primarySeed.primaryPerson.personId;

// A signed paired question binds each answer to the exact included instance,
// not just to the primary rate named first in the batch.
{
  const pairedProfile = retirementProfile({
    pensions: [{
      pensionId: 'paired-dc', ownerId: primaryId, type: 'occupational',
      currentValue: { amount: 300_000, currency: 'EUR' }, contributionStatus: 'active'
    }]
  });
  const pairedState = {
    meetingBrief: {
      questionBatch: {
        primaryFact: {
          factId: 'pension_employee_contribution_rate',
          factInstanceId: 'pension_employee_contribution_rate:paired-dc'
        },
        linkedFact: {
          factId: 'pension_employer_contribution_rate',
          factInstanceId: 'pension_employer_contribution_rate:paired-dc'
        }
      }
    }
  };
  const bound = bindCandidateToAskedEntity({
    candidateId: 'paired-employer',
    factId: 'pension_employer_contribution_rate',
    value: 10,
    certainty: 'exact'
  }, pairedState, pairedProfile);
  assert.equal(bound.value.entityId, 'paired-dc');
}

// Additive pension fields remain schema-v1 compatible and strictly validated.
const schemaProfile = retirementProfile({
  pensions: [{
    pensionId: 'db-primary',
    ownerId: primaryId,
    type: 'defined_benefit',
    contributionStatus: 'not_applicable',
    projectedAnnualIncome: { amount: 35_000, currency: 'EUR' },
    retirementLumpSum: { amount: 105_000, currency: 'EUR' },
    benefitStartAge: 60
  }]
});
assert.equal(schemaProfile.pensions[0].benefitStartAge, 60);
assert.equal(schemaProfile.pensions[0].retirementLumpSum.amount, 105_000);
assert.throws(
  () => normalizeHouseholdProfile({
    ...schemaProfile,
    pensions: [{ ...schemaProfile.pensions[0], contributionStatus: 'probably_active' }]
  }),
  /contributionStatus/
);

// A confirmed partner gets a distinct pension need with identity and wording.
const couple = retirementProfile({
  partner: true,
  pensions: [{
    pensionId: 'primary-paid-up',
    ownerId: primaryId,
    type: 'occupational',
    label: 'Old company pension',
    currentValue: { amount: 319_000, currency: 'EUR' },
    contributionStatus: 'paid_up'
  }]
});
const coupleReadiness = getPensionProjectionReadiness(couple);
const partnerNeed = coupleReadiness.requiredMissing.find((item) => (
  item.reasonCode === 'owner_pension_position_missing' && item.ownerId === 'person-partner'
));
assert.ok(partnerNeed, 'the confirmed partner must have an owner-scoped pension need');
const partnerQuestion = buildCanonicalQuestionPlan([{
  moduleId: 'pension_projection',
  required: true,
  readiness: coupleReadiness
}], { profile: couple }).find((item) => item.factInstanceId === 'pension_positions:person-partner');
assert.equal(partnerQuestion.ownerId, 'person-partner');
assert.equal(partnerQuestion.answerPolicy, 'value_or_none');
assert.match(partnerQuestion.prompt, /Does Niamh have/i);
assert.equal(
  resolveSemanticFact('/primaryPerson/age', { profile: couple }).questionPrompt,
  'What is your current age?'
);
assert.equal(
  resolveSemanticFact('/primaryPerson/intendedRetirementAge', { profile: couple }).questionPrompt,
  'At what age do you intend to retire?'
);
assert.equal(
  resolveSemanticFact('/partner/age', { profile: couple }).questionPrompt,
  "What is Niamh's current age?"
);

// Readiness follows the pension product and contribution status.
const productProfile = retirementProfile({
  pensions: [
    {
      pensionId: 'occupational-active', ownerId: primaryId, type: 'occupational',
      currentValue: { amount: 339_000, currency: 'EUR' }, contributionStatus: 'active',
      employeeContributionRate: 0.1, employerContributionRate: 0.08
    },
    {
      pensionId: 'prsa-active', ownerId: primaryId, type: 'prsa',
      currentValue: { amount: 415_000, currency: 'EUR' }, contributionStatus: 'active',
      employeeContributionRate: 0.2
    },
    {
      pensionId: 'occupational-paid-up', ownerId: primaryId, type: 'occupational',
      currentValue: { amount: 319_000, currency: 'EUR' }, contributionStatus: 'paid_up'
    },
    {
      pensionId: 'buyout', ownerId: primaryId, type: 'buyout_bond',
      currentValue: { amount: 80_000, currency: 'EUR' }, contributionStatus: 'not_applicable'
    },
    {
      pensionId: 'db-income', ownerId: primaryId, type: 'defined_benefit',
      contributionStatus: 'not_applicable', benefitStartAge: 60,
      projectedAnnualIncome: { amount: 35_000, currency: 'EUR' },
      retirementLumpSum: { amount: 105_000, currency: 'EUR' }
    }
  ]
});
assert.equal(getPensionProjectionReadiness(productProfile).requiredMissing.length, 0);
const productInput = buildPensionProjectionInput(productProfile);
assert.equal(productInput.pensions[0].currentPot, 1_153_000, 'DB income is not counted as a DC pot');
assert.ok(productInput.otherIncomeSources.some((income) => (
  income.id === 'defined-benefit-db-income'
    && income.annualAmountToday === 35_000
    && income.startAge === 60
)));

const statusUnknown = retirementProfile({
  pensions: [{
    pensionId: 'status-unknown', ownerId: primaryId, type: 'occupational',
    currentValue: { amount: 200_000, currency: 'EUR' }
  }]
});
assert.deepEqual(
  getPensionProjectionReadiness(statusUnknown).requiredMissing
    .filter((item) => item.fieldPath.startsWith('/pensions/0/'))
    .map((item) => item.fieldPath),
  ['/pensions/0/contributionStatus'],
  'unknown status is asked before contribution percentages'
);
const statusActive = normalizeHouseholdProfile({
  ...statusUnknown,
  pensions: [{ ...statusUnknown.pensions[0], contributionStatus: 'active' }]
});
assert.deepEqual(
  getPensionProjectionReadiness(statusActive).requiredMissing
    .filter((item) => item.fieldPath.startsWith('/pensions/0/'))
    .map((item) => item.fieldPath).sort(),
  ['/pensions/0/employeeContributionRate', '/pensions/0/employerContributionRate']
);

const dbPositionMapped = mapRealtimeFact(retirementProfile(), {
  factId: 'pension_positions',
  certainty: 'exact',
  value: {
    entityId: 'db-position', owner: 'primary', type: 'defined_benefit',
    amount: 35_000, currency: 'EUR', benefitStartAge: 60,
    projectedAnnualIncome: { amount: 35_000, currency: 'EUR' }
  }
});
assert.equal(dbPositionMapped.canonicalValue[0].currentValue, undefined, 'a DB annual amount is never a pot');
assert.equal(dbPositionMapped.canonicalValue[0].projectedAnnualIncome.amount, 35_000);
assert.equal(dbPositionMapped.canonicalValue[0].contributionStatus, 'not_applicable');

// Unknown answers are keyed to one fact instance, and a scoped decline needs
// the exact signed estimate question.
let instanceProfile = retirementProfile({
  pensions: [
    {
      pensionId: 'pension-one', ownerId: primaryId, type: 'occupational',
      currentValue: { amount: 200_000, currency: 'EUR' }, contributionStatus: 'active'
    },
    {
      pensionId: 'pension-two', ownerId: primaryId, type: 'occupational',
      currentValue: { amount: 300_000, currency: 'EUR' }, contributionStatus: 'active'
    }
  ]
});
const unknownOne = {
  factId: 'pension_employee_contribution_rate',
  value: { entityId: 'pension-one' },
  certainty: 'unknown'
};
instanceProfile = applyFact(instanceProfile, unknownOne);
const firstResponse = instanceProfile.assumptions.values.completionFacts
  .responsesByFactInstance['pension_employee_contribution_rate:pension-one'];
assert.equal(firstResponse.resolution, 'unknown');
assert.equal(instanceProfile.assumptions.values.completionFacts.unknownFactIds
  ?.pension_employee_contribution_rate, undefined, 'scoped unknown does not write a generic marker');

const firstQuestions = buildCanonicalQuestionPlan([{
  moduleId: 'pension_projection', required: true,
  readiness: getPensionProjectionReadiness(instanceProfile)
}], { profile: instanceProfile });
assert.equal(
  firstQuestions.find((need) => need.factInstanceId === 'pension_employee_contribution_rate:pension-one')?.status,
  'estimate_requested'
);
assert.equal(
  firstQuestions.find((need) => need.factInstanceId === 'pension_employee_contribution_rate:pension-two')?.status,
  'open'
);

instanceProfile = applyFact(instanceProfile, unknownOne);
assert.equal(
  instanceProfile.assumptions.values.completionFacts
    .responsesByFactInstance['pension_employee_contribution_rate:pension-one'].resolution,
  'unknown',
  'a repeated scoped unknown is not a decline without the signed estimate question'
);
instanceProfile = applyFact(instanceProfile, unknownOne, {
  nextQuestion: {
    factId: 'pension_employee_contribution_rate',
    factInstanceId: 'pension_employee_contribution_rate:pension-one',
    status: 'estimate_requested'
  }
});
assert.equal(
  instanceProfile.assumptions.values.completionFacts
    .responsesByFactInstance['pension_employee_contribution_rate:pension-one'].resolution,
  'estimate_declined'
);

const unknownTwo = {
  factId: 'pension_employee_contribution_rate',
  value: { entityId: 'pension-two' },
  certainty: 'unknown'
};
instanceProfile = applyFact(instanceProfile, unknownTwo);
const recoveredOne = {
  factId: 'pension_employee_contribution_rate',
  value: { entityId: 'pension-one', value: 0.1, rateUnit: 'decimal' },
  certainty: 'exact'
};
instanceProfile = applyFact(instanceProfile, recoveredOne);
assert.equal(
  instanceProfile.assumptions.values.completionFacts
    .responsesByFactInstance['pension_employee_contribution_rate:pension-one'],
  undefined
);
assert.equal(
  instanceProfile.assumptions.values.completionFacts
    .responsesByFactInstance['pension_employee_contribution_rate:pension-two'].resolution,
  'unknown',
  'answering one pension does not erase another pension response'
);

const legacyScoped = updateCompletion(instanceProfile, {
  unknownFactIds: { pension_employer_contribution_rate: true },
  estimateDeclinedFactIds: { pension_employer_contribution_rate: true }
});
assert.equal(
  completionResponseFor(legacyScoped, {
    factId: 'pension_employer_contribution_rate',
    factInstanceId: 'pension_employer_contribution_rate:pension-one'
  }),
  null,
  'legacy entity-wide markers do not suppress every pension instance'
);
const legacySingleton = updateCompletion(instanceProfile, {
  unknownFactIds: { monthly_spending: true },
  estimateDeclinedFactIds: { monthly_spending: true }
});
assert.equal(
  completionResponseFor(legacySingleton, { factId: 'monthly_spending' }).resolution,
  'estimate_declined',
  'legacy singleton completion markers remain readable'
);

// A declined exact instance remains selected and visible as needs_information,
// but it cannot enter the execution set and its need keeps full identity.
let blockedProfile = retirementProfile({
  pensions: [{
    pensionId: 'blocked-pension', ownerId: primaryId, type: 'occupational',
    currentValue: { amount: 250_000, currency: 'EUR' }, contributionStatus: 'active',
    employerContributionRate: 0.08
  }]
});
blockedProfile = updateCompletion(blockedProfile, {
  responsesByFactInstance: {
    'pension_employee_contribution_rate:blocked-pension': {
      resolution: 'estimate_declined',
      attempts: 2,
      entityId: 'blocked-pension',
      ownerId: blockedProfile.primaryPerson.personId,
      fieldPath: '/pensions/0/employeeContributionRate'
    }
  }
});
const blockedPlan = buildGoalModulePlan(blockedProfile, {
  allowedModuleIds: ['pension_projection', 'personal_balance_sheet']
});
const blockedSlot = blockedPlan.moduleSlots.find((slot) => slot.moduleId === 'pension_projection');
assert.equal(blockedSlot.availability, 'needs_information');
assert.ok(!blockedPlan.executionModuleIds.includes('pension_projection'));
const blockedRecommendations = goalPlanRecommendations(blockedPlan, blockedProfile);
const consumerProjection = toConsumerRealtimePlanningLists({
  moduleSlots: blockedPlan.moduleSlots,
  recommendations: blockedRecommendations
}, blockedProfile);
const projectedNeed = consumerProjection.recommendations
  .find((item) => item.moduleId === 'pension_projection')
  .requiredMissing
  .find((need) => need.factInstanceId === 'pension_employee_contribution_rate:blocked-pension');
assert.equal(projectedNeed.ownerId, blockedProfile.primaryPerson.personId);
assert.equal(projectedNeed.status, 'blocked_unknown');
assert.equal(projectedNeed.answerPolicy, 'unknown_allowed');
assert.match(projectedNeed.prompt, /blocked-pension|occupational pension|percentage/i);
assert.notEqual(
  buildWorkerQuestionPlan(blockedProfile, blockedRecommendations).factInstanceId,
  'pension_employee_contribution_rate:blocked-pension',
  'a declined estimate is not asked again'
);

// The regular proposal path accepts the new semantic facts through the module
// contract and derives active status from a stated current contribution.
const statusProposal = planFactProposal({
  config: { realtimeConversationV2Enabled: true },
  profile: statusUnknown,
  state: { recommendations: [] },
  fact: {
    factId: 'pension_contribution_status',
    value: { entityId: 'status-unknown', value: 'paid_up' },
    certainty: 'exact'
  },
  plannerBatch: true
});
assert.equal(statusProposal.profile.pensions[0].contributionStatus, 'paid_up');

console.info('[ConsumerPhase2Foundations] PASS: owner-aware needs, instance completion, pension readiness and module blocking');
