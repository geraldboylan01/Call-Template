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

import { marketFigure, marketFigureValue } from './figures/market_math.js';

export const PLANEIR_ASSUMPTIONS_VERSION = 'planeir-assumptions-1.6.0';
export const PLANEIR_ASSUMPTIONS_APPROVED_ON = '2026-10-21';

const CASH_RATE_FIGURE_ID = 'ie.market.cash.instant_access_gross_rate';

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
    /**
     * Education and care costs, deliberately higher than general inflation. One
     * value for both, so they always move together: the care module reads it
     * as `careFeeGrowthRate` (see `assumptionRecord`) and adds no rate of its own.
     */
    educationRate: 0.04,
    educationBasis: 'Education and healthcare costs have tended to rise faster than general consumer prices, so a higher long-term inflation assumption of 4% a year is used for education and care planning.'
  }),

  /**
   * The growth rate the net retirement cash-flow module uses. It is after tax
   * and held on its own: it is not worked out from the 5% investment growth
   * assumption. It was an unnamed default inside the engine and the adapter,
   * with the note "existing net retirement engine default", until it was given
   * a name and a basis here.
   */
  netRetirement: Object.freeze({
    /** The rate, and the basis and disclosure below, were approved on this day. */
    approvedOn: '2026-10-27',
    presentValueRate: 0.04,
    basis: 'A 4% a year after-tax growth rate is used to work out the fund needed today to pay for each year of retirement spending that other income does not cover.',
    disclosure: 'This is a planning assumption, not a guaranteed return. It is held separately from the long-term growth assumption used for pension pots.'
  }),

  cash: Object.freeze({
    /**
     * Gross, before DIRT. DIRT itself lives in the tax catalogue, not here. The
     * rate is a market figure worked out from the quotes in the figures
     * register (`figures/market_ie.js`), which keeps them as the audit trail.
     * Nothing from there reaches a client-facing string, which is why `basis`
     * does not name the banks.
     */
    instantAccessGrossRate: marketFigureValue(CASH_RATE_FIGURE_ID),
    basis: 'A 0.2% interest rate is used for money held in instant-access cash. It is the rounded average of the standard instant-access rates two large Irish retail banks quoted in October 2026, before DIRT.',
    disclosure: 'This is a planning assumption, not a quoted rate. Banks can change instant-access rates at any time, and regular-saver and notice accounts pay more.',
    figureId: CASH_RATE_FIGURE_ID,
    checkedOn: marketFigure(CASH_RATE_FIGURE_ID).checkedOn
  }),

  /**
   * Care costs (the Fair Deal module). The Fair Deal rules themselves are law
   * and live in their own dated catalogue; these are Planeir's planning figures.
   * The fee growth rate is not here: it is `inflation.educationRate`.
   */
  care: Object.freeze({
    agreedPrices: Object.freeze({
      /** The HSE list of maximum agreed prices with private and voluntary homes. */
      listNumber: 230,
      listDate: '2026-09-04',
      homesInList: 411,
      /** A week, in euro. */
      nationalWeeklyAverage: 1312,
      lowestWeekly: 1192,
      highestWeekly: 1508,
      /**
       * A simple average of each home's price in the county, our own calculation
       * from the list on 2026-10-21, not weighted by beds. The list gives none.
       * A county with two or three homes moves a lot with one home's price.
       */
      countyWeeklyAverages: Object.freeze({
        Carlow: Object.freeze({ homes: 5, average: 1256, lowest: 1220, highest: 1277 }),
        Cavan: Object.freeze({ homes: 7, average: 1291, lowest: 1228, highest: 1329 }),
        Clare: Object.freeze({ homes: 12, average: 1260, lowest: 1224, highest: 1304 }),
        Cork: Object.freeze({ homes: 47, average: 1307, lowest: 1232, highest: 1492 }),
        Donegal: Object.freeze({ homes: 13, average: 1259, lowest: 1234, highest: 1279 }),
        Dublin: Object.freeze({ homes: 86, average: 1414, lowest: 1342, highest: 1508 }),
        Galway: Object.freeze({ homes: 31, average: 1269, lowest: 1210, highest: 1319 }),
        Kerry: Object.freeze({ homes: 15, average: 1262, lowest: 1200, highest: 1310 }),
        Kildare: Object.freeze({ homes: 20, average: 1341, lowest: 1275, highest: 1388 }),
        Kilkenny: Object.freeze({ homes: 10, average: 1274, lowest: 1245, highest: 1285 }),
        Laois: Object.freeze({ homes: 3, average: 1284, lowest: 1270, highest: 1304 }),
        Leitrim: Object.freeze({ homes: 2, average: 1276, lowest: 1274, highest: 1277 }),
        Limerick: Object.freeze({ homes: 21, average: 1263, lowest: 1230, highest: 1292 }),
        Longford: Object.freeze({ homes: 3, average: 1276, lowest: 1233, highest: 1320 }),
        Louth: Object.freeze({ homes: 9, average: 1296, lowest: 1258, highest: 1325 }),
        Mayo: Object.freeze({ homes: 17, average: 1272, lowest: 1247, highest: 1333 }),
        Meath: Object.freeze({ homes: 18, average: 1313, lowest: 1282, highest: 1369 }),
        Monaghan: Object.freeze({ homes: 4, average: 1289, lowest: 1276, highest: 1299 }),
        Offaly: Object.freeze({ homes: 5, average: 1262, lowest: 1232, highest: 1281 }),
        Roscommon: Object.freeze({ homes: 8, average: 1254, lowest: 1225, highest: 1278 }),
        Sligo: Object.freeze({ homes: 6, average: 1332, lowest: 1276, highest: 1414 }),
        Tipperary: Object.freeze({ homes: 23, average: 1270, lowest: 1235, highest: 1295 }),
        Waterford: Object.freeze({ homes: 7, average: 1283, lowest: 1262, highest: 1315 }),
        Westmeath: Object.freeze({ homes: 8, average: 1241, lowest: 1192, highest: 1272 }),
        Wexford: Object.freeze({ homes: 14, average: 1265, lowest: 1212, highest: 1305 }),
        Wicklow: Object.freeze({ homes: 17, average: 1338, lowest: 1285, highest: 1373 })
      }),
      basis: 'The nursing home fee is the average of the HSE’s maximum agreed prices for private and voluntary nursing homes in the county, or nationally when the county is not known.',
      disclosure: 'This is a planning figure, not a quoted price. A home’s own fee can be higher or lower, and the HSE publishes a new list from time to time.',
      source: 'HSE, Nursing Home Support Scheme Maximum Agreed Prices with Private & Voluntary Nursing Homes, list 230',
      url: 'https://assets.hse.ie/media/documents/HSE_Section40_List_230_Published_List_04.09.2026.pdf',
      checkedOn: '2026-10-21'
    }),
    relativeCare: Object.freeze({
      defaultYears: 5,
      compareYears: Object.freeze([3, 10]),
      basis: 'Care for a relative is shown over 5 years, with 3 and 10 years beside it. These are planning lengths, not a forecast of how long care lasts.'
    }),
    ownCareStress: Object.freeze({
      startAge: 85,
      years: 5,
      approvedOn: '2026-10-21',
      sources: Object.freeze(['igeesNhss2019']),
      basis: 'The stress test assumes care from age 85 to 90. This is deliberately longer than the average stay in the scheme, about 2.6 years for men and 3.4 years for women (IGEES, 2019), and half of residents are over 85. It is a prudent stress, not a forecast.'
    })
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
    /** The policy, and the "enacted or announced" wording of its basis, were approved on this day. */
    approvedOn: '2026-10-27',
    policy: 'freeze_budget_parameters_apply_fixed_law_hold_unknowns',
    basis: 'Tax bands, credits and thresholds that each Budget sets are kept at their latest enacted or announced values in euro terms and never increased with inflation, because Budgets often leave them unchanged. Changes the law has already fixed by date and amount, such as the scheduled PRSI rises and the Standard Fund Threshold steps, are applied on their dates. Where the law ties a future figure to data that does not exist yet, such as the Standard Fund Threshold from 2030, the last known figure is held rather than forecast.',
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
  const { investment, inflation, collegeFunding, cash, care, version } = PLANEIR_ASSUMPTIONS;
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
    careFeeGrowth: {
      key: 'careFeeGrowthRate',
      value: inflation.educationRate,
      reason: `${inflation.educationBasis} (${version})`
    },
    careWeeklyFee: {
      key: 'careWeeklyFee',
      value: care.agreedPrices.nationalWeeklyAverage,
      reason: `${care.agreedPrices.basis} ${care.agreedPrices.disclosure} (HSE list ${care.agreedPrices.listNumber}, ${care.agreedPrices.listDate}; ${version})`
    },
    ownCareStressAge: {
      key: 'ownCareStressAge',
      value: care.ownCareStress.startAge,
      reason: `${care.ownCareStress.basis} (${version})`
    },
    ownCareStressYears: {
      key: 'ownCareStressYears',
      value: care.ownCareStress.years,
      reason: `${care.ownCareStress.basis} (${version})`
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
    presentValueRate: {
      key: 'presentValueRate',
      value: PLANEIR_ASSUMPTIONS.netRetirement.presentValueRate,
      reason: `${PLANEIR_ASSUMPTIONS.netRetirement.basis} ${PLANEIR_ASSUMPTIONS.netRetirement.disclosure} (${version})`
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
  careFeeGrowthRate: 'How fast nursing home fees rise (the education and healthcare cost rate)',
  careWeeklyFee: 'Nursing home fee a week',
  ownCareStressAge: 'Age at which the care stress test starts',
  ownCareStressYears: 'Years of care in the stress test',
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
