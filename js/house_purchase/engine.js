import { computeMonthlyPayment } from '../mortgage_math.js';
import { computeWorkingLiquidityReserve } from '../liquidity_reserve.js';
import {
  DEFAULT_HOUSE_PURCHASE_RULES,
  FHS_PRICE_CEILINGS,
  FHS_PRICE_CEILING_ROWS,
  HOUSE_PURCHASE_RULES,
  HOUSE_PURCHASE_SOURCE_METADATA
} from './config.js';
import {
  createDefaultHousePurchaseInputs,
  normalizeHousePurchaseInputs,
  parseHousePurchaseIsoDate
} from './normalize.js';
import {
  calculatePurchaseCosts,
  calculateStampDuty,
  roundHousePurchaseMoney
} from './calculations.js';
import {
  findFhsPriceCeiling,
  screenFirstHomeScheme,
  screenHelpToBuy
} from './schemes.js';

/**
 * @typedef {Object} HousePurchaseApplicant
 * @property {string} id
 * @property {string} label
 * @property {?number} age
 * @property {'employee'|'self_employed'|'contractor'|'student'|'other'|'unknown'} employmentStatus
 * @property {?number} grossAnnualIncome
 * @property {number} variableAnnualIncome
 * @property {number} lenderRecognisedVariableAnnualIncome
 * @property {'stable'|'variable'|'unknown'} incomeReliability
 * @property {number} existingMonthlyDebtPayments
 * @property {'first_time_buyer'|'fresh_start'|'previous_owner'|'unknown'} schemeBuyerStatus
 * @property {string} freshStartReason
 * @property {?boolean} previouslyOwnedPropertyAnywhere
 * @property {?boolean} retainedInterestInPreviousProperty
 * @property {?boolean} rightToResideInIreland
 */

/**
 * @typedef {Object} HousePurchaseInputs
 * @property {number} schemaVersion
 * @property {string} calculationDateIso
 * @property {'first_time_buyer'|'second_or_subsequent'|'unknown'} lendingCategory
 * @property {'single'|'joint'} applicationType
 * @property {HousePurchaseApplicant[]} applicants
 * @property {number} currentCashSavings
 * @property {{ownerId:string,amount:number}[]} cashSavingsContributions
 * @property {number} amountRingfencedForOtherGoals
 * @property {'suggested'|'custom'} emergencyReserveMode
 * @property {?number} emergencyReserveTarget
 * @property {number} currentMonthlySavings
 * @property {number} plannedMonthlySavings
 * @property {{id:string,amount:number,expectedDate:?string,confidence:'confirmed'|'estimated'}[]} lumpSums
 * @property {?number} monthlyNetHouseholdIncome
 * @property {?number} monthlyEssentialExpensesExcludingHousingDebtAndRent
 * @property {?number} currentMonthlyRent
 * @property {number} dependants
 * @property {number} otherKnownMonthlyCommitments
 * @property {number} estimatedMonthlyOwnershipCosts
 * @property {?number} targetPropertyPrice
 * @property {?string} targetPurchaseDate
 * @property {'new_build'|'second_hand'|'self_build'|'tenant_purchase'|'unknown'} acquisitionType
 * @property {'house'|'apartment'|'self_build'|'unknown'} dwellingType
 * @property {'principal_private_residence'|'other'|'unknown'} intendedUse
 * @property {string} localAuthorityCode
 * @property {?boolean} tenantNoticeReceived
 * @property {{status:string,amount:?number,lenderId:string,isMaximumAvailable:?boolean,macroPrudentialException:?boolean,htbQualifyingLender:?boolean}} lenderCapacity
 * @property {number} depositSavingsGrossAer
 * @property {number} dirtRate
 * @property {number} mortgageIllustrationRate
 * @property {number} mortgageTermYears
 * @property {{stampDutyMode:'rules'|'custom',customStampDuty:?number,legalAndConveyancing:number,valuation:number,surveyOrEngineer:number,movingAndFurnishing:number,contingency:number}} purchaseCosts
 * @property {{taxCompliant:?boolean,revenueApprovedDeveloperOrApprover:?boolean,expectedIncomeTaxAndDirtPaidPriorFourYears:?number,confirmedClaimAmount:number}} helpToBuy
 * @property {{applicationStatus:string,confirmedEquityAmount:number,siteEquity:number}} firstHomeScheme
 */

/**
 * @typedef {Object} HousePurchaseProjectionResult
 * @property {Object} capacities
 * @property {Object} targetFunding
 * @property {Object} depositTimeline
 * @property {Object} mortgage
 * @property {Object} householdAffordability
 * @property {Object} affordability Compatibility alias for householdAffordability.
 * @property {Object} fundingStack
 * @property {Object} bottlenecks
 * @property {Object} schemes
 * @property {Object[]} actions
 * @property {Object} readinessGates
 * @property {Object} ruleVersions
 */

export {
  DEFAULT_HOUSE_PURCHASE_RULES,
  FHS_PRICE_CEILINGS,
  FHS_PRICE_CEILING_ROWS,
  HOUSE_PURCHASE_RULES,
  HOUSE_PURCHASE_SOURCE_METADATA,
  calculateStampDuty,
  createDefaultHousePurchaseInputs,
  findFhsPriceCeiling,
  normalizeHousePurchaseInputs,
  screenFirstHomeScheme,
  screenHelpToBuy
};

export const HOUSE_PURCHASE_SCENARIO_OVERRIDE_KEYS = Object.freeze([
  'targetPropertyPrice',
  'targetPurchaseDate',
  'plannedMonthlySavings',
  'applicantIncomeById',
  'depositSavingsGrossAer',
  'mortgageIllustrationRate',
  'mortgageTermYears',
  'emergencyReserveTarget',
  'supportCase',
  'includeVariableIncome'
]);
export const HOUSE_PURCHASE_RULE_MAX_AGE_DAYS = 90;

const SUPPORT_CASES = new Set(['none', 'htb_only', 'fhs_only', 'htb_and_fhs']);
const EURO_FORMATTER = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

function formatEuro(value) {
  return EURO_FORMATTER.format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value, digits = 1) {
  return `${((Number.isFinite(value) ? value : 0) * 100).toFixed(digits)}%`;
}

function toUtcDate(iso) {
  return new Date(`${iso}T00:00:00.000Z`);
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function endOfUtcMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function addUtcMonths(date, count) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
}

function monthsThroughTarget(calculationDateIso, targetDateIso) {
  if (!targetDateIso) return null;
  const calculationDate = toUtcDate(calculationDateIso);
  const targetDate = toUtcDate(targetDateIso);
  const monthDelta = ((targetDate.getUTCFullYear() - calculationDate.getUTCFullYear()) * 12)
    + targetDate.getUTCMonth() - calculationDate.getUTCMonth();
  // The selected target is interpreted as the end of its calendar month.
  if (monthDelta < 0) return 0;
  return monthDelta + 1;
}

function ruleAgeDays(calculationDateIso, verifiedDateIso) {
  const age = (toUtcDate(calculationDateIso).getTime() - toUtcDate(verifiedDateIso).getTime()) / 86400000;
  return Math.max(0, Math.floor(age));
}

function assertScenarioNumber(value, key, { integer = false, min = 0, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`scenarioOverrides.${key} must be a ${integer ? 'whole ' : ''}number between ${min} and ${max}.`);
  }
  return value;
}

