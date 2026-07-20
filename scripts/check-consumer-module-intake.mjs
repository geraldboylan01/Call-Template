import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MODULE_IDS,
  createHouseholdProfile,
  getModuleIntakeContract,
  getModuleIntakeReadiness,
  getPlanningModuleDescriptors,
  getPlanningModuleDefinition,
  getPlanningModulesForSemanticFact,
  getSemanticFactDefinition,
  listPlanningModuleDefinitions,
  normalizeHouseholdProfile,
  resolveSemanticFact
} from '../js/planning/index.js';
import {
  REALTIME_CANARY_FACT_IDS,
  buildConfirmedRealtimeFactSummary,
  buildRealtimeFactReadBack,
  mapRealtimeFact,
  modulesEnabledByFacts,
  realtimeFactAllowed
} from '../worker/src/consumer/realtime_fact_mapper.js';
import { applyProfilePatch } from '../worker/src/consumer/validators.js';

const NOW = '2026-07-16T09:00:00.000Z';
const golden = JSON.parse(readFileSync(
  new URL('./fixtures/consumer-persona-golden.json', import.meta.url),
  'utf8'
));

function emptyProfile(profileId = 'intake-profile') {
  return createHouseholdProfile({ profileId, nowIso: NOW, calculationDateIso: NOW.slice(0, 10) });
}

function withGoal(type, title = type) {
  const profile = emptyProfile(`intake-${type}`);
  return normalizeHouseholdProfile({
    ...profile,
    goals: [{ goalId: `goal-${type}`, type, title, priority: 'high', status: 'active' }]
  });
}

function applyMapped(profile, factId, value) {
  const mapped = mapRealtimeFact(profile, { factId, value, certainty: 'exact' });
  if (mapped.proposalValue !== undefined) {
    const replay = mapRealtimeFact(profile, {
      factId,
      value: mapped.proposalValue,
      certainty: 'exact'
    });
    assert.deepEqual(
      { canonicalValue: replay.canonicalValue, additionalPatch: replay.additionalPatch },
      { canonicalValue: mapped.canonicalValue, additionalPatch: mapped.additionalPatch },
      `${factId}: encrypted proposal remaps deterministically`
    );
  }
  return applyProfilePatch(profile, {
    ...(mapped.additionalPatch || {}),
    [mapped.fieldPath]: mapped.canonicalValue
  }, [], 'ai_extraction');
}

const tableModuleIds = [...new Set(golden.cases.flatMap((entry) => entry.modules))].sort();

const sameTurnProfile = emptyProfile('intake-same-turn-persona');
assert.deepEqual(
  [...modulesEnabledByFacts([], [{ factId: 'primary_goal', value: 'buy_home' }], sameTurnProfile)],
  ['house_purchase', 'liquidity_analysis', 'personal_balance_sheet'],
  'a supported goal immediately opens its deterministic goal bundle'
);
assert.deepEqual(
  [...modulesEnabledByFacts([], [
    { factId: 'primary_goal', value: 'buy_home' },
    { factId: 'life_stage', value: 'young_employee' }
  ], sameTurnProfile)],
  ['house_purchase', 'liquidity_analysis'],
  'same-turn early-life evidence omits the default balance sheet without changing the direct goal bundle'
);

for (const moduleId of tableModuleIds) {
  const definition = getPlanningModuleDefinition(moduleId);
  const contract = getModuleIntakeContract(moduleId);
  assert.ok(definition, `${moduleId}: table module is registered`);
  assert.ok(contract, `${moduleId}: table module has an intake contract`);
  assert.equal(typeof contract.version, 'string', `${moduleId}: intake contract is versioned`);
  assert.ok(['calculation', 'composition', 'adviser_handoff'].includes(contract.mode));
  assert.ok(['approved', 'incomplete'].includes(contract.status));
  assert.equal(typeof contract.getIntakeReadiness, 'function');
}

for (const definition of listPlanningModuleDefinitions()) {
  assert.ok(definition.intakeContract, `${definition.id}: every registry module has an intake contract`);
  for (const factId of definition.intakeContract.semanticFactIds) {
    assert.ok(getSemanticFactDefinition(factId), `${definition.id}: ${factId} is defined semantically`);
    assert.ok(REALTIME_CANARY_FACT_IDS.includes(factId), `${definition.id}: ${factId} is available to Realtime`);
    assert.ok(
      getPlanningModulesForSemanticFact(factId).includes(definition.id),
      `${definition.id}: registry owns the ${factId} module relationship`
    );
  }
}

