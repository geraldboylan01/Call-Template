import { computeDatedCostFunding } from '../../future_cost_fund_math.js';
import { assertIsoDate, cloneJson } from '../utils.js';

const VERSION = 'dated-cost-1.0.0';
function requireValue(condition, path, message) {
  if (!condition) throw Object.assign(new Error(path + ': ' + message), { path, code: 'invalid_dated_cost' });
}
const stated = value => typeof value === 'string' && value.trim().length > 0;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The common dated-cost contract. Producers supply nominal bills and actual
 * tax-engine relief, never a relief percentage for this function to apply.
 * Both moneyNow and moneyEachYear are alternatives AFTER the same opening cash.
 * Payers use B1.1's stopsFromYear; null means an already-retired payer's share
 * continues, so there is no year in which all of this cost's funding stops.
 */
export function createDatedCost({ costId, goalId, title, producer, payerIds, payerRetirements,
  calculationDate, costKind, costByYear, cashToday = 0, funding = 'save_then_pay',
  savingStartsInYears = 0, provenance = {} }, options = {}) {
  assertIsoDate(calculationDate, '/datedCost/calculationDate');
  const calculationYear = Number(calculationDate.slice(0, 4));
  for (const [key, value] of Object.entries({ costId, goalId, title })) requireValue(stated(value), '/datedCost/' + key, 'must be a non-empty string.');
  requireValue(stated(producer?.module) && stated(producer?.version), '/datedCost/producer', 'name the module and version.');
  requireValue(Array.isArray(payerIds) && payerIds.length > 0 && payerIds.every(stated) && new Set(payerIds).size === payerIds.length,
    '/datedCost/payerIds', 'name each payer once.');
  requireValue(Array.isArray(payerRetirements) && payerRetirements.length === payerIds.length
    && new Set(payerRetirements.map(row => row.personId)).size === payerIds.length
    && payerRetirements.every(row => payerIds.includes(row.personId) && (row.stopsFromYear === null || Number.isInteger(row.stopsFromYear))),
  '/datedCost/payerRetirements', 'supply each payer’s B1.1 retirement boundary, or explicit null for a continuing share.');
  requireValue(Array.isArray(costByYear) && costByYear.length > 0, '/datedCost/costByYear', 'supply the yearly costs.');
  const costs = costByYear.map((row, index) => {
    const path = '/datedCost/costByYear/' + index;
    requireValue(Number.isInteger(row.year) && row.year >= calculationYear && (index === 0 || row.year === costByYear[index - 1].year + 1),
      path + '/year', 'must be a consecutive calendar year on or after the calculation year.');
    for (const key of ['amountBeforeRelief', 'reliefAmount', 'amountAfterRelief']) requireValue(amount(row[key]), path + '/' + key, 'must be a finite non-negative amount.');
    requireValue(Array.isArray(row.reliefClaims), path + '/reliefClaims', 'supply tax-engine claims, or an empty list.');
    for (const claim of row.reliefClaims) requireValue(payerIds.includes(claim.claimantId) && amount(claim.amount) && stated(claim.rulesVersion),
      path + '/reliefClaims', 'each claim needs a payer claimantId, amount and rulesVersion.');
    const claims = row.reliefClaims.reduce((sum, claim) => sum + claim.amount, 0);
    requireValue(Math.abs(claims - row.reliefAmount) < 1e-7 && row.reliefAmount <= row.amountBeforeRelief
      && Math.abs(row.amountBeforeRelief - row.reliefAmount - row.amountAfterRelief) < 1e-7,
    path, 'relief must reconcile once: before relief minus claimed relief equals after relief.');
    return cloneJson(row);
  });
  const engineOptions = { ...options, calculationYear };
  const priced = computeDatedCostFunding({ costKind, startsInYears: costs[0].year - calculationYear,
    costYears: costs.map(row => ({ yearIndex: row.year - calculationYear, cost: row.amountAfterRelief })),
    cashToday, funding, savingStartsInYears }, engineOptions);
  const moneyEachYear = priced.moneyEachYear.map(row => ({ year: calculationYear + row.yearIndex, amount: row.amount }));
  const splitYear = payerRetirements.every(row => row.stopsFromYear !== null)
    ? Math.max(calculationYear, ...payerRetirements.map(row => row.stopsFromYear)) : null;
  const before = moneyEachYear.filter(row => splitYear === null || row.year < splitYear);
  const after = moneyEachYear.filter(row => splitYear !== null && row.year >= splitYear);
  const capitalNeededAtRetirement = after.length ? computeDatedCostFunding({ costKind,
    startsInYears: after[0].year - splitYear, funding: 'lump_sum_now',
    costYears: after.map(row => ({ yearIndex: row.year - splitYear, cost: row.amount }))
  }, engineOptions).requiredToday : 0;
  return {
    contractVersion: VERSION, costId, goalId, title, producer: cloneJson(producer), payerIds: [...payerIds],
    costByYear: costs, moneyNow: priced.moneyNow, moneyEachYear,
    retirementSplit: { year: splitYear, before, after, capitalNeededAtRetirement },
    assumptions: priced.assumptions,
    provenance: { ...cloneJson(provenance), calculationDate, cashToday, funding, savingStartsInYears,
      payerRetirements: cloneJson(payerRetirements), requiredToday: priced.requiredToday }
  };
}
