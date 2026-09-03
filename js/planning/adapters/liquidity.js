import {
  LIQUIDITY_RESERVE_POLICY,
  computeLiquidityReserve,
  resolveLiquidityReservePolicy
} from '../../liquidity_reserve.js';
import {
  annualExpenses,
  baseCurrency,
  cashAmount,
  confirmedNone,
  createModuleRunResult,
  crossCurrencyWarnings,
  findGoal,
  getAssumption,
  grossEmploymentIncome,
  missing,
  monthlyExpenses,
  readiness,
  readinessFromMissing
} from './common.js';

export const LIQUIDITY_ADAPTER_VERSION = '1.1.0';

const RETIRED_STATUSES = new Set(['newly_retired', 'retired', 'older_retiree']);
const WORKING_STATUSES = new Set(['working', 'approaching_retirement']);
const WORKING_EMPLOYMENT_CONTEXTS = new Set([
  'employed', 'employee', 'self_employed', 'contractor', 'company_director', 'owner_manager'
]);

/** One person's own position, from their employment record and their pay. */
function personCohort(profile, person) {
  if (!person) return null;
  const employmentStatus = String(person.employmentStatus || '').trim().toLowerCase();
  if (employmentStatus === 'retired') return 'retired';
  if (['employee', 'self_employed', 'contractor'].includes(employmentStatus)) return 'working';
  // Employment income is single-owner, so this is genuinely this person's pay
  // and not a household figure standing in for it.
  if (person.personId && grossEmploymentIncome(profile, person.personId) > 0) return 'working';
  return null;
}

/**
 * WHICH RESERVE GUIDE APPLIES TO THIS HOUSEHOLD.
 *
 * The buffer is larger in retirement because earned income has stopped. A
 * household where somebody is still earning has not stopped earning, so the
 * retired guide applies only when EVERY adult has retired -- which is what the
 * policy's own wording says: "a working household", "a retired household".
 *
 * This used to read `primaryPerson` alone, which is not a rule so much as an
 * accident of who was entered first: a retired client with a working partner
 * was told to hold twenty-four months of spending in cash rather than six --
 * four times the target on the same facts -- and entering the couple the other
 * way round produced the opposite answer.
 *
 * A stated household retirement status still wins where the client has given
 * one; it is a statement about the household, not about one person.
 */
export function resolveLiquidityCohort(profile) {
  const persona = profile?.assumptions?.values?.persona || {};
  const retirementStatus = String(persona.retirementStatus || '').trim().toLowerCase();
  if (RETIRED_STATUSES.has(retirementStatus)) return 'retired';
  if (WORKING_STATUSES.has(retirementStatus)) return 'working';

  const employmentContext = String(persona.employmentContext || '').trim().toLowerCase();
  if (employmentContext === 'retired') return 'retired';
  if (WORKING_EMPLOYMENT_CONTEXTS.has(employmentContext)) return 'working';

  const people = [profile?.primaryPerson, profile?.partner].filter(Boolean);
  const cohorts = people.map((person) => personCohort(profile, person));
  // One earner is enough to make this a working household, even where the
  // other's position was never established.
  if (cohorts.includes('working')) return 'working';
  if (cohorts.length > 0 && cohorts.every((cohort) => cohort === 'retired')) return 'retired';
  return null;
}

export function getLiquidityReadiness(profile) {
  const moduleIds = ['liquidity_analysis'];
  const requiredMissing = [];
  const cashAssets = profile.assets?.filter((asset) => asset.type === 'cash') || [];
  if (cashAssets.length === 0 || !cashAssets.some((asset) => asset.currentValue)) {
    requiredMissing.push(missing('/assets', 'Add the current cash available to the household.', moduleIds));
  }
  if (monthlyExpenses(profile) === null) {
    requiredMissing.push(missing('/expenses/annualTotal', 'Add annual or monthly household spending.', moduleIds));
  }
  const cohort = resolveLiquidityCohort(profile);
  if (!cohort) {
    requiredMissing.push(missing(
      '/assumptions/values/persona/retirementStatus',
      'Confirm whether the household is working or retired so the correct cash-reserve guide is used.',
      moduleIds
    ));
  }
  const policy = cohort ? resolveLiquidityReservePolicy(cohort) : null;
  const assumptionsUsed = [];
  if (policy && getAssumption(profile, 'liquidity.minimumBufferMonths') === undefined) {
    assumptionsUsed.push({
      key: 'minimumBufferMonths',
      value: policy.minimumBufferMonths,
      reason: `${policy.basis} (${LIQUIDITY_RESERVE_POLICY.policyVersion}).`
    });
  }
  if (policy && getAssumption(profile, 'liquidity.targetBufferMonths') === undefined) {
    assumptionsUsed.push({
      key: 'targetBufferMonths',
      value: policy.targetBufferMonths,
      reason: policy.basis
    });
  }
  const warnings = crossCurrencyWarnings(profile, [
    ['Cash assets', cashAssets.map((asset) => asset.currentValue)],
    ['Expenses', Object.values(profile.expenses || {})]
  ]);
  const relevant = Boolean(findGoal(profile, ['maintain_liquidity', 'understand_position', 'buy_home']))
    || cashAssets.length > 0;
  if (['/expenses', '/expenses/annualTotal', '/expenses/monthlyEssential'].some((path) => confirmedNone(profile, path))
    && monthlyExpenses(profile) === null) {
    return readiness({
      status: 'adviser_review_required',
      assumptionsUsed,
      warnings: [
        ...warnings,
        'The liquidity illustration cannot calculate a reserve without positive household spending. Add spending later or discuss the position with an adviser.'
      ]
    });
  }
  return readinessFromMissing(requiredMissing, { assumptionsUsed, warnings, relevant });
}