const descriptorById = new Map(getPlanningModuleDescriptors().map((item) => [item.id, item]));
for (const moduleId of tableModuleIds) {
  assert.equal(typeof descriptorById.get(moduleId)?.intakeContract?.version, 'string');
  assert.equal(descriptorById.get(moduleId)?.intakeContract?.getIntakeReadiness, undefined);
}

const readinessProfiles = new Map();
readinessProfiles.set(MODULE_IDS.PERSONAL_BALANCE_SHEET, emptyProfile('intake-pbs'));
readinessProfiles.set(MODULE_IDS.LIQUIDITY, withGoal('understand_position'));
readinessProfiles.set(MODULE_IDS.HOUSE_PURCHASE, withGoal('buy_home'));
readinessProfiles.set(MODULE_IDS.NET_RETIREMENT, withGoal('retire'));
readinessProfiles.set(MODULE_IDS.MORTGAGE, withGoal('optimise_mortgage'));
readinessProfiles.set(MODULE_IDS.LOAN, withGoal('manage_loan'));
readinessProfiles.set(MODULE_IDS.COLLEGE_FUNDING, withGoal('fund_education', 'Plan college funding'));

let pensionProfile = withGoal('retire');
pensionProfile = normalizeHouseholdProfile({
  ...pensionProfile,
  pensions: [{ pensionId: 'pension-test', ownerId: pensionProfile.primaryPerson.personId, type: 'occupational' }]
});
readinessProfiles.set(MODULE_IDS.PENSION_PROJECTION, pensionProfile);

for (const [moduleId, profile] of readinessProfiles) {
  const contract = getModuleIntakeContract(moduleId);
  const readiness = getModuleIntakeReadiness(moduleId, profile);
  assert.equal(contract.status, 'approved', `${moduleId}: tested intake is approved`);
  assert.ok(readiness.requiredMissing.length > 0, `${moduleId}: incomplete fixture exposes required inputs`);
  for (const missing of readiness.requiredMissing) {
    const semantic = resolveSemanticFact(missing, { profile, moduleId });
    assert.ok(
      contract.semanticFactIds.includes(semantic.factId),
      `${moduleId}: ${missing.fieldPath} maps to contract fact ${semantic.factId}`
    );
    assert.ok(
      realtimeFactAllowed(semantic.factId, new Set([moduleId])),
      `${moduleId}: required fact ${semantic.factId} is writable when the table module is enabled`
    );
  }
}

const netReviewBase = withGoal('retire');
let netReviewProfile = normalizeHouseholdProfile({
  ...netReviewBase,
  primaryPerson: { ...netReviewBase.primaryPerson, age: 48 },
  incomeSources: [{
    incomeId: 'legacy-gross-only-income',
    ownerId: netReviewBase.primaryPerson.personId,
    type: 'employment',
    label: 'Gross employment income',
    grossAnnual: { amount: 75_000, currency: 'EUR' }
  }],
  assets: [{
    assetId: 'legacy-illiquid-investment',
    ownerIds: [netReviewBase.primaryPerson.personId],
    type: 'investment',
    label: 'Illiquid investment',
    currentValue: { amount: 25_000, currency: 'EUR' },
    liquid: false
  }],
  expenses: { annualTotal: { amount: 42_000, currency: 'EUR' } }
});
assert.deepEqual(
  getModuleIntakeReadiness(MODULE_IDS.NET_RETIREMENT, netReviewProfile)
    .requiredMissing.map((item) => item.fieldPath).sort(),
  ['/assets', '/incomeSources'],
  'gross-only income and illiquid assets do not silently satisfy Net Retirement intake'
);
assert.throws(
  () => mapRealtimeFact(netReviewProfile, {
    factId: 'income_sources', value: { operation: 'confirm_none' }
  }),
  (error) => error?.code === 'realtime_entity_review_required',
  'collection-wide none remains invalid while a gross-only income record exists'
);
netReviewProfile = applyMapped(netReviewProfile, 'income_sources', {
  operation: 'confirm_none', scope: 'net_retirement_income'
});
netReviewProfile = applyMapped(netReviewProfile, 'asset_position', {
  operation: 'confirm_none', scope: 'retirement_available_assets'
});
assert.equal(
  netReviewProfile.assumptions.values.completionFacts.confirmedNonePaths['/incomeSources/netAnnual'],
  true
);
assert.equal(
  netReviewProfile.assumptions.values.completionFacts.confirmedNonePaths['/assets/retirementAvailable'],
  true
);
assert.equal(netReviewProfile.incomeSources.length, 1, 'scoped none preserves gross-only income records');
assert.equal(netReviewProfile.assets.length, 1, 'scoped none preserves illiquid asset records');
assert.equal(
  getModuleIntakeReadiness(MODULE_IDS.NET_RETIREMENT, netReviewProfile).requiredMissing.length,
  0,
  'scoped none decisions release both Net Retirement review gates'
);
const netReviewSummary = buildConfirmedRealtimeFactSummary(netReviewProfile);
assert.ok(netReviewSummary.some((item) => (
  item.factId === 'income_sources' && item.value?.scope === 'net_retirement_income'
)));
assert.ok(netReviewSummary.some((item) => (
  item.factId === 'asset_position' && item.value?.scope === 'retirement_available_assets'
)));

