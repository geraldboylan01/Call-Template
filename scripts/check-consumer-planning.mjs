import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { computeHousePurchaseProjection } from '../js/house_purchase/index.js';
import { computeWorkingLiquidityReserve } from '../js/liquidity_reserve.js';
import {
  applyProfilePatch,
  confirmHouseholdProfile,
  createHouseholdProfile,
  extractRulesOnlyProfilePatch,
  getConsumerModuleDescriptors,
  getModuleReadiness,
  getPlanningModuleDefinition,
  getPlanningModuleDescriptors,
  normalizeHouseholdProfile,
  recommendModules,
  runConsumerAnalysis,
  runPlanningModule
} from '../js/planning/index.js';

const NOW = '2026-07-12T12:00:00.000Z';
const LATER = '2026-07-12T12:05:00.000Z';
const cases = [];

async function runCase(name, fn) {
  try {
    await fn();
    cases.push({ name, passed: true });
    console.info(`[ConsumerPlanning] PASS: ${name}`);
  } catch (error) {
    cases.push({ name, passed: false, error: error?.stack || String(error) });
    console.error(`[ConsumerPlanning] FAIL: ${name}\n${error?.stack || error}`);
  }
}

function emptyProfile(id = 'profile-test') {
  return createHouseholdProfile({ profileId: id, nowIso: NOW, calculationDateIso: '2026-07-12' });
}

function apply(profile, operations, nowIso = LATER) {
  return applyProfilePatch(profile, {
    patchId: 'test-patch',
    operations: operations.map((operation) => ({
      ...operation,
      provenance: operation.provenance || {
        source: 'user_statement',
        confidence: 'high',
        certainty: 'exact',
        capturedAt: NOW,
        confirmedByUser: false
      }
    }))
  }, { nowIso }).profile;
}

function homeProfile() {
  const draft = emptyProfile('profile-home');
  const extraction = extractRulesOnlyProfilePatch(
    "I'm 34, earn €80k a year and have €50k in savings. I spend €2,500 a month and pay €1,500 rent. I'm a first-time buyer and want to buy a house for about €400k by 2028. I save €1,200 a month.",
    { profile: draft, capturedAt: NOW, conversationTurnId: 'turn-home' }
  );
  return applyProfilePatch(draft, extraction.patch, { nowIso: LATER }).profile;
}

function retirementProfile() {
  const draft = emptyProfile('profile-retirement');
  const extraction = extractRulesOnlyProfilePatch(
    "I'm 45 and earn €90k. I want to retire at 62 with €50k a year in retirement. My pension pot is €220k, I contribute 8% and my employer contributes 6%.",
    { profile: draft, capturedAt: NOW, conversationTurnId: 'turn-retirement' }
  );
  return applyProfilePatch(draft, extraction.patch, { nowIso: LATER }).profile;
}

await runCase('creates canonical HouseholdProfile v1 without adviser/session state', () => {
  const profile = emptyProfile();
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.revision, 0);
  assert.equal(profile.source, 'consumer');
  assert.equal(profile.primaryPerson.role, 'primary');
  assert.deepEqual(profile.assets, []);
  assert.deepEqual(profile.fieldMetadata, {});
  assert.equal(profile.assumptions.calculationDateIso, '2026-07-12');
  assert.ok(!Object.hasOwn(profile, 'modules'));
  assert.ok(!Object.hasOwn(profile, 'clientId'));
});

await runCase('normalization rejects unknown schema and unsupported currencies', () => {
  const profile = emptyProfile();
  assert.throws(() => normalizeHouseholdProfile({ ...profile, schemaVersion: 2 }), /Unsupported HouseholdProfile/);
  assert.throws(() => normalizeHouseholdProfile({
    ...profile,
    assets: [{
      assetId: 'cash', ownerIds: ['primary'], type: 'cash', label: 'Cash', currentValue: { amount: 1, currency: 'JPY' }
    }]
  }), /currency must be one of/);
  assert.throws(() => normalizeHouseholdProfile({
    ...profile,
    incomeSources: [{ incomeId: 'bad', ownerId: 'unknown-person', type: 'employment', label: 'Bad' }]
  }), /unknown household person id/);
  assert.throws(() => normalizeHouseholdProfile({
    ...profile,
    assumptions: { ...profile.assumptions, values: { invalid: new Date(NOW) } }
  }), /plain JSON objects only/);
});

