/**
 * Centrally controlled Planéir planning assumptions.
 *
 * These were previously inline constants scattered across adapters, each
 * carrying a "review before consumer activation" note. Consumers now see
 * projections built on them, so they are defined once, versioned, and given the
 * plain-language basis that has to be said out loud alongside any figure.
 *
 * Current policy: Planéir controls these centrally. Consumers cannot edit them
 * and advisers cannot override them. `resolvePlanningAssumptions` takes an
 * overrides argument it deliberately ignores today — that is the seam for
 * controlled adviser configuration later, so enabling it will not mean
 * rebuilding the calculation engines.
 */

export const PLANEIR_ASSUMPTIONS_VERSION = 'planeir-assumptions-1.1.0';
export const PLANEIR_ASSUMPTIONS_APPROVED_ON = '2026-07-30';

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
      basis: 'For a working household, Planéir uses three months of spending as the minimum cash-reserve floor and six months as the target.'
    }),
    retired: Object.freeze({
      clientStatus: 'retired',
      minimumBufferMonths: 12,
      targetBufferMonths: 24,
      basis: 'For a retired household, Planéir uses twelve months of spending as the minimum cash-reserve floor and twenty-four months as the target.'
    }),
    disclosure: 'These are Planéir planning guides for resilience, not a personal recommendation or a guarantee that a particular reserve will meet every emergency.'
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
  const { investment, inflation, collegeFunding, version } = PLANEIR_ASSUMPTIONS;
  const records = {
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
  // Centrally approved Planéir assumptions (assumptionRecord above).
  investmentGrowthRate: 'Long-run investment growth rate',
  inflationRate: 'General inflation rate',
  educationInflationRate: 'Education cost inflation rate',
  collegeStartAge: 'College starting age',
  collegeDurationYears: 'Number of years of college',
  collegeAnnualCostsToday: 'Standard college costs in today’s money',
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
