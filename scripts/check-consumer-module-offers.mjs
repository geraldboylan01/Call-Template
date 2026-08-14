// Offer-then-collect.
//
// A relevant module is offered in one turn -- anchored to something the client
// said, explained in ordinary language, and asked -- before any of its own
// questions are asked and before it can run. These assertions hold that order:
// offer, accept or decline, collect, confirm, execute.

import assert from 'node:assert/strict';

import {
  MAX_CONSUMER_ANALYSES,
  MODULE_IDS,
  applyModuleDeferral,
  applyModuleReplacement,
  buildGoalModulePlan,
  composeCapacityChoice,
  isConsumerVisibleModule,
  nextPlanningCycleValues,
  planningCycleNumber,
  composeModuleOffer,
  consumerLanguageForModule,
  containsInternalModuleTerminology,
  confirmationSummary,
  createHouseholdProfile,
  getModuleManifest,
  goalPlanRecommendations,
  nextModuleOffer,
  normalizeHouseholdProfile,
  runConsumerAnalysis
} from '../js/planning/index.js';

const NOW = '2026-07-26T09:00:00.000Z';
const ALL = Object.values(MODULE_IDS);
const APPROVED_CONSUMER_MODULE_IDS = Object.freeze([
  MODULE_IDS.PERSONAL_BALANCE_SHEET,
  MODULE_IDS.LIQUIDITY,
  MODULE_IDS.HOUSE_PURCHASE,
  MODULE_IDS.MORTGAGE,
  MODULE_IDS.LOAN,
  MODULE_IDS.PENSION_PROJECTION,
  MODULE_IDS.COLLEGE_FUNDING
]);
const ADVISER_MODULE_NAMES = Object.freeze([
  'Personal balance sheet',
  'Liquidity reserve',
  'House purchase planner',
  'Mortgage analysis',
  'Loan analysis',
  'Pension projection',
  'College funding'
]);
const FORMAL_MODULE_NAMES = Object.freeze([
  'Personal Balance Sheet',
  'Liquidity Analysis',
  'House Purchase',
  'Mortgage Analysis',
  'Loan Analysis',
  'Pension Projection',
  'College Funding',
  ...ADVISER_MODULE_NAMES
]);
const FORBIDDEN_SPOKEN_TERMS = Object.freeze([
  ...FORMAL_MODULE_NAMES,
  ...APPROVED_CONSUMER_MODULE_IDS,
  MODULE_IDS.NET_RETIREMENT
]);
let failures = 0;
const pendingChecks = [];

function assertNoInternalTerminology(text, context = 'consumer wording') {
  assert.equal(typeof text, 'string', `${context} must be text`);
  const normalised = text.toLowerCase();
  for (const term of FORBIDDEN_SPOKEN_TERMS) {
    assert.ok(
      !normalised.includes(term.toLowerCase()),
      `${context} must not expose ${term}`
    );
  }
}

function check(name, fn) {
  const done = (error) => {
    if (error) {
      failures += 1;
      console.error(`[ModuleOffers] FAIL: ${name}\n    ${error.message}`);
    } else {
      console.info(`[ModuleOffers] PASS: ${name}`);
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      pendingChecks.push(result.then(() => done(), done));
      return undefined;
    }
    done();
  } catch (error) {
    done(error);
  }
  return undefined;
}

function profileFor({ persona = {}, planning = {}, goals = ['understand_position'], liabilities = [] } = {}) {
  const base = createHouseholdProfile({ profileId: 'offer', nowIso: NOW, calculationDateIso: NOW.slice(0, 10) });
  return normalizeHouseholdProfile({
    ...base,
    revision: 1,
    primaryPerson: { ...base.primaryPerson, age: 45 },
    goals: goals.map((type, index) => ({
      goalId: `goal-${index}`, type, title: type, priority: 'high', status: 'active'
    })),
    liabilities,
    assumptions: { ...base.assumptions, values: { ...base.assumptions.values, persona, planning } }
  });
}

/** A household that has told us about its mortgage, but not asked about it. */
const WITH_MORTGAGE = [{
  liabilityId: 'home-loan',
  ownerIds: ['primary'],
  type: 'mortgage',
  label: 'Home mortgage',
  currentBalance: { amount: 250_000, currency: 'EUR' }
}];

function planFor(options) {
  const profile = profileFor(options);
  return { profile, plan: buildGoalModulePlan(profile, { allowedModuleIds: ALL }) };
}

/** The facts the meeting would actually queue, i.e. from selected modules only. */
function queuedFactIds(plan, profile) {
  return new Set(goalPlanRecommendations(plan, profile)
    .flatMap((item) => (item.readiness?.requiredMissing || []).map((missing) => missing.fieldPath)));
}

