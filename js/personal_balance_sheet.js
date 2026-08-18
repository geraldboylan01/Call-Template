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
 * COUNT EACH HOLDING ONCE. That is the entire promise of a balance sheet, and
 * it was the one thing this engine did not check.
 *
 * Everything else here was already guarded -- buckets must reconcile to gross
 * assets, amounts must be finite and non-negative -- but the same position
 * supplied twice was summed without complaint, so one 50,000 holding became
 * 100,000 of net worth and the reconciliation identity still balanced perfectly.
 * A wrong balance sheet that passes its own consistency check is exactly the
 * plausible-but-wrong figure this module has to be incapable of producing.
 *
 * Identity is the source collection PLUS the id, not the id alone: a cash
 * holding and a business interest may legitimately carry the same id while
 * being two entirely different things, and rejecting that would refuse a
 * correct balance sheet.
 */
function assertDistinctPositions(positions, kind) {
  const seen = new Set();
  for (const position of positions) {
    const identity = `${position.source}:${position.id}`;
    if (seen.has(identity)) {
      throw new Error(
        `Personal Balance Sheet ${kind} ${position.id} from ${position.source} was supplied more than once; `
        + 'each position must be counted exactly once.'
      );
    }
    seen.add(identity);
  }
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
  assertDistinctPositions(assets, 'asset');
  assertDistinctPositions(liabilities, 'liability');

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
