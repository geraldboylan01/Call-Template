import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PERSONA_CATALOGUE_VERSION,
  buildPersonaModulePlan,
  classifyPlanningPersona,
  createHouseholdProfile,
  getPersonaDefinition,
  listPersonaDefinitions,
  normalizeHouseholdProfile
} from '../js/planning/index.js';
import {
  buildConfirmedRealtimeFactSummary,
  mapRealtimeFact,
  realtimeFactAllowed
} from '../worker/src/consumer/realtime_fact_mapper.js';
import { describeConversationState } from '../worker/src/consumer/conversation.js';
import { extractContextBoundPatch } from '../worker/src/consumer/conversation.js';
import { toPublicRealtimeAnalysisPlan } from '../worker/src/consumer/realtime_repository.js';
import { applyProfilePatch as applyApiProfilePatch } from '../worker/src/consumer/validators.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/consumer-persona-golden.json', import.meta.url), 'utf8'));
const NOW = '2026-07-15T09:00:00.000Z';

function goal(type, index = 0, priority = 'high') {
  return { goalId: `goal-${type}-${index}`, type, title: type, priority, status: 'active' };
}

function profileFor(testCase, extras = {}) {
  const profile = createHouseholdProfile({
    profileId: `persona-${testCase.personaId}`,
    nowIso: NOW,
    calculationDateIso: NOW.slice(0, 10)
  });
  profile.revision = extras.revision || 1;
  profile.assumptions.values.persona = {
    selfDescription: testCase.selfDescription,
    ...(testCase.circumstances || {}),
    ...(extras.persona || {})
  };
  profile.goals = extras.goals || (testCase.goal ? [goal(testCase.goal)] : []);
  return normalizeHouseholdProfile(profile);
}

