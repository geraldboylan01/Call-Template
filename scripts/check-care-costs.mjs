// Care costs: the engine, proved against an independent reference.
//
// The reference below imports NOTHING from `js/care_costs_math.js`,
// `js/planning/care/fair_deal.js` or the Fair Deal rules catalogue. It rebuilds
// every case year by year from first principles: the steps of Schedule 1 of the
// Act in WEEKS (the engine works in years, which is the same arithmetic, so
// agreement is a real cross-check), the rates typed here from the Act, the
// State Pension rate typed from the Department's pages, and the savings spread
// of "alongside" found by bisection, not by the engine's closed form.
//
// What the reference does share with the engine is the Irish tax engine, which
// has its own suites and golden cases: income tax, USC and PRSI on the person
// and the relief on the payer come from `computeTaxYear`, called here on inputs
// the reference builds itself. The central rates (prices, cash, DIRT) are read
// from the central assumptions, as the future cost fund's check reads them.
//
// The private course cases live in `private/cfp-cases/` on one Mac and never
// enter the repository. They run here only when that folder holds care cases,
// and the check says "not present" otherwise.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeCareCostProjection } from '../js/care_costs_math.js';
import {
  CARE_COUPLE,
  CARE_SAMPLE,
  CARE_TODAY,
  CARE_WEALTHY,
  runCareCostsTests
} from '../js/tests_care_costs_math.js';
import { PLANEIR_ASSUMPTIONS } from '../js/planning/planeir_assumptions.js';
import { computeTaxYear } from '../js/planning/tax/engine.js';
import { DEFAULT_IE_TAX_CATALOGUE, resolveTaxRules } from '../js/planning/tax/resolve.js';

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.info(`[CareCostsAudit] PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[CareCostsAudit] FAIL: ${name}\n    ${error.message}`);
  }
}

/* --------------------------------------------------------------- the reference */

/** Typed from Schedule 1 of the Act (Parts 1A and 2A) on 27 October 2026. */
const ACT = Object.freeze({
  singleShare: 0.8,
  coupleShare: 0.4,
  rentalShare: 0,
  rate: 0.075,
  singleDisregard: 36_000,
  coupleDisregard: 72_000,
  coupleDivisor: 2,
  capYears: 3,
  singleKeeps: 0.2, //   of the State Pension (Non-Contributory), a week
  coupleKeeps: 1.2 //    the rate and 20% of it, a week, partner at home
});

/** Typed from the Department's State Pension (Non-Contributory) page and Budget 2027 table, aged 66 to 79. */
const pensionWeekly = (isoDate) => (isoDate >= '2027-01-01' ? 298 : 288);

function addYears(isoDate, years) {
  return `${Number(isoDate.slice(0, 4)) + years}${isoDate.slice(4)}`;
}

function taxOf(year, status, people, items) {
  const { totals } = computeTaxYear({ input: { year, status, people, items } }).result;
  return totals.incomeTax + totals.usc + totals.prsi;
}

/** Schedule 1, step by step, in weeks. Returns yearly figures. */
function assessInWeeks({ couple, pension, netAnnual, rentAnnual, cash, other, home }) {
  const share = couple ? ACT.coupleShare : ACT.singleShare;
  const threshold = (couple ? ACT.coupleKeeps : ACT.singleKeeps) * pension;
  const netWeekly = netAnnual / 52; //                         the net weekly income step
  const rentWeekly = rentAnnual / 52; //                       eligible rent, after the tax on it
  const kept = ((1 - share) * netWeekly) + ((1 - ACT.rentalShare) * rentWeekly);
  const incomeWeekly = Math.max(0, kept < threshold
    ? (netWeekly + rentWeekly) - threshold //                  the safeguard step
    : (share * netWeekly) + (ACT.rentalShare * rentWeekly)); //  80% (40%) of net, 0% of the rent

  const disregard = couple ? ACT.coupleDisregard : ACT.singleDisregard;
  const split = couple ? ACT.coupleDivisor : 1;
  const cashWeekly = (Math.max(0, cash - disregard) * ACT.rate) / split / 52;
  const unused = Math.max(0, disregard - cash);
  const relevantWeekly = (Math.max(0, other + home - unused) * ACT.rate) / split / 52;
  // The split of the non-cash total: the unused disregard comes off other property first.
  const otherLeft = Math.max(0, other - unused);
  const homeLeft = Math.max(0, home - Math.max(0, unused - other));
  const part = (amount) => (amount * ACT.rate) / split;
  return {
    income: incomeWeekly * 52,
    savings: cashWeekly * 52,
    other: part(otherLeft),
    home: part(homeLeft),
    totalInWeeks: (incomeWeekly + cashWeekly + relevantWeekly) * 52
  };
}

