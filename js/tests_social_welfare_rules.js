import {
  estimateStateContributoryPension,
  stateContributoryPensionFromContributions,
  survivorStatePayment,
  weeklyRateForShare
} from './planning/social_welfare_rules.js';
import { getFigures } from './planning/figures/get_figures.js';

/**
 * The State Pension (Contributory) estimate and the one-payment rule, proved
 * against the Department of Social Protection's own worked example and at the
 * boundaries of the Total Contributions Approach. The thresholds the tests
 * compare with are read from the register, so the tests and the rules cannot
 * drift apart, and the published figures are written out here as the Department
 * prints them.
 *
 * The Department's worked example (State Pension (Contributory) calculation
 * methods and rates, gov.ie): "Mary has 965 reckonable contributions, 403
 * credited contributions and 205 Home Caring periods": 965 + 403 + 205 = 1,573,
 * 1,573 / 2,080 = 0.7562, 75.62%, and at the 2025 maximum of 289.30 that is
 * 218.80 a week.
 */

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertWithin(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message || 'Values differ'}: expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

function assertThrows(fn, pattern, message) {
  try {
    fn();
  } catch (error) {
    if (!pattern.test(error.message)) throw new Error(`${message}: unexpected error "${error.message}"`);
    return;
  }
  throw new Error(`${message}: expected an error`);
}

function runCase(name, fn) {
  try {
    fn();
    console.info(`[SocialWelfareRulesTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[SocialWelfareRulesTests] FAIL: ${name}\n    ${error.message}`);
    return { name, pass: false, error: error.message };
  }
}

const PREFIX = 'ie.social_welfare.state_pension_contributory.';
const registerValue = (id) => getFigures({ ids: [`${PREFIX}${id}`] })[0].value;

/** The thresholds, read from the register by the tests too. */
const FULL = registerValue('maximum_rate_contributions');
const MINIMUM = registerValue('minimum_paid_contributions');
const HOME_CARING_CAP = registerValue('home_caring_periods_cap');
const CREDITS_CAP = registerValue('credited_contributions_cap');
const PER_YEAR = registerValue('contributions_a_year');
const PENSION_AGE = registerValue('pension_age');

