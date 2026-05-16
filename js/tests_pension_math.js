import { computePensionProjection } from './pension_math.js';

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
    console.info(`[PensionTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[PensionTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

const BASE_TARGET_INPUTS = Object.freeze({
  currentAge: 42,
  retirementAge: 67,
  currentSalary: 85000,
  currentPot: 180000,
  personalPct: 0.08,
  employerPct: 0.06,
  growthRate: 0.05,
  inflationRate: 0.02,
  wageGrowthRate: 0.025,
  horizonEndAge: 92,
  currentYear: 2026,
  incomeMode: 'target',
  targetIncomeToday: 42000
});

const COUPLE_INPUTS = Object.freeze({
  currentYear: 2026,
  inflationRate: 0.02,
  growthRate: 0.05,
  wageGrowthRate: 0.025,
  incomeMode: 'target',
  targetIncomeToday: 70000,
  targetStartYear: 2052,
  horizonEndAge: 95,
  pensions: [
    {
      id: 'john',
      title: 'John',
      currentAge: 42,
      retirementAge: 67,
      currentSalary: 85000,
      currentPot: 180000,
      personalPct: 0.08,
      employerPct: 0.06
    },
    {
      id: 'mary',
      title: 'Mary',
      currentAge: 40,
      retirementAge: 66,
      currentSalary: 70000,
      currentPot: 120000,
      personalPct: 0.07,
      employerPct: 0.05
    }
  ]
});

export function runPensionMathTests() {
  const cases = [];

  cases.push(runCase('Rental income indexes from today to retirement', () => {
    const projection = computePensionProjection({
      ...BASE_TARGET_INPUTS,
      rentalIncomeToday: 18000
    });
    const expected = 18000 * Math.pow(1.02, 25);
    assertApprox(
      projection.debug.rentalIncomeNominalAtRetirement,
      expected,
      0.01,
      'Rental income at retirement mismatch'
    );
  }));

  cases.push(runCase('Target-mode required pot falls when rental income is present', () => {
    const noRent = computePensionProjection(BASE_TARGET_INPUTS);
    const withRent = computePensionProjection({
      ...BASE_TARGET_INPUTS,
      rentalIncomeToday: 18000
    });

    assert(withRent.debug.requiredPot < noRent.debug.requiredPot, 'Required pot should fall with rental income');
    assert(withRent.debug.pensionWithdrawalNominalAtRetirement < noRent.debug.pensionWithdrawalNominalAtRetirement, 'Pension-funded withdrawal should fall with rental income');
  }));

  cases.push(runCase('Rent-lost scenario restores no-rent required pot', () => {
    const noRent = computePensionProjection(BASE_TARGET_INPUTS);
    const rentLost = computePensionProjection({
      ...BASE_TARGET_INPUTS,
      rentalIncomeToday: 18000,
      baseScenarioId: 'with-rent',
      rentalIncomeScenarios: [
        { id: 'with-rent', title: 'With rental income', rentalIncomeToday: 18000 },
        { id: 'rent-lost', title: 'Rental income lost', rentalIncomeToday: 0 }
      ]
    }, { scenarioId: 'rent-lost' });

    assertApprox(
      rentLost.debug.requiredPot,
      noRent.debug.requiredPot,
      0.01,
      'Rent-lost scenario should match no-rent required pot'
    );
  }));

  cases.push(runCase('Rental income above target floors pension withdrawal at zero', () => {
    const projection = computePensionProjection({
      ...BASE_TARGET_INPUTS,
      targetIncomeToday: 10000,
      rentalIncomeToday: 20000,
      includeStatePension: false
    });

    assertApprox(projection.debug.requiredPot, 0, 0.01, 'Required pot should floor at zero');
    assertApprox(projection.debug.pensionWithdrawalNominalAtRetirement, 0, 0.01, 'Pension withdrawal should floor at zero');
  }));

  cases.push(runCase('Affordable mode reports total income including rent and state pension', () => {
    const projection = computePensionProjection({
      ...BASE_TARGET_INPUTS,
      incomeMode: 'affordable',
      affordableEndAges: [90],
      rentalIncomeToday: 12000
    });
    const current = projection.debug.affordableIncome.current[0];

    assert(current.totalIncomeToday > current.incomeToday + 12000, 'Affordable total income should include rent and default State Pension');
  }));

  cases.push(runCase('No-rent pension payload output stays unchanged when rent is explicitly zero', () => {
    const noRent = computePensionProjection(BASE_TARGET_INPUTS);
    const explicitZeroRent = computePensionProjection({
      ...BASE_TARGET_INPUTS,
      rentalIncomeToday: 0
    });

    assert(
      JSON.stringify(noRent.assumptionsTable) === JSON.stringify(explicitZeroRent.assumptionsTable),
      'Zero-rent assumptions should match no-rent assumptions'
    );
    assert(
      JSON.stringify(noRent.outputsTable) === JSON.stringify(explicitZeroRent.outputsTable),
      'Zero-rent outputs should match no-rent outputs'
    );
  }));

  cases.push(runCase('Two named pensions produce two accumulation charts and one combined drawdown chart', () => {
    const projection = computePensionProjection(COUPLE_INPUTS);
    const titles = projection.charts.map((chart) => chart.title);

    assert(projection.charts.length === 3, 'Couple projection should produce three charts');
    assert(titles.includes('John Pension Pot at Retirement (Before Withdrawals)'), 'John accumulation chart missing');
    assert(titles.includes('Mary Pension Pot at Retirement (Before Withdrawals)'), 'Mary accumulation chart missing');
    assert(titles.includes('Retirement Income Stack and Pension Balance'), 'Combined drawdown chart missing');
    assert(projection.charts[2].datasets.some((dataset) => dataset.label === 'Combined pension balance (current)'), 'Combined balance dataset missing');
    assert(projection.charts[2].datasets.some((dataset) => dataset.label === 'Required income'), 'Required income line missing');
  }));

  cases.push(runCase('Default State Pension applies once per included person and indexes correctly', () => {
    const projection = computePensionProjection(COUPLE_INPUTS);
    const expected = (299.30 * 52 * 2) * Math.pow(1.02, 26);

    assertApprox(
      projection.debug.statePensionNominalAtRetirement,
      expected,
      0.01,
      'State Pension at target start should include both people and index from today'
    );
  }));

  cases.push(runCase('State Pension exclusion works per person', () => {
    const withBoth = computePensionProjection(COUPLE_INPUTS);
    const withMaryExcluded = computePensionProjection({
      ...COUPLE_INPUTS,
      pensions: [
        COUPLE_INPUTS.pensions[0],
        { ...COUPLE_INPUTS.pensions[1], includeStatePension: false }
      ]
    });

    assert(withMaryExcluded.debug.statePensionNominalAtRetirement < withBoth.debug.statePensionNominalAtRetirement, 'Excluded State Pension should reduce state pension income');
    assertApprox(
      withMaryExcluded.debug.statePensionNominalAtRetirement,
      (299.30 * 52) * Math.pow(1.02, 26),
      0.01,
      'Only one State Pension should remain'
    );
  }));

  cases.push(runCase('DB and other income starts and indexes correctly', () => {
    const projection = computePensionProjection({
      ...COUPLE_INPUTS,
      otherIncomeSources: [
        {
          id: 'mary-db',
          title: 'Mary DB pension',
          type: 'db',
          ownerId: 'mary',
          annualAmountToday: 12000,
          startAge: 66,
          inflationIndexed: true
        }
      ]
    });

    assertApprox(
      projection.debug.otherIncomeNominalAtRetirement,
      12000 * Math.pow(1.02, 26),
      0.01,
      'Indexed DB pension should be present at target start'
    );
  }));

  cases.push(runCase('ARF minimum withdrawals apply at 4, 5 and 6 percent', () => {
    const base = {
      currentYear: 2026,
      inflationRate: 0,
      growthRate: 0,
      wageGrowthRate: 0,
      incomeMode: 'target',
      targetIncomeToday: 1,
      horizonEndAge: 61,
      includeStatePension: false,
      currentSalary: 0,
      personalPct: 0,
      employerPct: 0
    };
    const under70 = computePensionProjection({
      ...base,
      currentAge: 60,
      retirementAge: 60,
      currentPot: 100000
    });
    const over70 = computePensionProjection({
      ...base,
      currentAge: 70,
      retirementAge: 70,
      horizonEndAge: 71,
      currentPot: 100000
    });
    const overThreshold = computePensionProjection({
      ...base,
      currentAge: 60,
      retirementAge: 60,
      currentPot: 2100000
    });

    assertApprox(under70.debug.retirementSimulationProjectedCurrent.firstYearMandatoryWithdrawal, 4000, 0.01, 'Under-70 ARF minimum should be 4%');
    assertApprox(over70.debug.retirementSimulationProjectedCurrent.firstYearMandatoryWithdrawal, 5000, 0.01, 'Age-70 ARF minimum should be 5%');
    assertApprox(overThreshold.debug.retirementSimulationProjectedCurrent.firstYearMandatoryWithdrawal, 126000, 0.01, 'Over-€2m ARF minimum should be 6%');
  }));

  cases.push(runCase('Mandatory withdrawal surplus is shown when income exceeds target', () => {
    const projection = computePensionProjection({
      ...BASE_TARGET_INPUTS,
      currentAge: 60,
      retirementAge: 60,
      horizonEndAge: 62,
      currentSalary: 0,
      currentPot: 2500000,
      personalPct: 0,
      employerPct: 0,
      growthRate: 0,
      wageGrowthRate: 0,
      inflationRate: 0,
      targetIncomeToday: 10000,
      includeStatePension: false
    });

    assert(projection.debug.retirementSimulationProjectedCurrent.surpluses[0] > 0, 'Mandatory withdrawal surplus should be shown');
  }));

  cases.push(runCase('Target-mode required-pot solver works around ARF threshold', () => {
    const projection = computePensionProjection({
      ...BASE_TARGET_INPUTS,
      currentAge: 60,
      retirementAge: 60,
      horizonEndAge: 95,
      currentSalary: 0,
      currentPot: 0,
      personalPct: 0,
      employerPct: 0,
      growthRate: 0.03,
      wageGrowthRate: 0,
      inflationRate: 0.02,
      targetIncomeToday: 120000,
      includeStatePension: false
    });

    assert(Number.isFinite(projection.debug.requiredPot) && projection.debug.requiredPot > 0, 'Required pot should be finite');
    assert(projection.debug.retirementSimulationRequired.maxShortfall <= 25, 'Required simulation should not leave material shortfall');
  }));

  cases.push(runCase('Affordable mode goal seek remains stable with external income and mandatory withdrawals', () => {
    const projection = computePensionProjection({
      ...COUPLE_INPUTS,
      incomeMode: 'affordable',
      affordableEndAges: [90],
      rentalIncomeToday: 18000,
      otherIncomeSources: [
        {
          id: 'db',
          title: 'DB pension',
          type: 'db',
          ownerId: 'john',
          annualAmountToday: 9000,
          startAge: 67,
          inflationIndexed: true
        }
      ]
    });
    const result = projection.debug.affordableIncome.current[0];

    assert(Number.isFinite(result.totalIncomeToday) && result.totalIncomeToday > 0, 'Affordable total income should be finite');
    assert(result.totalIncomeToday > result.incomeToday, 'Affordable total should include non-pension income');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = {
    total: cases.length,
    passed,
    failed,
    results: cases
  };

  if (failed > 0) {
    console.warn('[PensionTests] Completed with failures', summary);
  } else {
    console.info('[PensionTests] All tests passed', summary);
  }

  return summary;
}
