import {
  computeHomeTradeDownProjection,
  getDefaultHomeTradeDownScenarioId,
  getHomeTradeDownCases,
  loanFromAnnualRepayment,
  normalizeHomeTradeDownInputs
} from './home_trade_down_math.js';
import { computeMonthlyPayment } from './mortgage_math.js';

/**
 * The sample every figure is proved against. A home worth 650,000 with a
 * 280,000 mortgage repaid at 30,000 a year. Selling releases 355,000 after the
 * mortgage and 15,000 of costs, and buying costs 12,000. New loans run 15 years
 * at 4%.
 */
export const HOME_TRADE_DOWN_SAMPLE = Object.freeze({
  homeValue: 650_000,
  mortgageBalance: 280_000,
  currentAnnualRepayments: 30_000,
  sellingCosts: 15_000,
  buyingCosts: 12_000,
  newLoanTermYears: 15,
  newLoanAnnualRate: 0.04,
  baseScenarioId: 'stay',
  scenarios: Object.freeze([
    Object.freeze({ id: 'stay', kind: 'stay' }),
    Object.freeze({ id: 'repay-18000', kind: 'move', annualRepayment: 18_000 }),
    Object.freeze({ id: 'repay-12000', kind: 'move', annualRepayment: 12_000 }),
    Object.freeze({ id: 'no-mortgage', kind: 'move', annualRepayment: 0 })
  ])
});

