import {
  computeFutureCostFundProjection,
  getDefaultFutureCostFundScenarioId,
  getFutureCostFundCases,
  normalizeFutureCostFundInputs
} from './future_cost_fund_math.js';
import {
  PLANEIR_ASSUMPTIONS,
  PLANEIR_ASSUMPTIONS_VERSION,
  assumptionRecord,
  assumptionLabel
} from './planning/planeir_assumptions.js';
import { DEFAULT_IE_TAX_CATALOGUE, resolveTaxRules } from './planning/tax/resolve.js';
import { IE_TAX_RULES_VERSION } from './planning/tax/rules_ie.js';

/**
 * The four sample cases, and the two fixtures every figure is proved against.
 *
 * The CENTRAL fixture reads nothing but the central assumptions. The DESIGN
 * fixture is what the design frames were drawn from: prices 3%, cash 2%, and no
 * DIRT because the design assumed savings grew 2% and nothing came off it. It
 * is injected through the options argument, which a payload cannot reach.
 */
export const FUTURE_COST_FUND_SAMPLE = Object.freeze({
  costTitle: 'College',
  costKind: 'education',
  startsInYears: 8,
  durationYears: 4,
  annualCostToday: 15_000,
  scenarios: Object.freeze([
    Object.freeze({ id: 'lump', lumpShare: 1 }),
    Object.freeze({ id: 'yearly', lumpShare: 0 }),
    Object.freeze({ id: 'half', lumpShare: 0.5 }),
    Object.freeze({ id: 'delayed', lumpShare: 0, savingStartsInYears: 3 })
  ])
});

export function designFixtureOptions() {
  const block = DEFAULT_IE_TAX_CATALOGUE.rulesByYear[2026];
  return {
    assumptions: {
      version: 'design-fixture',
      inflation: { educationRate: 0.03, generalRate: 0.03 },
      cash: { instantAccessGrossRate: 0.02 }
    },
    taxCatalogue: {
      ...DEFAULT_IE_TAX_CATALOGUE,
      rulesByYear: {
        ...DEFAULT_IE_TAX_CATALOGUE.rulesByYear,
        2026: { ...block, dirt: { ...block.dirt, rate: 0 } }
      }
    },
    calculationYear: 2026
  };
}