function inferBaseSupportCase(inputs) {
  const hasHtb = inputs.helpToBuy.confirmedClaimAmount > 0;
  const hasFhs = inputs.firstHomeScheme.applicationStatus === 'confirmed'
    && inputs.firstHomeScheme.confirmedEquityAmount > 0;
  if (hasHtb && hasFhs) return 'htb_and_fhs';
  if (hasHtb) return 'htb_only';
  if (hasFhs) return 'fhs_only';
  return 'none';
}

function applyScenarioOverrides(baseInputs, scenarioOverrides) {
  if (!scenarioOverrides || typeof scenarioOverrides !== 'object' || Array.isArray(scenarioOverrides)) {
    throw new Error('scenarioOverrides must be an object.');
  }
  Object.keys(scenarioOverrides).forEach((key) => {
    if (!HOUSE_PURCHASE_SCENARIO_OVERRIDE_KEYS.includes(key)) {
      throw new Error(`scenarioOverrides.${key} is not a supported house-purchase lever.`);
    }
  });

  const patched = {
    ...baseInputs,
    applicants: baseInputs.applicants.map((applicant) => ({ ...applicant })),
    cashSavingsContributions: baseInputs.cashSavingsContributions.map((entry) => ({ ...entry })),
    lumpSums: baseInputs.lumpSums.map((entry) => ({ ...entry })),
    lenderCapacity: { ...baseInputs.lenderCapacity },
    purchaseCosts: { ...baseInputs.purchaseCosts },
    helpToBuy: { ...baseInputs.helpToBuy },
    firstHomeScheme: { ...baseInputs.firstHomeScheme }
  };

  if (typeof scenarioOverrides.targetPropertyPrice !== 'undefined') {
    patched.targetPropertyPrice = assertScenarioNumber(scenarioOverrides.targetPropertyPrice, 'targetPropertyPrice', { min: 1 });
  }
  if (typeof scenarioOverrides.targetPurchaseDate !== 'undefined') {
    patched.targetPurchaseDate = parseHousePurchaseIsoDate(
      scenarioOverrides.targetPurchaseDate,
      'scenarioOverrides.targetPurchaseDate',
      { nullable: true }
    );
  }
  if (typeof scenarioOverrides.plannedMonthlySavings !== 'undefined') {
    patched.plannedMonthlySavings = assertScenarioNumber(scenarioOverrides.plannedMonthlySavings, 'plannedMonthlySavings');
  }
  if (typeof scenarioOverrides.depositSavingsGrossAer !== 'undefined') {
    patched.depositSavingsGrossAer = assertScenarioNumber(scenarioOverrides.depositSavingsGrossAer, 'depositSavingsGrossAer', { max: 1 });
  }
  if (typeof scenarioOverrides.mortgageIllustrationRate !== 'undefined') {
    patched.mortgageIllustrationRate = assertScenarioNumber(scenarioOverrides.mortgageIllustrationRate, 'mortgageIllustrationRate', { max: 1 });
  }
  if (typeof scenarioOverrides.mortgageTermYears !== 'undefined') {
    patched.mortgageTermYears = assertScenarioNumber(scenarioOverrides.mortgageTermYears, 'mortgageTermYears', { integer: true, min: 1, max: 50 });
  }
  if (typeof scenarioOverrides.emergencyReserveTarget !== 'undefined') {
    patched.emergencyReserveTarget = assertScenarioNumber(scenarioOverrides.emergencyReserveTarget, 'emergencyReserveTarget');
    patched.emergencyReserveMode = 'custom';
  }
  if (typeof scenarioOverrides.applicantIncomeById !== 'undefined') {
    const byId = scenarioOverrides.applicantIncomeById;
    if (!byId || typeof byId !== 'object' || Array.isArray(byId)) {
      throw new Error('scenarioOverrides.applicantIncomeById must be an object keyed by applicant id.');
    }
    Object.entries(byId).forEach(([id, amount]) => {
      const applicant = patched.applicants.find((entry) => entry.id === id);
      if (!applicant) throw new Error(`scenarioOverrides.applicantIncomeById.${id} does not match an applicant.`);
      applicant.grossAnnualIncome = assertScenarioNumber(amount, `applicantIncomeById.${id}`);
    });
  }
  if (scenarioOverrides.includeVariableIncome === true) {
    patched.applicants.forEach((applicant) => {
      applicant.lenderRecognisedVariableAnnualIncome = Math.max(
        applicant.lenderRecognisedVariableAnnualIncome,
        applicant.variableAnnualIncome
      );
    });
  } else if (typeof scenarioOverrides.includeVariableIncome !== 'undefined' && scenarioOverrides.includeVariableIncome !== false) {
    throw new Error('scenarioOverrides.includeVariableIncome must be a boolean.');
  }

  const supportCase = typeof scenarioOverrides.supportCase === 'undefined'
    ? inferBaseSupportCase(baseInputs)
    : String(scenarioOverrides.supportCase);
  if (!SUPPORT_CASES.has(supportCase)) {
    throw new Error('scenarioOverrides.supportCase must be none, htb_only, fhs_only or htb_and_fhs.');
  }

  return {
    inputs: normalizeHousePurchaseInputs(patched),
    supportCase,
    supportCaseWasExplicit: Object.hasOwn(scenarioOverrides, 'supportCase')
  };
}

function resolveReserve(inputs, rules) {
  const applicantDebtPayments = inputs.applicants.reduce((sum, entry) => sum + entry.existingMonthlyDebtPayments, 0);
  const reserveInputsComplete = inputs.monthlyEssentialExpensesExcludingHousingDebtAndRent !== null
    && inputs.currentMonthlyRent !== null;
  const monthlyExpenditure = reserveInputsComplete
    ? inputs.monthlyEssentialExpensesExcludingHousingDebtAndRent
      + inputs.currentMonthlyRent
      + inputs.otherKnownMonthlyCommitments
      + applicantDebtPayments
    : null;
  const reserveCalculation = computeWorkingLiquidityReserve({
    currentCash: inputs.currentCashSavings,
    monthlyExpenditure,
    minimumBufferMonths: rules.reserve.liquiditySafetyFloorMonths,
    targetBufferMonths: rules.reserve.recommendedMonths
  });
  const suggestedReserveTarget = reserveCalculation.targetCash;
  const appliedReserveTarget = inputs.emergencyReserveMode === 'custom'
    ? (inputs.emergencyReserveTarget ?? 0)
    : (suggestedReserveTarget ?? 0);
  const protectedCash = inputs.amountRingfencedForOtherGoals + appliedReserveTarget;
  return {
    applicantDebtPayments,
    reserveInputsComplete,
    reserveCalculation,
    suggestedReserveTarget,
    appliedReserveTarget,
    protectedCash,
    usableCurrentCash: Math.max(0, inputs.currentCashSavings - protectedCash),
    protectedCashShortfall: Math.max(0, protectedCash - inputs.currentCashSavings)
  };
}