const HOMEOWNER = { propertyStatus: 'homeowner' };

// ---------------------------------------------------------------------------
// The offer itself
// ---------------------------------------------------------------------------

check('an offer names a circumstance the client actually supplied', () => {
  const { profile, plan } = planFor({ liabilities: WITH_MORTGAGE });
  const offer = nextModuleOffer(plan, { profile });
  assert.ok(offer, 'a recorded mortgage should produce an offer');
  assert.equal(offer.moduleId, MODULE_IDS.MORTGAGE);
  assert.equal(offer.anchor, 'you have a mortgage');
  assert.equal(offer.anchorSource, 'circumstance');
  assert.match(offer.spokenOffer, /^You mentioned you have a mortgage\. We can /);
  assert.match(offer.spokenOffer, /Would you like to examine that\?$/);
  assertNoInternalTerminology(offer.spokenOffer, 'circumstance-based offer');
});

check('the offer description and question come from the module manifest', () => {
  const { profile, plan } = planFor({ liabilities: WITH_MORTGAGE });
  const offer = nextModuleOffer(plan, { profile });
  const manifestLanguage = getModuleManifest(MODULE_IDS.MORTGAGE).consumerLanguage;
  assert.equal(offer.offerDescription, manifestLanguage.consumerOfferDescription);
  assert.equal(offer.benefit, manifestLanguage.consumerOfferDescription,
    'the compatibility field must carry the validated offer description');
  assert.equal(offer.offerQuestion, manifestLanguage.offerQuestion);
  assert.ok(offer.spokenOffer.includes(offer.offerDescription));
  assert.ok(offer.spokenOffer.endsWith(offer.offerQuestion));
});

check('mortgage and loan offers are distinct analyses, not one another', () => {
  const mortgage = consumerLanguageForModule(MODULE_IDS.MORTGAGE).offerDescription;
  const loan = consumerLanguageForModule(MODULE_IDS.LOAN).offerDescription;
  assert.notEqual(mortgage, loan);
  assert.match(mortgage, /mortgage/i);
  assert.match(loan, /repayments?/i);
  assertNoInternalTerminology(mortgage, 'mortgage offer description');
  assertNoInternalTerminology(loan, 'loan offer description');
});

check('a direct explicit goal anchors an offer without a separate circumstance', () => {
  const profile = profileFor({ goals: ['optimise_mortgage'] });
  const offer = composeModuleOffer({
    moduleId: MODULE_IDS.MORTGAGE,
    state: 'offerable',
    supportingFactIds: []
  }, { profile });
  assert.ok(offer);
  assert.equal(offer.anchorSource, 'client_request');
  assert.equal(offer.anchor, 'You asked about your mortgage');
  assert.match(offer.spokenOffer, /^You asked about your mortgage\. We can /);
  assertNoInternalTerminology(offer.spokenOffer, 'direct-goal offer');
});

check('an offer that cannot be anchored to a stated fact is not made', () => {
  const opportunity = {
    moduleId: MODULE_IDS.MORTGAGE, state: 'offerable', supportingFactIds: ['property_status']
  };
  // No property status recorded, so there is nothing to quote back.
  assert.equal(composeModuleOffer(opportunity, { profile: profileFor() }), null);
});

check('only one module is offered at a time', () => {
  const { profile, plan } = planFor({
    persona: { hasPension: true, dependantCount: 2, educationFunding: true },
    liabilities: WITH_MORTGAGE
  });
  assert.ok(plan.moduleOpportunities.length > 1, 'this client has several relevant modules');
  const offer = nextModuleOffer(plan, { profile });
  assert.ok(offer && typeof offer.spokenOffer === 'string');
  assert.equal((offer.spokenOffer.match(/\?/g) || []).length, 1, 'one offer asks one decision question');
  assert.ok(offer.spokenOffer.endsWith(offer.offerQuestion));
});

check('homeownership and dependants alone do not create mortgage or college offers', () => {
  const { plan } = planFor({ persona: { ...HOMEOWNER, dependantCount: 2 } });
  assert.ok(!plan.moduleOpportunities.some((item) => item.moduleId === MODULE_IDS.MORTGAGE));
  assert.ok(!plan.moduleOpportunities.some((item) => item.moduleId === MODULE_IDS.COLLEGE_FUNDING));
});

check('explicit education intent creates a college offer', () => {
  const { plan } = planFor({ persona: { dependantCount: 2, educationFunding: true } });
  const opportunity = plan.moduleOpportunities.find((item) => item.moduleId === MODULE_IDS.COLLEGE_FUNDING);
  assert.ok(opportunity);
  assert.deepEqual(opportunity.supportingFactIds, ['education_funding_intent']);
});

