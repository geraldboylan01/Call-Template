import {
  computePensionProjection,
  getPensionScenarioCases,
  normalizePensionInputs
} from './pension_math.js';

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

/** The couple, with one piece of income a case can take away. */
const COUPLE_WITH_DB_INPUTS = Object.freeze({
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

const withoutTargetStartYear = (payload) => {
  const next = { ...payload };
  delete next.targetStartYear;
  return next;
};

const withoutOtherIncome = (payload) => {
  const next = { ...payload };
  delete next.otherIncomeSources;
  return next;
};

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

/** A married couple using every tax input the retirement module takes. */
const TAXED_COUPLE_INPUTS = Object.freeze({
  currentYear: 2026,
  inflationRate: 0.02,
  growthRate: 0.05,
  wageGrowthRate: 0.02,
  incomeMode: 'target',
  targetIncomeToday: 60000,
  targetIncomeBasis: 'net',
  householdTaxStatus: 'married_or_civil_partners',
  horizonEndAge: 92,
  rentalIncomeToday: 12000,
  rentalIncomeOwnerId: 'joint',
  pensions: [
    {
      id: 'john',
      title: 'John',
      currentAge: 55,
      retirementAge: 65,
      currentSalary: 90000,
      currentPot: 450000,
      personalPct: 0.1,
      employerPct: 0.06,
      lumpSum: { mode: 'max' },
      priorLumpSumsSince2005: 50000
    },
    {
      id: 'mary',
      title: 'Mary',
      currentAge: 53,
      retirementAge: 63,
      currentSalary: 60000,
      currentPot: 250000,
      personalPct: 0.08,
      employerPct: 0.05
    }
  ],
  otherIncomeSources: [
    {
      id: 'mary-db',
      title: 'Mary DB pension',
      type: 'db',
      ownerId: 'mary',
      annualAmountToday: 8000,
      startAge: 63,
      inflationIndexed: true
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

  cases.push(runCase('ARF minimum withdrawals follow the whole-year age test at 4, 5 and 6 percent', () => {
    // Corrected by the Irish tax engine brief (4.9, compatibility reason 2).
    // The statute charges an imputed distribution only where the holder is 60
    // or over for the WHOLE year, and 5% only where they are 70 or over for
    // the whole year. Before the correction this test expected 4% at attained
    // age 60 (now nothing), 5% at 70 (now 4%) and 6% on a €2.1m fund at 60
    // (now nothing, because the age test comes first).
    const base = {
      currentYear: 2026,
      inflationRate: 0,
      growthRate: 0,
      wageGrowthRate: 0,
      incomeMode: 'target',
      targetIncomeToday: 1,
      includeStatePension: false,
      currentSalary: 0,
      personalPct: 0,
      employerPct: 0
    };
    const firstYearMinimum = (age, currentPot) => computePensionProjection({
      ...base,
      currentAge: age,
      retirementAge: age,
      horizonEndAge: age + 1,
      currentPot
    }).debug.retirementSimulationProjectedCurrent.firstYearMandatoryWithdrawal;

    assertApprox(firstYearMinimum(60, 500000), 0, 0.01, 'No imputed distribution in the year the holder turns 60');
    assertApprox(firstYearMinimum(61, 500000), 20000, 0.01, '4% from the year the holder turns 61');
    assertApprox(firstYearMinimum(70, 500000), 20000, 0.01, 'Still 4% in the year the holder turns 70');
    assertApprox(firstYearMinimum(71, 500000), 25000, 0.01, '5% from the year the holder turns 71');
    assertApprox(firstYearMinimum(61, 2100000), 126000, 0.01, '6% on a fund above €2m once the age test is met');
    assertApprox(firstYearMinimum(58, 2100000), 0, 0.01, 'Nothing on a fund above €2m before the age test is met');
  }));

  cases.push(runCase('Mandatory withdrawal surplus is calculated and exported without charting', () => {
    // Moved from age 60 to 61 by the ARF correction (brief 4.9, compatibility
    // reason 2): at 60 there is no longer a minimum withdrawal to overshoot
    // with. The €2.5m fund is also above the 2026 threshold, so it now pays
    // chargeable excess tax at retirement first (reason 1).
    const projection = computePensionProjection({
      ...BASE_TARGET_INPUTS,
      currentAge: 61,
      retirementAge: 61,
      horizonEndAge: 63,
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

  /* --------------------------------------------------------------- cases ---
   *
   * A case is only worth showing on a card if it means the same thing as a
   * module of its own would. Every fixture below is proved against a standalone
   * payload written out by hand -- not against the merge that produced it --
   * because a merge that is wrong in the same way twice would otherwise agree
   * with itself.
   */

  /** What a case changes about the payload is not itself an output figure. */
  function stripCaseIdentity(projection) {
    const debug = JSON.parse(JSON.stringify(projection.debug));
    [
      'selectedScenarioId',
      'selectedScenarioTitle',
      'selectedScenarioDescription',
      'selectedScenarioSummary',
      'selectedScenarioIsBase',
      'selectedScenarioOverrides',
      'baseScenarioId',
      'chartAxisYears',
      // Whether the module is showing a rent comparison at all is a fact about
      // the case set, not about this case's arithmetic.
      'hasRentalContext'
    ].forEach((key) => {
      delete debug[key];
    });
    [
      'scenarios',
      'rentalIncomeScenarios',
      'baseScenarioId',
      'selectedScenarioId',
      'selectedScenarioTitle',
      'selectedScenarioDescription',
      'selectedScenarioSummary'
    ].forEach((key) => {
      delete debug.inputs[key];
    });
    return debug;
  }

  /** The values a chart draws, with the shared axis's leading and trailing gaps removed. */
  function chartValues(projection) {
    return projection.charts.map((chart) => ({
      title: chart.title,
      datasets: (chart.datasets || []).map((dataset) => ({
        label: dataset.label,
        data: (dataset.data || []).filter((value) => value !== null)
      }))
    }));
  }

  /**
   * Every row the two projections both report, so a case row cannot hide a
   * wrong figure. The row naming the case is the one exception: saying which
   * case is on screen is the point of it.
   */
  function sharedTableRows(projection, standalone, table) {
    const standaloneByLabel = new Map(standalone[table].rows.map((row) => [row[0], row[1]]));
    return projection[table].rows
      .filter((row) => row[0] !== 'Retirement income case' && standaloneByLabel.has(row[0]))
      .map((row) => [row[0], row[1], standaloneByLabel.get(row[0])]);
  }

  function assertCaseEqualsStandalone(fixtureName, base, caseId, standalone) {
    const fromCase = computePensionProjection(base, { scenarioId: caseId });
    const fromPayload = computePensionProjection(standalone);

    assert(
      JSON.stringify(stripCaseIdentity(fromCase)) === JSON.stringify(stripCaseIdentity(fromPayload)),
      `${fixtureName}: case "${caseId}" should compute the same figures as its standalone payload`
    );
    assert(
      JSON.stringify(chartValues(fromCase)) === JSON.stringify(chartValues(fromPayload)),
      `${fixtureName}: case "${caseId}" should chart the same values as its standalone payload`
    );
    sharedTableRows(fromCase, fromPayload, 'outputsTable').forEach(([label, actual, expected]) => {
      assert(actual === expected, `${fixtureName}: case "${caseId}" output "${label}" should read ${expected}, got ${actual}`);
    });
    sharedTableRows(fromCase, fromPayload, 'assumptionsTable').forEach(([label, actual, expected]) => {
      assert(actual === expected, `${fixtureName}: case "${caseId}" assumption "${label}" should read ${expected}, got ${actual}`);
    });
  }

  const RETIREMENT_AGE_BASE = {
    currentAge: 50,
    retirementAge: 62,
    currentSalary: 90000,
    currentPot: 400000,
    personalPct: 0.05,
    employerPct: 0.06,
    growthRate: 0.05,
    inflationRate: 0.02,
    wageGrowthRate: 0.02,
    horizonEndAge: 92,
    currentYear: 2026,
    incomeMode: 'target',
    targetIncomeToday: 45000,
    includeStatePension: true
  };

  /**
   * Every fixture, and the standalone payload each of its cases claims to be.
   *
   * Rule 5 is checked here for every case in every fixture at once, so a new
   * fixture cannot be added without its equality being proved too.
   */
  const CASE_FIXTURES = [
    {
      name: 'Single person retiring at 58, 62 or 66',
      base: {
        ...RETIREMENT_AGE_BASE,
        baseScenarioId: 'retire-62',
        scenarios: [
          { id: 'retire-62', title: 'Retire at 62' },
          { id: 'retire-58', title: 'Retire at 58', retirementAge: 58 },
          { id: 'retire-66', title: 'Retire at 66', retirementAge: 66 }
        ]
      },
      standalone: {
        'retire-62': { ...RETIREMENT_AGE_BASE },
        'retire-58': { ...RETIREMENT_AGE_BASE, retirementAge: 58 },
        'retire-66': { ...RETIREMENT_AGE_BASE, retirementAge: 66 }
      }
    },
    {
      name: 'Single person paying in more, topping up, or working part-time',
      base: {
        ...RETIREMENT_AGE_BASE,
        baseScenarioId: 'as-is',
        scenarios: [
          { id: 'as-is', title: 'As things stand' },
          { id: 'pay-10', title: 'Pay in 10%', personalPct: 0.1 },
          { id: 'top-up', title: 'Top up the pot', currentPot: 475000 },
          {
            id: 'part-time',
            title: 'Part-time to 65',
            retirementAge: 60,
            additionalIncomeSources: [
              {
                id: 'part-time-work',
                title: 'Part-time income',
                type: 'employment',
                annualAmountToday: 25000,
                startAge: 60,
                endAge: 65,
                inflationIndexed: true
              }
            ]
          }
        ]
      },
      standalone: {
        'as-is': { ...RETIREMENT_AGE_BASE },
        'pay-10': { ...RETIREMENT_AGE_BASE, personalPct: 0.1 },
        'top-up': { ...RETIREMENT_AGE_BASE, currentPot: 475000 },
        'part-time': {
          ...RETIREMENT_AGE_BASE,
          retirementAge: 60,
          otherIncomeSources: [
            {
              id: 'part-time-work',
              title: 'Part-time income',
              type: 'employment',
              annualAmountToday: 25000,
              startAge: 60,
              endAge: 65,
              inflationIndexed: true
            }
          ]
        }
      }
    },
    {
      name: 'Single person changing rent and retirement age together',
      base: {
        ...RETIREMENT_AGE_BASE,
        rentalIncomeToday: 18000,
        baseScenarioId: 'keep-letting',
        scenarios: [
          { id: 'keep-letting', title: 'Keep letting, retire at 62' },
          { id: 'sell-and-go', title: 'Sell up and retire at 58', retirementAge: 58, rentalIncomeToday: 0 }
        ]
      },
      standalone: {
        'keep-letting': { ...RETIREMENT_AGE_BASE, rentalIncomeToday: 18000 },
        'sell-and-go': { ...RETIREMENT_AGE_BASE, retirementAge: 58, rentalIncomeToday: 0 }
      }
    },
    {
      name: 'Couple with staggered retirement, one member moving',
      base: {
        ...COUPLE_INPUTS,
        baseScenarioId: 'as-planned',
        scenarios: [
          { id: 'as-planned', title: 'As planned' },
          {
            id: 'mary-earlier',
            title: 'Mary retires at 62',
            pensionOverrides: [{ id: 'mary', retirementAge: 62 }]
          },
          {
            id: 'mary-no-state-pension',
            title: 'Mary without the State Pension',
            pensionOverrides: [{ id: 'mary', includeStatePension: false }]
          }
        ]
      },
      standalone: {
        'as-planned': { ...COUPLE_INPUTS },
        // targetStartYear was written for the plan as it stood; a case that
        // moves a retirement age derives its own, so the standalone drops it.
        'mary-earlier': {
          ...withoutTargetStartYear(COUPLE_INPUTS),
          pensions: [
            COUPLE_INPUTS.pensions[0],
            { ...COUPLE_INPUTS.pensions[1], retirementAge: 62 }
          ]
        },
        'mary-no-state-pension': {
          ...COUPLE_INPUTS,
          pensions: [
            COUPLE_INPUTS.pensions[0],
            { ...COUPLE_INPUTS.pensions[1], includeStatePension: false }
          ]
        }
      }
    },
    {
      name: 'Couple dropping a DB pension and lowering the target',
      base: {
        ...COUPLE_WITH_DB_INPUTS,
        baseScenarioId: 'as-planned',
        scenarios: [
          { id: 'as-planned', title: 'As planned' },
          { id: 'no-db', title: 'Without the DB pension', excludedIncomeSourceIds: ['mary-db'] },
          { id: 'spend-less', title: 'Spend €60,000', targetIncomeToday: 60000 }
        ]
      },
      standalone: {
        'as-planned': { ...COUPLE_WITH_DB_INPUTS },
        'no-db': withoutOtherIncome(COUPLE_WITH_DB_INPUTS),
        'spend-less': { ...COUPLE_WITH_DB_INPUTS, targetIncomeToday: 60000 }
      }
    },
    {
      // Irish tax engine brief, 7.8: the tax keys are payload-level, so every
      // case inherits them and still equals its standalone payload.
      name: 'Married couple with an after-tax target and a lump sum, retiring earlier or later',
      base: {
        ...TAXED_COUPLE_INPUTS,
        baseScenarioId: 'as-planned',
        scenarios: [
          { id: 'as-planned', title: 'As planned' },
          { id: 'mary-earlier', title: 'Mary retires at 60', pensionOverrides: [{ id: 'mary', retirementAge: 60 }] },
          { id: 'pay-more', title: 'John pays in 15%', pensionOverrides: [{ id: 'john', personalPct: 0.15 }] }
        ]
      },
      standalone: {
        'as-planned': { ...TAXED_COUPLE_INPUTS },
        'mary-earlier': {
          ...TAXED_COUPLE_INPUTS,
          pensions: [TAXED_COUPLE_INPUTS.pensions[0], { ...TAXED_COUPLE_INPUTS.pensions[1], retirementAge: 60 }]
        },
        'pay-more': {
          ...TAXED_COUPLE_INPUTS,
          pensions: [{ ...TAXED_COUPLE_INPUTS.pensions[0], personalPct: 0.15 }, TAXED_COUPLE_INPUTS.pensions[1]]
        }
      }
    },
    {
      name: 'Affordable mode, cases retiring at 60 or 66',
      base: {
        ...RETIREMENT_AGE_BASE,
        incomeMode: 'affordable',
        affordableEndAges: [90, 95],
        targetIncomeToday: undefined,
        baseScenarioId: 'retire-62',
        scenarios: [
          { id: 'retire-62', title: 'Retire at 62' },
          { id: 'retire-60', title: 'Retire at 60', retirementAge: 60 },
          { id: 'retire-66', title: 'Retire at 66', retirementAge: 66 }
        ]
      },
      standalone: {
        'retire-62': { ...RETIREMENT_AGE_BASE, incomeMode: 'affordable', affordableEndAges: [90, 95], targetIncomeToday: undefined },
        'retire-60': { ...RETIREMENT_AGE_BASE, incomeMode: 'affordable', affordableEndAges: [90, 95], targetIncomeToday: undefined, retirementAge: 60 },
        'retire-66': { ...RETIREMENT_AGE_BASE, incomeMode: 'affordable', affordableEndAges: [90, 95], targetIncomeToday: undefined, retirementAge: 66 }
      }
    }
  ];

  CASE_FIXTURES.forEach((fixture) => {
    cases.push(runCase(`${fixture.name}: every case equals its standalone payload`, () => {
      const caseIds = getPensionScenarioCases(fixture.base).map((entry) => entry.id);
      assert(
        caseIds.length === Object.keys(fixture.standalone).length,
        `${fixture.name}: every case needs a standalone payload to be measured against`
      );
      caseIds.forEach((caseId) => {
        assertCaseEqualsStandalone(fixture.name, fixture.base, caseId, fixture.standalone[caseId]);
      });
    }));
  });

  cases.push(runCase('A retirement-age case re-derives its own timing', () => {
    const base = CASE_FIXTURES[0].base;
    const earlier = computePensionProjection(base, { scenarioId: 'retire-58' });
    const later = computePensionProjection(base, { scenarioId: 'retire-66' });

    assert(earlier.debug.incomeStartYear === 2034, `Retiring at 58 should start income in 2034, got ${earlier.debug.incomeStartYear}`);
    assert(later.debug.incomeStartYear === 2042, `Retiring at 66 should start income in 2042, got ${later.debug.incomeStartYear}`);
    assert(earlier.debug.requiredPotReferenceYear === 2034, 'The required pot reference year should follow the case');
    assert(earlier.debug.retirementYear === 2034, 'The retirement year should follow the case');
  }));

  cases.push(runCase('A base timing year does not carry into a case that moves a retirement age', () => {
    const base = CASE_FIXTURES[3].base;
    const asPlanned = computePensionProjection(base, { scenarioId: 'as-planned' });
    const maryEarlier = computePensionProjection(base, { scenarioId: 'mary-earlier' });

    assert(asPlanned.debug.incomeStartYear === 2052, 'The base keeps the income start year it states');
    assert(maryEarlier.debug.incomeStartYear === 2048, `Mary retiring at 62 should start household income in 2048, got ${maryEarlier.debug.incomeStartYear}`);
    assert(maryEarlier.debug.requiredPotReferenceYear === 2051, 'The reference year should be the later retirement');
    assert(maryEarlier.debug.inputs.includeEmploymentIncomeDuringBridge === true, 'Staggered retirement should bring bridge employment income back');
    assert(maryEarlier.debug.employmentIncomeNominalAtRetirement > 0, 'John should still be earning through the bridge years');
  }));

  cases.push(runCase('A case restating timing keeps it even when it moves a retirement age', () => {
    const projection = computePensionProjection({
      ...RETIREMENT_AGE_BASE,
      baseScenarioId: 'as-is',
      scenarios: [
        { id: 'as-is', title: 'As things stand' },
        { id: 'bridge', title: 'Stop at 58, draw from 62', retirementAge: 58, incomeStartYear: 2038 }
      ]
    }, { scenarioId: 'bridge' });

    assert(projection.debug.incomeStartYear === 2038, 'A case that restates the income start year should keep it');
    assert(projection.debug.inputs.primaryPension.retirementAge === 58, 'Contributions should still stop at 58');
  }));

  cases.push(runCase('Every case shares one chart axis', () => {
    const base = CASE_FIXTURES[0].base;
    const axes = ['retire-58', 'retire-62', 'retire-66'].map((scenarioId) => {
      const projection = computePensionProjection(base, { scenarioId });
      const drawdown = projection.charts.find((chart) => chart.meta?.kind === 'pensionDrawdownComposite');
      return {
        drawdown: drawdown.labels.join(','),
        accumulation: projection.charts[0].labels.join(',')
      };
    });

    assert(axes.every((axis) => axis.drawdown === axes[0].drawdown), 'The drawdown axis should not move with the case');
    assert(axes.every((axis) => axis.accumulation === axes[0].accumulation), 'The accumulation axis should not move with the case');
    assert(axes[0].drawdown.startsWith('58,'), `The shared axis should start at the earliest retirement age, got ${axes[0].drawdown.slice(0, 12)}`);
    assert(axes[0].accumulation.endsWith(',66'), `The shared accumulation axis should run to the latest retirement age, got ${axes[0].accumulation.slice(-12)}`);
  }));

  cases.push(runCase('A case card says what the case changes', () => {
    const byId = new Map(getPensionScenarioCases(CASE_FIXTURES[1].base).map((entry) => [entry.id, entry]));

    assert(byId.get('as-is').summary === '', 'The base case changes nothing, so it says nothing');
    assert(byId.get('pay-10').summary === 'Personal contributions 10.0%', `Unexpected contributions summary: ${byId.get('pay-10').summary}`);
    assert(byId.get('top-up').summary === 'Pension value €475,000', `Unexpected top-up summary: ${byId.get('top-up').summary}`);
    assert(
      byId.get('part-time').summary.startsWith('Retires at 60, income from 2036, part-time income'),
      `Unexpected part-time summary: ${byId.get('part-time').summary}`
    );
  }));

  cases.push(runCase('Case payloads are rejected with the case named', () => {
    const rejects = (raw, expected) => {
      let message = '';
      try {
        normalizePensionInputs(raw);
      } catch (error) {
        message = error?.message || '';
      }
      assert(message === expected, `Expected "${expected}", got "${message}"`);
    };
    const withCases = (scenarios, extra = {}) => ({ ...RETIREMENT_AGE_BASE, ...extra, scenarios });
    const couple = (scenarios) => ({ ...COUPLE_INPUTS, scenarios });

    rejects(
      withCases(Array.from({ length: 5 }, (_, index) => ({ id: `case-${index}`, title: `Case ${index}` }))),
      'generated.pensionInputs.scenarios supports at most 4 cases; received 5.'
    );
    rejects(
      withCases([{ id: 'same', title: 'One' }, { id: 'same', title: 'Two' }]),
      'generated.pensionInputs.scenarios[1].id must be unique.'
    );
    rejects(
      couple([{ id: 'as-planned', title: 'As planned' }, { id: 'earlier', title: 'Retire at 58', pensionOverrides: [{ id: 'joan', retirementAge: 58 }] }]),
      'generated.pensionInputs.scenarios[1] (Retire at 58): pensionOverrides[0].id must match a pension id.'
    );
    rejects(
      withCases([{ id: 'as-is', title: 'As things stand' }, { id: 'faster', title: 'Faster growth', growthRate: 0.07 }]),
      'generated.pensionInputs.scenarios[1] (Faster growth): growthRate is not a case override.'
    );
    rejects(
      { ...RETIREMENT_AGE_BASE, scenarios: [{ id: 'a', title: 'A' }], rentalIncomeScenarios: [{ id: 'r', title: 'R', rentalIncomeToday: 0 }] },
      'generated.pensionInputs must use scenarios or rentalIncomeScenarios, not both.'
    );
    rejects(
      withCases([{ id: 'as-is', title: 'As things stand' }, { id: 'too-early', title: 'Retire at 30', retirementAge: 30 }]),
      'generated.pensionInputs.scenarios[1] (Retire at 30): retirementAge must be greater than or equal to currentAge.'
    );
    rejects(
      withCases([{ id: 'as-is', title: 'As things stand' }], { baseScenarioId: 'missing' }),
      'generated.pensionInputs.baseScenarioId must match a case id.'
    );
    rejects(
      { ...COUPLE_WITH_DB_INPUTS, scenarios: [{ id: 'as-planned', title: 'As planned' }, { id: 'no-db', title: 'Without the DB pension', excludedIncomeSourceIds: ['mary-db-pension'] }] },
      'generated.pensionInputs.scenarios[1] (Without the DB pension): excludedIncomeSourceIds must match an other income source id.'
    );
    rejects(
      couple([{ id: 'as-planned', title: 'As planned' }, { id: 'earlier', title: 'Retire at 58', retirementAge: 58 }]),
      'generated.pensionInputs.scenarios[1] (Retire at 58): retirementAge must be set through pensionOverrides when the payload has more than one pension.'
    );
  }));

  cases.push(runCase('Editing a case moves that case and leaves the household alone', () => {
    // The shape the app writes back when a figure is edited with a non-base
    // case on screen: the whole case list, normalised, with one override
    // changed and the household's own figure untouched.
    const base = CASE_FIXTURES[0].base;
    const edited = {
      ...base,
      scenarios: getPensionScenarioCases(base).map((entry) => ({
        id: entry.id,
        title: entry.title,
        description: entry.description,
        overrides: entry.id === 'retire-58'
          ? { ...entry.overrides, retirementAge: 57 }
          : { ...entry.overrides }
      }))
    };

    const movedCase = computePensionProjection(edited, { scenarioId: 'retire-58' });
    const untouchedBase = computePensionProjection(edited, { scenarioId: 'retire-62' });
    const standalone = computePensionProjection({ ...RETIREMENT_AGE_BASE, retirementAge: 57 });

    assert(movedCase.debug.inputs.primaryPension.retirementAge === 57, 'The edited case should retire at 57');
    assert(untouchedBase.debug.inputs.primaryPension.retirementAge === 62, 'The base case should not move');
    assert(
      movedCase.debug.requiredPot === standalone.debug.requiredPot,
      'The edited case should still equal the standalone payload it now describes'
    );
  }));

  cases.push(runCase('A stored case reads the same way the second time', () => {
    const base = CASE_FIXTURES[1].base;
    const stored = JSON.parse(JSON.stringify(normalizePensionInputs(base)));
    const reStored = normalizePensionInputs(stored);

    assert(
      JSON.stringify(stored.scenarios) === JSON.stringify(reStored.scenarios),
      'Normalising a stored payload again should not change its cases'
    );
    ['pay-10', 'top-up', 'part-time'].forEach((scenarioId) => {
      const fresh = computePensionProjection(base, { scenarioId });
      const reloaded = computePensionProjection(stored, { scenarioId });
      assert(
        fresh.debug.requiredPot === reloaded.debug.requiredPot,
        `Case "${scenarioId}" should survive a session round trip`
      );
    });
  }));

  /* ----------------------------------------------------------------- tax ---
   *
   * The Irish tax engine brief (7.2 to 7.8). The engine's own golden cases are
   * in tests_ie_tax.js; these prove the retirement module uses it correctly.
   */

  cases.push(runCase('A fund above the SFT pays chargeable excess tax at retirement, and the pot compared is the drawdown fund', () => {
    const payload = {
      currentYear: 2026,
      currentAge: 64,
      retirementAge: 64,
      currentSalary: 0,
      currentPot: 2_500_000,
      personalPct: 0,
      employerPct: 0,
      growthRate: 0.05,
      inflationRate: 0.02,
      wageGrowthRate: 0.02,
      horizonEndAge: 90,
      incomeMode: 'target',
      targetIncomeToday: 90000,
      includeStatePension: false
    };
    const projection = computePensionProjection(payload);
    const [record] = projection.debug.tax.crystallisations.current;

    assertApprox(record.chargeableExcess, 300000, 0.01, 'Chargeable excess over the 2026 threshold');
    assertApprox(record.netCet, 120000, 0.01, 'No lump sum, so no credit: 40% of the excess');
    assertApprox(projection.debug.projectedPotCurrent, 2_380_000, 0.01, 'The projected pot is the drawdown fund');
    assert(projection.debug.sftBreaches.current === true, 'The breach is flagged on the current path');
    assert(projection.outputsTable.rows.some((row) => row[0] === 'Projected pot at target start (current, after lump sum and tax at retirement)'), 'The pot row says it is after tax at retirement');
    assert(projection.debug.sftSentence.startsWith('On the current path, the fund at retirement in 2026 is above the Standard Fund Threshold of €2.2 million'), `CET sentence: ${projection.debug.sftSentence}`);
  }));

  cases.push(runCase('Each member is tested at the SFT for their own retirement year', () => {
    // Before this change both members were tested at the reference year
    // (2031, when the later one retires). John retires in 2027, when the
    // threshold is €2.4m; Mary in 2031, when it is €2.8m, held.
    const projection = computePensionProjection({
      currentYear: 2026,
      inflationRate: 0,
      growthRate: 0,
      wageGrowthRate: 0,
      incomeMode: 'target',
      targetIncomeToday: 1,
      horizonEndAge: 70,
      includeEmploymentIncomeDuringBridge: false,
      pensions: [
        { id: 'john', title: 'John', currentAge: 64, retirementAge: 65, currentSalary: 0, currentPot: 2_600_000, personalPct: 0, employerPct: 0, includeStatePension: false },
        { id: 'mary', title: 'Mary', currentAge: 60, retirementAge: 65, currentSalary: 0, currentPot: 100_000, personalPct: 0, employerPct: 0, includeStatePension: false }
      ]
    });
    const byMember = new Map(projection.debug.sftByMember.map((entry) => [entry.id, entry]));
    const [john] = projection.debug.tax.crystallisations.current;

    assert(byMember.get('john').year === 2027 && byMember.get('john').sftValue === 2_400_000, 'John is tested in 2027 at €2.4m');
    assert(byMember.get('mary').year === 2031 && byMember.get('mary').sftBasis === 'held', 'Mary is tested in 2031 at the held figure');
    assertApprox(john.chargeableExcess, 200_000, 0.01, "John's excess is measured against 2027's threshold");
    const row = projection.outputsTable.rows.find((entry) => entry[0] === 'SFT threshold used');
    assert(row[1] === 'John €2.4m (2027); Mary €2.8m (2031, held)', `Threshold row: ${row[1]}`);
    assert(projection.debug.tax.disclosureCodes.includes('SFT_HELD'), 'A held threshold on screen carries SFT_HELD');
  }));

  cases.push(runCase('The required-pot search never crystallises', () => {
    const projection = computePensionProjection({
      ...BASE_TARGET_INPUTS,
      lumpSum: { mode: 'max' }
    });
    assert(projection.debug.retirementSimulationRequired.crystallisations.length === 0, 'No crystallisation on the required path');
    const [record] = projection.debug.tax.crystallisations.current;
    assertApprox(record.lumpSum, record.fundValue * 0.25, 0.01, 'The "max" lump sum is 25% of the fund');
    assertApprox(projection.debug.projectedPotCurrent, record.drawdownFund, 0.01, 'The projected pot is the fund after the lump sum');
    assert(projection.debug.tax.disclosureCodes.includes('LUMP_SUM_AS_CASH'), 'The lump sum is disclosed as cash');
  }));

  cases.push(runCase('Gross-mode tax is information only', () => {
    const plain = computePensionProjection(BASE_TARGET_INPUTS);
    const taxedStatus = computePensionProjection({ ...BASE_TARGET_INPUTS, householdTaxStatus: 'single' });
    const rows = (projection) => projection.outputsTable.rows.filter((row) => !String(row[0]).startsWith('Estimated') && !String(row[0]).includes('net cost'));
    assert(JSON.stringify(rows(plain)) === JSON.stringify(rows(taxedStatus)), 'A tax status changes no gross figure');
    assert(plain.debug.tax.disclosureCodes.includes('STATUS_SINGLE'), 'A single person without a status is assessed as single');
  }));

  cases.push(runCase('The income panel adds a net income line and hidden tax series, all of them in the CSV', () => {
    const projection = computePensionProjection(COUPLE_INPUTS);
    const chart = projection.charts.find((entry) => entry.meta?.kind === 'pensionDrawdownComposite');
    const income = new Map(chart.panels.income.datasets.map((dataset) => [dataset.label, dataset]));
    const csv = chart.panels.income.csvDatasets.map((dataset) => dataset.label);

    assert(income.get('Net income (current)') && !income.get('Net income (current)').hidden, 'Net income (current) is visible');
    ['Income tax (current)', 'USC (current)', 'PRSI (current)'].forEach((label) => {
      assert(income.get(label)?.hidden === true, `${label} is hidden by default`);
    });
    ['Net income (current)', 'Net income (max)', 'Income tax (current)', 'USC (current)', 'PRSI (current)', 'Income tax (max)', 'USC (max)', 'PRSI (max)']
      .forEach((label) => assert(csv.includes(label), `${label} is in the CSV`));
    assert(income.has('Required income'), 'The gross target line keeps its name');
    assert(projection.debug.tax.disclosureCodes.includes('STATUS_DEFAULT_SINGLE'), 'A couple without a status is told they were assessed as single');

    const net = computePensionProjection({ ...COUPLE_INPUTS, targetIncomeBasis: 'net' });
    const netChart = net.charts.find((entry) => entry.meta?.kind === 'pensionDrawdownComposite');
    assert(netChart.panels.income.datasets.some((dataset) => dataset.label === 'Required net income'), 'Net mode names the required line');
  }));

  cases.push(runCase('Net mode: the shortfall is the net gap at maximum withdrawal', () => {
    const projection = computePensionProjection({
      currentYear: 2026,
      currentAge: 66,
      retirementAge: 66,
      currentSalary: 0,
      currentPot: 40000,
      personalPct: 0,
      employerPct: 0,
      growthRate: 0,
      inflationRate: 0,
      wageGrowthRate: 0,
      horizonEndAge: 68,
      incomeMode: 'target',
      targetIncomeToday: 60000,
      targetIncomeBasis: 'net',
      includeStatePension: true
    });
    const simulation = projection.debug.retirementSimulationProjectedCurrent;
    assertApprox(simulation.mandatoryWithdrawals[0] + simulation.electedWithdrawals[0], 40000, 0.02, 'Everything available is drawn');
    assertApprox(simulation.shortfalls[0], 60000 - simulation.tax.netIncome[0], 0.01, 'The shortfall is net of tax');
    assert(simulation.shortfalls[0] > 0, 'A shortfall is recorded');
  }));

  cases.push(runCase('Other income is taxed by its treatment, and an assumed treatment is disclosed', () => {
    const projection = computePensionProjection({
      ...COUPLE_WITH_DB_INPUTS,
      householdTaxStatus: 'married_or_civil_partners',
      otherIncomeSources: [
        ...COUPLE_WITH_DB_INPUTS.otherIncomeSources,
        { id: 'lease', title: 'Land lease income', type: 'rental_or_lease_income', ownerId: 'household', annualAmountToday: 6000, startAge: 66, inflationIndexed: true },
        { id: 'gift', title: 'Family support', type: 'other', ownerId: 'john', annualAmountToday: 3000, startAge: 67, inflationIndexed: false, taxTreatment: 'non_taxable' }
      ]
    });
    const treatments = new Map(projection.debug.tax.incomeTreatments.map((entry) => [entry.id, entry]));
    assert(treatments.get('mary-db').treatment === 'occupational_pension' && !treatments.get('mary-db').assumedAsPension, 'A DB pension is an occupational pension');
    assert(treatments.get('lease').assumedAsPension === true && treatments.get('lease').ownerId === 'joint', 'Unlisted types are taxed as a pension, split for household income');
    assert(treatments.get('gift').itemType === null, 'Non-taxable income becomes no tax item');
    const texts = projection.debug.tax.disclosures.map((entry) => entry.text);
    assert(texts.includes('Land lease income is taxed like an Irish occupational pension.'), 'The assumed treatment is disclosed');
    assert(!texts.some((text) => text.startsWith('Mary DB pension is taxed like')), 'A DB pension needs no such disclosure');
  }));

  cases.push(runCase('Tax inputs are refused with the field named', () => {
    const rejects = (raw, expected) => {
      let message = '';
      try {
        computePensionProjection(raw);
      } catch (error) {
        message = error?.message || '';
      }
      assert(message === expected, `Expected "${expected}", got "${message}"`);
    };
    rejects({ ...BASE_TARGET_INPUTS, householdTaxStatus: 'cohabiting' }, 'generated.pensionInputs.householdTaxStatus must be one of: single, married_or_civil_partners, widowed_or_surviving_civil_partner.');
    rejects({ ...COUPLE_INPUTS, householdTaxStatus: 'widowed_or_surviving_civil_partner' }, 'generated.pensionInputs.householdTaxStatus widowed_or_surviving_civil_partner describes one person, but the payload has 2 pensions.');
    rejects({ ...BASE_TARGET_INPUTS, targetIncomeBasis: 'after-tax' }, 'generated.pensionInputs.targetIncomeBasis must be "gross" or "net".');
    rejects({ ...BASE_TARGET_INPUTS, rentalIncomeOwnerId: 'joint' }, 'generated.pensionInputs.rentalIncomeOwnerId "joint" splits rent between two people, but the payload has one pension.');
    rejects({ ...COUPLE_INPUTS, rentalIncomeOwnerId: 'joan' }, 'generated.pensionInputs.rentalIncomeOwnerId must match a pension id, or be "joint".');
    rejects({ ...BASE_TARGET_INPUTS, lumpSum: { mode: 'all' } }, 'generated.pensionInputs.legacy.lumpSum.mode must be "none", "max" or "amount".');
    rejects({ ...BASE_TARGET_INPUTS, sftAlreadyUsed: -1 }, 'generated.pensionInputs.legacy.sftAlreadyUsed must be greater than or equal to 0.');
    rejects({ ...COUPLE_WITH_DB_INPUTS, otherIncomeSources: [{ ...COUPLE_WITH_DB_INPUTS.otherIncomeSources[0], taxTreatment: 'pension' }] }, 'generated.pensionInputs.otherIncomeSources[0].taxTreatment must be one of: occupational_pension, rental, employment, social_welfare, non_taxable.');
    rejects({ ...BASE_TARGET_INPUTS, lumpSum: { mode: 'amount', amount: 5_000_000 } }, 'generated.pensionInputs: the lump sum of €5,000,000 for Pension is more than the projected fund of €1,336,648 at retirement.');
  }));

  cases.push(runCase('A lump sum above 25% of the fund is allowed and disclosed', () => {
    const projection = computePensionProjection({ ...BASE_TARGET_INPUTS, lumpSum: { mode: 'amount', amount: 600000 } });
    const [record] = projection.debug.tax.crystallisations.current;
    assertApprox(record.lumpSum, 600000, 0.01, 'The amount asked for is taken');
    assert(projection.debug.tax.disclosureCodes.includes('LUMP_SUM_ABOVE_25'), 'LUMP_SUM_ABOVE_25 is raised');
    assert(record.scheduleE > 0 && record.scheduleETax > 0, 'The part above €500,000 is taxed as income');
    assertApprox(record.netLumpSum, 600000 - 60000 - record.scheduleETax, 0.01, 'Net lump sum takes off the 20% tax and the Schedule E tax');
  }));

  cases.push(runCase('A couple far apart in age is taxed to the younger partner’s 100th birthday', () => {
    // The household horizon puts the older partner at 130 in its last year;
    // the tax engine must not refuse that as an impossible age.
    const projection = computePensionProjection({
      currentYear: 2026,
      incomeMode: 'target',
      targetIncomeToday: 50000,
      pensions: [
        { id: 'a', title: 'A', currentAge: 70, retirementAge: 70, currentSalary: 0, currentPot: 600000, personalPct: 0, employerPct: 0 },
        { id: 'b', title: 'B', currentAge: 40, retirementAge: 60, currentSalary: 60000, currentPot: 50000, personalPct: 0.05, employerPct: 0.05 }
      ]
    });
    const tax = projection.debug.retirementSimulationProjectedCurrent.tax;
    assert(projection.debug.inputs.horizonEndYear === 2086, 'The horizon is the younger partner’s 100th birthday');
    assert(tax.netIncome.length === projection.debug.retirementSimulationProjectedCurrent.years.length, 'Every year is taxed');
  }));

  cases.push(runCase('A stored tax payload reads the same way the second time', () => {
    const stored = JSON.parse(JSON.stringify(normalizePensionInputs(COUPLE_INPUTS)));
    assert(!('householdTaxStatus' in stored), 'A status that was not given is not stored as its default');
    const fresh = computePensionProjection(COUPLE_INPUTS);
    const reloaded = computePensionProjection(stored);
    assert(JSON.stringify(fresh.debug.tax.disclosureCodes) === JSON.stringify(reloaded.debug.tax.disclosureCodes), 'The same disclosures after a round trip');
    const taxed = JSON.parse(JSON.stringify(normalizePensionInputs(TAXED_COUPLE_INPUTS)));
    assert(taxed.pensions[0].lumpSum.mode === 'max' && taxed.pensions[0].priorLumpSumsSince2005 === 50000, 'Member tax inputs are kept');
    assert(computePensionProjection(taxed).debug.requiredPot === computePensionProjection(TAXED_COUPLE_INPUTS).debug.requiredPot, 'A stored taxed payload computes the same');
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