/** The savings paid in year `k` under "alongside": found by bisection so the fund ends at zero. */
function spreadByBisection(opening, years, growth, interest) {
  const closing = (first) => {
    let balance = opening;
    for (let k = 0; k < years; k += 1) {
      balance = (balance - (first * (1 + growth) ** k)) * (1 + interest);
    }
    return balance;
  };
  let low = 0;
  let high = (opening * 2) + 1;
  for (let step = 0; step < 200; step += 1) {
    const middle = (low + high) / 2;
    if (closing(middle) > 0) low = middle; else high = middle;
  }
  const first = (low + high) / 2;
  return Array.from({ length: years }, (_unused, k) => first * (1 + growth) ** k);
}

function reference(payload, { today, flatRelief = null, noPrivateAllowance = false, rates = null }) {
  const calcYear = Number(today.slice(0, 4));
  const central = PLANEIR_ASSUMPTIONS;
  const general = rates?.general ?? central.inflation.generalRate;
  const feeGrowth = rates?.fee ?? central.inflation.educationRate;
  const cashNet = (rates?.cash ?? central.cash.instantAccessGrossRate) * (1 - (rates?.dirt ?? resolveTaxRules(calcYear).dirt.rate));
  const prices = central.care.agreedPrices;
  const weeklyFee = payload.weeklyFee
    ?? (payload.county ? prices.countyWeeklyAverages[payload.county].average : prices.nationalWeeklyAverage);
  const years = payload.durationYears ?? 5;
  const t0 = payload.startsInYears;
  const couple = Boolean(payload.couple);
  const pension = pensionWeekly(addYears(today, t0));
  const home0 = payload.home ? Math.max(0, (payload.home.value * (1 + general) ** t0) - (payload.home.borrowings ?? 0)) : 0;
  const other0 = (payload.otherProperty ?? []).reduce(
    (total, property) => total + Math.max(0, (property.value * (1 + general) ** t0) - (property.borrowings ?? 0)),
    0
  ) + (payload.transferredInLastFiveYears?.nonCash ?? 0);
  const transferredCash = payload.transferredInLastFiveYears?.cash ?? 0;

  const personTax = (t, includeHomeRent) => {
    const g = (1 + general) ** t;
    const people = [{ id: 'p', age: Math.min(payload.age + t, 150) }];
    const items = payload.incomes.map((income) => ({ personId: 'p', type: income.type, amount: income.grossAnnual * g }));
    (payload.otherProperty ?? []).forEach((property) => {
      if ((property.rentAnnual ?? 0) > 0) items.push({ personId: 'p', type: 'rentalProfit', amount: property.rentAnnual * g });
    });
    if (couple) {
      people.push({ id: 'q', age: Math.min(payload.age + t, 150) });
      payload.couple.partnerIncomes.forEach((income) => items.push({ personId: 'q', type: income.type, amount: income.grossAnnual * g }));
    }
    if (includeHomeRent && payload.homeRent) items.push({ personId: 'p', type: 'rentalProfit', amount: payload.homeRent.annual * g });
    return taxOf(calcYear + t, couple ? 'married_or_civil_partners' : 'single', people, items);
  };
  const grossOf = (t) => {
    const sum = (list) => list.reduce((total, income) => total + income.grossAnnual, 0);
    return (sum(payload.incomes) + (couple ? sum(payload.couple.partnerIncomes) : 0)
      + (payload.otherProperty ?? []).reduce((total, property) => total + (property.rentAnnual ?? 0), 0)) * (1 + general) ** t;
  };
  const payerTax = (t, expense) => {
    const g = (1 + general) ** t;
    const items = payload.payer.people.flatMap((person) => {
      const retired = person.retiresInYears !== undefined && t >= person.retiresInYears;
      return (retired ? person.incomesAfterRetirement : person.incomes)
        .map((income) => ({ personId: person.id, type: income.type, amount: income.grossAnnual * g }));
    });
    if (expense > 0) items.push({ personId: payload.payer.people[0].id, type: 'nursingHomeExpenses', amount: expense });
    return taxOf(calcYear + t, payload.payer.taxStatus,
      payload.payer.people.map((person) => ({ id: person.id, age: Math.min(person.age + t, 150) })), items);
  };

  return payload.scenarios.map((scenario) => {
    const basis = scenario.basis ?? 'lower_of';
    const openingSavings = payload.cash * (1 + cashNet) ** t0;
    const spread = scenario.personMoney === 'alongside' ? spreadByBisection(openingSavings, years, feeGrowth, cashNet) : null;
    let savings = openingSavings;
    const rows = [];
    for (let k = 0; k < years; k += 1) {
      const t = t0 + k;
      const fee = weeklyFee * 52 * (1 + feeGrowth) ** t;
      const extras = (payload.weeklyExtras ?? 0) * 52 * (1 + feeGrowth) ** t;
      const withRent = payload.homeRent ? personTax(t, true) : null;
      const withoutRent = personTax(t, false);
      const rentGross = payload.homeRent ? payload.homeRent.annual * (1 + general) ** t : 0;
      const exempt = Boolean(payload.homeRent) && payload.homeRent.exemptionApplied !== false;
      const deductions = (payload.otherDeductions ?? 0) * (1 + general) ** t;
      const netAnnual = Math.max(0, exempt || !payload.homeRent
        ? grossOf(t) - withoutRent - deductions
        : grossOf(t) + rentGross - withRent - deductions);
      const rentAnnual = exempt ? Math.max(0, rentGross - (withRent - withoutRent)) : 0;
      const homeCounts = (payload.yearsInCareSoFar ?? 0) + k < ACT.capYears;
      const a = assessInWeeks({
        couple, pension, netAnnual, rentAnnual,
        cash: savings + transferredCash, other: other0, home: homeCounts ? home0 : 0
      });
      const assessed = a.income + a.savings + a.other + a.home;
      assert.ok(Math.abs(assessed - a.totalInWeeks) < 1e-6, 'the parts add up to the whole, worked in weeks');

      const fairDeal = basis !== 'private_fee' && assessed < fee;
      const contribution = fairDeal ? assessed : fee;
      const deferred = fairDeal && basis === 'fair_deal_with_loan' ? a.home : 0;
      const due = contribution + extras - deferred;
      const incomeAvailable = !fairDeal && noPrivateAllowance ? netAnnual + rentAnnual : a.income;
      const fromIncome = Math.min(incomeAvailable, due);
      const remaining = due - fromIncome;
      let wanted = 0;
      if (scenario.personMoney === 'first') wanted = remaining;
      if (scenario.personMoney === 'alongside') wanted = Math.min(spread[k], remaining);
      const fromSavings = Math.min(savings, wanted);
      const family = remaining - fromSavings;
      const nursing = Math.max(0, family - extras);
      const taxBefore = nursing > 0 && flatRelief === null ? payerTax(t, 0) : 0;
      const relief = flatRelief === null
        ? (nursing > 0 ? Math.max(0, taxBefore - payerTax(t, nursing)) : 0)
        : nursing * flatRelief;
      rows.push({
        fee, extras, fairDeal, assessed, contribution, income: a.income, savings: a.savings, other: a.other, home: a.home,
        deferred, hse: fairDeal ? fee - assessed : 0, due, fromIncome, fromSavings, family, relief, after: family - relief,
        savingsEnd: (savings - fromSavings) * (1 + cashNet), taxBefore
      });
      savings = (savings - fromSavings) * (1 + cashNet);
    }
    const loanToday = rows.reduce((total, row, k) => total + (row.deferred / (1 + general) ** (t0 + k)), 0);
    const loanEnd = rows.reduce((total, row, k) => total + (row.deferred * (1 + general) ** (years - k)), 0);
    return { rows, loanToday, loanEnd, home0 };
  });
}

