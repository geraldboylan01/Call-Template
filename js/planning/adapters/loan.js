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

export const LOAN_ADAPTER_VERSION = '1.0.0';

function selectLoan(profile) {
  const selectedId = getAssumption(profile, 'loan.liabilityId');
  return profile.liabilities.find((item) => item.type === 'loan' && item.liabilityId === selectedId)
    || profile.liabilities.find((item) => item.type === 'loan')
    || null;
}

export function getLoanReadiness(profile) {
  const loan = selectLoan(profile);
  const relevant = Boolean(findGoal(profile, 'manage_loan')) || Boolean(loan);
  if (!relevant) return readinessFromMissing([], { relevant: false });
  const moduleIds = ['loan_analysis'];
  const requiredMissing = [];
  if (!loan) {
    requiredMissing.push(missing('/liabilities', 'Add the non-housing loan to analyse.', moduleIds));
  } else {
    const index = profile.liabilities.indexOf(loan);
    if (!loan.currentBalance) requiredMissing.push(missing(`/liabilities/${index}/currentBalance`, 'Add the current loan balance.', moduleIds));
    if (typeof loan.annualInterestRate !== 'number') {
      requiredMissing.push(missing(`/liabilities/${index}/annualInterestRate`, 'Add the annual interest rate on the loan.', moduleIds));
    }
    if (typeof loan.remainingTermMonths !== 'number') {
      requiredMissing.push(missing(`/liabilities/${index}/remainingTermMonths`, 'Add the remaining loan term.', moduleIds));
    }
  }
  return readinessFromMissing(requiredMissing, {
    assumptionsUsed: [{ key: 'repaymentType', value: 'repayment', reason: 'The deterministic loan engine supports amortising repayment loans.' }],
    warnings: crossCurrencyWarnings(profile, [['Loan values', loan ? [loan.currentBalance, loan.monthlyPayment] : []]])
  });
}

export function buildLoanInput(profile) {
  const loan = selectLoan(profile);
  const settings = getAssumption(profile, 'loan', {});
  return {
    loanKind: 'loan',
    currentBalance: moneyAmount(loan.currentBalance, baseCurrency(profile)),
    annualInterestRate: loan.annualInterestRate,
    startDateIso: profile.assumptions.calculationDateIso,
    remainingTermYears: loan.remainingTermMonths / 12,
    repaymentType: 'repayment',
    fixedPaymentAmount: Number.isFinite(settings.fixedPaymentAmount) ? settings.fixedPaymentAmount : null,
    oneOffOverpayment: Number.isFinite(settings.oneOffOverpayment) ? settings.oneOffOverpayment : 0,
    annualOverpayment: Number.isFinite(settings.annualOverpayment) ? settings.annualOverpayment : 0
  };
}

export async function runLoanAnalysis(input, context) {
  const projection = computeMortgageProjection(input);
  return createModuleRunResult({
    moduleId: 'loan_analysis',
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
