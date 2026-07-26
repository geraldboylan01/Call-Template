import { PLANEIR_ASSUMPTIONS, assumptionRecord } from '../planeir_assumptions.js';
import { computePensionProjection } from '../../pension_math.js';
import { computeNetRetirementProjection } from '../../net_retirement_math.js';
import {
  IRELAND_RULES_CATALOGUE_VERSION,
  IRISH_STATE_PENSION_CONTRIBUTORY,
  normalizeStatePensionFraction
} from '../ireland_rules.js';
import {
  annualExpenses,
  availableInvestmentAmount,
  baseCurrency,
  createModuleRunResult,
  crossCurrencyWarnings,
  findGoal,
  getAssumption,
  grossEmploymentIncome,
  missing,
  moneyAmount,
  personForId,
  readinessFromMissing,
  sumKnown
} from './common.js';

export const PENSION_ADAPTER_VERSION = '1.0.0';
export const NET_RETIREMENT_ADAPTER_VERSION = '1.0.0';

const RETIREMENT_GOALS = ['improve_pension', 'retire', 'retire_early'];

function retirementTarget(profile) {
  const explicit = getAssumption(profile, 'retirement.targetIncomeToday');
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const goal = findGoal(profile, RETIREMENT_GOALS);
  const goalTarget = moneyAmount(goal?.targetAmount, baseCurrency(profile));
  return goalTarget ?? annualExpenses(profile);
}

function groupPensionsByOwner(profile) {
  const grouped = new Map();
  (profile.pensions || []).forEach((pension) => {
    if (!grouped.has(pension.ownerId)) grouped.set(pension.ownerId, []);
    grouped.get(pension.ownerId).push(pension);
  });
  return grouped;
}

export function getPensionProjectionReadiness(profile) {
  const relevant = Boolean(findGoal(profile, RETIREMENT_GOALS));
  if (!relevant) return readinessFromMissing([], { relevant: false });
  const moduleIds = ['pension_projection'];
  const requiredMissing = [];
  const grouped = groupPensionsByOwner(profile);
  if (grouped.size === 0) {
    requiredMissing.push(missing('/pensions', 'Add at least one pension position.', moduleIds));
  }
  grouped.forEach((pensions, ownerId) => {
    const person = personForId(profile, ownerId);
    const personPath = profile.partner?.personId === ownerId ? '/partner' : '/primaryPerson';
    if (!person) {
      requiredMissing.push(missing('/pensions', `Pension owner ${ownerId} does not match a household person.`, moduleIds));
      return;
    }
    if (typeof person.age !== 'number') requiredMissing.push(missing(`${personPath}/age`, 'Add the current age.', moduleIds));
    if (typeof person.intendedRetirementAge !== 'number') {
      requiredMissing.push(missing(`${personPath}/intendedRetirementAge`, 'Add the intended retirement age.', moduleIds));
    }
    if (grossEmploymentIncome(profile, ownerId) <= 0 && person.employmentStatus !== 'retired') {
      requiredMissing.push(missing('/incomeSources', `Add current gross income for ${person.displayName || person.role}.`, moduleIds));
    }
    pensions.forEach((pension) => {
      const index = profile.pensions.indexOf(pension);
      if (!pension.currentValue) requiredMissing.push(missing(`/pensions/${index}/currentValue`, 'Add the current pension value.', moduleIds));
      if (typeof pension.employeeContributionRate !== 'number') {
        requiredMissing.push(missing(`/pensions/${index}/employeeContributionRate`, 'Add the personal pension contribution rate.', moduleIds));
      }
      if (typeof pension.employerContributionRate !== 'number') {
        requiredMissing.push(missing(`/pensions/${index}/employerContributionRate`, 'Add the employer pension contribution rate, including zero.', moduleIds));
      }
    });
  });
  if (retirementTarget(profile) === null) {
    requiredMissing.push(missing('/assumptions/values/retirement/targetIncomeToday', 'Add target annual retirement income or current annual spending.', moduleIds));
  }
  // Centrally approved Planéir assumptions. Named and versioned so every
  // projected figure can state the basis it rests on.
  const assumptionsUsed = [
    assumptionRecord('investmentGrowth'),
    assumptionRecord('generalInflation')
  ];
  assumptionsUsed.push({
    key: 'statePensionContributory',
    value: IRISH_STATE_PENSION_CONTRIBUTORY.annualMaximumEur,
    reason: `${IRELAND_RULES_CATALOGUE_VERSION}, effective January 2026. Maximum gross rate only; actual entitlement depends on each person’s PRSI record.`
  });
  const warnings = [
    'Pension balances and projected withdrawals are shown before tax. Tax and wider retirement-income needs require separate adviser review.',
    ...crossCurrencyWarnings(profile, [
      ['Pension values', profile.pensions.map((pension) => pension.currentValue)],
      ['Income values', profile.incomeSources.map((income) => income.grossAnnual)]
    ])
  ];
  return readinessFromMissing(requiredMissing, { assumptionsUsed, warnings });
}

