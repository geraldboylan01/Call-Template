import { DEFAULT_HOUSE_PURCHASE_RULES } from './config.js';

const LENDING_CATEGORIES = new Set(['first_time_buyer', 'second_or_subsequent', 'unknown']);
const APPLICATION_TYPES = new Set(['single', 'joint']);
const EMPLOYMENT_STATUSES = new Set(['employee', 'self_employed', 'contractor', 'student', 'other', 'unknown']);
const INCOME_RELIABILITIES = new Set(['stable', 'variable', 'unknown']);
const SCHEME_BUYER_STATUSES = new Set(['first_time_buyer', 'fresh_start', 'previous_owner', 'unknown']);
const ACQUISITION_TYPES = new Set(['new_build', 'second_hand', 'self_build', 'tenant_purchase', 'unknown']);
const DWELLING_TYPES = new Set(['house', 'apartment', 'self_build', 'unknown']);
const INTENDED_USES = new Set(['principal_private_residence', 'other', 'unknown']);
const RESERVE_MODES = new Set(['suggested', 'custom']);
const LENDER_STATUSES = new Set(['not_obtained', 'estimated', 'confirmed', 'unknown']);
const FHS_APPLICATION_STATUSES = new Set(['not_applied', 'potential', 'confirmed', 'declined', 'unknown']);
const STAMP_DUTY_MODES = new Set(['rules', 'custom']);
const LUMP_SUM_CONFIDENCE = new Set(['confirmed', 'estimated']);

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function enumValue(value, allowed, fallback, fieldName) {
  const normalized = cleanString(value, fallback).toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`generated.housePurchaseInputs.${fieldName} has an unsupported value.`);
  }
  return normalized;
}

function finiteNumber(value, fallback, fieldName, { min = -Infinity, max = Infinity, integer = false, nullable = false } = {}) {
  if ((value === null || typeof value === 'undefined' || value === '') && nullable) {
    return null;
  }
  const candidate = (value === null || typeof value === 'undefined' || value === '') ? fallback : value;
  if (candidate === null && nullable) {
    return null;
  }
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new Error(`generated.housePurchaseInputs.${fieldName} must be a finite number${nullable ? ' or null' : ''}.`);
  }
  if (candidate < min || candidate > max || (integer && !Number.isInteger(candidate))) {
    const qualifier = integer ? 'integer' : 'number';
    throw new Error(`generated.housePurchaseInputs.${fieldName} must be a ${qualifier} between ${min} and ${max}.`);
  }
  return candidate;
}

function nullableBoolean(value, fallback = null, fieldName = 'value') {
  if (value === null || typeof value === 'undefined') {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`generated.housePurchaseInputs.${fieldName} must be true, false or null.`);
  }
  return value;
}

function requiredBoolean(value, fallback, fieldName) {
  if (typeof value === 'undefined' || value === null) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`generated.housePurchaseInputs.${fieldName} must be a boolean.`);
  }
  return value;
}

export function parseHousePurchaseIsoDate(value, fieldName, { nullable = false } = {}) {
  if ((value === null || typeof value === 'undefined' || value === '') && nullable) {
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error(`generated.housePurchaseInputs.${fieldName} must be a YYYY-MM-DD string${nullable ? ' or null' : ''}.`);
  }
  const normalized = value.trim();
  const [year, month, day] = normalized.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`generated.housePurchaseInputs.${fieldName} is not a valid calendar date.`);
  }
  return normalized;
}

function normalizeReserveMode(value) {
  const raw = cleanString(value, 'suggested').toLowerCase();
  const aliases = {
    recommended: 'suggested',
    default: 'suggested',
    six_months: 'suggested',
    accepted: 'suggested',
    none: 'custom'
  };
  return enumValue(aliases[raw] || raw, RESERVE_MODES, 'suggested', 'emergencyReserveMode');
}

function normalizeLenderStatus(value) {
  const raw = cleanString(value, 'not_obtained').toLowerCase();
  const aliases = {
    not_started: 'not_obtained',
    exploring: 'estimated',
    approval_in_principle: 'confirmed',
    aip: 'confirmed',
    declined: 'not_obtained'
  };
  return enumValue(aliases[raw] || raw, LENDER_STATUSES, 'not_obtained', 'lenderCapacity.status');
}