export function runSocialWelfareRulesTests() {
  const cases = [];

  cases.push(runCase('The thresholds are in the register, each with a gov.ie source and the day it was read', () => {
    assertEqual(FULL, 2080, 'the maximum rate needs 2,080 contributions');
    assertEqual(MINIMUM, 520, 'and 520 paid ones qualify');
    assertEqual(HOME_CARING_CAP, 1040, 'HomeCaring is capped at 1,040');
    assertEqual(CREDITS_CAP, 520, 'credits at 520');
    assertEqual(PER_YEAR, 52, '52 a year');
    assertEqual(PENSION_AGE, 66, 'State Pension age');
    assertEqual(FULL / PER_YEAR, 40, '2,080 is 40 years');
    const ids = ['pension_age', 'maximum_rate_contributions', 'contributions_a_year', 'minimum_paid_contributions', 'home_caring_periods_cap', 'credited_contributions_cap'];
    getFigures({ ids: ids.map((id) => `${PREFIX}${id}`) }).forEach((figure) => {
      assert(figure.source.url.startsWith('https://www.gov.ie/'), `${figure.id}: a gov.ie source`);
      assert(/^\d{4}-\d{2}-\d{2}$/.test(figure.checkedOn), `${figure.id}: a checked date`);
      assertEqual(figure.kind, 'law', `${figure.id}: law in force`);
      assert(figure.usedBy.includes('pension_projection'), `${figure.id}: used by the pension projection`);
    });
  }));

  cases.push(runCase('The Department’s worked example: 965 + 403 + 205 = 1,573 is 75.62%, and 218.80 a week at the 2025 maximum of 289.30', () => {
    const mary = stateContributoryPensionFromContributions({ paidContributions: 965, creditedContributions: 403, homeCaringPeriods: 205 });
    assertEqual(mary.totalContributions, 1_573, 'the total');
    assertEqual(mary.fraction, 1_573 / 2_080, 'the share of the maximum');
    assertWithin(mary.percent, 75.62, 0.006, 'the Department prints 75.62%');
    assertEqual(mary.qualifies, true, 'she qualifies');
    assertEqual(weeklyRateForShare(mary.fraction, 289.30), 218.80, 'the weekly rate the Department prints');
    assert(!mary.creditedCapped && !mary.homeCaringCapped, 'nothing is capped');
  }));

  cases.push(runCase('The maximum rate at 2,080 contributions, and not above it: 2,079 is a fraction short, 2,500 is still the full rate', () => {
    assertEqual(stateContributoryPensionFromContributions({ paidContributions: 2_080 }).fraction, 1, 'exactly 2,080 paid');
    const short = stateContributoryPensionFromContributions({ paidContributions: 2_079 });
    assertEqual(short.fraction, 2_079 / 2_080, '2,079 is one contribution short');
    assert(short.fraction < 1, 'so less than the full rate');
    assertEqual(stateContributoryPensionFromContributions({ paidContributions: 2_500 }).fraction, 1, 'more than 2,080 is no more than the maximum');
    // The three kinds add up to the full rate: 1,000 paid, 520 credits, 560 HomeCaring.
    assertEqual(stateContributoryPensionFromContributions({ paidContributions: 1_000, creditedContributions: 520, homeCaringPeriods: 560 }).fraction, 1, 'paid, credits and HomeCaring together');
  }));

  cases.push(runCase('The 520 paid-contribution minimum: 519 does not qualify and has no rate, 520 qualifies at a quarter', () => {
    const below = stateContributoryPensionFromContributions({ paidContributions: 519 });
    assertEqual(below.qualifies, false, '519 does not qualify');
    assertEqual(below.fraction, 0, 'and has no pension');
    const at = stateContributoryPensionFromContributions({ paidContributions: 520 });
    assertEqual(at.qualifies, true, '520 qualifies');
    assertEqual(at.fraction, 520 / 2_080, 'a quarter of the maximum');
    assertEqual(at.fraction, 0.25, 'which is 25%');
    // Caring and credits cannot stand in for paid contributions.
    const padded = stateContributoryPensionFromContributions({ paidContributions: 519, creditedContributions: 520, homeCaringPeriods: 1_040 });
    assertEqual(padded.qualifies, false, 'HomeCaring and credits do not make up the 520 paid');
    assertEqual(padded.fraction, 0, 'so nothing is paid');
    assertEqual(stateContributoryPensionFromContributions({ paidContributions: 0 }).fraction, 0, 'no contributions');
  }));

  cases.push(runCase('HomeCaring periods count to 1,040 and no further; credited contributions to 520', () => {
    const atCap = stateContributoryPensionFromContributions({ paidContributions: 520, homeCaringPeriods: 1_040 });
    assertEqual(atCap.homeCaringPeriods, 1_040, '1,040 count');
    assertEqual(atCap.homeCaringCapped, false, 'at the cap is not over it');
    assertEqual(atCap.fraction, 1_560 / 2_080, '520 + 1,040');
    const over = stateContributoryPensionFromContributions({ paidContributions: 520, homeCaringPeriods: 1_041 });
    assertEqual(over.homeCaringPeriods, 1_040, '1,041 counts as 1,040');
    assertEqual(over.homeCaringCapped, true, 'and says it was capped');
    assertEqual(over.fraction, atCap.fraction, 'the same rate');
    const bigCaring = stateContributoryPensionFromContributions({ paidContributions: 1_040, homeCaringPeriods: 5_000 });
    assertEqual(bigCaring.fraction, 1, '1,040 paid + 1,040 capped caring is the full 2,080');
    const credits = stateContributoryPensionFromContributions({ paidContributions: 520, creditedContributions: 521 });
    assertEqual(credits.creditedContributions, 520, 'credits count to 520');
    assertEqual(credits.creditedCapped, true, 'and say so');
  }));

  cases.push(runCase('Counts must be whole contributions, 0 or more', () => {
    assertThrows(() => stateContributoryPensionFromContributions({ paidContributions: -1 }), /paidContributions must be a whole number/, 'negative');
    assertThrows(() => stateContributoryPensionFromContributions({ paidContributions: 10.5 }), /paidContributions must be a whole number/, 'fraction of a contribution');
    assertThrows(() => stateContributoryPensionFromContributions({}), /paidContributions must be a whole number/, 'no paid contributions given');
    assertThrows(() => stateContributoryPensionFromContributions({ paidContributions: 520, homeCaringPeriods: -5 }), /homeCaringPeriods/, 'negative caring');
  }));

  cases.push(runCase('The estimate projects contributions to State Pension age from simple facts', () => {
    // 20 years paying now at 45, working to 66: 21 more years = 41 years, 2,132 contributions, the full rate.
    const full = estimateStateContributoryPension({ yearsPayingPrsi: 20, yearsCaring: 0, currentAge: 45, workStopAge: 66 });
    assertEqual(full.status, 'estimated', 'estimated');
    assertEqual(full.projected.paidContributions, 41 * PER_YEAR, '41 years of contributions');
    assertEqual(full.fraction, 1, 'the maximum');
    // Work stopping at 60 instead: 15 more years = 35 years = 1,820, which is 87.5%.
    const early = estimateStateContributoryPension({ yearsPayingPrsi: 20, yearsCaring: 0, currentAge: 45, workStopAge: 60 });
    assertEqual(early.projected.paidContributions, 35 * PER_YEAR, '35 years');
    assertEqual(early.fraction, 0.875, '87.5%');
    assertEqual(early.projected.futureYearsPaying, 15, 'years still to pay');
    // Work after State Pension age adds nothing: stopping at 70 is the same as at 66.
    const late = estimateStateContributoryPension({ yearsPayingPrsi: 20, yearsCaring: 0, currentAge: 45, workStopAge: 70 });
    assertEqual(late.projected.paidContributions, full.projected.paidContributions, 'nothing after 66 counts');
    // Already stopped: no more to come.
    const stopped = estimateStateContributoryPension({ yearsPayingPrsi: 30, yearsCaring: 0, currentAge: 70, workStopAge: 64 });
    assertEqual(stopped.projected.futureYearsPaying, 0, 'none to come');
    assertEqual(stopped.projected.paidContributions, 30 * PER_YEAR, 'what has been paid');
    assertEqual(stopped.fraction, 30 / 40, '30 of 40 years');
    // Class S counts the same as employment: the estimator asks only for years paying PRSI.
    assertEqual(full.method, 'total_contributions_approach', 'the method');
  }));

  cases.push(runCase('The estimate at the boundaries: 519 and 520 contributions, and years caring at the cap', () => {
    // Work already stopped, so what is paid now is what there will be.
    const years = (n, caring = 0) => estimateStateContributoryPension({ yearsPayingPrsi: n, yearsCaring: caring, currentAge: 70, workStopAge: 60 });
    assertEqual(years(9.99).projected.paidContributions, 519, '9.99 years is 519 contributions');
    assertEqual(years(9.99).qualifies, false, 'not qualifying');
    assertEqual(years(9.99).fraction, 0, 'no pension');
    assertEqual(years(10).projected.paidContributions, 520, '10 years is 520');
    assertEqual(years(10).qualifies, true, 'qualifying');
    assertEqual(years(10).fraction, 0.25, 'a quarter');
    // Caring: 20 years is the cap, 25 years counts as 20.
    const atCap = years(10, 20);
    assertEqual(atCap.projected.homeCaringPeriods, 1_040, '20 years caring is 1,040');
    assertEqual(atCap.projected.homeCaringCapped, false, 'at the cap');
    assertEqual(atCap.fraction, 0.75, '10 years paid and 20 caring');
    const over = years(10, 25);
    assertEqual(over.projected.homeCaringPeriods, 1_040, '25 years counts as 20');
    assertEqual(over.projected.homeCaringCapped, true, 'and says it was capped');
    assertEqual(over.fraction, atCap.fraction, 'the same rate');
    // Full rate with caring at the cap: 20 years paid + 20 caring = 2,080.
    assertEqual(years(20, 20).fraction, 1, '20 years paid and 20 caring is the maximum');
    // Caring alone, with too few paid years, does not qualify.
    assertEqual(years(5, 20).fraction, 0, '5 years paid does not qualify however long the caring');
  }));

  cases.push(runCase('An unknown fact is a missing fact, never a guess: nothing is estimated and no rate is given', () => {
    const base = { yearsPayingPrsi: 20, yearsCaring: 0, currentAge: 45, workStopAge: 66 };
    Object.keys(base).forEach((name) => {
      [undefined, null].forEach((empty) => {
        const result = estimateStateContributoryPension({ ...base, [name]: empty });
        assertEqual(result.status, 'missing', `${name} ${empty}: missing`);
        assertEqual(result.fraction, null, `${name}: no fraction`);
        assert(result.missing.includes(name), `${name}: named`);
        assert(!('weeklyRate' in result), `${name}: no rate`);
        assert(/^Not estimated: /.test(result.basis), `${name}: the basis says it was not estimated`);
      });
    });
    const none = estimateStateContributoryPension({});
    assertEqual(none.missing.length, 4, 'all four named when none is given');
    // A stated zero is a fact, not a missing one.
    const zero = estimateStateContributoryPension({ ...base, yearsPayingPrsi: 0, workStopAge: 40 });
    assertEqual(zero.status, 'estimated', 'zero years is a stated fact');
    assertEqual(zero.fraction, 0, 'and no pension');
    assertThrows(() => estimateStateContributoryPension({ ...base, yearsPayingPrsi: -1 }), /yearsPayingPrsi must be a number of years/, 'negative years');
    assertThrows(() => estimateStateContributoryPension({ ...base, currentAge: 45.5 }), /currentAge must be a whole age/, 'a fractional age');
    assertThrows(() => estimateStateContributoryPension({ ...base, yearsCaring: 'some' }), /yearsCaring must be a number of years/, 'text for years');
  }));

  cases.push(runCase('It is labelled an estimate under the Total Contributions Approach, and says the pension paid can be higher until 2034', () => {
    const result = estimateStateContributoryPension({ yearsPayingPrsi: 20, yearsCaring: 2, currentAge: 45, workStopAge: 60 });
    assertEqual(result.label, 'An estimate under the Total Contributions Approach', 'the label');
    assert(result.basis.startsWith('An estimate under the Total Contributions Approach, from 20 years paying PRSI so far, 15 more until work stops at 60, 2 years caring at home'), result.basis);
    assert(/Until 2034 the Department also compares a rate that blends in the yearly-average method, which can give some people more/.test(result.basis), 'the transition is stated');
    assert(!/—/.test(result.basis), 'no em dash');
    // Every register entry used is returned with its source, checked date and version.
    assert(result.figures.length >= 6, 'the thresholds used are named');
    result.figures.forEach((figure) => {
      assert(figure.source.url.startsWith('https://www.gov.ie/') && figure.checkedOn && figure.catalogueVersion, `${figure.id} carries its source, date and version`);
    });
    const failing = estimateStateContributoryPension({ yearsPayingPrsi: 8, yearsCaring: 0, currentAge: 70, workStopAge: 60 });
    assert(/fewer than the 520 needed to qualify/.test(failing.basis), failing.basis);
  }));

  cases.push(runCase('With a plan year, the weekly rate is the register’s maximum for that year', () => {
    const result = estimateStateContributoryPension({ yearsPayingPrsi: 30, yearsCaring: 0, currentAge: 70, workStopAge: 60 }, { year: 2026 });
    assertEqual(result.weeklyMaximum, 299.30, 'the 2026 maximum');
    assertEqual(result.weeklyRate, 224.5, '75% of 299.30, to the nearest 10 cent');
    assertEqual(result.rateYear, 2026, 'the year');
    const announced = estimateStateContributoryPension({ yearsPayingPrsi: 40, yearsCaring: 0, currentAge: 70, workStopAge: 60 }, { year: 2027 });
    assertEqual(announced.rateStatus, 'announced', 'a Budget rate says it is announced');
    assertEqual(announced.weeklyRate, announced.weeklyMaximum, 'the full rate is the maximum');
    assertThrows(() => weeklyRateForShare(1.5, 299.3), /fraction from 0 to 1/, 'a share above 1');
  }));

  cases.push(runCase('The one-payment rule: a survivor with both is paid the higher, never both', () => {
    const both = survivorStatePayment({ statePension: 299.3, bereavedPartners: 259.5 });
    assertEqual(both.paid, 'statePension', 'the higher is their own State Pension');
    assertEqual(both.amount, 299.3, 'its amount');
    assertEqual(both.notPaid, 'bereavedPartnersContributory', 'the other is not paid');
    const reduced = survivorStatePayment({ statePension: 120, bereavedPartners: 259.5 });
    assertEqual(reduced.paid, 'bereavedPartnersContributory', 'a reduced State Pension is below the Bereaved Partner’s pension');
    assertEqual(reduced.amount, 259.5, 'so that is paid, and not the two added');
    assertEqual(reduced.notPaid, 'statePension', 'the State Pension is not paid');
    const equal = survivorStatePayment({ statePension: 259.5, bereavedPartners: 259.5 });
    assertEqual(equal.paid, 'statePension', 'a tie is their own State Pension');
    assertEqual(equal.amount, 259.5, 'paid once');
    const before = survivorStatePayment({ bereavedPartners: 259.5 });
    assertEqual(before.paid, 'bereavedPartnersContributory', 'before retirement the rule does not arise');
    assertEqual(before.notPaid, null, 'nothing is set aside');
    const own = survivorStatePayment({ statePension: 100 });
    assertEqual(own.paid, 'statePension', 'only a State Pension');
    const none = survivorStatePayment({});
    assertEqual(none.paid, null, 'neither');
    assertEqual(none.amount, 0, 'nothing');
    const zero = survivorStatePayment({ statePension: 0, bereavedPartners: 259.5 });
    assertEqual(zero.paid, 'bereavedPartnersContributory', 'a State Pension of nothing is lower');
    assertThrows(() => survivorStatePayment({ statePension: -1 }), /statePension must be an amount of 0 or more/, 'negative');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };
  if (failed > 0) {
    console.warn('[SocialWelfareRulesTests] Completed with failures', summary);
  } else {
    console.info('[SocialWelfareRulesTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