const houseLiabilityBase = withGoal('buy_home');
let houseLiabilityProfile = normalizeHouseholdProfile({
  ...houseLiabilityBase,
  goals: houseLiabilityBase.goals.map((goal) => ({
    ...goal,
    targetAmount: { amount: 350_000, currency: 'EUR' }
  })),
  incomeSources: [{
    incomeId: 'legacy-house-income',
    ownerId: houseLiabilityBase.primaryPerson.personId,
    type: 'employment',
    label: 'Employment income',
    grossAnnual: { amount: 70_000, currency: 'EUR' }
  }],
  assets: [{
    assetId: 'legacy-house-cash',
    ownerIds: [houseLiabilityBase.primaryPerson.personId],
    type: 'cash',
    label: 'Cash savings',
    currentValue: { amount: 55_000, currency: 'EUR' },
    liquid: true
  }],
  liabilities: [{
    liabilityId: 'legacy-loan-id',
    ownerIds: [houseLiabilityBase.primaryPerson.personId],
    type: 'loan',
    label: 'Car loan',
    currentBalance: { amount: 9_000, currency: 'EUR' }
  }],
  expenses: {
    monthlyEssential: { amount: 2_200, currency: 'EUR' },
    currentMonthlyRent: { amount: 1_400, currency: 'EUR' }
  },
  assumptions: {
    ...houseLiabilityBase.assumptions,
    values: {
      ...houseLiabilityBase.assumptions.values,
      housePurchase: {
        lendingCategory: 'first_time_buyer',
        schemeBuyerStatus: 'first_time_buyer'
      }
    }
  }
});
const missingLiabilityPayment = getModuleIntakeReadiness(
  MODULE_IDS.HOUSE_PURCHASE,
  houseLiabilityProfile
).requiredMissing.find((item) => item.fieldPath === '/liabilities/0/monthlyPayment');
assert.ok(missingLiabilityPayment, 'every House Purchase liability requires a reviewed monthly payment');
assert.equal(missingLiabilityPayment.entityId, 'legacy-loan-id');
assert.equal(resolveSemanticFact(missingLiabilityPayment, {
  profile: houseLiabilityProfile,
  moduleId: MODULE_IDS.HOUSE_PURCHASE
}).factId, 'liability_monthly_payment');
houseLiabilityProfile = applyMapped(houseLiabilityProfile, 'liability_monthly_payment', {
  entityId: 'legacy-loan-id', amount: 0, currency: 'EUR'
});
assert.equal(houseLiabilityProfile.liabilities.length, 1, 'a legacy liability is updated rather than duplicated');
assert.equal(houseLiabilityProfile.liabilities[0].liabilityId, 'legacy-loan-id');
assert.equal(houseLiabilityProfile.liabilities[0].monthlyPayment.amount, 0);
assert.ok(!getModuleIntakeReadiness(MODULE_IDS.HOUSE_PURCHASE, houseLiabilityProfile)
  .requiredMissing.some((item) => item.fieldPath.endsWith('/monthlyPayment')));

