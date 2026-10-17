/**
 * Centrally controlled Planeir planning assumptions.
 *
 * These were previously inline constants scattered across adapters, each
 * carrying a "review before consumer activation" note. Consumers now see
 * projections built on them, so they are defined once, versioned, and given the
 * plain-language basis that has to be said out loud alongside any figure.
 *
 * Current policy: Planeir controls these centrally. Consumers cannot edit them
 * and advisers cannot override them. `resolvePlanningAssumptions` takes an
 * overrides argument it deliberately ignores today — that is the seam for
 * controlled adviser configuration later, so enabling it will not mean
 * rebuilding the calculation engines.
 */

export const PLANEIR_ASSUMPTIONS_VERSION = 'planeir-assumptions-1.3.0';
export const PLANEIR_ASSUMPTIONS_APPROVED_ON = '2026-10-13';

export const PLANEIR_ASSUMPTIONS = Object.freeze({
  version: PLANEIR_ASSUMPTIONS_VERSION,
  approvedOn: PLANEIR_ASSUMPTIONS_APPROVED_ON,

  investment: Object.freeze({
    /** Nominal, before inflation. */
    nominalGrowthRate: 0.05,
    basis: 'A 5% nominal growth assumption is intended to represent a medium-risk diversified portfolio held over the long term.',
    disclosure: 'This is a planning assumption, not a guaranteed return. Actual investment returns vary and can be negative.'
  }),

  inflation: Object.freeze({
    /** General consumer prices. */
    generalRate: 0.02,
    generalBasis: 'A 2% general inflation assumption is used to express future amounts in today’s money.',
    /** Education costs, deliberately higher than general inflation. */
    educationRate: 0.04,
    educationBasis: 'Education and healthcare costs have tended to rise faster than general consumer prices, so a higher long-term inflation assumption of 4% a year is used for education planning.'
  }),

  cash: Object.freeze({
    /** Gross, before DIRT. DIRT itself lives in the tax catalogue, not here. */
    instantAccessGrossRate: 0.002,
    basis: 'A 0.2% interest rate is used for money held in instant-access cash. It is the rounded average of the standard instant-access rates two large Irish retail banks quoted in October 2026, before DIRT.',
    disclosure: 'This is a planning assumption, not a quoted rate. Banks can change instant-access rates at any time, and regular-saver and notice accounts pay more.',
    /**
     * The two rates the figure was averaged from, for the audit trail only.
     * Nothing here reaches a client-facing string, which is why `basis` does
     * not name the banks.
     */
    observed: Object.freeze([
      Object.freeze({
        provider: 'Bank of Ireland',
        product: 'Instant Access Demand / Demand Deposit',
        quotedRate: 0.001,
        quotedAs: 'AER, variable, gross of DIRT',
        effective: '2026-09-14',
        url: 'https://personalbanking.bankofireland.com/save-and-invest/savings/bank-of-ireland-deposit-rates/'
      }),
      Object.freeze({
        provider: 'AIB',
        product: 'Personal Demand Deposit Account',
        quotedRate: 0.0025,
        quotedAs: 'AER and gross annual interest rate',
        effective: '2025-05-13',
        url: 'https://aib.ie/our-products/savings-and-deposits/Deposit-Rates'
      })
    ]),
    checkedOn: '2026-10-13'
  }),

  collegeFunding: Object.freeze({
    startAge: 18,
    durationYears: 4,
    scenarios: Object.freeze([
      Object.freeze({
        id: 'living_at_home',
        title: 'Living at home',
        category: 'living_at_home',
        annualCostTodayPerChild: 5_000,
        tone: 'base'
      }),
      Object.freeze({
        id: 'living_away',
        title: 'Living away from home',
        category: 'living_away',
        annualCostTodayPerChild: 15_000,
        tone: 'warning'
      })
    ]),
    disclosure: 'These are standard planning estimates in today’s money, not guaranteed future costs. Actual costs vary by course, institution and circumstances.'
  }),

  liquidity: Object.freeze({
    policyVersion: 'planeir-liquidity-reserve-1.0.0',
    working: Object.freeze({
      clientStatus: 'not-retired',
      minimumBufferMonths: 3,
      targetBufferMonths: 6,
      basis: 'For a working household, Planeir uses three months of spending as the minimum cash-reserve floor and six months as the target.'
    }),
    retired: Object.freeze({
      clientStatus: 'retired',
      minimumBufferMonths: 12,
      targetBufferMonths: 24,
      basis: 'For a retired household, Planeir uses twelve months of spending as the minimum cash-reserve floor and twenty-four months as the target.'
    }),
    disclosure: 'These are Planeir planning guides for resilience, not a personal recommendation or a guarantee that a particular reserve will meet every emergency.'
  }),

  /**
   * How tax rules are carried into years that have no rules yet. The rules
   * themselves are law and live in the tax catalogue
   * (`js/planning/tax/rules_ie.js`); this is Planeir's policy for the years
   * ahead, and `resolveTaxRules` is its only implementation.
   */
  taxProjection: Object.freeze({
    policy: 'freeze_budget_parameters_apply_fixed_law_hold_unknowns',
    basis: 'Tax bands, credits and thresholds that each Budget sets are kept at their latest enacted values in euro terms and never increased with inflation, because Budgets often leave them unchanged. Changes the law has already fixed by date and amount, such as the scheduled PRSI rises and the Standard Fund Threshold steps, are applied on their dates. Where the law ties a future figure to data that does not exist yet, such as the Standard Fund Threshold from 2030, the last known figure is held rather than forecast.',
    disclosure: 'If future Budgets raise bands and credits, tax in later years would be lower than shown. A held Standard Fund Threshold is its lowest possible level, so any tax shown on a fund above it may be overstated.'
  })
});

