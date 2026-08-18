/**
 * RUN METRICS THAT CAN BE TESTED WITHOUT PAYING FOR A CONVERSATION.
 *
 * These live outside `run-live-call.mjs` because that file starts a meeting at
 * import time, so nothing can import it to check its arithmetic. A metric that
 * cannot be tested is a metric that quietly drifts — and two of them already
 * had, each reporting a failure that had not happened.
 */

/**
 * Did this run own things correctly — and was there anything to judge?
 *
 * THREE STATES, BECAUSE "WRONG" AND "NEVER CAME UP" ARE DIFFERENT SEVERITIES.
 * The first batch reported four ownership failures; three were runs where the
 * synthetic client simply never mentioned their partner, so the profile had
 * none and a long `&&` called that incorrect ownership. Zero of the four had a
 * holding in the wrong name — which is the failure the metric exists to catch,
 * because it is the one that would feed a module someone else's money.
 *
 *   false — something IS wrong: a holding or income in the wrong name, or a
 *           captured age that contradicts what the client said.
 *   null  — nothing to judge: no household, or an age the persona states that
 *           the conversation never reached. Already counted by
 *           `module_critical_capture`; counting it here reports one gap twice.
 *   true  — everything the persona stated was established and correctly owned.
 */
export function ownershipVerdict(profile, truth = {}) {
  const primaryId = profile?.primaryPerson?.personId;
  const pensions = profile?.pensions || [];
  const incomes = profile?.incomeSources || [];
  const age = (person) => Number(person?.age);

  // Both sides must exist for a mismatch to mean anything: comparing a captured
  // age against a truth that does not state one reported every such run wrong.
  const contradicts = (stated, captured) =>
    Number.isFinite(stated) && Number.isFinite(captured) && captured !== stated;

  const wrong = [
    pensions.some((item) => item.ownerId !== primaryId),
    incomes.some((item) => item.ownerId !== primaryId),
    contradicts(truth.primaryAge, age(profile?.primaryPerson)),
    contradicts(truth.partnerAge, age(profile?.partner))
  ].some(Boolean);
  if (wrong) return false;

  const unreached = (stated, captured) => Number.isFinite(stated) && !Number.isFinite(captured);
  const unresolved = !primaryId
    || unreached(truth.primaryAge, age(profile?.primaryPerson))
    || unreached(truth.partnerAge, age(profile?.partner));
  return unresolved ? null : true;
}

/**
 * Did the module calculate the right opening figure — and did one run at all?
 *
 * `false` used to mean both "calculated the wrong number" and "calculated
 * nothing", so a batch scoring this 2/5 could not say whether any client had
 * ever been given a wrong number, and every failure to reach a module was
 * counted twice.
 */
export function arithmeticVerdict(result, expected) {
  if (!result) return null;
  if (!Number.isFinite(Number(expected))) return null;
  return Number(result) === Number(expected);
}

/**
 * How many figures the client corrected are still canonical at their OLD value?
 *
 * COVER EVERY FIGURE THE PERSONA STATES, NOT TWO OF THEM. This checked the
 * retirement age and the gross income and nothing else. A paid run where the
 * client said "I pay in 7 percent" and then "sorry, 6 percent is right" ended
 * with 0.07 canonical, the module ran on it, and the batch reported
 * correction_superseded 3/3 — because contribution rates were not among the
 * figures it looked at. A supersession metric that covers some of the
 * corrections is worse than none: it reports success over silent loss.
 */
/** Did the client actually say this figure, in digits or with separators? */
function spokenInTranscript(value, transcript) {
  const text = String(transcript || '');
  if (!text) return true; // No transcript supplied: fall back to the plain comparison.
  const plain = String(value);
  const grouped = Number(value).toLocaleString('en-US');
  const pattern = new RegExp(`(?<![\\d.,])(?:${plain}|${grouped.replace(/,/g, '[,.\\s]?')})(?![\\d.,]*\\d)`);
  // Rates are stated as percentages: 0.06 canonical is "6" or "6%" spoken.
  const asPercent = Number(value) > 0 && Number(value) < 1
    ? new RegExp(`(?<![\\d.,])${Math.round(Number(value) * 100)}\\s*(?:%|per\\s?cent)`, 'i')
    : null;
  return pattern.test(text) || Boolean(asPercent && asPercent.test(text));
}

export function supersededFigures(profile, truth = {}, transcript = '') {
  const money = (value) => Number(value?.amount ?? NaN);
  const pension = (profile?.pensions || [])[0] || {};
  const incomes = profile?.incomeSources || [];
  const stale = [
    ['intendedRetirementAge', truth.intendedRetirementAge,
      profile?.primaryPerson?.intendedRetirementAge],
    ['employeeRate', truth.employeeRate, pension.employeeContributionRate],
    ['employerRate', truth.employerRate, pension.employerContributionRate],
    ['pensionValue', truth.pensionValue, money(pension.currentValue)]
  ].filter(([, stated, captured]) => {
    // Both sides must exist: a figure the persona never states cannot be stale,
    // and one the conversation never reached is missing rather than superseded
    // — module_critical_capture reports that.
    if (!Number.isFinite(stated) || !Number.isFinite(Number(captured))) return false;
    if (Number(captured) === stated) return false;
    // AND THE CLIENT MUST ACTUALLY HAVE SAID THE FIGURE. A synthetic client
    // that says "around €300,000" and never corrects it has not superseded
    // anything: the lane captured what was said and the module used it. Scoring
    // that as a lost correction reports a persona wandering off its brief as a
    // product failure — a paid run was flagged exactly this way.
    return spokenInTranscript(stated, transcript);
  }).map(([name]) => name);

  if (Number.isFinite(truth.grossAnnual) && incomes.length > 0
    && !incomes.some((item) => money(item.grossAnnual) === truth.grossAnnual)) {
    stale.push('grossAnnual');
  }
  return stale;
}