await runCase('applies allowlisted patches atomically with leaf-level provenance', () => {
  const profile = emptyProfile();
  const original = JSON.stringify(profile);
  const result = applyProfilePatch(profile, {
    patchId: 'cash-patch',
    operations: [{
      op: 'add',
      path: '/assets/-',
      value: {
        assetId: 'cash', ownerIds: ['primary'], type: 'cash', label: 'Cash', currentValue: { amount: 12000, currency: 'EUR' }, liquid: true
      },
      provenance: {
        source: 'user_statement', confidence: 'medium', certainty: 'approximate', capturedAt: NOW, confirmedByUser: false
      }
    }]
  }, { nowIso: LATER });
  assert.equal(JSON.stringify(profile), original, 'input profile was mutated');
  assert.equal(result.profile.revision, 1);
  assert.deepEqual(result.changedPaths, ['/assets/0']);
  assert.equal(result.profile.assets[0].currentValue.amount, 12000);
  assert.equal(result.profile.fieldMetadata['/assets/0/currentValue/amount'].certainty, 'approximate');
  assert.ok(!result.profile.confirmedAt);
});

await runCase('reindexes field metadata when array entries are removed', () => {
  let profile = emptyProfile();
  profile = apply(profile, [
    {
      op: 'add', path: '/assets/-', value: { assetId: 'one', ownerIds: [], type: 'cash', label: 'One', currentValue: { amount: 1, currency: 'EUR' } },
      provenance: { source: 'user_statement', confidence: 'high', certainty: 'exact', capturedAt: NOW, confirmedByUser: false, note: 'first' }
    },
    {
      op: 'add', path: '/assets/-', value: { assetId: 'two', ownerIds: [], type: 'cash', label: 'Two', currentValue: { amount: 2, currency: 'EUR' } },
      provenance: { source: 'user_statement', confidence: 'high', certainty: 'exact', capturedAt: NOW, confirmedByUser: false, note: 'second' }
    }
  ]);
  profile = apply(profile, [{ op: 'remove', path: '/assets/0' }]);
  assert.equal(profile.assets[0].assetId, 'two');
  assert.equal(profile.fieldMetadata['/assets/0/currentValue/amount'].note, 'second');
  assert.ok(!Object.keys(profile.fieldMetadata).some((path) => path.startsWith('/assets/1')));
});

await runCase('blocks protected roots and prototype-pollution paths', () => {
  const profile = emptyProfile();
  const provenance = { source: 'user_statement', confidence: 'high', certainty: 'exact', capturedAt: NOW, confirmedByUser: false };
  assert.throws(() => applyProfilePatch(profile, {
    operations: [{ op: 'replace', path: '/profileId', value: 'changed', provenance }]
  }), /not allowlisted/);
  assert.throws(() => applyProfilePatch(profile, {
    operations: [{ op: 'add', path: '/assumptions/values/__proto__/polluted', value: true, provenance }]
  }), /forbidden token/);
  assert.throws(() => applyProfilePatch(profile, {
    operations: [{ op: 'add', path: '/assumptions/values/bad~2escape', value: true, provenance }]
  }), /invalid JSON Pointer escape/);
  assert.equal({}.polluted, undefined);
});

await runCase('invalid patched values do not mutate or advance the source revision', () => {
  const profile = emptyProfile();
  assert.throws(() => apply(profile, [{ op: 'replace', path: '/preferences/baseCurrency', value: 'JPY' }]), /baseCurrency/);
  assert.equal(profile.revision, 0);
  assert.equal(profile.preferences.baseCurrency, 'EUR');
});

await runCase('confirmation records explicit user confirmation provenance', () => {
  let profile = apply(emptyProfile(), [{ op: 'add', path: '/primaryPerson/age', value: 41 }]);
  profile = confirmHouseholdProfile(profile, { confirmedAt: LATER });
  assert.equal(profile.confirmedAt, LATER);
  assert.equal(profile.fieldMetadata['/primaryPerson/age'].source, 'user_confirmation');
  assert.equal(profile.fieldMetadata['/primaryPerson/age'].confirmedByUser, true);
});

