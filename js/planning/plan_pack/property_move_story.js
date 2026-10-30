import { storyDisplay } from './story_display.js';

/** A report module for the actual transaction, including items the loan-based
 * home comparison does not show (outright purchase, duty, tax and sale year). */
export function propertyMoveRows(move, property) {
  const rows = [
    ['property', 'Property', property.label ?? (property.use === 'home' ? 'Your home' : 'Your rental property'), 'text'],
    ['year', 'Year', move.year, 'year'],
    ['loanRepaid', 'Loan repaid', move.debts.some(debt => debt.balance > 0)
      ? 'The sale repays ' + move.debts.filter(debt => debt.balance > 0).map(debt => `${debt.label}: ${storyDisplay(debt.balance, 'EUR')}`).join('; ') + '.'
      : 'There is no outstanding secured loan to repay from this sale.', 'text'],
    ['sellingCosts', 'Selling costs', move.sellingCosts, 'EUR'],
    ['tax', 'Tax', move.tax, 'EUR']
  ];
  if (move.type === 'tradeDownHome') rows.push(
    ['newHomePrice', 'New home price', move.newHomePrice, 'EUR'],
    ['cashReleased', 'Cash released', move.cashReleased, 'EUR'],
    ['buyingCosts', 'Buying costs', move.buyingCosts.total, 'EUR'],
    ['stampDuty', 'Stamp duty', move.buyingCosts.stampDuty, 'EUR']);
  else rows.push(
    ['netProceeds', 'Net proceeds', move.cashReleased, 'EUR'],
    ['rentStopped', 'Rent stopped', move.rental.rent, 'EUR/year'],
    ['runningCostsStopped', 'Running costs stopped', move.rental.running, 'EUR/year'],
    ['rentalTaxStopped', 'Rental tax stopped', move.rental.tax, 'EUR/year'],
    ['repaymentsStopped', 'Repayments stopped', move.debts.reduce((total, debt) => total + debt.annualPayment, 0), 'EUR/year']);
  return rows.map(([key, label, value, unit]) => ({ key, label, value, unit, display: storyDisplay(value, unit) }));
}

export function propertyMoveChapter(move, property) {
  const rows = propertyMoveRows(move, property);
  const title = move.type === 'tradeDownHome' ? 'Moving to a smaller home' : 'Selling your rental property';
  return { input: { move, property }, nativeCaseId: null, basis: 'compiled_property_transaction',
    metrics: Object.fromEntries(rows.map(row => [row.key, row.value])),
    payload: { title, generated: { report: { title, blocks: [{ id: 'transaction', type: 'table', title: 'The property move',
      table: { columns: ['Figure', 'Value', 'Period'], rows: rows.map(row => [row.label, row.display, row.unit === 'EUR/year' ? 'a year' : '']) } }] } } } };
}