function resolveMortgageCapacity(inputs, rules) {
  const qualifyingIncome = inputs.applicants.reduce(
    (sum, applicant) => sum + applicant.grossAnnualIncome + applicant.lenderRecognisedVariableAnnualIncome,
    0
  );
  const rawVariableIncome = inputs.applicants.reduce((sum, applicant) => sum + applicant.variableAnnualIncome, 0);
  const centralBankMultiple = inputs.lendingCategory === 'first_time_buyer'
    ? rules.mortgage.firstTimeBuyerIncomeMultiple
    : rules.mortgage.secondSubsequentBuyerIncomeMultiple;
  const standardMortgageCapacity = qualifyingIncome * centralBankMultiple;
  const suppliedAmount = inputs.lenderCapacity.amount;
  const hasSuppliedCapacity = suppliedAmount !== null
    && (inputs.lenderCapacity.status === 'estimated' || inputs.lenderCapacity.status === 'confirmed');
  const suppliedAboveStandard = hasSuppliedCapacity && suppliedAmount > standardMortgageCapacity + 0.01;
  let lenderMortgageCapacity = hasSuppliedCapacity ? suppliedAmount : null;
  let usableMortgageCapacity = standardMortgageCapacity;
  let lenderCapacityTreatment = 'standard_rule_estimate';
  if (hasSuppliedCapacity) {
    if (suppliedAboveStandard && inputs.lenderCapacity.macroPrudentialException !== true) {
      usableMortgageCapacity = standardMortgageCapacity;
      lenderCapacityTreatment = 'capped_pending_exception_confirmation';
    } else {
      usableMortgageCapacity = Math.max(0, suppliedAmount);
      lenderCapacityTreatment = suppliedAboveStandard ? 'confirmed_macro_prudential_exception' : 'lender_amount';
    }
  }
  return {
    qualifyingIncome: roundHousePurchaseMoney(qualifyingIncome),
    rawVariableIncome: roundHousePurchaseMoney(rawVariableIncome),
    centralBankMultiple,
    standardMortgageCapacity: roundHousePurchaseMoney(standardMortgageCapacity),
    lenderMortgageCapacity: lenderMortgageCapacity === null ? null : roundHousePurchaseMoney(lenderMortgageCapacity),
    usableMortgageCapacity: roundHousePurchaseMoney(usableMortgageCapacity),
    suppliedAboveStandard,
    lenderCapacityTreatment
  };
}

function supportCaseUsesHtb(supportCase) {
  return supportCase === 'htb_only' || supportCase === 'htb_and_fhs';
}

function supportCaseUsesFhs(supportCase) {
  return supportCase === 'fhs_only' || supportCase === 'htb_and_fhs';
}

function resolveSupportAtPrice(inputs, rules, {
  propertyPrice,
  mortgageCapacity,
  supportCase,
  allowPotentialSupport
}) {
  const mortgageAmount = Math.min(mortgageCapacity, propertyPrice * rules.mortgage.principalHomeMaxLtv);
  const htbScreen = screenHelpToBuy(inputs, { rules, targetPropertyPrice: propertyPrice, mortgageAmount });
  let htbAmount = 0;
  let htbKind = 'none';
  if (supportCaseUsesHtb(supportCase)) {
    if (htbScreen.confirmedAmount > 0) {
      htbAmount = htbScreen.confirmedAmount;
      htbKind = 'confirmed';
    } else if (allowPotentialSupport && htbScreen.potentialAmount > 0) {
      htbAmount = htbScreen.potentialAmount;
      htbKind = 'potential';
    }
  }

  const siteEquity = inputs.acquisitionType === 'self_build' ? inputs.firstHomeScheme.siteEquity : 0;
  const minimumOwnDeposit = Math.max(
    0,
    propertyPrice * rules.mortgage.minimumDepositRate - htbAmount - siteEquity
  );
  const fhsScreen = screenFirstHomeScheme(inputs, {
    rules,
    targetPropertyPrice: propertyPrice,
    mortgageAmount,
    standardMortgageCapacity: resolveMortgageCapacity(inputs, rules).standardMortgageCapacity,
    ownDeposit: minimumOwnDeposit,
    htbAmount,
    usingHtb: htbAmount > 0
  });
  let fhsAmount = 0;
  let fhsKind = 'none';
  if (supportCaseUsesFhs(supportCase)) {
    if (fhsScreen.status === 'potentially_eligible' && fhsScreen.confirmedAmount > 0) {
      fhsAmount = fhsScreen.confirmedAmount;
      fhsKind = 'confirmed';
    } else if (allowPotentialSupport && fhsScreen.potentialAmount > 0) {
      fhsAmount = fhsScreen.potentialAmount;
      fhsKind = 'potential';
    }
  }

  return {
    supportCase,
    mortgageAmount: roundHousePurchaseMoney(mortgageAmount),
    htbAmount: roundHousePurchaseMoney(htbAmount),
    htbKind,
    fhsAmount: roundHousePurchaseMoney(fhsAmount),
    fhsKind,
    siteEquity: roundHousePurchaseMoney(siteEquity),
    helpToBuy: htbScreen,
    firstHomeScheme: fhsScreen,
    usesPotentialSupport: htbKind === 'potential' || fhsKind === 'potential'
  };
}

function evaluateFundingAtPrice(inputs, rules, {
  propertyPrice,
  mortgageCapacity,
  supportCase,
  allowPotentialSupport
}) {
  const costs = calculatePurchaseCosts(inputs, propertyPrice, rules);
  const support = resolveSupportAtPrice(inputs, rules, {
    propertyPrice,
    mortgageCapacity,
    supportCase,
    allowPotentialSupport
  });
  const minimumOwnDeposit = Math.max(
    0,
    propertyPrice * rules.mortgage.minimumDepositRate - support.htbAmount - support.siteEquity
  );
  const propertyFundingCash = Math.max(
    0,
    propertyPrice - support.mortgageAmount - support.htbAmount - support.fhsAmount - support.siteEquity
  );
  const requiredDepositCash = Math.max(minimumOwnDeposit, propertyFundingCash);
  const cashRequired = costs.total + requiredDepositCash;
  return {
    propertyPrice,
    costs,
    support,
    minimumDeposit: roundHousePurchaseMoney(propertyPrice * rules.mortgage.minimumDepositRate),
    minimumOwnDeposit: roundHousePurchaseMoney(minimumOwnDeposit),
    requiredDepositCash: roundHousePurchaseMoney(requiredDepositCash),
    cashRequired: roundHousePurchaseMoney(cashRequired),
    mortgageRequiredAtMinimumCash: roundHousePurchaseMoney(Math.max(
      0,
      propertyPrice - minimumOwnDeposit - support.htbAmount - support.fhsAmount - support.siteEquity
    ))
  };
}

function solveMaximumPropertyPrice(inputs, rules, {
  cashAvailable,
  mortgageCapacity,
  supportCase,
  allowPotentialSupport
}) {
  const canFund = (price) => evaluateFundingAtPrice(inputs, rules, {
    propertyPrice: price,
    mortgageCapacity,
    supportCase,
    allowPotentialSupport
  }).cashRequired <= cashAvailable + 0.005;

  if (!canFund(1)) return 0;
  let low = 1;
  let high = Math.max(100000, mortgageCapacity + cashAvailable + 100000);
  while (high < 10000000 && canFund(high)) {
    low = high;
    high *= 2;
  }
  high = Math.min(high, 10000000);
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (canFund(midpoint)) low = midpoint;
    else high = midpoint - 1;
  }
  return low;
}

function netSavingsRate(inputs) {
  return inputs.depositSavingsGrossAer * (1 - inputs.dirtRate);
}

