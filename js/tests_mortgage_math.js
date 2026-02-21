import {
  computeMonthlyPayment,
  computeAmortizationMonthlySchedule,
  computeMortgageProjection
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
