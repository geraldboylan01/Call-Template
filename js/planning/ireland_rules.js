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
 * Approved Retirement Fund imputed distributions (s.790D TCA).
 *
 * The statute tests age "for the whole of the tax year": the charge applies
 * only where the holder is 60 or over for the whole year, and the 5% rate only
 * where they are 70 or over for the whole year. Someone who turns 61 during a
 * year was 60 on 1 January, so ages here are stored as the statute writes them
 * and the attained-age test adds one (Irish tax engine brief, 4.1 and 4.9).
 *
 * Before this correction the engine charged 4% from retirement at any age and
 * 5% from attained age 70. That was earlier than the law in both places.
 */
export const IRISH_ARF_MINIMUM_DRAWDOWN = Object.freeze({
  ruleId: 'ie.arf.imputed_distribution',
  jurisdiction: 'IE',
  effectiveFrom: '2026-01-01',
  /** The holder must be at least this age for the whole of the year. */
  minimumWholeYearAge: 60,
  baseRate: 0.04,
  /** From this age, held for the whole of the year, the higher rate applies. */
  higherRateWholeYearAge: 70,
  higherRate: 0.05,
  /** A fund above this value draws the high-value rate, once the age test is met. */
  highValueThresholdEur: 2_000_000,
  highValueRate: 0.06,
  /** Revenue values the fund on 30 November; the engine uses the opening balance. */
  valuationDate: '30 November',
  source: Object.freeze({
    title: 'Revenue Pensions Manual, Chapter 28 (imputed distributions)',
    url: 'https://www.revenue.ie/en/tax-professionals/tdm/pensions/chapter-28.pdf'
  }),
  grossAmountNotice: 'ARF withdrawals are gross and subject to income tax, USC and PRSI; they must not be described as net income unless a module explicitly applies a tax conversion.'
});

/** Whether someone of this attained age was at least `wholeYearAge` for all of the year. */
function agedForWholeYear(attainedAge, wholeYearAge) {
  return attainedAge - 1 >= wholeYearAge;
}

/**
 * The imputed distribution rate for a fund of this size at this attained age.
 *
 * The age test comes first: below it there is no imputed distribution, however
 * large the fund. Once it is met, the high-value band wins over the age band.
 */
export function irishArfMinimumRate(age, openingBalance) {
  const rule = IRISH_ARF_MINIMUM_DRAWDOWN;
  if (!agedForWholeYear(age, rule.minimumWholeYearAge)) {
    return 0;
  }
  if (openingBalance > rule.highValueThresholdEur) {
    return rule.highValueRate;
  }
  return agedForWholeYear(age, rule.higherRateWholeYearAge)
    ? rule.higherRate
    : rule.baseRate;
}

/** The first attained age at which an imputed distribution, or its higher rate, applies. */
export function irishArfFirstAttainedAge(band = 'base') {
  const rule = IRISH_ARF_MINIMUM_DRAWDOWN;
  return (band === 'higher' ? rule.higherRateWholeYearAge : rule.minimumWholeYearAge) + 1;
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
