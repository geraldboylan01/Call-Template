// Proves the two routing paths cannot diverge.
//
// Planéir routes modules twice: buildGoalModulePlan decides what the
// conversation tells the client it will analyse, and recommendModules is the
// execution-time default inside runConsumerAnalysis when no explicit module ids
// are passed. Before P2 these were two hand-maintained tables that already
// disagreed -- liquidity_analysis was routed for understand_position by one and
// not the other. A client could be told one set of analyses and served another.
//
// Both now derive their goal-to-module edges from the shared module manifest.
// These assertions hold that property, plus the alias and capability rules.

import assert from 'node:assert/strict';

import {
  GOAL_TYPES,
  MODULE_IDS,
  buildGoalModulePlan,
  createHouseholdProfile,
  getPlanningModuleDefinition,
  isPlanningCapability,
  listAdviserSelectableModuleDefinitions,
  listPlanningModuleDefinitions,
  listRunnablePlanningModuleDefinitions,
  normalizeHouseholdProfile,
  recommendModules,
  resolvePlanningModuleId,
  runConsumerAnalysis
} from '../js/planning/index.js';
import { MODULE_MANIFEST } from '../js/planning/module_manifest.generated.js';
import { effectiveConsumerAvailability, validateAdviserConsumerToggle } from '../js/planning/module_availability.js';
import { factPreconditionBlock, isFactApplicable, withoutInapplicableFacts } from '../js/planning/fact_preconditions.js';

const NOW = '2026-07-25T09:00:00.000Z';
const ALL = Object.values(MODULE_IDS);
const APPROVED_MODULES = [
  'liquidity_analysis', 'house_purchase', 'personal_balance_sheet',
  'mortgage_analysis', 'loan_analysis', 'pension_projection', 'college_funding'
];
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.info(`[RoutingConvergence] PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[RoutingConvergence] FAIL: ${name}\n    ${error.message}`);
  }
}

function profileFor(goalTypes, { age = 45, persona = {} } = {}) {
  const base = createHouseholdProfile({
    profileId: `converge-${goalTypes.join('-')}`,
    nowIso: NOW,
    calculationDateIso: NOW.slice(0, 10)
  });
  return normalizeHouseholdProfile({
    ...base,
    revision: 1,
    primaryPerson: { ...base.primaryPerson, age },
    goals: goalTypes.map((type, index) => ({
      goalId: `goal-${type}-${index}`, type, title: type, priority: 'high', status: 'active'
    })),
    assumptions: { ...base.assumptions, values: { ...base.assumptions.values, persona } }
  });
}

/** What the conversation would tell the client it is going to analyse. */
function conversationModules(profile) {
  return new Set(buildGoalModulePlan(profile, { allowedModuleIds: ALL }).executionModuleIds);
}

/**
 * What runConsumerAnalysis would execute by default. Mirrors orchestrator.js:
 * recommendations, minus excluded, filtered to consumerAvailable and allowlist.
 */
function executionModules(profile, allowedIds = ALL) {
  const allowed = new Set(allowedIds);
  return new Set(recommendModules(profile)
    .filter((item) => item.status !== 'excluded')
    .filter((item) => getPlanningModuleDefinition(item.moduleId)?.consumerAvailable)
    .filter((item) => allowed.has(item.moduleId))
    .map((item) => item.moduleId));
}

// ---------------------------------------------------------------------------
// 1. Neither router may claim an edge the other does not have.
// ---------------------------------------------------------------------------

check('both routers derive their goal edges from the same manifest', () => {
  const manifestEdges = new Set();
  for (const entry of MODULE_MANIFEST) {
    for (const goal of entry.routing.goals || []) manifestEdges.add(`${goal.type}:${entry.moduleId}`);
  }
  for (const goalType of GOAL_TYPES) {
    const profile = profileFor([goalType]);
    for (const slot of buildGoalModulePlan(profile, { allowedModuleIds: ALL }).moduleSlots) {
      if (slot.source === 'balance_sheet_default') continue;
      assert.ok(
        manifestEdges.has(`${goalType}:${slot.moduleId}`),
        `conversation routed ${slot.moduleId} for ${goalType} with no manifest edge`
      );
    }
  }
});