function projectDepositTimeline(inputs, {
  startingCash,
  monthlyContribution,
  targetCash,
  horizonMonths
}) {
  const calculationDate = toUtcDate(inputs.calculationDateIso);
  const annualNetRate = netSavingsRate(inputs);
  const monthlyRate = annualNetRate === 0 ? 0 : Math.pow(1 + annualNetRate, 1 / 12) - 1;
  const confirmedLumpSums = inputs.lumpSums
    .filter((entry) => entry.confidence === 'confirmed' && entry.amount > 0 && entry.expectedDate)
    .map((entry) => ({ ...entry, applied: false }));
  const series = [{
    monthIndex: 0,
    dateIso: inputs.calculationDateIso,
    openingBalance: roundHousePurchaseMoney(startingCash),
    interest: 0,
    contribution: 0,
    lumpSums: 0,
    lumpSumIds: [],
    closingBalance: roundHousePurchaseMoney(startingCash)
  }];
  let balance = startingCash;
  let readyMonthIndex = balance + 0.005 >= targetCash ? 0 : null;
  let readyDateIso = readyMonthIndex === 0 ? formatIsoDate(endOfUtcMonth(calculationDate)) : null;

  for (let monthIndex = 1; monthIndex <= horizonMonths; monthIndex += 1) {
    const periodEnd = endOfUtcMonth(addUtcMonths(calculationDate, monthIndex - 1));
    const periodEndIso = formatIsoDate(periodEnd);
    const openingBalance = balance;
    const interest = openingBalance * monthlyRate;
    const applicable = confirmedLumpSums.filter((entry) => !entry.applied && entry.expectedDate <= periodEndIso);
    applicable.forEach((entry) => { entry.applied = true; });
    const lumpSums = applicable.reduce((sum, entry) => sum + entry.amount, 0);
    balance = openingBalance + interest + monthlyContribution + lumpSums;
    series.push({
      monthIndex,
      dateIso: periodEndIso,
      openingBalance: roundHousePurchaseMoney(openingBalance),
      interest: roundHousePurchaseMoney(interest),
      contribution: roundHousePurchaseMoney(monthlyContribution),
      lumpSums: roundHousePurchaseMoney(lumpSums),
      lumpSumIds: applicable.map((entry) => entry.id),
      closingBalance: roundHousePurchaseMoney(balance)
    });
    if (readyMonthIndex === null && balance + 0.005 >= targetCash) {
      readyMonthIndex = monthIndex;
      readyDateIso = periodEndIso;
    }
  }

  return {
    grossAer: inputs.depositSavingsGrossAer,
    dirtRate: inputs.dirtRate,
    netAer: annualNetRate,
    monthlyRate,
    monthlyContribution,
    startingCash: roundHousePurchaseMoney(startingCash),
    targetCash: roundHousePurchaseMoney(targetCash),
    series,
    readyMonthIndex,
    readyDateIso,
    status: readyMonthIndex === null ? 'out_of_horizon' : (readyMonthIndex === 0 ? 'already_funded' : 'projected')
  };
}

function contributionNeededByTarget(inputs, startingCash, targetCash, targetMonths) {
  if (startingCash + 0.005 >= targetCash) return 0;
  if (!Number.isInteger(targetMonths) || targetMonths <= 0) return null;
  const withoutContribution = projectDepositTimeline(inputs, {
    startingCash,
    monthlyContribution: 0,
    targetCash: Infinity,
    horizonMonths: targetMonths
  }).series.at(-1).closingBalance;
  const withUnitContribution = projectDepositTimeline(inputs, {
    startingCash,
    monthlyContribution: 1,
    targetCash: Infinity,
    horizonMonths: targetMonths
  }).series.at(-1).closingBalance;
  const factor = withUnitContribution - withoutContribution;
  if (factor <= 0) return null;
  return roundHousePurchaseMoney(Math.max(0, (targetCash - withoutContribution) / factor));
}

function mortgageIllustration(principal, inputs, rules) {
  const termYears = inputs.mortgageTermYears;
  const rate = inputs.mortgageIllustrationRate;
  const monthCount = termYears * 12;
  const monthlyPayment = computeMonthlyPayment(principal, rate, monthCount);
  const totalRepayments = monthlyPayment * monthCount;
  const sensitivity = [];
  rules.mortgage.sensitivityTermsYears.forEach((sensitivityTerm) => {
    [Math.max(0, rate - rules.mortgage.sensitivityRateDelta), rate, rate + rules.mortgage.sensitivityRateDelta]
      .forEach((sensitivityRate) => {
        const months = sensitivityTerm * 12;
        const payment = computeMonthlyPayment(principal, sensitivityRate, months);
        sensitivity.push({
          termYears: sensitivityTerm,
          rate: sensitivityRate,
          monthlyPayment: roundHousePurchaseMoney(payment),
          totalRepayments: roundHousePurchaseMoney(payment * months),
          totalInterest: roundHousePurchaseMoney(payment * months - principal)
        });
      });
  });
  return {
    principal: roundHousePurchaseMoney(principal),
    rate,
    termYears,
    monthlyPayment: roundHousePurchaseMoney(monthlyPayment),
    totalRepayments: roundHousePurchaseMoney(totalRepayments),
    totalInterest: roundHousePurchaseMoney(totalRepayments - principal),
    sensitivity,
    disclosure: 'This is a repayment illustration, not a quoted mortgage rate.'
  };
}

function invertMonthlyPayment(monthlyPayment, annualRate, monthCount) {
  if (monthlyPayment <= 0) return 0;
  const unitPayment = computeMonthlyPayment(1, annualRate, monthCount);
  return unitPayment > 0 ? monthlyPayment / unitPayment : 0;
}

function calculateAffordability(inputs, mortgage, reserve, rules) {
  const known = inputs.monthlyNetHouseholdIncome !== null
    && inputs.monthlyEssentialExpensesExcludingHousingDebtAndRent !== null
    && inputs.currentMonthlyRent !== null;
  if (!known) {
    return {
      status: 'insufficient_information',
      baseHeadroom: null,
      stressedHeadroom: null,
      transitionBudget: null,
      baseHousingCost: null,
      stressedHousingCost: null,
      mortgageRepaymentToNetIncome: null,
      cashFlowAlignedMortgageCapacity: null,
      detail: 'Net household income, essential expenses and current rent are required.'
    };
  }
  const committedBeforeHousing = inputs.monthlyEssentialExpensesExcludingHousingDebtAndRent
    + inputs.otherKnownMonthlyCommitments
    + reserve.applicantDebtPayments;
  const ownershipCosts = inputs.estimatedMonthlyOwnershipCosts;
  const stressedRate = inputs.mortgageIllustrationRate + rules.mortgage.sensitivityRateDelta;
  const stressedPayment = computeMonthlyPayment(
    mortgage.principal,
    stressedRate,
    inputs.mortgageTermYears * 12
  );
  const baseHousingCost = mortgage.monthlyPayment + ownershipCosts;
  const stressedHousingCost = stressedPayment + ownershipCosts;
  const baseHeadroom = inputs.monthlyNetHouseholdIncome - committedBeforeHousing - baseHousingCost;
  const stressedHeadroom = inputs.monthlyNetHouseholdIncome - committedBeforeHousing - stressedHousingCost;
  const transitionBudget = inputs.currentMonthlyRent + inputs.currentMonthlySavings;
  const status = baseHeadroom < 0
    ? 'stretched'
    : (stressedHeadroom >= 0 && baseHousingCost <= transitionBudget + 0.005 ? 'aligned' : 'tighter');
  const repaymentBudget = Math.max(0, Math.min(
    transitionBudget - ownershipCosts,
    inputs.monthlyNetHouseholdIncome - committedBeforeHousing - ownershipCosts
  ));
  const cashFlowAlignedMortgageCapacity = invertMonthlyPayment(
    repaymentBudget,
    stressedRate,
    inputs.mortgageTermYears * 12
  );
  return {
    status,
    baseHeadroom: roundHousePurchaseMoney(baseHeadroom),
    stressedHeadroom: roundHousePurchaseMoney(stressedHeadroom),
    transitionBudget: roundHousePurchaseMoney(transitionBudget),
    baseHousingCost: roundHousePurchaseMoney(baseHousingCost),
    stressedHousingCost: roundHousePurchaseMoney(stressedHousingCost),
    ownershipCosts: roundHousePurchaseMoney(ownershipCosts),
    mortgageRepaymentToNetIncome: inputs.monthlyNetHouseholdIncome > 0
      ? mortgage.monthlyPayment / inputs.monthlyNetHouseholdIncome
      : null,
    cashFlowAlignedMortgageCapacity: roundHousePurchaseMoney(cashFlowAlignedMortgageCapacity),
    detail: 'Plan\u00e9ir cash-flow indicator; it does not reproduce lender underwriting.'
  };
}

