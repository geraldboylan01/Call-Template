import {
  computeRentalKeepOrSellProjection,
  getDefaultRentalKeepOrSellScenarioId,
  getRentalKeepOrSellCases,
  normalizeRentalKeepOrSellInputs
} from './rental_keep_or_sell_math.js';

/**
 * The sample every figure is proved against. Rent 18,000 a year against loan
 * repayments of 13,000, running costs of 2,500 and tax of 3,700 leaves minus
 * 1,200. A sale at 320,000, less 6,000, the 180,000 loan and 21,000 of tax,
 * leaves 113,000.
 */
export const RENTAL_KEEP_OR_SELL_SAMPLE = Object.freeze({
  rentPerYear: 18_000,
  loanRepaymentsPerYear: 13_000,
  runningCostsPerYear: 2_500,
  taxOnRentalProfitPerYear: 3_700,
  salePrice: 320_000,
  sellingCosts: 6_000,
  loanBalance: 180_000,
  taxOnGain: 21_000
});

const RENTAL_KEEP_OR_SELL_EXPECTED = Object.freeze({
  keep: Object.freeze({
    names: ['Rent', 'Loan repayments', 'Running costs', 'Tax on the rental profit', 'Net each year'],
    amounts: [18_000, 13_000, 2_500, 3_700, -1_200],
    lo: [0, 5_000, 2_500, -1_200, -1_200],
    hi: [18_000, 18_000, 5_000, 2_500, 0],
    result: -1_200,
    tone: 'short',
    comesOff: 19_200,
    comesOffName: 'Loan repayments, running costs and tax'
  }),
  sell: Object.freeze({
    names: ['Sale price', 'Selling costs', 'Loan repaid', 'Tax on the gain', 'In hand'],
    amounts: [320_000, 6_000, 180_000, 21_000, 113_000],
    lo: [0, 314_000, 134_000, 113_000, 0],
    hi: [320_000, 320_000, 314_000, 134_000, 113_000],
    result: 113_000,
    tone: 'left_over',
    comesOff: 207_000,
    comesOffName: 'Selling costs, the loan and tax'
  })
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
    console.info(`[RentalKeepOrSellTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[RentalKeepOrSellTests] FAIL: ${name}\n    ${error.message}`);
    return { name, pass: false, error: error.message };
  }
}

const FIELD = 'generated.rentalKeepOrSellInputs';

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

function caseById(projection, id) {
  return projection.debug.cases.find((entry) => entry.id === id);
}

