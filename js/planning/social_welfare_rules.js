/**
 * Social welfare rules that need working out, not just looking up: the State
 * Pension (Contributory) rate from a person's contributions, and the one-payment
 * rule for a survivor. Pure: no clock, no storage, nothing typed that the
 * figures register holds.
 *
 * THE STATE PENSION (CONTRIBUTORY) ESTIMATE
 *
 * Under the Total Contributions Approach (TCA) a person's rate is the share of
 * the maximum that their contributions are of 2,080 (40 years):
 *
 *   paid (full-rate) contributions
 *   + HomeCaring periods, for time spent caring for a child aged 12 or under or
 *     a person who needed an increased level of care, up to 1,040 (20 years)
 *   + credited contributions, up to 520
 *   = total; rate = total / 2,080 of the maximum, and the maximum at 2,080 or more
 *
 * A person qualifies with at least 520 paid contributions. Every threshold above
 * is read from the register (`ie.social_welfare.state_pension_contributory.*`)
 * with its source and the day it was read.
 *
 * `estimateStateContributoryPension` asks only simple facts (years paying PRSI in
 * Ireland, years at home caring full time, current age, and the age work is
 * expected to stop) and projects the contributions to State Pension age. It is an
 * ESTIMATE under that one method. Until 2034 the Department also compares a rate
 * that blends in the yearly-average method (80% yearly average and 20% TCA for
 * 2026), which can give some people more, so this can be lower than the pension
 * paid. Credited contributions are not asked for, so none are counted, which also
 * keeps it on the low side.
 *
 * A fact that is not known is a missing fact: the result says which, and holds no
 * rate. Nothing is ever guessed or defaulted here.
 */

import { getFigures } from './figures/get_figures.js';
import { statePensionRuleForYear } from './ireland_rules.js';

const PREFIX = 'ie.social_welfare.state_pension_contributory.';
const THRESHOLD_IDS = Object.freeze({
  pensionAge: `${PREFIX}pension_age`,
  maximumRateContributions: `${PREFIX}maximum_rate_contributions`,
  contributionsAYear: `${PREFIX}contributions_a_year`,
  minimumPaidContributions: `${PREFIX}minimum_paid_contributions`,
  homeCaringPeriodsCap: `${PREFIX}home_caring_periods_cap`,
  creditedContributionsCap: `${PREFIX}credited_contributions_cap`
});

const MAX_YEARS = 100;
const MAX_AGE = 120;

/** The thresholds, by name, each with its register entry for the source and date. */
function readThresholds(names) {
  const figures = getFigures({ ids: names.map((name) => THRESHOLD_IDS[name]) });
  const byId = new Map(figures.map((figure) => [figure.id, figure]));
  const values = {};
  const provenance = [];
  names.forEach((name) => {
    const figure = byId.get(THRESHOLD_IDS[name]);
    values[name] = figure.value;
    provenance.push({
      id: figure.id,
      label: figure.label,
      valueShown: figure.valueShown,
      checkedOn: figure.checkedOn,
      catalogueVersion: figure.catalogueVersion,
      source: { title: figure.source.title, url: figure.source.url }
    });
  });
  return { values, provenance };
}