/* --------------------------------------------------------------- the fixtures */

const SINGLE = (income) => ({ taxStatus: 'single', people: [{ id: 'you', age: 52, incomes: [{ type: 'employment', grossAnnual: income }] }] });
const FOUR = CARE_SAMPLE.scenarios;
const THREE_WAYS = [
  { id: 'first', personMoney: 'first', familyFunding: 'each_year' },
  { id: 'alongside', personMoney: 'alongside', familyFunding: 'each_year' },
  { id: 'kept', personMoney: 'kept', familyFunding: 'each_year' }
];
const NO_DIRT = (() => {
  const block = DEFAULT_IE_TAX_CATALOGUE.rulesByYear[2026];
  return {
    ...DEFAULT_IE_TAX_CATALOGUE,
    rulesByYear: { ...DEFAULT_IE_TAX_CATALOGUE.rulesByYear, 2026: { ...block, dirt: { ...block.dirt, rate: 0 } } }
  };
})();

const noDefaults = (() => {
  const bare = { ...CARE_SAMPLE };
  delete bare.weeklyFee;
  delete bare.county;
  return bare;
})();

const FIXTURES = [
  ['the worked example, four cases', CARE_SAMPLE, {}],
  ['a wealthy single person: private years 1 to 3, Fair Deal from year 4', CARE_WEALTHY, {}],
  ['three years already in care: nothing on the home', { ...CARE_SAMPLE, yearsInCareSoFar: 3 }, {}],
  ['two years already in care: one year of the home left', { ...CARE_SAMPLE, yearsInCareSoFar: 2 }, {}],
  ['a couple, the retained-income threshold binds', CARE_COUPLE, {}],
  ['a couple on higher incomes, with a home', {
    ...CARE_COUPLE, age: 78, durationYears: 6, cash: 150_000, home: { value: 400_000, borrowings: 50_000 },
    incomes: [{ type: 'occupationalPension', grossAnnual: 30_000 }, { type: 'statePension', grossAnnual: 15_000 }],
    couple: { partnerIncomes: [{ type: 'occupationalPension', grossAnnual: 25_000 }] },
    scenarios: [...THREE_WAYS, { id: 'loan', basis: 'fair_deal_with_loan', personMoney: 'first', familyFunding: 'each_year' }]
  }, {}],
  ['income below the State pension', {
    ...CARE_SAMPLE, incomes: [{ type: 'statePension', grossAnnual: 9_000 }], cash: 20_000, home: undefined,
    scenarios: [FOUR[0], FOUR[1], FOUR[3]]
  }, {}],
  ['transferred assets and other property with rent', {
    ...CARE_SAMPLE, cash: 30_000, home: undefined, scenarios: THREE_WAYS,
    otherProperty: [{ label: 'The flat', value: 250_000, borrowings: 60_000, rentAnnual: 9_000 }],
    transferredInLastFiveYears: { cash: 100_000, nonCash: 40_000 }, otherDeductions: 1_200
  }, {}],
  ['rent from the home, not charged', {
    ...CARE_SAMPLE, incomes: [{ type: 'statePension', grossAnnual: 9_000 }], homeRent: { annual: 8_000 }, cash: 50_000,
    scenarios: [FOUR[0], FOUR[2]]
  }, {}],
  ['rent from the home with tax to pay on it', {
    ...CARE_SAMPLE, incomes: [{ type: 'occupationalPension', grossAnnual: 30_000 }, { type: 'statePension', grossAnnual: 15_600 }],
    homeRent: { annual: 14_400 }, cash: 60_000, scenarios: [FOUR[0], FOUR[3]]
  }, {}],
  ['rent from the home, no exemption applied', {
    ...CARE_SAMPLE, incomes: [{ type: 'occupationalPension', grossAnnual: 22_000 }],
    homeRent: { annual: 12_000, exemptionApplied: false }, scenarios: [FOUR[0], FOUR[3]]
  }, {}],
  ['care starting in three years, extras, a county fee, eight years, a joint payer who retires', {
    personLabel: 'Mam', age: 76, county: 'Dublin', weeklyExtras: 45, startsInYears: 3, durationYears: 8,
    incomes: [{ type: 'statePension', grossAnnual: 15_600 }, { type: 'occupationalPension', grossAnnual: 9_000 }],
    cash: 140_000, home: { value: 500_000, borrowings: 0 },
    payer: {
      taxStatus: 'married_or_civil_partners',
      people: [
        { id: 'a', age: 49, incomes: [{ type: 'employment', grossAnnual: 70_000 }], retiresInYears: 6, incomesAfterRetirement: [{ type: 'occupationalPension', grossAnnual: 25_000 }] },
        { id: 'b', age: 47, incomes: [{ type: 'employment', grossAnnual: 38_000 }], retiresInYears: 8, incomesAfterRetirement: [{ type: 'statePension', grossAnnual: 15_000 }] }
      ]
    },
    scenarios: [...THREE_WAYS, { id: 'loan', basis: 'fair_deal_with_loan', personMoney: 'alongside', familyFunding: 'save_then_pay' }]
  }, {}],
  ['the default length and fee: no duration, no county', noDefaults, {}],
  ['a standard-rate payer', { ...CARE_SAMPLE, payer: SINGLE(40_000), scenarios: [FOUR[1], FOUR[3]] }, {}],
  ['a payer straddling the bands', { ...CARE_SAMPLE, payer: SINGLE(46_000), scenarios: [FOUR[1], FOUR[3]] }, {}],
  ['a payer with no income tax', { ...CARE_SAMPLE, payer: SINGLE(10_000), scenarios: [FOUR[1], FOUR[3]] }, {}],
  ['dates either side of 1 January 2027', CARE_COUPLE, { today: '2027-01-01' }],
  ['care that starts after the new State Pension rate', { ...CARE_COUPLE, startsInYears: 2 }, {}],
  ['the course’s conventions: a flat 40% relief and no allowance in a private year',
    { ...CARE_SAMPLE, scenarios: [FOUR[1], FOUR[3]] }, { flatReliefRate: 0.4, privateAllowance: 'none' }],
  ['injected rates: prices 3%, cash 2% with no DIRT', { ...CARE_SAMPLE, scenarios: [FOUR[1], FOUR[3]] }, {
    assumptions: { ...PLANEIR_ASSUMPTIONS, inflation: { generalRate: 0.03, educationRate: 0.03 }, cash: { instantAccessGrossRate: 0.02 } },
    taxCatalogue: NO_DIRT
  }]
];

