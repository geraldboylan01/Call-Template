import {
  computeHousePurchaseProjection,
  createDefaultHousePurchaseInputs
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
    currentCashSavings: cashAmount(profile),
    cashSavingsContributions: applicants.map((applicant) => ({
      ownerId: applicant.id,
      amount: (profile.assets || [])
        .filter((asset) => asset.type === 'cash' && asset.ownerIds.includes(applicant.id))
        .reduce((total, asset) => total + (moneyAmount(asset.currentValue, currency) || 0), 0)
    })),
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
    localAuthorityCode: settings.localAuthorityCode || '',
    tenantNoticeReceived: typeof settings.tenantNoticeReceived === 'boolean' ? settings.tenantNoticeReceived : null,
    lenderCapacity: { ...defaults.lenderCapacity, ...(settings.lenderCapacity || {}) },
    helpToBuy: { ...defaults.helpToBuy, ...(settings.helpToBuy || {}) },
    firstHomeScheme: { ...defaults.firstHomeScheme, ...(settings.firstHomeScheme || {}) }
  };
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