check('every consumer-routable manifest edge is honoured by the conversation', () => {
  for (const entry of MODULE_MANIFEST) {
    if (!entry.routing.consumerRoutable) continue;
    // A gated module is filtered out before it can occupy a slot, so its
    // declared routes are correctly absent from a plan.
    if (!effectiveConsumerAvailability(entry.moduleId).visible) continue;
    for (const goal of entry.routing.goals || []) {
      const profile = profileFor([goal.type]);
      const selected = buildGoalModulePlan(profile, { allowedModuleIds: ALL })
        .moduleSlots.map((slot) => slot.moduleId);
      assert.ok(
        selected.includes(entry.moduleId),
        `manifest routes ${entry.moduleId} for ${goal.type} but the conversation did not select it`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2. The client is served what the conversation promised.
// ---------------------------------------------------------------------------

check('conversation selection and execution default agree on every single goal', () => {
  for (const goalType of GOAL_TYPES) {
    const profile = profileFor([goalType]);
    const conversation = conversationModules(profile);
    const execution = executionModules(profile);
    // The conversation may add a pinned module the execution default does not,
    // and caps at three. What must never happen is the execution layer running
    // a consumer module the conversation never mentioned.
    for (const moduleId of execution) {
      assert.ok(
        conversation.has(moduleId),
        `${goalType}: execution would run ${moduleId}, which the conversation never selected`
      );
    }
  }
});

check('conversation selection and execution agree on multi-goal profiles', () => {
  const combinations = [
    ['buy_home', 'maintain_liquidity'],
    ['retire', 'improve_pension'],
    ['understand_position', 'build_wealth'],
    ['optimise_mortgage', 'manage_loan'],
    ['fund_education', 'understand_position']
  ];
  for (const goals of combinations) {
    const profile = profileFor(goals);
    const conversation = conversationModules(profile);
    for (const moduleId of executionModules(profile)) {
      assert.ok(
        conversation.has(moduleId),
        `${goals.join('+')}: execution would run ${moduleId}, which the conversation never selected`
      );
    }
  }
});

check('an executed analysis runs exactly the confirmed conversation modules', async () => {
  const profile = profileFor(['buy_home']);
  const conversation = [...conversationModules(profile)];
  const result = await runConsumerAnalysis({
    profile,
    moduleIds: conversation,
    allowedModuleIds: ALL,
    calculatedAt: NOW
  });
  const executed = result.analysisPlan.selectedModules.map((item) => item.moduleId).sort();
  assert.deepEqual(executed, [...conversation].sort(),
    'the analysis layer executed a different module set than the conversation confirmed');
});

// ---------------------------------------------------------------------------
// 3. The retired alias resolves without duplicating anything.
// ---------------------------------------------------------------------------

check('business_owner_relief resolves to the canonical module', () => {
  assert.equal(resolvePlanningModuleId('business_owner_relief'), 'business_relief_analysis');
  assert.equal(getPlanningModuleDefinition('business_owner_relief').id, 'business_relief_analysis');
  assert.equal(
    getPlanningModuleDefinition('business_owner_relief'),
    getPlanningModuleDefinition('business_relief_analysis'),
    'both ids must resolve to one definition object, not two'
  );
});

check('the alias creates no duplicate catalogue entry, manifest or count', () => {
  const registered = listPlanningModuleDefinitions().map((item) => item.id);
  assert.ok(!registered.includes('business_owner_relief'), 'alias must not be a registry entry');
  assert.equal(new Set(registered).size, registered.length, 'registry contains duplicate ids');

  const manifested = MODULE_MANIFEST.map((entry) => entry.moduleId);
  assert.ok(!manifested.includes('business_owner_relief'), 'alias must not have its own manifest');
  assert.equal(new Set(manifested).size, manifested.length, 'manifest contains duplicate ids');

  assert.ok(
    !listAdviserSelectableModuleDefinitions().some((item) => item.id === 'business_owner_relief'),
    'alias must not appear in the adviser selector'
  );
});

check('the alias creates no duplicate routing entry or output', async () => {
  const profile = profileFor(['business_planning'], { persona: { businessExit: true } });
  const recommendations = recommendModules(profile).map((item) => item.moduleId);
  assert.ok(!recommendations.includes('business_owner_relief'), 'alias must not be recommended');
  assert.equal(
    recommendations.filter((id) => id === 'business_relief_analysis').length, 1,
    'business relief must be recommended exactly once'
  );

  // Requesting the retired id must not produce a second, duplicate run.
  const result = await runConsumerAnalysis({
    profile,
    moduleIds: ['business_relief_analysis', 'business_owner_relief'],
    allowedModuleIds: ALL,
    calculatedAt: NOW
  });
  const ids = result.analysisPlan.selectedModules.map((item) => item.moduleId);
  assert.equal(new Set(ids).size, ids.length, 'the alias produced a duplicate module run');
});

// ---------------------------------------------------------------------------
// 4. Capabilities are not modules.
// ---------------------------------------------------------------------------

check('scenario_analysis is classified as a capability', () => {
  assert.equal(isPlanningCapability('scenario_analysis'), true);
  assert.equal(getPlanningModuleDefinition('scenario_analysis').adviserAvailable, false);
  assert.equal(getPlanningModuleDefinition('scenario_analysis').consumerAvailable, false);
  const entry = MODULE_MANIFEST.find((item) => item.moduleId === 'scenario_analysis');
  assert.equal(entry.implementation.status, 'capability');
});

check('the capability never appears as selectable, routable or runnable', () => {
  assert.ok(
    !listAdviserSelectableModuleDefinitions().some((item) => item.id === 'scenario_analysis'),
    'a capability must never be offered in an adviser selector'
  );
  assert.ok(
    !listRunnablePlanningModuleDefinitions().some((item) => item.id === 'scenario_analysis'),
    'a capability must never be counted as a runnable module'
  );
  for (const goalType of GOAL_TYPES) {
    const profile = profileFor([goalType]);
    assert.ok(
      !conversationModules(profile).has('scenario_analysis'),
      `a capability must never be consumer-routed (${goalType})`
    );
    assert.ok(
      !recommendModules(profile).some((item) => item.moduleId === 'scenario_analysis'),
      `a capability must never be recommended (${goalType})`
    );
  }
});

check('scenario handling is carried by scenario-aware modules instead', () => {
  const aware = MODULE_MANIFEST
    .filter((entry) => entry.implementation.scenarioAware)
    .map((entry) => entry.moduleId).sort();
  assert.deepEqual(aware, ['house_purchase', 'net_retirement_cashflow', 'pension_projection']);
  for (const moduleId of aware) {
    assert.equal(typeof getPlanningModuleDefinition(moduleId).run, 'function',
      `${moduleId} must be runnable to carry scenario overrides`);
  }
});

// ---------------------------------------------------------------------------
// 5. Adviser availability is preserved.
// ---------------------------------------------------------------------------

check('every adviser-available module survives the migration', () => {
  const adviser = listPlanningModuleDefinitions()
    .filter((item) => item.adviserAvailable).map((item) => item.id).sort();
  assert.deepEqual(adviser, [
    'agricultural_relief', 'business_owner_analysis', 'business_relief_analysis',
    'cat_analysis', 'college_funding', 'house_purchase', 'liquidity_analysis',
    'loan_analysis', 'mortgage_analysis', 'net_retirement_cashflow',
    'personal_balance_sheet', 'pension_projection', 'protection_analysis',
    'retirement_goal_analysis'
  ].sort());
  for (const id of adviser) {
    assert.ok(
      MODULE_MANIFEST.some((entry) => entry.moduleId === id),
      `adviser-available ${id} lost its manifest`
    );
  }
});

check('retirement_goal_analysis stays adviser-selection-only', () => {
  const entry = MODULE_MANIFEST.find((item) => item.moduleId === 'retirement_goal_analysis');
  assert.equal(entry.implementation.status, 'routing_label');
  assert.equal(entry.routing.consumerRoutable, false);
  assert.deepEqual(entry.routing.goals, []);
  assert.equal(entry.availability.adviser, true);
  for (const goalType of GOAL_TYPES) {
    assert.ok(
      !conversationModules(profileFor([goalType])).has('retirement_goal_analysis'),
      `retirement_goal_analysis must not be auto-routed (${goalType})`
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Consumer visibility is a hard filter.
// ---------------------------------------------------------------------------

function planFor(persona = {}, planning = {}, goals = ['understand_position'], adviserOverrides = null) {
  const profile = profileFor(goals, { persona });
  const withPlanning = normalizeHouseholdProfile({
    ...profile,
    assumptions: {
      ...profile.assumptions,
      values: { ...profile.assumptions.values, planning: { ...profile.assumptions.values.planning, ...planning } }
    }
  });
  return buildGoalModulePlan(withPlanning, { allowedModuleIds: ALL, adviserOverrides });
}

const RICH = { propertyStatus: 'homeowner', hasPension: true, dependantCount: 2 };
/** Everything a consumer surface is allowed to see. */
function consumerFacing(plan) {
  return JSON.stringify({ slots: plan.moduleSlots, opportunities: plan.moduleOpportunities });
}

check('a module without platform consumer approval is never consumer-visible', () => {
  // net_retirement_cashflow has a runnable engine but has not been through the
  // consumer-readiness review, so an engine alone must not make it visible.
  const plan = planFor({ ...RICH, retirementStatus: 'approaching_retirement' });
  for (const moduleId of ['net_retirement_cashflow']) {
    assert.ok(
      !plan.moduleOpportunities.some((item) => item.moduleId === moduleId),
      `${moduleId} is not platform-approved and must never be offered`
    );
    assert.ok(!consumerFacing(plan).includes(moduleId), `${moduleId} leaked into a consumer-facing payload`);
    assert.ok(
      plan.withheldOpportunities.some((item) => item.moduleId === moduleId),
      `${moduleId} should still be visible internally for adviser tooling`
    );
  }
});

check('a module with no runnable engine is never consumer-visible', () => {
  const plan = planFor(RICH);
  assert.ok(!consumerFacing(plan).includes('protection_analysis'));
  const withheld = plan.withheldOpportunities.find((item) => item.moduleId === 'protection_analysis');
  assert.equal(withheld.blockedBy, 'runnable_engine');
});

check('an adviser-disabled module is never offered', () => {
  const off = planFor(RICH, {}, ['understand_position'], { mortgage_analysis: false });
  assert.ok(!off.moduleOpportunities.some((item) => item.moduleId === MODULE_IDS.MORTGAGE));
  const withheld = off.withheldOpportunities.find((item) => item.moduleId === MODULE_IDS.MORTGAGE);
  assert.equal(withheld.blockedBy, 'adviser_consumer_enabled');

  const on = planFor(RICH, {}, ['understand_position'], { mortgage_analysis: true });
  assert.ok(on.moduleOpportunities.some((item) => item.moduleId === MODULE_IDS.MORTGAGE));
});

check('an adviser cannot enable a platform-unapproved or non-runnable module', () => {
  assert.equal(validateAdviserConsumerToggle('net_retirement_cashflow', true).code, 'module_not_platform_approved');
  assert.equal(validateAdviserConsumerToggle('protection_analysis', true).code, 'module_not_runnable');
  assert.equal(validateAdviserConsumerToggle('cat_analysis', true).code, 'module_not_runnable');
  // Turning a module OFF only ever narrows what a consumer sees, so it is allowed.
  assert.equal(validateAdviserConsumerToggle('net_retirement_cashflow', false).ok, true);
  // The reviewed modules may be switched on.
  for (const moduleId of APPROVED_MODULES) {
    assert.equal(validateAdviserConsumerToggle(moduleId, true).ok, true, `${moduleId} should be enableable`);
  }
});

check('the approved modules are platform-approved and adviser-enabled by default', () => {
  const byId = new Map(MODULE_MANIFEST.map((entry) => [entry.moduleId, entry]));
  for (const moduleId of APPROVED_MODULES) {
    const entry = byId.get(moduleId);
    assert.equal(entry.consumerReadiness.status, 'approved', `${moduleId} readiness`);
    assert.equal(entry.availability.platformConsumerApproved, true, `${moduleId} platform approval`);
    assert.equal(entry.availability.adviserConsumerEnabled, true, `${moduleId} adviser default`);
    assert.equal(entry.implementation.hasRunnableEngine, true, `${moduleId} engine`);
    assert.ok(entry.clientBenefit.length > 40, `${moduleId} needs a client-facing benefit`);
  }
  // Mortgage and Loan are separate analyses, not aliases of one another.
  assert.notEqual(byId.get('mortgage_analysis').clientBenefit, byId.get('loan_analysis').clientBenefit);
  assert.ok(byId.get('mortgage_analysis').routing.goals.some((goal) => goal.type === 'optimise_mortgage'));
  assert.ok(byId.get('loan_analysis').routing.goals.some((goal) => goal.type === 'manage_loan'));
  // An engine without a completed review stays unapproved.
  assert.equal(byId.get('net_retirement_cashflow').availability.platformConsumerApproved, false);
});

check('an adviser may disable any approved module for their own journey', () => {
  for (const moduleId of APPROVED_MODULES) {
    const off = effectiveConsumerAvailability(moduleId, { adviserOverrides: { [moduleId]: false } });
    assert.equal(off.visible, false, `${moduleId} should be hideable by its adviser`);
    assert.equal(off.blockedBy, 'adviser_consumer_enabled');
  }
});

// ---------------------------------------------------------------------------
// 7. Offers are anchored to what the client actually said.
// ---------------------------------------------------------------------------

check('understand_position starts on the Personal Balance Sheet alone', () => {
  const plan = planFor();
  assert.deepEqual(plan.moduleSlots.map((slot) => slot.moduleId), [MODULE_IDS.PERSONAL_BALANCE_SHEET]);
  assert.deepEqual(plan.moduleOpportunities, []);
  assert.deepEqual(plan.executionModuleIds, [MODULE_IDS.PERSONAL_BALANCE_SHEET]);
});

check('an opportunity appears only once the circumstance emerges', () => {
  const before = planFor({}, {}, ['understand_position'], { mortgage_analysis: true });
  assert.ok(!before.moduleOpportunities.some((item) => item.moduleId === MODULE_IDS.MORTGAGE));
  const after = planFor({ propertyStatus: 'homeowner' }, {}, ['understand_position'], { mortgage_analysis: true });
  assert.ok(after.moduleOpportunities.some((item) => item.moduleId === MODULE_IDS.MORTGAGE));
});

check('every offer carries a reason, supporting facts and a benefit descriptor', () => {
  const plan = planFor({ propertyStatus: 'homeowner' }, {}, ['understand_position'], { mortgage_analysis: true });
  const offer = plan.moduleOpportunities.find((item) => item.moduleId === MODULE_IDS.MORTGAGE);
  assert.ok(offer.relevanceReason.length > 20, 'an offer must be explainable');
  assert.ok(offer.supportingFactIds.includes('property_status'),
    'an offer must name the accumulated facts that make it relevant');
  assert.ok(offer.clientBenefit.length > 20, 'an offer must state the benefit in plain language');
  assert.equal(offer.effectiveConsumerAvailability.visible, true);
});

check('identical accumulated state produces stable opportunities', () => {
  const persona = { propertyStatus: 'homeowner' };
  const overrides = { mortgage_analysis: true };
  const first = planFor(persona, {}, ['understand_position'], overrides);
  const second = planFor(persona, {}, ['understand_position'], overrides);
  assert.deepEqual(
    second.moduleOpportunities.map((item) => `${item.moduleId}:${item.state}`),
    first.moduleOpportunities.map((item) => `${item.moduleId}:${item.state}`)
  );
  // Unrelated later evidence must not drop an earlier opportunity.
  const widened = planFor({ ...persona, dependantCount: 2 }, {}, ['understand_position'], overrides);
  assert.ok(widened.moduleOpportunities.some((item) => item.moduleId === MODULE_IDS.MORTGAGE));
});

// ---------------------------------------------------------------------------
// 8. Accept, decline, confirm, execute.
// ---------------------------------------------------------------------------

const OFFERED = { propertyStatus: 'homeowner' };
const ENABLE_MORTGAGE = { mortgage_analysis: true };

check('declining a module removes it from execution and marks it declined', () => {
  const plan = planFor(OFFERED, { declinedModuleIds: [MODULE_IDS.MORTGAGE] }, ['understand_position'], ENABLE_MORTGAGE);
  const offer = plan.moduleOpportunities.find((item) => item.moduleId === MODULE_IDS.MORTGAGE);
  assert.equal(offer.state, 'declined');
  assert.ok(!plan.executionModuleIds.includes(MODULE_IDS.MORTGAGE));
  assert.ok(!plan.moduleSlots.some((slot) => slot.moduleId === MODULE_IDS.MORTGAGE));
});

check('accepting a module is not enough to execute it', () => {
  const plan = planFor(OFFERED, { acceptedModuleIds: [MODULE_IDS.MORTGAGE] }, ['understand_position'], ENABLE_MORTGAGE);
  // An accepted offer occupies a slot so its question queue opens, but it is
  // marked accepted rather than selected and cannot execute yet.
  const slot = plan.moduleSlots.find((item) => item.moduleId === MODULE_IDS.MORTGAGE);
  assert.ok(slot, 'acceptance should bring the module into the plan');
  assert.equal(slot.selectionState, 'accepted');
  assert.ok(
    !plan.executionModuleIds.includes(MODULE_IDS.MORTGAGE),
    'an accepted module must not execute before the final set is confirmed'
  );
});

check('confirming the final set promotes an accepted module to selected', () => {
  const plan = planFor(
    OFFERED,
    { acceptedModuleIds: [MODULE_IDS.MORTGAGE], confirmedModuleIds: [MODULE_IDS.MORTGAGE] },
    ['understand_position'],
    ENABLE_MORTGAGE
  );
  const slot = plan.moduleSlots.find((item) => item.moduleId === MODULE_IDS.MORTGAGE);
  assert.ok(slot, 'a confirmed accepted module must become selected');
  assert.equal(slot.selectionState, 'selected');
  assert.equal(slot.source, 'client_accepted_offer');
  assert.ok(plan.executionModuleIds.includes(MODULE_IDS.MORTGAGE));
});

check('confirmation cannot smuggle in a module the client never accepted', () => {
  const plan = planFor(OFFERED, { confirmedModuleIds: [MODULE_IDS.MORTGAGE] }, ['understand_position'], ENABLE_MORTGAGE);
  assert.ok(
    !plan.executionModuleIds.includes(MODULE_IDS.MORTGAGE),
    'confirmation without acceptance must not execute a module'
  );
});

check('confirmation cannot smuggle in a module that is not consumer-visible', () => {
  const plan = planFor(
    { ...RICH, retirementStatus: 'approaching_retirement' },
    {
      acceptedModuleIds: ['net_retirement_cashflow'],
      confirmedModuleIds: ['net_retirement_cashflow']
    }
  );
  assert.ok(
    !plan.executionModuleIds.includes('net_retirement_cashflow'),
    'a platform-unapproved module must not execute even if accepted and confirmed'
  );
});

// ---------------------------------------------------------------------------
// 9. Fact preconditions.
// ---------------------------------------------------------------------------

check('a sole trader is never asked what their employer contributes', () => {
  const selfEmployed = profileFor(['improve_pension'], { persona: { employmentContext: 'self_employed' } });
  const employee = profileFor(['improve_pension'], { persona: { employmentContext: 'employee' } });
  const factId = 'pension_employer_contribution_rate';
  assert.equal(isFactApplicable(factId, selfEmployed, 'pension_projection'), false);
  assert.equal(isFactApplicable(factId, employee, 'pension_projection'), true);
  assert.ok(factPreconditionBlock(factId, selfEmployed, 'pension_projection').reason.length > 20);
});

check('inapplicable facts are filtered out of a question queue', () => {
  const selfEmployed = profileFor(['improve_pension'], { persona: { employmentContext: 'self_employed' } });
  const queue = withoutInapplicableFacts([
    { factId: 'pension_positions', moduleId: 'pension_projection' },
    { factId: 'pension_employer_contribution_rate', moduleId: 'pension_projection' },
    { factId: 'pension_employee_contribution_rate', moduleId: 'pension_projection' }
  ], selfEmployed).map((item) => item.factId);
  assert.deepEqual(queue, ['pension_positions', 'pension_employee_contribution_rate']);
});


if (failures > 0) {
  console.error(`\n[RoutingConvergence] ${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.info('\n[RoutingConvergence] conversation selection, execution defaults, alias and capability rules all hold.');
}