/** What the sample must show: the screen's own rounding, and the unrounded loans. */
export const HOME_TRADE_DOWN_EXPECTED = Object.freeze({
  ids: ['stay', 'repay-18000', 'repay-12000', 'no-mortgage'],
  titles: ['Stay', 'Repay €18,000 a year', 'Repay €12,000 a year', 'No mortgage'],
  block1: [370_000, 343_000, 343_000, 343_000],
  block2: [280_000, 203_000, 135_000, 0],
  homeBudget: [650_000, 546_000, 478_000, 343_000],
  repaid: [30_000, 18_000, 12_000, 0],
  freed: [0, 12_000, 18_000, 30_000],
  loanUnrounded: [0, 202_788, 135_192, 0],
  released: 355_000,
  cashTowardHome: 343_000
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message || 'Values differ'}: expected ${e}, got ${a}`);
  }
}

function assertWithin(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message || 'Values differ'}: expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

function assertThrows(fn, expectedMessage, label) {
  try {
    fn();
  } catch (error) {
    if (error.message !== expectedMessage) {
      throw new Error(`${label}: expected "${expectedMessage}", got "${error.message}"`);
    }
    return;
  }
  throw new Error(`${label}: expected it to throw "${expectedMessage}"`);
}

function runCase(name, fn) {
  try {
    fn();
    console.info(`[HomeTradeDownTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[HomeTradeDownTests] FAIL: ${name}\n    ${error.message}`);
    return { name, pass: false, error: error.message };
  }
}

const FIELD = 'generated.homeTradeDownInputs';

/** Wording the module must never put in front of a client. */
function bannedWording(text) {
  return /p\.a\.|we recommend|you should|best option|\bbest\b|\bideal\b|\boptimal\b|\bwe\b|\bus\b|\bour\b/i.test(text);
}

function collectStrings(value, found = []) {
  if (typeof value === 'string') {
    found.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((entry) => collectStrings(entry, found));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => collectStrings(entry, found));
  }
  return found;
}

/** The sample with other cases. The sample names "stay" as its base, which other cases may not have. */
function withCases(scenarios, patch = {}) {
  return { ...HOME_TRADE_DOWN_SAMPLE, baseScenarioId: undefined, ...patch, scenarios };
}

export function runHomeTradeDownTests() {
  const cases = [];

  cases.push(runCase('The sample: every figure in the four cases, to the screen\'s rounding', () => {
    const projection = computeHomeTradeDownProjection(HOME_TRADE_DOWN_SAMPLE);
    const expected = HOME_TRADE_DOWN_EXPECTED;
    const { cases: solved } = projection.debug;
    assertDeepEqual(solved.map((entry) => entry.id), expected.ids, 'ids');
    assertDeepEqual(solved.map((entry) => entry.title), expected.titles, 'titles');
    assertDeepEqual(solved.map((entry) => entry.block1), expected.block1, 'block 1');
    assertDeepEqual(solved.map((entry) => entry.block2), expected.block2, 'block 2');
    assertDeepEqual(solved.map((entry) => entry.homeBudget), expected.homeBudget, 'home budget');
    assertDeepEqual(solved.map((entry) => entry.repaid), expected.repaid, 'repaid');
    assertDeepEqual(solved.map((entry) => entry.freed), expected.freed, 'freed');
    assertEqual(projection.debug.released, expected.released, 'released by selling');
    assertEqual(projection.debug.cashTowardHome, expected.cashTowardHome, 'cash toward the home');
  }));

  cases.push(runCase('The unrounded loans, and the budgets they make', () => {
    const { cases: solved } = computeHomeTradeDownProjection(HOME_TRADE_DOWN_SAMPLE).debug;
    solved.forEach((entry, index) => {
      assertWithin(entry.loanUnrounded, HOME_TRADE_DOWN_EXPECTED.loanUnrounded[index], 1, `${entry.id}: loan`);
    });
    assertWithin(solved[1].homeBudgetUnrounded, 545_788, 1, 'unrounded budget at 18,000');
    assertWithin(solved[2].homeBudgetUnrounded, 478_192, 1, 'unrounded budget at 12,000');
  }));

  cases.push(runCase('Payments are monthly: annual compounding would give other loans', () => {
    const annualFactor = (1 - 1.04 ** -15) / 0.04;
    assertWithin(18_000 * annualFactor, 200_131, 1, 'annual compounding at 18,000');
    assertWithin(12_000 * annualFactor, 133_421, 1, 'annual compounding at 12,000');
    const monthly = loanFromAnnualRepayment(18_000, 15, 0.04);
    assert(Math.abs(monthly - 200_131) > 2_000, 'the engine does not compound annually');
  }));

  cases.push(runCase('Round trip: the loan, paid back monthly, is the yearly repayment', () => {
    const { cases: solved, inputs } = computeHomeTradeDownProjection(HOME_TRADE_DOWN_SAMPLE).debug;
    solved.filter((entry) => entry.kind === 'move' && entry.annualRepayment > 0).forEach((entry) => {
      const monthly = computeMonthlyPayment(
        entry.loanUnrounded,
        inputs.newLoanAnnualRate,
        inputs.newLoanTermYears * 12
      );
      assertWithin(monthly * 12, entry.annualRepayment, 0.01, `${entry.id}: the yearly repayment`);
    });
  }));

  cases.push(runCase('Invariants: the blocks add to the budget, the year adds to today, the budget fits the home', () => {
    const shapes = [
      HOME_TRADE_DOWN_SAMPLE,
      withCases(
        [{ id: 'a', kind: 'move', annualRepayment: 5_000.5 }, { id: 'b', kind: 'move', annualRepayment: 29_999 }],
        { newLoanAnnualRate: 0.0275, newLoanTermYears: 7, sellingCosts: 20_000.4 }
      ),
      withCases([{ id: 'a', kind: 'move', annualRepayment: 9_000 }], { newLoanAnnualRate: 0, newLoanTermYears: 20 }),
      withCases([{ id: 'a', kind: 'stay' }], { homeValue: 650_000.6 })
    ];
    shapes.forEach((payload, index) => {
      const projection = computeHomeTradeDownProjection(payload);
      projection.debug.cases.forEach((entry) => {
        const label = `shape ${index + 1}/${entry.id}`;
        assertEqual(entry.block1 + entry.block2, entry.homeBudget, `${label}: blocks add to the budget`);
        assertWithin(entry.freed + entry.repaid, payload.currentAnnualRepayments, 1e-9, `${label}: freed plus repaid`);
        assert(entry.homeBudget <= Math.round(payload.homeValue), `${label}: budget is within the current home`);
        assert(entry.freed >= 0, `${label}: nothing is negative`);
      });
    });
  }));

  cases.push(runCase('No interest: the loan is the repayment for every month', () => {
    assertEqual(loanFromAnnualRepayment(12_000, 15, 0), 180_000, 'a flat loan');
    assertEqual(loanFromAnnualRepayment(0, 15, 0.04), 0, 'nothing repaid, nothing borrowed');
  }));

  cases.push(runCase('Rounding: the loan to €1,000, the budget as the two blocks shown', () => {
    const payload = withCases(
      [{ id: 'm', kind: 'move', annualRepayment: 17_500 }],
      { sellingCosts: 15_432, buyingCosts: 11_111 }
    );
    const [entry] = computeHomeTradeDownProjection(payload).debug.cases;
    assertEqual(entry.block2 % 1_000, 0, 'the loan is a whole thousand');
    assertEqual(entry.block1, 650_000 - 280_000 - 15_432 - 11_111, 'block 1 is shown to the euro');
    assertEqual(entry.homeBudget, entry.block1 + entry.block2, 'budget is the blocks as shown');
    assertWithin(entry.block2, entry.loanUnrounded, 500, 'the loan rounds by at most 500');
  }));

  cases.push(runCase('A stay ignores a repayment it was given, and a move with none is refused', () => {
    const stay = normalizeHomeTradeDownInputs(withCases([{ id: 'a', kind: 'stay', annualRepayment: 5 }]));
    assertEqual(stay.scenarios[0].annualRepayment, null, 'ignored, not refused');
    assertThrows(
      () => normalizeHomeTradeDownInputs(withCases([{ id: 'a', kind: 'move' }])),
      `${FIELD}.scenarios[0] (a): annualRepayment must be a number from 0 up to currentAnnualRepayments.`,
      'a move with no repayment'
    );
  }));

  cases.push(runCase('Titles: given, or derived from the case', () => {
    const [stay, move, none] = getHomeTradeDownCases(withCases([
      { id: 'a', kind: 'stay' },
      { id: 'b', kind: 'move', annualRepayment: 18_000 },
      { id: 'c', kind: 'move', annualRepayment: 0, title: 'Clear the mortgage', description: 'No loan at all.' }
    ]));
    assertEqual(stay.title, 'Stay', 'stay');
    assertEqual(move.title, 'Repay €18,000 a year', 'repay');
    assertEqual(none.title, 'Clear the mortgage', 'given title wins');
    assertEqual(none.description, 'No loan at all.', 'description');
  }));

  cases.push(runCase('The cases and the default, for the presenter', () => {
    const list = getHomeTradeDownCases(HOME_TRADE_DOWN_SAMPLE);
    assertDeepEqual(list.map((entry) => entry.id), HOME_TRADE_DOWN_EXPECTED.ids, 'ids');
    assertEqual(getDefaultHomeTradeDownScenarioId(HOME_TRADE_DOWN_SAMPLE), 'stay', 'default');
    assertEqual(
      getDefaultHomeTradeDownScenarioId({ ...HOME_TRADE_DOWN_SAMPLE, baseScenarioId: 'repay-12000' }),
      'repay-12000',
      'requested default'
    );
    const first = getDefaultHomeTradeDownScenarioId({ ...HOME_TRADE_DOWN_SAMPLE, baseScenarioId: undefined });
    assertEqual(first, 'stay', 'the first case when none is named');
  }));

  cases.push(runCase('Normalising is idempotent', () => {
    const once = normalizeHomeTradeDownInputs(HOME_TRADE_DOWN_SAMPLE);
    assertDeepEqual(normalizeHomeTradeDownInputs(once), once, 'normalised twice');
  }));

  cases.push(runCase('Tables, outputs and the one chart', () => {
    const projection = computeHomeTradeDownProjection(HOME_TRADE_DOWN_SAMPLE);
    assertEqual(projection.outputsTable.rows.length, 4, 'one row per case');
    assertDeepEqual(projection.outputsTable.rows[1], ['Repay €18,000 a year', 18_000, 12_000, 203_000, 546_000], 'case 2');
    assertDeepEqual(projection.outputsTable.rows[0], ['Stay', 30_000, 0, 0, 650_000], 'the stay');
    projection.tables.forEach((table) => {
      const [one, two, total] = table.rows.map((row) => row[1]);
      assertEqual(one + two, total, `${table.title}: the lines add up`);
    });
    assertEqual(projection.charts.length, 1, 'one chart');
    assertDeepEqual(projection.charts[0].datasets[0].data, HOME_TRADE_DOWN_EXPECTED.homeBudget, 'chart data');
    assertEqual(projection.debug.assumptionsUsed.source, 'payload', 'the loan terms come from the payload');
  }));

  cases.push(runCase('Rejections carry the exact message', () => {
    const bad = (patch) => () => normalizeHomeTradeDownInputs({
      ...HOME_TRADE_DOWN_SAMPLE,
      // Other cases may not include the sample's base case.
      ...('scenarios' in patch && !('baseScenarioId' in patch) ? { baseScenarioId: undefined } : {}),
      ...patch
    });
    const without = (key) => () => {
      const copy = { ...HOME_TRADE_DOWN_SAMPLE };
      delete copy[key];
      normalizeHomeTradeDownInputs(copy);
    };
    const fifth = [...HOME_TRADE_DOWN_SAMPLE.scenarios, { id: 'fifth', kind: 'move', annualRepayment: 1_000 }];

    assertThrows(
      bad({ scenarios: fifth }),
      `${FIELD}.scenarios supports at most 4 cases; received 5.`,
      'a fifth case'
    );
    assertThrows(
      bad({ scenarios: [{ id: 'a', kind: 'move', annualRepayment: 35_000, title: 'Repay €35,000 a year' }] }),
      `${FIELD}.scenarios[0] (Repay €35,000 a year): annualRepayment must be a number from 0 up to currentAnnualRepayments.`,
      'a repayment above today\'s'
    );
    assertThrows(
      bad({ scenarios: [{ id: 'a', kind: 'move', annualRepayment: -1 }] }),
      `${FIELD}.scenarios[0] (a): annualRepayment must be a number from 0 up to currentAnnualRepayments.`,
      'a negative repayment'
    );
    assertThrows(
      bad({ sellingCosts: 400_000 }),
      `${FIELD}.sellingCosts: selling would not clear the mortgage.`,
      'selling that cannot clear the mortgage'
    );
    assertThrows(
      bad({ buyingCosts: 400_000 }),
      `${FIELD}.buyingCosts: the money from selling does not cover the buying costs.`,
      'buying costs above the released money'
    );
    assertThrows(
      bad({ scenarios: [{ id: 'a', kind: 'move', annualRepayment: 30_000 }] }),
      `${FIELD}.scenarios[0] (Repay €30,000 a year): the home budget is more than the current home. This module shows trading down.`,
      'a budget above the current home'
    );
    assertThrows(
      bad({ scenarios: [{ id: 'a', kind: 'stay' }, { id: 'a', kind: 'move', annualRepayment: 0 }] }),
      `${FIELD}.scenarios[1].id must be unique.`,
      'a duplicate id'
    );
    assertThrows(
      bad({ scenarios: [{ id: 'a', kind: 'stay', colour: 'blue' }] }),
      `${FIELD}.scenarios[0] (Stay): "colour" is not a case field.`,
      'an unknown case key'
    );
    assertThrows(
      bad({ scenarios: [{ id: 'a', kind: 'hold' }] }),
      `${FIELD}.scenarios[0] (a): kind must be "stay" or "move".`,
      'a bad kind'
    );
    assertThrows(
      bad({ baseScenarioId: 'nope' }),
      `${FIELD}.baseScenarioId must match a case id.`,
      'a bad base case'
    );
    assertThrows(
      bad({ newLoanTermYears: 0 }),
      `${FIELD}.newLoanTermYears must be a whole number of years from 1 to 40.`,
      'a zero term'
    );
    assertThrows(
      bad({ newLoanTermYears: 41 }),
      `${FIELD}.newLoanTermYears must be a whole number of years from 1 to 40.`,
      'a term above 40'
    );
    assertThrows(
      bad({ newLoanTermYears: 12.5 }),
      `${FIELD}.newLoanTermYears must be a whole number of years from 1 to 40.`,
      'a part-year term'
    );
    assertThrows(
      bad({ newLoanAnnualRate: -0.01 }),
      `${FIELD}.newLoanAnnualRate must be a number from 0 to 0.15.`,
      'a negative rate'
    );
    assertThrows(
      bad({ newLoanAnnualRate: 0.2 }),
      `${FIELD}.newLoanAnnualRate must be a number from 0 to 0.15.`,
      'a rate above 15%'
    );
    assertThrows(
      bad({ homeValue: 0 }),
      `${FIELD}.homeValue must be a number greater than 0.`,
      'no home'
    );
    assertThrows(
      bad({ currentAnnualRepayments: Number.NaN }),
      `${FIELD}.currentAnnualRepayments must be a number greater than 0.`,
      'not a number'
    );
    assertThrows(
      bad({ buyingCosts: -1 }),
      `${FIELD}.buyingCosts must be a number greater than or equal to 0.`,
      'negative buying costs'
    );
    assertThrows(
      without('newLoanTermYears'),
      `${FIELD}.newLoanTermYears must be a whole number of years from 1 to 40.`,
      'a missing term'
    );
    assertThrows(
      without('newLoanAnnualRate'),
      `${FIELD}.newLoanAnnualRate must be a number from 0 to 0.15.`,
      'a missing rate'
    );
    assertThrows(
      without('scenarios'),
      `${FIELD}.scenarios must be an array with at least 1 case.`,
      'no cases'
    );
    assertThrows(
      bad({ notAField: 1 }),
      `${FIELD}.notAField is not an input of this module.`,
      'an unknown key'
    );
    assertThrows(() => normalizeHomeTradeDownInputs(null), `${FIELD} must be an object.`, 'null');
    assertThrows(() => normalizeHomeTradeDownInputs([]), `${FIELD} must be an object.`, 'an array');
  }));

  cases.push(runCase('Engine text holds no banned phrase, "we", "us", "our" or "p.a."', () => {
    const projection = computeHomeTradeDownProjection(HOME_TRADE_DOWN_SAMPLE);
    const text = collectStrings({
      assumptionsTable: projection.assumptionsTable,
      outputsTable: projection.outputsTable,
      tables: projection.tables,
      charts: projection.charts,
      cases: getHomeTradeDownCases(HOME_TRADE_DOWN_SAMPLE)
    });
    text.forEach((entry) => assert(!bannedWording(entry), `banned wording in "${entry}"`));
    const rows = projection.assumptionsTable.rows.map((row) => row[1]).join(' | ');
    assert(rows.includes('15 years') && rows.includes('4% a year'), 'the loan terms are named');
    assert(rows.includes('Monthly'), 'the payment convention is named');
    assert(rows.includes('nearest €1,000'), 'the rounding is named');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };

  if (failed > 0) {
    console.warn('[HomeTradeDownTests] Completed with failures', summary);
  } else {
    console.info('[HomeTradeDownTests] All tests passed', { total: summary.total, passed: summary.passed });
  }

  return summary;
}