check('every approved module resolves to manifest-owned client language', () => {
  for (const moduleId of APPROVED_CONSUMER_MODULE_IDS) {
    const language = consumerLanguageForModule(moduleId);
    assert.ok(language, `${moduleId} needs client language`);
    assert.deepEqual(Object.keys(language), [
      'moduleId',
      'offerDescription',
      'shortDescription',
      'confirmationDescription',
      'offerQuestion'
    ]);
    assert.equal(language.moduleId, moduleId, 'wording remains attached to its exact id');
    for (const [field, value] of Object.entries(language)) {
      if (field === 'moduleId') continue;
      assert.ok(value.trim().length > 0, `${moduleId}.${field} must not be empty`);
      assertNoInternalTerminology(value, `${moduleId}.${field}`);
    }
  }
});

check('offers for all approved modules contain no formal names or ids', () => {
  const goalByModule = {
    [MODULE_IDS.PERSONAL_BALANCE_SHEET]: 'understand_position',
    [MODULE_IDS.LIQUIDITY]: 'maintain_liquidity',
    [MODULE_IDS.HOUSE_PURCHASE]: 'buy_home',
    [MODULE_IDS.MORTGAGE]: 'optimise_mortgage',
    [MODULE_IDS.LOAN]: 'manage_loan',
    [MODULE_IDS.PENSION_PROJECTION]: 'improve_pension',
    [MODULE_IDS.COLLEGE_FUNDING]: 'fund_education'
  };
  for (const moduleId of APPROVED_CONSUMER_MODULE_IDS) {
    const profile = profileFor({ goals: [goalByModule[moduleId]] });
    const offer = composeModuleOffer({ moduleId, state: 'offerable', supportingFactIds: [] }, { profile });
    assert.ok(offer, `${moduleId} should be anchored by its direct goal`);
    assert.equal(offer.moduleId, moduleId);
    assertNoInternalTerminology(offer.spokenOffer, `${moduleId} offer`);
  }
});

check('formal module names remain available to internal and adviser surfaces', () => {
  assert.deepEqual(
    APPROVED_CONSUMER_MODULE_IDS.map((moduleId) => getModuleManifest(moduleId).name),
    ADVISER_MODULE_NAMES
  );
});

check('the legacy-copy boundary detects formal catalogue names and ids', () => {
  for (const legacyCopy of [
    ...FORMAL_MODULE_NAMES.map((name) => `Run ${name} next.`),
    ...ALL.map((moduleId) => `Run ${moduleId} next.`),
    'Run House Purchase next.',
    'Run Liquidity Analysis next.',
    'Use the net retirement cash-flow view.'
  ]) {
    assert.equal(
      containsInternalModuleTerminology(legacyCopy),
      true,
      `${legacyCopy} must be caught at the consumer boundary`
    );
  }
  assert.equal(
    containsInternalModuleTerminology('Project whether your pension may be on track.'),
    false
  );
});

check('overall-position offer mentions retirement only when the client raised it', () => {
  const ordinary = consumerLanguageForModule(MODULE_IDS.PERSONAL_BALANCE_SHEET, {
    profile: profileFor({ goals: ['understand_position'] })
  });
  const retirement = consumerLanguageForModule(MODULE_IDS.PERSONAL_BALANCE_SHEET, {
    profile: profileFor({ goals: ['understand_position', 'retire'] })
  });
  assert.doesNotMatch(ordinary.offerDescription, /retirement/i);
  assert.match(retirement.offerDescription, /including retirement/i);
});

check('college offer handles one or multiple children and both living scenarios naturally', () => {
  const opportunity = {
    moduleId: MODULE_IDS.COLLEGE_FUNDING,
    state: 'offerable',
    supportingFactIds: ['dependant_count']
  };
  const one = composeModuleOffer(opportunity, {
    profile: profileFor({ persona: { dependantCount: 1 } })
  });
  const many = composeModuleOffer(opportunity, {
    profile: profileFor({ persona: { dependantCount: 3 } })
  });
  assert.match(one.spokenOffer, /you have a child to plan for/i);
  assert.match(many.spokenOffer, /you have 3 children to plan for/i);
  for (const offer of [one, many]) {
    assert.match(offer.spokenOffer, /each child you want to support/i);
    assert.match(offer.spokenOffer, /living at home/i);
    assert.match(offer.spokenOffer, /accommodation away from home/i);
    assertNoInternalTerminology(offer.spokenOffer, 'college offer');
  }
});

