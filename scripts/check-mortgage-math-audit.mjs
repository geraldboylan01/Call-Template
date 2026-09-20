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
  computeMortgageComparison,
  computeMortgageProjection,
  getDefaultMortgageScenarioId,
  getMortgageScenarioCases,
  normalizeMortgageInputs
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

/**
 * The comparison this module exists for: do nothing, overpay regularly, pay a
 * lump sum, or do both. Shared by the case checks and the refusal matrix.
 */
const FOUR_CASE_LOAN = {
  ...BASE,
  currentBalance: 320_000,
  annualInterestRate: 0.0425,
  endDateIso: '2052-12-01',
  loanKind: 'mortgage',
  baseScenarioId: 'current',
  scenarios: [
    { id: 'current', title: 'No overpayment', oneOffOverpayment: 0, annualOverpayment: 0 },
    { id: 'annual-3k', title: '3,000 a year', annualOverpayment: 3_000 },
    { id: 'lump-25k', title: '25,000 lump sum', oneOffOverpayment: 25_000 },
    { id: 'both', title: 'Lump sum and 3,000 a year', oneOffOverpayment: 25_000, annualOverpayment: 3_000 }
  ]
};

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
  // A one-off overpayment reduces the balance the maths starts from, and the
  // CONTRACTUAL payment is held, so the term shortens.
  //
  // This is the same principle the annual-overpayment case below asserts, and
  // it used to be contradicted here: the payment was derived from the reduced
  // balance, which silently took the benefit as cash-flow relief instead. A
  // lump sum then showed no time saved at all, on the same screen as a regular
  // overpayment that did shorten the term -- two overpayments of the same loan,
  // measured on different bases and impossible to compare.
  const result = schedule({
    currentBalance: 100_000, annualInterestRate: 0, remainingTermYears: 10, oneOffOverpayment: 20_000
  });
  assert.equal(result.openingBalance, 80_000);
  close(result.monthlyPaymentUsed, 100_000 / 120, 1e-9, 'the contractual payment is held');
  close(result.totalPaidLifetime, 80_000, CENT, 'and only the reduced balance is repaid');
  assert.equal(result.monthsSimulated, 96, 'at 833.33 a month, 80,000 clears in 96 months, not 120');
  close(result.lumpSumApplied, 20_000, CENT, 'the lump sum is counted as money paid in');
  close(result.totalOverpaid, 20_000, CENT, 'and it is the whole of what was overpaid');
  pass('a one-off overpayment holds the contractual payment and shortens the term');
}

{
  // The other half of the lender's question: keep the term, cut the payment.
  // Taking the benefit this way is a stated choice, never a silent consequence.
  const shorter = schedule({
    currentBalance: 100_000, annualInterestRate: 0, remainingTermYears: 10, oneOffOverpayment: 20_000
  });
  const lower = schedule({
    currentBalance: 100_000,
    annualInterestRate: 0,
    remainingTermYears: 10,
    oneOffOverpayment: 20_000,
    overpaymentBenefit: 'lowerPayment'
  });
  close(lower.monthlyPaymentUsed, 80_000 / 120, 1e-9, 'the payment is re-amortised over the full term');
  assert.equal(lower.monthsSimulated, 120, 'and the term is unchanged');
  assert.ok(
    lower.monthlyPaymentUsed < shorter.monthlyPaymentUsed,
    'the repayment is lower than holding the contractual payment'
  );
  assert.ok(
    lower.monthsSimulated > shorter.monthsSimulated,
    'and it runs longer, which is what the interest saving is traded for'
  );
  pass('overpaymentBenefit lowerPayment keeps the term and re-amortises the payment down');
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
    [{ currentBalance: 100_000, annualInterestRate: 0.04, remainingTermYears: 10, repaymentType: 'interestOnly' }, /Interest-only/],
    [{ ...FOUR_CASE_LOAN, overpaymentBenefit: 'whicheverIsBigger' }, /overpaymentBenefit must be "shorterTerm" or "lowerPayment"/],
    [{ ...FOUR_CASE_LOAN, scenarios: [{ id: 'a', title: 'A' }, { id: 'a', title: 'Also A' }] }, /scenarios\[1\]\.id must be unique/],
    [{ ...FOUR_CASE_LOAN, scenarios: [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, title: `C${n}` })) }, /supports at most 4 cases; received 5/],
    [{ ...FOUR_CASE_LOAN, baseScenarioId: 'not-a-case' }, /baseScenarioId must match a scenario id/],
    [{ ...FOUR_CASE_LOAN, scenarios: [{ id: 'a', title: 'A', endDateIso: '2040-01-01', remainingTermYears: 10 }] }, /at most one of endDateIso or remainingTermYears/],
    [{ ...FOUR_CASE_LOAN, scenarios: [{ id: 'a', title: 'A', annualOverpayment: -1 }] }, /scenarios\[0\]\.annualOverpayment must be greater than or equal to 0/]
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