const pensionValueBase = emptyProfile('intake-pbs-pension-value');
let pensionValueProfile = normalizeHouseholdProfile({
  ...pensionValueBase,
  pensions: [{
    pensionId: 'pension_realtime_needs_value',
    ownerId: pensionValueBase.primaryPerson.personId,
    type: 'occupational'
  }],
  assumptions: {
    ...pensionValueBase.assumptions,
    values: {
      ...pensionValueBase.assumptions.values,
      completionFacts: { confirmedNonePaths: { '/liabilities': true } }
    }
  }
});
const missingPensionValue = getModuleIntakeReadiness(
  MODULE_IDS.PERSONAL_BALANCE_SHEET,
  pensionValueProfile
).requiredMissing.find((item) => item.fieldPath === '/pensions/0/currentValue');
assert.ok(missingPensionValue, 'PBS exposes an existing pension with no current value');
assert.equal(resolveSemanticFact(missingPensionValue, {
  profile: pensionValueProfile,
  moduleId: MODULE_IDS.PERSONAL_BALANCE_SHEET
}).factId, 'pension_current_value');
pensionValueProfile = applyMapped(pensionValueProfile, 'pension_current_value', {
  entityId: 'pension_realtime_needs_value', amount: 42_000, currency: 'EUR'
});
assert.equal(pensionValueProfile.pensions[0].currentValue.amount, 42_000);

const reconciliationBase = emptyProfile('intake-pbs-reconciliation');
let reconciliationProfile = normalizeHouseholdProfile({
  ...reconciliationBase,
  assets: [{
    assetId: 'asset-existing-pension-total',
    ownerIds: [reconciliationBase.primaryPerson.personId],
    type: 'pension',
    label: 'Existing pension total',
    currentValue: { amount: 60_000, currency: 'EUR' }
  }],
  pensions: [
    {
      pensionId: 'pension-reconciliation-test',
      ownerId: reconciliationBase.primaryPerson.personId,
      type: 'occupational',
      currentValue: { amount: 60_000, currency: 'EUR' }
    },
    {
      pensionId: 'pension-reconciliation-second',
      ownerId: reconciliationBase.primaryPerson.personId,
      type: 'personal',
      currentValue: { amount: 25_000, currency: 'EUR' }
    }
  ],
  assumptions: {
    ...reconciliationBase.assumptions,
    values: {
      ...reconciliationBase.assumptions.values,
      completionFacts: {
        confirmedNonePaths: {
          '/liabilities': true,
          '/properties': true,
          '/businesses': true
        }
      }
    }
  }
});
const missingReconciliations = getModuleIntakeReadiness(
  MODULE_IDS.PERSONAL_BALANCE_SHEET,
  reconciliationProfile
).requiredMissing.filter((item) => item.fieldPath.includes('/specialistAssetReconciliation/pension/'));
assert.equal(missingReconciliations.length, 2, 'PBS exposes one reconciliation input per specialist pension record');
const reconciliationFacts = missingReconciliations.map((item) => resolveSemanticFact(item, {
  profile: reconciliationProfile,
  moduleId: MODULE_IDS.PERSONAL_BALANCE_SHEET
}));
assert.ok(reconciliationFacts.every((fact) => fact.factId === 'specialist_asset_reconciliation'));
assert.deepEqual(
  reconciliationFacts.map((fact) => fact.factInstanceId).sort(),
  [
    'specialist_asset_reconciliation:pension:pension-reconciliation-second',
    'specialist_asset_reconciliation:pension:pension-reconciliation-test'
  ],
  'PBS reconciliation inputs retain distinct category-and-record semantic identities'
);
assert.ok(reconciliationFacts.every((fact) => fact.identityStability === 'path_entity_id'));
reconciliationProfile = applyMapped(reconciliationProfile, 'specialist_asset_reconciliation', {
  category: 'pension', entityId: 'pension-reconciliation-test', decision: 'duplicate'
});
reconciliationProfile = applyMapped(reconciliationProfile, 'specialist_asset_reconciliation', {
  category: 'pension', entityId: 'pension-reconciliation-second', decision: 'distinct'
});
assert.equal(
  reconciliationProfile.assumptions.values.completionFacts
    .specialistAssetReconciliation.pension['pension-reconciliation-test'],
  'duplicate'
);
assert.equal(
  reconciliationProfile.assumptions.values.completionFacts
    .specialistAssetReconciliation.pension['pension-reconciliation-second'],
  'distinct'
);
assert.equal(
  getModuleIntakeReadiness(MODULE_IDS.PERSONAL_BALANCE_SHEET, reconciliationProfile).status,
  'ready',
  'a reviewed duplicate-or-distinct decision releases the fail-closed PBS intake gate'
);
reconciliationProfile = applyMapped(reconciliationProfile, 'pension_current_value', {
  entityId: 'pension-reconciliation-test', amount: 65_000, currency: 'EUR'
});
assert.equal(
  reconciliationProfile.assumptions.values.completionFacts.specialistAssetReconciliation,
  undefined,
  'changing a specialist position invalidates its stale duplicate-or-distinct decision'
);
assert.equal(
  getModuleIntakeReadiness(MODULE_IDS.PERSONAL_BALANCE_SHEET, reconciliationProfile).status,
  'missing_information',
  'the changed specialist position must be reconciled again before PBS is ready'
);

