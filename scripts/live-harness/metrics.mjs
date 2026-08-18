/**
 * RUN METRICS THAT CAN BE TESTED WITHOUT PAYING FOR A CONVERSATION.
 *
 * These live outside `run-live-call.mjs` because that file starts a meeting at
 * import time, so nothing can import it to check its arithmetic. A metric that
 * cannot be tested is a metric that quietly drifts — and three of them already
 * had, each reporting a failure that had not happened.
 *
 * EVERY METRIC HERE IS DRIVEN BY THE PERSONA, NOT BY A MODULE NAME. The first
 * version asked whether `pension_projection` appeared in the results and read a
 * chart dataset called "Pot (current)". A perfectly good mortgage run scored
 * moduleCompleted=false on that test, and every criterion downstream of it
 * failed too — a page of failures that meant nothing. What a run should be
 * judged against is what its persona said would happen.
 */

import { POSITION_PROJECTIONS } from '../../js/planning/reconciliation.js';

/** Collections that have an owner at all. Dependants are household members. */
const OWNED_COLLECTIONS = Object.freeze([...new Set(
  Object.values(POSITION_PROJECTIONS)
    .filter((projection) => projection.ownerKey)
    .map((projection) => projection.collection)
)]);

/** Read a `/a/0/b` pointer out of a profile. Missing anything yields undefined. */
function readPath(profile, path) {
  return String(path || '').split('/').filter(Boolean).reduce((node, key) => {
    if (node === null || typeof node !== 'object') return undefined;
    return node[Array.isArray(node) ? Number(key) : key];
  }, profile);
}

/** Every owner id on a record, whichever shape the collection uses. */
function ownersOf(record, projection) {
  if (!projection.ownerKey) return [];
  const value = record?.[projection.ownerKey];
  return Array.isArray(value) ? value : [value].filter(Boolean);
}

function projectionForCollection(collection) {
  return Object.values(POSITION_PROJECTIONS).find((item) => item.collection === collection);
}

/**
 * Did this run own things correctly — and was there anything to judge?
 *
 * THREE STATES, BECAUSE "WRONG" AND "NEVER CAME UP" ARE DIFFERENT SEVERITIES.
 * An early batch reported four ownership failures; three were runs where the
 * synthetic client never mentioned their partner, so the profile had none and a
 * long `&&` called that incorrect ownership. Zero of the four had a holding in
 * the wrong name — the failure the metric exists to catch, because it is the
 * one that would feed a module someone else's money.
 *
 *   false — a holding in the wrong name, or a captured age that contradicts
 *           what the client said.
 *   null  — nothing to judge: no household, or an age the persona states that
 *           the conversation never reached.
 *   true  — everything the persona stated was established and correctly owned.
 *
 * `truth.owners` names the expected owner per collection ('primary', 'partner',
 * 'joint', or an explicit id); anything unnamed defaults to the primary client.
 * 'joint' accepts either partner, because a jointly held thing legitimately
 * carries both.
 */
export function ownershipVerdict(profile, truth = {}) {
  const primaryId = profile?.primaryPerson?.personId;
  const partnerId = profile?.partner?.personId;
  const age = (person) => Number(person?.age);
  const expectedOwners = truth.owners || {};

  const allowedFor = (collection) => {
    const declared = expectedOwners[collection] || 'primary';
    if (declared === 'joint') return [primaryId, partnerId].filter(Boolean);
    if (declared === 'partner') return [partnerId].filter(Boolean);
    if (declared === 'primary') return [primaryId].filter(Boolean);
    return [declared];
  };

  const misowned = OWNED_COLLECTIONS.some((collection) => {
    const records = profile?.[collection] || [];
    if (!records.length) return false;
    const projection = projectionForCollection(collection);
    const allowed = allowedFor(collection);
    if (!allowed.length) return false;
    return records.some((record) => {
      const owners = ownersOf(record, projection);
      // A record with no owner recorded is INCOMPLETE, not misowned — the
      // capture metrics report that. Only a named, wrong owner is wrong.
      if (!owners.length) return false;
      return !owners.every((owner) => allowed.includes(owner));
    });
  });

  // Both sides must exist for an age mismatch to mean anything: comparing a
  // captured age against a truth that states none reported every such run wrong.
  const contradicts = (stated, captured) =>
    Number.isFinite(stated) && Number.isFinite(captured) && captured !== stated;

  if (misowned
    || contradicts(truth.primaryAge, age(profile?.primaryPerson))
    || contradicts(truth.partnerAge, age(profile?.partner))) {
    return false;
  }

  const unreached = (stated, captured) => Number.isFinite(stated) && !Number.isFinite(captured);
  const unresolved = !primaryId
    || unreached(truth.primaryAge, age(profile?.primaryPerson))
    || unreached(truth.partnerAge, age(profile?.partner));
  return unresolved ? null : true;
}

/**
 * Did the module calculate the right headline figure — and did one run at all?
 *
 * `false` used to mean both "calculated the wrong number" and "calculated
 * nothing", so a batch scoring this 2/5 could not say whether any client had
 * ever been given a wrong number, and every failure to reach a module was
 * counted twice.
 */
export function arithmeticVerdict(result, expected) {
  if (result === null || typeof result === 'undefined') return null;
  if (!Number.isFinite(Number(expected))) return null;
  return Number(result) === Number(expected);
}

