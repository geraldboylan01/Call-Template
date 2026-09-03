import {
  computeHousePurchaseProjection,
  createDefaultHousePurchaseInputs,
  normalizeHousePurchaseInputs
} from '../../house_purchase/index.js';
import {
  baseCurrency,
  cashAmount,
  confirmedNone,
  createModuleRunResult,
  crossCurrencyWarnings,
  findGoal,
  getAssumption,
  grossEmploymentIncome,
  householdAggregateNetIncome,
  missing,
  moneyAmount,
  netHouseholdIncome,
  readiness,
  readinessFromMissing
} from './common.js';

export const HOUSE_PURCHASE_ADAPTER_VERSION = '1.0.0';

function personPath(profile, personId) {
  return profile.partner?.personId === personId ? '/partner' : '/primaryPerson';
}

function applicantFor(profile, person, index) {
  const grossIncome = grossEmploymentIncome(profile, person.personId);
  const values = getAssumption(profile, `housePurchase.applicants.${person.personId}`, {});
  const defaultBuyerStatus = getAssumption(profile, 'housePurchase.schemeBuyerStatus', 'unknown');
  return {
    id: person.personId,
    label: person.displayName || (index === 0 ? 'Applicant' : 'Applicant 2'),
    age: person.age ?? null,
    employmentStatus: person.employmentStatus === 'retired' ? 'other' : (person.employmentStatus || 'unknown'),
    grossAnnualIncome: grossIncome > 0 ? grossIncome : null,
    variableAnnualIncome: Number.isFinite(values.variableAnnualIncome) ? values.variableAnnualIncome : 0,
    lenderRecognisedVariableAnnualIncome: Number.isFinite(values.lenderRecognisedVariableAnnualIncome)
      ? values.lenderRecognisedVariableAnnualIncome
      : 0,
    incomeReliability: values.incomeReliability || 'unknown',
    existingMonthlyDebtPayments: Number.isFinite(values.existingMonthlyDebtPayments)
      ? values.existingMonthlyDebtPayments
      : 0,
    schemeBuyerStatus: values.schemeBuyerStatus || defaultBuyerStatus,
    freshStartReason: values.freshStartReason || '',
    previouslyOwnedPropertyAnywhere: typeof values.previouslyOwnedPropertyAnywhere === 'boolean'
      ? values.previouslyOwnedPropertyAnywhere
      : null,
    retainedInterestInPreviousProperty: typeof values.retainedInterestInPreviousProperty === 'boolean'
      ? values.retainedInterestInPreviousProperty
      : null,
    rightToResideInIreland: typeof values.rightToResideInIreland === 'boolean'
      ? values.rightToResideInIreland
      : null
  };
}

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

function cashAssetsInBaseCurrency(profile, currency) {
  return (profile.assets || [])
    .filter((asset) => asset.type === 'cash')
    .map((asset) => ({ asset, amount: moneyAmount(asset.currentValue, currency) }))
    .filter((entry) => entry.amount !== null);
}

// Cash names an applicant only when the client attributed it to that person.
// Joint cash ("we have 25,000 saved") is stored against the household, so it
// belongs to the buyers together rather than to each of them in full.
function applicantOwnersOfCash(asset, applicantIds) {
  const named = applicantIds.filter((id) => asset.ownerIds.includes(id));
  return named.length > 0 ? named : applicantIds;
}

function hasSharedCash(profile, currency, applicantIds) {
  if (applicantIds.length < 2) return false;
  return cashAssetsInBaseCurrency(profile, currency)
    .some(({ asset }) => applicantOwnersOfCash(asset, applicantIds).length > 1);
}