check('pension offer states controlled assumptions without guaranteeing returns', () => {
  const profile = profileFor({ goals: ['improve_pension'] });
  const offer = composeModuleOffer({
    moduleId: MODULE_IDS.PENSION_PROJECTION,
    state: 'offerable',
    supportingFactIds: []
  }, { profile });
  assert.match(offer.spokenOffer, /5% annual investment growth/i);
  assert.match(offer.spokenOffer, /medium-risk diversified portfolio/i);
  assert.match(offer.spokenOffer, /2% annual inflation/i);
  assert.match(offer.spokenOffer, /returns are not guaranteed/i);
  assert.doesNotMatch(offer.spokenOffer, /returns are guaranteed|will return|will grow by 5%/i);
  assertNoInternalTerminology(offer.spokenOffer, 'pension offer');
});

check('a module that is not consumer-visible is never offered or mentioned', () => {
  const { profile, plan } = planFor({
    persona: { ...HOMEOWNER, retirementStatus: 'approaching_retirement', dependantCount: 1 }
  });
  const serialised = JSON.stringify({
    opportunities: plan.moduleOpportunities,
    offer: nextModuleOffer(plan, { profile }),
    confirmation: confirmationSummary(plan)
  });
  for (const hidden of ['net_retirement_cashflow', 'protection_analysis', 'cat_analysis']) {
    assert.ok(!serialised.includes(hidden), `${hidden} must never reach a consumer surface`);
  }
  assert.equal(consumerLanguageForModule(MODULE_IDS.NET_RETIREMENT), null);
  assert.equal(composeModuleOffer({
    moduleId: MODULE_IDS.NET_RETIREMENT,
    state: 'offerable',
    supportingFactIds: ['retirement_status']
  }, { profile }), null);
});

// ---------------------------------------------------------------------------
// Collect only after acceptance
// ---------------------------------------------------------------------------

check('module-specific questions do not start before acceptance', () => {
  const { profile, plan } = planFor({ persona: HOMEOWNER, liabilities: WITH_MORTGAGE });
  const queued = queuedFactIds(plan, profile);
  for (const path of [...queued]) {
    assert.ok(
      !path.includes('annualInterestRate') && !path.includes('remainingTermMonths'),
      `mortgage-specific question ${path} was queued before the client accepted`
    );
  }
});

check('accepting a module activates its required-fact collection', () => {
  const before = planFor({ persona: HOMEOWNER, liabilities: WITH_MORTGAGE });
  const after = planFor({
    persona: HOMEOWNER,
    liabilities: WITH_MORTGAGE,
    planning: {
      acceptedModuleIds: [MODULE_IDS.MORTGAGE],
      confirmedModuleIds: [MODULE_IDS.MORTGAGE]
    }
  });
  const beforeFacts = queuedFactIds(before.plan, before.profile);
  const afterFacts = queuedFactIds(after.plan, after.profile);
  assert.ok(afterFacts.size > beforeFacts.size, 'acceptance must open the module’s question queue');
  assert.ok(
    [...afterFacts].some((path) => path.includes('annualInterestRate')),
    'the mortgage rate and term questions should now be queued'
  );
});

check('declining a module prevents its questions and its execution', () => {
  const { profile, plan } = planFor({
    persona: HOMEOWNER,
    liabilities: WITH_MORTGAGE,
    planning: { declinedModuleIds: [MODULE_IDS.MORTGAGE] }
  });
  const declined = plan.moduleOpportunities.find((item) => item.moduleId === MODULE_IDS.MORTGAGE);
  assert.equal(declined.state, 'declined');
  assert.equal(nextModuleOffer(plan, { profile }), null, 'a declined module must not be offered again');
  assert.ok(!plan.executionModuleIds.includes(MODULE_IDS.MORTGAGE));
  const queued = queuedFactIds(plan, profile);
  assert.ok(![...queued].some((path) => path.includes('annualInterestRate')));
});

// ---------------------------------------------------------------------------
// Confirm, then execute exactly
// ---------------------------------------------------------------------------

check('an accepted module does not execute before the set is confirmed', () => {
  const { plan } = planFor({
    persona: HOMEOWNER,
    liabilities: WITH_MORTGAGE,
    planning: { acceptedModuleIds: [MODULE_IDS.MORTGAGE] }
  });
  assert.ok(!plan.executionModuleIds.includes(MODULE_IDS.MORTGAGE));
});

