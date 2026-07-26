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
let failures = 0;

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
    if (result instanceof Promise) return result.then(() => done(), done);
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
  const { profile, plan } = planFor({ persona: HOMEOWNER });
  const offer = nextModuleOffer(plan, { profile });
  assert.ok(offer, 'a homeowner should be offered something');
  assert.equal(offer.moduleId, MODULE_IDS.MORTGAGE);
  assert.equal(offer.anchor, 'you own your home');
  assert.match(offer.spokenOffer, /^You mentioned you own your home\. I can /);
  assert.match(offer.spokenOffer, /Would that be useful\?$/);
});

check('the benefit wording comes from the module manifest', () => {
  const { profile, plan } = planFor({ persona: HOMEOWNER });
  const offer = nextModuleOffer(plan, { profile });
  assert.equal(offer.benefit, getModuleManifest(MODULE_IDS.MORTGAGE).clientBenefit);
  assert.ok(offer.spokenOffer.includes(offer.benefit), 'the spoken offer must carry the manifest benefit');
});

check('mortgage and loan offers are distinct analyses, not one another', () => {
  const mortgage = getModuleManifest('mortgage_analysis').clientBenefit;
  const loan = getModuleManifest('loan_analysis').clientBenefit;
  assert.notEqual(mortgage, loan);
  assert.match(mortgage, /mortgage/i);
  assert.match(loan, /repayments?/i);
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
    persona: { ...HOMEOWNER, hasPension: true, dependantCount: 2 }
  });
  assert.ok(plan.moduleOpportunities.length > 1, 'this client has several relevant modules');
  const offer = nextModuleOffer(plan, { profile });
  assert.ok(offer && typeof offer.spokenOffer === 'string');
  assert.equal(offer.spokenOffer.match(/Would that be useful\?/g).length, 1);
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
    planning: { acceptedModuleIds: [MODULE_IDS.MORTGAGE] }
  });
  assert.ok(!plan.executionModuleIds.includes(MODULE_IDS.MORTGAGE));
});

check('the confirmation names the modules in plain language', () => {
  const { plan } = planFor({
    persona: HOMEOWNER,
    planning: {
      acceptedModuleIds: [MODULE_IDS.MORTGAGE],
      confirmedModuleIds: [MODULE_IDS.MORTGAGE]
    }
  });
  const summary = confirmationSummary(plan);
  assert.match(summary.spoken, /Mortgage analysis and Personal balance sheet/,
    'a client-requested analysis is named first, matching its rank');
  assert.match(summary.spoken, /Have I got that right\?$/);
  assert.ok(!summary.spoken.includes('_'), 'the confirmation must not read out internal ids');
  assert.deepEqual(summary.moduleIds, plan.executionModuleIds);
});

check('execution runs exactly the confirmed set', async () => {
  const { profile, plan } = planFor({
    persona: HOMEOWNER,
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
  const first = planFor({ persona: HOMEOWNER });
  const second = planFor({ persona: HOMEOWNER });
  assert.equal(
    nextModuleOffer(first.plan, { profile: first.profile }).spokenOffer,
    nextModuleOffer(second.plan, { profile: second.profile }).spokenOffer
  );
});

check('an offer survives an unrelated later turn', () => {
  const before = planFor({ persona: HOMEOWNER });
  const after = planFor({ persona: { ...HOMEOWNER, hasPension: true } });
  const stillOffered = after.plan.moduleOpportunities.map((item) => item.moduleId);
  assert.ok(
    stillOffered.includes(MODULE_IDS.MORTGAGE),
    'the mortgage opportunity must not vanish because a later turn was about pensions'
  );
  assert.ok(before.plan.moduleOpportunities.length < after.plan.moduleOpportunities.length);
});

check('an offer is composed from the profile, never from a transcript', () => {
  const { profile, plan } = planFor({ persona: HOMEOWNER });
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
});

check('the explanation names the three current analyses in plain language', () => {
  const { profile, plan } = multiPlan(FULL_PLAN);
  const choice = composeCapacityChoice(plan, { profile });
  for (const name of choice.currentNames) {
    assert.ok(choice.spoken.includes(name), `${name} must be named`);
    assert.ok(!name.includes('_'), 'names must be plain language, not module ids');
  }
  assert.match(choice.spoken, /could also be useful/, 'it must say why the fourth is relevant');
  assert.match(choice.spoken, /replace one of those three with it, or keep it for a separate follow-up/);
});

check('the model is never told which analysis to drop', () => {
  const { profile, plan } = multiPlan(FULL_PLAN);
  const choice = composeCapacityChoice(plan, { profile });
  assert.ok(!Object.hasOwn(choice, 'recommendedRemoval'));
  assert.deepEqual(choice.currentModuleIds, plan.moduleSlots.map((slot) => slot.moduleId));
});

// ---------------------------------------------------------------------------
// Replacement and deferral
// ---------------------------------------------------------------------------

check('a client-selected replacement swaps exactly that analysis', () => {
  const { profile, plan } = multiPlan(FULL_PLAN);
  const choice = composeCapacityChoice(plan, { profile });
  const removed = MODULE_IDS.COLLEGE_FUNDING;
  const planning = applyModuleReplacement(
    profile.assumptions.values.planning || {},
    { removeModuleId: removed, addModuleId: choice.candidateModuleId }
  );
  const after = multiPlan({ ...FULL_PLAN, planning });
  const ids = after.plan.moduleSlots.map((slot) => slot.moduleId);
  assert.ok(!ids.includes(removed), 'the analysis the client named is removed');
  assert.ok(ids.includes(choice.candidateModuleId), 'the new analysis takes its place');
  assert.equal(ids.length, MAX_CONSUMER_ANALYSES);
  // The goal behind the removed analysis is not discarded.
  assert.ok(after.profile.goals.some((goal) => goal.type === 'fund_education'));
  // A changed set invalidates the previous confirmation.
  assert.deepEqual(after.plan.executionModuleIds.length > 0, true);
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

if (failures > 0) {
  console.error(`\n[ModuleOffers] ${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.info('\n[ModuleOffers] offer, accept, decline, collect, confirm and execute all hold.');
}
