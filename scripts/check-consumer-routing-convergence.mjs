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

const NOW = '2026-07-25T09:00:00.000Z';
const ALL = Object.values(MODULE_IDS);
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

if (failures > 0) {
  console.error(`\n[RoutingConvergence] ${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.info('\n[RoutingConvergence] conversation selection, execution defaults, alias and capability rules all hold.');
}