check('the confirmation uses outcome phrases while retaining exact module ids', () => {
  const { plan } = planFor({
    persona: HOMEOWNER,
    liabilities: WITH_MORTGAGE,
    planning: {
      acceptedModuleIds: [MODULE_IDS.MORTGAGE],
      confirmedModuleIds: [MODULE_IDS.MORTGAGE]
    }
  });
  const summary = confirmationSummary(plan);
  assert.deepEqual(
    summary.modules.map((item) => item.description),
    summary.moduleIds.map((moduleId) => (
      consumerLanguageForModule(moduleId).confirmationDescription
    ))
  );
  for (const item of summary.modules) {
    assert.ok(summary.spoken.includes(item.description), `${item.description} must be confirmed`);
    assert.equal(item.name, item.description, 'the compatibility alias must also be client-safe');
  }
  assert.match(summary.spoken, /^So I will /);
  assert.match(summary.spoken, /Have I got that right\?$/);
  assertNoInternalTerminology(summary.spoken, 'final confirmation');
  assert.deepEqual(summary.moduleIds, plan.executionModuleIds);
});

check('a hidden analysis cannot be smuggled into final confirmation', () => {
  const summary = confirmationSummary({
    moduleSlots: [
      { moduleId: MODULE_IDS.NET_RETIREMENT, source: 'goal_direct', reasons: [] },
      { moduleId: MODULE_IDS.PERSONAL_BALANCE_SHEET, source: 'goal_direct', reasons: [] }
    ]
  });
  assert.deepEqual(summary.moduleIds, [MODULE_IDS.PERSONAL_BALANCE_SHEET]);
  assertNoInternalTerminology(summary.spoken, 'hidden-module confirmation');
  assert.doesNotMatch(summary.spoken, /retirement cashflow/i);
});

check('execution runs exactly the confirmed set', async () => {
  const { profile, plan } = planFor({
    persona: HOMEOWNER,
    liabilities: WITH_MORTGAGE,
    planning: {
      acceptedModuleIds: [MODULE_IDS.MORTGAGE],
      confirmedModuleIds: [MODULE_IDS.MORTGAGE]
    }
  });
  const confirmed = confirmationSummary(plan).moduleIds;
  const result = await runConsumerAnalysis({
    profile, moduleIds: confirmed, allowedModuleIds: ALL, calculatedAt: NOW
  });
  assert.deepEqual(
    result.analysisPlan.selectedModules.map((item) => item.moduleId).sort(),
    [...confirmed].sort()
  );
});

// ---------------------------------------------------------------------------
// Driven by accumulated state, not the latest turn
// ---------------------------------------------------------------------------

check('the same accumulated state produces the same offer', () => {
  const first = planFor({ persona: HOMEOWNER, liabilities: WITH_MORTGAGE });
  const second = planFor({ persona: HOMEOWNER, liabilities: WITH_MORTGAGE });
  assert.equal(
    nextModuleOffer(first.plan, { profile: first.profile }).spokenOffer,
    nextModuleOffer(second.plan, { profile: second.profile }).spokenOffer
  );
});

check('an offer survives an unrelated later turn', () => {
  const before = planFor({ persona: HOMEOWNER, liabilities: WITH_MORTGAGE });
  const after = planFor({ persona: { ...HOMEOWNER, hasPension: true }, liabilities: WITH_MORTGAGE });
  const stillOffered = after.plan.moduleOpportunities.map((item) => item.moduleId);
  assert.ok(
    stillOffered.includes(MODULE_IDS.MORTGAGE),
    'the mortgage opportunity must not vanish because a later turn was about pensions'
  );
  assert.ok(before.plan.moduleOpportunities.length < after.plan.moduleOpportunities.length);
});

check('an offer is composed from the profile, never from a transcript', () => {
  const { profile, plan } = planFor({ persona: HOMEOWNER, liabilities: WITH_MORTGAGE });
  const offer = nextModuleOffer(plan, { profile });
  // Composition takes only the plan and the profile. There is no transcript
  // parameter to pass, so however fast the voice replies, it cannot change which
  // module is offered -- only accumulated structured state can.
  assert.deepEqual(offer, nextModuleOffer(buildGoalModulePlan(profile, { allowedModuleIds: ALL }), { profile }));
  assert.equal(composeModuleOffer({ ...plan.moduleOpportunities[0], state: 'candidate' }, { profile }), null,
    'only an offerable opportunity may be spoken');
});


// ---------------------------------------------------------------------------
// Multiple goals, ranking, and the three-analysis product limit.
// ---------------------------------------------------------------------------

function multiPlan({ goals, planning = {}, persona = {}, liabilities = [] }) {
  const profile = profileFor({ goals, planning, persona, liabilities });
  return { profile, plan: buildGoalModulePlan(profile, { allowedModuleIds: ALL }) };
}

check('unrelated goals both reach the final set', () => {
  const { plan } = multiPlan({ goals: ['understand_position', 'fund_education'] });
  const ids = plan.moduleSlots.map((slot) => slot.moduleId);
  assert.ok(ids.includes(MODULE_IDS.PERSONAL_BALANCE_SHEET));
  assert.ok(ids.includes(MODULE_IDS.COLLEGE_FUNDING));
  assert.deepEqual([...plan.executionModuleIds].sort(), [...ids].sort());
});

