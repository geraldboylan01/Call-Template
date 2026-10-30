import { PLANEIR_ASSUMPTIONS, PLANEIR_ASSUMPTIONS_VERSION } from '../planeir_assumptions.js';
import { HOUSE_PURCHASE_RULES, HOUSE_PURCHASE_RULES_VERSION } from '../../house_purchase/config.js';
import { calculatePurchaseCosts } from '../../house_purchase/calculations.js';
import { computeHomeTradeDownCashPurchase } from '../../home_trade_down_math.js';
import { computeRentalKeepOrSellProjection } from '../../rental_keep_or_sell_math.js';
import { computeAmortizationMonthlySchedule } from '../../mortgage_math.js';
import { priceInvestmentSales } from './investment_sales.js';
import { IE_CGT_FIXED_RULES } from '../tax/rules_ie.js';

export const PROPERTY_LEVERS = ['tradeDownHome', 'sellProperty'];
function refuse(path, message, code = 'missing_information') { throw Object.assign(new Error(message), { path, code }); }
const money = (value, path) => {
  if (!value || value.currency !== 'EUR' || !Number.isFinite(value.amount)) refuse(path, 'Establish this EUR amount, including a stated zero where appropriate.');
  return value.amount;
};
export function propertyMoveBounds(pack) {
  const central = PLANEIR_ASSUMPTIONS.routes.propertyMoves;
  const homes = pack.household.properties.filter(p => p.use === 'home');
  const year = Number(pack.calculationDate.slice(0, 4));
  return { year: [year, year + central.maximumYearsAhead],
    newHomePrice: homes.length === 1 && homes[0].currentValue ? [Math.ceil(homes[0].currentValue.amount * central.minimumReplacementShare * 100) / 100,
      Math.floor(homes[0].currentValue.amount * central.maximumReplacementShare * 100) / 100] : null,
    approvalStatus: central.approvalStatus, basis: central.basis, assumptionsVersion: PLANEIR_ASSUMPTIONS_VERSION };
}
function propertyFor(pack, change) {
  const candidates = pack.household.properties.filter(p => change.type === 'tradeDownHome' ? p.use === 'home' : p.propertyId === change.propertyId);
  if (candidates.length !== 1) refuse('/household/properties', 'Identify one home for a trade down, or the specific second property for a sale.');
  const property = candidates[0], index = pack.household.properties.indexOf(property), path = '/household/properties/' + index;
  if (change.type === 'sellProperty' && property.use === 'home') refuse(path + '/use', 'Use tradeDownHome for the home.', 'invalid_input');
  if (!property.ownerIds.length || property.ownerIds.length > 2
    || property.ownerIds.some(id => ![pack.household.primaryPerson.personId, pack.household.partner?.personId].includes(id))) refuse(path + '/ownerIds', 'Establish the actual household owners.');
  if (change.type === 'sellProperty' && property.ownerIds.length === 2 && property.jointEqualOwnership !== true) refuse(path + '/jointEqualOwnership', 'Confirm equal joint ownership; the shared tax engine does not infer unequal shares.');
  return { property, path };
}
function debtsAt(pack, property, date, debtInputs) {
  return property.associatedLiabilityIds.map(id => {
    const debt = pack.household.liabilities.find(d => d.liabilityId === id), path = '/household/liabilities/' + pack.household.liabilities.indexOf(debt);
    if (!debt) refuse('/household/properties', 'Bind each mortgage to an existing liability.');
    if (pack.household.properties.filter(p => p.associatedLiabilityIds.includes(id)).length !== 1) refuse('/household/properties', 'A shared property loan needs an explicit allocation contract.');
    const balance = money(debt.currentBalance, path + '/currentBalance');
    const monthly = money(debt.monthlyPayment, path + '/monthlyPayment');
    if (balance === 0) return { liabilityId: id, balance: 0, annualPayment: 0, endsInYears: 0 };
    if (!Number.isFinite(debt.annualInterestRate) || !(debt.remainingTermMonths > 0)) refuse(path, 'Establish the rate and term for the native mortgage timeline.');
    const input = debtInputs?.[id] ?? { currentBalance: balance, annualInterestRate: debt.annualInterestRate, startDateIso: pack.calculationDate,
      remainingTermYears: debt.remainingTermMonths / 12, fixedPaymentAmount: monthly, repaymentType: 'repayment', scenarios: [{ id: 'today' }], baseScenarioId: 'today' };
    const projection = computeAmortizationMonthlySchedule(input, { scenarioId: debtInputs?.[id] ? 'clear-by-age' : 'today' });
    if (!projection.payoffDateIso && date > projection.endMonthIso) refuse(path + '/remainingTermMonths', 'A sale after an unpaid loan’s term needs its settlement/balloon facts; the old repayment is not extended.');
    const previous = date === pack.calculationDate ? null : projection.monthlySchedule.filter(row => row.dateIso < date).at(-1);
    const balanceAtSale = previous?.balanceEnd ?? projection.openingBalance;
    return { liabilityId: id, label: debt.label, balance: balanceAtSale,
      annualPayment: balanceAtSale > 0 ? 12 * (debtInputs?.[id] ? projection.monthlyPaymentUsed : monthly) : 0,
      endsInYears: projection.payoffDateIso ? Math.ceil(projection.monthsSimulated / 12) : null };
  });
}
function rentalFacts(pack, property, path) {
  const rent = money(property.rentAnnual, path + '/rentAnnual');
  const running = money(property.runningCostsAnnual, path + '/runningCostsAnnual');
  const tax = money(property.taxOnRentalProfitAnnual, path + '/taxOnRentalProfitAnnual');
  if (!Array.isArray(property.rentalIncomeSourceIds)) refuse(path + '/rentalIncomeSourceIds', 'Bind the rent to its income records, or explicitly record no rental income.');
  const incomes = property.rentalIncomeSourceIds.map(id => {
    const income = pack.household.incomeSources.find(i => i.incomeId === id);
    if (!income || income.type !== 'rental' || income.ownerIds.some(id => !property.ownerIds.includes(id))) refuse(path + '/rentalIncomeSourceIds', 'Bind rental income owned by this property’s owners.');
    if (pack.household.properties.filter(p => p.rentalIncomeSourceIds?.includes(id)).length !== 1) refuse(path + '/rentalIncomeSourceIds', 'Rental income cannot belong to two properties.');
    return income;
  });
  if (Math.abs(incomes.reduce((sum, income) => sum + money(income.netAnnual, '/household/incomeSources/netAnnual'), 0) - (rent - tax)) > 0.005) refuse(path + '/rentalIncomeSourceIds',
    'Reconcile the property’s rent less its stated incremental rental tax with the bound bank receipts. Running costs and repayments are separate regular expenses.');
  // Preserve stated salary/pension bank receipts when removing the rent; do not
  // silently switch the remaining household to estimated bank pay.
  for (const owner of property.ownerIds) for (const income of pack.household.incomeSources.filter(i => i.ownerIds.includes(owner))) {
    if (income.ownerIds.length !== 1 || !income.netAnnual) refuse('/household/incomeSources/netAnnual', 'Establish separate per-person bank receipts before stopping this rental income.');
  }
  return { rent, running, tax, incomeIds: property.rentalIncomeSourceIds };
}