// `cashSavingsContributions` is a decomposition of `currentCashSavings`, not a
// second measurement of it: the engine contract requires the rows to total the
// household cash exactly, and the engine itself never reads the split. So the
// household total stays counted once and is shared between the owners a cash
// holding actually has -- attributing a joint holding to both applicants in
// full would double the household's deposit on paper.
function cashSavingsContributions(profile, applicants, currency, totalCash) {
  const applicantIds = applicants.map((applicant) => applicant.id);
  if (applicantIds.length === 0) return [];
  const shares = new Map(applicantIds.map((id) => [id, 0]));
  for (const { asset, amount } of cashAssetsInBaseCurrency(profile, currency)) {
    const owners = applicantOwnersOfCash(asset, applicantIds);
    const share = amount / owners.length;
    owners.forEach((id) => shares.set(id, shares.get(id) + share));
  }
  const rows = applicantIds.map((id) => ({ ownerId: id, amount: roundCents(shares.get(id)) }));
  // Rounding each share to the cent can leave a fraction over. It settles on
  // the largest row so the split still totals the household cash exactly, which
  // is the invariant the engine checks.
  const residual = roundCents(totalCash - rows.reduce((total, row) => total + row.amount, 0));
  if (residual !== 0) {
    const target = rows.reduce((best, row) => (row.amount > best.amount ? row : best), rows[0]);
    target.amount = roundCents(target.amount + residual);
  }
  return rows;
}

export function getHousePurchaseReadiness(profile) {
  const moduleIds = ['house_purchase'];
  const goal = findGoal(profile, 'buy_home');
  if (!goal) return readinessFromMissing([], { relevant: false });
  const requiredMissing = [];
  const settings = getAssumption(profile, 'housePurchase', {});
  const people = [profile.primaryPerson, profile.partner].filter(Boolean);
  const applicantBuyerStatuses = people.map((person) => (
    getAssumption(profile, `housePurchase.applicants.${person.personId}.schemeBuyerStatus`, null)
      || settings.schemeBuyerStatus
      || 'unknown'
  ));
  const lendingCategory = settings.lendingCategory || (
    applicantBuyerStatuses.length > 0 && applicantBuyerStatuses.every((status) => status === 'first_time_buyer')
      ? 'first_time_buyer'
      : 'unknown'
  );
  if (!goal.targetAmount || moneyAmount(goal.targetAmount, baseCurrency(profile)) === null) {
    requiredMissing.push(missing(`/goals/${profile.goals.indexOf(goal)}/targetAmount`, 'Add an approximate target property price.', moduleIds));
  }
  if (!people.some((person) => grossEmploymentIncome(profile, person.personId) > 0)) {
    requiredMissing.push(missing('/incomeSources', 'Add gross annual household income.', moduleIds));
  }
  if (!(profile.assets || []).some((asset) => asset.type === 'cash' && asset.currentValue)) {
    requiredMissing.push(missing('/assets', 'Add current cash savings for the deposit journey.', moduleIds));
  }
  if (!profile.expenses?.monthlyEssential) {
    requiredMissing.push(missing(
      '/expenses/monthlyEssential',
      'Add essential monthly spending excluding rent and housing debt so the reserve is protected.',
      moduleIds
    ));
  }
  if (moneyAmount(profile.expenses?.currentMonthlyRent, baseCurrency(profile)) === null) {
    requiredMissing.push(missing(
      '/expenses/currentMonthlyRent',
      'Add current monthly rent, or enter none if there is no rent.',
      moduleIds
    ));
  }
  if (!['first_time_buyer', 'second_or_subsequent'].includes(lendingCategory)) {
    requiredMissing.push(missing(
      '/assumptions/values/housePurchase/lendingCategory',
      'Is this a first-time-buyer application, a fresh-start application, or a second/subsequent purchase?',
      moduleIds
    ));
  }
  const assumptionsUsed = [
    { key: 'purchaseCosts', value: 'dated engine defaults', reason: 'The existing deterministic engine owns buying-cost estimates.' },
    { key: 'mortgageIllustration', value: 'dated engine defaults', reason: 'The existing engine owns its illustration rate and term.' }
  ];
  // The affordability side of this module asks for a combined household
  // take-home figure, so a stated aggregate may answer it. It is declared,
  // because it is a household figure standing in for the sum of positions --
  // and it never answers the applicant-income requirement above, which is
  // checked per person against employment income only.
  if ((profile.incomeSources || []).every((income) => !income.netAnnual)
    && householdAggregateNetIncome(profile) !== null) {
    assumptionsUsed.push({
      key: 'monthlyNetHouseholdIncome',
      value: 'stated household total',
      reason: 'Take-home pay was given as a combined household figure rather than per person.'
    });
  }
  if (hasSharedCash(profile, baseCurrency(profile), people.map((person) => person.personId))) {
    assumptionsUsed.push({
      key: 'cashSavingsContributions',
      value: 'shared evenly between the buyers',
      reason: 'Cash held jointly was not attributed to one buyer, so the split shown is even. It does not change the illustration.'
    });
  }
  if (!goal.targetDate) {
    assumptionsUsed.push({ key: 'targetPurchaseDate', value: null, reason: 'No target date was provided; affordability still runs without a deadline.' });
  }
  const warnings = crossCurrencyWarnings(profile, [
    ['Cash assets', (profile.assets || []).filter((asset) => asset.type === 'cash').map((asset) => asset.currentValue)],
    ['Income', (profile.incomeSources || []).map((income) => income.grossAnnual || income.netAnnual)],
    ['Goal values', [goal.targetAmount]]
  ]);
  const terminalAbsences = [];
  if (confirmedNone(profile, '/incomeSources')
    && !people.some((person) => grossEmploymentIncome(profile, person.personId) > 0)) {
    terminalAbsences.push('The house-purchase illustration cannot run without positive household income. Add income later or discuss the goal with an adviser.');
  }
  if (['/expenses', '/expenses/annualTotal', '/expenses/monthlyEssential'].some((path) => confirmedNone(profile, path))
    && moneyAmount(profile.expenses?.monthlyEssential, baseCurrency(profile)) === null) {
    terminalAbsences.push('The house-purchase illustration cannot protect a cash reserve without essential spending. Add spending later or discuss the goal with an adviser.');
  }
  if (terminalAbsences.length > 0) {
    return readiness({
      status: 'adviser_review_required',
      assumptionsUsed,
      warnings: [...warnings, ...terminalAbsences]
    });
  }
  return readinessFromMissing(requiredMissing, { assumptionsUsed, warnings });
}

