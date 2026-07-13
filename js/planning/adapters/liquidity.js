import { computeWorkingLiquidityReserve } from '../../liquidity_reserve.js';
import {
  annualExpenses,
  baseCurrency,
  cashAmount,
  confirmedNone,
  createModuleRunResult,
  crossCurrencyWarnings,
  findGoal,
  getAssumption,
  missing,
  monthlyExpenses,
  readiness,
  readinessFromMissing
} from './common.js';

export const LIQUIDITY_ADAPTER_VERSION = '1.0.0';

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
  const assumptionsUsed = [];
  if (getAssumption(profile, 'liquidity.minimumBufferMonths') === undefined) {
    assumptionsUsed.push({ key: 'minimumBufferMonths', value: 3, reason: 'Planéir working-household safety floor.' });
  }
  if (getAssumption(profile, 'liquidity.targetBufferMonths') === undefined) {
    assumptionsUsed.push({ key: 'targetBufferMonths', value: 6, reason: 'Planéir working-household reserve target.' });
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
  return {
    currentCash: cashAmount(profile),
    monthlyExpenditure: monthlyExpenses(profile),
    annualExpenditure: annualExpenses(profile),
    minimumBufferMonths: getAssumption(profile, 'liquidity.minimumBufferMonths', 3),
    targetBufferMonths: getAssumption(profile, 'liquidity.targetBufferMonths', 6)
  };
}

export async function runLiquidityAnalysis(input, context) {
  const reserve = computeWorkingLiquidityReserve(input);
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