// These are finalized, natural-language answers with the semantic facts that
// the Realtime/text interpreter is allowed to propose from each answer. The
// test deliberately applies them through the production semantic mapper into
// a blank canonical profile; it does not seed persona fields directly.
const SEMANTIC_CONVERSATION_CONTEXT = Object.freeze({
  student_early_adult: {
    transcript: 'I am a student at the start of adult life and want to understand my financial position.',
    facts: [['self_description', 'student'], ['life_stage', 'student']]
  },
  graduate_young_employee: {
    transcript: 'I recently graduated, I am now an employee, and I want an overview of where I stand.',
    facts: [['self_description', 'graduate'], ['life_stage', 'graduate'], ['employment_context', 'employee']]
  },
  first_time_buyer: {
    transcript: 'I am a first-time buyer and currently work as an employee.',
    facts: [['self_description', 'first_time_buyer'], ['property_status', 'first_time_buyer'], ['employment_context', 'employee']]
  },
  young_professional_delaying_purchase: {
    transcript: 'I am a young professional, but I expect to delay buying a home for now.',
    facts: [['self_description', 'young_professional'], ['life_stage', 'young_professional'], ['property_status', 'delaying_purchase']]
  },
  couple_combining_finances: {
    transcript: 'We are a couple combining our finances and want to understand our joint position.',
    facts: [['self_description', 'combining_finances'], ['household_structure', 'couple'], ['finance_combining', true]]
  },
  new_parent_young_family: {
    transcript: 'We are a young family and new parents with one dependant.',
    facts: [['self_description', 'new_parent'], ['household_structure', 'family'], ['new_parent_status', true], ['dependant_count', 1]]
  },
  established_professional: {
    transcript: 'I am an established professional working as an employee and want to understand my position.',
    facts: [['self_description', 'established_professional'], ['life_stage', 'established_professional'], ['employment_context', 'employee']]
  },
  mid_career_behind_retirement: {
    transcript: 'I am mid-career and feel behind on retirement planning.',
    facts: [['self_description', 'behind_on_retirement'], ['career_stage', 'mid_career'], ['retirement_readiness', 'retirement_behind']]
  },
  self_employed_professional: {
    transcript: 'I am a self-employed professional and want a clear view of my finances.',
    facts: [['self_description', 'self_employed'], ['employment_context', 'self_employed'], ['business_context', 'self_employed']]
  },
  company_director_owner_manager: {
    transcript: 'I am a company director and owner-manager of a business.',
    facts: [['self_description', 'company_director'], ['employment_context', 'company_director'], ['business_context', 'company_director']]
  },
  business_owner_approaching_exit: {
    transcript: 'I own a business and am actively approaching a sale or exit.',
    facts: [['self_description', 'business_exit'], ['business_context', 'business_owner'], ['business_exit_intent', true]]
  },
  farmer_agricultural_business_owner: {
    transcript: 'I am a farmer, operate the farm business, and own agricultural assets.',
    facts: [['self_description', 'farmer'], ['business_context', 'farmer'], ['agricultural_assets', true]]
  },
  pre_retiree: {
    transcript: 'I am approaching retirement, still working, and already have a pension.',
    facts: [['self_description', 'pre_retiree'], ['life_stage', 'pre_retiree'], ['career_stage', 'approaching_retirement'], ['retirement_status', 'approaching_retirement'], ['has_pension', true]]
  },
  newly_retired: {
    transcript: 'I have recently retired and want to understand my financial position.',
    facts: [['self_description', 'newly_retired'], ['life_stage', 'newly_retired'], ['retirement_status', 'newly_retired']]
  },
  older_retiree: {
    transcript: 'I am an older retiree, later in retirement, and want an overview of my position.',
    facts: [['self_description', 'older_retiree'], ['life_stage', 'older_retiree'], ['retirement_status', 'older_retiree']]
  },
  high_net_worth_family: {
    transcript: 'We are a family for whom complex family wealth and legacy planning are material.',
    facts: [['self_description', 'high_net_worth_family'], ['household_structure', 'family'], ['high_net_worth_context', true]]
  },
  parent_funding_education: {
    transcript: 'We are a family with two dependants and funding their education is an explicit priority.',
    facts: [['self_description', 'funding_education'], ['household_structure', 'family'], ['dependant_count', 2], ['education_funding_intent', true]]
  },
  parent_grandparent_transferring_wealth: {
    transcript: 'I am a parent or grandparent and transferring wealth to family is an explicit priority.',
    facts: [['self_description', 'transferring_wealth'], ['household_structure', 'parent_or_grandparent'], ['wealth_transfer_intent', true]]
  },
  lump_sum_recipient: {
    transcript: 'I recently received a lump sum and it is driving this planning conversation.',
    facts: [['self_description', 'lump_sum_recipient'], ['lump_sum_status', true]]
  },
  immediate_financial_decision_user: {
    transcript: 'I have an immediate financial decision and want to review my mortgage path first.',
    facts: [['self_description', 'immediate_decision'], ['immediate_decision_context', true]]
  }
});

function profileFromFinalizedSemanticConversation(testCase) {
  const profile = createHouseholdProfile({
    profileId: `persona-conversation-${testCase.personaId}`,
    nowIso: NOW,
    calculationDateIso: NOW.slice(0, 10)
  });
  profile.revision = 1;
  const context = SEMANTIC_CONVERSATION_CONTEXT[testCase.personaId];
  assert.ok(context, `${testCase.personaId}: finalized semantic conversation fixture exists`);
  assert.ok(context.transcript.length >= 20, `${testCase.personaId}: voice-style transcript is meaningful`);
  const facts = [
    { factId: 'primary_goal', value: testCase.goal || 'understand_position' },
    ...context.facts.map(([factId, value]) => ({ factId, value }))
  ];
  assert.equal(
    new Set(facts.map((fact) => fact.factId)).size,
    facts.length,
    `${testCase.personaId}: a finalized answer proposes each semantic fact at most once`
  );
  let canonical = normalizeHouseholdProfile(profile);
  for (const fact of facts) {
    assert.equal(
      realtimeFactAllowed(fact.factId, new Set()),
      true,
      `${testCase.personaId}: intake fact ${fact.factId} is allowed before module routing`
    );
    const mapped = mapRealtimeFact(canonical, fact);
    canonical = applyApiProfilePatch(
      canonical,
      { [mapped.fieldPath]: mapped.canonicalValue },
      [],
      'ai_extraction'
    );
  }
  return { profile: normalizeHouseholdProfile(canonical), facts, transcript: context.transcript };
}

