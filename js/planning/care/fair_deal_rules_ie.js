/**
 * The Fair Deal rules (the Nursing Homes Support Scheme), by effective date.
 * Data only.
 *
 * Every figure here is read from the Act or from the official page named in
 * `FAIR_DEAL_SOURCES`, on the day the rule records in `verifiedOn`. None comes
 * from a third-party summary and none is typed anywhere else: the care engine
 * reads these through `resolveFairDealRules`, and the figures register lists
 * each one with its source and checked date.
 *
 * Two things this catalogue deliberately does not hold:
 *
 * - The State Pension (Non-Contributory) rates. They are social welfare rates,
 *   so they live in `social_welfare_ie.js` beside State Pension (Contributory)
 *   and are read from there. The rules below hold only the shares of that rate
 *   the scheme leaves a person (`retained.*`).
 * - The Irish tax rules, which the tax engine owns.
 *
 * The steps these figures feed are Schedule 1 of the Act, Parts 1A and 2A (an
 * application made on or after 25 July 2013). Parts 1 and 2, at 5%, are not
 * modelled, so the first block starts on 1 February 2024, the day the last rule
 * it holds (the share of eligible rental income) took its current value.
 *
 * Keeping it current: add a new block, never edit a past one, set `verifiedOn`
 * on every rule to the day it was read, and bump `FAIR_DEAL_RULES_VERSION`. A
 * rule a later block carries over unchanged is the SAME OBJECT as the earlier
 * block's, which is how the figures register lists it once, for the date it
 * first took effect.
 */

export const FAIR_DEAL_RULES_VERSION = 'ie-fair-deal-2026.1';

const FAIR_DEAL_SOURCES = Object.freeze({
  actSchedule1: Object.freeze({
    title: 'Nursing Homes Support Scheme Act 2009, Schedule 1 (Assessment of Means), revised Act',
    url: 'https://revisedacts.lawreform.ie/eli/2009/act/15/schedule/1/revised/en/html'
  }),
  actSection30: Object.freeze({
    title: 'Nursing Homes Support Scheme Act 2009, section 30 (Reviews), revised Act',
    url: 'https://revisedacts.lawreform.ie/eli/2009/act/15/section/30/revised/en/html'
  }),
  hseFinancialAssessment: Object.freeze({
    title: 'HSE, Fair Deal scheme: financial assessment, how much you pay towards care',
    url: 'https://www2.hse.ie/services/schemes-allowances/fair-deal-scheme/financial-assessment/'
  }),
  hseThreeYearCap: Object.freeze({
    title: 'HSE, Fair Deal scheme: 3-year cap on homes, farms and businesses',
    url: 'https://www2.hse.ie/services/schemes-allowances/fair-deal-scheme/3-year-cap/'
  }),
  hseNursingHomeLoan: Object.freeze({
    title: 'HSE, Fair Deal scheme: nursing home loan',
    url: 'https://www2.hse.ie/services/schemes-allowances/fair-deal-scheme/nursing-home-loan/'
  }),
  ciFairDeal: Object.freeze({
    title: 'Citizens Information, Fair Deal scheme',
    url: 'https://www.citizensinformation.ie/en/health/health-services/health-services-for-older-people/fair-deal-scheme/'
  }),
  revenueLoanRepaid: Object.freeze({
    title: 'Revenue, how the nursing home loan is repaid',
    url: 'https://www.revenue.ie/en/life-events-and-personal-circumstances/nursing-homes-fair-deal-loan/'
  })
});

/** The Act's rules were read live on this day; the HSE and Revenue loan pages on the earlier one. */
const ACT_READ_ON = '2026-10-27';
const PAGES_READ_ON = '2026-10-21';

const BLOCK_YEAR = 2024;

/**
 * One rule. `name` is the quantity the figures register lists it under, and
 * the key the engine reads it by. `effectiveFrom` is set only where the source
 * states a date for that rule.
 */
function rule(name, value, unit, label, sourceKeys, verifiedOn, effectiveFrom = null) {
  return Object.freeze({
    name,
    ruleId: `ie.fair_deal.${name}.${BLOCK_YEAR}`,
    value,
    unit,
    label,
    sources: Object.freeze(sourceKeys.map((key) => FAIR_DEAL_SOURCES[key])),
    verifiedOn,
    effectiveFrom
  });
}

