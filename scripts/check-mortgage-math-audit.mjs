#!/usr/bin/env node

/**
 * PHASE 5 MODULE #4 — THE AMORTISATION ENGINE, PROVED ARITHMETICALLY.
 *
 * `mortgage_analysis` and `loan_analysis` are two modules over one engine, so
 * the maths is audited deeply ONCE here and the two modules are checked only
 * for what actually differs between them: which liability they select, how
 * they map it, and what they expose.
 *
 * THE REFERENCE IMPLEMENTATION BELOW IS WRITTEN FROM THE FORMULA, not from the
 * code under test:
 *
 *     P = B·i / (1 − (1+i)^−n)
 *
 * and the schedule is re-simulated from `interest = balance × i`,
 * `principal = payment − interest`. It imports nothing from `mortgage_math.js`.
 * A shared bug would otherwise agree with itself and pass.
 *
 * THE DEFECT THIS PINS. Payoff detection required the remaining balance to
 * reach EXACTLY zero, which floating-point arithmetic reaches only by luck.
 * Across €250,000 over 25 years at rates from 1% to 6%, half the runs finished
 * with a residue like 0.00000000012 — and every one of those told the client,
 * in prose, that the mortgage would not be repaid, on the same screen as
 * "Remaining balance at term end: €0.00". A debt of a ten-billionth of a cent
 * is not a debt: money is measured to the cent, and anything below half a cent
 * is settled.
 */

import assert from 'node:assert/strict';

import {
  computeAmortizationMonthlySchedule,
  computeMonthlyPayment,
  computeMortgageProjection
} from '../js/mortgage_math.js';
import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';
import {
  buildMortgageInput,
  getMortgageReadiness,
  validateMortgageInput
} from '../js/planning/adapters/mortgage.js';
import { buildLoanInput, getLoanReadiness, validateLoanInput } from '../js/planning/adapters/loan.js';
import { runPlanningModule } from '../js/planning/module_registry.js';
import { MODULE_FAILURE_CODES, classifyModuleFailure } from '../js/planning/module_failures.js';

const pass = (message) => console.info(`[MortgageAudit] PASS: ${message}`);

const NOW = '2026-08-18T09:00:00.000Z';
const TODAY = '2026-08-18';
const EUR = (amount) => ({ amount, currency: 'EUR' });

/* ------------------------------------------------ independent arithmetic */

/** The annuity payment, from the formula. */
function referencePayment(balance, annualRate, months) {
  const i = annualRate / 12;
  if (i === 0) return balance / months;
  return (balance * i) / (1 - Math.pow(1 + i, -months));
}

/** The schedule, re-simulated period by period from first principles. */
function referenceSchedule(balance, annualRate, months, payment) {
  const i = annualRate / 12;
  let remaining = balance;
  let totalInterest = 0;
  let totalPrincipal = 0;
  let periods = 0;
  while (periods < months && remaining > 0.005) {
    const interest = remaining * i;
    const principal = Math.min(payment - interest, remaining);
    totalInterest += interest;
    totalPrincipal += principal;
    remaining -= principal;
    periods += 1;
  }
  return {
    periods,
    totalInterest,
    totalPrincipal,
    remaining: remaining <= 0.005 ? 0 : remaining,
    totalPaid: totalInterest + totalPrincipal
  };
}