assert.equal(fixture.fixtureVersion, 1);
assert.equal(fixture.catalogueVersion, PERSONA_CATALOGUE_VERSION);
assert.equal(fixture.cases.length, 20, 'all 20 authoritative personas must have a golden fixture');
assert.equal(listPersonaDefinitions().length, 20, 'catalogue must contain exactly the supplied 20 personas');
assert.equal(new Set(fixture.cases.map((item) => item.personaId)).size, 20, 'persona fixture ids must be unique');

for (const testCase of fixture.cases) {
  const profile = profileFor(testCase);
  const firstAssessment = classifyPlanningPersona(profile);
  const secondAssessment = classifyPlanningPersona(profile);
  assert.deepEqual(secondAssessment, firstAssessment, `${testCase.personaId}: classifier must be deterministic`);
  assert.equal(firstAssessment.primaryPersonaId, testCase.personaId, `${testCase.personaId}: authoritative persona`);
  assert.equal(firstAssessment.catalogueVersion, PERSONA_CATALOGUE_VERSION);
  assert.equal(firstAssessment.profileRevision, profile.revision);
  assert.ok(firstAssessment.score >= 60, `${testCase.personaId}: explicit self-description weight`);
  const plan = buildPersonaModulePlan(profile);
  assert.equal(plan.moduleSlots.length, 3, `${testCase.personaId}: exactly three slots`);
  assert.deepEqual(plan.moduleSlots.map((slot) => slot.slot), [1, 2, 3]);
  assert.deepEqual(plan.moduleSlots.map((slot) => slot.moduleId), testCase.modules, `${testCase.personaId}: ordered default bundle`);
  assert.equal(new Set(plan.moduleSlots.map((slot) => slot.moduleId)).size, 3);
  assert.ok(plan.moduleSlots.some((slot) => slot.moduleId === 'personal_balance_sheet'));
  assert.equal(getPersonaDefinition(testCase.personaId).version, PERSONA_CATALOGUE_VERSION);
  console.info(`[ConsumerPersonaGolden] PASS: ${testCase.personaId}`);
}

// Acceptance gate: every authoritative persona also has to survive the same
// semantic-fact path used by a finalized voice/text answer. This catches drift
// between the Realtime mapper, canonical profile shape, conversation
// orchestrator, classifier, and exact ordered three-slot contract.
for (const testCase of fixture.cases) {
  const conversation = profileFromFinalizedSemanticConversation(testCase);
  const summary = buildConfirmedRealtimeFactSummary(conversation.profile);
  assert.ok(summary.some((fact) => fact.factId === 'primary_goal'), `${testCase.personaId}: mapped goal is canonical`);
  assert.ok(summary.some((fact) => fact.factId === 'self_description'), `${testCase.personaId}: mapped self-description is canonical`);
  for (const fact of conversation.facts) {
    assert.ok(
      summary.some((item) => item.factId === fact.factId),
      `${testCase.personaId}: mapped semantic fact ${fact.factId} is visible to planning state`
    );
  }
  const assessment = classifyPlanningPersona(conversation.profile);
  assert.equal(assessment.primaryPersonaId, testCase.personaId, `${testCase.personaId}: conversation classifier result`);
  const plan = buildPersonaModulePlan(conversation.profile);
  assert.deepEqual(
    plan.moduleSlots.map((slot) => slot.moduleId),
    testCase.modules,
    `${testCase.personaId}: conversation exact ordered three-module bundle`
  );
  const orchestrated = describeConversationState(conversation.profile, {
    allowedModules: [...new Set(fixture.cases.flatMap((item) => item.modules))]
  });
  assert.equal(
    orchestrated.personaAssessment.primaryPersonaId,
    testCase.personaId,
    `${testCase.personaId}: production conversation orchestrator persona`
  );
  assert.deepEqual(
    orchestrated.moduleSlots.map((slot) => slot.moduleId),
    testCase.modules,
    `${testCase.personaId}: production conversation orchestrator bundle`
  );
  console.info(`[ConsumerPersonaConversationGolden] PASS: ${testCase.personaId}`);
}

