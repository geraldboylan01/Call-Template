import { computeCollegeFundingProjection } from './college_funding_math.js';

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
    console.info(`[CollegeFundingTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[CollegeFundingTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

const TWINS_INPUTS = Object.freeze({
  currentYear: 2026,
  childrenCount: 2,
  childCurrentAge: 13,
  collegeStartAge: 18,
  collegeDurationYears: 4,
  inflationRate: 0.02,
  scenarios: [
    {
      id: 'at-home-no-car',
      title: 'At home, no car support',
      category: 'At home',
      annualCostTodayPerChild: 5000,
      oneOffCostTodayPerChild: 0
    },
    {
      id: 'at-home-with-car',
      title: 'At home, with car support',
      category: 'At home',
      annualCostTodayPerChild: 5000,
      oneOffCostTodayPerChild: 10000
    },
    {
      id: 'away-no-car',
      title: 'Away from home, no car support',
      category: 'Away from home',
      annualCostTodayPerChild: 15000,
      oneOffCostTodayPerChild: 0
    },
    {
      id: 'away-with-car',
      title: 'Away from home, with car support',
      category: 'Away from home',
      annualCostTodayPerChild: 15000,
      oneOffCostTodayPerChild: 10000,
      tone: 'warning'
    }
  ]
});

export function runCollegeFundingMathTests() {
  const cases = [];

  cases.push(runCase('Computes today and nominal costs over the college years', () => {
    const projection = computeCollegeFundingProjection(TWINS_INPUTS);
    const atHome = projection.debug.scenarios.find((scenario) => scenario.id === 'at-home-no-car');
    const expectedNominal = 10000 * (
      Math.pow(1.02, 5)
      + Math.pow(1.02, 6)
      + Math.pow(1.02, 7)
      + Math.pow(1.02, 8)
    );

    assertApprox(atHome.costToday, 40000, 0.01, 'Today cost mismatch');
    assertApprox(atHome.nominalCost, expectedNominal, 0.01, 'Nominal cost mismatch');
  }));

  cases.push(runCase('Includes one-off support in the first college year only', () => {
    const projection = computeCollegeFundingProjection(TWINS_INPUTS);
    const stress = projection.debug.stressScenario;

    assert(stress.id === 'away-with-car', 'Stress scenario should use warning/highest scenario');
    assert(stress.oneOffNominalSeries[0] > 0, 'One-off support should appear in year one');
    assert(stress.oneOffNominalSeries.slice(1).every((value) => value === 0), 'One-off support should not repeat');
  }));

  cases.push(runCase('Builds scenario, timeline and support impact charts', () => {
    const projection = computeCollegeFundingProjection(TWINS_INPUTS);
    const titles = projection.charts.map((chart) => chart.title);

    assert(titles.includes('College Funding Scenarios'), 'Scenario chart missing');
    assert(titles.some((title) => title.startsWith('Funding Timeline -')), 'Timeline chart missing');
    assert(titles.includes('Impact of One-Off Support'), 'Support impact chart missing');
    assert(projection.charts.every((chart) => chart.display?.valueFormat === 'currency'), 'Charts should use currency formatting');
  }));

  const summary = {
    total: cases.length,
    passed: cases.filter((result) => result.pass).length,
    failed: cases.filter((result) => !result.pass)
  };

  if (summary.failed.length > 0) {
    throw new Error(`${summary.failed.length} college funding math test(s) failed.`);
  }

  console.info('[CollegeFundingTests] All tests passed', summary);
  return summary;
}
