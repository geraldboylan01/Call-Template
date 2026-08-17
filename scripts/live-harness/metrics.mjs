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
