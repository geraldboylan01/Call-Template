export const IRELAND_RULES_CATALOGUE_VERSION = 'ie-planning-rules-2026.01';

export const IRISH_STATE_PENSION_CONTRIBUTORY = Object.freeze({
  ruleId: 'ie.state_pension_contributory.maximum',
  jurisdiction: 'IE',
  effectiveFrom: '2026-01-01',
  weeklyMaximumEur: 299.30,
  annualMaximumEur: 15_563.60,
  defaultStartAge: 66,
  defaultEscalationRate: 0.02,
  source: Object.freeze({
    title: 'Department of Social Protection — State Pension (Contributory)',
    url: 'https://www.gov.ie/en/service/e6f908-state-pension-contributory/',
    ratesTitle: 'Department of Social Protection — Budget 2026',
    ratesUrl: 'https://www.gov.ie/en/department-of-social-protection/publications/budget-2026/'
  }),
  entitlementNotice: 'The maximum rate is a planning assumption, not a confirmed entitlement. The actual contributory rate depends on the person’s PRSI record.',
  grossAmountNotice: 'State Pension figures are gross and must not be described as net income unless a module explicitly applies a tax conversion.'
});

/**
 * Approved Retirement Fund minimum drawdown.
 *
 * These are dated Irish rules, so they belong beside the State Pension figures
 * in this catalogue rather than as constants inside a calculation engine.
 * Moving them changed no value: the rates and the high-value threshold are
 * exactly what `pension_math.js` applied before, and the pension projection is
 * pinned against unchanged output.
 */
export const IRISH_ARF_MINIMUM_DRAWDOWN = Object.freeze({
  ruleId: 'ie.arf.minimum_drawdown',
  jurisdiction: 'IE',
  effectiveFrom: '2026-01-01',
  /** Standard minimum drawdown before the higher-age band. */
  baseRate: 0.04,
  /** From this age the higher standard rate applies. */
  higherRateFromAge: 70,
  higherRate: 0.05,
  /** A fund above this value draws the high-value rate at any age. */
  highValueThresholdEur: 2_000_000,
  highValueRate: 0.06,
  source: Object.freeze({
    title: 'Revenue — Approved Retirement Funds (ARFs)',
    url: 'https://www.revenue.ie/en/jobs-and-pensions/pensions/approved-retirement-funds.aspx'
  }),
  grossAmountNotice: 'ARF withdrawals are gross and subject to income tax, USC and PRSI; they must not be described as net income unless a module explicitly applies a tax conversion.'
});

/**
 * The minimum a fund of this size must draw down at this age.
 *
 * The high-value band wins over the age band, which is the order the rules
 * apply in: a fund above the threshold draws the higher rate whatever the
 * holder's age.
 */
export function irishArfMinimumRate(age, openingBalance) {
  if (openingBalance > IRISH_ARF_MINIMUM_DRAWDOWN.highValueThresholdEur) {
    return IRISH_ARF_MINIMUM_DRAWDOWN.highValueRate;
  }
  return age >= IRISH_ARF_MINIMUM_DRAWDOWN.higherRateFromAge
    ? IRISH_ARF_MINIMUM_DRAWDOWN.higherRate
    : IRISH_ARF_MINIMUM_DRAWDOWN.baseRate;
}

export function normalizeStatePensionFraction(value, fallback = 1) {
  const candidate = Number(value);
  if (!Number.isFinite(candidate)) return fallback;
  return Math.min(1, Math.max(0, candidate));
}

export function statePensionAnnualAmount(fraction = 1) {
  return IRISH_STATE_PENSION_CONTRIBUTORY.annualMaximumEur
    * normalizeStatePensionFraction(fraction);
}

export function publicIrishStatePensionRule() {
  return Object.freeze({
    catalogueVersion: IRELAND_RULES_CATALOGUE_VERSION,
    ...IRISH_STATE_PENSION_CONTRIBUTORY,
    source: { ...IRISH_STATE_PENSION_CONTRIBUTORY.source }
  });
}