/* ------------------------------------------------------------------ the checks */

const CLOSE = 0.01;

function checkInvariants(engineCase, want, tag) {
  let assessedHome = 0;
  engineCase.rows.forEach((row, k) => {
    const at = `${tag}, year ${row.yearInCare}`;
    if (engineCase.basis !== 'private_fee') {
      assert.ok(row.due <= row.fee + row.extras + CLOSE, `${at}: what is due is never more than the private fee plus extras`);
    }
    assert.ok(row.savingsAtStart >= -CLOSE && row.savingsAtEnd >= -CLOSE, `${at}: savings never go below zero`);
    assert.ok(row.hsePays >= -CLOSE && row.familyBeforeRelief >= -CLOSE, `${at}: nothing is negative`);
    assert.ok(row.relief <= row.nursingHomePart + CLOSE, `${at}: relief is never more than the fees relieved`);
    if (want.rows[k].taxBefore > 0) {
      assert.ok(row.relief <= want.rows[k].taxBefore + CLOSE, `${at}: relief never exceeds the tax the payer would otherwise pay`);
    }
    if (row.fairDealApplies) {
      assert.ok(Math.abs((row.fee + row.extras) - (row.hsePays + row.contribution + row.extras)) <= CLOSE,
        `${at}: fee + extras = HSE share + contribution + extras`);
    } else {
      assert.equal(row.hsePays, 0, `${at}: in a private year the HSE share is 0`);
      assert.ok(Math.abs(row.contribution - row.fee) <= CLOSE, `${at}: and the contribution is the fee`);
    }
    assert.ok(Math.abs(row.due - (row.contribution + row.extras - row.deferredToLoan)) <= CLOSE,
      `${at}: due = contribution + extras - any home part deferred to the loan`);
    assert.ok(Math.abs(row.due - (row.fromIncome + row.fromSavings + row.familyBeforeRelief)) <= CLOSE,
      `${at}: due = income used + savings used + family share`);
    assert.ok(row.homePart === 0 || row.yearInCare <= 3, `${at}: the home part appears only in the first three years from entering care`);
    assessedHome += row.homePart;
  });
  assert.ok(assessedHome <= (0.225 * want.home0) + CLOSE, `${tag}: the home part never exceeds 22.5% of the home`);
}