function requireWholeCount(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number of contributions, 0 or more.`);
  }
  return value;
}

/** To the nearest 10 cent, which is how the Department's own worked example rounds a weekly rate. */
function nearestTenCent(amount) {
  return Math.round(amount * 10) / 10;
}

/**
 * The rate from contribution counts, under the Total Contributions Approach.
 *
 * @param {object} counts
 * @param {number} counts.paidContributions full-rate (Class A and Class S) contributions paid
 * @param {number} [counts.creditedContributions] credits for time unable to work
 * @param {number} [counts.homeCaringPeriods] HomeCaring periods
 * @returns {{ qualifies: boolean, fraction: number, percent: number,
 *   paidContributions: number, creditedContributions: number, creditedCapped: boolean,
 *   homeCaringPeriods: number, homeCaringCapped: boolean, totalContributions: number,
 *   thresholds: object, figures: object[] }}
 */
export function stateContributoryPensionFromContributions({
  paidContributions,
  creditedContributions = 0,
  homeCaringPeriods = 0
} = {}) {
  requireWholeCount(paidContributions, 'paidContributions');
  requireWholeCount(creditedContributions, 'creditedContributions');
  requireWholeCount(homeCaringPeriods, 'homeCaringPeriods');
  const { values, provenance } = readThresholds([
    'maximumRateContributions', 'minimumPaidContributions', 'homeCaringPeriodsCap', 'creditedContributionsCap'
  ]);

  const credited = Math.min(creditedContributions, values.creditedContributionsCap);
  const homeCaring = Math.min(homeCaringPeriods, values.homeCaringPeriodsCap);
  const total = paidContributions + credited + homeCaring;
  const qualifies = paidContributions >= values.minimumPaidContributions;
  const fraction = qualifies ? Math.min(1, total / values.maximumRateContributions) : 0;
  return {
    qualifies,
    fraction,
    percent: fraction * 100,
    paidContributions,
    creditedContributions: credited,
    creditedCapped: creditedContributions > values.creditedContributionsCap,
    homeCaringPeriods: homeCaring,
    homeCaringCapped: homeCaringPeriods > values.homeCaringPeriodsCap,
    totalContributions: total,
    thresholds: values,
    figures: provenance
  };
}

function isGiven(value) {
  return value !== undefined && value !== null;
}

function requireYears(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_YEARS) {
    throw new Error(`${name} must be a number of years from 0 to ${MAX_YEARS}.`);
  }
  return value;
}

function requireAge(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_AGE) {
    throw new Error(`${name} must be a whole age from 0 to ${MAX_AGE}.`);
  }
  return value;
}

const ESTIMATE_LABEL = 'An estimate under the Total Contributions Approach';
const ESTIMATE_NOTE = 'Until 2034 the Department also compares a rate that blends in the yearly-average method, which can give some people more, so the pension paid can be higher.';

const MISSING_NAMES = Object.freeze({
  yearsPayingPrsi: 'years paying PRSI in Ireland',
  yearsCaring: 'years at home caring full time',
  currentAge: 'current age',
  workStopAge: 'the age work is expected to stop'
});

/**
 * An estimate of the State Pension (Contributory) from simple facts.
 *
 * @param {object} facts
 * @param {number} facts.yearsPayingPrsi years paying PRSI in Ireland so far, as an employee or self-employed (Class S counts)
 * @param {number} facts.yearsCaring years at home caring full time, 0 if none
 * @param {number} facts.currentAge
 * @param {number} facts.workStopAge the age work is expected to stop
 * @param {object} [options]
 * @param {number} [options.year] the plan year, to put the maximum weekly rate in force that year beside the share
 * @returns {object} `status: 'missing'` with `missing` names, or `status: 'estimated'`
 *   with `fraction` of the maximum, `basis` in words, and the register entries used.
 */
export function estimateStateContributoryPension(facts = {}, { year = null } = {}) {
  const missing = Object.keys(MISSING_NAMES).filter((name) => !isGiven(facts[name]));
  if (missing.length > 0) {
    return Object.freeze({
      status: 'missing',
      missing: Object.freeze(missing),
      fraction: null,
      basis: `Not estimated: ${missing.map((name) => MISSING_NAMES[name]).join(' and ')} not known.`
    });
  }
  const yearsPayingPrsi = requireYears(facts.yearsPayingPrsi, 'yearsPayingPrsi');
  const yearsCaring = requireYears(facts.yearsCaring, 'yearsCaring');
  const currentAge = requireAge(facts.currentAge, 'currentAge');
  const workStopAge = requireAge(facts.workStopAge, 'workStopAge');

  const { values, provenance } = readThresholds(['pensionAge', 'contributionsAYear']);
  // Contributions after State Pension age are not counted: the pension is taken from then.
  const futureYears = Math.max(0, Math.min(workStopAge, values.pensionAge) - currentAge);
  const paidContributions = Math.round((yearsPayingPrsi + futureYears) * values.contributionsAYear);
  const homeCaringPeriods = Math.round(yearsCaring * values.contributionsAYear);
  const counted = stateContributoryPensionFromContributions({ paidContributions, homeCaringPeriods });

  const parts = [
    `${yearsPayingPrsi} years paying PRSI so far`,
    futureYears > 0 ? `${futureYears} more until work stops at ${Math.min(workStopAge, values.pensionAge)}` : 'none more to come',
    `${yearsCaring} years caring at home`
  ];
  const basis = counted.qualifies
    ? `${ESTIMATE_LABEL}, from ${parts.join(', ')}: ${counted.totalContributions} of ${counted.thresholds.maximumRateContributions} contributions at State Pension age. ${ESTIMATE_NOTE}`
    : `${ESTIMATE_LABEL}, from ${parts.join(', ')}: ${counted.paidContributions} paid contributions at State Pension age, fewer than the ${counted.thresholds.minimumPaidContributions} needed to qualify. ${ESTIMATE_NOTE}`;

  const result = {
    status: 'estimated',
    method: 'total_contributions_approach',
    label: ESTIMATE_LABEL,
    note: ESTIMATE_NOTE,
    basis,
    qualifies: counted.qualifies,
    fraction: counted.fraction,
    percent: counted.percent,
    pensionAge: values.pensionAge,
    projected: {
      atAge: values.pensionAge,
      futureYearsPaying: futureYears,
      paidContributions: counted.paidContributions,
      homeCaringPeriods: counted.homeCaringPeriods,
      homeCaringCapped: counted.homeCaringCapped,
      creditedContributions: 0,
      totalContributions: counted.totalContributions
    },
    thresholds: { ...counted.thresholds, ...values },
    figures: [...provenance, ...counted.figures]
  };
  if (year !== null) {
    const rule = statePensionRuleForYear(year);
    result.weeklyMaximum = rule.weeklyMaximumEur;
    result.weeklyRate = nearestTenCent(rule.weeklyMaximumEur * counted.fraction);
    result.rateYear = year;
    result.rateStatus = rule.status;
  }
  return Object.freeze(result);
}

/** The weekly rate for a share of a maximum, to the nearest 10 cent. */
export function weeklyRateForShare(share, weeklyMaximum) {
  if (typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 1) {
    throw new Error('share must be a fraction from 0 to 1.');
  }
  if (typeof weeklyMaximum !== 'number' || !Number.isFinite(weeklyMaximum) || weeklyMaximum < 0) {
    throw new Error('weeklyMaximum must be a number of euros, 0 or more.');
  }
  return nearestTenCent(weeklyMaximum * share);
}

/**
 * The one-payment rule: a survivor who could have both their own State Pension
 * and the Bereaved Partner's (Contributory) Pension is paid only the higher of
 * the two, never both and never the two added. Amounts are in one unit (a week or
 * a year). A payment the survivor does not have is left out (null). When the two
 * are equal their own State Pension is the one paid.
 *
 * Before retirement a survivor has no State Pension of their own, so only the
 * Bereaved Partner's (Contributory) Pension is paid and the rule does not arise.
 *
 * @param {{ statePension?: number|null, bereavedPartners?: number|null }} amounts
 * @returns {{ paid: 'statePension'|'bereavedPartnersContributory'|null, amount: number, notPaid: string|null }}
 */
export function survivorStatePayment({ statePension = null, bereavedPartners = null } = {}) {
  const check = (value, name) => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be an amount of 0 or more, or null when the survivor does not have it.`);
    }
    return value;
  };
  const own = check(statePension, 'statePension');
  const bereaved = check(bereavedPartners, 'bereavedPartners');
  if (own === null && bereaved === null) {
    return Object.freeze({ paid: null, amount: 0, notPaid: null });
  }
  if (bereaved === null || (own !== null && own >= bereaved)) {
    return Object.freeze({ paid: 'statePension', amount: own, notPaid: bereaved === null ? null : 'bereavedPartnersContributory' });
  }
  return Object.freeze({ paid: 'bereavedPartnersContributory', amount: bereaved, notPaid: own === null ? null : 'statePension' });
}