const ambiguousProfile = createHouseholdProfile({ profileId: 'persona-ambiguous', nowIso: NOW, calculationDateIso: NOW.slice(0, 10) });
ambiguousProfile.revision = 1;
const ambiguous = classifyPlanningPersona(ambiguousProfile);
assert.equal(ambiguous.primaryPersonaId, null);
assert.equal(ambiguous.needsDisambiguation, true);
assert.equal(ambiguous.confidence, 'low');
assert.equal(ambiguous.disambiguationFactId, 'self_description');

const goalOnly = normalizeHouseholdProfile({ ...ambiguousProfile, goals: [goal('buy_home')] });
const tied = classifyPlanningPersona(goalOnly);
assert.equal(tied.primaryPersonaId, 'first_time_buyer', 'specific persona wins stable tie-break');
assert.equal(tied.leadMargin, 0, 'score margin, not tie-break metadata, controls disambiguation');
assert.equal(tied.needsDisambiguation, true);

const homeBuyer = fixture.cases.find((item) => item.personaId === 'first_time_buyer');
const homePlan = buildPersonaModulePlan(profileFor(homeBuyer, { goals: [goal('buy_home')] }));
assert.deepEqual(homePlan.moduleSlots.map((slot) => slot.moduleId), [
  'personal_balance_sheet', 'house_purchase', 'liquidity_analysis'
]);
assert.ok(homePlan.moduleSlots.slice(1).every((slot) => ['persona_default', 'mandatory_rule'].includes(slot.source)));

const overlapBase = fixture.cases.find((item) => item.personaId === 'company_director_owner_manager');
const overlap = profileFor(overlapBase, {
  goals: [goal('buy_home')],
  persona: {
    companyDirector: true,
    employmentContext: 'company_director',
    newParent: true,
    dependantCount: 1,
    propertyStatus: 'first_time_buyer'
  }
});
const overlapPlan = buildPersonaModulePlan(overlap);
assert.equal(overlapPlan.personaAssessment.primaryPersonaId, 'company_director_owner_manager');
assert.deepEqual(overlapPlan.moduleSlots.map((slot) => slot.moduleId), [
  'personal_balance_sheet', 'house_purchase', 'liquidity_analysis'
]);
assert.ok(overlapPlan.overrides.some((override) => override.ruleId === 'persona.override.buy_home_liquidity.v1'));

const selfDescribedDirectorHomeDraft = createHouseholdProfile({
  profileId: 'persona-director-home-disambiguation',
  nowIso: NOW,
  calculationDateIso: NOW.slice(0, 10)
});
selfDescribedDirectorHomeDraft.revision = 2;
selfDescribedDirectorHomeDraft.assumptions.values.persona = { selfDescription: 'company_director' };
selfDescribedDirectorHomeDraft.goals = [goal('buy_home')];
const selfDescribedDirectorHome = normalizeHouseholdProfile(selfDescribedDirectorHomeDraft);
const selfDescribedDirectorAssessment = classifyPlanningPersona(selfDescribedDirectorHome);
assert.equal(selfDescribedDirectorAssessment.leadMargin, 10);
assert.equal(
  selfDescribedDirectorAssessment.needsDisambiguation,
  false,
  'one explicit self-description is the completed disambiguating answer and must not loop'
);
assert.notEqual(
  describeConversationState(selfDescribedDirectorHome, {
    allowedModules: ['house_purchase', 'liquidity_analysis']
  }).nextQuestion?.factId,
  'self_description',
  'the typed journey must not ask for the same self-description again'
);