/**
 * The headline number a module put in front of the client.
 *
 * Read by the DATASET LABEL the persona names, so a new module needs a persona
 * entry rather than a branch here. A persona that declares no headline gets no
 * arithmetic score — Phase 4 asks whether the right inputs reached the right
 * module, and inventing an approximate expected figure just to have something
 * to score would make that answer less trustworthy, not more.
 */
export function headlineFigure(moduleResult, headline) {
  if (!moduleResult || !headline?.datasetLabel) return null;
  const chart = (moduleResult.charts || []).find((item) => Array.isArray(item.datasets)
    && item.datasets.some((set) => set.label === headline.datasetLabel));
  const dataset = chart?.datasets.find((set) => set.label === headline.datasetLabel);
  const index = Number.isFinite(headline.index) ? headline.index : 0;
  return dataset?.data?.[index] ?? null;
}

/**
 * Which figures the client corrected are still canonical at their OLD value?
 *
 * COVER EVERY FIGURE THE PERSONA STATES, NOT TWO OF THEM. This checked the
 * retirement age and the gross income and nothing else. A paid run where the
 * client said "I pay in 7 percent" and then "sorry, 6 percent is right" ended
 * with 0.07 canonical, the module ran on it, and the batch reported
 * correction_superseded 3/3 — because contribution rates were not among the
 * figures it looked at. A metric that covers some of the corrections is worse
 * than none: it reports success over silent loss.
 *
 * The figures come from the persona as `{ name, path, expected }`, so a
 * mortgage rate or a college contribution is scored by the same code that
 * scores a pension pot.
 */
export function supersededFigures(profile, truth = {}, transcript = '') {
  return (truth.figures || [])
    .filter(({ path, expected }) => {
      const captured = Number(unwrapAmount(readPath(profile, path)));
      // Both sides must exist: a figure the persona never states cannot be
      // stale, and one the conversation never reached is missing rather than
      // superseded — module_critical_capture reports that.
      if (!Number.isFinite(expected) || !Number.isFinite(captured)) return false;
      if (numbersMatch(captured, expected)) return false;
      // AND THE CLIENT MUST ACTUALLY HAVE SAID IT. A synthetic client that says
      // "around €300,000" and never corrects it has not superseded anything:
      // the lane captured what was said and the module used it. Scoring that as
      // a lost correction reports a persona wandering off its brief as a
      // product defect — a paid run was flagged exactly this way.
      return spokenInTranscript(expected, transcript);
    })
    .map(({ name, path }) => name || path);
}

/**
 * Equal to any meaningful precision.
 *
 * A mortgage rate stated as "4.1 percent" is stored as 0.040999999999999995,
 * and a strict comparison called that a lost correction — a metric defect
 * reported as a product one. Compared relatively so a money amount and a rate
 * can use the same test.
 */
function numbersMatch(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) <= scale * 1e-9;
}

/** Money objects and bare numbers both arrive here. */
function unwrapAmount(value) {
  if (value && typeof value === 'object' && 'amount' in value) return value.amount;
  return value;
}

/** 0.041 -> "4.1", without the floating-point tail that 0.041 * 100 leaves. */
function percentString(value) {
  return String(Number((Number(value) * 100).toFixed(6)));
}

function escapeForRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Did the client actually say this figure, in digits, grouped, or as a rate? */
function spokenInTranscript(value, transcript) {
  const text = String(transcript || '');
  if (!text) return true; // No transcript supplied: fall back to the comparison.
  const plain = String(value);
  const grouped = Number(value).toLocaleString('en-US');
  const pattern = new RegExp(
    `(?<![\\d.,])(?:${plain}|${grouped.replace(/,/g, '[,.\\s]?')})(?![\\d.,]*\\d)`
  );
  // RATES ARE SPOKEN AS PERCENTAGES, AND THEY HAVE DECIMALS. 0.06 canonical is
  // "6 percent" spoken and 0.041 is "4.1 percent" — rounding to a whole number
  // matched neither, because "4" cannot match inside "4.1".
  const asPercent = Number(value) > 0 && Number(value) < 1
    ? new RegExp(
      `(?<![\\d.,])${escapeForRegex(percentString(value))}(?![\\d.,]*\\d)\\s*(?:%|per\\s?cent)?`,
      'i'
    )
    : null;
  return pattern.test(text) || Boolean(asPercent && asPercent.test(text));
}

/**
 * Positions that exist in canonical state beyond what the client actually has.
 *
 * The failure this catches is an AGGREGATE BECOMING A HOLDING: "about 500k
 * between us" recorded as a position, a household total recorded per person, or
 * two children arriving as three dependants. Counted per collection from the
 * persona's declared counts, so it reads a duplicated liability exactly as it
 * reads a duplicated pension.
 */
export function extraPositions(profile, truth = {}) {
  const expected = truth.expectedCounts || {};
  return Object.entries(expected).reduce((total, [collection, count]) => (
    total + Math.max(0, (profile?.[collection] || []).length - count)
  ), 0);
}

/**
 * Figures in canonical state that the persona never said, plus extra positions.
 *
 * A canonical figure the client never gave is the most serious capture defect
 * short of a wrong owner, because nothing downstream can tell it from a real one.
 */
export function falsePositiveFigures(profile, truth = {}) {
  const wrongValued = (truth.figures || []).filter(({ path, expected }) => {
    const captured = Number(unwrapAmount(readPath(profile, path)));
    return Number.isFinite(expected) && Number.isFinite(captured) && !numbersMatch(captured, expected);
  }).length;
  return extraPositions(profile, truth) + wrongValued;
}