export function runRentalKeepOrSellTests() {
  const cases = [];

  cases.push(runCase('The sample: every line of both cases is in the order and amount stated', () => {
    const projection = computeRentalKeepOrSellProjection(RENTAL_KEEP_OR_SELL_SAMPLE);
    ['keep', 'sell'].forEach((id) => {
      const expected = RENTAL_KEEP_OR_SELL_EXPECTED[id];
      const entry = caseById(projection, id);
      assertDeepEqual(entry.rows.map((row) => row.name), expected.names, `${id}: row names`);
      assertDeepEqual(entry.rows.map((row) => row.amount), expected.amounts, `${id}: amounts`);
      assertEqual(entry.result, expected.result, `${id}: result`);
      assertEqual(entry.resultTone, expected.tone, `${id}: tone`);
    });
  }));

  cases.push(runCase('The sample: each bar sits where the running balance puts it', () => {
    const projection = computeRentalKeepOrSellProjection(RENTAL_KEEP_OR_SELL_SAMPLE);
    ['keep', 'sell'].forEach((id) => {
      const expected = RENTAL_KEEP_OR_SELL_EXPECTED[id];
      const entry = caseById(projection, id);
      assertDeepEqual(entry.rows.map((row) => row.lo), expected.lo, `${id}: lower ends`);
      assertDeepEqual(entry.rows.map((row) => row.hi), expected.hi, `${id}: upper ends`);
    });
  }));

  cases.push(runCase('Five rows, always, with the same keys in both cases', () => {
    const projection = computeRentalKeepOrSellProjection(RENTAL_KEEP_OR_SELL_SAMPLE);
    projection.debug.cases.forEach((entry) => {
      assertDeepEqual(
        entry.rows.map((row) => row.key),
        ['start', 'cut1', 'cut2', 'cut3', 'result'],
        `${entry.id}: row keys`
      );
    });
  }));

  cases.push(runCase('Invariants: the result is the start less the cuts, and each cut meets the one before', () => {
    const shapes = [
      RENTAL_KEEP_OR_SELL_SAMPLE,
      { ...RENTAL_KEEP_OR_SELL_SAMPLE, loanRepaymentsPerYear: 0, taxOnRentalProfitPerYear: 0 },
      { ...RENTAL_KEEP_OR_SELL_SAMPLE, loanRepaymentsPerYear: 30_000 },
      { ...RENTAL_KEEP_OR_SELL_SAMPLE, loanBalance: 400_000 },
      { ...RENTAL_KEEP_OR_SELL_SAMPLE, sellingCosts: 0, loanBalance: 0, taxOnGain: 0 }
    ];
    shapes.forEach((payload, index) => {
      const projection = computeRentalKeepOrSellProjection(payload);
      projection.debug.cases.forEach((entry) => {
        const [start, cut1, cut2, cut3, result] = entry.rows;
        const total = cut1.amount + cut2.amount + cut3.amount;
        assert(
          Math.abs(start.amount - total - result.amount) < 1e-9,
          `shape ${index + 1}/${entry.id}: result ${result.amount} is not ${start.amount} less ${total}`
        );
        assertEqual(cut1.hi, start.amount, `shape ${index + 1}/${entry.id}: the first cut starts at the headline`);
        assertEqual(cut2.hi, cut1.lo, `shape ${index + 1}/${entry.id}: second cut meets the first`);
        assertEqual(cut3.hi, cut2.lo, `shape ${index + 1}/${entry.id}: third cut meets the second`);
        assertEqual(cut3.lo, entry.result, `shape ${index + 1}/${entry.id}: the last cut ends at the result`);
        assertEqual(result.lo, Math.min(0, entry.result), `shape ${index + 1}/${entry.id}: result lower end`);
        assertEqual(result.hi, Math.max(0, entry.result), `shape ${index + 1}/${entry.id}: result upper end`);
      });
    });
  }));

  cases.push(runCase('The tone follows the result: left over, level, or short', () => {
    const positive = computeRentalKeepOrSellProjection({
      ...RENTAL_KEEP_OR_SELL_SAMPLE,
      rentPerYear: 25_000
    });
    assertEqual(caseById(positive, 'keep').result, 5_800, 'net each year when rent is 25,000');
    assertEqual(caseById(positive, 'keep').resultTone, 'left_over', 'positive net');

    const level = computeRentalKeepOrSellProjection({
      ...RENTAL_KEEP_OR_SELL_SAMPLE,
      rentPerYear: 19_200
    });
    assertEqual(caseById(level, 'keep').result, 0, 'net each year when rent is 19,200');
    assertEqual(caseById(level, 'keep').resultTone, 'level', 'zero net');

    const underwater = computeRentalKeepOrSellProjection({
      ...RENTAL_KEEP_OR_SELL_SAMPLE,
      loanBalance: 310_000
    });
    assertEqual(caseById(underwater, 'sell').result, -17_000, 'in hand when the loan is 310,000');
    assertEqual(caseById(underwater, 'sell').resultTone, 'short', 'a sale that does not clear the loan');

    const nothing = computeRentalKeepOrSellProjection({
      ...RENTAL_KEEP_OR_SELL_SAMPLE,
      loanBalance: 293_000
    });
    assertEqual(caseById(nothing, 'sell').result, 0, 'in hand when the loan is 293,000');
    assertEqual(caseById(nothing, 'sell').resultTone, 'level', 'a sale that leaves nothing');
  }));

  cases.push(runCase('A cut of zero keeps its row', () => {
    const projection = computeRentalKeepOrSellProjection({
      ...RENTAL_KEEP_OR_SELL_SAMPLE,
      runningCostsPerYear: 0
    });
    const entry = caseById(projection, 'keep');
    assertEqual(entry.rows.length, 5, 'five rows');
    assertEqual(entry.rows[2].amount, 0, 'the zero cut');
    assertEqual(entry.rows[2].lo, entry.rows[2].hi, 'a zero-width bar');
  }));

  cases.push(runCase('What comes off is named and added up for the video, in debug only', () => {
    const projection = computeRentalKeepOrSellProjection(RENTAL_KEEP_OR_SELL_SAMPLE);
    ['keep', 'sell'].forEach((id) => {
      const expected = RENTAL_KEEP_OR_SELL_EXPECTED[id];
      const entry = caseById(projection, id);
      assertEqual(entry.comesOff, expected.comesOff, `${id}: what comes off`);
      assertEqual(entry.comesOffName, expected.comesOffName, `${id}: what it is called`);
    });
    const screenText = JSON.stringify({
      assumptionsTable: projection.assumptionsTable,
      outputsTable: projection.outputsTable,
      tables: projection.tables,
      charts: projection.charts
    });
    assert(!/19,?200|207,?000/.test(screenText), 'the derived totals reach no table or chart');
  }));

  cases.push(runCase('The outputs table has one row per case, and the tables add down to the result', () => {
    const projection = computeRentalKeepOrSellProjection(RENTAL_KEEP_OR_SELL_SAMPLE);
    assertEqual(projection.outputsTable.rows.length, 2, 'one row per case');
    assertDeepEqual(projection.outputsTable.rows[0], ['Keep', 18_000, 13_000, 2_500, 3_700, -1_200], 'Keep row');
    assertDeepEqual(projection.outputsTable.rows[1], ['Sell', 320_000, 6_000, 180_000, 21_000, 113_000], 'Sell row');
    projection.tables.forEach((table) => {
      const amounts = table.rows.map((row) => row[1]);
      const sumOfLines = amounts.slice(0, -1).reduce((sum, amount) => sum + amount, 0);
      assertEqual(sumOfLines, amounts[amounts.length - 1], `${table.title}: lines add to the last row`);
    });
  }));

  cases.push(runCase('One ordinary chart ships for the surfaces that draw no module', () => {
    const keep = computeRentalKeepOrSellProjection(RENTAL_KEEP_OR_SELL_SAMPLE);
    assertEqual(keep.charts.length, 1, 'one chart');
    assertDeepEqual(keep.charts[0].datasets[0].data, [18_000, -13_000, -2_500, -3_700, -1_200], 'Keep chart data');
    assertEqual(keep.debug.baseScenarioId, 'keep', 'default base case');

    const sell = computeRentalKeepOrSellProjection({ ...RENTAL_KEEP_OR_SELL_SAMPLE, baseScenarioId: 'sell' });
    assertEqual(sell.debug.baseScenarioId, 'sell', 'requested base case');
    assertDeepEqual(sell.charts[0].labels, RENTAL_KEEP_OR_SELL_EXPECTED.sell.names, 'Sell chart labels');
  }));

  cases.push(runCase('The cases and the default, for the presenter', () => {
    const list = getRentalKeepOrSellCases(RENTAL_KEEP_OR_SELL_SAMPLE);
    assertDeepEqual(list.map((entry) => entry.id), ['keep', 'sell'], 'ids');
    assertDeepEqual(list.map((entry) => entry.title), ['Keep', 'Sell'], 'titles');
    list.forEach((entry) => assert(entry.description.length > 0, `${entry.id}: description`));
    assertEqual(getDefaultRentalKeepOrSellScenarioId(RENTAL_KEEP_OR_SELL_SAMPLE), 'keep', 'default');
    assertEqual(
      getDefaultRentalKeepOrSellScenarioId({ ...RENTAL_KEEP_OR_SELL_SAMPLE, baseScenarioId: 'sell' }),
      'sell',
      'requested default'
    );
  }));

  cases.push(runCase('Normalising is idempotent', () => {
    const once = normalizeRentalKeepOrSellInputs(RENTAL_KEEP_OR_SELL_SAMPLE);
    assertDeepEqual(normalizeRentalKeepOrSellInputs(once), once, 'normalised twice');
    assertEqual(once.baseScenarioId, 'keep', 'default base case');
  }));

  cases.push(runCase('Rejections carry the exact message', () => {
    const bad = (patch) => () => normalizeRentalKeepOrSellInputs({ ...RENTAL_KEEP_OR_SELL_SAMPLE, ...patch });
    const without = (key) => () => {
      const copy = { ...RENTAL_KEEP_OR_SELL_SAMPLE };
      delete copy[key];
      normalizeRentalKeepOrSellInputs(copy);
    };

    assertThrows(bad({ rentPerYear: 0 }), `${FIELD}.rentPerYear must be a number greater than 0.`, 'no rent');
    assertThrows(bad({ salePrice: -1 }), `${FIELD}.salePrice must be a number greater than 0.`, 'negative price');
    assertThrows(
      bad({ taxOnGain: -1 }),
      `${FIELD}.taxOnGain must be a number greater than or equal to 0.`,
      'negative tax on the gain'
    );
    assertThrows(
      bad({ loanRepaymentsPerYear: Number.NaN }),
      `${FIELD}.loanRepaymentsPerYear must be a number greater than or equal to 0.`,
      'not a number'
    );
    assertThrows(
      bad({ sellingCosts: '6000' }),
      `${FIELD}.sellingCosts must be a number greater than or equal to 0.`,
      'a string'
    );
    assertThrows(
      without('loanBalance'),
      `${FIELD}.loanBalance must be a number greater than or equal to 0.`,
      'a missing field'
    );
    assertThrows(
      without('rentPerYear'),
      `${FIELD}.rentPerYear must be a number greater than 0.`,
      'a missing rent'
    );
    assertThrows(
      bad({ scenarios: [] }),
      `${FIELD}.scenarios is not an input of this module.`,
      'a scenarios array'
    );
    assertThrows(
      bad({ notAField: 1 }),
      `${FIELD}.notAField is not an input of this module.`,
      'an unknown key'
    );
    assertThrows(
      bad({ baseScenarioId: 'hold' }),
      `${FIELD}.baseScenarioId must be "keep" or "sell".`,
      'a bad base case'
    );
    assertThrows(() => normalizeRentalKeepOrSellInputs(null), `${FIELD} must be an object.`, 'null');
    assertThrows(() => normalizeRentalKeepOrSellInputs([]), `${FIELD} must be an object.`, 'an array');
  }));

  cases.push(runCase('Engine text holds no banned phrase, "we", "us", "our" or "p.a."', () => {
    const projection = computeRentalKeepOrSellProjection(RENTAL_KEEP_OR_SELL_SAMPLE);
    const text = collectStrings({
      assumptionsTable: projection.assumptionsTable,
      outputsTable: projection.outputsTable,
      tables: projection.tables,
      charts: projection.charts,
      cases: getRentalKeepOrSellCases(RENTAL_KEEP_OR_SELL_SAMPLE)
    });
    text.forEach((entry) => assert(!bannedWording(entry), `banned wording in "${entry}"`));
    const basis = projection.assumptionsTable.rows.map((row) => row[1]).join(' | ');
    assert(basis.includes('as stated'), 'the figures are said to be as stated');
    assert(/Tax is not calculated here/.test(basis), 'the tax is said not to be calculated');
    assert(/one year/.test(basis), 'the period is stated');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };

  if (failed > 0) {
    console.warn('[RentalKeepOrSellTests] Completed with failures', summary);
  } else {
    console.info('[RentalKeepOrSellTests] All tests passed', { total: summary.total, passed: summary.passed });
  }

  return summary;
}
