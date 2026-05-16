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
      rentalIncomeToday: 20000
    });

    assertApprox(projection.debug.requiredPot, 0, 0.01, 'Required pot should floor at zero');
    assertApprox(projection.debug.pensionWithdrawalNominalAtRetirement, 0, 0.01, 'Pension withdrawal should floor at zero');
  }));

  cases.push(runCase('Affordable mode reports total income including rent', () => {
    const projection = computePensionProjection({
      ...BASE_TARGET_INPUTS,
      incomeMode: 'affordable',
      affordableEndAges: [90],
      rentalIncomeToday: 12000
    });
    const current = projection.debug.affordableIncome.current[0];

    assertApprox(
      current.totalIncomeToday,
      current.incomeToday + 12000,
      0.01,
      'Affordable total income should include rent'
    );
  }));

  cases.push(runCase('No-rent pension payload output stays unchanged', () => {
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
