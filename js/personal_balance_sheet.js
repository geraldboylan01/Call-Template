const BUCKET_ORDER = Object.freeze([
  'lifestyle_assets',
  'spendable_reserves',
  'retirement_funding',
  'concentrated_assets'
]);

function finiteNonNegative(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${fieldName} must be a finite non-negative number.`);
  }
  return number;
}

function normalizePosition(position, index, kind) {
  if (!position || typeof position !== 'object' || Array.isArray(position)) {
    throw new Error(`${kind}[${index}] must be an object.`);
  }
  return Object.freeze({
    id: String(position.id || `${kind}-${index + 1}`),
    label: String(position.label || `${kind} ${index + 1}`),
    bucket: kind === 'liabilities' ? 'liabilities' : String(position.bucket || ''),
    amount: finiteNonNegative(position.amount, `${kind}[${index}].amount`),
    source: String(position.source || 'canonical_profile')
  });
}

function rounded(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Pure, code-owned Personal Balance Sheet engine.
 *
 * The adapter is responsible for currency filtering and reconciliation. This
 * function only accepts reconciled positions, totals them once, and checks the
 * accounting identity before returning an immutable semantic result.
 */
export function computePersonalBalanceSheet({
  assetPositions = [],
  liabilityPositions = [],
  monthlyExpenditure = null
} = {}) {
  if (!Array.isArray(assetPositions) || !Array.isArray(liabilityPositions)) {
    throw new Error('Personal Balance Sheet positions must be arrays.');
  }
  const assets = assetPositions.map((position, index) => normalizePosition(position, index, 'assets'));
  const liabilities = liabilityPositions.map((position, index) => normalizePosition(position, index, 'liabilities'));
  for (const position of assets) {
    if (!BUCKET_ORDER.includes(position.bucket)) {
      throw new Error(`Unsupported Personal Balance Sheet bucket: ${position.bucket}`);
    }
  }

  const buckets = Object.fromEntries(BUCKET_ORDER.map((bucket) => [bucket, {
    total: rounded(assets.filter((position) => position.bucket === bucket).reduce((sum, position) => sum + position.amount, 0)),
    positions: assets.filter((position) => position.bucket === bucket)
  }]));
  const grossAssets = rounded(assets.reduce((sum, position) => sum + position.amount, 0));
  const totalLiabilities = rounded(liabilities.reduce((sum, position) => sum + position.amount, 0));
  const netWorth = rounded(grossAssets - totalLiabilities);
  const monthly = monthlyExpenditure === null || typeof monthlyExpenditure === 'undefined'
    ? null
    : finiteNonNegative(monthlyExpenditure, 'monthlyExpenditure');
  const spendableReserves = buckets.spendable_reserves.total;
  const reserveMonths = monthly && monthly > 0 ? rounded(spendableReserves / monthly) : null;
  const bucketTotal = rounded(BUCKET_ORDER.reduce((sum, bucket) => sum + buckets[bucket].total, 0));
  if (bucketTotal !== grossAssets) {
    throw new Error('Personal Balance Sheet reconciliation failed: asset buckets do not equal gross assets.');
  }

  return Object.freeze({
    buckets: Object.freeze(buckets),
    liabilities: Object.freeze(liabilities),
    grossAssets,
    totalLiabilities,
    netWorth,
    spendableReserves,
    monthlyExpenditure: monthly,
    reserveMonths,
    reconciliationDifference: rounded(grossAssets - totalLiabilities - netWorth)
  });
}

export const PERSONAL_BALANCE_SHEET_BUCKETS = BUCKET_ORDER;
