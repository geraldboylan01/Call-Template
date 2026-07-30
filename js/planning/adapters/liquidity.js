import {
  LIQUIDITY_RESERVE_POLICY,
  computeLiquidityReserve,
  resolveLiquidityReservePolicy
} from '../../liquidity_reserve.js';
import {
  annualExpenses,
  baseCurrency,
  cashAmount,
  confirmedNone,
  createModuleRunResult,
  crossCurrencyWarnings,
  findGoal,
  getAssumption,
  grossEmploymentIncome,
  missing,
  monthlyExpenses,
  readiness,
  readinessFromMissing
} from './common.js';

export const LIQUIDITY_ADAPTER_VERSION = '1.1.0';

const RETIRED_STATUSES = new Set(['newly_retired', 'retired', 'older_retiree']);
const WORKING_STATUSES = new Set(['working', 'approaching_retirement']);
const WORKING_EMPLOYMENT_CONTEXTS = new Set([
  'employed', 'employee', 'self_employed', 'contractor', 'company_director', 'owner_manager'
]);

export function resolveLiquidityCohort(profile) {
  const persona = profile?.assumptions?.values?.persona || {};
  const retirementStatus = String(persona.retirementStatus || '').trim().toLowerCase();
  if (RETIRED_STATUSES.has(retirementStatus)) return 'retired';
  if (WORKING_STATUSES.has(retirementStatus)) return 'working';

  const employmentContext = String(persona.employmentContext || '').trim().toLowerCase();
  if (employmentContext === 'retired') return 'retired';
  if (WORKING_EMPLOYMENT_CONTEXTS.has(employmentContext)) return 'working';

  const employmentStatus = String(profile?.primaryPerson?.employmentStatus || '').trim().toLowerCase();
  if (employmentStatus === 'retired') return 'retired';
  if (['employee', 'self_employed', 'contractor'].includes(employmentStatus)) return 'working';

  const primaryPersonId = profile?.primaryPerson?.personId;
  if (primaryPersonId && grossEmploymentIncome(profile, primaryPersonId) > 0) return 'working';
  return null;
}

export function getLiquidityReadiness(profile) {
  const moduleIds = ['liquidity_analysis'];
  const requiredMissing = [];
  const cashAssets = profile.assets?.filter((asset) => asset.type === 'cash') || [];
  if (cashAssets.length === 0 || !cashAssets.some((asset) => asset.currentValue)) {
    requiredMissing.push(missing('/assets', 'Add the current cash available to the household.', moduleIds));
  }
  if (monthlyExpenses(profile) === null) {
    requiredMissing.push(missing('/expenses/annualTotal', 'Add annual or monthly household spending.', moduleIds));
  }
  const cohort = resolveLiquidityCohort(profile);
  if (!cohort) {
    requiredMissing.push(missing(
      '/assumptions/values/persona/retirementStatus',
      'Confirm whether the household is working or retired so the correct cash-reserve guide is used.',
      moduleIds
    ));
  }
  const policy = cohort ? resolveLiquidityReservePolicy(cohort) : null;
  const assumptionsUsed = [];
  if (policy && getAssumption(profile, 'liquidity.minimumBufferMonths') === undefined) {
    assumptionsUsed.push({
      key: 'minimumBufferMonths',
      value: policy.minimumBufferMonths,
      reason: `${policy.basis} (${LIQUIDITY_RESERVE_POLICY.policyVersion}).`
    });
  }
  if (policy && getAssumption(profile, 'liquidity.targetBufferMonths') === undefined) {
    assumptionsUsed.push({
      key: 'targetBufferMonths',
      value: policy.targetBufferMonths,
      reason: policy.basis
    });
  }
  const warnings = crossCurrencyWarnings(profile, [
    ['Cash assets', cashAssets.map((asset) => asset.currentValue)],
    ['Expenses', Object.values(profile.expenses || {})]
  ]);
  const relevant = Boolean(findGoal(profile, ['maintain_liquidity', 'understand_position', 'buy_home']))
    || cashAssets.length > 0;
  if (['/expenses', '/expenses/annualTotal', '/expenses/monthlyEssential'].some((path) => confirmedNone(profile, path))
    && monthlyExpenses(profile) === null) {
    return readiness({
      status: 'adviser_review_required',
      assumptionsUsed,
      warnings: [
        ...warnings,
        'The liquidity illustration cannot calculate a reserve without positive household spending. Add spending later or discuss the position with an adviser.'
      ]
    });
  }
  return readinessFromMissing(requiredMissing, { assumptionsUsed, warnings, relevant });
}

export function buildLiquidityInput(profile) {
  const cohort = resolveLiquidityCohort(profile);
  const clientStatus = cohort === 'retired' ? 'retired' : 'not-retired';
  const policy = resolveLiquidityReservePolicy(clientStatus);
  return {
    currentCash: cashAmount(profile),
    monthlyExpenditure: monthlyExpenses(profile),
    annualExpenditure: annualExpenses(profile),
    clientStatus,
    policyVersion: LIQUIDITY_RESERVE_POLICY.policyVersion,
    minimumBufferMonths: getAssumption(
      profile,
      'liquidity.minimumBufferMonths',
      policy.minimumBufferMonths
    ),
    targetBufferMonths: getAssumption(
      profile,
      'liquidity.targetBufferMonths',
      policy.targetBufferMonths
    )
  };
}

export async function runLiquidityAnalysis(input, context) {
  const reserve = computeLiquidityReserve(input);
  const currency = context.baseCurrency || 'EUR';
  const projection = {
    assumptionsTable: {
      columns: ['Assumption', 'Value'],
      rows: [
        ['Minimum buffer', `${reserve.minimumBufferMonths} months`],
        ['Target buffer', `${reserve.targetBufferMonths} months`],
        ['Monthly spending', reserve.monthlyExpenditure]
      ]
    },
    outputsTable: {
      columns: ['Metric', 'Value'],
      rows: [
        ['Current cash', reserve.currentCash],
        ['Months covered', reserve.monthsCovered],
        ['Target cash', reserve.targetCash],
        ['Surplus to target', reserve.surplusCash],
        ['Shortfall to target', reserve.shortfallCash]
      ]
    },
    tables: [],
    charts: reserve.currentCash === null || reserve.targetCash === null ? [] : [{
      id: 'liquidity-reserve-position',
      title: 'Cash reserve position',
      type: 'bar',
      labels: ['Current cash', 'Minimum reserve', 'Target reserve'],
      datasets: [{ label: currency, data: [reserve.currentCash, reserve.minimumCash, reserve.targetCash] }]
    }]
  };
  return createModuleRunResult({
    moduleId: 'liquidity_analysis',
    moduleVersion: context.moduleVersion,
    input,
    context,
    projection,
    semanticResult: {
      currency,
      clientStatus: reserve.clientStatus,
      policyVersion: reserve.policyVersion,
      currentCash: reserve.currentCash,
      monthlyExpenditure: reserve.monthlyExpenditure,
      monthsCovered: reserve.monthsCovered,
      minimumCash: reserve.minimumCash,
      targetCash: reserve.targetCash,
      surplusCash: reserve.surplusCash,
      shortfallCash: reserve.shortfallCash,
      position: reserve.shortfallCash > 0 ? 'below_target' : 'at_or_above_target'
    }
  });
}