function normalizeFhsStatus(value) {
  const raw = cleanString(value, 'not_applied').toLowerCase();
  const aliases = {
    not_started: 'not_applied',
    considering: 'potential',
    approval_in_principle: 'potential'
  };
  return enumValue(aliases[raw] || raw, FHS_APPLICATION_STATUSES, 'not_applied', 'firstHomeScheme.applicationStatus');
}

function normalizeStampDutyMode(value) {
  const raw = cleanString(value, 'rules').toLowerCase();
  return enumValue(raw === 'calculated' ? 'rules' : raw, STAMP_DUTY_MODES, 'rules', 'purchaseCosts.stampDutyMode');
}

function normalizeLenderId(value) {
  const raw = cleanString(value, 'unknown').toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    boi: 'bank_of_ireland',
    bankofireland: 'bank_of_ireland',
    permanent_tsb: 'ptsb',
    permanenttsb: 'ptsb'
  };
  return aliases[raw] || raw;
}

function defaultApplicant(index = 0) {
  return {
    id: index === 0 ? 'applicant-1' : `applicant-${index + 1}`,
    label: index === 0 ? 'Applicant' : `Applicant ${index + 1}`,
    age: null,
    employmentStatus: 'unknown',
    grossAnnualIncome: null,
    variableAnnualIncome: 0,
    lenderRecognisedVariableAnnualIncome: 0,
    incomeReliability: 'unknown',
    existingMonthlyDebtPayments: 0,
    schemeBuyerStatus: 'unknown',
    freshStartReason: '',
    previouslyOwnedPropertyAnywhere: null,
    retainedInterestInPreviousProperty: null,
    rightToResideInIreland: null
  };
}

export function createDefaultHousePurchaseInputs(calculationDateIso = todayIso()) {
  const dateIso = parseHousePurchaseIsoDate(calculationDateIso, 'calculationDateIso');
  const rules = DEFAULT_HOUSE_PURCHASE_RULES;
  return {
    schemaVersion: rules.schemaVersion,
    calculationDateIso: dateIso,
    lendingCategory: 'unknown',
    applicationType: 'single',
    applicants: [defaultApplicant(0)],
    currentCashSavings: 0,
    cashSavingsContributions: [{ ownerId: 'applicant-1', amount: 0 }],
    amountRingfencedForOtherGoals: 0,
    emergencyReserveMode: 'suggested',
    emergencyReserveTarget: null,
    currentMonthlySavings: 0,
    plannedMonthlySavings: 0,
    lumpSums: [],
    monthlyNetHouseholdIncome: null,
    monthlyEssentialExpensesExcludingHousingDebtAndRent: null,
    currentMonthlyRent: null,
    dependants: 0,
    otherKnownMonthlyCommitments: 0,
    estimatedMonthlyOwnershipCosts: 0,
    targetPropertyPrice: null,
    targetPurchaseDate: null,
    acquisitionType: 'unknown',
    dwellingType: 'unknown',
    intendedUse: 'principal_private_residence',
    localAuthorityCode: '',
    tenantNoticeReceived: null,
    lenderCapacity: {
      status: 'not_obtained',
      amount: null,
      lenderId: 'unknown',
      isMaximumAvailable: null,
      macroPrudentialException: null,
      htbQualifyingLender: null
    },
    depositSavingsGrossAer: rules.depositSavings.grossAerDefault,
    dirtRate: rules.depositSavings.dirtRateDefault,
    mortgageIllustrationRate: rules.mortgage.illustrationRateDefault,
    mortgageTermYears: rules.mortgage.termYearsDefault,
    purchaseCosts: {
      stampDutyMode: 'rules',
      customStampDuty: null,
      legalAndConveyancing: rules.purchaseCosts.legalAndConveyancing,
      valuation: rules.purchaseCosts.valuation,
      surveyOrEngineer: rules.purchaseCosts.surveyOrEngineerByAcquisition.unknown,
      movingAndFurnishing: rules.purchaseCosts.movingAndFurnishing,
      contingency: rules.purchaseCosts.contingency
    },
    helpToBuy: {
      taxCompliant: null,
      revenueApprovedDeveloperOrApprover: null,
      expectedIncomeTaxAndDirtPaidPriorFourYears: null,
      confirmedClaimAmount: 0
    },
    firstHomeScheme: {
      applicationStatus: 'not_applied',
      confirmedEquityAmount: 0,
      siteEquity: 0
    }
  };
}