function compareToReference(name, payload, options) {
  const today = options.today ?? CARE_TODAY;
  const engineOptions = { today };
  const referenceOptions = { today };
  if (options.flatReliefRate !== undefined) {
    engineOptions.flatReliefRate = options.flatReliefRate;
    referenceOptions.flatRelief = options.flatReliefRate;
  }
  if (options.privateAllowance === 'none') {
    engineOptions.privateAllowance = 'none';
    referenceOptions.noPrivateAllowance = true;
  }
  if (options.assumptions) {
    engineOptions.assumptions = options.assumptions;
    engineOptions.taxCatalogue = options.taxCatalogue;
    referenceOptions.rates = { general: 0.03, fee: 0.03, cash: 0.02, dirt: 0 };
  }

  const engine = computeCareCostProjection(payload, engineOptions);
  const expected = reference(payload, referenceOptions);
  assert.equal(engine.debug.cases.length, expected.length, `${name}: the same number of cases`);

  engine.debug.cases.forEach((engineCase, caseIndex) => {
    const want = expected[caseIndex];
    const tag = `${name} / ${engineCase.id}`;
    assert.equal(engineCase.rows.length, want.rows.length, `${tag}: nothing is due after the last year, and every year is there`);
    engineCase.rows.forEach((row, k) => {
      const ref = want.rows[k];
      const at = `${tag}, year ${row.yearInCare}`;
      [
        ['fee', row.fee, ref.fee], ['extras', row.extras, ref.extras], ['assessed contribution', row.assessedContribution, ref.assessed],
        ['income part', row.incomePart, ref.income], ['savings part', row.savingsPart, ref.savings],
        ['other property part', row.otherPropertyPart, ref.other], ['home part', row.homePart, ref.home],
        ['contribution', row.contribution, ref.contribution], ['HSE share', row.hsePays, ref.hse],
        ['deferred to the loan', row.deferredToLoan, ref.deferred], ['due', row.due, ref.due],
        ['paid from income', row.fromIncome, ref.fromIncome], ['paid from savings', row.fromSavings, ref.fromSavings],
        ['family before relief', row.familyBeforeRelief, ref.family], ['relief', row.relief, ref.relief],
        ['family after relief', row.familyAfterRelief, ref.after], ['savings at the end', row.savingsAtEnd, ref.savingsEnd]
      ].forEach(([what, got, wanted]) => {
        assert.ok(Math.abs(got - wanted) <= CLOSE, `${at}: ${what} is ${got}, the reference has ${wanted}`);
      });
      assert.equal(row.fairDealApplies, ref.fairDeal, `${at}: whether Fair Deal applies`);
    });
    assert.ok(Math.abs(engineCase.loanTodaysMoney - want.loanToday) <= CLOSE, `${tag}: loan in today's money`);
    assert.ok(Math.abs(engineCase.loanAtEnd - want.loanEnd) <= CLOSE, `${tag}: loan at the end of care`);
    checkInvariants(engineCase, want, tag);
  });
}