const studentBase = fixture.cases.find((item) => item.personaId === 'student_early_adult');
const twoGoalOverridePlan = buildPersonaModulePlan(profileFor(studentBase, {
  goals: [goal('optimise_mortgage', 0), goal('transfer_wealth', 1)]
}));
assert.ok(twoGoalOverridePlan.moduleSlots.some((slot) => slot.moduleId === 'mortgage_analysis'));
assert.ok(twoGoalOverridePlan.moduleSlots.some((slot) => slot.moduleId === 'cat_analysis'));
assert.equal(
  new Set(twoGoalOverridePlan.overrides.map((override) => override.slot)).size,
  2,
  'two explicit goal modules must occupy two distinct non-PBS slots'
);

const multiGoalBase = fixture.cases.find((item) => item.personaId === 'established_professional');
const homeAndRetirement = profileFor(multiGoalBase, {
  goals: [goal('buy_home', 0), goal('retire', 1)]
});
const homeAndRetirementPlan = buildPersonaModulePlan(homeAndRetirement);
assert.equal(homeAndRetirementPlan.requiresGoalPriorityQuestion, true, 'home plus a fourth required analysis needs a goal-focus choice');
assert.deepEqual(homeAndRetirementPlan.deferredGoalTypes, ['retire']);
const homeFocusedPlan = buildPersonaModulePlan(profileFor(multiGoalBase, {
  goals: homeAndRetirement.goals,
  persona: { primaryGoalType: 'buy_home' }
}));
assert.equal(homeFocusedPlan.requiresGoalPriorityQuestion, false);
assert.deepEqual(homeFocusedPlan.moduleSlots.map((slot) => slot.moduleId), [
  'personal_balance_sheet', 'house_purchase', 'liquidity_analysis'
]);
assert.deepEqual(homeFocusedPlan.deferredGoalTypes, ['retire']);
const invalidHomeFocusPlan = buildPersonaModulePlan(profileFor(multiGoalBase, {
  goals: homeAndRetirement.goals,
  persona: { primaryGoalType: 'transfer_wealth' }
}));
assert.equal(
  invalidHomeFocusPlan.requiresGoalPriorityQuestion,
  true,
  'a stale focus that is not an active high-priority goal cannot bypass the multi-goal choice'
);

const multiGoal = profileFor(multiGoalBase, {
  goals: [goal('buy_home', 0), goal('retire', 1), goal('assess_decision', 2)],
  persona: { educationFunding: true }
});
const multiPlan = buildPersonaModulePlan(multiGoal);
assert.equal(multiPlan.requiresGoalPriorityQuestion, true);
assert.deepEqual(new Set(multiPlan.deferredGoalTypes), new Set(['retire', 'assess_decision']));
const focusedPlan = buildPersonaModulePlan(profileFor(multiGoalBase, {
  goals: multiGoal.goals,
  persona: { educationFunding: true, primaryGoalType: 'retire' }
}));
assert.equal(focusedPlan.requiresGoalPriorityQuestion, false);
assert.ok(focusedPlan.moduleSlots.some((slot) => slot.moduleId === 'retirement_goal_analysis'));
assert.ok(focusedPlan.deferredGoalTypes.includes('buy_home'));

const immediateBase = fixture.cases.find((item) => item.personaId === 'immediate_financial_decision_user');
const vagueImmediate = profileFor(immediateBase, { goals: [goal('assess_decision')] });
const vagueImmediatePlan = buildPersonaModulePlan(vagueImmediate);
assert.equal(vagueImmediatePlan.requiresDecisionTopicQuestion, true);
const vagueImmediateState = describeConversationState(vagueImmediate, {
  allowedModules: ['house_purchase', 'liquidity_analysis']
});
assert.equal(vagueImmediateState.nextQuestion.factId, 'primary_goal');
assert.match(vagueImmediateState.nextQuestion.prompt, /specific financial decision/i);
assert.deepEqual(vagueImmediateState.moduleSlots, [], 'an unspecified decision must not expose a retirement placeholder plan');