const BLOCK_2024_02_01 = Object.freeze({
  effectiveFrom: '2024-02-01',
  status: 'enacted',
  verifiedOn: ACT_READ_ON,
  rules: Object.freeze([
    rule('income.share.single', 0.8, 'rate',
      'Share of a single person’s income, after tax and deductions, that Fair Deal assesses',
      ['actSchedule1', 'hseFinancialAssessment', 'ciFairDeal'], ACT_READ_ON),
    rule('income.share.couple', 0.4, 'rate',
      'Share of a couple’s combined income, after tax and deductions, that Fair Deal assesses for the person in care',
      ['actSchedule1', 'hseFinancialAssessment'], ACT_READ_ON),
    rule('income.rental_share', 0, 'rate',
      'Share of the rent from a person’s own home that Fair Deal assesses while they are in care',
      ['actSchedule1', 'ciFairDeal', 'hseFinancialAssessment'], ACT_READ_ON, '2024-02-01'),
    rule('assets.rate', 0.075, 'rate_a_year',
      'Yearly share of a person’s net assets above the disregard that Fair Deal assesses',
      ['actSchedule1', 'hseFinancialAssessment'], ACT_READ_ON),
    rule('assets.couple_divisor', 2, 'count',
      'Number of people a couple’s assessed assets are divided between',
      ['actSchedule1', 'hseFinancialAssessment'], ACT_READ_ON),
    rule('assets.disregard.single', 36_000, 'eur',
      'Assets of a single person that Fair Deal does not count',
      ['actSchedule1', 'hseFinancialAssessment', 'ciFairDeal'], ACT_READ_ON),
    rule('assets.disregard.couple', 72_000, 'eur',
      'Assets of a couple that Fair Deal does not count',
      ['actSchedule1', 'hseFinancialAssessment'], ACT_READ_ON),
    rule('home.cap_years', 3, 'years',
      'Years of care after which a person’s home stops counting in the Fair Deal assessment',
      ['actSchedule1', 'hseThreeYearCap', 'ciFairDeal'], ACT_READ_ON),
    rule('home.couple_both_in_care_cap', 0.225, 'rate',
      'Most a couple’s shared home can add to Fair Deal contributions when both receive care, as a share of its value',
      ['actSchedule1', 'ciFairDeal'], ACT_READ_ON),
    rule('retained.single_pension_share', 0.2, 'rate',
      'Share of the maximum State Pension (Non-Contributory) that a single person keeps at least',
      ['actSchedule1', 'ciFairDeal'], ACT_READ_ON),
    rule('retained.couple_at_home_pension_multiple', 1.2, 'multiple',
      'Multiple of the maximum State Pension (Non-Contributory) that a couple keeps at least when the partner stays at home',
      ['actSchedule1', 'ciFairDeal'], ACT_READ_ON),
    rule('transfers.look_back_years', 5, 'years',
      'Years before a Fair Deal application in which a transfer of assets or income still counts',
      ['actSchedule1', 'hseFinancialAssessment', 'ciFairDeal'], ACT_READ_ON),
    rule('review.earliest_request_months', 12, 'months',
      'Months after an assessment or review before a person can ask for another review without a material change',
      ['actSection30', 'hseFinancialAssessment', 'ciFairDeal'], ACT_READ_ON),
    rule('loan.repay_after_death_months.revenue', 12, 'months',
      'Months after death within which the nursing home loan is repaid, as Revenue states it',
      ['revenueLoanRepaid'], PAGES_READ_ON),
    rule('loan.repay_after_death_months.hse', 18, 'months',
      'Months after death within which the nursing home loan is repaid, as the HSE states it',
      ['hseNursingHomeLoan'], PAGES_READ_ON),
    rule('loan.repay_on_sale_months', 6, 'months',
      'Months after a sale or transfer of the home within which the nursing home loan is repaid',
      ['revenueLoanRepaid', 'hseNursingHomeLoan'], PAGES_READ_ON),
    rule('loan.late_interest_daily', 0.000219, 'rate',
      'Interest charged a day on a late repayment of the nursing home loan',
      ['revenueLoanRepaid'], PAGES_READ_ON)
  ])
});

/** Oldest first. */
export const FAIR_DEAL_RULE_BLOCKS = Object.freeze([BLOCK_2024_02_01]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The rules in force on a date: the last block that starts on or before it.
 * A date after the last block uses the last block, because nothing in the Act
 * is indexed; `latest` says so. A date before the first block throws.
 *
 * `catalogue` is the test injection: a list of blocks in the same shape.
 */
export function resolveFairDealRules(dateIso, { catalogue = FAIR_DEAL_RULE_BLOCKS } = {}) {
  if (!ISO_DATE.test(dateIso ?? '')) {
    throw new Error(`The Fair Deal rules are asked for on a YYYY-MM-DD date; received ${JSON.stringify(dateIso)}.`);
  }
  const block = [...catalogue].reverse().find((candidate) => candidate.effectiveFrom <= dateIso);
  if (!block) {
    throw new Error(`The Fair Deal rules are recorded from ${catalogue[0].effectiveFrom}; ${dateIso} is earlier.`);
  }
  const byName = new Map(block.rules.map((entry) => [entry.name, entry]));
  const find = (name) => {
    const entry = byName.get(name);
    if (!entry) {
      throw new Error(`The Fair Deal rules have no rule named ${JSON.stringify(name)}.`);
    }
    return entry;
  };
  return Object.freeze({
    version: FAIR_DEAL_RULES_VERSION,
    effectiveFrom: block.effectiveFrom,
    status: block.status,
    verifiedOn: block.verifiedOn,
    latest: block === catalogue[catalogue.length - 1],
    value: (name) => find(name).value,
    ruleId: (name) => find(name).ruleId,
    ruleIds: Object.freeze(block.rules.map((entry) => entry.ruleId))
  });
}
