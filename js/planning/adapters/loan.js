import { computeMortgageProjection, normalizeMortgageInputs } from '../../mortgage_math.js';
import {
  baseCurrency,
  createModuleRunResult,
  crossCurrencyWarnings,
  findGoal,
  getAssumption,
  missing,
  moneyAmount,
  readinessFromMissing,
  selectLiabilityOfType
} from './common.js';

export const LOAN_ADAPTER_VERSION = '1.0.0';

function selectLoan(profile) {
  return selectLiabilityOfType(
    profile,
    'loan',
    getAssumption(profile, 'loan.liabilityId')
  );
}

/**
 * Name the loan under analysis when the household holds more than one.
 *
 * By the time this runs the client has chosen -- an undecided household never
 * reaches a result at all -- so this records WHICH of theirs was analysed
 * rather than papering over a choice nobody made.
 */
function loanSelectionAssumption(selection) {
  if (!selection.selected || selection.candidates.length < 2) return [];
  return [{
    key: 'analysedLoan',
    value: selection.selected.label || selection.selected.liabilityId,
    reason: `The household holds ${selection.candidates.length} loans; this analysis covers the one that was chosen.`
  }];
}

export function getLoanReadiness(profile) {
  const selection = selectLoan(profile);
  const loan = selection.selected;
  const relevant = Boolean(findGoal(profile, 'manage_loan')) || selection.candidates.length > 0;
  if (!relevant) return readinessFromMissing([], { relevant: false });
  const moduleIds = ['loan_analysis'];
  const requiredMissing = [];
  if (selection.ambiguous) {
    // ASK, DO NOT GUESS. Same rule as the mortgage: several loans and no stated
    // choice is a question, not a tie broken by recording order.
    requiredMissing.push(missing(
      '/assumptions/values/loan/liabilityId',
      `Which loan should this analysis cover: ${selection.candidates
        .map((item) => item.label || item.liabilityId).join(', ')}?`,
      moduleIds
    ));
  } else if (!loan) {
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
      ...loanSelectionAssumption(selection)
    ],
    warnings: crossCurrencyWarnings(profile, [['Loan values', loan ? [loan.currentBalance, loan.monthlyPayment] : []]])
  });
}

export function buildLoanInput(profile) {
  const selection = selectLoan(profile);
  const loan = selection.selected;
  // Readiness already refuses both of these, so reaching here means a direct
  // caller skipped it. Say what is wrong rather than dereferencing null, and
  // never resolve an undecided choice just because someone called in directly.
  if (selection.ambiguous) {
    throw new Error(
      `generated.loanInputs cannot be built: the profile holds ${selection.candidates.length} loans `
      + 'and none has been chosen for analysis.'
    );
  }
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
  normalizeLoanInput(input);
}

/** Canonical input the shared amortisation engine will actually consume. */
export function normalizeLoanInput(input) {
  // Contract identity only. The shared amortisation normalizer has a useful UI
  // default, but accepting an absent discriminator here would let structural
  // code choose the financial meaning of the payload.
  if (input?.loanKind !== 'loan') {
    throw new Error('generated.loanInputs.loanKind must be "loan".');
  }
  const hasEndDate = typeof input.endDateIso === 'string' && input.endDateIso.trim() !== '';
  const hasRemainingTerm = input.remainingTermYears !== null
    && typeof input.remainingTermYears !== 'undefined';
  if (hasEndDate === hasRemainingTerm) {
    throw new Error('generated.loanInputs must provide exactly one of endDateIso or remainingTermYears.');
  }
  const normalized = normalizeMortgageInputs(input, { defaultLoanKind: 'loan' });
  if (normalized.loanKind !== 'loan') {
    throw new Error('generated.loanInputs.loanKind must be "loan".');
  }
  return normalized;
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