function normalizeApplicant(raw, index) {
  if (!isObject(raw)) {
    throw new Error(`generated.housePurchaseInputs.applicants[${index}] must be an object.`);
  }
  const fallback = defaultApplicant(index);
  return {
    id: cleanString(raw.id, fallback.id),
    label: cleanString(raw.label, fallback.label),
    age: finiteNumber(raw.age, null, `applicants[${index}].age`, { min: 0, max: 120, integer: true, nullable: true }),
    employmentStatus: enumValue(raw.employmentStatus, EMPLOYMENT_STATUSES, fallback.employmentStatus, `applicants[${index}].employmentStatus`),
    grossAnnualIncome: finiteNumber(raw.grossAnnualIncome, null, `applicants[${index}].grossAnnualIncome`, { min: 0, nullable: true }),
    variableAnnualIncome: finiteNumber(raw.variableAnnualIncome, 0, `applicants[${index}].variableAnnualIncome`, { min: 0 }),
    lenderRecognisedVariableAnnualIncome: finiteNumber(raw.lenderRecognisedVariableAnnualIncome, 0, `applicants[${index}].lenderRecognisedVariableAnnualIncome`, { min: 0 }),
    incomeReliability: enumValue(raw.incomeReliability, INCOME_RELIABILITIES, fallback.incomeReliability, `applicants[${index}].incomeReliability`),
    existingMonthlyDebtPayments: finiteNumber(raw.existingMonthlyDebtPayments, 0, `applicants[${index}].existingMonthlyDebtPayments`, { min: 0 }),
    schemeBuyerStatus: enumValue(raw.schemeBuyerStatus, SCHEME_BUYER_STATUSES, fallback.schemeBuyerStatus, `applicants[${index}].schemeBuyerStatus`),
    freshStartReason: cleanString(raw.freshStartReason),
    previouslyOwnedPropertyAnywhere: nullableBoolean(raw.previouslyOwnedPropertyAnywhere, null, `applicants[${index}].previouslyOwnedPropertyAnywhere`),
    retainedInterestInPreviousProperty: nullableBoolean(raw.retainedInterestInPreviousProperty, null, `applicants[${index}].retainedInterestInPreviousProperty`),
    rightToResideInIreland: nullableBoolean(raw.rightToResideInIreland, null, `applicants[${index}].rightToResideInIreland`)
  };
}

function normalizeLumpSum(raw, index) {
  if (!isObject(raw)) {
    throw new Error(`generated.housePurchaseInputs.lumpSums[${index}] must be an object.`);
  }
  return {
    id: cleanString(raw.id, `lump-sum-${index + 1}`),
    amount: finiteNumber(raw.amount, 0, `lumpSums[${index}].amount`, { min: 0 }),
    expectedDate: parseHousePurchaseIsoDate(raw.expectedDate, `lumpSums[${index}].expectedDate`, { nullable: true }),
    confidence: enumValue(raw.confidence, LUMP_SUM_CONFIDENCE, 'estimated', `lumpSums[${index}].confidence`)
  };
}

