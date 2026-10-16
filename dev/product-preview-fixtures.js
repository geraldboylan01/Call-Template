import { normalizeMortgageInputs, computeMortgageComparison } from '../js/mortgage_math.js';
import { computePersonalBalanceSheet } from '../js/personal_balance_sheet.js';

// Fictional, reproducible examples. Every displayed total comes from the engines.
export const mortgageInputs = normalizeMortgageInputs({
  currentBalance: 320000,
  annualInterestRate: 0.0425,
  startDateIso: '2026-01-01',
  endDateIso: '2052-12-01',
  repaymentType: 'repayment',
  loanKind: 'mortgage',
  overpaymentBenefit: 'shorterTerm',
  baseScenarioId: 'current',
  scenarios: [
    { id: 'current', title: 'Current mortgage', oneOffOverpayment: 0, annualOverpayment: 0 },
    { id: 'lump', title: '€20,000 lump sum', oneOffOverpayment: 20000, annualOverpayment: 0 },
    { id: 'regular', title: '€3,000 each year', oneOffOverpayment: 0, annualOverpayment: 3000 }
  ]
});
export const mortgageComparison = computeMortgageComparison(mortgageInputs);
export const mortgageModule = {
  id: 'fictional-mortgage-preview', title: 'Mortgage Projection', media: [], ui: {},
  generated: { mortgageInputs, summaryHtml: '', assumptions: { columns: [], rows: [] }, outputs: { columns: [], rows: [] }, tables: [], charts: [] }
};

const position = (id, label, bucket, amount) => ({ id, label, bucket, amount, source: 'fictional_preview' });
const home = position('home', 'Family home', 'lifestyle_assets', 500000);
const pension = position('pension', 'Pension fund', 'retirement_funding', 220000);
const rental = position('rental', 'Rental property', 'concentrated_assets', 300000);
const cash = (amount) => position('cash', 'Cash savings', 'spendable_reserves', amount);
const homeLoan = (amount) => position('home-loan', 'Home mortgage', 'liabilities', amount);
const rentalLoan = position('rental-loan', 'Rental mortgage', 'liabilities', 120000);
const definitions = [
  { id: 'current', title: 'Current position', assets: [home, cash(35000), pension, rental], debts: [homeLoan(200000), rentalLoan], movements: [] },
  { id: 'sell-rental', title: 'Sell rental property', assets: [home, cash(215000), pension], debts: [homeLoan(200000)], movements: [
    { from: { sectionKey: 'legacy', rowLabel: 'Rental property', amount: 300000 }, to: [
      { sectionKey: 'liabilities', rowLabel: 'Rental mortgage', amount: 120000, action: 'reduce' },
      { sectionKey: 'liquidity', rowLabel: 'Cash savings', amount: 180000, action: 'add' }
    ] }
  ] },
  { id: 'reduce-home-loan', title: 'Sell & reduce home loan', assets: [home, cash(115000), pension], debts: [homeLoan(100000)], movements: [
    { from: { sectionKey: 'legacy', rowLabel: 'Rental property', amount: 300000 }, to: [
      { sectionKey: 'liabilities', rowLabel: 'Rental mortgage', amount: 120000, action: 'reduce' },
      { sectionKey: 'liquidity', rowLabel: 'Cash savings', amount: 180000, action: 'add' }
    ] },
    { from: { sectionKey: 'liquidity', rowLabel: 'Cash savings', amount: 100000 }, to: [
      { sectionKey: 'liabilities', rowLabel: 'Home mortgage', amount: 100000, action: 'reduce' }
    ] }
  ] }
];
const bucketMap = [
  ['lifestyle', 'Lifestyle', 'lifestyle_assets'],
  ['liquidity', 'Liquidity', 'spendable_reserves'],
  ['longevity', 'Longevity', 'retirement_funding'],
  ['legacy', 'Legacy', 'concentrated_assets']
];
export const balanceSheetCases = definitions.map((definition) => {
  const result = computePersonalBalanceSheet({ assetPositions: definition.assets, liabilityPositions: definition.debts });
  const sections = bucketMap.map(([key, title, bucket]) => ({
    key, title, columns: ['Asset', 'Amount (€)'],
    rows: result.buckets[bucket].positions.map((item) => [item.label, item.amount]),
    subtotalLabel: `${title} total`, subtotalValue: result.buckets[bucket].total
  }));
  sections.push({ key: 'liabilities', title: 'Liabilities', columns: ['Liability', 'Amount (€)'], rows: result.liabilities.map((item) => [item.label, item.amount]), subtotalLabel: 'Total liabilities', subtotalValue: result.totalLiabilities });
  sections.push({ key: 'summary', title: 'Summary', columns: ['Metric', 'Amount (€)'], rows: [['Gross assets', result.grossAssets], ['Total liabilities', result.totalLiabilities], ['Net worth', result.netWorth]], subtotalLabel: 'Net worth', subtotalValue: result.netWorth });
  return { id: definition.id, title: definition.title, sections, movements: definition.movements, result };
});
export const balanceSheetModule = {
  id: 'fictional-pbs-preview', title: 'Personal Balance Sheet', media: [], ui: {},
  generated: { summaryHtml: '', outputsBucketed: { currencySymbol: '€', sections: balanceSheetCases[0].sections, scenarios: balanceSheetCases.slice(1).map(({ result, ...scenario }) => scenario) }, charts: [] }
};