/* ------------------------------------------- cases, and what each is worth */

/**
 * The reference schedule again, with a year-end overpayment.
 *
 * Written from the same first principles as `referenceSchedule` and kept
 * separate from it, because the engine's comparison figures are the whole
 * point of the module and must not be checked against the engine's own
 * arithmetic. The loan starts in January, so a calendar year-end is every
 * twelfth period.
 */
function referenceScheduleWithAnnual(balance, annualRate, months, payment, annualOverpayment) {
  const i = annualRate / 12;
  let remaining = balance;
  let totalInterest = 0;
  let overpaid = 0;
  let periods = 0;
  while (periods < months && remaining > 0.005) {
    const interest = remaining * i;
    const principal = Math.min(payment - interest, remaining);
    totalInterest += interest;
    remaining -= principal;
    periods += 1;
    if (annualOverpayment > 0 && remaining > 0 && (periods % 12 === 0 || periods === months)) {
      const applied = Math.min(annualOverpayment, remaining);
      remaining -= applied;
      overpaid += applied;
    }
  }
  return {
    periods,
    totalInterest,
    overpaid,
    remaining: remaining <= 0.005 ? 0 : remaining
  };
}

{
  // Every case is measured on ONE basis: the contractual payment. That is what
  // makes a lump sum and a regular overpayment readable side by side, which is
  // the entire reason cases exist.
  const comparison = computeMortgageComparison(FOUR_CASE_LOAN);
  const byId = new Map(comparison.cases.map((item) => [item.id, item]));
  const contractual = referencePayment(320_000, 0.0425, 324);

  assert.equal(comparison.baseScenarioId, 'current');
  assert.equal(comparison.cases.length, 4);
  for (const item of comparison.cases) {
    close(item.monthlyPaymentUsed, contractual, 1e-9, `${item.id} uses the contractual payment`);
  }

  // The base, independently.
  const refBase = referenceSchedule(320_000, 0.0425, 324, contractual);
  close(byId.get('current').totalInterestLifetime, refBase.totalInterest, CENT, 'base interest');
  assert.equal(byId.get('current').monthsSimulated, refBase.periods, 'base term');
  assert.equal(byId.get('current').interestSaved, 0, 'the base saves nothing against itself');
  assert.equal(byId.get('current').savedPerEuroOverpaid, null, 'and has no return to report');
  // Not `close(..., CENT)`: a client who overpaid nothing must report exactly
  // nothing. Subtracting the contractual payment from itself three hundred
  // times leaves a residue, and a residue here would print a "total paid in"
  // for a case that paid in nothing -- and then divide the saving by it.
  assert.equal(byId.get('current').totalOverpaid, 0, 'and paid in nothing at all, not nearly nothing');

  // A lump sum, independently: the balance drops, the payment does not.
  const refLump = referenceSchedule(320_000 - 25_000, 0.0425, 324, contractual);
  const lump = byId.get('lump-25k');
  close(lump.totalInterestLifetime, refLump.totalInterest, CENT, 'lump-sum interest');
  assert.equal(lump.monthsSimulated, refLump.periods, 'lump-sum term');
  assert.ok(lump.monthsSaved > 0, 'a lump sum now finishes the loan earlier');
  close(lump.totalOverpaid, 25_000, CENT, 'the lump sum is what was paid in');
  close(lump.savedPerEuroOverpaid, lump.interestSaved / 25_000, 1e-9, 'the return is interest saved per euro');

  // A regular overpayment, independently.
  const refAnnual = referenceScheduleWithAnnual(320_000, 0.0425, 324, contractual, 3_000);
  const annual = byId.get('annual-3k');
  close(annual.totalInterestLifetime, refAnnual.totalInterest, CENT, 'annual-overpayment interest');
  assert.equal(annual.monthsSimulated, refAnnual.periods, 'annual-overpayment term');
  // Taken from the schedule, not from the inputs: the final year's overpayment
  // is clipped to whatever is left, so multiplying the yearly figure by the
  // number of years would overstate what the client actually paid.
  close(annual.totalOverpaid, refAnnual.overpaid, CENT, 'only the overpayments actually applied are counted');
  assert.ok(
    annual.totalOverpaid < 3_000 * Math.ceil(annual.monthsSimulated / 12),
    'and that is less than the naive years-times-amount figure'
  );

  // Both together beat either alone, and the saving is an identity, not a
  // separately computed number that could drift from the totals on screen.
  const both = byId.get('both');
  assert.ok(both.interestSaved > lump.interestSaved && both.interestSaved > annual.interestSaved);
  for (const item of comparison.cases) {
    close(
      item.interestSaved + item.totalInterestLifetime,
      byId.get('current').totalInterestLifetime,
      CENT,
      `${item.id}: interest saved and interest paid reconstruct the base`
    );
    assert.equal(
      item.monthsSaved,
      byId.get('current').monthsSimulated - item.monthsSimulated,
      `${item.id}: time saved is the difference in term`
    );
  }
  pass('four cases share one contractual payment, and each is worth what an independent schedule says');
}