export function buildPensionProjectionInput(profile) {
  const currency = baseCurrency(profile);
  const grouped = groupPensionsByOwner(profile);
  const settings = getAssumption(profile, 'retirement', {});
  const pensions = Array.from(grouped.entries()).map(([ownerId, ownerPensions], index) => {
    const person = personForId(profile, ownerId);
    const legacyIncludeSetting = settings.includeStatePension;
    const includeStatePension = typeof legacyIncludeSetting === 'boolean'
      ? legacyIncludeSetting
      : getAssumption(profile, `retirement.includeStatePension.${ownerId}`, true);
    const rawFraction = getAssumption(profile, `retirement.statePensionFraction.${ownerId}`);
    const statePensionFraction = includeStatePension === false
      ? 0
      : normalizeStatePensionFraction(rawFraction, 1);
    return {
      id: ownerId,
      title: person?.displayName ? `${person.displayName} pension` : `Pension ${index + 1}`,
      currentAge: person.age,
      retirementAge: person.intendedRetirementAge,
      currentSalary: grossEmploymentIncome(profile, ownerId),
      currentPot: sumKnown(ownerPensions.map((pension) => moneyAmount(pension.currentValue, currency))),
      personalPct: Math.min(1, sumKnown(ownerPensions.map((pension) => pension.employeeContributionRate))),
      employerPct: Math.min(1, sumKnown(ownerPensions.map((pension) => pension.employerContributionRate))),
      includeStatePension: statePensionFraction > 0,
      statePensionFraction,
      statePensionStartAge: getAssumption(
        profile,
        `retirement.statePensionStartAge.${ownerId}`,
        IRISH_STATE_PENSION_CONTRIBUTORY.defaultStartAge
      ),
      statePensionEscalationRate: IRISH_STATE_PENSION_CONTRIBUTORY.defaultEscalationRate
    };
  });
  const otherIncomeSources = profile.incomeSources
    .filter((income) => !['employment', 'self_employment', 'state_pension'].includes(income.type))
    .map((income) => ({
      id: income.incomeId,
      title: income.label,
      type: income.type,
      ownerId: income.ownerId,
      annualAmountToday: moneyAmount(income.netAnnual, currency) ?? moneyAmount(income.grossAnnual, currency) ?? 0,
      startAge: income.startAge ?? personForId(profile, income.ownerId)?.intendedRetirementAge ?? pensions[0]?.retirementAge,
      ...(typeof income.endAge === 'number' ? { endAge: income.endAge } : {}),
      inflationIndexed: income.inflationIndexed !== false
    }))
    .filter((income) => income.annualAmountToday > 0);
  return {
    currentYear: Number(profile.assumptions.calculationDateIso.slice(0, 4)),
    // Centrally controlled: neither a consumer nor an adviser can override
    // these, so the engine reads the approved values directly rather than a
    // per-profile copy that could silently drift.
    growthRate: PLANEIR_ASSUMPTIONS.investment.nominalGrowthRate,
    inflationRate: PLANEIR_ASSUMPTIONS.inflation.generalRate,
    wageGrowthRate: Number.isFinite(settings.wageGrowthRate)
      ? settings.wageGrowthRate
      : PLANEIR_ASSUMPTIONS.inflation.generalRate,
    incomeMode: 'target',
    targetIncomeToday: retirementTarget(profile),
    horizonEndAge: Number.isInteger(settings.horizonEndAge) ? settings.horizonEndAge : 100,
    pensions,
    otherIncomeSources,
    statePensionRule: {
      catalogueVersion: IRELAND_RULES_CATALOGUE_VERSION,
      effectiveFrom: IRISH_STATE_PENSION_CONTRIBUTORY.effectiveFrom,
      source: IRISH_STATE_PENSION_CONTRIBUTORY.source.url
    }
  };
}

