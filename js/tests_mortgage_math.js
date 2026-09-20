import {
  computeMonthlyPayment,
  computeAmortizationMonthlySchedule,
  computeMortgageComparison,
  computeMortgageProjection,
  getMortgageScenarioCases,
  normalizeMortgageInputs
} from './mortgage_math.js';

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
    console.info(`[MortgageTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[MortgageTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

export function runMortgageMathTests() {
  const cases = [];

  cases.push(runCase('Zero-rate payment divides principal evenly', () => {
    const payment = computeMonthlyPayment(120000, 0, 120);
    assertApprox(payment, 1000, 1e-9, 'Zero-rate monthly payment mismatch');
  }));

  cases.push(runCase('30y @ 6% on 100k monthly payment sanity', () => {
    const payment = computeMonthlyPayment(100000, 0.06, 360);
    assertApprox(payment, 599.55, 0.05, 'Known mortgage payment mismatch');
  }));

  cases.push(runCase('Negative amortisation throws', () => {
    let didThrow = false;

    try {
      computeAmortizationMonthlySchedule({
        currentBalance: 100000,
        annualInterestRate: 0.06,
        startDateIso: '2026-01-01',
        remainingTermYears: 30,
        repaymentType: 'repayment',
        fixedPaymentAmount: 100
      });
    } catch (error) {
      didThrow = String(error?.message || '').toLowerCase().includes('negative amortisation');
    }

    assert(didThrow, 'Expected negative amortisation error was not thrown');
  }));

  cases.push(runCase('Annual overpayment reduces interest and payoff time', () => {
    const baseInputs = {
      currentBalance: 250000,
      annualInterestRate: 0.045,
      startDateIso: '2026-01-01',
      remainingTermYears: 30,
      repaymentType: 'repayment'
    };

    const base = computeAmortizationMonthlySchedule(baseInputs);
    const withOverpayment = computeAmortizationMonthlySchedule({
      ...baseInputs,
      annualOverpayment: 5000
    });

    assert(withOverpayment.monthsSimulated < base.monthsSimulated, 'Overpayment should shorten payoff time');
    assert(withOverpayment.totalInterestLifetime < base.totalInterestLifetime, 'Overpayment should reduce total interest');
  }));

  cases.push(runCase('Inclusive month count from explicit end date', () => {
    const projection = computeAmortizationMonthlySchedule({
      currentBalance: 12000,
      annualInterestRate: 0,
      startDateIso: '2026-03-15',
      endDateIso: '2027-02-20',
      repaymentType: 'repayment'
    });

    assert(projection.termMonthsPlanned === 12, `Expected 12 months, got ${projection.termMonthsPlanned}`);
  }));

  cases.push(runCase('loanKind=loan switches labels to loan wording', () => {
    const projection = computeMortgageProjection({
      loanKind: 'loan',
      currentBalance: 200000,
      annualInterestRate: 0.04,
      startDateIso: '2026-01-01',
      remainingTermYears: 25,
      repaymentType: 'repayment'
    }, { defaultLoanKind: 'loan' });

    const assumptionLabels = projection.assumptionsTable.rows.map((row) => String(row[0]));
    assert(assumptionLabels.includes('Current loan balance'), 'Expected current loan balance label');
    assert(assumptionLabels.includes('Loan term'), 'Expected loan term label');
    assert(String(projection.charts[0]?.title || '').startsWith('Loan '), 'Expected loan chart title');
  }));

  cases.push(runCase('Mortgage and loan projections are numerically identical for same inputs', () => {
    const shared = {
      currentBalance: 320000,
      annualInterestRate: 0.0425,
      startDateIso: '2026-01-01',
      endDateIso: '2052-12-01',
      repaymentType: 'repayment',
      fixedPaymentAmount: null,
      oneOffOverpayment: 0,
      annualOverpayment: 3000
    };

    const mortgageProjection = computeMortgageProjection({
      ...shared,
      loanKind: 'mortgage'
    }, { defaultLoanKind: 'mortgage' });
    const loanProjection = computeMortgageProjection({
      ...shared,
      loanKind: 'loan'
    }, { defaultLoanKind: 'loan' });

    assertApprox(
      mortgageProjection.debug.paymentUsedMonthly,
      loanProjection.debug.paymentUsedMonthly,
      1e-9,
      'Monthly payment should match between mortgage and loan'
    );
    assertApprox(
      mortgageProjection.debug.totalInterestLifetime,
      loanProjection.debug.totalInterestLifetime,
      1e-6,
      'Total interest should match between mortgage and loan'
    );
    assertApprox(
      mortgageProjection.debug.totalPaidLifetime,
      loanProjection.debug.totalPaidLifetime,
      1e-6,
      'Total paid should match between mortgage and loan'
    );
  }));

  const FOUR_CASES = {
    currentBalance: 320000,
    annualInterestRate: 0.0425,
    startDateIso: '2026-01-01',
    endDateIso: '2052-12-01',
    repaymentType: 'repayment',
    loanKind: 'mortgage',
    baseScenarioId: 'current',
    scenarios: [
      { id: 'current', title: 'No overpayment', oneOffOverpayment: 0, annualOverpayment: 0 },
      { id: 'annual-3k', title: '3,000 a year', annualOverpayment: 3000 },
      { id: 'lump-25k', title: '25,000 lump sum', oneOffOverpayment: 25000 },
      { id: 'both', title: 'Lump sum and 3,000 a year', oneOffOverpayment: 25000, annualOverpayment: 3000 }
    ]
  };

  cases.push(runCase('A lump sum holds the payment and shortens the term', () => {
    const shared = {
      currentBalance: 320000,
      annualInterestRate: 0.0425,
      startDateIso: '2026-01-01',
      endDateIso: '2052-12-01',
      repaymentType: 'repayment'
    };
    const plain = computeAmortizationMonthlySchedule(shared);
    const lump = computeAmortizationMonthlySchedule({ ...shared, oneOffOverpayment: 25000 });

    assertApprox(lump.monthlyPaymentUsed, plain.monthlyPaymentUsed, 1e-9, 'Payment should be unchanged by a lump sum');
    assert(lump.monthsSimulated < plain.monthsSimulated, 'A lump sum should clear the mortgage earlier');
    assert(lump.totalInterestLifetime < plain.totalInterestLifetime, 'A lump sum should reduce total interest');
  }));

  cases.push(runCase('overpaymentBenefit lowerPayment keeps the term instead', () => {
    const shared = {
      currentBalance: 320000,
      annualInterestRate: 0.0425,
      startDateIso: '2026-01-01',
      endDateIso: '2052-12-01',
      repaymentType: 'repayment',
      oneOffOverpayment: 25000
    };
    const shorter = computeAmortizationMonthlySchedule(shared);
    const lower = computeAmortizationMonthlySchedule({ ...shared, overpaymentBenefit: 'lowerPayment' });

    assert(lower.monthlyPaymentUsed < shorter.monthlyPaymentUsed, 'Lower-payment should reduce the repayment');
    assert(lower.monthsSimulated > shorter.monthsSimulated, 'Lower-payment should keep the loan running longer');
    assert(
      lower.totalInterestLifetime > shorter.totalInterestLifetime,
      'Taking the benefit as cash flow should save less interest'
    );
  }));

  cases.push(runCase('Every case is measured at the same contractual payment', () => {
    const comparison = computeMortgageComparison(FOUR_CASES);
    const base = comparison.cases[0];
    assert(comparison.cases.length === 4, 'Expected four cases');
    comparison.cases.forEach((item) => {
      assertApprox(item.monthlyPaymentUsed, base.monthlyPaymentUsed, 1e-9, `${item.id} should share the contractual payment`);
      assertApprox(
        item.interestSaved + item.totalInterestLifetime,
        base.totalInterestLifetime,
        0.01,
        `${item.id}: interest saved plus interest paid should reconstruct the base`
      );
    });
    assert(base.totalOverpaid === 0, 'The base overpays exactly nothing, not nearly nothing');
    assert(base.savedPerEuroOverpaid === null, 'The base has no per-euro figure to report');
  }));

  cases.push(runCase('Total overpaid comes from the schedule, not the inputs', () => {
    const comparison = computeMortgageComparison(FOUR_CASES);
    const annual = comparison.cases.find((item) => item.id === 'annual-3k');
    const naive = 3000 * Math.ceil(annual.monthsSimulated / 12);
    assert(annual.totalOverpaid > 0, 'A regular overpayment should register as money paid in');
    assert(
      annual.totalOverpaid < naive,
      'The final year is clipped to the balance, so the total must be below years times amount'
    );
  }));

  cases.push(runCase('A case inherits every fact it does not restate', () => {
    const comparison = computeMortgageComparison({
      ...FOUR_CASES,
      annualInterestRate: 0.06,
      scenarios: [
        { id: 'current', title: 'No overpayment' },
        { id: 'switch', title: 'Switch rate', annualInterestRate: 0.032 }
      ]
    });
    const [base, switched] = comparison.cases;
    assert(switched.monthlyPaymentUsed < base.monthlyPaymentUsed, 'The overriding case uses its own rate');
    assert(switched.interestSaved > 0, 'Switching to a lower rate should save interest');
    assert(switched.savedPerEuroOverpaid === null, 'A saving with no overpayment reports no per-euro figure');
  }));

  cases.push(runCase('Normalising twice describes the same cases as normalising once', () => {
    const authored = computeMortgageComparison(FOUR_CASES).cases.map((item) => Math.round(item.interestSaved));
    let stored = normalizeMortgageInputs(FOUR_CASES);
    for (let round = 0; round < 3; round += 1) {
      stored = normalizeMortgageInputs(stored);
      const again = computeMortgageComparison(stored).cases.map((item) => Math.round(item.interestSaved));
      assert(
        JSON.stringify(again) === JSON.stringify(authored),
        'Re-normalising must not quietly drop every case override'
      );
    }
  }));

  cases.push(runCase('Case buttons preview their own outcome', () => {
    const list = getMortgageScenarioCases(FOUR_CASES);
    assert(list.length === 4, 'Expected four case buttons');
    assert(/interest$/.test(list[0].detail), 'The base states what it costs');
    list.slice(1).forEach((item) => {
      assert(item.detail.startsWith('Saves '), `${item.id} should state what it saves`);
    });
  }));

  cases.push(runCase('Refused: over the cap, duplicate ids, and an unknown benefit', () => {
    const refusals = [
      [{ ...FOUR_CASES, scenarios: [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, title: `C${n}` })) }, 'at most 4 cases'],
      [{ ...FOUR_CASES, scenarios: [{ id: 'a', title: 'A' }, { id: 'a', title: 'A again' }] }, 'must be unique'],
      [{ ...FOUR_CASES, overpaymentBenefit: 'whicheverIsBigger' }, 'shorterTerm'],
      [{ ...FOUR_CASES, baseScenarioId: 'not-a-case' }, 'must match a scenario id']
    ];

    refusals.forEach(([payload, fragment]) => {
      let message = '';
      try {
        computeMortgageProjection(payload);
      } catch (error) {
        message = String(error?.message || '');
      }
      assert(message.includes(fragment), `Expected a refusal mentioning "${fragment}", got "${message}"`);
    });
  }));

  cases.push(runCase('A single-case payload behaves as it did before cases existed', () => {
    const projection = computeMortgageProjection({
      currentBalance: 200000,
      annualInterestRate: 0.04,
      startDateIso: '2026-01-01',
      remainingTermYears: 25,
      repaymentType: 'repayment'
    });
    assert(projection.comparisonTable === null, 'A single case has nothing to compare');
    // One chart, for the surfaces that render from the payload alone; the
    // module screen draws its own balance curve and year-interest columns.
    assert(projection.charts.length === 1, 'And draws only its own chart');
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
    console.warn('[MortgageTests] Completed with failures', summary);
  } else {
    console.info('[MortgageTests] All tests passed', summary);
  }

  return summary;
}