const BOTTLENECK_COPY = Object.freeze({
  insufficient_information: ['Complete the core plan inputs', 'Some information needed to protect cash or screen the selected route is missing.'],
  scheme_or_property_mismatch: ['Confirm the selected support route', 'The target currently relies on support that is unconfirmed or does not pass every encoded criterion.'],
  income_borrowing_capacity: ['Income capacity is the main constraint', 'The mortgage needed from today\u2019s usable cash is above the standard or confirmed lender amount.'],
  monthly_affordability: ['Monthly affordability is the main constraint', 'The illustrated housing cost fails the base, transition-budget or stressed-headroom check.'],
  emergency_reserve: ['Protect the household reserve', 'Current cash does not fully cover the ringfenced goals and protected emergency reserve.'],
  purchase_costs: ['Build the buying-cost fund', 'The deposit may be covered, but the estimated buying costs are not yet fully funded.'],
  target_timeline: ['The target date needs a higher saving pace', 'Planned saving is below the amount needed for the selected date.'],
  deposit_gap: ['Deposit cash is the main constraint', 'Usable cash is below the deposit and buying-cost target.'],
  ready_for_next_step: ['Inputs appear broadly aligned', 'Deposit cash, mortgage requirement and monthly cash flow appear aligned under the assumptions entered.']
});

function makeBottleneck(code, status = 'fail') {
  const [label, detail] = BOTTLENECK_COPY[code];
  return { code, label, detail, status };
}

function diagnoseBottlenecks({
  inputs,
  reserve,
  mortgageCapacity,
  targetEvaluation,
  targetFunding,
  affordability,
  supportCase
}) {
  const flags = [];
  if ((inputs.emergencyReserveMode === 'suggested' && !reserve.reserveInputsComplete)
    || affordability.status === 'insufficient_information') {
    flags.push(makeBottleneck('insufficient_information', 'unknown'));
  }
  const supportSelected = supportCase !== 'none';
  const supportScreenIncomplete = supportSelected && (
    targetEvaluation.support.usesPotentialSupport
    || (supportCaseUsesHtb(supportCase) && targetEvaluation.support.helpToBuy.status !== 'potentially_eligible')
    || (supportCaseUsesFhs(supportCase) && targetEvaluation.support.firstHomeScheme.status !== 'potentially_eligible')
  );
  if (supportScreenIncomplete) flags.push(makeBottleneck('scheme_or_property_mismatch', 'warning'));

  const cashForPropertyToday = Math.max(0, reserve.usableCurrentCash - targetEvaluation.costs.total);
  const mortgageRequiredToday = Math.max(
    0,
    inputs.targetPropertyPrice
      - cashForPropertyToday
      - targetEvaluation.support.htbAmount
      - targetEvaluation.support.fhsAmount
      - targetEvaluation.support.siteEquity
  );
  if (mortgageRequiredToday > targetEvaluation.support.mortgageAmount + 0.01) {
    flags.push(makeBottleneck('income_borrowing_capacity'));
  }
  if (mortgageCapacity.suppliedAboveStandard && inputs.lenderCapacity.status !== 'confirmed') {
    flags.push(makeBottleneck('income_borrowing_capacity', 'warning'));
  }
  if (affordability.status === 'stretched') flags.push(makeBottleneck('monthly_affordability'));
  if (affordability.status === 'tighter') flags.push(makeBottleneck('monthly_affordability', 'warning'));
  if (reserve.protectedCashShortfall > 0) flags.push(makeBottleneck('emergency_reserve'));
  const ownMinimumDeposit = targetEvaluation.minimumOwnDeposit;
  if (reserve.usableCurrentCash + 0.01 >= ownMinimumDeposit
    && reserve.usableCurrentCash + 0.01 < ownMinimumDeposit + targetEvaluation.costs.total) {
    flags.push(makeBottleneck('purchase_costs'));
  }
  if (targetFunding.targetDateStatus === 'past' && targetFunding.currentCashGap > 0.01) {
    flags.push(makeBottleneck('target_timeline'));
  } else if (inputs.targetPurchaseDate && targetFunding.monthlySavingNeeded !== null
    && inputs.plannedMonthlySavings + 0.01 < targetFunding.monthlySavingNeeded) {
    flags.push(makeBottleneck('target_timeline'));
  }
  if (targetFunding.currentCashGap > 0.01) flags.push(makeBottleneck('deposit_gap'));

  const deduplicated = flags.filter((entry, index) => (
    flags.findIndex((candidate) => candidate.code === entry.code) === index
  ));
  if (deduplicated.length === 0) deduplicated.push(makeBottleneck('ready_for_next_step', 'pass'));
  const primary = deduplicated[0];
  return {
    primary,
    secondary: deduplicated.slice(1),
    all: deduplicated,
    ready: primary.code === 'ready_for_next_step'
  };
}

function buildActions({ bottlenecks, targetFunding, reserve, schemes, inputs }) {
  const actions = [];
  const add = (id, title, detail) => {
    if (!actions.some((entry) => entry.id === id) && actions.length < 3) {
      actions.push({ id, priority: actions.length + 1, title, detail });
    }
  };
  const codes = bottlenecks.all.map((entry) => entry.code);
  if (codes.includes('insufficient_information')) {
    add('complete-cash-flow', 'Complete the household cash-flow inputs', 'Add essential spending and rent so the protected reserve and resilience gate can be calculated.');
  }
  if (codes.includes('emergency_reserve')) {
    add('protect-reserve', 'Protect the emergency reserve first', `Keep ${formatEuro(reserve.appliedReserveTarget)} outside the buying fund, plus any other ringfenced cash.`);
  }
  if (codes.includes('income_borrowing_capacity')) {
    add('confirm-lender-capacity', 'Confirm the lender capacity', 'Test the target with a lender or reduce the mortgage requirement by increasing deposit cash or changing the property target.');
  }
  if (codes.includes('monthly_affordability')) {
    add('review-monthly-cost', 'Review the post-purchase monthly position', 'Revisit price, term, ownership costs and household commitments before treating the target as comfortable.');
  }
  if (targetFunding.additionalMonthlySavingNeeded > 0) {
    add('close-saving-gap', 'Close the target-date saving gap', `The illustration needs about ${formatEuro(targetFunding.additionalMonthlySavingNeeded)} more per month for the selected date.`);
  }
  if (schemes.helpToBuy.status === 'potentially_eligible' || schemes.helpToBuy.status === 'more_information_required') {
    add('check-htb', 'Check Help to Buy with Revenue', 'Confirm purchaser, property, lender and prior-four-year tax details before relying on any HTB amount.');
  }
  if (schemes.firstHomeScheme.status === 'potentially_eligible' || schemes.firstHomeScheme.status === 'more_information_required') {
    add('check-fhs', 'Check the First Home Scheme route', 'Confirm the participating lender, maximum mortgage, property ceiling and shared-equity implications.');
  }
  add('confirm-costs', 'Refresh the property and buying-cost estimates', `Validate the ${formatEuro(inputs.targetPropertyPrice)} target and professional-fee allowances before acting.`);
  add('seek-lender-assessment', 'Seek a formal lender assessment', 'The Plan\u00e9ir figures are educational illustrations and do not constitute mortgage approval.');
  return actions;
}

