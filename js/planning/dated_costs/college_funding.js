import { computeCollegeFundingProjection } from '../../college_funding_math.js';
import { assertIsoDate } from '../utils.js';
import { createDatedCost } from './contract.js';

/** Use the college engine's actual nominal year rows, including one-off costs. */
export function produceCollegeCost({ input, scenarioId, childId, title, calculationDate, costId, goalId, payerIds, payerRetirements,
  cashToday = 0, funding = 'save_then_pay', savingStartsInYears = 0 }, options = {}) {
  assertIsoDate(calculationDate, '/datedCost/calculationDate');
  const currentYear = Number(calculationDate.slice(0, 4));
  if (input.currentYear !== undefined && input.currentYear !== currentYear) throw new Error('The college input currentYear must match calculationDate.');
  const nativeInput = { ...input, currentYear };
  const projection = computeCollegeFundingProjection(nativeInput);
  const scenario = projection.debug.scenarios.find(row => row.id === scenarioId);
  if (!scenario) throw new Error('Name the college scenario for this dated cost.');
  if (childId !== undefined && !scenario.childSeries.some(row => row.id === childId)) throw new Error('Name a child in the college projection.');
  return createDatedCost({ costId, goalId, title, producer: { module: 'college_funding', version: 'dated-cost-college-1.0.0' },
    payerIds, payerRetirements, calculationDate, costKind: 'education', cashToday, funding, savingStartsInYears,
    costByYear: scenario.yearRows.map(row => {
      const cost = childId === undefined ? row.annualFamilyCost : row.children.find(child => child.id === childId).cost;
      return { year: row.year, amountBeforeRelief: cost, reliefAmount: 0, amountAfterRelief: cost, reliefClaims: [] };
    }),
    provenance: { input: nativeInput, scenarioId, ...(childId === undefined ? {} : { childId }),
      costInflationRate: projection.debug.inputs.inflationRate, costBasis: 'native_college_funding_nominal_schedule' }
  }, options);
}