export function buildLiquidityInput(profile) {
  const cohort = resolveLiquidityCohort(profile);
  const clientStatus = cohort === 'retired' ? 'retired' : 'not-retired';
  const policy = resolveLiquidityReservePolicy(clientStatus);
  return {
    currentCash: cashAmount(profile),
    monthlyExpenditure: monthlyExpenses(profile),
    annualExpenditure: annualExpenses(profile),
    clientStatus,
    policyVersion: LIQUIDITY_RESERVE_POLICY.policyVersion,
    minimumBufferMonths: getAssumption(
      profile,
      'liquidity.minimumBufferMonths',
      policy.minimumBufferMonths
    ),
    targetBufferMonths: getAssumption(
      profile,
      'liquidity.targetBufferMonths',
      policy.targetBufferMonths
    )
  };
}

/**
 * The module's own input contract.
 *
 * The engine is deliberately forgiving -- it coerces anything unusable to
 * `null` and falls back to policy -- which is right for a renderer handling a
 * half-filled form, and wrong as the last word before a client is given a
 * number. A buffer override of `-3` or `0` silently became the policy default,
 * so an adviser could type one figure and the illustration use another without
 * anyone being told.
 */
export function validateLiquidityInput(input) {
  if (!['retired', 'not-retired'].includes(input?.clientStatus)) {
    throw new Error('liquidity input clientStatus must be "retired" or "not-retired".');
  }
  const finiteOrNull = (value, field) => {
    if (value === null || typeof value === 'undefined') return;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`liquidity input ${field} must be a finite number when present.`);
    }
    if (value < 0) throw new Error(`liquidity input ${field} must not be negative.`);
  };
  finiteOrNull(input?.currentCash, 'currentCash');
  finiteOrNull(input?.monthlyExpenditure, 'monthlyExpenditure');
  finiteOrNull(input?.annualExpenditure, 'annualExpenditure');
  if (Number.isFinite(input?.monthlyExpenditure) && Number.isFinite(input?.annualExpenditure)
    && Math.abs((input.monthlyExpenditure * 12) - input.annualExpenditure) > 0.01) {
    throw new Error('liquidity input monthlyExpenditure and annualExpenditure must describe the same spending.');
  }
  for (const field of ['minimumBufferMonths', 'targetBufferMonths']) {
    const value = input?.[field];
    if (value === null || typeof value === 'undefined') continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`liquidity input ${field} must be a positive number of months when present.`);
    }
  }
}

/**
 * Canonical cash-reserve input. The engine owns the annual/monthly equivalence
 * and dated buffer policy; no conversational meaning is inferred here.
 */
export function normalizeLiquidityInput(input) {
  validateLiquidityInput(input);
  const reserve = computeLiquidityReserve(input);
  if (reserve.currentCash === null || reserve.monthlyExpenditure === null) {
    throw new Error('liquidity input requires currentCash and positive monthly or annual expenditure.');
  }
  return {
    currentCash: reserve.currentCash,
    monthlyExpenditure: reserve.monthlyExpenditure,
    annualExpenditure: reserve.annualExpenditure,
    clientStatus: reserve.clientStatus,
    policyVersion: LIQUIDITY_RESERVE_POLICY.policyVersion,
    minimumBufferMonths: reserve.minimumBufferMonths,
    targetBufferMonths: reserve.targetBufferMonths
  };
}

export async function runLiquidityAnalysis(input, context) {
  const reserve = computeLiquidityReserve(input);
  const currency = context.baseCurrency || 'EUR';
  const projection = {
    assumptionsTable: {
      columns: ['Assumption', 'Value'],
      rows: [
        ['Minimum buffer', `${reserve.minimumBufferMonths} months`],
        ['Target buffer', `${reserve.targetBufferMonths} months`],
        ['Monthly spending', reserve.monthlyExpenditure]
      ]
    },
    outputsTable: {
      columns: ['Metric', 'Value'],
      rows: [
        ['Current cash', reserve.currentCash],
        ['Months covered', reserve.monthsCovered],
        ['Target cash', reserve.targetCash],
        ['Surplus to target', reserve.surplusCash],
        ['Shortfall to target', reserve.shortfallCash]
      ]
    },
    tables: [],
    charts: reserve.currentCash === null || reserve.targetCash === null ? [] : [{
      id: 'liquidity-reserve-position',
      title: 'Cash reserve position',
      type: 'bar',
      labels: ['Current cash', 'Minimum reserve', 'Target reserve'],
      datasets: [{ label: currency, data: [reserve.currentCash, reserve.minimumCash, reserve.targetCash] }]
    }]
  };
  return createModuleRunResult({
    moduleId: 'liquidity_analysis',
    moduleVersion: context.moduleVersion,
    input,
    context,
    projection,
    semanticResult: {
      currency,
      clientStatus: reserve.clientStatus,
      policyVersion: reserve.policyVersion,
      currentCash: reserve.currentCash,
      monthlyExpenditure: reserve.monthlyExpenditure,
      monthsCovered: reserve.monthsCovered,
      minimumCash: reserve.minimumCash,
      targetCash: reserve.targetCash,
      surplusCash: reserve.surplusCash,
      shortfallCash: reserve.shortfallCash,
      // The engine's own verdict, including when it cannot reach one. Deriving
      // this from a falsy shortfall is what turned "we never established your
      // spending" into "your reserve is at or above target".
      position: reserve.position
    }
  });
}