function tableForScheme(title, screen) {
  return {
    id: title === 'Help to Buy' ? 'house-purchase-htb-screen' : 'house-purchase-fhs-screen',
    title,
    columns: ['Criterion', 'Status', 'Detail'],
    rows: screen.criteria.map((entry) => [entry.label, entry.status, entry.detail])
  };
}

/**
 * Compute the deterministic Irish house-purchase illustration.
 * Runtime-generated outputs replace any model-supplied calculations whenever
 * HousePurchaseInputs are present.
 *
 * @param {HousePurchaseInputs} rawInputs
 * @param {{scenarioOverrides?:Object,rules?:Object}} [options]
 * @returns {{assumptionsTable:Object,outputsTable:Object,tables:Object[],charts:Object[],summaryHtml:string,result:HousePurchaseProjectionResult,debug:Object}}
 */
export function computeHousePurchaseProjection(rawInputs, {
  scenarioOverrides = {},
  rules = DEFAULT_HOUSE_PURCHASE_RULES
} = {}) {
  const baseInputs = normalizeHousePurchaseInputs(rawInputs);
  const scenario = applyScenarioOverrides(baseInputs, scenarioOverrides);
  const inputs = scenario.inputs;
  const reserve = resolveReserve(inputs, rules);
  const mortgageCapacity = resolveMortgageCapacity(inputs, rules);
  const allowPotentialSupport = scenario.supportCaseWasExplicit;
  const currentSupportablePrice = solveMaximumPropertyPrice(inputs, rules, {
    cashAvailable: reserve.usableCurrentCash,
    mortgageCapacity: mortgageCapacity.usableMortgageCapacity,
    supportCase: 'none',
    allowPotentialSupport: false
  });
  const activeSupportablePrice = solveMaximumPropertyPrice(inputs, rules, {
    cashAvailable: reserve.usableCurrentCash,
    mortgageCapacity: mortgageCapacity.usableMortgageCapacity,
    supportCase: scenario.supportCase,
    allowPotentialSupport
  });
  const targetEvaluation = evaluateFundingAtPrice(inputs, rules, {
    propertyPrice: inputs.targetPropertyPrice,
    mortgageCapacity: mortgageCapacity.usableMortgageCapacity,
    supportCase: scenario.supportCase,
    allowPotentialSupport
  });
  const purchaseCashRequired = targetEvaluation.cashRequired;
  // If today's cash does not yet cover the protected reserve, future savings
  // must refill that shortfall before they become usable purchase cash.
  const targetCash = purchaseCashRequired + reserve.protectedCashShortfall;
  const horizonMonths = rules.depositSavings.projectionHorizonMonths;
  const depositTimeline = projectDepositTimeline(inputs, {
    startingCash: reserve.usableCurrentCash,
    monthlyContribution: inputs.plannedMonthlySavings,
    targetCash,
    horizonMonths
  });
  const targetMonths = monthsThroughTarget(inputs.calculationDateIso, inputs.targetPurchaseDate);
  const monthlySavingNeeded = contributionNeededByTarget(
    inputs,
    reserve.usableCurrentCash,
    targetCash,
    targetMonths
  );
  const targetDateSeriesRow = targetMonths === null
    ? null
    : depositTimeline.series[Math.min(targetMonths, depositTimeline.series.length - 1)];
  const projectedCashAtTarget = targetDateSeriesRow?.closingBalance ?? null;
  const currentCashGap = Math.max(0, targetCash - reserve.usableCurrentCash);
  const cashForPropertyToday = Math.max(0, reserve.usableCurrentCash - targetEvaluation.costs.total);
  const mortgageRequired = Math.max(
    0,
    inputs.targetPropertyPrice
      - cashForPropertyToday
      - targetEvaluation.support.htbAmount
      - targetEvaluation.support.fhsAmount
      - targetEvaluation.support.siteEquity
  );

  const targetFunding = {
    targetPropertyPrice: roundHousePurchaseMoney(inputs.targetPropertyPrice),
    purchaseCosts: targetEvaluation.costs.total,
    stampDuty: targetEvaluation.costs.stampDuty,
    minimumDeposit: targetEvaluation.minimumDeposit,
    minimumOwnDeposit: targetEvaluation.minimumOwnDeposit,
    requiredDepositCash: targetEvaluation.requiredDepositCash,
    purchaseCashRequired,
    protectedCashShortfall: roundHousePurchaseMoney(reserve.protectedCashShortfall),
    cashRequired: roundHousePurchaseMoney(targetCash),
    usableCash: roundHousePurchaseMoney(reserve.usableCurrentCash),
    currentCashGap: roundHousePurchaseMoney(currentCashGap),
    mortgageRequired: roundHousePurchaseMoney(mortgageRequired),
    monthlySavingNeeded,
    additionalMonthlySavingNeeded: monthlySavingNeeded === null
      ? null
      : roundHousePurchaseMoney(Math.max(0, monthlySavingNeeded - inputs.plannedMonthlySavings)),
    targetDateIso: inputs.targetPurchaseDate,
    targetDateStatus: targetMonths === null ? 'not_set' : (targetMonths === 0 ? 'past' : 'current_or_future'),
    targetMonthEndIso: inputs.targetPurchaseDate ? formatIsoDate(endOfUtcMonth(toUtcDate(inputs.targetPurchaseDate))) : null,
    projectedCashAtTarget,
    cashReadyDateIso: depositTimeline.readyDateIso,
    readyDateIso: inputs.emergencyReserveMode === 'suggested' && !reserve.reserveInputsComplete
      ? null
      : depositTimeline.readyDateIso,
    monthsToReady: inputs.emergencyReserveMode === 'suggested' && !reserve.reserveInputsComplete
      ? null
      : depositTimeline.readyMonthIndex,
    status: inputs.emergencyReserveMode === 'suggested' && !reserve.reserveInputsComplete
      ? 'more_information_required'
      : depositTimeline.status
  };

  const principal = Math.min(
    targetEvaluation.support.mortgageAmount,
    Math.max(0, inputs.targetPropertyPrice
      - targetEvaluation.minimumOwnDeposit
      - targetEvaluation.support.htbAmount
      - targetEvaluation.support.fhsAmount
      - targetEvaluation.support.siteEquity)
  );
  const mortgage = mortgageIllustration(principal, inputs, rules);
  const affordability = calculateAffordability(inputs, mortgage, reserve, rules);
  const cashFlowAlignedMortgageCapacity = affordability.cashFlowAlignedMortgageCapacity;
  const cashFlowAlignedPropertyCapacity = cashFlowAlignedMortgageCapacity === null
    ? null
    : solveMaximumPropertyPrice(inputs, rules, {
      cashAvailable: reserve.usableCurrentCash,
      mortgageCapacity: Math.min(mortgageCapacity.usableMortgageCapacity, cashFlowAlignedMortgageCapacity),
      supportCase: 'none',
      allowPotentialSupport: false
    });

  const capacities = {
    ...mortgageCapacity,
    cashFlowAlignedMortgageCapacity,
    cashFlowAlignedPropertyCapacity,
    currentSupportablePrice: roundHousePurchaseMoney(currentSupportablePrice),
    activeSupportablePrice: roundHousePurchaseMoney(activeSupportablePrice)
  };

  const ownCashToProperty = Math.min(
    targetEvaluation.requiredDepositCash,
    Math.max(0, reserve.usableCurrentCash - targetEvaluation.costs.total)
  );
  const propertyFundingGap = Math.max(
    0,
    inputs.targetPropertyPrice
      - ownCashToProperty
      - mortgage.principal
      - targetEvaluation.support.htbAmount
      - targetEvaluation.support.fhsAmount
      - targetEvaluation.support.siteEquity
  );
  const fundingStack = {
    total: roundHousePurchaseMoney(inputs.targetPropertyPrice),
    ownCash: roundHousePurchaseMoney(ownCashToProperty),
    buyingCosts: targetEvaluation.costs.total,
    cashGapIncludingCosts: roundHousePurchaseMoney(currentCashGap),
    estimatedMortgage: mortgage.principal,
    confirmedHtb: targetEvaluation.support.htbKind === 'confirmed' ? targetEvaluation.support.htbAmount : 0,
    confirmedFhs: targetEvaluation.support.fhsKind === 'confirmed' ? targetEvaluation.support.fhsAmount : 0,
    potentialHtb: targetEvaluation.support.htbKind === 'potential' ? targetEvaluation.support.htbAmount : 0,
    potentialFhs: targetEvaluation.support.fhsKind === 'potential' ? targetEvaluation.support.fhsAmount : 0,
    siteEquity: targetEvaluation.support.siteEquity,
    remainingGap: roundHousePurchaseMoney(propertyFundingGap),
    items: [
      { id: 'own-cash', label: 'Own cash', status: 'confirmed_input', amount: roundHousePurchaseMoney(ownCashToProperty) },
      { id: 'mortgage', label: 'Estimated mortgage', status: 'estimated', amount: mortgage.principal },
      { id: 'htb-confirmed', label: 'Confirmed HTB input', status: 'confirmed_input', amount: targetEvaluation.support.htbKind === 'confirmed' ? targetEvaluation.support.htbAmount : 0 },
      { id: 'fhs-confirmed', label: 'Confirmed FHS input', status: 'confirmed_input', amount: targetEvaluation.support.fhsKind === 'confirmed' ? targetEvaluation.support.fhsAmount : 0 },
      { id: 'htb-potential', label: 'Potential HTB', status: 'potential_support', amount: targetEvaluation.support.htbKind === 'potential' ? targetEvaluation.support.htbAmount : 0 },
      { id: 'fhs-potential', label: 'Potential FHS', status: 'potential_support', amount: targetEvaluation.support.fhsKind === 'potential' ? targetEvaluation.support.fhsAmount : 0 },
      { id: 'gap', label: 'Property funding gap', status: 'funding_gap', amount: roundHousePurchaseMoney(propertyFundingGap) }
    ]
  };

  const schemes = {
    helpToBuy: targetEvaluation.support.helpToBuy,
    firstHomeScheme: targetEvaluation.support.firstHomeScheme,
    activeSupportCase: scenario.supportCase,
    usesPotentialSupport: targetEvaluation.support.usesPotentialSupport
  };
  const bottlenecks = diagnoseBottlenecks({
    inputs,
    reserve,
    mortgageCapacity,
    targetEvaluation,
    targetFunding,
    affordability,
    supportCase: scenario.supportCase
  });
  const readinessGates = {
    regulatoryCapacity: {
      status: mortgageRequired <= mortgageCapacity.usableMortgageCapacity + 0.01 ? 'pass' : 'fail',
      label: 'Regulatory capacity',
      detail: `${formatEuro(mortgageRequired)} required versus ${formatEuro(mortgageCapacity.usableMortgageCapacity)} illustrated capacity.`
    },
    protectedCash: {
      status: currentCashGap <= 0.01 ? 'pass' : 'fail',
      label: 'Protected cash',
      detail: `${formatEuro(reserve.appliedReserveTarget)} reserve protected; ${formatEuro(currentCashGap)} current cash gap.`
    },
    householdResilience: {
      status: affordability.status === 'aligned' ? 'pass' : (affordability.status === 'insufficient_information' ? 'unknown' : 'warning'),
      label: 'Household resilience',
      detail: affordability.detail
    },
    supportScreening: {
      status: scenario.supportCase === 'none'
        ? 'not_applicable'
        : (targetEvaluation.support.usesPotentialSupport ? 'warning' : 'pass'),
      label: 'Support screening',
      detail: scenario.supportCase === 'none' ? 'No scheme support included in this case.' : 'Scheme inputs remain subject to official confirmation.'
    }
  };
  const actions = buildActions({ bottlenecks, targetFunding, reserve, schemes, inputs });

  const ruleVersion = (verifiedDate, sources, extra = {}) => {
    const ageDays = ruleAgeDays(inputs.calculationDateIso, verifiedDate);
    return {
      ...extra,
      ageDays,
      isStale: ageDays > HOUSE_PURCHASE_RULE_MAX_AGE_DAYS,
      sources: [...sources]
    };
  };
  const ruleVersions = {
    mortgage: ruleVersion(rules.mortgage.asOfDate, rules.mortgage.sources, { asOfDate: rules.mortgage.asOfDate }),
    stampDuty: ruleVersion(rules.stampDuty.asOfDate, rules.stampDuty.sources, { asOfDate: rules.stampDuty.asOfDate }),
    depositSavings: ruleVersion(rules.depositSavings.asOfDate, rules.depositSavings.sources, { asOfDate: rules.depositSavings.asOfDate }),
    helpToBuy: ruleVersion(rules.helpToBuy.asOfDate, rules.helpToBuy.sources, { asOfDate: rules.helpToBuy.asOfDate }),
    firstHomeScheme: {
      ...ruleVersion(rules.firstHomeScheme.verifiedOn, rules.firstHomeScheme.sources),
      effectiveDate: rules.firstHomeScheme.effectiveDate,
      verifiedOn: rules.firstHomeScheme.verifiedOn
    },
    maxAgeDays: HOUSE_PURCHASE_RULE_MAX_AGE_DAYS
  };
  ruleVersions.staleRuleIds = ['mortgage', 'stampDuty', 'depositSavings', 'helpToBuy', 'firstHomeScheme']
    .filter((id) => ruleVersions[id].isStale);
  ruleVersions.requiresReleaseSourceCheck = ruleVersions.staleRuleIds.length > 0;

  const result = {
    capacities,
    targetFunding,
    depositTimeline,
    mortgage,
    householdAffordability: affordability,
    affordability,
    fundingStack,
    bottlenecks,
    schemes,
    actions,
    readinessGates,
    ruleVersions,
    protectedCash: {
      currentCashSavings: roundHousePurchaseMoney(inputs.currentCashSavings),
      ringfencedForOtherGoals: roundHousePurchaseMoney(inputs.amountRingfencedForOtherGoals),
      suggestedEmergencyReserve: reserve.suggestedReserveTarget === null ? null : roundHousePurchaseMoney(reserve.suggestedReserveTarget),
      appliedEmergencyReserve: roundHousePurchaseMoney(reserve.appliedReserveTarget),
      totalProtected: roundHousePurchaseMoney(reserve.protectedCash),
      usableCash: roundHousePurchaseMoney(reserve.usableCurrentCash),
      shortfall: roundHousePurchaseMoney(reserve.protectedCashShortfall)
    },
    purchaseCosts: targetEvaluation.costs,
    disclosures: [...rules.disclosures]
  };

  const assumptionsTable = {
    columns: ['Assumption', 'Value', 'Notes'],
    rows: [
      ['Calculation date', inputs.calculationDateIso, `Rules verified ${rules.verifiedOn}`],
      ['Lending category', inputs.lendingCategory, `${mortgageCapacity.centralBankMultiple.toFixed(1)}\u00d7 standard income-limit illustration`],
      ['Qualifying income', formatEuro(mortgageCapacity.qualifyingIncome), 'Base income plus only lender-recognised variable income'],
      ['Protected emergency reserve', formatEuro(reserve.appliedReserveTarget), inputs.emergencyReserveMode === 'suggested' ? 'Six-month target with three-month safety floor' : 'Custom input'],
      ['Deposit growth', `${formatPercent(inputs.depositSavingsGrossAer, 2)} gross / ${formatPercent(netSavingsRate(inputs), 2)} after DIRT`, 'Monthly compounding; contributions at month-end'],
      ['Mortgage illustration', `${formatPercent(inputs.mortgageIllustrationRate, 2)} for ${inputs.mortgageTermYears} years`, 'Illustration, not a quoted mortgage rate'],
      ['Support case', scenario.supportCase, targetEvaluation.support.usesPotentialSupport ? 'Includes unconfirmed potential support' : 'Uses confirmed inputs only'],
      ['Target property', formatEuro(inputs.targetPropertyPrice), `${inputs.acquisitionType}; ${inputs.dwellingType}`]
    ]
  };
  const outputsTable = {
    columns: ['Metric', 'Value', 'Notes'],
    rows: [
      ['Current supportable property price', formatEuro(currentSupportablePrice), 'Protects the reserve and buying-cost fund'],
      ['Standard mortgage capacity', formatEuro(mortgageCapacity.standardMortgageCapacity), 'Central Bank income-limit illustration'],
      ['Usable current cash', formatEuro(reserve.usableCurrentCash), 'After ringfenced goals and emergency reserve'],
      ['Cash required for target', formatEuro(targetCash), 'Deposit cash plus estimated buying costs'],
      ['Current cash gap', formatEuro(currentCashGap), 'Potential support is not treated as confirmed funding'],
      ['Earliest illustrated date', depositTimeline.readyDateIso || 'Beyond 600 months', depositTimeline.status],
      ['Monthly saving needed', monthlySavingNeeded === null ? 'Not determined' : formatEuro(monthlySavingNeeded), inputs.targetPurchaseDate || 'No target date entered'],
      ['Illustrated monthly repayment', formatEuro(mortgage.monthlyPayment), `${formatPercent(mortgage.rate, 2)} over ${mortgage.termYears} years`],
      ['Primary bottleneck', bottlenecks.primary.label, bottlenecks.primary.detail]
    ]
  };

  const purchaseCostTable = {
    id: 'house-purchase-costs',
    title: 'Estimated buying costs',
    columns: ['Cost', 'Amount', 'Treatment'],
    rows: [
      ['Stamp duty', formatEuro(targetEvaluation.costs.stampDuty), inputs.purchaseCosts.stampDutyMode === 'custom' ? 'Custom estimate' : 'Dated Revenue bands'],
      ['Legal and conveyancing', formatEuro(targetEvaluation.costs.legalAndConveyancing), 'Editable planning estimate'],
      ['Valuation', formatEuro(targetEvaluation.costs.valuation), 'Editable planning estimate'],
      ['Survey / engineer', formatEuro(targetEvaluation.costs.surveyOrEngineer), 'Editable planning estimate'],
      ['Moving and furnishing', formatEuro(targetEvaluation.costs.movingAndFurnishing), 'Editable planning estimate'],
      ['Contingency', formatEuro(targetEvaluation.costs.contingency), 'Editable planning estimate'],
      ['Total', formatEuro(targetEvaluation.costs.total), 'Not included in the mortgage deposit']
    ]
  };
  const sensitivityTable = {
    id: 'house-purchase-mortgage-sensitivity',
    title: 'Mortgage rate and term sensitivity',
    columns: ['Rate', 'Term', 'Monthly repayment', 'Total interest'],
    rows: mortgage.sensitivity.map((entry) => [
      formatPercent(entry.rate, 2),
      `${entry.termYears} years`,
      formatEuro(entry.monthlyPayment),
      formatEuro(entry.totalInterest)
    ])
  };
  const tables = [
    purchaseCostTable,
    sensitivityTable,
    tableForScheme('Help to Buy', schemes.helpToBuy),
    tableForScheme('First Home Scheme', schemes.firstHomeScheme)
  ];

  const chartSeries = depositTimeline.series.filter((entry) => (
    entry.monthIndex <= 60 || entry.monthIndex % 12 === 0 || entry.monthIndex === depositTimeline.readyMonthIndex
  ));
  const charts = [
    {
      id: 'house-purchase-deposit-journey',
      title: 'Deposit journey',
      type: 'line',
      labels: chartSeries.map((entry) => entry.dateIso),
      datasets: [
        { label: 'Projected usable cash', data: chartSeries.map((entry) => entry.closingBalance) },
        { label: 'Cash target', data: chartSeries.map(() => targetCash) }
      ],
      textAlternative: `Usable cash starts at ${formatEuro(reserve.usableCurrentCash)} and ${depositTimeline.readyDateIso ? `reaches ${formatEuro(targetCash)} by ${depositTimeline.readyDateIso}` : `does not reach ${formatEuro(targetCash)} within 600 months`}.`
    },
    {
      id: 'house-purchase-funding-stack',
      title: 'Target funding stack',
      type: 'bar',
      labels: fundingStack.items.filter((entry) => entry.amount > 0).map((entry) => entry.label),
      datasets: [{
        label: 'Amount',
        data: fundingStack.items.filter((entry) => entry.amount > 0).map((entry) => entry.amount),
        statuses: fundingStack.items.filter((entry) => entry.amount > 0).map((entry) => entry.status)
      }]
    },
    {
      id: 'house-purchase-mortgage-sensitivity',
      title: 'Mortgage repayment sensitivity',
      type: 'bar',
      labels: mortgage.sensitivity.map((entry) => `${formatPercent(entry.rate, 1)} / ${entry.termYears}y`),
      datasets: [{ label: 'Monthly repayment', data: mortgage.sensitivity.map((entry) => entry.monthlyPayment) }]
    }
  ];

  const summaryHtml = `<p>The current standard-rule route supports an estimated property price of <strong>${formatEuro(currentSupportablePrice)}</strong>. For the ${formatEuro(inputs.targetPropertyPrice)} target, the current protected-cash gap is <strong>${formatEuro(currentCashGap)}</strong>. ${depositTimeline.readyDateIso ? `At ${formatEuro(inputs.plannedMonthlySavings)} per month, the cash target is illustrated by <strong>${depositTimeline.readyDateIso}</strong>.` : 'The cash target is outside the 600-month projection horizon at the current saving pace.'} The primary planning constraint is <strong>${bottlenecks.primary.label.toLowerCase()}</strong>.</p>`;

  return {
    assumptionsTable,
    outputsTable,
    tables,
    charts,
    summaryHtml,
    result,
    debug: {
      normalizedInputs: inputs,
      baseInputs,
      scenarioOverrides: { ...scenarioOverrides },
      supportCase: scenario.supportCase,
      supportCaseWasExplicit: scenario.supportCaseWasExplicit,
      allowPotentialSupport,
      reserve,
      targetEvaluation,
      activeSupportablePrice,
      targetMonths,
      horizonMonths,
      rulesAsOfDate: rules.asOfDate
    }
  };
}