{
  // A case restates only what it changes. Everything else it inherits, so a
  // correction to the loan itself reaches every case that did not override it.
  const comparison = computeMortgageComparison({
    ...FOUR_CASE_LOAN,
    annualInterestRate: 0.06,
    scenarios: [
      { id: 'current', title: 'No overpayment' },
      { id: 'switch', title: 'Switch to 3.2%', annualInterestRate: 0.032 }
    ]
  });
  const byId = new Map(comparison.cases.map((item) => [item.id, item]));
  close(
    byId.get('current').monthlyPaymentUsed,
    referencePayment(320_000, 0.06, 324),
    1e-9,
    'the inheriting case picks up the corrected rate'
  );
  close(
    byId.get('switch').monthlyPaymentUsed,
    referencePayment(320_000, 0.032, 324),
    1e-9,
    'and the overriding case keeps its own'
  );
  assert.ok(byId.get('switch').interestSaved > 0, 'switching saves interest');
  assert.equal(
    byId.get('switch').savedPerEuroOverpaid,
    null,
    'but no euro was overpaid, so no per-euro figure is claimed'
  );
  pass('a case inherits every fact it does not restate, and a saving with no overpayment reports no return');
}

{
  // The base is whichever case the payload nominates. A household that already
  // overpays should see the next step measured from where they stand.
  const comparison = computeMortgageComparison({ ...FOUR_CASE_LOAN, baseScenarioId: 'annual-3k' });
  assert.equal(comparison.baseScenarioId, 'annual-3k');
  assert.equal(comparison.baseCase.id, 'annual-3k');
  const byId = new Map(comparison.cases.map((item) => [item.id, item]));
  assert.equal(
    getDefaultMortgageScenarioId({ ...FOUR_CASE_LOAN, baseScenarioId: 'annual-3k' }),
    'annual-3k',
    'and the module opens on it, rather than on whichever case was authored first'
  );
  assert.equal(byId.get('annual-3k').interestSaved, 0, 'the nominated base saves nothing against itself');
  assert.ok(
    byId.get('current').interestSaved < 0,
    'and doing less than the base costs interest rather than saving it'
  );
  pass('the nominated base is what every case is measured against, including cases that do worse');
}