await runCase('rules-only extraction captures common home and liquidity language conservatively', () => {
  const profile = homeProfile();
  const homeGoal = profile.goals.find((goal) => goal.type === 'buy_home');
  assert.equal(profile.primaryPerson.age, 34);
  assert.equal(profile.incomeSources[0].grossAnnual.amount, 80000);
  assert.equal(profile.assets[0].currentValue.amount, 50000);
  assert.equal(profile.expenses.monthlyEssential.amount, 2500);
  assert.equal(profile.expenses.currentMonthlyRent.amount, 1500);
  assert.equal(homeGoal.targetAmount.amount, 400000);
  assert.equal(homeGoal.targetDate, '2028-12-31');
  assert.equal(profile.assumptions.values.housePurchase.plannedMonthlySavings, 1200);
  assert.equal(profile.fieldMetadata['/primaryPerson/age'].certainty, 'exact');
  assert.equal(profile.fieldMetadata['/goals/0/targetAmount/amount'].certainty, 'approximate');
});

await runCase('rules-only extraction captures retirement goals, pot and contribution rates', () => {
  const profile = retirementProfile();
  assert.equal(profile.primaryPerson.age, 45);
  assert.equal(profile.primaryPerson.intendedRetirementAge, 62);
  assert.equal(profile.pensions[0].currentValue.amount, 220000);
  assert.equal(profile.pensions[0].employeeContributionRate, 0.08);
  assert.equal(profile.pensions[0].employerContributionRate, 0.06);
  assert.equal(profile.assumptions.values.retirement.targetIncomeToday, 50000);
  assert.ok(profile.goals.some((goal) => goal.type === 'retire'));
  assert.ok(profile.goals.some((goal) => goal.type === 'improve_pension'));
});

await runCase('rules-only fallback returns no invented values for unbounded prose', () => {
  const extraction = extractRulesOnlyProfilePatch('I would like some help understanding my choices.', {
    profile: emptyProfile(), capturedAt: NOW
  });
  assert.equal(extraction.patch.operations.length, 0);
  assert.ok(extraction.warnings[0].includes('No bounded profile fields'));
});

await runCase('registry exposes only active consumer candidates to bootstrap', () => {
  const consumer = getConsumerModuleDescriptors();
  assert.deepEqual(consumer.map((entry) => entry.id), ['liquidity_analysis', 'house_purchase', 'personal_balance_sheet']);
  assert.ok(consumer.every((entry) => entry.consumerAvailable));
  assert.ok(consumer.every((entry) => !Object.values(entry).some((value) => typeof value === 'function')));
  const all = getPlanningModuleDescriptors();
  for (const id of [
    'pension_projection', 'net_retirement_cashflow', 'mortgage_analysis', 'college_funding',
    'personal_balance_sheet', 'cat_analysis', 'business_owner_analysis', 'business_relief_analysis',
    'business_owner_relief', 'agricultural_relief'
  ]) assert.ok(all.some((entry) => entry.id === id), `missing registry entry ${id}`);
  assert.equal(all.find((entry) => entry.id === 'personal_balance_sheet').status, 'beta');
  assert.equal(all.find((entry) => entry.id === 'personal_balance_sheet').consumerAvailable, true);
  assert.equal(all.find((entry) => entry.id === 'cat_analysis').consumerAvailable, false);
});

await runCase('deterministic routing distinguishes required and recommended modules', () => {
  const recommendations = recommendModules(homeProfile());
  const house = recommendations.find((entry) => entry.moduleId === 'house_purchase');
  const liquidity = recommendations.find((entry) => entry.moduleId === 'liquidity_analysis');
  assert.equal(house.status, 'required');
  assert.equal(liquidity.status, 'recommended');
  assert.ok(house.triggeredRuleIds.includes('route.buy_home.v1'));
  assert.equal(house.readiness.status, 'ready_with_assumptions');
});