export function buildHousePurchaseInput(profile) {
  const calculationDateIso = profile.assumptions.calculationDateIso;
  const defaults = createDefaultHousePurchaseInputs(calculationDateIso);
  const goal = findGoal(profile, 'buy_home');
  const people = [profile.primaryPerson, profile.partner].filter(Boolean);
  const applicants = people.map((person, index) => applicantFor(profile, person, index));
  const currency = baseCurrency(profile);
  const netIncomeAnnual = netHouseholdIncome(profile);
  const totalCash = cashAmount(profile);
  const monthlyEssential = moneyAmount(profile.expenses?.monthlyEssential, currency)
    ?? (moneyAmount(profile.expenses?.annualTotal, currency) === null
      ? null
      : moneyAmount(profile.expenses?.annualTotal, currency) / 12);
  const currentMonthlyRent = moneyAmount(profile.expenses?.currentMonthlyRent, currency);
  const otherCommitments = (profile.liabilities || [])
    .filter((liability) => liability.type !== 'mortgage')
    .reduce((total, liability) => total + (moneyAmount(liability.monthlyPayment, currency) || 0), 0);
  const settings = getAssumption(profile, 'housePurchase', {});
  const buyerStatus = settings.lendingCategory || (
    applicants.length > 0 && applicants.every((applicant) => applicant.schemeBuyerStatus === 'first_time_buyer')
      ? 'first_time_buyer'
      : 'unknown'
  );
  return {
    ...defaults,
    calculationDateIso,
    lendingCategory: buyerStatus,
    applicationType: people.length > 1 ? 'joint' : 'single',
    applicants,
    currentCashSavings: totalCash,
    cashSavingsContributions: cashSavingsContributions(profile, applicants, currency, totalCash),
    amountRingfencedForOtherGoals: Number.isFinite(settings.amountRingfencedForOtherGoals)
      ? settings.amountRingfencedForOtherGoals
      : 0,
    emergencyReserveMode: Number.isFinite(settings.emergencyReserveTarget) ? 'custom' : 'suggested',
    emergencyReserveTarget: Number.isFinite(settings.emergencyReserveTarget) ? settings.emergencyReserveTarget : null,
    currentMonthlySavings: Number.isFinite(settings.currentMonthlySavings) ? settings.currentMonthlySavings : 0,
    plannedMonthlySavings: Number.isFinite(settings.plannedMonthlySavings)
      ? settings.plannedMonthlySavings
      : (Number.isFinite(settings.currentMonthlySavings) ? settings.currentMonthlySavings : 0),
    monthlyNetHouseholdIncome: netIncomeAnnual === null ? null : netIncomeAnnual / 12,
    monthlyEssentialExpensesExcludingHousingDebtAndRent: monthlyEssential === null
      ? null
      : monthlyEssential,
    currentMonthlyRent,
    dependants: profile.dependants.length,
    otherKnownMonthlyCommitments: otherCommitments,
    estimatedMonthlyOwnershipCosts: Number.isFinite(settings.estimatedMonthlyOwnershipCosts)
      ? settings.estimatedMonthlyOwnershipCosts
      : 0,
    targetPropertyPrice: moneyAmount(goal?.targetAmount, currency),
    targetPurchaseDate: goal?.targetDate || null,
    acquisitionType: settings.acquisitionType || 'unknown',
    dwellingType: settings.dwellingType || 'unknown',
    intendedUse: settings.intendedUse || 'principal_private_residence',
    localAuthorityCode: settings.localAuthorityCode || 'unknown',
    tenantNoticeReceived: typeof settings.tenantNoticeReceived === 'boolean' ? settings.tenantNoticeReceived : null,
    lenderCapacity: { ...defaults.lenderCapacity, ...(settings.lenderCapacity || {}) },
    helpToBuy: { ...defaults.helpToBuy, ...(settings.helpToBuy || {}) },
    firstHomeScheme: { ...defaults.firstHomeScheme, ...(settings.firstHomeScheme || {}) }
  };
}

