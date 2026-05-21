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
  wageGrowthRate: 0.02,
  horizonEndAge: 92,
  currentYear: 2026,
  incomeMode: 'target',
  targetIncomeToday: 42000
});

const COUPLE_INPUTS = Object.freeze({
  currentYear: 2026,
  inflationRate: 0.02,
  growthRate: 0.05,
  wageGrowthRate: 0.02,
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

const USER_SPOUSE_PAYLOAD = Object.freeze({
  currentYear: 2026,
  currentAge: 48,
  retirementAge: 63,
  currentSalary: 175000,
  currentPot: 585000,
  personalPct: 0.0914285714,
  employerPct: 0,
  growthRate: 0.05,
  inflationRate: 0.02,
  wageGrowthRate: 0.02,
  incomeMode: 'target',
  targetIncomeToday: 80000,
  targetStartYear: 2041,
  horizonEndAge: 95,
  rentalIncomeToday: 21600,
  baseScenarioId: 'current-scenario',
  rentalIncomeScenarios: [
    { id: 'current-scenario', title: 'Current scenario', rentalIncomeToday: 21600 },
    { id: 'sell-btl-scenario', title: 'Sell BTL scenario', rentalIncomeToday: 0 }
  ],
  pensions: [
    {
      id: 'user-pension',
      title: 'User pension',
      currentAge: 48,
      retirementAge: 63,
      currentSalary: 100000,
      currentPot: 300000,
      personalPct: 0.1,
      employerPct: 0,
      includeStatePension: true
    },
    {
      id: 'spouse-pension',
      title: 'Spouse pension',
      currentAge: 50,
      retirementAge: 65,
      currentSalary: 75000,
      currentPot: 285000,
      personalPct: 0.08,
      employerPct: 0,
      includeStatePension: true
    }
  ]
});

const STAGGERED_RETIREMENT_INPUTS = Object.freeze({
  currentYear: 2026,
  inflationRate: 0,
  growthRate: 0,
  wageGrowthRate: 0,
  incomeMode: 'target',
  targetIncomeToday: 50000,
  horizonEndAge: 70,
  pensions: [
    {
      id: 'older',
      title: 'Older',
      currentAge: 60,
      retirementAge: 65,
      currentSalary: 100000,
      currentPot: 100000,
      personalPct: 0.1,
      employerPct: 0,
      includeStatePension: false
    },
    {
      id: 'younger',
      title: 'Younger',
      currentAge: 55,
      retirementAge: 65,
      currentSalary: 80000,
      currentPot: 200000,
      personalPct: 0.1,
      employerPct: 0,
      includeStatePension: false
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

  cases.push(runCase('Required pension pot defaults to deplete by age 100', () => {
    const { horizonEndAge, ...inputsWithoutExplicitHorizon } = BASE_TARGET_INPUTS;
    const projection = computePensionProjection({
      ...inputsWithoutExplicitHorizon,
      currentAge: 60,
      retirementAge: 60,
      currentSalary: 0,
      currentPot: 0,
      personalPct: 0,
      employerPct: 0,
      growthRate: 0,
      wageGrowthRate: 0,
      inflationRate: 0,
      targetIncomeToday: 10000,
      includeStatePension: false
    });

    assert(projection.debug.inputs.horizonEndAge === 100, 'Default pension horizon should be age 100');
    assert(
      projection.debug.requiredPotDepletionResidual <= projection.debug.requiredPotDepletionTolerance,
      'Required path should deplete within tolerance by age 100'
    );
  }));

  cases.push(runCase('Explicit horizon age is respected', () => {
    const projection = computePensionProjection(BASE_TARGET_INPUTS);

    assert(projection.debug.inputs.horizonEndAge === 92, 'Explicit horizon age should be respected');
  }));

  cases.push(runCase('Household default horizon uses the later member age-100 year', () => {
    const { horizonEndAge, ...coupleWithoutExplicitHorizon } = COUPLE_INPUTS;
    const projection = computePensionProjection(coupleWithoutExplicitHorizon);
    const maryHorizon = projection.debug.inputs.horizonEndAges.find((entry) => entry.id === 'mary');

    assert(projection.debug.inputs.horizonEndYear === 2086, 'Household default horizon should use later age-100 calendar year');
    assert(maryHorizon?.age === 100, 'Later member should be age 100 at default household horizon');
  }));

  cases.push(runCase('External income covering target suppresses required pot and path', () => {
    const projection = computePensionProjection({
      currentYear: 2026,
      currentAge: 60,
      retirementAge: 60,
      currentSalary: 0,
      currentPot: 0,
      personalPct: 0,
      employerPct: 0,
      growthRate: 0,
      inflationRate: 0,
      wageGrowthRate: 0,
      horizonEndAge: 62,
      incomeMode: 'target',
      targetIncomeToday: 10000,
      rentalIncomeToday: 20000,
      includeStatePension: false
    });
    const outputLabels = projection.outputsTable.rows.map((row) => row[0]);
    const drawdownChart = projection.charts.find((chart) => chart.title === 'Retirement Income Stack and Pension Balance');

    assert(projection.debug.readinessStatus === 'externalIncomeCoversTarget', 'External income should classify as covering target');
    assert(projection.debug.requiredPotIsApplicable === false, 'Required pension pot should not be applicable');
    assert(!outputLabels.some((label) => String(label).startsWith('Required pension pot')), 'Required pension pot row should be suppressed');
    assert(!outputLabels.some((label) => String(label).includes('Gap vs required')), 'Gap row should be suppressed');
    assert(drawdownChart, 'Drawdown chart should still be present');
    assert(!drawdownChart.datasets.some((dataset) => dataset.label === 'Required pension pot path'), 'Required pension pot path should be suppressed');
    assert(projection.debug.readinessSentence.includes('separate required pension pot is not shown'), 'Readiness wording should explain suppression');
  }));

  cases.push(runCase('Current projected pot above required shows surplus wording', () => {
    const projection = computePensionProjection({
      currentYear: 2026,
      currentAge: 60,
      retirementAge: 60,
      currentSalary: 0,
      currentPot: 40000,
      personalPct: 0,
      employerPct: 0,
      growthRate: 0,
      inflationRate: 0,
      wageGrowthRate: 0,
      horizonEndAge: 62,
      incomeMode: 'target',
      targetIncomeToday: 10000,
      includeStatePension: false
    });

    assert(projection.debug.readinessStatus === 'currentOnTrack', 'Current surplus should classify as on track');
    assert(projection.debug.currentSurplusVsRequired > 0, 'Current surplus should be captured');
    assert(projection.outputsTable.rows.some((row) => row[0] === 'Current surplus vs required'), 'Surplus row should be shown');
    assert(projection.debug.readinessSentence.includes('strong position'), 'Readiness wording should be professional and positive');
  }));

  cases.push(runCase('Max contributions can close the required-pot gap', () => {
    const projection = computePensionProjection({
      currentYear: 2026,
      currentAge: 60,
      retirementAge: 62,
      currentSalary: 100000,
      currentPot: 0,
      personalPct: 0,
      employerPct: 0,
      growthRate: 0,
      inflationRate: 0,
      wageGrowthRate: 0,
      horizonEndAge: 64,
      incomeMode: 'target',
      targetIncomeToday: 10000,
      includeStatePension: false
    });

    assert(projection.debug.readinessStatus === 'maxContributionsCloseGap', 'Max contributions should close the gap');
    assert(projection.debug.currentGapVsRequired > 0, 'Current gap should be captured');
    assert(projection.debug.maxGapVsRequired === 0, 'Max path should not leave a gap');
    assert(projection.outputsTable.rows.some((row) => row[0] === 'Max-contribution surplus vs required'), 'Max surplus row should be shown');
  }));

  cases.push(runCase('Shortfall remains after max contributions and shows planning levers', () => {
    const projection = computePensionProjection({
      currentYear: 2026,
      currentAge: 60,
      retirementAge: 60,
      currentSalary: 0,
      currentPot: 0,
      personalPct: 0,
      employerPct: 0,
      growthRate: 0,
      inflationRate: 0,
      wageGrowthRate: 0,
      horizonEndAge: 62,
      incomeMode: 'target',
      targetIncomeToday: 10000,
      includeStatePension: false
    });

    assert(projection.debug.readinessStatus === 'shortfallAfterMax', 'Persistent gap should classify as shortfall after max');
    assert(projection.debug.maxGapVsRequired > 0, 'Max gap should be captured');
    assert(projection.debug.readinessSentence.includes('planning levers'), 'Readiness wording should mention planning levers');
  }));

  cases.push(runCase('Tolerance-sized gaps are treated as on track', () => {
    const projection = computePensionProjection({
      currentYear: 2026,
      currentAge: 60,
      retirementAge: 60,
      currentSalary: 0,
      currentPot: 29960,
      personalPct: 0,
      employerPct: 0,
      growthRate: 0,
      inflationRate: 0,
      wageGrowthRate: 0,
      horizonEndAge: 62,
      incomeMode: 'target',
      targetIncomeToday: 10000,
      includeStatePension: false
    });

    assert(projection.debug.readinessStatus === 'currentOnTrack', 'Small gap should be treated as on track');
    assert(projection.debug.currentGapVsRequired === 0, 'Tolerance-sized gap should be zeroed');
    assert(projection.outputsTable.rows.some((row) => row[1] === 'On track within tolerance'), 'Tolerance row should be shown');
  }));

  cases.push(runCase('Rental-lost scenario can change readiness status', () => {
    const inputs = {
      currentYear: 2026,
      currentAge: 60,
      retirementAge: 60,
      currentSalary: 0,
      currentPot: 0,
      personalPct: 0,
      employerPct: 0,
      growthRate: 0,
      inflationRate: 0,
      wageGrowthRate: 0,
      horizonEndAge: 62,
      incomeMode: 'target',
      targetIncomeToday: 10000,
      rentalIncomeToday: 20000,
      includeStatePension: false,
      baseScenarioId: 'with-rent',
      rentalIncomeScenarios: [
        { id: 'with-rent', title: 'With rent', rentalIncomeToday: 20000 },
        { id: 'rent-lost', title: 'Rent lost', rentalIncomeToday: 0 }
      ]
    };
    const withRent = computePensionProjection(inputs, { scenarioId: 'with-rent' });
    const rentLost = computePensionProjection(inputs, { scenarioId: 'rent-lost' });

    assert(withRent.debug.readinessStatus === 'externalIncomeCoversTarget', 'With-rent scenario should be externally funded');
    assert(rentLost.debug.readinessStatus === 'shortfallAfterMax', 'Rent-lost scenario should show a shortfall');
  }));

  cases.push(runCase('Target-mode required pot falls when rental income is present', () => {
    const noRent = computePensionProjection(BASE_TARGET_INPUTS);
    const withRent = computePensionProjection({
      ...BASE_TARGET_INPUTS,
      rentalIncomeToday: 18000
    });

    assert(withRent.debug.requiredPot < noRent.debug.requiredPot, 'Required pension pot should fall with rental income');
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

  cases.push(runCase('Household other income can start from the primary age without member ownership', () => {
    const projection = computePensionProjection({
      currentYear: 2026,
      inflationRate: 0.02,
      growthRate: 0.05,
      wageGrowthRate: 0.02,
      incomeMode: 'target',
      targetIncomeToday: 50000,
      targetStartAge: 60,
      horizonEndAge: 100,
      pensions: [
        {
          id: 'client',
          title: 'Client DC pension',
          currentAge: 53,
          retirementAge: 60,
          currentSalary: 80000,
          currentPot: 200000,
          personalPct: 0.3,
          employerPct: 0.05,
          includeStatePension: true
        },
        {
          id: 'spouse',
          title: 'Spouse State Pension allowance',
          currentAge: 49,
          retirementAge: 60,
          currentSalary: 0,
          currentPot: 0,
          personalPct: 0,
          employerPct: 0,
          includeStatePension: true
        }
      ],
      otherIncomeSources: [
        {
          id: 'client-db-pension',
          title: 'Defined benefit pension',
          type: 'db',
          ownerId: 'client',
          annualAmountToday: 9000,
          startAge: 66,
          inflationIndexed: true
        },
        {
          id: 'land-lease-income',
          title: 'Land lease income',
          type: 'rental_or_lease_income',
          ownerId: 'household',
          annualAmountToday: 15000,
          startAge: 65,
          inflationIndexed: true,
          inflationRate: 0.02
        }
      ]
    });
    const outputLabels = projection.outputsTable.rows.map((row) => row[0]);

    assert(projection.debug.inputs.otherIncomeSources.length === 2, 'Both other income sources should normalize');
    assert(outputLabels.includes('Defined benefit pension at target start'), 'DB income output row should be listed by name');
    assert(outputLabels.includes('Land lease income at target start'), 'Household income output row should be listed by name');
  }));

  cases.push(runCase('Rental income above target floors pension withdrawal at zero', () => {
    const projection = computePensionProjection({
      ...BASE_TARGET_INPUTS,
      targetIncomeToday: 10000,
      rentalIncomeToday: 20000,
      includeStatePension: false
    });

    assertApprox(projection.debug.requiredPot, 0, 0.01, 'Required pension pot should floor at zero');
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

  cases.push(runCase('Supplied household payload produces two accumulation charts and one combined drawdown chart', () => {
    const projection = computePensionProjection(USER_SPOUSE_PAYLOAD, { scenarioId: 'current-scenario' });
    const titles = projection.charts.map((chart) => chart.title);

    assert(projection.charts.length === 3, 'Household payload should produce three charts');
    assert(titles.includes('User pension pot at retirement (before withdrawals)'), 'User accumulation chart missing');
    assert(titles.includes('Spouse pension pot at retirement (before withdrawals)'), 'Spouse accumulation chart missing');
    assert(titles.includes('Retirement Income Stack and Pension Balance'), 'Combined drawdown chart missing');
  }));

  cases.push(runCase('State Pension-only spouse does not produce an empty accumulation chart', () => {
    const projection = computePensionProjection({
      currentYear: 2026,
      inflationRate: 0.02,
      growthRate: 0.05,
      wageGrowthRate: 0.02,
      incomeMode: 'target',
      targetIncomeToday: 50000,
      targetStartAge: 60,
      horizonEndAge: 100,
      pensions: [
        {
          id: 'client',
          title: 'Client DC pension',
          currentAge: 53,
          retirementAge: 60,
          currentSalary: 80000,
          currentPot: 200000,
          personalPct: 0.3,
          employerPct: 0.05,
          includeStatePension: true
        },
        {
          id: 'spouse',
          title: 'Spouse State Pension allowance',
          currentAge: 49,
          retirementAge: 60,
          currentSalary: 0,
          currentPot: 0,
          personalPct: 0,
          employerPct: 0,
          includeStatePension: true
        }
      ]
    });
    const titles = projection.charts.map((chart) => chart.title);

    assert(projection.charts.length === 2, 'State Pension-only spouse should not add a zero-value accumulation chart');
    assert(titles.includes('Client DC pension pot at retirement (before withdrawals)'), 'Client accumulation chart missing');
    assert(!titles.some((title) => title.includes('Spouse State Pension')), 'State Pension-only spouse accumulation chart should be omitted');
    assert(titles.includes('Retirement Income Stack and Pension Balance'), 'Combined drawdown chart missing');
  }));

  cases.push(runCase('Same household retirement year creates no bridge period', () => {
    const projection = computePensionProjection(USER_SPOUSE_PAYLOAD);

    assert(projection.debug.incomeStartYear === 2041, 'Income should start in the shared retirement year');
    assert(projection.debug.requiredPotReferenceYear === 2041, 'Required pension pot reference should be the shared retirement year');
    assert(projection.debug.inputs.includeEmploymentIncomeDuringBridge === false, 'Bridge employment income should default off without staggered retirement years');
  }));

  cases.push(runCase('Staggered retire-at-65 household starts drawdown at first retirement and references required pot at second retirement', () => {
    const projection = computePensionProjection(STAGGERED_RETIREMENT_INPUTS);
    const combinedChart = projection.charts[2];

    assert(projection.debug.incomeStartYear === 2031, 'Drawdown should start when the first person retires');
    assert(projection.debug.requiredPotReferenceYear === 2036, 'Required pension pot reference should default to the later retirement year');
    assert(combinedChart.labels[0] === '65', 'Combined chart should start at the primary member age at first retirement');
    assert(combinedChart.labels.includes('70'), 'Combined chart should include the primary member age at later retirement');
    assert(combinedChart.display.xAxisTitle === 'Older age', 'Combined chart x-axis should name the primary member age');
  }));

  cases.push(runCase('Later pension is unavailable before retirement but keeps accumulating until it enters the household pool', () => {
    const projection = computePensionProjection(STAGGERED_RETIREMENT_INPUTS);
    const simulation = projection.debug.retirementSimulationProjectedCurrent;
    const combinedChart = projection.charts[2];
    const combinedBalance = combinedChart.datasets.find((dataset) => dataset.label === 'Combined pension balance (current)');

    assert(combinedBalance.data[0] === projection.debug.currentIncomeStartBalances[0], 'Only the first retired pension should show in the opening combined balance');
    assert(projection.debug.currentReferenceBalances[1] > projection.debug.currentIncomeStartBalances[1], 'Later pension should continue accumulating before its retirement year');
    assert(simulation.perPensionMandatory[1].slice(0, 5).every((value) => value === 0), 'Later pension should not have mandatory withdrawals before retirement');
    assert(simulation.perPensionElected[1].slice(0, 5).every((value) => value === 0), 'Later pension should not have elected withdrawals before retirement');
  }));

  cases.push(runCase('Bridge employment income reduces withdrawals and required pot path begins at reference year', () => {
    const withBridge = computePensionProjection(STAGGERED_RETIREMENT_INPUTS);
    const withoutBridge = computePensionProjection({
      ...STAGGERED_RETIREMENT_INPUTS,
      includeEmploymentIncomeDuringBridge: false
    });
    const combinedChart = withBridge.charts[2];
    const employment = combinedChart.datasets.find((dataset) => dataset.label === 'Employment income (current)');
    const requiredPath = combinedChart.datasets.find((dataset) => dataset.label === 'Required pension pot path');
    const referenceIndex = combinedChart.labels.indexOf('70');

    assert(employment.data.slice(0, referenceIndex).some((value) => value > 0), 'Bridge employment income should appear before second retirement');
    assert(withBridge.debug.retirementSimulationProjectedCurrent.electedWithdrawals[0] < withoutBridge.debug.retirementSimulationProjectedCurrent.electedWithdrawals[0], 'Bridge salary should reduce first-year elected withdrawals');
    assert(requiredPath.data.slice(0, referenceIndex).every((value) => value === null), 'Required pension pot path should be blank before the reference year');
    assert(Number.isFinite(requiredPath.data[referenceIndex]), 'Required pension pot path should start at the reference year');
    assertApprox(
      withBridge.debug.projectedPotCurrent,
      withBridge.debug.currentReferenceBalances.reduce((total, value) => total + value, 0),
      0.01,
      'Projected pot should be measured at the reference year'
    );
  }));

  cases.push(runCase('Required pension pot terminal point is shown in the balance panel', () => {
    const projection = computePensionProjection(STAGGERED_RETIREMENT_INPUTS);
    const combinedChart = projection.charts[2];
    const balancePanel = combinedChart.panels.balance;
    const requiredPath = balancePanel.datasets.find((dataset) => dataset.label === 'Required pension pot path');

    assert(combinedChart.display.variant === 'pension-drawdown-composite', 'Drawdown chart should use the composite variant');
    assert(balancePanel.labels.length === requiredPath.data.length, 'Balance-panel required path should align with terminal label');
    assert(balancePanel.labels[balancePanel.labels.length - 1].startsWith('End Older age'), 'Balance panel should include terminal primary-age label');
    assert(
      requiredPath.data[requiredPath.data.length - 1] <= projection.debug.requiredPotDepletionTolerance,
      'Required path terminal point should deplete within tolerance'
    );
  }));

  cases.push(runCase('Composite drawdown chart separates balance and income panels', () => {
    const projection = computePensionProjection(COUPLE_INPUTS);
    const combinedChart = projection.charts[2];

    assert(combinedChart.panels.balance.datasets.some((dataset) => dataset.label === 'Combined pension balance (current)'), 'Balance panel should include current balance line');
    assert(combinedChart.panels.balance.datasets.some((dataset) => dataset.label === 'Required pension pot path'), 'Balance panel should include required pension pot path');
    assert(combinedChart.panels.income.datasets.some((dataset) => dataset.label === 'Required income'), 'Income panel should include required income line');
    assert(
      combinedChart.panels.income.datasets.every((dataset) => dataset.label !== 'Combined pension balance (current)'),
      'Income panel should not include balance lines'
    );
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

  cases.push(runCase('Mandatory withdrawal surplus is calculated and exported without charting', () => {
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
    const drawdownChart = projection.charts.find((chart) => chart.display?.variant === 'pension-drawdown-composite');
    assert(drawdownChart, 'Drawdown composite chart should be present');
    const rootLabels = drawdownChart.datasets.map((dataset) => dataset.label);
    const incomeLabels = drawdownChart.panels.income.datasets.map((dataset) => dataset.label);
    const csvLabels = drawdownChart.panels.income.csvDatasets.map((dataset) => dataset.label);
    const surplusCsvDataset = drawdownChart.panels.income.csvDatasets.find((dataset) => dataset.label === 'Surplus (current)');

    assert(projection.debug.retirementSimulationProjectedCurrent.surpluses[0] > 0, 'Mandatory withdrawal surplus should still be calculated');
    assert(rootLabels.every((label) => !String(label).startsWith('Surplus')), 'Root chart datasets should not include surplus');
    assert(incomeLabels.every((label) => !String(label).startsWith('Surplus')), 'Visible income panel datasets should not include surplus');
    assert(csvLabels.includes('Surplus (current)'), 'CSV datasets should include current surplus');
    assert(csvLabels.includes('Surplus (max)'), 'CSV datasets should include max surplus');
    assert(
      surplusCsvDataset.data[0] === projection.debug.retirementSimulationProjectedCurrent.surpluses[0],
      'CSV surplus should match the calculated current surplus'
    );
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

    assert(Number.isFinite(projection.debug.requiredPot) && projection.debug.requiredPot > 0, 'Required pension pot should be finite');
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