await runCase('house readiness matches the strict engine lending-category gate', async () => {
  let profile = apply(emptyProfile('profile-minimal-home'), [
    {
      op: 'add', path: '/goals/-', value: {
        goalId: 'home', type: 'buy_home', title: 'Buy a home', priority: 'high', status: 'active',
        targetAmount: { amount: 350000, currency: 'EUR' }
      }
    },
    {
      op: 'add', path: '/incomeSources/-', value: {
        incomeId: 'salary', ownerId: 'primary', type: 'employment', label: 'Employment income',
        grossAnnual: { amount: 65000, currency: 'EUR' }
      }
    },
    {
      op: 'add', path: '/assets/-', value: {
        assetId: 'cash', ownerIds: ['primary'], type: 'cash', label: 'Cash savings',
        currentValue: { amount: 50000, currency: 'EUR' }, liquid: true
      }
    },
    { op: 'add', path: '/expenses/monthlyEssential', value: { amount: 2500, currency: 'EUR' } }
  ]);
  const incomplete = getModuleReadiness('house_purchase', profile);
  assert.equal(incomplete.status, 'missing_information');
  assert.ok(incomplete.requiredMissing.some((item) => item.fieldPath.endsWith('/lendingCategory')));
  assert.ok(incomplete.requiredMissing.some((item) => item.fieldPath.endsWith('/currentMonthlyRent')));

  profile = apply(profile, [{
    op: 'add',
    path: '/assumptions/values/housePurchase',
    value: { lendingCategory: 'first_time_buyer', schemeBuyerStatus: 'first_time_buyer' }
  }, {
    op: 'add',
    path: '/expenses/currentMonthlyRent',
    value: { amount: 0, currency: 'EUR' }
  }]);
  const result = await runConsumerAnalysis({
    profile,
    moduleIds: ['house_purchase', 'liquidity_analysis'],
    allowedModuleIds: ['house_purchase', 'liquidity_analysis'],
    calculatedAt: NOW
  });
  assert.equal(result.analysisPlan.status, 'complete');
  assert.deepEqual(result.errors, []);
});

await runCase('retirement routing selects both gross pension and net cash-flow boundaries', () => {
  const recommendations = recommendModules(retirementProfile());
  assert.ok(recommendations.some((entry) => entry.moduleId === 'pension_projection'));
  assert.ok(recommendations.some((entry) => entry.moduleId === 'net_retirement_cashflow'));
  assert.equal(getPlanningModuleDefinition('retirement_goal_analysis').kind, 'composition');
  assert.equal(getPlanningModuleDefinition('retirement_goal_analysis').run, undefined);
});

await runCase('liquidity adapter wraps the existing reserve formula without numerical drift', async () => {
  const profile = homeProfile();
  const definition = getPlanningModuleDefinition('liquidity_analysis');
  const input = definition.buildInput(profile);
  const expected = computeWorkingLiquidityReserve(input);
  const result = await runPlanningModule('liquidity_analysis', profile, {
    calculationVersion: 'test', calculatedAt: NOW, scenarioOverrides: {}
  });
  assert.equal(result.semanticResult.targetCash, expected.targetCash);
  assert.equal(result.semanticResult.monthsCovered, expected.monthsCovered);
  assert.match(result.inputSnapshotHash, /^(sha256|fnv1a64):/);
});

await runCase('house adapter preserves direct-engine calculation parity', async () => {
  const profile = homeProfile();
  const definition = getPlanningModuleDefinition('house_purchase');
  const input = definition.buildInput(profile);
  const direct = computeHousePurchaseProjection(input);
  const wrapped = await runPlanningModule('house_purchase', profile, {
    calculationVersion: 'test', calculatedAt: NOW, scenarioOverrides: {}
  });
  assert.equal(wrapped.semanticResult.currentSupportablePrice, direct.result.capacities.currentSupportablePrice);
  assert.equal(wrapped.semanticResult.currentCashGap, direct.result.targetFunding.currentCashGap);
  assert.equal(wrapped.semanticResult.mortgageMonthlyPayment, direct.result.mortgage.monthlyPayment);
  assert.equal(wrapped.tables.length, direct.tables.length);
});