/** Price one route's complete capital-sale batch from its own opening history. */
export function pricePropertyRoute(pack, route, index, debtInputs = {}) {
  const ci = route.changes.findIndex(c => PROPERTY_LEVERS.includes(c.type));
  const ids = route.changes.filter(c => c.type === 'sellAsset').map(c => c.assetId);
  const ordinary = (date = pack.calculationDate, state = pack.planningInputs.openingTaxState, events = [], investments = ids) =>
    priceInvestmentSales(pack.household, investments, date, pack.planningInputs.householdTaxStatus, state, events);
  if (ci < 0) return { sales: ordinary(), move: null };
  if (!pack.chapters.includes('household_cash_flow')) refuse('/chapters/household_cash_flow', 'Include cash flow to price the property move’s change in bank income and repayments.');
  const change = route.changes[ci], here = `/routes/${index}/changes/${ci}`, bounds = propertyMoveBounds(pack);
  if (change.year < bounds.year[0] || change.year > bounds.year[1]) refuse(here + '/year', 'Year is outside the central property-move horizon.', 'invalid_input');
  const { property, path } = propertyFor(pack, change);
  const value = money(property.currentValue, path + '/currentValue');
  if (property.associatedLiabilityIds.length === 0 && pack.household.liabilities.some(d => d.type === 'mortgage'
    && !pack.household.properties.some(p => p.associatedLiabilityIds.includes(d.liabilityId)))) refuse(path + '/associatedLiabilityIds', 'Bind unallocated mortgages before assuming this property is debt-free.');
  if (route.changes.some(c => (c.type === 'clearOutgoing' && property.associatedLiabilityIds.includes(pack.planningInputs.outgoingBindings.find(b => b.id === c.outgoingId)?.liabilityId))
    || (c.type === 'useCash' && property.associatedLiabilityIds.includes(pack.planningInputs.goalBindings.find(b => b.goalId === c.goalId)?.liabilityId)))) refuse(here, 'A property sale and another cash clearance cannot repay the same loan.', 'invalid_input');
  const date = change.year === bounds.year[0] ? pack.calculationDate : `${change.year}-01-01`;
  const debts = debtsAt(pack, property, date, debtInputs), loanBalance = debts.reduce((sum, d) => sum + d.balance, 0);
  const central = PLANEIR_ASSUMPTIONS.routes.propertyMoves;
  const sellingCosts = value * central.agentFeeRate + central.saleLegalCosts;
  let sales, tax = 0, rental = null, native, event = null, buyingCosts = null;
  if (change.type === 'tradeDownHome') {
    if (property.homeUse !== 'throughout') refuse(path + '/homeUse', 'Confirm full principal-private-residence use before applying zero CGT to the home.');
    if (change.newHomePrice < bounds.newHomePrice[0] || change.newHomePrice > bounds.newHomePrice[1]) refuse(here + '/newHomePrice', 'Replacement price is outside the central shares of current value.', 'invalid_input');
    const costs = HOUSE_PURCHASE_RULES.purchaseCosts;
    buyingCosts = calculatePurchaseCosts({ purchaseCosts: { ...costs, stampDutyMode: 'rules', surveyOrEngineer: costs.surveyOrEngineerByAcquisition.second_hand } }, change.newHomePrice, HOUSE_PURCHASE_RULES);
    native = computeHomeTradeDownCashPurchase({ homeValue: value, mortgageBalance: loanBalance,
      currentAnnualRepayments: debts.reduce((sum, d) => sum + d.annualPayment, 0), sellingCosts, buyingCosts: buyingCosts.total, newHomePrice: change.newHomePrice });
    sales = ordinary();
  } else {
    const cost = money(property.baseCost, path + '/baseCost');
    for (const field of ['acquisitionDate', 'acquiredBy', 'homeUse']) if (!property[field] || property[field] === 'unknown') refuse(path + '/' + field, 'Establish this property acquisition or home-use fact; no missing fact is assumed.');
    if (property.acquisitionDate > date) refuse(path + '/acquisitionDate', 'Acquisition must be no later than disposal.', 'invalid_input');
    if (property.acquisitionDate < IE_CGT_FIXED_RULES.indexation.earliestSupportedAcquisition) refuse(path + '/acquisitionDate', 'The native tax engine needs a market-value basis for a property held before 6 April 1974; that adapter is not present.');
    rental = rentalFacts(pack, property, path);
    event = { type: 'propertyDisposal', personId: property.ownerIds.length === 2 ? 'joint' : property.ownerIds[0], disposalDate: date,
      proceeds: value, acquisitionCost: cost, acquisitionDate: property.acquisitionDate, acquiredBy: property.acquiredBy, homeUse: property.homeUse, sellingCosts };
    const now = date === pack.calculationDate;
    sales = ordinary(pack.calculationDate, pack.planningInputs.openingTaxState, now ? [event] : []);
    const taxBatch = now ? sales : ordinary(date, sales.nextState ?? pack.planningInputs.openingTaxState, [event], []);
    tax = taxBatch.propertyDisposals[0].tax;
    native = computeRentalKeepOrSellProjection({ rentPerYear: rental.rent, runningCostsPerYear: rental.running, taxOnRentalProfitPerYear: rental.tax,
      loanRepaymentsPerYear: debts.reduce((sum, d) => sum + d.annualPayment, 0), salePrice: value, sellingCosts, loanBalance, taxOnGain: tax }).debug;
    native.taxBatch = taxBatch;
  }
  const cashReleased = change.type === 'tradeDownHome' ? native.cashReleased : native.cases.find(c => c.id === 'sell').result;
  if (cashReleased < 0) refuse(here + (change.type === 'tradeDownHome' ? '/newHomePrice' : '/propertyId'), 'Sale equity does not cover the loan, costs and replacement purchase; no new borrowing is inferred.', 'invalid_input');
  return { sales, move: { type: change.type, propertyId: property.propertyId, propertyPath: path, source: here, year: change.year, date,
    offset: change.year - bounds.year[0], cashReleased, sellingCosts, buyingCosts, tax, debts, rental, native,
    ...(change.type === 'tradeDownHome' ? { newHomePrice: change.newHomePrice } : {}),
    assumptions: { ...central, assumptionsVersion: PLANEIR_ASSUMPTIONS_VERSION, housePurchaseRules: HOUSE_PURCHASE_RULES_VERSION,
      timing: 'Current-year sale at the pack date; later sales at start of the chosen year. Current property values and rents held flat, not forecast. Replacement bought outright, existing loans settled; no new loan or break fee is inferred.' } } };
}

