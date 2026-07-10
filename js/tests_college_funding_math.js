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

const MIXED_AGE_INPUTS = Object.freeze({
  currentYear: 2026,
  children: [
    {
      id: 'eldest',
      title: 'Eldest child',
      currentAge: 2,
      collegeStartAge: 18,
      collegeDurationYears: 4
    },
    {
      id: 'twin-1',
      title: 'Twin 1',
      currentAge: 0,
      collegeStartAge: 18,
      collegeDurationYears: 4
    },
    {
      id: 'twin-2',
      title: 'Twin 2',
      currentAge: 0,
      collegeStartAge: 18,
      collegeDurationYears: 4
    }
  ],
  inflationRate: 0,
  scenarios: [
    {
      id: 'at-home',
      title: 'At home',
      category: 'At home',
      annualCostTodayPerChild: 1000,
      oneOffCostTodayPerChild: 100
    },
    {
      id: 'away',
      title: 'Away from home',
      category: 'Away from home',
      annualCostTodayPerChild: 2000,
      oneOffCostTodayPerChild: 100
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

  cases.push(runCase('Builds child profile, scenario and support impact charts', () => {
    const projection = computeCollegeFundingProjection(TWINS_INPUTS);
    const titles = projection.charts.map((chart) => chart.title);

    assert(titles.includes('Annual Funding Profile by Child'), 'Child-level annual profile chart missing');
    assert(titles.includes('College Funding Scenarios'), 'Scenario chart missing');
    assert(titles.includes('Impact of One-Off Support'), 'Support impact chart missing');
    assert(projection.charts.every((chart) => chart.display?.valueFormat === 'currency'), 'Charts should use currency formatting');
  }));

  cases.push(runCase('Uses child-level timing for mixed-age siblings', () => {
    const projection = computeCollegeFundingProjection(MIXED_AGE_INPUTS);
    const atHome = projection.debug.scenarios.find((scenario) => scenario.id === 'at-home');

    assert(projection.debug.inputs.childrenCount === 3, 'childrenCount should be derived from children[]');
    assert(projection.debug.collegeStartYear === 2042, 'Family funding should start when eldest starts college');
    assert(projection.debug.collegeEndYear === 2047, 'Family funding should end when twins finish college');
    assert(projection.debug.fundingPeriodYears === 6, 'Family funding period should last six years');
    assert(atHome.labels.join(',') === '2042,2043,2044,2045,2046,2047', 'Unexpected funding timeline labels');
    assert(atHome.childrenAttendingSeries.join(',') === '1,1,3,3,2,2', 'Unexpected children attending series');
    assert(atHome.annualTodaySeries.join(',') === '1000,1000,3000,3000,2000,2000', 'Unexpected annual cost profile');
    assert(atHome.oneOffTodaySeries.join(',') === '100,0,200,0,0,0', 'One-off support should follow each child first year');
  }));

  cases.push(runCase('Builds annual tables with one child column per child', () => {
    const projection = computeCollegeFundingProjection(MIXED_AGE_INPUTS);
    const atHomeTable = projection.tables.find((table) => table.title === 'At home Annual Funding Profile');

    assert(atHomeTable, 'At-home annual funding table missing');
    assert(atHomeTable.columns.join('|') === 'Year|Eldest child|Twin 1|Twin 2|Children attending|Annual family cost', 'Unexpected annual table columns');
    assert(atHomeTable.rows.length === 6, 'Annual table should cover six years');
    assert(atHomeTable.rows[0].join('|') === '2042|1100|-|-|1|1100', 'Unexpected first annual row');
    assert(atHomeTable.rows[2].join('|') === '2044|1000|1100|1100|3|3200', 'Unexpected overlap annual row');
  }));

  cases.push(runCase('Builds stacked child datasets per scenario', () => {
    const projection = computeCollegeFundingProjection(MIXED_AGE_INPUTS);
    const profileChart = projection.charts.find((chart) => chart.title === 'Annual Funding Profile by Child');

    assert(profileChart, 'Annual profile chart missing');
    assert(profileChart.display?.stacked === true, 'Annual profile chart should be stacked');
    assert(profileChart.datasets.length === MIXED_AGE_INPUTS.children.length * MIXED_AGE_INPUTS.scenarios.length, 'Unexpected child scenario dataset count');
    assert(profileChart.datasets.every((dataset) => typeof dataset.stack === 'string' && dataset.stack), 'Every annual profile dataset should belong to a scenario stack');
  }));

  cases.push(runCase('Rejects invalid child-level timing', () => {
    let duplicateRejected = false;
    try {
      computeCollegeFundingProjection({
        ...MIXED_AGE_INPUTS,
        children: [
          MIXED_AGE_INPUTS.children[0],
          { ...MIXED_AGE_INPUTS.children[1], id: 'eldest' }
        ]
      });
    } catch (_error) {
      duplicateRejected = true;
    }

    let startAgeRejected = false;
    try {
      computeCollegeFundingProjection({
        ...MIXED_AGE_INPUTS,
        children: [
          { ...MIXED_AGE_INPUTS.children[0], collegeStartAge: 2 }
        ]
      });
    } catch (_error) {
      startAgeRejected = true;
    }

    let negativeInflationRejected = false;
    try {
      computeCollegeFundingProjection({
        ...MIXED_AGE_INPUTS,
        inflationRate: -0.01
      });
    } catch (_error) {
      negativeInflationRejected = true;
    }

    assert(duplicateRejected, 'Duplicate child ids should be rejected');
    assert(startAgeRejected, 'College start age must be greater than current age');
    assert(negativeInflationRejected, 'Negative inflation should be rejected');
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
