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

import { IRISH_STATE_PENSION_CONTRIBUTORY } from './ireland_rules.js';

export const PLANEIR_ASSUMPTIONS_VERSION = 'planeir-assumptions-1.0.0';
export const PLANEIR_ASSUMPTIONS_APPROVED_ON = '2026-07-26';

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

  /**
   * Provisional values for facts a client may genuinely not be able to supply.
   *
   * WHY THESE ARE HERE AND NOT IN THE CONVERSATION. A client who cannot name a
   * retirement age is not a client who should leave with nothing — but the model
   * must never invent the number that fills the gap. These are centrally
   * approved, versioned and dated exactly like every other assumption, so the
   * agent selects from this list and cannot originate a value. Each one appears
   * on screen as an assumption rather than as something the client said.
   *
   * ADDING AN ENTRY IS AN ADVISER DECISION, NOT AN ENGINEERING ONE.
   */
  provisionalFacts: Object.freeze({
    intended_retirement_age: Object.freeze({
      value: IRISH_STATE_PENSION_CONTRIBUTORY.defaultStartAge,
      label: 'Retirement age',
      basis: `Aligned with the State Pension (Contributory) default start age of ${IRISH_STATE_PENSION_CONTRIBUTORY.defaultStartAge}, so a provisional plan lines up with when that income is assumed to begin.`,
      disclosure: 'This is a placeholder so the projection can run, not a decision. Change it whenever a real age is chosen.'
    })
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
 * The approved provisional value for a fact, or null if there is not one.
 *
 * Returning null is the answer that matters: it is what stops the agent
 * offering an assumption for a fact nobody has approved one for, which would be
 * inventing a figure with extra steps.
 */
export function provisionalFactAssumption(factId) {
  const entry = PLANEIR_ASSUMPTIONS.provisionalFacts[String(factId || '')];
  return entry ? Object.freeze({ ...entry, factId, version: PLANEIR_ASSUMPTIONS.version }) : null;
}

/** Facts an approved provisional value exists for. */
export function provisionalFactIds() {
  return Object.keys(PLANEIR_ASSUMPTIONS.provisionalFacts);
}

/** The `assumptionsUsed` record for a provisional fact, so it shows on screen as an assumption. */
export function provisionalFactRecord(factId) {
  const entry = provisionalFactAssumption(factId);
  if (!entry) return null;
  return Object.freeze({
    key: factId,
    value: entry.value,
    reason: `${entry.basis} ${entry.disclosure} (${entry.version})`
  });
}
