export const EUR_MICROS_PER_EURO = 1_000_000;
export const EUR_MICROS_PER_CENT = 10_000;
export const PROVIDER_COST_FAIL_CLOSED_LIMIT_EUR_MICROS = 0;

const BASIS_POINTS_SCALE = 10_000;
const UNITS_PER_MILLION = 1_000_000;
const LEDGER_STATUSES = new Set(['reserved', 'known', 'unknown', 'not_sent']);

export function isEurMicros(value, { allowZero = true } = {}) {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}

export function requireEurMicros(value, label = 'amountEurMicros', { allowZero = true } = {}) {
  if (!isEurMicros(value, { allowZero })) {
    const qualifier = allowZero ? 'a non-negative' : 'a positive';
    throw new TypeError(`${label} must be ${qualifier} safe integer in micro-euros.`);
  }
  return value;
}

export function failClosedEurMicros(value) {
  return isEurMicros(value)
    ? value
    : PROVIDER_COST_FAIL_CLOSED_LIMIT_EUR_MICROS;
}

function safeAdd(left, right, label) {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`${label} exceeds the safe integer range.`);
  }
  return total;
}

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function ledgerAmount(entry, camelName, snakeName, options) {
  return requireEurMicros(entry?.[camelName] ?? entry?.[snakeName], camelName, options);
}

export function chargedProviderCostEurMicros(entry) {
  const status = String(entry?.status || '');
  if (!LEDGER_STATUSES.has(status)) {
    throw new TypeError('Provider-cost ledger entry has an invalid status.');
  }
  if (status === 'not_sent') return 0;
  if (status === 'known') {
    return ledgerAmount(entry, 'actualCostEurMicros', 'actual_cost_eur_micros', { allowZero: true });
  }
  return ledgerAmount(entry, 'reservedCostEurMicros', 'reserved_cost_eur_micros', { allowZero: false });
}

export function summarizeProviderBudget(limitEurMicros, entries = []) {
  const limit = requireEurMicros(limitEurMicros, 'limitEurMicros');
  let spent = 0;
  let knownActual = 0;
  let reservedOrUnknown = 0;
  let released = 0;

  for (const entry of entries) {
    const status = String(entry?.status || '');
    const reservation = ledgerAmount(
      entry,
      'reservedCostEurMicros',
      'reserved_cost_eur_micros',
      { allowZero: false }
    );
    const charged = chargedProviderCostEurMicros(entry);
    spent = safeAdd(spent, charged, 'spentEurMicros');
    if (status === 'known') knownActual = safeAdd(knownActual, charged, 'knownActualEurMicros');
    if (status === 'reserved' || status === 'unknown') {
      reservedOrUnknown = safeAdd(reservedOrUnknown, reservation, 'reservedOrUnknownEurMicros');
    }
    if (status === 'not_sent') released = safeAdd(released, reservation, 'releasedEurMicros');
  }

  const remaining = Math.max(0, limit - spent);
  return Object.freeze({
    currency: 'EUR',
    unit: 'micro-euro',
    limitEurMicros: limit,
    spentEurMicros: spent,
    knownActualEurMicros: knownActual,
    reservedOrUnknownEurMicros: reservedOrUnknown,
    releasedEurMicros: released,
    remainingEurMicros: remaining,
    overLimitEurMicros: Math.max(0, spent - limit),
    exhausted: limit === 0 || spent >= limit,
    failClosed: limit === 0
  });
}

// Rates are expressed as integer micro-euros per one million provider units.
// This works for tokens, milliseconds, characters, or any other metered unit
// without embedding provider pricing in application code. The optional safety
// margin is applied in basis points and the final reservation is rounded up.
export function estimateProviderUsageCostEurMicros(components, { safetyMarginBps = 0 } = {}) {
  if (!Array.isArray(components) || components.length === 0) {
    throw new TypeError('components must be a non-empty array.');
  }
  if (!Number.isSafeInteger(safetyMarginBps) || safetyMarginBps < 0 || safetyMarginBps > 100_000) {
    throw new TypeError('safetyMarginBps must be an integer between 0 and 100000.');
  }

  let weightedUnits = 0n;
  for (const [index, component] of components.entries()) {
    const quantity = requireNonNegativeSafeInteger(
      component?.quantity,
      `components[${index}].quantity`
    );
    const rate = requireEurMicros(
      component?.rateEurMicrosPerMillionUnits,
      `components[${index}].rateEurMicrosPerMillionUnits`
    );
    weightedUnits += BigInt(quantity) * BigInt(rate);
  }

  const multiplier = BigInt(BASIS_POINTS_SCALE + safetyMarginBps);
  const divisor = BigInt(UNITS_PER_MILLION * BASIS_POINTS_SCALE);
  const roundedUp = (weightedUnits * multiplier + divisor - 1n) / divisor;
  if (roundedUp > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Estimated provider cost exceeds the safe integer range.');
  }
  return Number(roundedUp);
}