/** What each fixture must show, to the nearest €100 (the screen's rounding). */
export const FUTURE_COST_FUND_EXPECTED = Object.freeze({
  central: Object.freeze({
    lumpSum: [86_100, 0, 43_000, 0],
    yearly: [0, 10_800, 5_400, 17_300],
    savingYears: [0, 8, 8, 5],
    paidIn: [86_100, 86_500, 86_300, 86_600],
    growth: [1_100, 700, 900, 600],
    costs: [20_500, 21_300, 22_200, 23_100],
    totalCost: 87_200,
    openingAtCostStart: 87_000
  }),
  design: Object.freeze({
    lumpSum: [65_800, 0, 32_900, 0],
    yearly: [0, 8_800, 4_400, 14_500],
    savingYears: [0, 8, 8, 5],
    paidIn: [65_800, 70_500, 68_200, 72_700],
    growth: [13_700, 9_000, 11_300, 6_800],
    costs: [19_000, 19_600, 20_200, 20_800],
    totalCost: 79_500,
    openingAtCostStart: 77_100
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
    console.info(`[FutureCostFundTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[FutureCostFundTests] FAIL: ${name}\n    ${error.message}`);
    return { name, pass: false, error: error.message };
  }
}

const hundred = (amount) => Math.round(amount / 100) * 100;

function checkAgainstTable(projection, expected, label) {
  const { cases, totalCost } = projection.debug;
  assertEqual(hundred(totalCost), expected.totalCost, `${label}: total cost`);
  cases.forEach((entry, index) => {
    assertEqual(hundred(entry.lumpSumToday), expected.lumpSum[index], `${label}: case ${index + 1} lump sum`);
    assertEqual(hundred(entry.yearlyAmount), expected.yearly[index], `${label}: case ${index + 1} yearly amount`);
    assertEqual(entry.savingYears, expected.savingYears[index], `${label}: case ${index + 1} years of saving`);
    assertEqual(hundred(entry.paidIn), expected.paidIn[index], `${label}: case ${index + 1} paid in`);
    // Growth on screen is total minus paid in AS SHOWN, never rounded alone.
    assertEqual(
      hundred(totalCost) - hundred(entry.paidIn),
      expected.growth[index],
      `${label}: case ${index + 1} growth`
    );
    assertWithin(
      entry.openingBalanceAtCostStart,
      expected.openingAtCostStart,
      100,
      `${label}: case ${index + 1} opening balance at the cost start`
    );
  });
  projection.debug.costYears.forEach((entry, index) => {
    assertEqual(hundred(entry.cost), expected.costs[index], `${label}: cost year ${index + 1}`);
  });
}

function checkInvariants(projection, label) {
  const { cases, totalCost } = projection.debug;
  const reference = cases[0].openingBalanceAtCostStart;
  cases.forEach((entry) => {
    const last = entry.rows[entry.rows.length - 1];
    assertWithin(last.closingBalance, 0, 0.01, `${label}/${entry.id}: closing balance in the last cost year`);
    entry.rows.forEach((row) => {
      assert(row.closingBalance >= -0.01, `${label}/${entry.id}: balance negative in year ${row.yearIndex}`);
      assert(row.openingBalance >= -0.01, `${label}/${entry.id}: opening balance negative in year ${row.yearIndex}`);
    });
    assertWithin(
      entry.openingBalanceAtCostStart,
      reference,
      0.01,
      `${label}/${entry.id}: opening balance at the cost start differs between cases`
    );
    assertWithin(entry.paidIn + entry.growth, totalCost, 1e-6, `${label}/${entry.id}: paidIn + growth`);
  });
}

function bankOrBannedWording(text) {
  return /Bank of Ireland|AIB|Permanent TSB|PTSB|Revolut|p\.a\.|we recommend|you should|best option|\bbest\b|\bideal\b|\boptimal\b/i.test(text);
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

export function runFutureCostFundTests() {
  const cases = [];

  cases.push(runCase('Central defaults: every figure in the sample table, to the nearest €100', () => {
    const projection = computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, { calculationYear: 2026 });
    checkAgainstTable(projection, FUTURE_COST_FUND_EXPECTED.central, 'central');
  }));

  cases.push(runCase('Design fixture, injected through the options: every figure in the design table', () => {
    const projection = computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, designFixtureOptions());
    checkAgainstTable(projection, FUTURE_COST_FUND_EXPECTED.design, 'design');
  }));

  cases.push(runCase('Invariants hold for every case of both fixtures', () => {
    checkInvariants(computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, { calculationYear: 2026 }), 'central');
    checkInvariants(computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, designFixtureOptions()), 'design');
  }));

  cases.push(runCase('Edge shapes close at zero: one saving year, one cost year, a long run, a general cost', () => {
    const shapes = [
      { startsInYears: 1, durationYears: 1 },
      { startsInYears: 1, durationYears: 4 },
      { startsInYears: 12, durationYears: 1 },
      { startsInYears: 3, durationYears: 25 },
      { startsInYears: 30, durationYears: 30, costKind: 'general' }
    ];
    shapes.forEach((shape) => {
      const projection = computeFutureCostFundProjection({
        ...FUTURE_COST_FUND_SAMPLE,
        scenarios: [{ id: 'a', lumpShare: 0 }, { id: 'b', lumpShare: 0.3 }, { id: 'c', lumpShare: 1 }],
        ...shape
      }, { calculationYear: 2026 });
      checkInvariants(projection, JSON.stringify(shape));
    });
  }));

  cases.push(runCase('Rates come from the central assumptions and the tax catalogue, not from a payload', () => {
    const education = computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, { calculationYear: 2026 });
    const used = education.debug.assumptionsUsed;
    assertEqual(used.priceGrowthRate, 0.04, 'an education cost grows at 4%');
    assertEqual(used.priceGrowthSource, 'inflation.educationRate', 'education source');
    assertEqual(used.cashRateGross, 0.002, 'the central cash rate is 0.2%');
    assertEqual(used.dirtRate, resolveTaxRules(2026).dirt.rate, 'DIRT is read from the tax catalogue');
    assertEqual(used.cashRateNet, 0.002 * (1 - resolveTaxRules(2026).dirt.rate), 'net rate is gross x (1 - DIRT), exactly');
    assertEqual(used.assumptionsVersion, PLANEIR_ASSUMPTIONS_VERSION, 'assumptions version named');
    assertEqual(used.taxRulesVersion, IE_TAX_RULES_VERSION, 'tax rules version named');
    assertEqual(used.dirtRuleId, 'ie.dirt.2026', 'DIRT rule named');

    const general = computeFutureCostFundProjection(
      { ...FUTURE_COST_FUND_SAMPLE, costKind: 'general' },
      { calculationYear: 2026 }
    );
    assertEqual(general.debug.assumptionsUsed.priceGrowthRate, 0.02, 'a general cost grows at 2%');
    assertEqual(general.debug.assumptionsUsed.priceGrowthSource, 'inflation.generalRate', 'general source');
  }));

  cases.push(runCase('The fund follows the DIRT rule in the catalogue: the engine holds no copy', () => {
    const block = DEFAULT_IE_TAX_CATALOGUE.rulesByYear[2026];
    const withDirt = (rate) => ({
      ...DEFAULT_IE_TAX_CATALOGUE,
      rulesByYear: {
        ...DEFAULT_IE_TAX_CATALOGUE.rulesByYear,
        2026: { ...block, dirt: { ...block.dirt, rate } }
      }
    });
    const none = computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, { calculationYear: 2026, taxCatalogue: withDirt(0) });
    const half = computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, { calculationYear: 2026, taxCatalogue: withDirt(0.5) });
    const central = computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, { calculationYear: 2026 });
    assertEqual(none.debug.assumptionsUsed.cashRateNet, 0.002, 'no DIRT: net equals gross');
    assertEqual(half.debug.assumptionsUsed.cashRateNet, 0.001, 'DIRT 50%: net is half');
    assert(none.debug.requiredToday < central.debug.requiredToday, 'less DIRT, less to set aside today');
    assert(half.debug.requiredToday > central.debug.requiredToday, 'more DIRT, more to set aside today');
    assert(
      half.debug.cases[0].lumpSumToday > central.debug.cases[0].lumpSumToday,
      'the lump sum follows the rate in the catalogue'
    );
  }));

  cases.push(runCase('Rejections carry the exact messages', () => {
    const base = FUTURE_COST_FUND_SAMPLE;
    const normalise = (patch) => () => normalizeFutureCostFundInputs({ ...base, ...patch });

    assertThrows(
      normalise({ scenarios: [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}` })) }),
      'generated.futureCostFundInputs.scenarios supports at most 4 cases; received 5.',
      'a fifth case'
    );
    assertThrows(
      normalise({ scenarios: [{ id: 'a' }, { id: 'a', lumpShare: 1 }] }),
      'generated.futureCostFundInputs.scenarios[1].id must be unique.',
      'a duplicate id'
    );
    assertThrows(
      normalise({ scenarios: [{ id: 'a', colour: 'blue' }] }),
      'generated.futureCostFundInputs.scenarios[0] (Save every year): "colour" is not a case field.',
      'an unknown case key'
    );
    assertThrows(
      normalise({ scenarios: [{ id: 'a' }, { id: 'b', title: 'Start in 3 years', savingStartsInYears: 8 }] }),
      'generated.futureCostFundInputs.scenarios[1] (Start in 3 years): savingStartsInYears must be less than startsInYears.',
      'a delayed start at the cost start'
    );
    assertThrows(
      normalise({ scenarios: [{ id: 'a', title: 'Late', savingStartsInYears: 9 }] }),
      'generated.futureCostFundInputs.scenarios[0] (Late): savingStartsInYears must be less than startsInYears.',
      'a delayed start after the cost start'
    );
    assertThrows(
      normalise({ baseScenarioId: 'nope' }),
      'generated.futureCostFundInputs.baseScenarioId must match a case id.',
      'a bad baseScenarioId'
    );
    assertThrows(
      normalise({ scenarios: [{ id: 'a', lumpShare: 1.2 }] }),
      'generated.futureCostFundInputs.scenarios[0] (a): lumpShare must be a number from 0 to 1.',
      'a share above 1'
    );
    assertThrows(
      normalise({ scenarios: [{ id: 'a', lumpShare: -0.1 }] }),
      'generated.futureCostFundInputs.scenarios[0] (a): lumpShare must be a number from 0 to 1.',
      'a share below 0'
    );
    assertThrows(
      normalise({ costKind: undefined }),
      'generated.futureCostFundInputs.costKind must be "education" or "general".',
      'a missing costKind'
    );
    assertThrows(
      normalise({ costKind: 'medical' }),
      'generated.futureCostFundInputs.costKind must be "education" or "general".',
      'an invalid costKind'
    );
    ['priceGrowthRate', 'savingsGrowthRate', 'inflationRate', 'dirtRate'].forEach((field) => {
      assertThrows(
        normalise({ [field]: 0.03 }),
        `generated.futureCostFundInputs.${field} is not accepted. Rates are set centrally in the Planéir assumptions.`,
        `a ${field} in the payload`
      );
    });
    assertThrows(
      normalise({ startsInYears: 2.5 }),
      'generated.futureCostFundInputs.startsInYears must be a whole number of years from 1 to 40.',
      'a fractional start'
    );
    assertThrows(
      normalise({ durationYears: 31 }),
      'generated.futureCostFundInputs.durationYears must be a whole number of years from 1 to 30.',
      'a duration over 30'
    );
    assertThrows(
      normalise({ annualCostToday: 0 }),
      'generated.futureCostFundInputs.annualCostToday must be greater than 0.',
      'a cost of nothing'
    );
    assertThrows(
      normalise({ costTitle: 'x'.repeat(61) }),
      'generated.futureCostFundInputs.costTitle must be 1 to 60 characters.',
      'a title over 60 characters'
    );
  }));

  cases.push(runCase('Projection years are bounded before calculating or allocating rows', () => {
    const projection = computeFutureCostFundProjection({
      ...FUTURE_COST_FUND_SAMPLE,
      startsInYears: 40,
      durationYears: 30
    }, { calculationYear: 2026 });
    checkInvariants(projection, 'maximum supported years');
    projection.debug.cases.forEach((entry) => {
      assertEqual(entry.rows.length, 70, 'the maximum number of annual rows');
    });

    [41, 100, 1_000_000_000, Number.MAX_SAFE_INTEGER].forEach((startsInYears) => {
      const payload = { ...FUTURE_COST_FUND_SAMPLE, startsInYears };
      const message = 'generated.futureCostFundInputs.startsInYears must be a whole number of years from 1 to 40.';
      assertThrows(() => normalizeFutureCostFundInputs(payload), message, `normalising a ${startsInYears}-year start`);
      assertThrows(() => computeFutureCostFundProjection(payload), message, `projecting a ${startsInYears}-year start`);
    });
  }));

  cases.push(runCase('The normaliser is idempotent, and cases get plain default titles', () => {
    const once = normalizeFutureCostFundInputs(FUTURE_COST_FUND_SAMPLE);
    const twice = normalizeFutureCostFundInputs(once);
    assertEqual(JSON.stringify(twice), JSON.stringify(once), 'normalising twice');
    assertEqual(
      JSON.stringify(getFutureCostFundCases(FUTURE_COST_FUND_SAMPLE).map((entry) => entry.title)),
      JSON.stringify(['Lump sum today', 'Save every year', 'Part now, part each year', 'Start in 3 years']),
      'default titles'
    );
    assertEqual(getDefaultFutureCostFundScenarioId(FUTURE_COST_FUND_SAMPLE), 'lump', 'first case is the default');
    assertEqual(
      getDefaultFutureCostFundScenarioId({ ...FUTURE_COST_FUND_SAMPLE, baseScenarioId: 'half' }),
      'half',
      'baseScenarioId is honoured'
    );
  }));

  cases.push(runCase('A lump sum that covers the whole cost ignores a saving start', () => {
    const normalized = normalizeFutureCostFundInputs({
      ...FUTURE_COST_FUND_SAMPLE,
      scenarios: [{ id: 'a', lumpShare: 1, savingStartsInYears: 99 }]
    });
    assertEqual(normalized.scenarios[0].savingStartsInYears, 0, 'ignored, not refused');
  }));

  cases.push(runCase('The cash assumption is central, labelled, and never names a provider to a client', () => {
    assertEqual(PLANEIR_ASSUMPTIONS.cash.instantAccessGrossRate, 0.002, 'central gross rate');
    const record = assumptionRecord('cashRate');
    assert(record && record.key === 'cashGrowthRate' && record.value === 0.002, 'assumptionRecord(cashRate)');
    assertEqual(assumptionLabel('cashGrowthRate'), 'Interest on money held in cash', 'approved label');
    assert(!bankOrBannedWording(record.reason), 'the record reason names no provider');
    assert(!bankOrBannedWording(PLANEIR_ASSUMPTIONS.cash.basis), 'basis names no provider');
    assert(!bankOrBannedWording(PLANEIR_ASSUMPTIONS.cash.disclosure), 'disclosure names no provider');
    assert(PLANEIR_ASSUMPTIONS.cash.observed.length === 2, 'the audit trail keeps the two observed rates');
    assert(
      PLANEIR_ASSUMPTIONS.cash.observed.every((entry) => entry.url && entry.effective),
      'each observed rate keeps its source and date'
    );
  }));

  cases.push(runCase('Engine text and tables hold no provider name, "p.a." or banned phrase', () => {
    const projection = computeFutureCostFundProjection(FUTURE_COST_FUND_SAMPLE, { calculationYear: 2026 });
    const text = collectStrings({
      assumptionsTable: projection.assumptionsTable,
      outputsTable: projection.outputsTable,
      tables: projection.tables,
      charts: projection.charts
    });
    text.forEach((entry) => assert(!bankOrBannedWording(entry), `banned wording in "${entry}"`));
    const rateRows = projection.assumptionsTable.rows.map((row) => row[1]).join(' | ');
    assert(rateRows.includes('4% a year'), 'the price rate is shown whole');
    assert(rateRows.includes('0.2% a year') && rateRows.includes('0.13% a year'), 'cash before and after DIRT');
    assert(rateRows.includes('33%'), 'DIRT is stated');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };

  if (failed > 0) {
    console.warn('[FutureCostFundTests] Completed with failures', summary);
  } else {
    console.info('[FutureCostFundTests] All tests passed', { total: summary.total, passed: summary.passed });
  }

  return summary;
}