check('a primary goal changes rank without deleting secondary goals', () => {
  const { plan } = multiPlan({
    goals: ['buy_home', 'retire'],
    planning: { primaryGoalType: 'retire' }
  });
  const ids = plan.moduleSlots.map((slot) => slot.moduleId);
  assert.equal(ids[0], MODULE_IDS.PENSION_PROJECTION, 'the primary goal ranks first');
  assert.ok(ids.includes(MODULE_IDS.HOUSE_PURCHASE), 'the secondary goal must survive');
  assert.ok(!plan.deferredGoalTypes.includes('buy_home'), 'a served goal is not deferred');
});

check('no primary answer still produces a provisional set', () => {
  const { plan } = multiPlan({ goals: ['buy_home', 'retire'] });
  assert.equal(plan.requiresGoalPriorityQuestion, true, 'the client should still be asked');
  assert.equal(plan.moduleSlots.length, 3, 'but the plan must not be empty while unanswered');
  assert.ok(plan.executionModuleIds.length > 0);
});

check('a consumer-hidden module never consumes a slot', () => {
  const { plan } = multiPlan({ goals: ['retire'] });
  const ids = plan.moduleSlots.map((slot) => slot.moduleId);
  assert.ok(!ids.includes('net_retirement_cashflow'), 'a gated analysis must not take a slot');
  // Every slot that was spent produces something.
  assert.deepEqual(plan.executionModuleIds, ids);
});

check('never more than three analyses, across goals and accepted offers', () => {
  const { plan } = multiPlan({
    goals: ['understand_position', 'optimise_mortgage', 'fund_education'],
    planning: { acceptedModuleIds: ['loan_analysis', 'pension_projection'] },
    persona: { hasPension: true }
  });
  assert.equal(plan.moduleSlots.length, MAX_CONSUMER_ANALYSES);
  assert.ok(plan.executionModuleIds.length <= MAX_CONSUMER_ANALYSES);
  assert.ok(plan.capacity.overflowModuleIds.length > 0, 'the surplus must be recorded, not dropped');
});

check('an explicitly requested analysis outranks a circumstance discovery', () => {
  const { plan } = multiPlan({
    goals: ['understand_position', 'optimise_mortgage', 'fund_education'],
    planning: { acceptedModuleIds: ['loan_analysis'] }
  });
  assert.equal(plan.moduleSlots[0].moduleId, 'loan_analysis', 'a client request ranks top');
  assert.equal(plan.moduleSlots[0].source, 'client_accepted_offer');
});

// ---------------------------------------------------------------------------
// The product-limit conversation
// ---------------------------------------------------------------------------

const FULL_PLAN = {
  goals: ['understand_position', 'optimise_mortgage', 'fund_education'],
  persona: { hasPension: true }
};

check('a fourth relevant analysis triggers the honest product-limit explanation', () => {
  const { profile, plan } = multiPlan(FULL_PLAN);
  assert.equal(plan.capacity.atLimit, true);
  const choice = composeCapacityChoice(plan, { profile });
  assert.ok(choice, 'a fourth relevant analysis must produce the limit explanation');
  assert.match(choice.spoken, /At the moment the application can run up to 3 analyses/);
  // Honest about being a product constraint, never a planning rule.
  assert.doesNotMatch(choice.spoken, /three is enough|best practice|we recommend only/i);
  assert.equal(choice.maximumAnalyses, MAX_CONSUMER_ANALYSES);
  assertNoInternalTerminology(choice.spoken, 'capacity explanation');
});

check('the explanation describes the current three and proposed fourth by outcome', () => {
  const { profile, plan } = multiPlan(FULL_PLAN);
  const choice = composeCapacityChoice(plan, { profile });
  const expectedCurrent = plan.moduleSlots.map((slot) => (
    consumerLanguageForModule(slot.moduleId, { profile }).shortDescription
  ));
  assert.deepEqual(choice.currentDescriptions, expectedCurrent);
  assert.deepEqual(choice.currentNames, expectedCurrent, 'the compatibility alias is client-safe');
  for (const description of choice.currentDescriptions) {
    assert.ok(choice.spoken.includes(description), `${description} must be described`);
    assertNoInternalTerminology(description, 'current capacity choice');
  }
  assert.equal(
    choice.candidateDescription,
    consumerLanguageForModule(choice.candidateModuleId, { profile }).shortDescription
  );
  assert.ok(choice.spoken.includes(choice.candidateDescription), 'the fourth outcome must be described');
  assert.match(choice.spoken, /could also be useful/, 'it must say why the fourth is relevant');
  assert.match(choice.spoken, /keep the current three and leave it for a separate follow-up/);
  assertNoInternalTerminology(choice.candidateDescription, 'fourth capacity choice');
});

