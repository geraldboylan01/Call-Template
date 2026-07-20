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
