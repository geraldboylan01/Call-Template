import {
  computeNetRetirementProjection,
  getNetRetirementScenarioCases,
  normalizeNetRetirementInputs
} from './net_retirement_math.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertApprox(actual, expected, tolerance, message) {
  const delta = Math.abs(actual - expected);
  if (delta > tolerance) {
    throw new Error(`${message} (expected ${expected}, got ${actual}, delta ${delta})`);
  }
}

function runCase(name, testFn) {
  try {
    testFn();
    console.info(`[NetRetirementTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[NetRetirementTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

const CLIENT_INPUTS = Object.freeze({
  currentYear: 2026,
  currentAge: 60,
  horizonEndAge: 100,
  annualExpenditureToday: 90000,
  expenditureInflationRate: 0,
  presentValueRate: 0,
  availableInvestmentFundToday: 1027000,
  incomeSources: [
    {
      id: 'irish-rent',
      title: 'Irish rental income',
      annualAmountToday: 10000,
      startAge: 60,
      inflationIndexed: false
    },
    {
      id: 'eu-rent',
      title: 'Non-Irish EU rental income',
      annualAmountToday: 14000,
      startAge: 60,
      inflationIndexed: false
    },
    {
      id: 'half-irish-state-pension',
      title: '50% Irish State Pension',
      annualAmountToday: 7781.8,
      startAge: 66,
      inflationIndexed: false
    }
  ],
  baseScenarioId: 'keep-irish-rental',
  scenarios: [
    {
      id: 'keep-irish-rental',
      title: 'Keep Irish rental property',
      availableInvestmentFundToday: 1027000
    },
    {
      id: 'sell-irish-rental',
      title: 'Sell Irish rental property',
      availableInvestmentFundToday: 1477000,
      excludedIncomeSourceIds: ['irish-rent']
    }
  ]
});

export function runNetRetirementMathTests() {
  const cases = [];

  cases.push(runCase('Computes annual net shortfall with and without rental income', () => {
    const keep = computeNetRetirementProjection(CLIENT_INPUTS, { scenarioId: 'keep-irish-rental' });
    const sell = computeNetRetirementProjection(CLIENT_INPUTS, { scenarioId: 'sell-irish-rental' });

    assertApprox(keep.debug.annualRows[0].netShortfall, 66000, 0.01, 'Keep case first-year shortfall mismatch');
    assertApprox(sell.debug.annualRows[0].netShortfall, 76000, 0.01, 'Sell case first-year shortfall mismatch');
    assertApprox(keep.debug.annualRows[6].netShortfall, 58218.2, 0.01, 'Keep case age-66 shortfall mismatch');
    assertApprox(sell.debug.annualRows[6].netShortfall, 68218.2, 0.01, 'Sell case age-66 shortfall mismatch');
  }));

  cases.push(runCase('Uses present value logic for the required net fund', () => {
    const twoYearInputs = {
      currentYear: 2026,
      currentAge: 60,
      horizonEndAge: 61,
      annualExpenditureToday: 100,
      expenditureInflationRate: 0,
      presentValueRate: 0.1,
      incomeSources: [],
      scenarios: [{ id: 'base', title: 'Base' }]
    };
    const projection = computeNetRetirementProjection(twoYearInputs);
    assertApprox(projection.debug.requiredFundToday, 100 + (100 / 1.1), 0.01, 'PV required fund mismatch');
    assertApprox(projection.debug.scenario.requiredFundPath[0], projection.debug.requiredFundToday, 0.01, 'Required fund path start mismatch');
    assertApprox(projection.debug.scenario.requiredFundPath[1], 100, 0.01, 'Required fund path final year mismatch');
  }));

  cases.push(runCase('Keeps available fund path at zero after depletion', () => {
    const projection = computeNetRetirementProjection({
      ...CLIENT_INPUTS,
      availableInvestmentFundToday: 50000,
      scenarios: [{ id: 'base', title: 'Base', availableInvestmentFundToday: 50000 }]
    });
    const path = projection.debug.scenario.availableFundPath;
    const firstZeroIndex = path.findIndex((value) => value === 0);

    assert(firstZeroIndex >= 0, 'Expected available fund path to reach zero');
    assert(path.every((value) => value >= 0), 'Available fund path should never be negative');
    assert(path.slice(firstZeroIndex).every((value) => value === 0), 'Available fund path should stay at zero after depletion');
  }));

  cases.push(runCase('Builds scenario cases and annual shortfall table', () => {
    const projection = computeNetRetirementProjection(CLIENT_INPUTS);
    const scenarioCases = getNetRetirementScenarioCases(CLIENT_INPUTS);
    const annualChart = projection.charts.find((chart) => chart.title === 'Net Income vs Expenditure');
    const requiredFundChart = projection.charts.find((chart) => chart.title === 'Required Net Investment Fund');

    assert(scenarioCases.length === 2, 'Expected two scenario cases');
    assert(scenarioCases[1].detail.includes('required net fund today'), 'Scenario detail should summarize required fund');
    assert(projection.tables[0].title === 'Annual Net Shortfall', 'Annual shortfall table missing');
    assert(projection.tables[0].rows.length === 41, 'Age 60 to 100 should produce 41 annual rows');
    assert(projection.charts.length === 2, 'Expected two charts');
    assert(annualChart.labels[0] === '60', 'Annual chart should default to client age on the x-axis');
    assert(annualChart.labels[annualChart.labels.length - 1] === '100', 'Annual chart should run to age 100 by default');
    assert(annualChart.display.xAxisTitle === 'Client age', 'Annual chart x-axis should be labelled by client age');
    assert(annualChart.display.stacked === true, 'Annual chart should use stacked bars for income sources');
    assert(annualChart.datasets.length === 4, 'Annual chart should show three income sources plus expenditure');
    assert(annualChart.datasets.some((dataset) => dataset.label === 'Irish rental income' && dataset.type === 'bar' && dataset.stack === 'net-income'), 'Irish rental income should be a stacked bar dataset');
    assert(annualChart.datasets.some((dataset) => dataset.label === 'Non-Irish EU rental income' && dataset.type === 'bar' && dataset.stack === 'net-income'), 'EU rental income should be a stacked bar dataset');
    assert(annualChart.datasets.some((dataset) => dataset.label === '50% Irish State Pension' && dataset.type === 'bar' && dataset.stack === 'net-income'), 'State Pension income should be a stacked bar dataset');
    assert(annualChart.datasets.filter((dataset) => dataset.type === 'bar').every((dataset) => typeof dataset.backgroundColor === 'string' && dataset.backgroundColor), 'Income bars should have source colours');
    assert(annualChart.datasets.some((dataset) => dataset.label === 'Net expenditure' && dataset.type === 'line'), 'Net expenditure should be a line dataset');
    assert(!annualChart.datasets.some((dataset) => dataset.label === 'Net income'), 'Aggregate net income should not hide the source-level stack');
    assert(!annualChart.datasets.some((dataset) => dataset.label === 'Annual net shortfall'), 'Net shortfall should not be plotted directly');
    assert(requiredFundChart.labels[0] === '60', 'Required fund chart should default to client age on the x-axis');
    assert(requiredFundChart.labels[requiredFundChart.labels.length - 1] === '100', 'Required fund chart should run to age 100 by default');
    assert(requiredFundChart.display.xAxisTitle === 'Client age', 'Required fund chart x-axis should be labelled by client age');
    assert(requiredFundChart.display.yMin === 0, 'Required fund chart should set a zero y-axis floor');
  }));

  cases.push(runCase('Accepts normalized null optional fields on a second pass', () => {
    const normalized = normalizeNetRetirementInputs(CLIENT_INPUTS);
    assert(normalized.incomeSources[0].endYear === null, 'Expected normalized income source endYear to be null');
    assert(normalized.scenarios[0].annualExpenditureToday === null, 'Expected normalized scenario expenditure override to be null');
    const projection = computeNetRetirementProjection(normalized);
    assertApprox(projection.debug.annualRows[0].netShortfall, 66000, 0.01, 'Second-pass normalized inputs mismatch');
  }));

  const summary = {
    total: cases.length,
    passed: cases.filter((result) => result.pass).length,
    failed: cases.filter((result) => !result.pass)
  };

  if (summary.failed.length > 0) {
    throw new Error(`${summary.failed.length} net retirement math test(s) failed.`);
  }

  console.info('[NetRetirementTests] All tests passed', summary);
  return summary;
}
