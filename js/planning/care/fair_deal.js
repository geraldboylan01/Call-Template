/**
 * The Fair Deal assessment: what the Nursing Homes Support Scheme asks a person
 * to pay towards their care, from their income and their assets.
 *
 * These are the steps of Schedule 1 of the Act, Part 1A for a person who is not
 * a member of a couple and Part 2A for one who is (an application made on or
 * after 25 July 2013). The Act works in weeks and multiplies by 52 for the
 * year. Every step here is a share or a subtraction, so working in whole years
 * gives the same figure to the cent; the care check rebuilds each case in weeks
 * from the Act's own wording to prove it.
 *
 * Nothing is typed here. The shares, disregards and thresholds come from the
 * rules passed in (`resolveFairDealRules`), and the State Pension
 * (Non-Contributory) rate they are measured against comes from the caller, who
 * reads it from the social welfare catalogue at the date of the application.
 *
 * What this does not decide: whether Fair Deal is used in a year, who pays the
 * contribution, or any tax. It assesses; `care_costs_math.js` applies.
 */

const WEEKS_IN_YEAR = 52;

/**
 * The person's weekly assessed income, as a yearly figure (Schedule 1, para 2).
 *
 * `netIncome` is the year's income after income tax, USC, PRSI, levies and the
 * other allowable deductions, leaving out the eligible rent on the person's own
 * home. That rent (`eligibleRent`, after the tax due on it) is assessed at its
 * own share, which is 0%, and still counts in full towards what the person keeps.
 *
 * For a person who is not a member of a couple the share is 80%; for one who is
 * it is 40% of the couple's combined net income. Where what is left would be
 * less than the minimum retained income threshold, the person pays everything
 * above the threshold instead.
 */
function assessIncome({ rules, isCouple, weeklyPension, netIncome, eligibleRent }) {
  const share = rules.value(isCouple ? 'income.share.couple' : 'income.share.single');
  const rentalShare = rules.value('income.rental_share');
  const thresholdFactor = isCouple
    ? rules.value('retained.couple_at_home_pension_multiple')
    : rules.value('retained.single_pension_share');
  const threshold = thresholdFactor * weeklyPension * WEEKS_IN_YEAR;
  const kept = ((1 - share) * netIncome) + ((1 - rentalShare) * eligibleRent);
  const safeguardBinds = kept < threshold;
  const assessed = safeguardBinds
    ? netIncome + eligibleRent - threshold
    : (share * netIncome) + (rentalShare * eligibleRent);
  return { incomePart: Math.max(0, assessed), threshold, safeguardBinds };
}

/**
 * The assets (Schedule 1, paras 3 and 4).
 *
 * Cash assets come first: the disregard comes off them, and what is left of the
 * disregard comes off the total of the non-cash ("relevant") assets. Together
 * that is the rate on all net assets above the disregard, however they are
 * classed. Only how the non-cash part splits between other property and the home
 * depends on the order, so the unused disregard is taken off other property
 * before the home (an open check with the HSE, which changes how much the
 * Nursing Home Loan can defer and never the total).
 *
 * A couple's assets are assessed together and each partner is assessed on half.
 */
function assessAssets({ rules, isCouple, cash, otherProperty, home }) {
  const disregard = rules.value(isCouple ? 'assets.disregard.couple' : 'assets.disregard.single');
  const rate = rules.value('assets.rate');
  const divisor = isCouple ? rules.value('assets.couple_divisor') : 1;

  const cashBase = Math.max(0, cash - disregard);
  const unused = Math.max(0, disregard - cash);
  const otherBase = Math.max(0, otherProperty - unused);
  const unusedAfterOther = Math.max(0, unused - otherProperty);
  const homeBase = Math.max(0, home - unusedAfterOther);

  const part = (base) => (rate * base) / divisor;
  return {
    savingsPart: part(cashBase),
    otherPropertyPart: part(otherBase),
    homePart: part(homeBase),
    disregard,
    unusedDisregard: unused
  };
}

/**
 * Assess one year.
 *
 * @param {object} args
 * @param {object} args.rules The Fair Deal rules in force (`resolveFairDealRules`).
 * @param {boolean} args.isCouple The person is one of a couple whose partner stays at home.
 * @param {number} args.weeklyPension The maximum weekly State Pension (Non-Contributory)
 *   at the date of the application.
 * @param {number} args.netIncome The year's net income (see `assessIncome`), floored at 0 by the caller.
 * @param {number} [args.eligibleRent] The year's eligible rent after tax.
 * @param {number} args.cash Cash assets, net of borrowings, including transferred cash.
 * @param {number} args.otherProperty Other property net of borrowings, including transferred non-cash assets.
 * @param {number} args.home The home net of borrowings while it counts, otherwise 0.
 * @returns {object} The four parts of the contribution, their sum, and what set the income part.
 */
export function assessFairDeal({ rules, isCouple, weeklyPension, netIncome, eligibleRent = 0, cash, otherProperty, home }) {
  const income = assessIncome({ rules, isCouple, weeklyPension, netIncome, eligibleRent });
  const assets = assessAssets({ rules, isCouple, cash, otherProperty, home });
  return {
    incomePart: income.incomePart,
    savingsPart: assets.savingsPart,
    otherPropertyPart: assets.otherPropertyPart,
    homePart: assets.homePart,
    contribution: income.incomePart + assets.savingsPart + assets.otherPropertyPart + assets.homePart,
    retainedIncomeThreshold: income.threshold,
    safeguardBinds: income.safeguardBinds,
    assetDisregard: assets.disregard
  };
}
