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

export const MORTGAGE_ADAPTER_VERSION = '1.0.0';

function selectMortgage(profile) {
  return selectLiabilityOfType(
    profile,
    'mortgage',
    getAssumption(profile, 'mortgage.liabilityId')
  );
}

/**
 * Name the mortgage under analysis when the household holds more than one.
 *
 * By the time this runs the client has chosen -- an undecided household never
 * reaches a result at all -- so this records WHICH of theirs was analysed
 * rather than papering over a choice nobody made.
 */
function mortgageSelectionAssumption(selection) {
  if (!selection.selected || selection.candidates.length < 2) return [];
  return [{
    key: 'analysedMortgage',
    value: selection.selected.label || selection.selected.liabilityId,
    reason: `The household holds ${selection.candidates.length} mortgages; this analysis covers the one that was chosen.`
  }];
}

export function getMortgageReadiness(profile) {
  const selection = selectMortgage(profile);
  const mortgage = selection.selected;
  const relevant = Boolean(findGoal(profile, 'optimise_mortgage'))
    || selection.candidates.length > 0;
  if (!relevant) return readinessFromMissing([], { relevant: false });
  const moduleIds = ['mortgage_analysis'];
  const requiredMissing = [];
  if (selection.ambiguous) {
    // ASK, DO NOT GUESS. Two mortgages and no stated choice is a question for
    // the client, not a tie broken by whichever was recorded first.
    requiredMissing.push(missing(
      '/assumptions/values/mortgage/liabilityId',
      `Which mortgage should this analysis cover: ${selection.candidates
        .map((item) => item.label || item.liabilityId).join(', ')}?`,
      moduleIds
    ));
  } else if (!mortgage) {
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
    { key: 'repaymentType', value: 'repayment', reason: 'The current deterministic engine supports amortising repayment mortgages only.' },
    ...mortgageSelectionAssumption(selection)
  ];
  const warnings = [
    'Interest-only mortgages are not supported in v1.',
    ...crossCurrencyWarnings(profile, [['Mortgage values', mortgage ? [mortgage.currentBalance, mortgage.monthlyPayment] : []]])
  ];
  return readinessFromMissing(requiredMissing, { assumptionsUsed, warnings });
}

export function buildMortgageInput(profile) {
  const selection = selectMortgage(profile);
  const mortgage = selection.selected;
  // Readiness already refuses both of these, so reaching here means a direct
  // caller skipped it. Say what is wrong rather than dereferencing null, and
  // never resolve an undecided choice just because someone called in directly.
  if (selection.ambiguous) {
    throw new Error(
      `generated.mortgageInputs cannot be built: the profile holds ${selection.candidates.length} mortgages `
      + 'and none has been chosen for analysis.'
    );
  }
  if (!mortgage) {
    throw new Error('generated.mortgageInputs cannot be built: the profile holds no mortgage to analyse.');
  }
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

/**
 * Hold the generated payload to the engine's own contract before the engine
 * sees it, so a mapping defect here reports as an invalid input rather than
 * as an engine crash. Both modules share one engine, so both share one
 * contract.
 */
export function validateMortgageInput(input) {
  normalizeMortgageInputs(input, { defaultLoanKind: 'mortgage' });
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