for (const moduleId of [
  MODULE_IDS.CAT,
  MODULE_IDS.BUSINESS_OWNER_ANALYSIS,
  MODULE_IDS.BUSINESS_RELIEF_ANALYSIS,
  MODULE_IDS.BUSINESS_RELIEF,
  MODULE_IDS.AGRICULTURAL_RELIEF
]) {
  const definition = getPlanningModuleDefinition(moduleId);
  const intake = getModuleIntakeReadiness(moduleId, emptyProfile(`intake-${moduleId}`));
  assert.equal(definition.intakeContract.mode, 'adviser_handoff');
  assert.equal(definition.intakeContract.status, 'incomplete');
  assert.equal(intake.status, 'intake_contract_incomplete');
  assert.equal(definition.run, undefined, `${moduleId}: incomplete adviser intake is non-executable`);
}

let household = applyMapped(emptyProfile('intake-entities'), 'household_structure', 'couple');
const coupleReadiness = getModuleIntakeReadiness(MODULE_IDS.PERSONAL_BALANCE_SHEET, household);
const missingPartner = coupleReadiness.requiredMissing.find((item) => item.fieldPath === '/partner');
assert.ok(missingPartner, 'couple intake fails closed until the partner is represented separately');
assert.equal(
  resolveSemanticFact(missingPartner, { profile: household, moduleId: MODULE_IDS.PERSONAL_BALANCE_SHEET }).factId,
  'partner_person',
  'the missing partner record resolves to a writable semantic fact'
);
household = applyMapped(household, 'partner_person', {
  displayName: 'Partner', employmentStatus: 'employee'
});
let personSummaryProfile = applyMapped(emptyProfile('intake-person-summary'), 'partner_person', {
  displayName: 'Partner', employmentStatus: 'employee'
});
personSummaryProfile = applyMapped(personSummaryProfile, 'person_current_age', { owner: 'primary', value: 42 });
personSummaryProfile = applyMapped(personSummaryProfile, 'intended_retirement_age', { owner: 'primary', value: 66 });
personSummaryProfile = applyMapped(personSummaryProfile, 'person_current_age', { owner: 'partner', value: 40 });
personSummaryProfile = applyMapped(personSummaryProfile, 'intended_retirement_age', { owner: 'partner', value: 65 });
const personSummary = buildConfirmedRealtimeFactSummary(personSummaryProfile)
  .filter((fact) => ['person_current_age', 'intended_retirement_age'].includes(fact.factId))
  .map((fact) => ({ factId: fact.factId, entityId: fact.entityId, value: fact.value }))
  .sort((left, right) => `${left.factId}:${left.entityId}`.localeCompare(`${right.factId}:${right.entityId}`));
assert.deepEqual(personSummary, [
  { factId: 'intended_retirement_age', entityId: 'partner_realtime', value: 65 },
  { factId: 'intended_retirement_age', entityId: 'primary', value: 66 },
  { factId: 'person_current_age', entityId: 'partner_realtime', value: 40 },
  { factId: 'person_current_age', entityId: 'primary', value: 42 }
]);
assert.equal(household.partner.personId, 'partner_realtime');