{
  // WHEN THE LUMP SUM LANDS IS WORTH MONEY, and the engine has to charge for
  // the wait rather than quietly crediting the client with paying early.
  //
  // Re-simulated here from the formula: the loan runs at its contractual
  // repayment until the chosen month, and only then does the balance drop.
  const lumpMonth = 24;
  const rate = 0.0425 / 12;
  const payment = referencePayment(320_000, 0.0425, 324);
  let balance = 320_000;
  let interest = 0;
  let months = 0;
  while (balance > 0.005 && months < 400) {
    const charged = balance * rate;
    interest += charged;
    balance = balance + charged - payment;
    months += 1;
    if (months === lumpMonth) balance -= 25_000;
    if (balance < 0) balance = 0;
  }

  const deferred = computeAmortizationMonthlySchedule({
    ...BASE,
    currentBalance: 320_000,
    annualInterestRate: 0.0425,
    endDateIso: '2052-12-01',
    oneOffOverpayment: 25_000,
    oneOffOverpaymentMonth: lumpMonth
  });
  assert.equal(deferred.monthsSimulated, months, 'a deferred lump sum clears the loan when the formula says it does');
  assert.ok(
    Math.abs(deferred.totalInterestLifetime - interest) < 0.01,
    'and removes exactly the interest the formula says it removes'
  );
  assert.equal(deferred.lumpSumApplied, 25_000, 'the whole lump sum is still paid in');
  assert.equal(deferred.lumpSumMonth, lumpMonth);
  assert.equal(deferred.openingBalance, 320_000, 'and money not yet paid does not reduce the opening balance');

  const immediate = computeAmortizationMonthlySchedule({
    ...BASE,
    currentBalance: 320_000,
    annualInterestRate: 0.0425,
    endDateIso: '2052-12-01',
    oneOffOverpayment: 25_000
  });
  assert.ok(
    deferred.totalInterestLifetime > immediate.totalInterestLifetime,
    'waiting two years costs interest that paying now would have removed'
  );
  assert.equal(immediate.lumpSumMonth, 0, 'and the default is still that it is already paid');
  assert.equal(
    immediate.monthsSimulated,
    computeAmortizationMonthlySchedule({
      ...BASE,
      currentBalance: 320_000,
      annualInterestRate: 0.0425,
      endDateIso: '2052-12-01',
      oneOffOverpayment: 25_000,
      oneOffOverpaymentMonth: 0
    }).monthsSimulated,
    'stating month 0 explicitly is the same loan'
  );

  // The timing control moves the lump in EVERY case at once. Two cases on one
  // screen answering "when would you pay it" differently is the defect.
  const moved = computeMortgageComparison(FOUR_CASE_LOAN, { oneOffOverpaymentMonth: lumpMonth });
  for (const item of moved.cases) {
    assert.equal(item.projection.lumpSumMonth, lumpMonth, `${item.id} moved with the rest`);
  }
  const atZero = computeMortgageComparison(FOUR_CASE_LOAN);
  assert.ok(
    moved.cases.find((item) => item.id === 'lump-25k').interestSaved
      < atZero.cases.find((item) => item.id === 'lump-25k').interestSaved,
    'and deferring removes less interest'
  );
  assert.equal(
    moved.cases.find((item) => item.id === 'annual-3k').totalInterestLifetime,
    atZero.cases.find((item) => item.id === 'annual-3k').totalInterestLifetime,
    'while a case with no lump sum is untouched by the timing'
  );
  pass('a lump sum can be paid later, it costs interest to wait, and the timing moves every case together');
}