await runCase('future deterministic engines have readiness but remain consumer-gated', () => {
  const pension = getModuleReadiness('pension_projection', retirementProfile());
  assert.equal(pension.status, 'ready_with_assumptions');
  assert.equal(getPlanningModuleDefinition('pension_projection').consumerAvailable, false);

  let mortgage = emptyProfile('profile-mortgage');
  const mortgageExtraction = extractRulesOnlyProfilePatch(
    'I want to pay off my mortgage of €250k at 4% with 20 years left.',
    { profile: mortgage, capturedAt: NOW }
  );
  mortgage = applyProfilePatch(mortgage, mortgageExtraction.patch, { nowIso: LATER }).profile;
  assert.equal(getModuleReadiness('mortgage_analysis', mortgage).status, 'ready_with_assumptions');

  let college = emptyProfile('profile-college');
  college = apply(college, [
    { op: 'add', path: '/goals/-', value: { goalId: 'college', type: 'assess_decision', title: 'Plan college funding', priority: 'medium', status: 'active' } },
    { op: 'add', path: '/dependants/-', value: { dependantId: 'child', displayName: 'Child', currentAge: 10 } },
    {
      op: 'add', path: '/assumptions/values/collegeFunding', value: {
        requested: true,
        scenarios: [{ id: 'home', title: 'At home', category: 'At home', annualCostTodayPerChild: 8000, oneOffCostTodayPerChild: 0 }]
      }
    }
  ]);
  assert.equal(getModuleReadiness('college_funding', college).status, 'ready_with_assumptions');
  assert.equal(getPlanningModuleDefinition('college_funding').consumerAvailable, false);
});

await runCase('adviser-only and unsupported modules cannot be run by consumer orchestration', async () => {
  const result = await runConsumerAnalysis({
    profile: homeProfile(),
    moduleIds: ['cat_analysis', 'retirement_goal_analysis', 'missing_module'],
    calculatedAt: NOW
  });
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.errors.map((entry) => entry.code), [
    'adviser_only', 'module_not_consumer_available', 'unknown_module'
  ]);
  assert.equal(result.analysisPlan.status, 'needs_review');
});

await runCase('default analysis keeps optional recommendations removable', async () => {
  const result = await runConsumerAnalysis({
    profile: homeProfile(),
    allowedModuleIds: ['liquidity_analysis', 'house_purchase'],
    calculatedAt: NOW
  });
  const house = result.analysisPlan.selectedModules.find((entry) => entry.moduleId === 'house_purchase');
  const liquidity = result.analysisPlan.selectedModules.find((entry) => entry.moduleId === 'liquidity_analysis');
  assert.equal(house.required, true);
  assert.equal(liquidity.required, false, 'recommended liquidity module was incorrectly promoted to required');
  assert.equal(result.analysisPlan.status, 'complete');
});

await runCase('server allowlist filters default routing without user-selected semantics', async () => {
  const liquidityOnly = await runConsumerAnalysis({
    profile: homeProfile(),
    allowedModuleIds: ['liquidity_analysis'],
    calculatedAt: NOW
  });
  assert.deepEqual(liquidityOnly.analysisPlan.selectedModules.map((entry) => entry.moduleId), ['liquidity_analysis']);
  assert.equal(liquidityOnly.analysisPlan.selectedModules[0].required, false);
  const blocked = await runConsumerAnalysis({
    profile: homeProfile(),
    moduleIds: ['house_purchase'],
    allowedModuleIds: ['house_purchase'],
    calculatedAt: NOW
  });
  assert.deepEqual(blocked.results, []);
  assert.ok(blocked.errors.some((entry) => entry.code === 'prerequisite_not_allowed'));
});

await runCase('default missing-information modules stay in the plan and generate questions', async () => {
  let profile = emptyProfile('profile-incomplete-home');
  profile = apply(profile, [{
    op: 'add', path: '/goals/-', value: {
      goalId: 'home', type: 'buy_home', title: 'Buy a home', priority: 'high', status: 'active'
    }
  }]);
  const result = await runConsumerAnalysis({ profile, calculatedAt: NOW });
  const selectedHouse = result.analysisPlan.selectedModules.find((entry) => entry.moduleId === 'house_purchase');
  assert.ok(selectedHouse, 'missing-information house module disappeared from the plan');
  assert.equal(selectedHouse.readiness.status, 'missing_information');
  assert.ok(result.analysisPlan.requiredQuestions.some((question) => question.blockingModuleIds.includes('house_purchase')));
  assert.equal(result.analysisPlan.status, 'needs_review');
  assert.deepEqual(result.results, []);
});