// Money compared to the cent. Lifetime totals are sums of hundreds of floats,
// so they carry accumulated representation error far below a cent; anything
// larger than this is a real disagreement, not rounding.
const CENT = 0.01;
const close = (actual, expected, tolerance, note) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${note}: expected ${expected}, got ${actual} (tolerance ${tolerance})`
);

const BASE = { repaymentType: 'repayment', startDateIso: '2026-01-01' };
const schedule = (over) => computeAmortizationMonthlySchedule({ ...BASE, ...over });

/* ------------------------------------------------------- hand-checkable */

{
  // €100,000 at 0% over 10 years. €833.33 a month, no interest, €100,000 paid.
  // The zero-rate branch is also the division-by-zero guard in the annuity
  // formula, so this case earns its place twice.
  const result = schedule({ currentBalance: 100_000, annualInterestRate: 0, remainingTermYears: 10 });
  close(result.monthlyPaymentUsed, 100_000 / 120, 1e-9, 'zero-rate payment');
  close(result.monthlyPaymentUsed, referencePayment(100_000, 0, 120), 1e-9, 'zero-rate payment vs reference');
  assert.equal(result.totalInterestLifetime, 0, 'no rate is no interest');
  close(result.totalPaidLifetime, 100_000, CENT, 'total paid equals the sum borrowed');
  assert.equal(result.monthsSimulated, 120);
  assert.equal(result.balanceRemaining, 0);
  assert.equal(result.payoffYear, 2035, 'ten years from 2026 is 2035');
  pass('hand-checkable: €100,000 at 0% over 10 years is €833.33 a month and no interest');
}

{
  // One month at 12% a year is one month at 1%: €1,000 becomes €1,010.
  const result = schedule({ currentBalance: 1_000, annualInterestRate: 0.12, remainingTermYears: 1 / 12 });
  assert.equal(result.monthsSimulated, 1);
  close(result.monthlyPaymentUsed, 1_010, 1e-9, 'one-month payment');
  close(result.totalInterestLifetime, 10, 1e-9, 'one month of interest at 1%');
  assert.equal(result.balanceRemaining, 0);
  pass('hand-checkable: a one-month term at 12% costs exactly one month of interest');
}

/* ------------------------------------------------------------- realistic */

{
  const balance = 280_000;
  const rate = 0.039;
  const months = 27 * 12;
  const expectedPayment = referencePayment(balance, rate, months);
  const expected = referenceSchedule(balance, rate, months, expectedPayment);
  const result = schedule({ currentBalance: balance, annualInterestRate: rate, remainingTermYears: 27 });

  close(result.monthlyPaymentUsed, expectedPayment, 1e-9, 'payment vs independent annuity');
  close(result.totalInterestLifetime, expected.totalInterest, CENT, 'lifetime interest vs independent schedule');
  close(result.totalPrincipalLifetime, expected.totalPrincipal, CENT, 'lifetime principal');
  close(result.totalPaidLifetime, expected.totalPaid, CENT, 'lifetime total paid');
  assert.equal(result.monthsSimulated, expected.periods);
  assert.equal(result.payoffYear, 2052, '324 months from January 2026');
  pass('realistic: €280,000 at 3.9% over 27 years matches an independently computed annuity');
}

/* -------------------------------------------------------- the identities */

{
  // What you pay is what you borrowed plus the interest on it. Asserted across
  // a spread of rates and terms rather than at one convenient point.
  for (const [balance, rate, years] of [
    [100_000, 0, 10], [250_000, 0.025, 25], [280_000, 0.039, 27],
    [15_000, 0.079, 5], [500_000, 0.06, 30]
  ]) {
    const result = schedule({ currentBalance: balance, annualInterestRate: rate, remainingTermYears: years });
    close(
      result.totalPaidLifetime,
      result.totalInterestLifetime + result.openingBalance,
      CENT,
      `total paid = interest + principal (${balance} at ${rate})`
    );
    close(result.totalPrincipalLifetime, result.openingBalance, CENT, 'principal repaid is the sum borrowed');
    assert.equal(result.balanceRemaining, 0, 'a fully amortising schedule ends at zero');
    assert.ok(result.payoffYear !== null, 'and reports the year it was repaid');
  }
  pass('total paid equals principal plus interest, across five rate and term combinations');
}

{
  // Every period: interest is the rate on the balance, and the payment splits
  // into exactly interest plus principal.
  const result = schedule({ currentBalance: 250_000, annualInterestRate: 0.045, remainingTermYears: 25 });
  const monthlyRate = 0.045 / 12;
  for (const month of result.monthlySchedule) {
    close(month.interestPaid, month.balanceStart * monthlyRate, 1e-6, `interest in month ${month.monthIndex}`);
    close(month.totalPaid, month.interestPaid + month.principalPaid, 1e-9, `split in month ${month.monthIndex}`);
    close(month.balanceEnd, month.balanceStart - month.principalPaid, 1e-9, `balance roll in month ${month.monthIndex}`);
    assert.ok(month.balanceEnd >= -1e-9, 'the balance never goes below zero');
  }
  const first = result.monthlySchedule[0];
  close(first.interestPaid, 250_000 * monthlyRate, 1e-9, 'the first month is the rate on the opening balance');
  pass('every period splits into interest on the balance plus principal, and the balance rolls forward');
}

{
  // The annual rollup is the monthly schedule regrouped, not a second sum.
  const result = schedule({ currentBalance: 280_000, annualInterestRate: 0.039, remainingTermYears: 27 });
  const annualPrincipal = result.annualSchedule.reduce((sum, row) => sum + row.principalPaidRaw, 0);
  const annualInterest = result.annualSchedule.reduce((sum, row) => sum + row.interestPaidRaw, 0);
  close(annualPrincipal, result.totalPrincipalLifetime, 1e-6, 'annual principal reconciles to lifetime');
  close(annualInterest, result.totalInterestLifetime, 1e-6, 'annual interest reconciles to lifetime');
  assert.equal(result.annualSchedule.length, 27, 'one row per calendar year of the term');
  assert.equal(result.annualSchedule.at(-1).balanceEnd, 0, 'the final year ends at zero');
  pass('the annual schedule reconciles exactly to the monthly one');
}

/* -------------------------------------------- the payoff-detection defect */

{
  // THE DEFECT. Requiring an exact zero made this a coin flip: half of these
  // finished with a float residue and were reported as never repaid.
  let wrong = 0;
  let total = 0;
  for (let basisPoints = 100; basisPoints <= 600; basisPoints += 5) {
    const result = schedule({
      currentBalance: 250_000, annualInterestRate: basisPoints / 10_000, remainingTermYears: 25
    });
    total += 1;
    if (result.payoffYear === null || result.balanceRemaining !== 0) wrong += 1;
  }
  assert.equal(wrong, 0, `${wrong} of ${total} fully amortising mortgages were reported as not repaid`);
  assert.ok(total >= 100, 'the sweep is wide enough to catch a float-luck regression');
  pass(`all ${total} fully amortising mortgages across 1%–6% report a payoff year`);
}

{
  // And the prose the client reads must agree with the figure beside it.
  const projection = computeMortgageProjection({
    ...BASE, currentBalance: 100_000, annualInterestRate: 0, remainingTermYears: 10
  });
  const summary = projection.summaryHtml.replace(/<[^>]+>/g, '');
  assert.match(summary, /projected to be fully repaid in 2035/);
  assert.ok(!/not fully repaid/.test(summary), 'the summary cannot deny a repayment it also shows as complete');
  const payoffRow = projection.outputsTable.rows.find((row) => row[0] === 'Payoff year');
  assert.equal(payoffRow[1], '2035');
  const balanceRow = projection.outputsTable.rows.find((row) => /Remaining balance/.test(row[0]));
  assert.equal(balanceRow[1], '€0.00');
  assert.match(balanceRow[2], /fully repaid/, 'and the note agrees with the balance');
  pass('the client summary and the outputs table tell the same story about repayment');
}

{
  // A loan that genuinely is not repaid must still say so.
  const result = schedule({
    currentBalance: 200_000, annualInterestRate: 0.05, remainingTermYears: 20, fixedPaymentAmount: 1_000
  });
  assert.equal(result.payoffYear, null, 'an underpaid loan has no payoff year');
  assert.ok(result.balanceRemaining > 1_000, 'and a real balance remains');
  assert.equal(result.monthsSimulated, result.termMonthsPlanned, 'it ran the whole term');
  pass('a genuinely unpaid loan still reports no payoff year and a real outstanding balance');
}

/* ------------------------------------------------------------ edge cases */

{
  assert.throws(
    () => schedule({
      currentBalance: 200_000, annualInterestRate: 0.05, remainingTermYears: 20, fixedPaymentAmount: 100
    }),
    /Negative amortisation/,
    'a payment below the monthly interest is refused, not looped forever'
  );
  pass('a payment that cannot cover the interest is refused rather than amortising negatively');
}

{
  // A payment larger than the debt clears it in one month and no more.
  const result = schedule({
    currentBalance: 1_000, annualInterestRate: 0.05, remainingTermYears: 10, fixedPaymentAmount: 5_000
  });
  assert.equal(result.monthsSimulated, 1);
  assert.equal(result.balanceRemaining, 0);
  close(result.totalPaidLifetime, 1_000 + (1_000 * 0.05 / 12), CENT, 'only the debt and one month of interest');
  pass('a payment above the balance settles it in one month and takes no more than is owed');
}

{
  // A one-off overpayment reduces the balance the maths starts from.
  const result = schedule({
    currentBalance: 100_000, annualInterestRate: 0, remainingTermYears: 10, oneOffOverpayment: 20_000
  });
  assert.equal(result.openingBalance, 80_000);
  close(result.monthlyPaymentUsed, 80_000 / 120, 1e-9, 'the payment is derived from the reduced balance');
  close(result.totalPaidLifetime, 80_000, CENT, 'and only the reduced balance is repaid');
  pass('a one-off overpayment reduces the opening balance before the payment is derived');
}

{
  // An annual overpayment keeps the payment and shortens the term. Both halves
  // matter: a recalculated payment would be a different product.
  const plain = schedule({ currentBalance: 200_000, annualInterestRate: 0.04, remainingTermYears: 25 });
  const overpaid = schedule({
    currentBalance: 200_000, annualInterestRate: 0.04, remainingTermYears: 25, annualOverpayment: 5_000
  });
  close(overpaid.monthlyPaymentUsed, plain.monthlyPaymentUsed, 1e-9, 'the monthly payment is unchanged');
  assert.ok(overpaid.monthsSimulated < plain.monthsSimulated, 'the term shortens');
  assert.ok(overpaid.totalInterestLifetime < plain.totalInterestLifetime, 'and less interest is paid');
  const overpaidMonths = overpaid.monthlySchedule.filter((month) => month.annualOverpaymentApplied > 0);
  assert.ok(overpaidMonths.length > 0);
  assert.ok(
    overpaidMonths.every((month) => month.dateIso.slice(5, 7) === '12' || month.monthIndex === overpaid.monthsSimulated - 1),
    'overpayments land at calendar year-ends'
  );
  close(
    overpaid.totalPaidLifetime,
    overpaid.totalInterestLifetime + overpaid.openingBalance,
    CENT,
    'the identity still holds with overpayments'
  );
  pass('an annual overpayment shortens the term at an unchanged payment, and the identity holds');
}

{
  // Inputs the engine must refuse outright rather than model.
  const refusals = [
    [{ currentBalance: 0, annualInterestRate: 0.04, remainingTermYears: 10 }, /currentBalance must be greater than 0/],
    [{ currentBalance: -1, annualInterestRate: 0.04, remainingTermYears: 10 }, /currentBalance must be greater than 0/],
    [{ currentBalance: 100_000, annualInterestRate: -0.01, remainingTermYears: 10 }, /annualInterestRate must be greater than or equal to 0/],
    [{ currentBalance: 100_000, annualInterestRate: 0.04, remainingTermYears: 0 }, /remainingTermYears must be greater than 0/],
    [{ currentBalance: 100_000, annualInterestRate: 0.04 }, /must include endDateIso or remainingTermYears/],
    [{ currentBalance: 100_000, annualInterestRate: 0.04, remainingTermYears: 10, repaymentType: 'interestOnly' }, /Interest-only/]
  ];
  for (const [patch, pattern] of refusals) {
    assert.throws(() => schedule(patch), pattern, `refused: ${JSON.stringify(patch)}`);
  }
  pass('a zero or negative balance, a negative rate, a missing term and interest-only are all refused');
}

{
  // The rate convention is nominal — the annual rate divided by twelve — and
  // the payment function and the schedule must not disagree about it.
  const balance = 150_000;
  const rate = 0.05;
  const months = 240;
  const standalone = computeMonthlyPayment(balance, rate, months);
  const result = schedule({ currentBalance: balance, annualInterestRate: rate, remainingTermYears: 20 });
  close(standalone, result.monthlyPaymentUsed, 1e-9, 'one payment formula, used consistently');
  assert.equal(result.monthlyRate, rate / 12, 'the schedule uses the nominal monthly rate');
  close(result.monthlySchedule[0].interestPaid, balance * rate / 12, 1e-9, 'and charges it on the opening balance');
  // Stated explicitly so a future switch to a geometric conversion is a
  // deliberate, visible change rather than a silent drift.
  assert.notEqual(result.monthlyRate, Math.pow(1 + rate, 1 / 12) - 1, 'not an effective-rate conversion');
  pass('the nominal annual/12 rate convention is used consistently by the formula and the schedule');
}

/* ----------------------------------- module routing over the shared engine */

const profileOf = (liabilities, values = {}) => normalizeHouseholdProfile({
  ...createHouseholdProfile({ profileId: 'mort', nowIso: NOW, calculationDateIso: TODAY }),
  primaryPerson: { personId: 'primary', role: 'primary', employmentStatus: 'employee', age: 44 },
  liabilities,
  expenses: { monthlyEssential: EUR(2_000) },
  assumptions: { calculationDateIso: TODAY, values }
});

const debt = (liabilityId, type, balance, rate, months, ownerIds = ['primary']) => ({
  liabilityId, ownerIds, type, label: `${type} ${liabilityId}`,
  currentBalance: EUR(balance), annualInterestRate: rate, remainingTermMonths: months
});

{
  // Mapping: the rate stays a fraction, the term converts months to years, and
  // each module stamps its own kind.
  const mortgage = buildMortgageInput(profileOf([debt('m1', 'mortgage', 280_000, 0.039, 324)]));
  assert.equal(mortgage.currentBalance, 280_000);
  assert.equal(mortgage.annualInterestRate, 0.039, 'the rate is not rescaled');
  assert.equal(mortgage.remainingTermYears, 27, '324 months is 27 years');
  assert.equal(mortgage.loanKind, 'mortgage');
  assert.doesNotThrow(() => validateMortgageInput(mortgage));

  const loan = buildLoanInput(profileOf([debt('l1', 'loan', 15_000, 0.079, 60)]));
  assert.equal(loan.remainingTermYears, 5, '60 months is 5 years');
  assert.equal(loan.loanKind, 'loan');
  assert.doesNotThrow(() => validateLoanInput(loan));
  pass('both modules map balance, rate and term into the shared engine without rescaling');
}

{
  // Type separation. A loan is not a mortgage and neither module may borrow
  // the other's liability.
  const loanOnly = profileOf([debt('l1', 'loan', 15_000, 0.079, 60)]);
  assert.equal(getMortgageReadiness(loanOnly).status, 'not_relevant', 'a loan does not make mortgage analysis relevant');
  assert.equal(getLoanReadiness(loanOnly).status, 'ready_with_assumptions');

  const mortgageOnly = profileOf([debt('m1', 'mortgage', 280_000, 0.039, 324)]);
  assert.equal(getLoanReadiness(mortgageOnly).status, 'not_relevant');
  assert.equal(getMortgageReadiness(mortgageOnly).status, 'ready_with_assumptions');
  pass('a loan never reaches mortgage analysis and a mortgage never reaches loan analysis');
}

/* ------------------------------------------- which liability, and who decided */

{
  // ONE CANDIDATE NEEDS NO QUESTION.
  const single = profileOf([debt('m1', 'mortgage', 280_000, 0.039, 324)]);
  assert.equal(getMortgageReadiness(single).status, 'ready_with_assumptions');
  assert.equal(buildMortgageInput(single).currentBalance, 280_000);
  assert.ok(
    !getMortgageReadiness(single).assumptionsUsed.some((item) => item.key === 'analysedMortgage'),
    'and nothing is claimed about a choice that was never needed'
  );
  // A stale selection id pointing at nothing still resolves to the only
  // mortgage there is, because there is no ambiguity to resolve.
  const stale = profileOf([debt('m1', 'mortgage', 280_000, 0.039, 324)], { mortgage: { liabilityId: 'gone' } });
  assert.equal(buildMortgageInput(stale).currentBalance, 280_000);
  pass('one eligible mortgage proceeds without an unnecessary question');
}

{
  // SEVERAL CANDIDATES AND NO CHOICE IS A QUESTION, NOT A TIE-BREAK.
  const two = [debt('m1', 'mortgage', 280_000, 0.039, 324), debt('m2', 'mortgage', 95_000, 0.052, 120)];
  const readiness = getMortgageReadiness(profileOf(two));
  assert.equal(readiness.status, 'missing_information', 'the module stays unready');
  const need = readiness.requiredMissing.find(
    (item) => item.fieldPath === '/assumptions/values/mortgage/liabilityId'
  );
  assert.ok(need, 'and surfaces the need that makes the conversation ask');
  assert.match(need.reason, /Which mortgage/);
  assert.match(need.reason, /mortgage m1/);
  assert.match(need.reason, /mortgage m2/, 'naming both so the client can answer');
  assert.throws(
    () => buildMortgageInput(profileOf(two)),
    /none has been chosen/,
    'and a direct caller cannot resolve it either'
  );
  pass('two mortgages with no stated choice keep the module unready and ask which');
}

{
  // ORDER CANNOT DECIDE. This is the property the old first-match fallback
  // violated: reordering the collection changed which mortgage was analysed.
  const forward = [debt('m1', 'mortgage', 280_000, 0.039, 324), debt('m2', 'mortgage', 95_000, 0.052, 120)];
  const reversed = [debt('m2', 'mortgage', 95_000, 0.052, 120), debt('m1', 'mortgage', 280_000, 0.039, 324)];

  assert.equal(getMortgageReadiness(profileOf(forward)).status, 'missing_information');
  assert.equal(
    getMortgageReadiness(profileOf(reversed)).status,
    'missing_information',
    'undecided either way round'
  );

  // And once chosen, the same mortgage is analysed whichever order it sits in.
  const chosen = { mortgage: { liabilityId: 'm2' } };
  assert.equal(buildMortgageInput(profileOf(forward, chosen)).currentBalance, 95_000);
  assert.equal(
    buildMortgageInput(profileOf(reversed, chosen)).currentBalance,
    95_000,
    'selection follows the stable liability id, never the array position'
  );
  const declared = getMortgageReadiness(profileOf(reversed, chosen))
    .assumptionsUsed.find((item) => item.key === 'analysedMortgage');
  assert.ok(declared, 'the chosen mortgage is named in the output');
  assert.match(declared.value, /m2/);
  pass('array order cannot determine which mortgage is analysed, chosen or not');
}

{
  // A selection naming a mortgage that is not there does not silently fall
  // back to another one.
  const two = [debt('m1', 'mortgage', 280_000, 0.039, 324), debt('m2', 'mortgage', 95_000, 0.052, 120)];
  const stale = profileOf(two, { mortgage: { liabilityId: 'sold-last-year' } });
  assert.equal(getMortgageReadiness(stale).status, 'missing_information');
  assert.throws(() => buildMortgageInput(stale), /none has been chosen/);
  pass('a stale selection id re-asks rather than quietly analysing a different mortgage');
}

{
  // THE SAME RULE FOR LOANS, and the two kinds stay separate while it applies.
  const twoLoans = [debt('l1', 'loan', 15_000, 0.079, 60), debt('l2', 'loan', 4_000, 0.099, 24)];
  assert.equal(getLoanReadiness(profileOf(twoLoans)).status, 'missing_information');
  assert.throws(() => buildLoanInput(profileOf(twoLoans)), /none has been chosen/);
  assert.equal(
    buildLoanInput(profileOf([...twoLoans].reverse(), { loan: { liabilityId: 'l2' } })).currentBalance,
    4_000,
    'and the chosen loan wins regardless of order'
  );
  assert.equal(
    getMortgageReadiness(profileOf(twoLoans)).status,
    'not_relevant',
    'two car loans never make mortgage analysis relevant'
  );

  // An undecided pair of mortgages must not block the loan, or vice versa.
  const mixed = profileOf([
    debt('m1', 'mortgage', 280_000, 0.039, 324),
    debt('m2', 'mortgage', 95_000, 0.052, 120),
    debt('l1', 'loan', 15_000, 0.079, 60)
  ]);
  assert.equal(getMortgageReadiness(mixed).status, 'missing_information', 'the mortgages are still undecided');
  assert.equal(getLoanReadiness(mixed).status, 'ready_with_assumptions', 'the single loan is not');
  assert.equal(buildLoanInput(mixed).currentBalance, 15_000, 'and it is the car loan, not a mortgage');
  pass('loans follow the same rule, and an undecided mortgage never blocks the loan');
}

{
  // Ownership: a jointly owned mortgage is one debt at its full balance.
  const joint = normalizeHouseholdProfile({
    ...profileOf([]),
    partner: { personId: 'partner', role: 'partner', employmentStatus: 'employee', age: 43 },
    liabilities: [debt('m1', 'mortgage', 280_000, 0.039, 324, ['primary', 'partner'])]
  });
  assert.equal(buildMortgageInput(joint).currentBalance, 280_000, 'two owners is not twice the debt');
  pass('a jointly owned mortgage is analysed once, at its full balance');
}

{
  // A direct caller that skipped readiness gets a sentence, not a TypeError.
  const noDebt = profileOf([debt('l1', 'loan', 15_000, 0.079, 60)]);
  assert.throws(
    () => buildMortgageInput(noDebt),
    /holds no mortgage to analyse/,
    'the absence is named rather than dereferenced'
  );
  pass('building an input with no matching liability names what is absent');
}

{
  // End to end through the registry, with the output contract asserted against
  // the independently computed figures.
  const profile = profileOf([debt('m1', 'mortgage', 280_000, 0.039, 324)]);
  const expectedPayment = referencePayment(280_000, 0.039, 324);
  const expected = referenceSchedule(280_000, 0.039, 324, expectedPayment);
  const result = await runPlanningModule('mortgage_analysis', profile, {
    calculationVersion: 'test', calculatedAt: NOW, scenarioOverrides: {}
  });
  assert.equal(result.moduleId, 'mortgage_analysis');
  assert.equal(result.semanticResult.openingBalance, 280_000);
  close(result.semanticResult.monthlyPayment, expectedPayment, 1e-9, 'the module reports the annuity payment');
  close(result.semanticResult.totalInterestLifetime, expected.totalInterest, CENT, 'and the independent interest');
  close(result.semanticResult.totalPaidLifetime, expected.totalPaid, CENT, 'and the independent total');
  // The module dates the schedule from the calculation date, not from January:
  // 324 months from August 2026 ends in July 2053.
  assert.equal(result.semanticResult.payoffYear, 2053);
  pass('mortgage analysis runs end to end and reports the independently computed figures');
}

{
  const profile = profileOf([debt('l1', 'loan', 15_000, 0.079, 60)]);
  const expectedPayment = referencePayment(15_000, 0.079, 60);
  const result = await runPlanningModule('loan_analysis', profile, {
    calculationVersion: 'test', calculatedAt: NOW, scenarioOverrides: {}
  });
  assert.equal(result.moduleId, 'loan_analysis');
  close(result.semanticResult.monthlyPayment, expectedPayment, 1e-9, 'the same engine, the loan module');
  assert.equal(result.semanticResult.payoffYear, 2031, 'sixty months from August 2026 ends in July 2031');
  pass('loan analysis runs end to end over the same proven engine');
}

{
  // A bad assumption reaches the failure taxonomy as an invalid input.
  const profile = profileOf(
    [debt('m1', 'mortgage', 280_000, 0.039, 324)],
    { mortgage: { fixedPaymentAmount: 50 } }
  );
  let error = null;
  try {
    await runPlanningModule('mortgage_analysis', profile, { calculationVersion: 'test', calculatedAt: NOW });
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, 'a payment below the interest fails the run');
  assert.equal(classifyModuleFailure(error), MODULE_FAILURE_CODES.EXECUTION_FAILED,
    'the input passed its contract and the engine refused to model it');
  pass('a payment that cannot amortise fails the run with a classified module failure');
}

console.info('[MortgageAudit] All amortisation engine and routing checks passed.');