household = applyMapped(household, 'income_sources', [
  {
    entityId: 'primary_salary', owner: 'primary', type: 'employment', label: 'Primary salary',
    grossAnnual: 70_000
  },
  {
    entityId: 'partner_salary', owner: 'partner', type: 'employment', label: 'Partner salary',
    grossAnnual: 50_000
  }
]);
assert.equal(household.incomeSources.length, 2, 'joint incomes are stored as owner-specific repeatable positions');
assert.deepEqual(household.incomeSources.map((item) => item.ownerId), ['primary', 'partner_realtime']);
assert.throws(
  () => mapRealtimeFact(household, { factId: 'gross_household_income', value: 120_000 }),
  (error) => error?.code === 'realtime_joint_income_breakdown_required'
);

household = applyMapped(household, 'asset_position', {
  entityId: 'emergency_cash', type: 'cash', label: 'Emergency cash', currentValue: 25_000
});
household = applyMapped(household, 'property_position', {
  entityId: 'home', use: 'home', owner: 'joint', currentValue: 450_000
});
household = applyMapped(household, 'business_position', {
  entityId: 'consultancy', label: 'Consultancy', owner: 'primary', agricultural: false, estimatedValue: 90_000
});
household = applyMapped(household, 'liability_position', {
  entityId: 'mortgage', type: 'mortgage', label: 'Home mortgage', owner: 'joint', currentBalance: 180_000
});
assert.equal(household.assets.length, 1);
assert.equal(household.properties.length, 1);
assert.equal(household.businesses.length, 1);
assert.equal(household.liabilities.length, 1);

household = applyMapped(household, 'pension_positions', [
  {
    entityId: 'primary_work', owner: 'primary', type: 'occupational', currentValue: 80_000,
    employeeContributionRate: 8, employerContributionRate: 6
  },
  {
    entityId: 'partner_work', owner: 'partner', type: 'occupational', currentValue: 55_000,
    employeeContributionRate: 6, employerContributionRate: 5
  }
]);
assert.equal(household.pensions.length, 2, 'repeatable pensions retain separate owners');
household = applyMapped(household, 'pension_current_value', {
  entityId: 'partner_work', amount: 60_000, currency: 'EUR'
});
assert.equal(household.pensions.find((item) => item.ownerId === 'partner_realtime').currentValue.amount, 60_000);
const selectedPensionRate = mapRealtimeFact(household, {
  factId: 'pension_employee_contribution_rate',
  value: { entityId: 'partner_work', rate: 7 }
});
assert.match(
  buildRealtimeFactReadBack(
    'pension_employee_contribution_rate',
    selectedPensionRate.proposalValue,
    'exact',
    'EUR'
  ),
  /7%/,
  'selected-entity proposal wrappers retain exact numeric read-back formatting'
);

household = applyMapped(household, 'dependants', [
  { entityId: 'first_child', displayName: 'First child', currentAge: 12 },
  { entityId: 'second_child', displayName: 'Second child', currentAge: 9 }
]);
household = applyMapped(household, 'dependant_current_age', { entityId: 'second_child', age: 10 });
assert.deepEqual(household.dependants.map((item) => item.currentAge), [12, 10]);

household = applyMapped(household, 'college_cost_scenarios', [
  { scenarioId: 'at_home', title: 'At home', annualCostTodayPerChild: 8_000 },
  { scenarioId: 'away', title: 'Away from home', annualCostTodayPerChild: 15_000 }
]);
assert.equal(household.assumptions.values.collegeFunding.scenarios.length, 2);
const entitySummary = buildConfirmedRealtimeFactSummary(household);
assert.equal(entitySummary.filter((item) => item.factId === 'partner_person').length, 1);
assert.equal(entitySummary.filter((item) => item.factId === 'income_sources').length, 2);
assert.equal(entitySummary.filter((item) => item.factId === 'pension_positions').length, 2);
assert.equal(entitySummary.filter((item) => item.factId === 'dependants').length, 2);

household = applyMapped(household, 'asset_position', {
  operation: 'remove', entityId: 'emergency_cash'
});
assert.equal(household.assets.length, 0, 'entity removal uses stable identity');
household = applyMapped(household, 'asset_position', { operation: 'confirm_none' });
assert.equal(household.assumptions.values.completionFacts.confirmedNonePaths['/assets'], true);

console.info(`[ConsumerModuleIntake] PASS: ${tableModuleIds.length} table modules have explicit intake contracts`);
console.info('[ConsumerModuleIntake] PASS: required readiness fields resolve to writable registry-owned facts');
console.info('[ConsumerModuleIntake] PASS: joint income, PBS, pension, dependant and college entity operations');
