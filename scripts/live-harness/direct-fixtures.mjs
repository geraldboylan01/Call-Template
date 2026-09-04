/** Shared synthetic inputs for the direct planner and completion harnesses. */
import { createDefaultHousePurchaseInputs } from '../../js/house_purchase/index.js';
import { LIQUIDITY_RESERVE_POLICY } from '../../js/liquidity_reserve.js';
import { PLANEIR_ASSUMPTIONS, approvedCollegeScenarios } from '../../js/planning/planeir_assumptions.js';

export function directModuleTestInputs(TODAY) {
  const house = createDefaultHousePurchaseInputs(TODAY);
Object.assign(house, {
  lendingCategory: 'first_time_buyer',
  applicants: [{
    ...house.applicants[0],
    id: 'primary',
    label: 'Aoife',
    age: 34,
    employmentStatus: 'employee',
    grossAnnualIncome: 68000,
    incomeReliability: 'stable',
    schemeBuyerStatus: 'first_time_buyer'
  }],
  cashSavingsContributions: [{ ownerId: 'primary', amount: 70000 }],
  currentCashSavings: 70000,
  monthlyNetHouseholdIncome: 4200,
  monthlyEssentialExpensesExcludingHousingDebtAndRent: 2200,
  currentMonthlyRent: 1700,
  currentMonthlySavings: 1000,
  plannedMonthlySavings: 1000,
  targetPropertyPrice: 400000,
  targetPurchaseDate: '2028-06-30',
  localAuthorityCode: 'unknown'
});

  const inputs = {
  personal_balance_sheet: {
    currency: 'EUR',
    assetPositions: [
      { id: 'home', label: 'Home', bucket: 'lifestyle_assets', amount: 450000, source: 'properties' },
      { id: 'cash', label: 'Savings', bucket: 'spendable_reserves', amount: 50000, source: 'assets' },
      { id: 'pension', label: 'Pension', bucket: 'retirement_funding', amount: 180000, source: 'pensions' }
    ],
    liabilityPositions: [{ id: 'mortgage', label: 'Mortgage', amount: 240000, source: 'liabilities' }],
    monthlyExpenditure: 2500,
    reconciliationWarnings: [],
    currencyWarnings: []
  },
  pension_projection: {
    currentYear: Number(TODAY.slice(0, 4)),
    inflationRate: 0.02,
    growthRate: 0.05,
    wageGrowthRate: 0.02,
    incomeMode: 'target',
    targetIncomeToday: 70000,
    targetStartYear: Number(TODAY.slice(0, 4)) + 26,
    horizonEndAge: 95,
    pensions: [
      { id: 'primary', title: 'John', currentAge: 42, retirementAge: 67, currentSalary: 85000, currentPot: 180000, personalPct: 0.08, employerPct: 0.06, includeStatePension: true, statePensionFraction: 1, statePensionStartAge: 66, statePensionEscalationRate: 0.02 },
      { id: 'partner', title: 'Mary', currentAge: 40, retirementAge: 66, currentSalary: 70000, currentPot: 120000, personalPct: 0.07, employerPct: 0.05, includeStatePension: true, statePensionFraction: 1, statePensionStartAge: 66, statePensionEscalationRate: 0.02 }
    ],
    otherIncomeSources: []
  },
  liquidity_analysis: {
    currentCash: 90000,
    monthlyExpenditure: 5000,
    annualExpenditure: 60000,
    clientStatus: 'not-retired',
    policyVersion: LIQUIDITY_RESERVE_POLICY.policyVersion,
    minimumBufferMonths: 3,
    targetBufferMonths: 6
  },
  mortgage_analysis: {
    loanKind: 'mortgage', currentBalance: 240000, annualInterestRate: 0.041,
    startDateIso: TODAY, endDateIso: null, remainingTermYears: 22, repaymentType: 'repayment',
    fixedPaymentAmount: null, oneOffOverpayment: 0, annualOverpayment: 0
  },
  loan_analysis: {
    loanKind: 'loan', currentBalance: 18000, annualInterestRate: 0.085,
    startDateIso: TODAY, endDateIso: null, remainingTermYears: 4, repaymentType: 'repayment',
    fixedPaymentAmount: null, oneOffOverpayment: 0, annualOverpayment: 500
  },
  college_funding: {
    currentYear: Number(TODAY.slice(0, 4)),
    inflationRate: PLANEIR_ASSUMPTIONS.inflation.educationRate,
    children: [{ id: 'child-1', title: 'Child', currentAge: 8, collegeStartAge: 18, collegeDurationYears: 4 }],
    scenarios: approvedCollegeScenarios()
  },
  house_purchase: house
};
  return inputs;
}