export async function runPensionProjection(input, context) {
  const projection = computePensionProjection(input, { scenarioId: context.scenarioOverrides?.scenarioId || '' });
  return createModuleRunResult({
    moduleId: 'pension_projection',
    moduleVersion: context.moduleVersion,
    input,
    context,
    projection,
    semanticResult: {
      currency: context.baseCurrency || 'EUR',
      projectedPotAtRetirement: projection.debug.projectedPotCurrent,
      projectedPotAtIncomeStart: projection.debug.projectedAvailablePotAtIncomeStartCurrent,
      requiredPot: projection.debug.requiredPot,
      gapVsRequired: projection.debug.currentGapVsRequired,
      surplusVsRequired: projection.debug.currentSurplusVsRequired,
      readinessStatus: projection.debug.readinessStatus,
      readinessSentence: projection.debug.readinessSentence,
      retirementYear: projection.debug.retirementYear,
      depletionAgeProjected: projection.debug.depletionAgeProjected
    }
  });
}

export function getNetRetirementReadiness(profile) {
  const relevant = Boolean(findGoal(profile, ['retire', 'retire_early']));
  if (!relevant) return readinessFromMissing([], { relevant: false });
  const moduleIds = ['net_retirement_cashflow'];
  const requiredMissing = [];
  if (typeof profile.primaryPerson.age !== 'number') {
    requiredMissing.push(missing('/primaryPerson/age', 'Add the current age for the retirement cash-flow timeline.', moduleIds));
  }
  if (annualExpenses(profile) === null) {
    requiredMissing.push(missing('/expenses/annualTotal', 'Add annual net household spending.', moduleIds));
  }
  const assumptionsUsed = [];
  if (typeof profile.assumptions.inflationRate !== 'number') {
    assumptionsUsed.push(assumptionRecord('generalInflation'));
  }
  if (!Number.isFinite(getAssumption(profile, 'retirement.presentValueRate'))) {
    assumptionsUsed.push({ key: 'presentValueRate', value: 0.04, reason: 'Existing net retirement engine default.' });
  }
  const grossOnly = profile.incomeSources.filter((income) => income.grossAnnual && !income.netAnnual);
  const warnings = [
    'This adapter uses only after-tax income values; gross-only income is excluded from net cash-flow.',
    ...(grossOnly.length > 0 ? [`${grossOnly.length} gross-only income source(s) will be excluded.`] : []),
    ...crossCurrencyWarnings(profile, [
      ['Expenses', Object.values(profile.expenses || {})],
      ['Income values', profile.incomeSources.map((income) => income.netAnnual)],
      ['Liquid investments', profile.assets.map((asset) => asset.currentValue)]
    ])
  ];
  return readinessFromMissing(requiredMissing, { assumptionsUsed, warnings });
}

export function buildNetRetirementInput(profile) {
  const currency = baseCurrency(profile);
  const settings = getAssumption(profile, 'retirement', {});
  const currentAge = profile.primaryPerson.age;
  const incomeSources = profile.incomeSources
    .filter((income) => moneyAmount(income.netAnnual, currency) !== null)
    .map((income) => ({
      id: income.incomeId,
      title: income.label,
      type: income.type,
      annualAmountToday: moneyAmount(income.netAnnual, currency),
      startAge: income.startAge ?? currentAge,
      ...(typeof income.endAge === 'number' ? { endAge: income.endAge } : {}),
      inflationIndexed: income.inflationIndexed !== false
    }));
  return {
    currentYear: Number(profile.assumptions.calculationDateIso.slice(0, 4)),
    currentAge,
    horizonEndAge: Number.isInteger(settings.horizonEndAge) ? settings.horizonEndAge : 100,
    annualExpenditureToday: annualExpenses(profile),
    expenditureInflationRate: PLANEIR_ASSUMPTIONS.inflation.generalRate,
    presentValueRate: Number.isFinite(settings.presentValueRate) ? settings.presentValueRate : 0.04,
    availableInvestmentFundToday: availableInvestmentAmount(profile),
    incomeSources,
    scenarios: [{ id: 'base', title: 'Current position' }]
  };
}

export async function runNetRetirementCashflow(input, context) {
  const projection = computeNetRetirementProjection(input, { scenarioId: context.scenarioOverrides?.scenarioId || '' });
  return createModuleRunResult({
    moduleId: 'net_retirement_cashflow',
    moduleVersion: context.moduleVersion,
    input,
    context,
    projection,
    semanticResult: {
      currency: context.baseCurrency || 'EUR',
      requiredNetFundToday: projection.debug.requiredFundToday,
      firstYearShortfall: projection.debug.firstYearShortfall,
      surplusVsRequired: projection.debug.surplusVsRequired,
      gapVsRequired: projection.debug.gapVsRequired,
      scenarioId: projection.debug.scenarioId
    }
  });
}