/** Today's chapter inputs change only for a sale taking place today. */
export function applyPropertyMove(profile, move, cashAssetId) {
  if (!move || move.offset !== 0) return;
  const cash = profile.assets.find(a => a.assetId === cashAssetId && a.type === 'cash');
  if (!cash?.currentValue) refuse('/planningInputs/cashAssetId', 'Identify the cash account receiving property proceeds.');
  cash.currentValue.amount += move.cashReleased;
  const property = profile.properties.find(p => p.propertyId === move.propertyId);
  property.currentValue.amount = move.type === 'tradeDownHome' ? move.newHomePrice : 0;
  const spending = money(profile.expenses.annualTotal, '/household/expenses/annualTotal');
  const removed = move.debts.reduce((sum, d) => sum + d.annualPayment, 0) + (move.rental?.running ?? 0);
  if (removed > spending + 0.005) refuse('/household/expenses/annualTotal', 'Confirm that spending includes property running costs and repayments.');
  profile.expenses.annualTotal.amount -= removed;
  for (const entry of move.debts) {
    const debt = profile.liabilities.find(d => d.liabilityId === entry.liabilityId);
    debt.currentBalance.amount = 0; debt.monthlyPayment.amount = 0;
  }
  for (const income of profile.incomeSources.filter(i => move.rental?.incomeIds.includes(i.incomeId))) {
    income.grossAnnual = { amount: 0, currency: 'EUR' }; income.netAnnual = { amount: 0, currency: 'EUR' };
  }
}