{
  // KEEP THE TERM AND LOWER THE REPAYMENT: the same money, the other answer.
  const comparison = computeMortgageComparison(FOUR_CASE_LOAN);
  const reduction = comparison.repaymentReduction;
  assert.ok(reduction, 'a case set with a lump sum offers the alternative');
  assert.equal(reduction.lumpSum, 25_000, 'modelled from the largest lump sum on the table');

  // From the formula: the payment that amortises the post-lump balance over
  // the full remaining term.
  const expectedPayment = referencePayment(320_000 - 25_000, 0.0425, 324);
  assert.ok(
    Math.abs(reduction.newPayment - expectedPayment) < 0.01,
    'the recalculated repayment is the annuity payment on the smaller balance'
  );
  assert.equal(
    reduction.projection.monthsSimulated,
    324,
    'the term does not move'
  );
  assert.ok(reduction.monthlyReduction > 0, 'and the repayment falls');
  assert.ok(
    Math.abs(reduction.freedOverRemainingTerm - (reduction.monthlyReduction * 324)) < 0.01,
    'what is freed is the monthly drop over every month it applies to'
  );

  // THE TRADE, STATED HONESTLY. Cash flow now costs interest later, and the
  // module says so beside the figure that looks like a saving.
  assert.ok(reduction.interestSavedVsBase > 0, 'it still removes interest against doing nothing');
  assert.ok(
    reduction.extraInterestVsShorterTerm > 0,
    'but it costs more interest than the same lump sum spent on shortening the term'
  );
  // Measured against the case that put in the SAME lump sum and nothing else,
  // so the only difference between the two is what the lender did with it.
  assert.equal(reduction.shorterTermCaseId, 'lump-25k', 'measured against the same lump sum, spent the other way');
  assert.ok(
    reduction.extraInterestVsShorterTerm
      === reduction.totalInterestLifetime
        - comparison.cases.find((item) => item.id === 'lump-25k').totalInterestLifetime,
    'and the two figures come from the same pair of schedules'
  );

  // A yearly amount cannot be re-amortised into a lower repayment.
  const noLump = computeMortgageComparison({
    ...FOUR_CASE_LOAN,
    scenarios: [
      { id: 'current', title: 'No overpayment' },
      { id: 'annual-3k', title: '3,000 a year', annualOverpayment: 3_000 }
    ]
  });
  assert.equal(noLump.repaymentReduction, null, 'and a case set without one does not invent the decision');
  pass('keeping the term lowers the repayment, and the module can price what that costs in interest');
}

{
  // A DEBT CLEARED OUTRIGHT IS CLEARED, NOT UNREPAID.
  //
  // A lump sum that settles the whole balance leaves the schedule empty, and
  // an empty schedule used to read as "never repaid": the same table row said
  // the case saved nine years AND that the mortgage was not repaid within its
  // term. Clearing a mortgage is the most complete version of the thing this
  // module exists to show, so it cannot be the one case it reports backwards.
  const shared = {
    ...BASE,
    currentBalance: 90_000,
    annualInterestRate: 0.0235,
    remainingTermYears: 9,
    fixedPaymentAmount: 946
  };

  const cleared = computeAmortizationMonthlySchedule({ ...shared, oneOffOverpayment: 90_000 });
  assert.equal(cleared.monthsSimulated, 0, 'nothing is left to amortise');
  assert.equal(cleared.balanceRemaining, 0, 'and nothing is outstanding');
  assert.equal(cleared.payoffDateIso, '2026-01-01', 'so it is cleared in the first month of the schedule');
  assert.equal(cleared.payoffYear, 2026);
  assert.equal(cleared.lumpSumApplied, 90_000, 'the whole lump sum went in');

  // More than the balance still clears it, and still only spends the balance.
  const overshoot = computeAmortizationMonthlySchedule({ ...shared, oneOffOverpayment: 120_000 });
  assert.equal(overshoot.payoffDateIso, '2026-01-01');
  assert.equal(overshoot.lumpSumApplied, 90_000, 'a lump sum cannot pay more than is owed');

  // Deferred, it clears in the month it lands rather than in month one.
  const later = computeAmortizationMonthlySchedule({
    ...shared,
    oneOffOverpayment: 90_000,
    oneOffOverpaymentMonth: 24
  });
  assert.equal(later.payoffDateIso, '2027-12-01', 'the 24th month of a schedule starting January 2026');
  assert.ok(later.totalInterestLifetime > 0, 'and two years of interest were charged before it landed');

  // A loan that genuinely is not repaid still says so.
  const unrepaid = computeAmortizationMonthlySchedule({
    ...shared,
    remainingTermYears: 2,
    fixedPaymentAmount: 946
  });
  assert.equal(unrepaid.payoffDateIso, null, 'a balance left standing has no payoff date');
  assert.ok(unrepaid.balanceRemaining > 0);

  // And the table says the same thing as the figures beside it.
  const table = computeMortgageProjection({
    ...shared,
    baseScenarioId: 'current',
    scenarios: [
      { id: 'current', title: 'Current mortgage' },
      { id: 'clear', title: 'Clear it', oneOffOverpayment: 90_000 }
    ]
  }, { scenarioId: 'clear' }).comparisonTable;
  const clearedRow = table.rows.find((row) => row[0] === 'Clear it');
  assert.equal(clearedRow[1], 'Jan 2026', 'the row reports the month it was cleared');
  assert.ok(!clearedRow.some((cell) => String(cell).includes('Not within')), 'and never calls it unrepaid');
  pass('a lump sum that clears the whole balance reports the month it cleared, not "never repaid"');
}

