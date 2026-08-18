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

export const MORTGAGE_ADAPTER_VERSION = '1.0.0';

function selectMortgage(profile) {
  const selectedId = getAssumption(profile, 'mortgage.liabilityId');
  return profile.liabilities.find((liability) => liability.type === 'mortgage' && liability.liabilityId === selectedId)
    || profile.liabilities.find((liability) => liability.type === 'mortgage')
    || null;
}

/**
 * Which mortgage this run is about.
 *
 * `selectMortgage` falls back to the first matching liability, so a household with
 * two of them got an analysis of one and nothing on the page said which. The
 * choice is declared instead: the figures are right for a real mortgage of
 * theirs, and the client can now see whether it is the one they meant.
 */
function mortgageSelectionAssumption(profile, selected) {
  const candidates = profile.liabilities.filter((item) => item.type === 'mortgage');
  if (!selected || candidates.length < 2) return [];
  return [{
    key: 'analysedMortgage',
    value: selected.label || selected.liabilityId,
    reason: `The household holds ${candidates.length} mortgages; this analysis covers that one.`
  }];
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
    { key: 'repaymentType', value: 'repayment', reason: 'The current deterministic engine supports amortising repayment mortgages only.' },
    ...mortgageSelectionAssumption(profile, mortgage)
  ];
  const warnings = [
    'Interest-only mortgages are not supported in v1.',
    ...crossCurrencyWarnings(profile, [['Mortgage values', mortgage ? [mortgage.currentBalance, mortgage.monthlyPayment] : []]])
  ];
  return readinessFromMissing(requiredMissing, { assumptionsUsed, warnings });
}

export function buildMortgageInput(profile) {
  const mortgage = selectMortgage(profile);
  // Readiness already refuses this, so reaching here means a direct caller
  // skipped it. Say what is absent rather than dereferencing null and
  // reporting a TypeError as the module's diagnostic.
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