/**
 * Resolve the assumptions in force for a plan.
 *
 * @param {object} [options]
 * @param {object|null} [options.adviserOverrides] Reserved. Central control
 *   means overrides are ignored today; the parameter exists so adviser
 *   configuration can be enabled later without touching the engines.
 */
export function resolvePlanningAssumptions({ adviserOverrides = null } = {}) {
  void adviserOverrides;
  return PLANEIR_ASSUMPTIONS;
}

/** The college scenarios in the shape the college engine consumes. */
export function approvedCollegeScenarios() {
  return PLANEIR_ASSUMPTIONS.collegeFunding.scenarios.map((scenario) => ({ ...scenario }));
}

/**
 * Assumption records for a module's `assumptionsUsed`, so every figure a client
 * sees can name the assumption behind it and its version.
 */
export function assumptionRecord(key) {
  const { investment, inflation, collegeFunding, cash, version } = PLANEIR_ASSUMPTIONS;
  const records = {
    cashRate: {
      key: 'cashGrowthRate',
      value: cash.instantAccessGrossRate,
      reason: `${cash.basis} ${cash.disclosure} (${version})`
    },
    investmentGrowth: {
      key: 'investmentGrowthRate',
      value: investment.nominalGrowthRate,
      reason: `${investment.basis} ${investment.disclosure} (${version})`
    },
    generalInflation: {
      key: 'inflationRate',
      value: inflation.generalRate,
      reason: `${inflation.generalBasis} (${version})`
    },
    educationInflation: {
      key: 'educationInflationRate',
      value: inflation.educationRate,
      reason: `${inflation.educationBasis} (${version})`
    },
    collegeStartAge: {
      key: 'collegeStartAge',
      value: collegeFunding.startAge,
      reason: `Standard assumed college start age (${version}).`
    },
    collegeDuration: {
      key: 'collegeDurationYears',
      value: collegeFunding.durationYears,
      reason: `Four years of college for each child (${version}).`
    },
    taxProjection: {
      key: 'taxProjectionPolicy',
      value: PLANEIR_ASSUMPTIONS.taxProjection.policy,
      reason: `${PLANEIR_ASSUMPTIONS.taxProjection.basis} ${PLANEIR_ASSUMPTIONS.taxProjection.disclosure} (${version})`
    },
    collegeCosts: {
      key: 'collegeAnnualCostsToday',
      value: collegeFunding.scenarios.map((scenario) => (
        `${scenario.title}: €${scenario.annualCostTodayPerChild.toLocaleString('en-IE')} a year per child`
      )).join('; '),
      reason: `${collegeFunding.disclosure} (${version})`
    }
  };
  return records[key] ? Object.freeze({ ...records[key] }) : null;
}

/**
 * Plain names for the engine assumption keys that appear in `assumptionsUsed`.
 *
 * These keys are ENGINE keys, not semantic fact ids: `collegeStartAge`, not
 * `college_start_age`. Passing them through the semantic fact registry returns
 * nothing, so a consumer projection that tried it rendered every optional input
 * as `null` and then filtered it away — which is why the live lane was never
 * told which inputs it could skip, and asked for them.
 *
 * Every key any adapter can push into `assumptionsUsed` must be listed here.
 * An unlisted key returns '' so a caller can fail closed rather than leak a
 * camelCase identifier into something a client hears.
 */
const ASSUMPTION_LABELS = Object.freeze({
  // Centrally approved Planeir assumptions (assumptionRecord above).
  investmentGrowthRate: 'Long-run investment growth rate',
  inflationRate: 'General inflation rate',
  educationInflationRate: 'Education cost inflation rate',
  cashGrowthRate: 'Interest on money held in cash',
  collegeStartAge: 'College starting age',
  collegeDurationYears: 'Number of years of college',
  collegeAnnualCostsToday: 'Standard college costs in today’s money',
  taxProjectionPolicy: 'How tax rules are carried into future years',
  // Adapter-owned engine defaults.
  purchaseCosts: 'Home-buying cost estimates',
  mortgageIllustration: 'Illustrative mortgage rate and term',
  targetPurchaseDate: 'Target purchase date',
  minimumBufferMonths: 'Minimum cash-reserve months',
  targetBufferMonths: 'Target cash-reserve months',
  repaymentType: 'Repayment type',
  presentValueRate: 'Present-value discount rate',
  statePensionContributory: 'State Pension (Contributory) maximum rate'
});

/** The plain name for an engine assumption key, or '' when it is unknown. */
export function assumptionLabel(key) {
  return typeof key === 'string' ? ASSUMPTION_LABELS[key] || '' : '';
}

/** Every assumption key that has an approved consumer-safe label. */
export function listAssumptionLabelKeys() {
  return Object.keys(ASSUMPTION_LABELS);
}
