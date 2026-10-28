import { computeAmortizationMonthlySchedule } from '../../mortgage_math.js';
import { resolveTaxRules } from '../tax/resolve.js';
import { PLANEIR_ASSUMPTIONS, PLANEIR_ASSUMPTIONS_VERSION } from '../planeir_assumptions.js';
import { IE_TAX_RULES_VERSION } from '../tax/rules_ie.js';
import { figuresVersionLabel } from '../figures/get_figures.js';
import { priceInvestmentSales } from './investment_sales.js';

const number = value => typeof value === 'number' && Number.isFinite(value);
const euro = value => value?.currency === 'EUR' && number(value.amount) ? value.amount : null;
const HEADLINES = Object.freeze({
  idle_cash_vs_debt: 'Cash and borrowing rates', debts_other_than_mortgage: 'Loans and cards other than the mortgage',
  investment_at_a_loss: 'An investment sale records a loss', tax_due: 'Stated tax due',
  mortgage_could_be_shorter: 'The mortgage term with spare cash applied'
});

/** Issue facts use native engines and stated bindings, with no inferred answers. */
export function scanStoryIssues(r) {
  const issues = [], unavailable = [];
  const household = r.household;
  if (!household) return { issues, unavailable: [{ id: 'household_source', reason: 'The compiled route has no household source.' }] };
  const add = (id, items) => {
    if (!items.length) return;
    const headlineKey = `issues.${id}.headline`, orderKey = `issues.${id}.order`;
    r.calculated(headlineKey, HEADLINES[id], 'text', [], 'neutral_issue_headline');
    r.calculated(orderKey, items.map(item => item.id), 'list', [r.householdPath], 'issue_item_order');
    issues.push({ id, headline: HEADLINES[id], headlineKey, orderKey, state: 'present', addressed: false, items });
  };
  const field = (issue, id, name, value, unit, inputs, calculation) => {
    const key = `issues.${issue}.${id}.${name}`;
    if (value === null || value === undefined) r.unavailable(key, 'This fact was not given or could not be calculated.',
      r.source(null, { kind: 'calculation', inputs, calculation }), false, 'not_stated_or_not_computed');
    else r.calculated(key, value, unit, inputs, calculation);
    return key;
  };
  const debtRows = household.liabilities.map((debt, index) => ({ debt, path: r.householdPath + '/liabilities/' + index }))
    .filter(({ debt }) => ['loan', 'credit_card'].includes(debt.type) && euro(debt.currentBalance) !== 0)
    .sort((a, b) => (number(b.debt.annualInterestRate) ? b.debt.annualInterestRate : -Infinity)
      - (number(a.debt.annualInterestRate) ? a.debt.annualInterestRate : -Infinity) || a.debt.liabilityId.localeCompare(b.debt.liabilityId));
  add('debts_other_than_mortgage', debtRows.map(({ debt, path }) => {
    const id = debt.liabilityId, balance = euro(debt.currentBalance), rate = debt.annualInterestRate;
    const end = r.ledger?.freedCash?.find(event => event.liabilityId === id)?.payoffDateIso;
    const factKeys = [field('debts_other_than_mortgage', id, 'label', debt.label, 'text', [path + '/label'], 'stated_label'),
      field('debts_other_than_mortgage', id, 'balance', balance, 'EUR', [path + '/currentBalance'], 'stated_balance'),
      field('debts_other_than_mortgage', id, 'rate', rate, 'ratio', [path + '/annualInterestRate'], 'stated_rate'),
      field('debts_other_than_mortgage', id, 'yearlyCost', number(balance) && number(rate) ? balance * rate : null,
        'EUR/year', [path + '/currentBalance', path + '/annualInterestRate'], 'annual_interest_at_stated_balance')];
    if (end) factKeys.push(field('debts_other_than_mortgage', id, 'endDate', end, 'date', [r.ledgerPath + '/freedCash'], 'native_contract_end'));
    return { id, label: debt.label, factKeys, rateKnown: number(rate), costBasis: 'Annual interest at the stated balance; not a repayment forecast' };
  }));
  const spare = r.facts['position.spareCash']?.value;
  const compatible = r.compiled.versions.assumptions === PLANEIR_ASSUMPTIONS_VERSION
    && r.compiled.versions.taxRules === IE_TAX_RULES_VERSION && r.compiled.versions.figures === figuresVersionLabel();
  const netCashRate = compatible ? PLANEIR_ASSUMPTIONS.cash.instantAccessGrossRate * (1 - resolveTaxRules(Number(r.compiled.calculationDate.slice(0, 4))).dirt.rate) : null;
  if (!compatible) for (const id of ['idle_cash_vs_debt', 'investment_at_a_loss', 'mortgage_could_be_shorter']) {
    unavailable.push({ id, code: 'versions_unavailable', reason: 'Recompile with the matching rules and assumptions before calculating this issue.' });
  }
  if (!number(spare)) unavailable.push({ id: 'idle_cash_vs_debt', reason: 'Spare cash above the reserve has not been calculated.' });
  else if (compatible) add('idle_cash_vs_debt', household.liabilities.flatMap((debt, index) => {
    if (!['mortgage', 'loan', 'credit_card'].includes(debt.type)) return [];
    const balance = euro(debt.currentBalance), rate = debt.annualInterestRate;
    if (balance !== 0 && (!number(balance) || !number(rate))) unavailable.push({ id: 'idle_cash_vs_debt', entityId: debt.liabilityId, reason: 'The debt’s balance and rate are needed to compare its cost with cash.' });
    if (!number(balance) || !number(rate) || spare <= 0 || balance <= 0 || rate <= netCashRate) return [];
    const path = r.householdPath + '/liabilities/' + index, amount = Math.min(spare, balance), id = debt.liabilityId;
    return [{ id, label: debt.label, factKeys: [
      field('idle_cash_vs_debt', id, 'spareCash', spare, 'EUR', ['position.spareCash'], 'available_cash'),
      field('idle_cash_vs_debt', id, 'cashRateAfterTax', netCashRate, 'ratio', [], 'central_cash_rate_after_dirt'),
      field('idle_cash_vs_debt', id, 'loanRate', rate, 'ratio', [path + '/annualInterestRate'], 'stated_rate'),
      field('idle_cash_vs_debt', id, 'comparedAmount', amount, 'EUR', ['position.spareCash', path + '/currentBalance'], 'smaller_of_cash_and_debt'),
      field('idle_cash_vs_debt', id, 'yearlyDifference', amount * (rate - netCashRate), 'EUR/year', [path, 'position.spareCash'], 'annual_rate_difference_on_compared_amount')
    ] }];
  }));
  if (debtRows.some(({ debt }) => !number(debt.annualInterestRate) || euro(debt.currentBalance) === null)) {
    unavailable.push({ id: 'debt_costs', reason: 'Unstated rates or balances remain unknown; those debts are not ordered as cheaper debts or assigned zero cost.' });
  }
  const losses = [];
  for (const [index, asset] of (compatible ? household.assets : []).entries()) {
    if (asset.type !== 'investment' || asset.investmentTaxTreatment !== 'ordinary_cgt' || !(euro(asset.currentValue) > 0)) continue;
    if (!asset.baseCost) {
      unavailable.push({ id: 'investment_at_a_loss', entityId: asset.assetId, code: 'base_cost_missing', reason: 'Base cost was not given, so a disposal loss is not asserted.' }); continue;
    }
    const path = r.householdPath + '/assets/' + index;
    // Missing sale costs are not silently supplied by the tax adapter's legacy
    // zero-cost fallback. A stated zero remains a valid fact.
    if (euro(asset.sellingCosts) === null) {
      unavailable.push({ id: 'investment_at_a_loss', entityId: asset.assetId, reason: 'Selling costs were not given, so a disposal loss is not asserted.' }); continue;
    }
    try {
      const priced = priceInvestmentSales(household, [asset.assetId], r.compiled.calculationDate,
        r.pack.planningInputs.householdTaxStatus, r.pack.planningInputs.openingTaxState);
      const result = priced.result.disposals[0];
      if (result.acquisitionCostBasis !== 'stated' || result.outcome !== 'loss') continue;
      const id = asset.assetId;
      losses.push({ id, label: asset.label, factKeys: [
        field('investment_at_a_loss', id, 'value', result.proceeds, 'EUR', [path], 'native_tax_disposal_proceeds'),
        field('investment_at_a_loss', id, 'baseCost', result.acquisitionCost, 'EUR', [path], 'native_tax_stated_base_cost'),
        field('investment_at_a_loss', id, 'sellingCosts', result.sellingCosts, 'EUR', [path], 'native_tax_selling_costs'),
        field('investment_at_a_loss', id, 'loss', result.allowableLoss, 'EUR', [path], 'native_tax_allowable_loss_after_selling_costs')
      ] });
    } catch (error) { unavailable.push({ id: 'investment_at_a_loss', entityId: asset.assetId, reason: error.message }); }
  }
  add('investment_at_a_loss', losses);
  add('tax_due', (r.pack.planningInputs.taxDue ?? []).flatMap(binding => {
    const index = household.liabilities.findIndex(debt => debt.liabilityId === binding.liabilityId);
    const debt = household.liabilities[index], amount = euro(debt?.currentBalance);
    if (!number(amount)) { unavailable.push({ id: 'tax_due', entityId: binding.liabilityId, reason: 'The bound tax liability has no stated EUR balance.' }); return []; }
    if (amount === 0) return [];
    return [{ id: binding.liabilityId, factKeys: [field('tax_due', binding.liabilityId, 'amount', amount, 'EUR', [r.householdPath + '/liabilities/' + index], 'bound_tax_liability'),
      field('tax_due', binding.liabilityId, 'dueDate', binding.dueDate, 'date', ['/source/normalizedPlanPack/planningInputs/taxDue'], 'stated_due_date')] }];
  }));
  const shorter = [];
  for (const [index, debt] of (compatible ? household.liabilities : []).entries()) {
    if (debt.type !== 'mortgage' || !(euro(debt.currentBalance) > 0) || !(spare > 0) || !(debt.annualInterestRate > netCashRate)) continue;
    const path = r.householdPath + '/liabilities/' + index;
    if (!number(debt.remainingTermMonths) || !number(debt.monthlyPayment?.amount)) {
      unavailable.push({ id: 'mortgage_could_be_shorter', entityId: debt.liabilityId, reason: 'The mortgage term and payment are needed for its native schedule.' }); continue;
    }
    const input = { loanKind: 'mortgage', currentBalance: debt.currentBalance.amount, annualInterestRate: debt.annualInterestRate,
      remainingTermYears: debt.remainingTermMonths / 12, startDateIso: r.compiled.calculationDate, repaymentType: 'repayment',
      fixedPaymentAmount: debt.monthlyPayment.amount, oneOffOverpayment: 0 };
    try {
      const today = computeAmortizationMonthlySchedule(input);
      const cash = Math.min(spare, debt.currentBalance.amount);
      const changed = computeAmortizationMonthlySchedule({ ...input, oneOffOverpayment: cash });
      if (!today.payoffDateIso || !changed.payoffDateIso || changed.monthsSimulated >= today.monthsSimulated) continue;
      shorter.push({ id: debt.liabilityId, factKeys: [field('mortgage_could_be_shorter', debt.liabilityId, 'endDate', today.payoffDateIso, 'date', [path], 'native_amortisation_end'),
        field('mortgage_could_be_shorter', debt.liabilityId, 'endDateWithCash', changed.payoffDateIso, 'date', [path, 'position.spareCash'], 'native_amortisation_with_spare_cash'),
        field('mortgage_could_be_shorter', debt.liabilityId, 'cashApplied', cash, 'EUR', [path, 'position.spareCash'], 'spare_cash_up_to_outstanding_balance')] });
    } catch (error) { unavailable.push({ id: 'mortgage_could_be_shorter', entityId: debt.liabilityId, reason: error.message }); }
  }
  add('mortgage_could_be_shorter', shorter);
  return { issues, unavailable };
}
