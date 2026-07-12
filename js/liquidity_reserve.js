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

/**
 * Pure reserve calculation shared by the Liquidity and House Purchase modules.
 * The working-household defaults preserve Planéir's existing three-month safety
 * floor and six-month target.
 */
export function computeWorkingLiquidityReserve({
  currentCash = null,
  monthlyExpenditure = null,
  annualExpenditure = null,
  minimumBufferMonths = 3,
  targetBufferMonths = 6
} = {}) {
  const monthly = toPositiveNumber(monthlyExpenditure)
    ?? (() => {
      const annual = toPositiveNumber(annualExpenditure);
      return annual === null ? null : annual / 12;
    })();
  const minimumMonths = toPositiveNumber(minimumBufferMonths) ?? 3;
  const targetMonths = Math.max(toPositiveNumber(targetBufferMonths) ?? 6, minimumMonths);
  const cash = toFiniteNumber(currentCash);
  const minimumCash = monthly === null ? null : monthly * minimumMonths;
  const targetCash = monthly === null ? null : monthly * targetMonths;
  const monthsCovered = cash !== null && monthly !== null
    ? cash / monthly
    : null;

  return {
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