const resolvedImmediatePlan = buildPersonaModulePlan(profileFor(immediateBase, {
  goals: [goal('optimise_mortgage')]
}));
assert.equal(resolvedImmediatePlan.requiresDecisionTopicQuestion, false);
assert.deepEqual(resolvedImmediatePlan.moduleSlots.map((slot) => slot.moduleId), [
  'personal_balance_sheet', 'mortgage_analysis', 'liquidity_analysis'
]);
const wealthImmediatePlan = buildPersonaModulePlan(profileFor(immediateBase, {
  goals: [goal('build_wealth')]
}));
assert.deepEqual(wealthImmediatePlan.moduleSlots.map((slot) => slot.moduleId), [
  'personal_balance_sheet', 'pension_projection', 'liquidity_analysis'
], 'build wealth resolves through the deterministic goal registry to Pension Projection');
const immediateMultiGoalPlan = buildPersonaModulePlan(profileFor(immediateBase, {
  goals: [goal('optimise_mortgage'), goal('transfer_wealth', 1)]
}));
assert.equal(immediateMultiGoalPlan.requiresGoalPriorityQuestion, true);
assert.equal(immediateMultiGoalPlan.deferredGoalTypes.length, 1, 'the second immediate decision is retained for a later plan');

// A vague decision from an under-specified young employee is clarified before
// any module inputs, then the bounded semantic persona scan accepts several
// explicit context facts from one answer and does not ask them again.
const youngEmployee = fixture.cases.find((item) => item.personaId === 'graduate_young_employee');
const youngDecision = profileFor(youngEmployee, {
  goals: [goal('assess_decision'), goal('optimise_mortgage', 1)]
});
const youngScanState = describeConversationState(youngDecision, {
  allowedModules: ['house_purchase', 'liquidity_analysis']
});
assert.equal(youngScanState.requiresDecisionTopicQuestion, false);
assert.equal(youngScanState.requiresPersonaScan, true);
assert.equal(youngScanState.nextQuestion.factId, 'household_structure');
const youngContextPatch = extractContextBoundPatch(
  youngDecision,
  youngScanState.nextQuestion,
  'We are a family with two children. I am employed, we own our home, have no business interest, and I am still working.'
);
assert.equal(youngContextPatch['/assumptions/values/persona/householdStructure'], 'family');
assert.equal(youngContextPatch['/assumptions/values/persona/dependantCount'], 2);
assert.equal(youngContextPatch['/assumptions/values/persona/employmentContext'], 'employee');
assert.equal(youngContextPatch['/assumptions/values/persona/propertyStatus'], 'homeowner');
assert.equal(youngContextPatch['/assumptions/values/persona/businessContext'], 'no_business_interest');
assert.equal(youngContextPatch['/assumptions/values/persona/retirementStatus'], 'working');
const youngAfterScan = applyApiProfilePatch(youngDecision, youngContextPatch, [], 'consumer_edit');
const youngAfterScanState = describeConversationState(youngAfterScan, {
  allowedModules: ['house_purchase', 'liquidity_analysis']
});
assert.equal(youngAfterScanState.requiresPersonaScan, false, 'volunteered semantic scan facts are reused');
assert.equal(
  ['household_structure', 'employment_context', 'property_status', 'dependant_count', 'business_context', 'retirement_status']
    .includes(youngAfterScanState.nextQuestion?.factId),
  false,
  'the completed bounded scan must move on rather than repeat a volunteered context fact'
);

const directorContext = profileFor(overlapBase, { goals: [goal('business_planning')] });
const directorScanState = describeConversationState(directorContext, { allowedModules: [] });
assert.equal(directorScanState.nextQuestion.factId, 'household_structure');
const directorPatch = extractContextBoundPatch(
  directorContext,
  directorScanState.nextQuestion,
  'This is for me and my partner; we have no children, rent our home, and I am a company director with a business. I am still working.'
);
const directorAfterScan = applyApiProfilePatch(directorContext, directorPatch, [], 'consumer_edit');
const directorAfterScanState = describeConversationState(directorAfterScan, { allowedModules: [] });
assert.equal(directorAfterScanState.requiresPersonaScan, false);
assert.equal(directorAfterScanState.personaAssessment.primaryPersonaId, 'company_director_owner_manager');
assert.equal(directorAfterScan.assumptions.values.persona.householdStructure, 'couple');
assert.equal(directorAfterScan.assumptions.values.persona.dependantCount, 0);
assert.equal(directorAfterScan.assumptions.values.persona.businessContext, 'company_director');