check('replacement choices use descriptions and resolve to exact module ids', () => {
  const { profile, plan } = multiPlan(FULL_PLAN);
  const choice = composeCapacityChoice(plan, { profile });
  assert.deepEqual(choice.currentModuleIds, plan.moduleSlots.map((slot) => slot.moduleId));
  assert.deepEqual(
    choice.replacementChoices,
    choice.currentModuleIds.map((moduleId, index) => ({
      moduleId,
      description: choice.currentDescriptions[index]
    }))
  );
  for (const replacement of choice.replacementChoices) {
    assert.ok(choice.replacementPrompt.includes(replacement.description));
  }
  assert.ok(choice.replacementPrompt.includes(choice.candidateDescription));
  assertNoInternalTerminology(choice.replacementPrompt, 'replacement prompt');
  assert.ok(!Object.hasOwn(choice, 'recommendedRemoval'));
  assert.doesNotMatch(choice.replacementPrompt, /recommend|best one to remove|drop the/i);
});

check('deferral acknowledgement uses only client-outcome wording', () => {
  const { profile, plan } = multiPlan(FULL_PLAN);
  const choice = composeCapacityChoice(plan, { profile });
  for (const description of [...choice.currentDescriptions, choice.candidateDescription]) {
    assert.ok(choice.deferralAcknowledgement.includes(description));
  }
  assert.match(choice.deferralAcknowledgement, /separate follow-up/);
  assertNoInternalTerminology(choice.deferralAcknowledgement, 'deferral acknowledgement');
});

check('capacity composition refuses a hidden current or proposed analysis', () => {
  const hiddenCandidate = composeCapacityChoice({
    capacity: {
      atLimit: true,
      maximumAnalyses: MAX_CONSUMER_ANALYSES,
      overflowModuleIds: [MODULE_IDS.NET_RETIREMENT]
    },
    moduleSlots: [
      { moduleId: MODULE_IDS.PERSONAL_BALANCE_SHEET },
      { moduleId: MODULE_IDS.MORTGAGE },
      { moduleId: MODULE_IDS.COLLEGE_FUNDING }
    ],
    moduleOpportunities: []
  }, { profile: profileFor({ goals: ['retire'] }) });
  assert.equal(hiddenCandidate, null);

  const hiddenCurrent = composeCapacityChoice({
    capacity: {
      atLimit: true,
      maximumAnalyses: MAX_CONSUMER_ANALYSES,
      overflowModuleIds: [MODULE_IDS.PENSION_PROJECTION]
    },
    moduleSlots: [
      { moduleId: MODULE_IDS.PERSONAL_BALANCE_SHEET },
      { moduleId: MODULE_IDS.MORTGAGE },
      { moduleId: MODULE_IDS.NET_RETIREMENT }
    ],
    moduleOpportunities: []
  }, { profile: profileFor({ goals: ['retire'] }) });
  assert.equal(hiddenCurrent, null);
});

check('capacity composition refuses an unanchored proposed analysis', () => {
  const unanchored = composeCapacityChoice({
    capacity: {
      atLimit: true,
      maximumAnalyses: MAX_CONSUMER_ANALYSES,
      overflowModuleIds: [MODULE_IDS.PENSION_PROJECTION]
    },
    moduleSlots: [
      { moduleId: MODULE_IDS.PERSONAL_BALANCE_SHEET },
      { moduleId: MODULE_IDS.MORTGAGE },
      { moduleId: MODULE_IDS.COLLEGE_FUNDING }
    ],
    moduleOpportunities: []
  }, { profile: profileFor({}) });
  assert.equal(unanchored, null);
});

// ---------------------------------------------------------------------------
// Replacement and deferral
// ---------------------------------------------------------------------------

