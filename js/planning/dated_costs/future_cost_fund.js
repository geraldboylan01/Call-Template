import { computeDatedCostFunding } from '../../future_cost_fund_math.js';
import { assertIsoDate } from '../utils.js';
import { createDatedCost } from './contract.js';

/** One ordinary dated cost, using the future-cost engine's existing inflation. */
export function produceFutureCostFundCost({ input, calculationDate, costId, goalId, payerIds, payerRetirements,
  cashToday = 0, funding = input.startsInYears === 0 ? 'each_year' : 'save_then_pay', savingStartsInYears = 0 }, options = {}) {
  assertIsoDate(calculationDate, '/datedCost/calculationDate');
  const priced = computeDatedCostFunding({ costKind: input.costKind, startsInYears: input.startsInYears,
    annualCostToday: input.annualCostToday, durationYears: input.durationYears, cashToday, funding, savingStartsInYears
  }, { ...options, calculationYear: Number(calculationDate.slice(0, 4)) });
  const contract = createDatedCost({ costId, goalId, title: input.costTitle, producer: { module: 'future_cost_fund', version: 'dated-cost-future-fund-1.0.0' },
    payerIds, payerRetirements, calculationDate, costKind: input.costKind, cashToday, funding, savingStartsInYears,
    costByYear: priced.costYears.map(row => ({ year: priced.assumptions.calculationYear + row.yearIndex,
      amountBeforeRelief: row.cost, reliefAmount: 0, amountAfterRelief: row.cost, reliefClaims: [] })),
    provenance: { input: { ...input }, costBasis: 'native_future_cost_fund_nominal_schedule' }
  }, options);
  return { ...contract, assumptions: { ...contract.assumptions,
    priceGrowthRate: priced.assumptions.priceGrowthRate, priceGrowthSource: priced.assumptions.priceGrowthSource } };
}