export function normalizeHousePurchaseInputs(raw, { allowPartial = false } = {}) {
  if ((raw === null || typeof raw === 'undefined') && allowPartial) {
    return null;
  }
  if (!isObject(raw)) {
    throw new Error('generated.housePurchaseInputs must be an object.');
  }
  const defaults = createDefaultHousePurchaseInputs(raw.calculationDateIso || todayIso());
  const applicationType = enumValue(raw.applicationType, APPLICATION_TYPES, defaults.applicationType, 'applicationType');
  const rawApplicants = Array.isArray(raw.applicants) ? raw.applicants : defaults.applicants;
  const expectedCount = applicationType === 'joint' ? 2 : 1;
  if (!allowPartial && rawApplicants.length !== expectedCount) {
    throw new Error(`generated.housePurchaseInputs.applicants must contain exactly ${expectedCount} applicant${expectedCount === 1 ? '' : 's'}.`);
  }
  if (rawApplicants.length < 1 || rawApplicants.length > 2) {
    throw new Error('generated.housePurchaseInputs.applicants must contain one or two applicants.');
  }
  const applicants = rawApplicants.slice(0, expectedCount).map(normalizeApplicant);
  while (allowPartial && applicants.length < expectedCount) {
    applicants.push(defaultApplicant(applicants.length));
  }
  const ids = applicants.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('generated.housePurchaseInputs applicant ids must be unique.');
  }

  const currentCashSavings = finiteNumber(raw.currentCashSavings, defaults.currentCashSavings, 'currentCashSavings', { min: 0 });
  let cashSavingsContributions = Array.isArray(raw.cashSavingsContributions)
    ? raw.cashSavingsContributions.map((entry, index) => {
      if (!isObject(entry)) {
        throw new Error(`generated.housePurchaseInputs.cashSavingsContributions[${index}] must be an object.`);
      }
      const ownerId = cleanString(entry.ownerId);
      if (!ids.includes(ownerId)) {
        throw new Error(`generated.housePurchaseInputs.cashSavingsContributions[${index}].ownerId must match an applicant id.`);
      }
      return {
        ownerId,
        amount: finiteNumber(entry.amount, 0, `cashSavingsContributions[${index}].amount`, { min: 0 })
      };
    })
    : (applicationType === 'single' ? [{ ownerId: applicants[0].id, amount: currentCashSavings }] : []);

  if (!allowPartial && applicationType === 'joint' && currentCashSavings > 0 && cashSavingsContributions.length === 0) {
    throw new Error('generated.housePurchaseInputs.cashSavingsContributions must identify the joint applicants\u2019 included savings.');
  }
  const contributionTotal = cashSavingsContributions.reduce((sum, entry) => sum + entry.amount, 0);
  if (!allowPartial && Math.abs(contributionTotal - currentCashSavings) > 0.01) {
    throw new Error('generated.housePurchaseInputs.cashSavingsContributions must total currentCashSavings.');
  }
  if (allowPartial && cashSavingsContributions.length === 0 && currentCashSavings === 0) {
    cashSavingsContributions = applicants.map((entry) => ({ ownerId: entry.id, amount: 0 }));
  }

  const acquisitionType = enumValue(raw.acquisitionType, ACQUISITION_TYPES, defaults.acquisitionType, 'acquisitionType');
  const surveyDefault = DEFAULT_HOUSE_PURCHASE_RULES.purchaseCosts.surveyOrEngineerByAcquisition[acquisitionType];
  const rawLender = isObject(raw.lenderCapacity) ? raw.lenderCapacity : {};
  const rawCosts = isObject(raw.purchaseCosts) ? raw.purchaseCosts : {};
  const rawHtb = isObject(raw.helpToBuy) ? raw.helpToBuy : {};
  const rawFhs = isObject(raw.firstHomeScheme) ? raw.firstHomeScheme : {};

  const normalized = {
    schemaVersion: finiteNumber(raw.schemaVersion, defaults.schemaVersion, 'schemaVersion', { min: 1, integer: true }),
    calculationDateIso: parseHousePurchaseIsoDate(raw.calculationDateIso || defaults.calculationDateIso, 'calculationDateIso'),
    lendingCategory: enumValue(raw.lendingCategory, LENDING_CATEGORIES, defaults.lendingCategory, 'lendingCategory'),
    applicationType,
    applicants,
    currentCashSavings,
    cashSavingsContributions,
    amountRingfencedForOtherGoals: finiteNumber(raw.amountRingfencedForOtherGoals, 0, 'amountRingfencedForOtherGoals', { min: 0 }),
    emergencyReserveMode: normalizeReserveMode(raw.emergencyReserveMode),
    emergencyReserveTarget: finiteNumber(raw.emergencyReserveTarget, null, 'emergencyReserveTarget', { min: 0, nullable: true }),
    currentMonthlySavings: finiteNumber(raw.currentMonthlySavings, 0, 'currentMonthlySavings', { min: 0 }),
    plannedMonthlySavings: finiteNumber(raw.plannedMonthlySavings, raw.currentMonthlySavings ?? 0, 'plannedMonthlySavings', { min: 0 }),
    lumpSums: Array.isArray(raw.lumpSums) ? raw.lumpSums.map(normalizeLumpSum) : [],
    monthlyNetHouseholdIncome: finiteNumber(raw.monthlyNetHouseholdIncome, null, 'monthlyNetHouseholdIncome', { min: 0, nullable: true }),
    monthlyEssentialExpensesExcludingHousingDebtAndRent: finiteNumber(raw.monthlyEssentialExpensesExcludingHousingDebtAndRent, null, 'monthlyEssentialExpensesExcludingHousingDebtAndRent', { min: 0, nullable: true }),
    currentMonthlyRent: finiteNumber(raw.currentMonthlyRent, null, 'currentMonthlyRent', { min: 0, nullable: true }),
    dependants: finiteNumber(raw.dependants, 0, 'dependants', { min: 0, integer: true }),
    otherKnownMonthlyCommitments: finiteNumber(raw.otherKnownMonthlyCommitments, 0, 'otherKnownMonthlyCommitments', { min: 0 }),
    estimatedMonthlyOwnershipCosts: finiteNumber(raw.estimatedMonthlyOwnershipCosts, 0, 'estimatedMonthlyOwnershipCosts', { min: 0 }),
    targetPropertyPrice: finiteNumber(raw.targetPropertyPrice, null, 'targetPropertyPrice', { min: 0, nullable: true }),
    targetPurchaseDate: parseHousePurchaseIsoDate(raw.targetPurchaseDate, 'targetPurchaseDate', { nullable: true }),
    acquisitionType,
    dwellingType: enumValue(raw.dwellingType, DWELLING_TYPES, acquisitionType === 'self_build' ? 'self_build' : defaults.dwellingType, 'dwellingType'),
    intendedUse: enumValue(raw.intendedUse, INTENDED_USES, defaults.intendedUse, 'intendedUse'),
    localAuthorityCode: cleanString(raw.localAuthorityCode),
    tenantNoticeReceived: nullableBoolean(raw.tenantNoticeReceived, null, 'tenantNoticeReceived'),
    lenderCapacity: {
      status: normalizeLenderStatus(rawLender.status),
      amount: finiteNumber(rawLender.amount, null, 'lenderCapacity.amount', { min: 0, nullable: true }),
      lenderId: normalizeLenderId(rawLender.lenderId),
      isMaximumAvailable: nullableBoolean(rawLender.isMaximumAvailable, null, 'lenderCapacity.isMaximumAvailable'),
      macroPrudentialException: nullableBoolean(rawLender.macroPrudentialException, null, 'lenderCapacity.macroPrudentialException'),
      htbQualifyingLender: nullableBoolean(rawLender.htbQualifyingLender, null, 'lenderCapacity.htbQualifyingLender')
    },
    depositSavingsGrossAer: finiteNumber(raw.depositSavingsGrossAer, defaults.depositSavingsGrossAer, 'depositSavingsGrossAer', { min: 0, max: 1 }),
    dirtRate: finiteNumber(raw.dirtRate, defaults.dirtRate, 'dirtRate', { min: 0, max: 1 }),
    mortgageIllustrationRate: finiteNumber(raw.mortgageIllustrationRate, defaults.mortgageIllustrationRate, 'mortgageIllustrationRate', { min: 0, max: 1 }),
    mortgageTermYears: finiteNumber(raw.mortgageTermYears, defaults.mortgageTermYears, 'mortgageTermYears', { min: 1, max: 50, integer: true }),
    purchaseCosts: {
      stampDutyMode: normalizeStampDutyMode(rawCosts.stampDutyMode),
      customStampDuty: finiteNumber(rawCosts.customStampDuty, null, 'purchaseCosts.customStampDuty', { min: 0, nullable: true }),
      legalAndConveyancing: finiteNumber(rawCosts.legalAndConveyancing, defaults.purchaseCosts.legalAndConveyancing, 'purchaseCosts.legalAndConveyancing', { min: 0 }),
      valuation: finiteNumber(rawCosts.valuation, defaults.purchaseCosts.valuation, 'purchaseCosts.valuation', { min: 0 }),
      surveyOrEngineer: finiteNumber(rawCosts.surveyOrEngineer, surveyDefault, 'purchaseCosts.surveyOrEngineer', { min: 0 }),
      movingAndFurnishing: finiteNumber(rawCosts.movingAndFurnishing, defaults.purchaseCosts.movingAndFurnishing, 'purchaseCosts.movingAndFurnishing', { min: 0 }),
      contingency: finiteNumber(rawCosts.contingency, defaults.purchaseCosts.contingency, 'purchaseCosts.contingency', { min: 0 })
    },
    helpToBuy: {
      taxCompliant: nullableBoolean(rawHtb.taxCompliant, null, 'helpToBuy.taxCompliant'),
      revenueApprovedDeveloperOrApprover: nullableBoolean(rawHtb.revenueApprovedDeveloperOrApprover, null, 'helpToBuy.revenueApprovedDeveloperOrApprover'),
      expectedIncomeTaxAndDirtPaidPriorFourYears: finiteNumber(rawHtb.expectedIncomeTaxAndDirtPaidPriorFourYears, null, 'helpToBuy.expectedIncomeTaxAndDirtPaidPriorFourYears', { min: 0, nullable: true }),
      confirmedClaimAmount: finiteNumber(rawHtb.confirmedClaimAmount, 0, 'helpToBuy.confirmedClaimAmount', { min: 0, max: DEFAULT_HOUSE_PURCHASE_RULES.helpToBuy.maximumRelief })
    },
    firstHomeScheme: {
      applicationStatus: normalizeFhsStatus(rawFhs.applicationStatus),
      confirmedEquityAmount: finiteNumber(rawFhs.confirmedEquityAmount, 0, 'firstHomeScheme.confirmedEquityAmount', { min: 0 }),
      siteEquity: finiteNumber(rawFhs.siteEquity, 0, 'firstHomeScheme.siteEquity', { min: 0 })
    }
  };

  if (normalized.purchaseCosts.stampDutyMode === 'custom' && normalized.purchaseCosts.customStampDuty === null && !allowPartial) {
    throw new Error('generated.housePurchaseInputs.purchaseCosts.customStampDuty is required when stampDutyMode is custom.');
  }
  if (normalized.emergencyReserveMode === 'custom' && normalized.emergencyReserveTarget === null && !allowPartial) {
    throw new Error('generated.housePurchaseInputs.emergencyReserveTarget is required when emergencyReserveMode is custom.');
  }
  if (!allowPartial) {
    if (!(normalized.targetPropertyPrice > 0)) {
      throw new Error('generated.housePurchaseInputs.targetPropertyPrice must be greater than 0 for calculation.');
    }
    if (normalized.lendingCategory === 'unknown') {
      throw new Error('generated.housePurchaseInputs.lendingCategory is required for calculation.');
    }
    normalized.applicants.forEach((applicant, index) => {
      if (applicant.grossAnnualIncome === null) {
        throw new Error(`generated.housePurchaseInputs.applicants[${index}].grossAnnualIncome is required for calculation.`);
      }
    });
    if ((normalized.lenderCapacity.status === 'estimated' || normalized.lenderCapacity.status === 'confirmed')
      && normalized.lenderCapacity.amount === null) {
      throw new Error('generated.housePurchaseInputs.lenderCapacity.amount is required when status is estimated or confirmed.');
    }
  }

  return normalized;
}