/**
 * Hold the generated payload to the engine's own contract before the engine
 * sees it, so a mapping defect in this file is reported as an invalid input
 * rather than as an engine crash.
 */
export function validateHousePurchaseInput(input) {
  normalizeHousePurchaseInput(input);
}

const HOUSE_PURCHASE_TOP_LEVEL_FIELDS = Object.freeze([
  'schemaVersion', 'calculationDateIso', 'lendingCategory', 'applicationType', 'applicants',
  'currentCashSavings', 'cashSavingsContributions', 'amountRingfencedForOtherGoals',
  'emergencyReserveMode', 'emergencyReserveTarget', 'currentMonthlySavings',
  'plannedMonthlySavings', 'lumpSums', 'monthlyNetHouseholdIncome',
  'monthlyEssentialExpensesExcludingHousingDebtAndRent', 'currentMonthlyRent', 'dependants',
  'otherKnownMonthlyCommitments', 'estimatedMonthlyOwnershipCosts', 'targetPropertyPrice',
  'targetPurchaseDate', 'acquisitionType', 'dwellingType', 'intendedUse',
  'localAuthorityCode', 'tenantNoticeReceived', 'lenderCapacity', 'depositSavingsGrossAer',
  'dirtRate', 'mortgageIllustrationRate', 'mortgageTermYears', 'purchaseCosts',
  'helpToBuy', 'firstHomeScheme'
]);
const HOUSE_PURCHASE_APPLICANT_FIELDS = Object.freeze([
  'id', 'label', 'age', 'employmentStatus', 'grossAnnualIncome', 'variableAnnualIncome',
  'lenderRecognisedVariableAnnualIncome', 'incomeReliability', 'existingMonthlyDebtPayments',
  'schemeBuyerStatus', 'freshStartReason', 'previouslyOwnedPropertyAnywhere',
  'retainedInterestInPreviousProperty', 'rightToResideInIreland'
]);
const HOUSE_PURCHASE_NESTED_FIELDS = Object.freeze({
  lenderCapacity: ['status', 'amount', 'lenderId', 'isMaximumAvailable', 'macroPrudentialException', 'htbQualifyingLender'],
  purchaseCosts: ['stampDutyMode', 'customStampDuty', 'legalAndConveyancing', 'valuation', 'surveyOrEngineer', 'movingAndFurnishing', 'contingency'],
  helpToBuy: ['taxCompliant', 'revenueApprovedDeveloperOrApprover', 'expectedIncomeTaxAndDirtPaidPriorFourYears', 'confirmedClaimAmount'],
  firstHomeScheme: ['applicationStatus', 'confirmedEquityAmount', 'siteEquity']
});
const HOUSE_PURCHASE_ENUMS = Object.freeze({
  lendingCategory: ['first_time_buyer', 'second_or_subsequent', 'unknown'],
  applicationType: ['single', 'joint'],
  emergencyReserveMode: ['suggested', 'custom'],
  acquisitionType: ['new_build', 'second_hand', 'self_build', 'tenant_purchase', 'unknown'],
  dwellingType: ['house', 'apartment', 'self_build', 'unknown'],
  intendedUse: ['principal_private_residence', 'other', 'unknown']
});
const HOUSE_PURCHASE_APPLICANT_ENUMS = Object.freeze({
  employmentStatus: ['employee', 'self_employed', 'contractor', 'student', 'other', 'unknown'],
  incomeReliability: ['stable', 'variable', 'unknown'],
  schemeBuyerStatus: ['first_time_buyer', 'fresh_start', 'previous_owner', 'unknown']
});