const mappedProfile = profileFor(homeBuyer);
const mapped = mapRealtimeFact(mappedProfile, { factId: 'employment_context', value: 'self-employed' });
assert.equal(mapped.fieldPath, '/assumptions/values/persona/employmentContext');
assert.equal(mapped.canonicalValue, 'self_employed');
assert.equal(realtimeFactAllowed('employment_context', new Set()), true, 'intake facts are allowed before module routing');
assert.equal(realtimeFactAllowed('mortgage_current_balance', new Set(['liquidity_analysis'])), false);
assert.equal(realtimeFactAllowed('mortgage_current_balance', new Set(['mortgage_analysis'])), true);
assert.ok(buildConfirmedRealtimeFactSummary(mappedProfile).some((fact) => fact.factId === 'self_description'));

const newPension = mapRealtimeFact(mappedProfile, { factId: 'pension_employee_contribution_rate', value: 8 });
assert.equal(newPension.fieldPath, '/pensions/0');
assert.equal(newPension.canonicalValue.employeeContributionRate, 0.08, 'spoken whole percentages normalize to decimals');
const pensionProfile = normalizeHouseholdProfile({
  ...mappedProfile,
  pensions: [newPension.canonicalValue]
});
const pensionLeaf = mapRealtimeFact(pensionProfile, { factId: 'pension_current_value', value: 50000 });
assert.equal(pensionLeaf.fieldPath, '/pensions/0/currentValue', 'later pension facts patch only their leaf');
assert.deepEqual(pensionLeaf.canonicalValue, { amount: 50000, currency: 'EUR' });
const newMortgage = mapRealtimeFact(mappedProfile, { factId: 'mortgage_current_balance', value: 180000 });
assert.equal(newMortgage.fieldPath, '/liabilities/0');
const mortgageProfile = normalizeHouseholdProfile({
  ...mappedProfile,
  liabilities: [newMortgage.canonicalValue]
});
const mortgageLeaf = mapRealtimeFact(mortgageProfile, { factId: 'mortgage_annual_interest_rate', value: 3.5 });
assert.equal(mortgageLeaf.fieldPath, '/liabilities/0/annualInterestRate', 'later mortgage facts patch only their leaf');
assert.equal(mortgageLeaf.canonicalValue, 0.035);

const persistedPlanInput = {
  moduleIds: ['house_purchase', 'liquidity_analysis'],
  personaAssessment: overlapPlan.personaAssessment,
  moduleSlots: overlapPlan.moduleSlots,
  overrides: overlapPlan.overrides,
  requiresGoalPriorityQuestion: false,
  deferredGoalTypes: []
};
const persistedPlan = toPublicRealtimeAnalysisPlan({
  id: 'realtime_plan_test', realtime_session_id: 'rt_test', profile_revision: 7,
  status: 'prepared', analysis_run_id: null, error_code: null,
  created_at: NOW, confirmed_at: null, completed_at: null,
  module_ids_json: JSON.stringify({ schemaVersion: 2, encryptedInput: true })
}, persistedPlanInput);
assert.equal(persistedPlan.moduleSlots.length, 3, 'all three display slots survive persistence');
assert.equal(persistedPlan.personaAssessment.primaryPersonaId, 'company_director_owner_manager');
assert.equal(persistedPlan.personaAssessment.scoredCandidates, undefined, 'internal scores must not cross the public plan boundary');
assert.deepEqual(persistedPlan.moduleIds, ['house_purchase', 'liquidity_analysis'], 'execution ids remain separate from display slots');

console.info('[ConsumerPersonaGolden] 20/20 persona bundles plus overlap, ambiguity, focus and semantic-fact controls passed.');