await runCase('consumer analysis resolves prerequisites, runs deterministically and preserves input', async () => {
  const profile = homeProfile();
  const before = JSON.stringify(profile);
  const first = await runConsumerAnalysis({
    profile,
    moduleIds: ['house_purchase'],
    analysisPlanId: 'analysis-one',
    calculatedAt: NOW
  });
  const second = await runConsumerAnalysis({
    profile,
    moduleIds: ['house_purchase'],
    analysisPlanId: 'analysis-two',
    calculatedAt: NOW
  });
  assert.equal(JSON.stringify(profile), before, 'orchestrator mutated the profile');
  assert.deepEqual(first.results.map((entry) => entry.moduleId), ['liquidity_analysis', 'house_purchase']);
  assert.equal(first.analysisPlan.status, 'complete');
  assert.equal(first.plan, first.analysisPlan);
  assert.equal(first.errors.length, 0);
  assert.equal(first.results[0].inputSnapshotHash, second.results[0].inputSnapshotHash);
  assert.equal(first.results[1].inputSnapshotHash, second.results[1].inputSnapshotHash);
});

await runCase('module-scoped scenario overrides change only the scenario-aware result', async () => {
  const profile = homeProfile();
  const base = await runConsumerAnalysis({ profile, moduleIds: ['house_purchase'], calculatedAt: NOW });
  const scenario = await runConsumerAnalysis({
    profile,
    moduleIds: ['house_purchase'],
    scenarioOverrides: { house_purchase: { plannedMonthlySavings: 2500 } },
    calculatedAt: NOW
  });
  const baseHouse = base.results.find((entry) => entry.moduleId === 'house_purchase');
  const scenarioHouse = scenario.results.find((entry) => entry.moduleId === 'house_purchase');
  const baseLiquidity = base.results.find((entry) => entry.moduleId === 'liquidity_analysis');
  const scenarioLiquidity = scenario.results.find((entry) => entry.moduleId === 'liquidity_analysis');
  assert.notEqual(baseHouse.semanticResult.readyDateIso, scenarioHouse.semanticResult.readyDateIso);
  assert.notEqual(baseHouse.inputSnapshotHash, scenarioHouse.inputSnapshotHash);
  assert.deepEqual(baseLiquidity.semanticResult, scenarioLiquidity.semanticResult);
});

await runCase('result summary preserves code-owned numeric facts', async () => {
  const result = await runConsumerAnalysis({ profile: homeProfile(), moduleIds: ['house_purchase'], calculatedAt: NOW });
  assert.equal(result.summary.generatedBy, 'deterministic_rules');
  const houseRun = result.results.find((entry) => entry.moduleId === 'house_purchase');
  const houseSummary = result.summary.highlights.find((entry) => entry.moduleId === 'house_purchase');
  assert.equal(houseSummary.numericFacts.currentCashGap, houseRun.semanticResult.currentCashGap);
  assert.equal(houseSummary.numericFacts.currentSupportablePrice, houseRun.semanticResult.currentSupportablePrice);
  assert.ok(result.summary.nextSteps.some((entry) => entry.includes('Confirm the inputs')));
});

await runCase('planning core has no DOM, browser-storage or Node-runtime imports', () => {
  const planningRoot = new URL('../js/planning/', import.meta.url);
  const paths = [];
  const walk = (url) => {
    readdirSync(url, { withFileTypes: true }).forEach((entry) => {
      const child = new URL(entry.name, url);
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, url));
      else if (entry.name.endsWith('.js')) paths.push(child);
    });
  };
  walk(planningRoot);
  assert.ok(paths.length >= 10);
  paths.forEach((url) => {
    const source = readFileSync(url, 'utf8');
    assert.doesNotMatch(source, /\b(?:window|document|HTMLElement|customElements|localStorage|sessionStorage)\b/, String(url));
    assert.doesNotMatch(source, /(?:from|import\()\s*['"]node:/, String(url));
  });
  // Ensure this check itself did not accidentally rely on a workspace-relative cwd.
  assert.equal(typeof join, 'function');
});

const failed = cases.filter((entry) => !entry.passed);
if (failed.length > 0) {
  console.error(`[ConsumerPlanning] ${failed.length}/${cases.length} checks failed.`);
  process.exitCode = 1;
} else {
  console.info(`[ConsumerPlanning] All ${cases.length} checks passed.`);
}
