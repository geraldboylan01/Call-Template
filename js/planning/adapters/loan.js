import { computeMortgageProjection, normalizeMortgageInputs } from '../../mortgage_math.js';
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

/**
 * Which loan this run is about.
 *
 * `selectLoan` falls back to the first matching liability, so a household with
 * two of them got an analysis of one and nothing on the page said which. The
 * choice is declared instead: the figures are right for a real loan of
 * theirs, and the client can now see whether it is the one they meant.
 */
function loanSelectionAssumption(profile, selected) {
  const candidates = profile.liabilities.filter((item) => item.type === 'loan');
  if (!selected || candidates.length < 2) return [];
  return [{
    key: 'analysedLoan',
    value: selected.label || selected.liabilityId,
    reason: `The household holds ${candidates.length} loans; this analysis covers that one.`
  }];
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
    assumptionsUsed: [
      { key: 'repaymentType', value: 'repayment', reason: 'The deterministic loan engine supports amortising repayment loans.' },
      ...loanSelectionAssumption(profile, loan)
    ],
    warnings: crossCurrencyWarnings(profile, [['Loan values', loan ? [loan.currentBalance, loan.monthlyPayment] : []]])
  });
}

export function buildLoanInput(profile) {
  const loan = selectLoan(profile);
  // Readiness already refuses this, so reaching here means a direct caller
  // skipped it. Say what is absent rather than dereferencing null and
  // reporting a TypeError as the module's diagnostic.
  if (!loan) {
    throw new Error('generated.loanInputs cannot be built: the profile holds no loan to analyse.');
  }
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

/**
 * Hold the generated payload to the engine's own contract before the engine
 * sees it, so a mapping defect here reports as an invalid input rather than
 * as an engine crash. Both modules share one engine, so both share one
 * contract.
 */
export function validateLoanInput(input) {
  normalizeMortgageInputs(input, { defaultLoanKind: 'loan' });
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