check('a client-selected replacement swaps exactly that analysis', () => {
  const { profile, plan } = multiPlan(FULL_PLAN);
  const choice = composeCapacityChoice(plan, { profile });
  const removed = MODULE_IDS.COLLEGE_FUNDING;
  const removedChoice = choice.replacementChoices.find((item) => item.moduleId === removed);
  assert.ok(removedChoice, 'the client-facing choice must resolve to the selected id');
  assert.ok(choice.replacementPrompt.includes(removedChoice.description));
  const planning = applyModuleReplacement(
    {
      ...(profile.assumptions.values.planning || {}),
      confirmedModuleIds: plan.moduleSlots.map((slot) => slot.moduleId)
    },
    { removeModuleId: removed, addModuleId: choice.candidateModuleId }
  );
  assert.deepEqual(planning.confirmedModuleIds, [], 'changing the set clears stale confirmation');
  const after = multiPlan({ ...FULL_PLAN, planning });
  const ids = after.plan.moduleSlots.map((slot) => slot.moduleId);
  assert.ok(!ids.includes(removed), 'the analysis the client named is removed');
  assert.ok(ids.includes(choice.candidateModuleId), 'the new analysis takes its place');
  assert.equal(ids.length, MAX_CONSUMER_ANALYSES);
  // The goal behind the removed analysis is not discarded.
  assert.ok(after.profile.goals.some((goal) => goal.type === 'fund_education'));
  assert.ok(after.profile.assumptions.values.planning.replacedModuleIds.includes(removed));
});

check('deferring keeps the current set and stores the analysis for later', () => {
  const { profile, plan } = multiPlan(FULL_PLAN);
  const choice = composeCapacityChoice(plan, { profile });
  const planning = applyModuleDeferral(profile.assumptions.values.planning || {}, choice.candidateModuleId);
  const after = multiPlan({ ...FULL_PLAN, planning });
  assert.deepEqual(
    after.plan.moduleSlots.map((slot) => slot.moduleId),
    plan.moduleSlots.map((slot) => slot.moduleId),
    'the confirmed three are unchanged'
  );
  assert.ok(planning.deferredModuleIds.includes(choice.candidateModuleId), 'it is retained for later');
  assert.ok(choice.deferralAcknowledgement.includes(choice.candidateDescription));
  assertNoInternalTerminology(choice.deferralAcknowledgement, 'applied deferral acknowledgement');
});

check('a deferred analysis is not pressed again in the same cycle', () => {
  const { profile, plan } = multiPlan(FULL_PLAN);
  const choice = composeCapacityChoice(plan, { profile });
  const planning = applyModuleDeferral(profile.assumptions.values.planning || {}, choice.candidateModuleId);
  const after = multiPlan({ ...FULL_PLAN, planning });
  assert.ok(
    !after.plan.moduleOpportunities.some((item) => item.moduleId === choice.candidateModuleId),
    'a deferred analysis must not be offered again this cycle'
  );
  assert.ok(
    !after.plan.capacity.overflowModuleIds.includes(choice.candidateModuleId),
    'nor should it keep re-triggering the limit conversation'
  );
});

// ---------------------------------------------------------------------------
// A second planning cycle
// ---------------------------------------------------------------------------

check('a new cycle reuses facts but clears offer and confirmation state', () => {
  const { profile } = multiPlan({
    ...FULL_PLAN,
    planning: {
      planningCycle: 1,
      acceptedModuleIds: ['loan_analysis'],
      confirmedModuleIds: ['loan_analysis'],
      replacedModuleIds: ['college_funding'],
      deferredModuleIds: ['pension_projection']
    }
  });
  const next = nextPlanningCycleValues(profile.assumptions.values.planning);
  assert.equal(next.planningCycle, 2);
  assert.deepEqual(next.acceptedModuleIds, [], 'acceptances do not carry into a new cycle');
  assert.deepEqual(next.confirmedModuleIds, [], 'the previous confirmation does not carry');
  assert.deepEqual(next.replacedModuleIds, []);
  assert.deepEqual(next.carriedOverModuleIds, ['pension_projection'], 'a deferral is remembered');
  assert.deepEqual(next.deferredModuleIds, [], 'and becomes a candidate again');

  const cycleTwo = multiPlan({ ...FULL_PLAN, planning: next });
  assert.equal(planningCycleNumber(cycleTwo.profile), 2);
  // Goals and facts survive; the client is not asked to repeat themselves.
  assert.equal(cycleTwo.profile.goals.length, 3);
  assert.equal(cycleTwo.plan.moduleSlots.length, MAX_CONSUMER_ANALYSES, 'its own limit of three');
});

check('final execution matches exactly the confirmed consumer-visible analyses', () => {
  const { plan } = multiPlan(FULL_PLAN);
  assert.equal(plan.executionModuleIds.length, MAX_CONSUMER_ANALYSES);
  for (const moduleId of plan.executionModuleIds) {
    assert.ok(isConsumerVisibleModule(moduleId, {}), `${moduleId} must be consumer-visible`);
  }
  assert.ok(!plan.executionModuleIds.includes('net_retirement_cashflow'));
});

await Promise.all(pendingChecks);

if (failures > 0) {
  console.error(`\n[ModuleOffers] ${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.info('\n[ModuleOffers] offer, accept, decline, collect, confirm and execute all hold.');
}
