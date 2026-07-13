import { computeMortgageProjection } from '../../mortgage_math.js';
import {
  baseCurrency,
  createModuleRunResult,
  crossCurrencyWarnings,
  findGoal,
  getAssumption,
  missing,
  moneyAmount,
  readinessFromMissing
} from './common.js';

export const MORTGAGE_ADAPTER_VERSION = '1.0.0';

function selectMortgage(profile) {
  const selectedId = getAssumption(profile, 'mortgage.liabilityId');
  return profile.liabilities.find((liability) => liability.type === 'mortgage' && liability.liabilityId === selectedId)
    || profile.liabilities.find((liability) => liability.type === 'mortgage')
    || null;
}

export function getMortgageReadiness(profile) {
  const mortgage = selectMortgage(profile);
  const relevant = Boolean(findGoal(profile, 'optimise_mortgage')) || Boolean(mortgage);
  if (!relevant) return readinessFromMissing([], { relevant: false });
  const moduleIds = ['mortgage_analysis'];
  const requiredMissing = [];
  if (!mortgage) {
    requiredMissing.push(missing('/liabilities', 'Add the mortgage to analyse.', moduleIds));
  } else {
    const index = profile.liabilities.indexOf(mortgage);
    if (!mortgage.currentBalance) requiredMissing.push(missing(`/liabilities/${index}/currentBalance`, 'Add the mortgage balance.', moduleIds));
    if (typeof mortgage.annualInterestRate !== 'number') {
      requiredMissing.push(missing(`/liabilities/${index}/annualInterestRate`, 'Add the current annual interest rate.', moduleIds));
    }
    if (typeof mortgage.remainingTermMonths !== 'number') {
      requiredMissing.push(missing(`/liabilities/${index}/remainingTermMonths`, 'Add the remaining mortgage term.', moduleIds));
    }
  }
  const assumptionsUsed = [
    { key: 'repaymentType', value: 'repayment', reason: 'The current deterministic engine supports amortising repayment mortgages only.' }
  ];
  const warnings = [
    'Interest-only mortgages are not supported in v1.',
    ...crossCurrencyWarnings(profile, [['Mortgage values', mortgage ? [mortgage.currentBalance, mortgage.monthlyPayment] : []]])
  ];
  return readinessFromMissing(requiredMissing, { assumptionsUsed, warnings });
}

export function buildMortgageInput(profile) {
  const mortgage = selectMortgage(profile);
  const settings = getAssumption(profile, 'mortgage', {});
  return {
    loanKind: 'mortgage',
    currentBalance: moneyAmount(mortgage.currentBalance, baseCurrency(profile)),
    annualInterestRate: mortgage.annualInterestRate,
    startDateIso: profile.assumptions.calculationDateIso,
    remainingTermYears: mortgage.remainingTermMonths / 12,
    repaymentType: 'repayment',
    fixedPaymentAmount: Number.isFinite(settings.fixedPaymentAmount) ? settings.fixedPaymentAmount : null,
    oneOffOverpayment: Number.isFinite(settings.oneOffOverpayment) ? settings.oneOffOverpayment : 0,
    annualOverpayment: Number.isFinite(settings.annualOverpayment) ? settings.annualOverpayment : 0
  };
}

export async function runMortgageAnalysis(input, context) {
  const projection = computeMortgageProjection(input);
  return createModuleRunResult({
    moduleId: 'mortgage_analysis',
    moduleVersion: context.moduleVersion,
    input,
    context,
    projection,
    semanticResult: {
      currency: context.baseCurrency || 'EUR',
      openingBalance: projection.debug.openingBalance,
      monthlyPayment: projection.debug.paymentUsedMonthly,
      payoffYear: projection.debug.payoffYear,
      totalInterestLifetime: projection.debug.totalInterestLifetime,
      totalPaidLifetime: projection.debug.totalPaidLifetime
    }
  });
}