for (const [name, payload, options] of FIXTURES) {
  check(`the engine matches the independent reference: ${name}`, () => compareToReference(name, payload, options));
}

check('Fair Deal never costs more than paying privately, including a case that pays privately while the home counts and uses it after', () => {
  const total = (entry) => entry.rows.reduce((sum, row) => sum + row.fromIncome + row.fromSavings + row.familyBeforeRelief, 0);
  const worked = Object.fromEntries(computeCareCostProjection(CARE_SAMPLE, { today: CARE_TODAY }).debug.cases.map((entry) => [entry.id, entry]));
  assert.ok(total(worked.first) <= total(worked.private) + CLOSE);
  const privateWealthy = { id: 'private', basis: 'private_fee', personMoney: 'first', familyFunding: 'each_year' };
  const mixed = computeCareCostProjection(CARE_WEALTHY, { today: CARE_TODAY }).debug.cases[0];
  const throughout = computeCareCostProjection({ ...CARE_WEALTHY, scenarios: [privateWealthy] }, { today: CARE_TODAY }).debug.cases[0];
  assert.ok(total(mixed) <= total(throughout) + CLOSE);
  assert.ok(mixed.rows.slice(3).every((row) => row.fairDealApplies), 'Fair Deal from year four');
});

check('the Act worked in weeks adds up to its parts worked in years, on a table of incomes and assets', () => {
  for (const couple of [false, true]) {
    for (const net of [0, 4_000, 9_000, 15_600, 24_000, 60_000]) {
      for (const rent of [0, 8_000]) {
        for (const cash of [0, 20_000, 50_000, 90_000, 400_000]) {
          for (const [other, home] of [[0, 0], [60_000, 0], [0, 320_000], [40_000, 250_000]]) {
            const a = assessInWeeks({ couple, pension: 288, netAnnual: net, rentAnnual: rent, cash, other, home });
            assert.ok(Math.abs(a.totalInWeeks - (a.income + a.savings + a.other + a.home)) < 1e-6,
              `couple=${couple}, net=${net}, rent=${rent}, cash=${cash}, other=${other}, home=${home}`);
          }
        }
      }
    }
  }
});