function requireFiniteJsonNumber(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be ${nullable ? 'a finite number or null' : 'a finite number'}.`);
  }
}

function requireCanonicalEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`${label} must use a canonical module enum value.`);
  }
}

function requireNonEmptyJsonString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function requireNullableJsonBoolean(value, label) {
  if (value !== null && typeof value !== 'boolean') {
    throw new Error(`${label} must be true, false or null.`);
  }
}

function requireOwnFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const missingFields = fields.filter((field) => !Object.hasOwn(value, field));
  if (missingFields.length > 0) {
    throw new Error(`${label} must explicitly include: ${missingFields.join(', ')}.`);
  }
}

/** Canonical input the dated house-purchase engine will actually consume. */
export function normalizeHousePurchaseInput(input) {
  // The renderer's normalizer can sensibly display a half-filled form by
  // supplying zero/unknown defaults. At the calculation boundary those values
  // carry client meaning (no dependants, no commitments, no scheme claim), so
  // they must be authored by the semantic planner rather than reconstructed by
  // deterministic defaults. This check inspects JSON shape only.
  requireOwnFields(input, HOUSE_PURCHASE_TOP_LEVEL_FIELDS, 'generated.housePurchaseInputs');
  for (const [field, allowed] of Object.entries(HOUSE_PURCHASE_ENUMS)) {
    requireCanonicalEnum(input[field], allowed, `generated.housePurchaseInputs.${field}`);
  }
  for (const field of [
    'schemaVersion', 'currentCashSavings', 'amountRingfencedForOtherGoals',
    'currentMonthlySavings', 'plannedMonthlySavings', 'dependants',
    'otherKnownMonthlyCommitments', 'estimatedMonthlyOwnershipCosts',
    'depositSavingsGrossAer', 'dirtRate', 'mortgageIllustrationRate', 'mortgageTermYears'
  ]) {
    requireFiniteJsonNumber(input[field], `generated.housePurchaseInputs.${field}`);
  }
  for (const field of [
    'emergencyReserveTarget', 'monthlyNetHouseholdIncome',
    'monthlyEssentialExpensesExcludingHousingDebtAndRent', 'currentMonthlyRent',
    'targetPropertyPrice'
  ]) {
    requireFiniteJsonNumber(input[field], `generated.housePurchaseInputs.${field}`, { nullable: true });
  }
  requireNonEmptyJsonString(input.calculationDateIso, 'generated.housePurchaseInputs.calculationDateIso');
  requireNonEmptyJsonString(input.localAuthorityCode, 'generated.housePurchaseInputs.localAuthorityCode');
  if (input.targetPurchaseDate !== null) {
    requireNonEmptyJsonString(input.targetPurchaseDate, 'generated.housePurchaseInputs.targetPurchaseDate');
  }
  requireNullableJsonBoolean(input.tenantNoticeReceived, 'generated.housePurchaseInputs.tenantNoticeReceived');
  if (!Array.isArray(input.applicants) || input.applicants.length === 0) {
    throw new Error('generated.housePurchaseInputs.applicants must contain at least one applicant.');
  }
  input.applicants.forEach((applicant, index) => {
    const label = `generated.housePurchaseInputs.applicants[${index}]`;
    requireOwnFields(applicant, HOUSE_PURCHASE_APPLICANT_FIELDS, label);
    requireNonEmptyJsonString(applicant.id, `${label}.id`);
    requireNonEmptyJsonString(applicant.label, `${label}.label`);
    for (const [field, allowed] of Object.entries(HOUSE_PURCHASE_APPLICANT_ENUMS)) {
      requireCanonicalEnum(applicant[field], allowed, `${label}.${field}`);
    }
    for (const field of [
      'variableAnnualIncome', 'lenderRecognisedVariableAnnualIncome',
      'existingMonthlyDebtPayments'
    ]) {
      requireFiniteJsonNumber(applicant[field], `${label}.${field}`);
    }
    for (const field of ['age', 'grossAnnualIncome']) {
      requireFiniteJsonNumber(applicant[field], `${label}.${field}`, { nullable: true });
    }
    if (applicant.freshStartReason !== null && typeof applicant.freshStartReason !== 'string') {
      throw new Error(`${label}.freshStartReason must be a string or null.`);
    }
    for (const field of [
      'previouslyOwnedPropertyAnywhere', 'retainedInterestInPreviousProperty',
      'rightToResideInIreland'
    ]) {
      requireNullableJsonBoolean(applicant[field], `${label}.${field}`);
    }
  });
  for (const [field, required] of Object.entries(HOUSE_PURCHASE_NESTED_FIELDS)) {
    requireOwnFields(input[field], required, `generated.housePurchaseInputs.${field}`);
  }
  if (!Array.isArray(input.cashSavingsContributions) || !Array.isArray(input.lumpSums)) {
    throw new Error('generated.housePurchaseInputs contribution and lump-sum collections must be explicit arrays.');
  }
  input.cashSavingsContributions.forEach((entry, index) => {
    const label = `generated.housePurchaseInputs.cashSavingsContributions[${index}]`;
    requireOwnFields(entry, ['ownerId', 'amount'], label);
    requireNonEmptyJsonString(entry.ownerId, `${label}.ownerId`);
    requireFiniteJsonNumber(entry.amount, `${label}.amount`);
  });
  input.lumpSums.forEach((entry, index) => {
    const label = `generated.housePurchaseInputs.lumpSums[${index}]`;
    requireOwnFields(entry, ['id', 'amount', 'expectedDate', 'confidence'], label);
    requireNonEmptyJsonString(entry.id, `${label}.id`);
    requireFiniteJsonNumber(entry.amount, `${label}.amount`);
    if (entry.expectedDate !== null) requireNonEmptyJsonString(entry.expectedDate, `${label}.expectedDate`);
    requireCanonicalEnum(entry.confidence, ['confirmed', 'estimated'], `${label}.confidence`);
  });
  requireCanonicalEnum(
    input.lenderCapacity.status,
    ['not_obtained', 'estimated', 'confirmed', 'unknown'],
    'generated.housePurchaseInputs.lenderCapacity.status'
  );
  requireFiniteJsonNumber(
    input.lenderCapacity.amount,
    'generated.housePurchaseInputs.lenderCapacity.amount',
    { nullable: true }
  );
  requireCanonicalEnum(
    input.lenderCapacity.lenderId,
    ['aib', 'ebs', 'haven', 'bank_of_ireland', 'ptsb', 'other', 'unknown'],
    'generated.housePurchaseInputs.lenderCapacity.lenderId'
  );
  for (const field of ['isMaximumAvailable', 'macroPrudentialException', 'htbQualifyingLender']) {
    requireNullableJsonBoolean(input.lenderCapacity[field], `generated.housePurchaseInputs.lenderCapacity.${field}`);
  }
  requireCanonicalEnum(
    input.purchaseCosts.stampDutyMode,
    ['rules', 'custom'],
    'generated.housePurchaseInputs.purchaseCosts.stampDutyMode'
  );
  requireFiniteJsonNumber(
    input.purchaseCosts.customStampDuty,
    'generated.housePurchaseInputs.purchaseCosts.customStampDuty',
    { nullable: true }
  );
  for (const field of ['legalAndConveyancing', 'valuation', 'surveyOrEngineer', 'movingAndFurnishing', 'contingency']) {
    requireFiniteJsonNumber(input.purchaseCosts[field], `generated.housePurchaseInputs.purchaseCosts.${field}`);
  }
  for (const field of ['taxCompliant', 'revenueApprovedDeveloperOrApprover']) {
    requireNullableJsonBoolean(input.helpToBuy[field], `generated.housePurchaseInputs.helpToBuy.${field}`);
  }
  requireFiniteJsonNumber(
    input.helpToBuy.expectedIncomeTaxAndDirtPaidPriorFourYears,
    'generated.housePurchaseInputs.helpToBuy.expectedIncomeTaxAndDirtPaidPriorFourYears',
    { nullable: true }
  );
  requireFiniteJsonNumber(
    input.helpToBuy.confirmedClaimAmount,
    'generated.housePurchaseInputs.helpToBuy.confirmedClaimAmount'
  );
  requireCanonicalEnum(
    input.firstHomeScheme.applicationStatus,
    ['not_applied', 'potential', 'confirmed', 'declined', 'unknown'],
    'generated.housePurchaseInputs.firstHomeScheme.applicationStatus'
  );
  for (const field of ['confirmedEquityAmount', 'siteEquity']) {
    requireFiniteJsonNumber(input.firstHomeScheme[field], `generated.housePurchaseInputs.firstHomeScheme.${field}`);
  }
  return normalizeHousePurchaseInputs(input);
}

export async function runHousePurchaseAnalysis(input, context) {
  const projection = computeHousePurchaseProjection(input, {
    scenarioOverrides: context.scenarioOverrides || {}
  });
  const result = projection.result;
  return createModuleRunResult({
    moduleId: 'house_purchase',
    moduleVersion: context.moduleVersion,
    input,
    context,
    projection,
    semanticResult: {
      currency: context.baseCurrency || 'EUR',
      targetPropertyPrice: result.targetFunding.targetPropertyPrice,
      currentSupportablePrice: result.capacities.currentSupportablePrice,
      standardMortgageCapacity: result.capacities.standardMortgageCapacity,
      usableCurrentCash: result.targetFunding.usableCash,
      currentCashGap: result.targetFunding.currentCashGap,
      cashRequired: result.targetFunding.cashRequired,
      readyDateIso: result.targetFunding.readyDateIso,
      monthsToReady: result.targetFunding.monthsToReady,
      monthlySavingNeeded: result.targetFunding.monthlySavingNeeded,
      mortgageMonthlyPayment: result.mortgage.monthlyPayment,
      primaryBottleneck: result.bottlenecks.primary,
      readinessGates: result.readinessGates,
      ruleVersions: result.ruleVersions
    },
    warnings: [
      ...(result.ruleVersions.requiresReleaseSourceCheck
        ? [`Dated housing rules require a source refresh: ${result.ruleVersions.staleRuleIds.join(', ')}.`]
        : []),
      ...result.disclosures
    ]
  });
}