{
  // A STATED REPAYMENT DOES NOT CANCEL THE LENDER'S CHOICE.
  //
  // `lowerPayment` used to be ignored whenever `fixedPaymentAmount` was set,
  // which is the normal case -- the adviser reads the repayment off the
  // client's statement. The keep-the-term section then reported the repayment
  // unchanged and nothing freed, for every payload that named a repayment.
  const withFixed = {
    ...BASE,
    currentBalance: 100_000,
    annualInterestRate: 0,
    remainingTermYears: 10,
    fixedPaymentAmount: 1_000,
    oneOffOverpayment: 20_000,
    overpaymentBenefit: 'lowerPayment'
  };
  const lowered = computeAmortizationMonthlySchedule(withFixed);
  assert.equal(lowered.contractualPayment, 1_000, 'the stated repayment is what they pay today');
  close(lowered.monthlyPaymentUsed, 80_000 / 120, 1e-9, 'and the lump sum re-amortises it over the full term');
  assert.equal(lowered.monthsSimulated, 120, 'with the term unchanged');

  // Holding the repayment instead still shortens the term, as before.
  const held = computeAmortizationMonthlySchedule({ ...withFixed, overpaymentBenefit: 'shorterTerm' });
  assert.equal(held.monthlyPaymentUsed, 1_000, 'shorterTerm holds the stated repayment');
  assert.ok(held.monthsSimulated < 120, 'and finishes early');
  pass('a stated repayment sets what is paid before the lump sum, not what the lender does after it');
}

{
  // THE KEEP-THE-TERM SECTION NEEDS A TERM LEFT TO KEEP.
  const shared = {
    ...BASE,
    currentBalance: 90_000,
    annualInterestRate: 0.0235,
    remainingTermYears: 9,
    fixedPaymentAmount: 946,
    baseScenarioId: 'current'
  };

  const clearedOutright = computeMortgageComparison({
    ...shared,
    scenarios: [
      { id: 'current', title: 'Current mortgage' },
      { id: 'clear', title: 'Clear it', oneOffOverpayment: 90_000 }
    ]
  });
  assert.equal(
    clearedOutright.repaymentReduction,
    null,
    'a lump sum that clears the balance leaves no repayment to lower'
  );

  const partial = computeMortgageComparison({
    ...shared,
    scenarios: [
      { id: 'current', title: 'Current mortgage' },
      { id: 'part', title: '30,000 lump', oneOffOverpayment: 30_000 }
    ]
  });
  assert.ok(partial.repaymentReduction, 'a partial lump sum still offers the alternative');
  assert.equal(partial.repaymentReduction.contractualPayment, 946, 'measured from what they pay today');
  assert.ok(
    partial.repaymentReduction.monthlyReduction > 0,
    'and the repayment genuinely falls, even though a repayment was stated'
  );
  pass('the keep-the-term section is offered only when there is a repayment left to lower');
}

