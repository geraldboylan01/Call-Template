import { PLANEIR_ASSUMPTIONS } from './planning/planeir_assumptions.js';

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositiveNumber(value) {
  const parsed = toFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export const LIQUIDITY_RESERVE_POLICY = PLANEIR_ASSUMPTIONS.liquidity;

function normalizedClientStatus(value) {
  if (value && typeof value === 'object') {
    if (value.retired === true) return 'retired';
    return normalizedClientStatus(value.clientStatus ?? value.cohort);
  }
  const status = String(value || '').trim().toLowerCase();
  return ['retired', 'newly_retired', 'older_retiree'].includes(status)
    ? 'retired'
    : 'not-retired';
}

export function resolveLiquidityReservePolicy(value = 'not-retired') {
  return normalizedClientStatus(value) === 'retired'
    ? LIQUIDITY_RESERVE_POLICY.retired
    : LIQUIDITY_RESERVE_POLICY.working;
}

export function liquidityConversationGuidance() {
  const { working, retired, policyVersion, disclosure } = LIQUIDITY_RESERVE_POLICY;
  return Object.freeze([
    `Planéir’s cash-reserve guide for a working household is ${working.minimumBufferMonths}–${working.targetBufferMonths} months of spending: ${working.minimumBufferMonths} months is the minimum floor and ${working.targetBufferMonths} months is the target.`,
    `For a retired household, the guide is ${retired.minimumBufferMonths}–${retired.targetBufferMonths} months of spending (one to two years): ${retired.minimumBufferMonths} months is the minimum floor and ${retired.targetBufferMonths} months is the target.`,
    `Do not substitute a one-to-three-month emergency-fund range for either cohort. ${disclosure} Policy ${policyVersion}.`
  ]);
}

/**
 * Pure reserve calculation shared by the Liquidity renderer and planning
 * adapter. Cohort defaults come from the centrally approved Planéir policy.
 */
export function computeLiquidityReserve({
  currentCash = null,
  monthlyExpenditure = null,
  annualExpenditure = null,
  clientStatus = 'not-retired',
  minimumBufferMonths,
  targetBufferMonths
} = {}) {
  const policy = resolveLiquidityReservePolicy(clientStatus);
  const monthly = toPositiveNumber(monthlyExpenditure)
    ?? (() => {
      const annual = toPositiveNumber(annualExpenditure);
      return annual === null ? null : annual / 12;
    })();
  const minimumMonths = toPositiveNumber(minimumBufferMonths) ?? policy.minimumBufferMonths;
  const targetMonths = Math.max(
    toPositiveNumber(targetBufferMonths) ?? policy.targetBufferMonths,
    minimumMonths
  );
  const cash = toFiniteNumber(currentCash);
  const minimumCash = monthly === null ? null : monthly * minimumMonths;
  const targetCash = monthly === null ? null : monthly * targetMonths;
  const monthsCovered = cash !== null && monthly !== null
    ? cash / monthly
    : null;

  return {
    clientStatus: policy.clientStatus,
    policyVersion: LIQUIDITY_RESERVE_POLICY.policyVersion,
    currentCash: cash,
    monthlyExpenditure: monthly,
    annualExpenditure: monthly === null ? null : monthly * 12,
    minimumBufferMonths: minimumMonths,
    targetBufferMonths: targetMonths,
    minimumCash,
    targetCash,
    monthsCovered,
    surplusCash: cash !== null && targetCash !== null ? Math.max(0, cash - targetCash) : 0,
    shortfallCash: cash !== null && targetCash !== null ? Math.max(0, targetCash - cash) : 0
  };
}

/**
 * Backward-compatible working-household wrapper used by House Purchase.
 * Explicit scenario overrides remain supported, while the defaults now come
 * from the same policy object as Liquidity guidance and rendering.
 */
export function computeWorkingLiquidityReserve(input = {}) {
  return computeLiquidityReserve({ ...input, clientStatus: 'not-retired' });
}