const unit = runCareCostsTests();
if (unit.failed > 0) {
  failures += unit.failed;
}

/* ------------------------------------------------- the private course cases */

/**
 * Cases kept in `private/cfp-cases/` as `care-costs-<name>.json`:
 *   { "inputs": <careCostInputs>, "options": { "today", "flatReliefRate", "privateAllowance", "assumptions" },
 *     "expect": { "<caseId>": { "<total>": number, "rows": [{ "<field>": number }] } }, "toleranceEur": number }
 * Any total or row field the engine produces can be named; only those named are compared.
 */
function runPrivateCourseCases(directory, { quiet = false } = {}) {
  if (!existsSync(directory)) {
    return { status: 'not present', files: 0 };
  }
  const files = readdirSync(directory).filter((file) => /^care-costs-.+\.json$/.test(file)).sort();
  for (const file of files) {
    const body = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    const tolerance = body.toleranceEur ?? 0.5;
    const projection = computeCareCostProjection(body.inputs, body.options ?? {});
    for (const [caseId, expect] of Object.entries(body.expect ?? {})) {
      const found = projection.debug.cases.find((entry) => entry.id === caseId);
      assert.ok(found, `${file}: the case ${caseId} exists`);
      for (const [field, value] of Object.entries(expect)) {
        if (field === 'rows') {
          value.forEach((rowExpect, index) => {
            for (const [rowField, rowValue] of Object.entries(rowExpect)) {
              assert.ok(Math.abs(found.rows[index][rowField] - rowValue) <= tolerance,
                `${file} / ${caseId}, row ${index + 1}, ${rowField}: ${found.rows[index][rowField]} against ${rowValue}`);
            }
          });
        } else {
          assert.ok(Math.abs(found[field] - value) <= tolerance, `${file} / ${caseId}, ${field}: ${found[field]} against ${value}`);
        }
      }
    }
    if (!quiet) console.info(`[CareCostsAudit] private course case ${file}: matches`);
  }
  return { status: files.length > 0 ? 'ran' : 'no care cases in the folder', files: files.length };
}

check('the private course runner reads a case file and fails on a figure that is off (proved on a made-up case in a temporary folder)', () => {
  const folder = mkdtempSync(join(tmpdir(), 'care-private-'));
  try {
    const sample = computeCareCostProjection(CARE_SAMPLE, { today: CARE_TODAY, flatReliefRate: 0.4 }).debug.cases[1];
    const body = (family) => JSON.stringify({
      inputs: { ...CARE_SAMPLE, scenarios: [CARE_SAMPLE.scenarios[1]] },
      options: { today: CARE_TODAY, flatReliefRate: 0.4 },
      expect: { alongside: { familyTotalBeforeRelief: family, rows: [{ fee: 68_276, assessedContribution: 40_530 }] } },
      toleranceEur: 0.5
    });
    writeFileSync(join(folder, 'care-costs-made-up.json'), body(sample.familyTotalBeforeRelief));
    assert.deepEqual(runPrivateCourseCases(folder, { quiet: true }), { status: 'ran', files: 1 });
    writeFileSync(join(folder, 'care-costs-made-up.json'), body(sample.familyTotalBeforeRelief + 100));
    assert.throws(() => runPrivateCourseCases(folder, { quiet: true }), /familyTotalBeforeRelief/);
    assert.deepEqual(runPrivateCourseCases(join(folder, 'nowhere'), { quiet: true }), { status: 'not present', files: 0 });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

const privateResult = runPrivateCourseCases(fileURLToPath(new URL('../private/cfp-cases/', import.meta.url)));
console.info(`[CareCostsAudit] private course cases: ${privateResult.status}${privateResult.status === 'not present' ? ' (private/cfp-cases/ is on one Mac only and is never in the repository)' : ''}`);

if (failures > 0) {
  console.error(`[CareCostsAudit] ${failures} check(s) failed.`);
  process.exit(1);
}

console.info('[CareCostsAudit] the engine matches the independent reference on every fixture, the invariants hold, and the Fair Deal rules and their register entries pass.');