{
  // A payload with no cases is still one case, so nothing downstream has to
  // special-case the shape.
  const projection = computeMortgageProjection({ ...BASE, currentBalance: 200_000, annualInterestRate: 0.04, remainingTermYears: 25 });
  assert.equal(projection.comparisonTable, null, 'a single case has nothing to compare');
  // The module draws its own balance curve and year-interest columns in SVG,
  // so the focused pane shows no charts card. The payload keeps one chart for
  // the surfaces that render a module without it -- the video summary.
  assert.deepEqual(projection.charts.map((chart) => chart.id), ['mortgage-mixed-annual'], 'and one chart ships for the surfaces with no module');
  const cases = getMortgageScenarioCases({ ...BASE, currentBalance: 200_000, annualInterestRate: 0.04, remainingTermYears: 25 });
  assert.equal(cases.length, 1);
  pass('a payload with no cases behaves exactly as it did before cases existed');
}

{
  // The case buttons preview the outcome, so the comparison is readable before
  // anything is clicked.
  const cases = getMortgageScenarioCases(FOUR_CASE_LOAN);
  assert.deepEqual(cases.map((item) => item.id), ['current', 'annual-3k', 'lump-25k', 'both']);
  assert.match(cases[0].detail, /^Finishes \w{3} \d{4} · €[\d,]+ interest$/, 'the base states what it costs');
  for (const item of cases.slice(1)) {
    assert.match(item.detail, /^Saves €[\d,]+ · .+ earlier$/, `${item.id} states what it saves`);
  }
  const selected = computeMortgageProjection(FOUR_CASE_LOAN, { scenarioId: 'lump-25k' });
  assert.equal(selected.scenarioId, 'lump-25k');
  // ONE ROW PER CASE, in the same order and direction as the buttons above it.
  assert.equal(selected.comparisonTable.columns.length, 7, 'seven measures, read left to right');
  assert.equal(selected.comparisonTable.columns[0], 'Case');
  assert.equal(
    selected.comparisonTable.columns.at(-1),
    'Interest saved per \u20ac1 in',
    'the long label, because the short one reads like a return'
  );
  assert.equal(selected.comparisonTable.rows.length, 4, 'one row per case');
  assert.deepEqual(
    selected.comparisonTable.rows.map((row) => row[0]),
    ['No overpayment', '3,000 a year', '25,000 lump sum', 'Lump sum and 3,000 a year'],
    'in payload order'
  );
  for (const row of selected.comparisonTable.rows) {
    assert.equal(row.length, selected.comparisonTable.columns.length, `row "${row[0]}" matches the column count`);
  }
  // The two comparison charts are gone: they restated the shaded gap of the
  // module's own balance chart in a second unit.
  assert.deepEqual(
    selected.charts.map((chart) => chart.id),
    ['mortgage-mixed-annual'],
    'and a chosen case adds no chart that restates what the module already draws'
  );
  // An unknown case id falls back to the base rather than rendering nothing.
  assert.equal(computeMortgageProjection(FOUR_CASE_LOAN, { scenarioId: 'no-such-case' }).scenarioId, 'current');
  pass('case buttons preview their own outcome, and an unknown case falls back to the base');
}

{
  // NORMALISING IS IDEMPOTENT, and it has to be.
  //
  // An authored case states its changes flat; the normaliser returns them
  // nested under `overrides`; the app stores what the normaliser returned and
  // normalises it again on every render and every session reload. A normaliser
  // that read only the flat form would find nothing the second time and return
  // four cases that all change nothing -- four buttons, four identical answers,
  // and no error raised anywhere to say so.
  const authored = computeMortgageComparison(FOUR_CASE_LOAN).cases.map((item) => Math.round(item.interestSaved));
  assert.ok(authored.some((saved) => saved > 0), 'the fixture saves something to begin with');

  let stored = normalizeMortgageInputs(FOUR_CASE_LOAN);
  for (let round = 0; round < 3; round += 1) {
    stored = normalizeMortgageInputs(stored);
    assert.deepEqual(
      computeMortgageComparison(stored).cases.map((item) => Math.round(item.interestSaved)),
      authored,
      `re-normalising ${round + 1} time(s) still describes the same cases`
    );
  }
  assert.deepEqual(normalizeMortgageInputs(stored), stored, 'and the normalised form is a fixed point');
  pass('normalising a payload twice describes the same cases as normalising it once');
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
