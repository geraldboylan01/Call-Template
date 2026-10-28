/**
 * Protection gap: if one income stopped, how big is the hole, and how long
 * would savings fill it?
 *
 * A household with up to two incomes states what it needs each year, what each
 * person brings home, and what it has in savings. Each case changes ONE thing:
 * a person cannot work, or a person dies. The engine says what comes in after
 * that, how far it falls short of what is needed, and how many months savings
 * would fill the gap.
 *
 * THE MODEL
 *
 *   floor     = the State payment (cannotWork) or survivor's pension (dies)
 *   moneyIn   = floor + the take-home of everyone whose income has not stopped
 *   needed    = the case's neededAfter when it states one, else the household's
 *   gap       = max(0, needed - moneyIn)        spare = max(0, moneyIn - needed)
 *   months    = savings / (gap / 12), to the nearest whole month
 *   beyond    = the unrounded months reach 36
 *
 * Savings fill ONLY the gap, with no interest and no inflation, and the gap is
 * constant. A case states what CHANGES, never the result.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No tax rule and no State rate. A case either states its take-home and State
 * payment (the `people[].takeHome` and event amounts), or carries an `income`
 * block that a caller upstream built from the shared tax engine and the figures
 * register: recalculated take-home for each person and the State payment kept
 * separate, with the calculation year, the versions and the basis. This module
 * only checks that block adds up; it never calculates tax or looks up a rate.
 *
 * TIME
 *
 * A case's money in can change over time: an `income` block may have a second
 * phase (a State payment counted for a stated number of months, then not at
 * all), and a stated payment may run for a number of months. Savings fill the
 * gap month by month through those changes, so a payment is never extended
 * past the time it was given for. A case with neither is one constant gap, as
 * before, and its answer is unchanged.
 *
 * MONEY RECEIVED
 *
 * What a person has told us they would receive (a lump sum paid on death, a
 * regular payment while they cannot work) is counted as money received: a lump
 * sum joins the savings in that case, a regular payment is money in for the
 * months stated. It is never a cover amount needed, a gap against cover, a
 * premium, a product or a provider.
 *
 * THE HARD LIMIT
 *
 * This screen shows the gap and the time. It never shows a cover amount, a
 * premium or a product, so a payload that carries one is refused at every
 * level rather than ignored.
 *
 * The engine owns every client-facing string (case titles, the two-line answer,
 * the sentence, the footnote) so the screen, the video and any summary read the
 * same words. The client is "you"; people are named.
 */

import { MAX_MODULE_SCENARIO_CASES } from './scenario_cap.js';

const FIELD = 'generated.protectionGapInputs';

/** The strip shows this many months. Savings that last this long or more are "beyond". */
export const PROTECTION_GAP_HORIZON_MONTHS = 36;

const MAX_PEOPLE = 2;
const MAX_HOUSEHOLD_LABEL_LENGTH = 60;
const MAX_PERSON_LABEL_LENGTH = 24;
const MAX_TITLE_LENGTH = 40;
const SCALE_STEP_EUR = 10_000;
const SCALE_HEADROOM_PERCENT = 105;

const INPUT_FIELDS = Object.freeze(['householdLabel', 'people', 'needed', 'savings', 'baseScenarioId', 'scenarios']);
const PERSON_FIELDS = Object.freeze(['id', 'label', 'takeHome']);
const CASE_FIELDS = Object.freeze(['id', 'title', 'description', 'event', 'income', 'received']);
const INCOME_FIELDS = Object.freeze(['basis', 'calculationYear', 'versions', 'creditAllocation', 'phases']);
const INCOME_BASES = Object.freeze(['stated', 'estimated']);
const CREDIT_ALLOCATIONS = Object.freeze(['own', 'allocated']);
const VERSION_FIELDS = Object.freeze(['taxRules', 'assumptions', 'socialWelfare']);
const PHASE_FIELDS = Object.freeze(['months', 'takeHome', 'statePayment', 'householdNetIncome']);
const STATE_PAYMENT_FIELDS = Object.freeze(['personId', 'scheme', 'amount', 'grossAmount', 'estimatedTax', 'weeklyRate', 'weeks', 'figure']);
const STATE_PAYMENT_SCHEMES = Object.freeze(['illnessBenefit', 'bereavedPartnerPension', 'stated']);
const FIGURE_FIELDS = Object.freeze(['id', 'effectiveFrom', 'status', 'checkedOn', 'catalogueVersion', 'sourceUrl']);
const RECEIVED_FIELDS = Object.freeze({
  lumpSum: Object.freeze(['type', 'amount']),
  regularPayment: Object.freeze(['type', 'amount', 'months', 'afterMonths'])
});
const MAX_RECEIVED = 3;
const MAX_PHASE_MONTHS = 120;
/** The most euros a phase's parts may differ from the household net income they should add up to. */
const RECONCILE_TOLERANCE_EUR = 1;
const EVENT_TYPES = Object.freeze(['cannotWork', 'dies']);
const EVENT_FIELDS = Object.freeze({
  cannotWork: Object.freeze(['type', 'personId', 'statePayment']),
  dies: Object.freeze(['type', 'personId', 'survivorsPension', 'neededAfter', 'neededBecause'])
});
const NEEDED_BECAUSE_CODES = Object.freeze(['mortgageCleared', 'livingCostsLower']);

/** These are calculated. A payload that states one is refused. */
const DERIVED_FIELDS = Object.freeze(['gap', 'months', 'spare', 'leftOver']);

/** The hard limit: a key that is, or contains, any of these is refused at every level. */
const FORBIDDEN_KEY_PATTERN = /cover|premium|policy|product|provider|insurer|quote/i;

/**
 * Words that may never be on this screen: no recommendation, no cover,
 * premium, policy or insurance wording, no gendered pronoun, no third person,
 * and no provider. The view's own scan uses these, and so does the input check,
 * because a case title or the household line is shown as given.
 */
export const PROTECTION_GAP_BANNED_PHRASES = Object.freeze([
  /\bwe recommend\b/i,
  /\byou should\b/i,
  /\bbest option\b/i,
  /\bbest\b/i,
  /\bideal\b/i,
  /\boptimal\b/i,
  /\bp\.a\./i,
  /\bcover(s|ed|ing|age)?\b/i,
  /premium/i,
  /\bpolic(y|ies)\b/i,
  /insur/i,
  /\bquote/i,
  /income protection/i,
  /serious illness/i,
  /\b(he|she|his|her|hers|him)\b/i,
  /the household/i,
  /the client/i
]);

export const PROTECTION_GAP_PROVIDER_NAMES = Object.freeze([
  /\bbank of ireland\b/i,
  /\baib\b/i,
  /\bptsb\b/i,
  /\bpermanent tsb\b/i,
  /\brevolut\b/i,
  /\bzurich\b/i,
  /\birish life\b/i,
  /\bdavy\b/i
]);

/** The first banned pattern a piece of client-facing text matches, or null. */
function wordingProblem(text) {
  return [...PROTECTION_GAP_BANNED_PHRASES, ...PROTECTION_GAP_PROVIDER_NAMES].find((candidate) => candidate.test(text)) || null;
}

/** Refuse client-facing text this screen may not show. */
function refuseForbiddenWording(text, path) {
  const pattern = wordingProblem(text);
  if (pattern) {
    throw new Error(`${FIELD}.${path} ("${text}"): this screen shows the gap and the time, never a recommendation, a cover amount, a premium, a product or a provider, and never says "he", "she" or "the household".`);
  }
}


const ID_PATTERN = /^[a-z0-9_-]+$/;

/** What the screen says when every figure is stated. */
const FOOTNOTE = 'Amounts are a year. Your savings are used only to fill the gap, with no interest or inflation. '
  + 'State payments are as given and depend on eligibility. '
  + 'When one income stops, the other person’s tax can change, so your take-home may differ from what is shown.';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function has(raw, key) {
  return Object.prototype.hasOwnProperty.call(raw, key) && typeof raw[key] !== 'undefined';
}

function isWholeEuros(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** `€96,000`: whole euros with thousands separators. The screen uses the same one. */
export function euroText(amount) {
  return `€${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function monthsText(count) {
  return `${count} ${count === 1 ? 'month' : 'months'}`;
}

function fieldPath(path, key) {
  return path ? `${FIELD}.${path}.${key}` : `${FIELD}.${key}`;
}

/** The hard limit and the calculated fields come before anything else is said about a key. */
function refuseForbiddenAndDerived(raw, path, allowedDerived = []) {
  Object.keys(raw).forEach((key) => {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new Error(
        `${fieldPath(path, key)}: this screen shows the gap and the time, never a cover amount, a premium or a product.`
      );
    }
  });
  Object.keys(raw).forEach((key) => {
    if (DERIVED_FIELDS.includes(key) && !allowedDerived.includes(key)) {
      throw new Error(`${fieldPath(path, key)} is not accepted. It is calculated.`);
    }
  });
}

function refuseUnknown(raw, allowed, path, name) {
  Object.keys(raw).forEach((key) => {
    if (!allowed.includes(key)) {
      const where = path ? `${FIELD}.${path}` : FIELD;
      throw new Error(`${where}${name ? ` (${name})` : ''}: "${key}" is not a field.`);
    }
  });
}

function normalizePeople(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PEOPLE) {
    throw new Error(`${FIELD}.people must list 1 or 2 people.`);
  }
  const seen = new Set();
  return raw.map((person, index) => {
    const path = `people[${index}]`;
    if (!isPlainObject(person)) {
      throw new Error(`${FIELD}.${path} must be an object.`);
    }
    refuseForbiddenAndDerived(person, path);
    refuseUnknown(person, PERSON_FIELDS, path);

    const id = typeof person.id === 'string' ? person.id.trim() : '';
    if (!id || !ID_PATTERN.test(id)) {
      throw new Error(`${FIELD}.${path}.id must be lower case letters, numbers, "-" or "_".`);
    }
    if (seen.has(id)) {
      throw new Error(`${FIELD}.${path}.id must be unique.`);
    }
    seen.add(id);

    const label = typeof person.label === 'string' ? person.label.trim() : '';
    if (label.length < 1 || label.length > MAX_PERSON_LABEL_LENGTH) {
      throw new Error(`${FIELD}.${path}.label must be 1 to ${MAX_PERSON_LABEL_LENGTH} characters.`);
    }
    // A name is shown in the sentence and the summary, so it is held to the same limit.
    if (wordingProblem(label)) {
      throw new Error(`${FIELD}.${path}.label ("${label}"): a name is shown on this screen, so it is held to the same wording limit (no provider, product, "he" or "she"). If it is the person's own name, use another form of it.`);
    }
    if (!isWholeEuros(person.takeHome)) {
      throw new Error(`${FIELD}.${path}.takeHome must be a whole number of euros.`);
    }
    return { id, label, takeHome: person.takeHome };
  });
}

/** The title a case gets when the payload gives none. */
function derivedCaseTitle(event, person) {
  if (!event) {
    return 'Today';
  }
  return event.type === 'dies' ? `If ${person.label} died` : `${person.label} cannot work`;
}

function normalizeEvent(rawEvent, { path, rawTitle, id, people, neededToday, hasIncome = false }) {
  const eventPath = `${path}.event`;
  const nameForErrors = rawTitle || id;

  if (Array.isArray(rawEvent)) {
    throw new Error(`${FIELD}.${path} (${nameForErrors}): a case takes one event.`);
  }
  if (!isPlainObject(rawEvent)) {
    throw new Error(`${FIELD}.${eventPath} must be an object.`);
  }
  refuseForbiddenAndDerived(rawEvent, eventPath);
  if (!EVENT_TYPES.includes(rawEvent.type)) {
    throw new Error(`${FIELD}.${eventPath}.type must be "cannotWork" or "dies".`);
  }
  refuseUnknown(rawEvent, EVENT_FIELDS[rawEvent.type], eventPath, nameForErrors);

  const personId = typeof rawEvent.personId === 'string' ? rawEvent.personId.trim() : '';
  const person = people.find((entry) => entry.id === personId);
  if (!person) {
    throw new Error(`${FIELD}.${path} (${nameForErrors}): personId "${personId}" is not one of the people.`);
  }

  const title = rawTitle || derivedCaseTitle({ type: rawEvent.type }, person);
  const where = `${FIELD}.${path} (${title})`;

  if (rawEvent.type === 'dies' && people.length !== 2) {
    throw new Error(`${where}: needs two people in the household.`);
  }
  if (person.takeHome <= 0) {
    throw new Error(`${where}: personId "${person.id}" has no take-home to stop.`);
  }

  if (rawEvent.type === 'cannotWork') {
    if (hasIncome) {
      if (has(rawEvent, 'statePayment')) {
        throw new Error(`${where}: the State payment is given in income.phases[].statePayment; do not give it in the event as well.`);
      }
      return { event: { type: 'cannotWork', personId: person.id }, person, title };
    }
    if (!isWholeEuros(rawEvent.statePayment)) {
      throw new Error(`${where}: statePayment must be a whole number of euros, 0 or more.`);
    }
    return { event: { type: 'cannotWork', personId: person.id, statePayment: rawEvent.statePayment }, person, title };
  }

  if (hasIncome) {
    if (has(rawEvent, 'survivorsPension')) {
      throw new Error(`${where}: the survivor’s pension is given in income.phases[].statePayment; do not give it in the event as well.`);
    }
  } else if (!isWholeEuros(rawEvent.survivorsPension)) {
    throw new Error(`${where}: survivorsPension must be a whole number of euros, 0 or more.`);
  }

  const hasNeededAfter = has(rawEvent, 'neededAfter');
  const hasReasons = has(rawEvent, 'neededBecause');
  if (hasNeededAfter && (!isWholeEuros(rawEvent.neededAfter) || rawEvent.neededAfter <= 0)) {
    throw new Error(`${where}: neededAfter must be a whole number of euros greater than 0.`);
  }

  let reasons = [];
  if (hasReasons) {
    if (!Array.isArray(rawEvent.neededBecause)) {
      throw new Error(`${where}: neededBecause must be a list of reasons.`);
    }
    rawEvent.neededBecause.forEach((code) => {
      if (!NEEDED_BECAUSE_CODES.includes(code)) {
        throw new Error(`${where}: neededBecause "${code}" is not one of ${NEEDED_BECAUSE_CODES.join(', ')}.`);
      }
    });
    // Canonical order, no repeats, so normalising twice changes nothing.
    reasons = NEEDED_BECAUSE_CODES.filter((code) => rawEvent.neededBecause.includes(code));
  }
  if (hasReasons && reasons.length > 0 && !hasNeededAfter) {
    throw new Error(`${where}: neededBecause needs neededAfter.`);
  }
  if (hasNeededAfter && rawEvent.neededAfter > neededToday) {
    throw new Error(`${where}: a higher need after a death is not drawn yet.`);
  }

  const event = hasIncome
    ? { type: 'dies', personId: person.id }
    : { type: 'dies', personId: person.id, survivorsPension: rawEvent.survivorsPension };
  // A need that has not changed is the same as none stated, so the reason is dropped with it.
  if (hasNeededAfter && rawEvent.neededAfter < neededToday) {
    event.neededAfter = rawEvent.neededAfter;
    if (reasons.length > 0) {
      event.neededBecause = reasons;
    }
  }
  return { event, person, title };
}


function wholeEuroField(value, where, name, { positive = false } = {}) {
  if (!isWholeEuros(value) || (positive && value <= 0)) {
    throw new Error(`${where}: ${name} must be a whole number of euros${positive ? ' greater than 0' : ', 0 or more'}.`);
  }
  return value;
}

function wholeMonthsField(value, where, name, { min }) {
  if (!Number.isInteger(value) || value < min || value > MAX_PHASE_MONTHS) {
    throw new Error(`${where}: ${name} must be a whole number of months from ${min} to ${MAX_PHASE_MONTHS}.`);
  }
  return value;
}

function normalizeStatePayment(raw, { where, path, people, event }) {
  if (!isPlainObject(raw)) {
    throw new Error(`${where}: statePayment must be an object.`);
  }
  refuseForbiddenAndDerived(raw, path);
  refuseUnknown(raw, STATE_PAYMENT_FIELDS, path);
  const personId = typeof raw.personId === 'string' ? raw.personId.trim() : '';
  if (!people.some((person) => person.id === personId)) {
    throw new Error(`${where}: statePayment.personId "${personId}" is not one of the people.`);
  }
  if (event && event.type === 'cannotWork' && personId !== event.personId) {
    throw new Error(`${where}: the State payment is paid to the person who cannot work.`);
  }
  if (event && event.type === 'dies' && personId === event.personId) {
    throw new Error(`${where}: the survivor’s pension is paid to the person who is left.`);
  }
  if (!STATE_PAYMENT_SCHEMES.includes(raw.scheme)) {
    throw new Error(`${where}: statePayment.scheme must be one of ${STATE_PAYMENT_SCHEMES.join(', ')}.`);
  }
  const amount = wholeEuroField(raw.amount, where, 'statePayment.amount');
  const out = { personId, scheme: raw.scheme, amount };
  if (raw.scheme === 'stated') {
    ['grossAmount', 'estimatedTax', 'weeklyRate', 'weeks', 'figure'].forEach((key) => {
      if (has(raw, key)) {
        throw new Error(`${where}: a stated State payment is given as it is; statePayment.${key} belongs to an estimated one.`);
      }
    });
    return out;
  }
  // A payment worked out from a rate: the gross figure and the tax estimated on it
  // are kept, so the amount shown can be traced back to both.
  out.grossAmount = wholeEuroField(raw.grossAmount, where, 'statePayment.grossAmount');
  out.estimatedTax = wholeEuroField(raw.estimatedTax, where, 'statePayment.estimatedTax');
  if (Math.abs(out.grossAmount - out.estimatedTax - amount) > RECONCILE_TOLERANCE_EUR) {
    throw new Error(`${where}: statePayment.amount (${amount}) is not the gross amount (${out.grossAmount}) less the estimated tax (${out.estimatedTax}).`);
  }
  if (has(raw, 'weeklyRate') || has(raw, 'weeks')) {
    if (typeof raw.weeklyRate !== 'number' || !Number.isFinite(raw.weeklyRate) || raw.weeklyRate < 0
      || !Number.isInteger(raw.weeks) || raw.weeks < 1 || raw.weeks > 52) {
      throw new Error(`${where}: statePayment.weeklyRate must be a number of euros and statePayment.weeks a whole number from 1 to 52.`);
    }
    if (Math.abs(raw.weeklyRate * raw.weeks - out.grossAmount) > RECONCILE_TOLERANCE_EUR) {
      throw new Error(`${where}: statePayment.grossAmount (${out.grossAmount}) is not the weekly rate (${raw.weeklyRate}) for ${raw.weeks} weeks.`);
    }
    out.weeklyRate = raw.weeklyRate;
    out.weeks = raw.weeks;
  }
  if (has(raw, 'figure')) {
    if (!isPlainObject(raw.figure)) {
      throw new Error(`${where}: statePayment.figure must be an object.`);
    }
    refuseForbiddenAndDerived(raw.figure, `${path}.figure`);
    refuseUnknown(raw.figure, FIGURE_FIELDS, `${path}.figure`);
    const figure = {};
    FIGURE_FIELDS.forEach((key) => {
      if (has(raw.figure, key)) {
        if (typeof raw.figure[key] !== 'string' || raw.figure[key].length < 1 || raw.figure[key].length > 200) {
          throw new Error(`${where}: statePayment.figure.${key} must be text of up to 200 characters.`);
        }
        figure[key] = raw.figure[key];
      }
    });
    out.figure = figure;
  }
  return out;
}

/**
 * A case's `income` block: the recalculated take-home for each person and the
 * State payment kept apart, for one calculation year, with the versions of what
 * it was calculated from and the basis. Each phase is one full calculation of
 * the whole household, so a phase after the State payment ends is its own
 * figures, not the first phase carried on.
 */
function normalizeIncome(raw, { path, where, people, event }) {
  const incomePath = `${path}.income`;
  const at = `${FIELD}.${incomePath}`;
  if (!isPlainObject(raw)) {
    throw new Error(`${at} must be an object.`);
  }
  refuseForbiddenAndDerived(raw, incomePath);
  refuseUnknown(raw, INCOME_FIELDS, incomePath, where);

  if (!INCOME_BASES.includes(raw.basis)) {
    throw new Error(`${where}: income.basis must be "stated" or "estimated".`);
  }
  if (!Number.isInteger(raw.calculationYear) || raw.calculationYear < 2000 || raw.calculationYear > 2100) {
    throw new Error(`${where}: income.calculationYear must be a whole year.`);
  }
  const creditAllocation = has(raw, 'creditAllocation') ? raw.creditAllocation : 'own';
  if (!CREDIT_ALLOCATIONS.includes(creditAllocation)) {
    throw new Error(`${where}: income.creditAllocation must be "own" or "allocated".`);
  }

  const versions = {};
  if (has(raw, 'versions')) {
    if (!isPlainObject(raw.versions)) {
      throw new Error(`${where}: income.versions must be an object.`);
    }
    refuseForbiddenAndDerived(raw.versions, `${incomePath}.versions`);
    refuseUnknown(raw.versions, VERSION_FIELDS, `${incomePath}.versions`);
    VERSION_FIELDS.forEach((key) => {
      if (has(raw.versions, key)) {
        if (typeof raw.versions[key] !== 'string' || raw.versions[key].length < 1 || raw.versions[key].length > 80) {
          throw new Error(`${where}: income.versions.${key} must be text of up to 80 characters.`);
        }
        versions[key] = raw.versions[key];
      }
    });
  }
  if (raw.basis === 'estimated' && !has(versions, 'taxRules')) {
    throw new Error(`${where}: an estimated income needs income.versions.taxRules, the version of the tax rules it was calculated with.`);
  }

  if (!Array.isArray(raw.phases) || raw.phases.length < 1 || raw.phases.length > 2) {
    throw new Error(`${where}: income.phases must list 1 or 2 phases.`);
  }
  const phases = raw.phases.map((rawPhase, index) => {
    const phasePath = `${incomePath}.phases[${index}]`;
    const here = `${where}: income.phases[${index}]`;
    if (!isPlainObject(rawPhase)) {
      throw new Error(`${here} must be an object.`);
    }
    refuseForbiddenAndDerived(rawPhase, phasePath, ['months']);
    refuseUnknown(rawPhase, PHASE_FIELDS, phasePath);

    const last = index === raw.phases.length - 1;
    let months = null;
    if (!last) {
      months = wholeMonthsField(rawPhase.months, here, 'months', { min: 1 });
    } else if (has(rawPhase, 'months') && rawPhase.months !== null) {
      throw new Error(`${here}: the last phase carries on, so it has no months.`);
    }

    if (!isPlainObject(rawPhase.takeHome)) {
      throw new Error(`${here}: takeHome must give each person’s take-home.`);
    }
    refuseForbiddenAndDerived(rawPhase.takeHome, `${phasePath}.takeHome`);
    Object.keys(rawPhase.takeHome).forEach((key) => {
      if (!people.some((person) => person.id === key)) {
        throw new Error(`${here}: takeHome "${key}" is not one of the people.`);
      }
    });
    const takeHome = {};
    people.forEach((person) => {
      if (!has(rawPhase.takeHome, person.id)) {
        throw new Error(`${here}: takeHome needs ${person.id}.`);
      }
      takeHome[person.id] = wholeEuroField(rawPhase.takeHome[person.id], here, `takeHome.${person.id}`);
    });
    if (event && takeHome[event.personId] !== 0) {
      throw new Error(`${here}: takeHome.${event.personId} must be 0, because that take-home stops in this case.`);
    }

    let statePayment = null;
    if (has(rawPhase, 'statePayment') && rawPhase.statePayment !== null) {
      if (!event) {
        throw new Error(`${here}: a case with no event has no State payment.`);
      }
      statePayment = normalizeStatePayment(rawPhase.statePayment, { where: here, path: `${phasePath}.statePayment`, people, event });
    }

    const phase = { months, takeHome, statePayment };
    if (has(rawPhase, 'householdNetIncome')) {
      phase.householdNetIncome = wholeEuroField(rawPhase.householdNetIncome, here, 'householdNetIncome');
      const parts = Object.values(takeHome).reduce((total, value) => total + value, 0) + (statePayment ? statePayment.amount : 0);
      if (Math.abs(parts - phase.householdNetIncome) > RECONCILE_TOLERANCE_EUR) {
        throw new Error(`${here}: the take-home and the State payment add up to ${parts}, but the household’s net income is ${phase.householdNetIncome}. They must reconcile.`);
      }
    } else if (raw.basis === 'estimated') {
      throw new Error(`${here}: an estimated income needs householdNetIncome from the shared tax engine, so its parts can be checked against it.`);
    }
    return phase;
  });

  return { basis: raw.basis, calculationYear: raw.calculationYear, versions, creditAllocation, phases };
}

/** Money a person has told us they would receive in this case. */
function normalizeReceived(raw, { path, where, event }) {
  const at = `${path}.received`;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RECEIVED) {
    throw new Error(`${where}: received must list 1 to ${MAX_RECEIVED} payments.`);
  }
  if (!event) {
    throw new Error(`${where}: money received belongs to a case with an event.`);
  }
  return raw.map((entry, index) => {
    const entryPath = `${at}[${index}]`;
    const here = `${where}: received[${index}]`;
    if (!isPlainObject(entry)) {
      throw new Error(`${here} must be an object.`);
    }
    refuseForbiddenAndDerived(entry, entryPath, ['months']);
    if (!Object.keys(RECEIVED_FIELDS).includes(entry.type)) {
      throw new Error(`${here}: type must be "lumpSum" or "regularPayment".`);
    }
    refuseUnknown(entry, RECEIVED_FIELDS[entry.type], entryPath, where);
    if (entry.type === 'lumpSum') {
      if (event.type !== 'dies') {
        throw new Error(`${here}: a lump sum is money paid on a death.`);
      }
      return { type: 'lumpSum', amount: wholeEuroField(entry.amount, here, 'amount', { positive: true }) };
    }
    if (event.type !== 'cannotWork') {
      throw new Error(`${here}: a regular payment is money paid while someone cannot work.`);
    }
    const out = {
      type: 'regularPayment',
      amount: wholeEuroField(entry.amount, here, 'amount', { positive: true }),
      months: wholeMonthsField(entry.months, here, 'months', { min: 1 })
    };
    if (has(entry, 'afterMonths')) {
      const after = wholeMonthsField(entry.afterMonths, here, 'afterMonths', { min: 0 });
      if (after > 0) out.afterMonths = after;
    }
    return out;
  });
}

function normalizeCase(rawCase, index, people, neededToday) {
  const path = `scenarios[${index}]`;
  if (!isPlainObject(rawCase)) {
    throw new Error(`${FIELD}.${path} must be an object.`);
  }
  refuseForbiddenAndDerived(rawCase, path);

  if (typeof rawCase.id !== 'string' || rawCase.id.trim() === '') {
    throw new Error(`${FIELD}.${path}.id must be a non-empty string.`);
  }
  const id = rawCase.id.trim();

  let rawTitle = '';
  if (has(rawCase, 'title')) {
    rawTitle = typeof rawCase.title === 'string' ? rawCase.title.trim() : '';
    if (rawTitle.length < 1 || rawTitle.length > MAX_TITLE_LENGTH) {
      throw new Error(`${FIELD}.${path}.title must be 1 to ${MAX_TITLE_LENGTH} characters.`);
    }
  }
  refuseUnknown(rawCase, CASE_FIELDS, path, rawTitle || id);
  if (rawTitle) refuseForbiddenWording(rawTitle, `${path}.title`);

  const description = typeof rawCase.description === 'string' ? rawCase.description.trim() : '';
  if (description) refuseForbiddenWording(description, `${path}.description`);

  const hasIncome = has(rawCase, 'income');
  if (!has(rawCase, 'event')) {
    const title = rawTitle || derivedCaseTitle(null, null);
    if (has(rawCase, 'received')) {
      throw new Error(`${FIELD}.${path} (${title}): money received belongs to a case with an event.`);
    }
    const normalized = { id, title, description };
    if (hasIncome) {
      normalized.income = normalizeIncome(rawCase.income, { path, where: `${FIELD}.${path} (${title})`, people, event: null });
    }
    return normalized;
  }
  const { event, title } = normalizeEvent(rawCase.event, { path, rawTitle, id, people, neededToday, hasIncome });
  const normalized = { id, title, description, event };
  const where = `${FIELD}.${path} (${title})`;
  if (hasIncome) {
    normalized.income = normalizeIncome(rawCase.income, { path, where, people, event });
    const paidTo = normalized.income.phases.map((phase) => phase.statePayment).filter(Boolean);
    if (event.type === 'cannotWork' && paidTo.length === 0) {
      throw new Error(`${where}: income needs the State payment in its first phase, even when it is 0.`);
    }
    if (event.type === 'dies' && !normalized.income.phases[0].statePayment) {
      throw new Error(`${where}: income needs the survivor’s pension in its first phase, even when it is 0.`);
    }
  }
  if (has(rawCase, 'received')) {
    normalized.received = normalizeReceived(rawCase.received, { path, where, event });
  }
  return normalized;
}

/**
 * Validate a payload and return it in canonical form.
 *
 * Idempotent: normalising a normalised payload returns an equal one.
 */
export function normalizeProtectionGapInputs(raw) {
  if (!isPlainObject(raw)) {
    throw new Error(`${FIELD} must be an object.`);
  }
  refuseForbiddenAndDerived(raw, '');
  refuseUnknown(raw, INPUT_FIELDS, '');

  let householdLabel;
  if (has(raw, 'householdLabel')) {
    householdLabel = typeof raw.householdLabel === 'string' ? raw.householdLabel.trim() : '';
    if (householdLabel.length < 1 || householdLabel.length > MAX_HOUSEHOLD_LABEL_LENGTH) {
      throw new Error(`${FIELD}.householdLabel must be 1 to ${MAX_HOUSEHOLD_LABEL_LENGTH} characters.`);
    }
    refuseForbiddenWording(householdLabel, 'householdLabel');
  }

  const people = normalizePeople(raw.people);

  if (!isWholeEuros(raw.needed) || raw.needed <= 0) {
    throw new Error(`${FIELD}.needed must be a whole number of euros greater than 0.`);
  }
  if (!isWholeEuros(raw.savings)) {
    throw new Error(`${FIELD}.savings must be a whole number of euros, 0 or more.`);
  }

  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) {
    throw new Error(`${FIELD}.scenarios must be an array with at least 1 case.`);
  }
  if (raw.scenarios.length > MAX_MODULE_SCENARIO_CASES) {
    throw new Error(
      `${FIELD}.scenarios supports at most ${MAX_MODULE_SCENARIO_CASES} cases; received ${raw.scenarios.length}.`
    );
  }

  const usedIds = new Set();
  const scenarios = raw.scenarios.map((rawCase, index) => {
    const normalized = normalizeCase(rawCase, index, people, raw.needed);
    if (usedIds.has(normalized.id)) {
      throw new Error(`${FIELD}.scenarios[${index}].id must be unique.`);
    }
    usedIds.add(normalized.id);
    return normalized;
  });

  let baseScenarioId = scenarios[0].id;
  if (has(raw, 'baseScenarioId')) {
    const requested = typeof raw.baseScenarioId === 'string' ? raw.baseScenarioId.trim() : '';
    if (!requested || !scenarios.some((scenario) => scenario.id === requested)) {
      throw new Error(`${FIELD}.baseScenarioId must match a case id.`);
    }
    baseScenarioId = requested;
  }
  // With other cases beside it, the base is today, the case every other is read
  // against, so it carries no event. A module of one case may show one event.
  const base = scenarios.find((scenario) => scenario.id === baseScenarioId);
  if (scenarios.length > 1 && base.event) {
    throw new Error(`${FIELD}.baseScenarioId (${base.title}): the base case is today, so it cannot have an event. Put the case with no event first, or name it as baseScenarioId.`);
  }

  const normalized = { people, needed: raw.needed, savings: raw.savings, baseScenarioId, scenarios };
  if (householdLabel) {
    normalized.householdLabel = householdLabel;
  }
  return normalized;
}

/** `[{ id, title, description }]`, for the presenter and the case buttons. */
export function getProtectionGapCases(rawInputs) {
  return normalizeProtectionGapInputs(rawInputs).scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    description: scenario.description
  }));
}

export function getDefaultProtectionGapScenarioId(rawInputs) {
  return normalizeProtectionGapInputs(rawInputs).baseScenarioId;
}

function reasonText(codes) {
  if (codes.length === 2) {
    return 'your mortgage is cleared and your living costs drop';
  }
  return codes[0] === 'mortgageCleared' ? 'your mortgage is cleared' : 'your living costs drop';
}

/** `a year`, `2 years`, `7 months`: how long something is counted for. */
function durationText(months) {
  if (months === 12) return 'a year';
  if (months % 12 === 0) return `${months / 12} years`;
  return monthsText(months);
}

const ILLNESS_BENEFIT_ASSUMPTION = 'Assumes the standard personal rate of Illness Benefit';
const BEREAVED_PENSION_ASSUMPTION = 'Assumes the standard personal rate of the Bereaved Partner’s (Contributory) Pension';

/**
 * The words a case adds when its State payment came from a rate, or when it
 * counts money the person told us about.
 */
function buildPaymentParts({ event, income, received, intervals }) {
  const first = income ? income.phases[0].statePayment : null;
  const estimated = Boolean(income && income.basis === 'estimated' && first && first.scheme !== 'stated');
  const assumption = !first ? '' : (first.scheme === 'illnessBenefit'
    ? `${ILLNESS_BENEFIT_ASSUMPTION}.`
    : (first.scheme === 'bereavedPartnerPension' ? `${BEREAVED_PENSION_ASSUMPTION}.` : ''));
  const shownAfterTax = estimated ? ', shown after estimated tax' : '';

  const receivedParts = [];
  (received || []).forEach((entry) => {
    if (entry.type === 'lumpSum') {
      receivedParts.push(`A lump sum of ${euroText(entry.amount)}, as you told us, is counted with your savings.`);
    } else {
      const from = entry.afterMonths ? ` from month ${entry.afterMonths + 1}` : '';
      receivedParts.push(`A payment of ${euroText(entry.amount)} a year, as you told us, is counted for ${monthsText(entry.months)}${from}.`);
    }
  });

  let later = '';
  if (event && intervals.length > 1) {
    const next = intervals[1];
    const what = next.ended.join(',');
    const lead = what === 'statePayment'
      ? 'the State payment is not counted'
      : (what === 'paid' ? 'the payment you told us about stops' : 'your income changes');
    const outcome = next.gap > 0
      ? `you would be ${euroText(next.gap)} a year short`
      : 'you would still have what you need';
    later = `After ${durationText(next.start)}, ${lead}, and ${outcome}.`;
  }
  return { assumption, shownAfterTax, receivedParts, later };
}

/** The sentence under the answer: what this case changes, and what is still needed. */
function buildSentence({ event, people, earnersCounted, needed, neededChanged, extras }) {
  const need = euroText(needed);
  if (!event) {
    if (earnersCounted >= 2) {
      return `Both of your take-home pays come in, and you need ${need}.`;
    }
    if (earnersCounted === 1) {
      return `Your take-home pay comes in, and you need ${need}.`;
    }
    return `No take-home pay comes in, and you need ${need}.`;
  }

  const name = people.find((person) => person.id === event.personId).label;
  const { assumption, shownAfterTax, receivedParts, later, payment } = extras;
  if (event.type === 'cannotWork') {
    const lead = payment > 0
      ? `${name}’s take-home stops and a State payment starts${shownAfterTax}.`
      : `${name}’s take-home stops.`;
    return [lead, assumption, ...receivedParts, `You still need ${need}.`, later].filter(Boolean).join(' ');
  }

  const lead = payment > 0
    ? `${name}’s take-home stops and a survivor’s pension starts${shownAfterTax}.`
    : `${name}’s take-home stops.`;
  if (!neededChanged) {
    return [lead, assumption, ...receivedParts, `You still need ${need}.`, later].filter(Boolean).join(' ');
  }
  const reasons = event.neededBecause || [];
  const needText = reasons.length > 0
    ? `You need ${need}, because ${reasonText(reasons)}.`
    : `You need ${need}.`;
  return [lead, assumption, ...receivedParts, needText, later].filter(Boolean).join(' ');
}

/** The two-line answer. */
function buildHeadline({ status, gap, spare, savings, months, beyond, savingsWords, later }) {
  if (status === 'left_over' || status === 'tight') {
    const line1 = status === 'left_over'
      ? `You have ${euroText(spare)} a year left over.`
      : 'You have exactly what you need.';
    if (later) {
      // Covered at first, short later: the second line says when, and for how long savings help.
      const after = `After ${durationText(later.start)} you would be ${euroText(later.gap)} a year short`;
      if (savings === 0) {
        return { line1, line2: `${after}, and you have no savings to fill it.` };
      }
      if (beyond) {
        return { line1, line2: `${after}, and ${savingsWords.toLowerCase()} would last beyond three years.` };
      }
      return { line1, line2: `${after}, and ${savingsWords.toLowerCase()} would last ${monthsText(months)} in all.` };
    }
    return { line1, line2: 'There is nothing for your savings to fill.' };
  }
  const line1 = `You are ${euroText(gap)} a year short.`;
  if (savings === 0) {
    return { line1, line2: 'You have no savings to fill it.' };
  }
  if (beyond) {
    return { line1, line2: `${savingsWords} would last beyond three years.` };
  }
  if (months === 0) {
    return { line1, line2: `${savingsWords} would last less than a month.` };
  }
  return { line1, line2: `${savingsWords} would last ${monthsText(months)}.` };
}

/**
 * The case's money in over time, as stretches in which it is constant. A stretch
 * starts when a State payment's phase ends, or a stated regular payment starts
 * or stops. Everything is in whole months from the day the income stops.
 */
function buildIntervals({ phases, regular, needed }) {
  const cuts = new Set([0]);
  if (phases.length > 1) cuts.add(phases[0].months);
  regular.forEach((entry) => {
    cuts.add(entry.afterMonths);
    cuts.add(entry.afterMonths + entry.months);
  });
  const starts = [...cuts].sort((left, right) => left - right);
  return starts.map((start, index) => {
    const length = index + 1 < starts.length ? starts[index + 1] - start : Infinity;
    const phase = phases.length > 1 && start >= phases[0].months ? phases[1] : phases[0];
    const takeHome = Object.values(phase.takeHome).reduce((total, value) => total + value, 0);
    const paid = regular
      .filter((entry) => entry.afterMonths <= start && start < entry.afterMonths + entry.months)
      .reduce((total, entry) => total + entry.amount, 0);
    const ended = [];
    if (start > 0) {
      if (phases.length > 1 && start === phases[0].months && phases[0].payment > 0) ended.push('statePayment');
      if (regular.some((entry) => entry.afterMonths + entry.months === start)) ended.push('paid');
    }
    const moneyIn = takeHome + phase.payment + paid;
    return { start, length, moneyIn, gap: Math.max(0, needed - moneyIn), spare: Math.max(0, moneyIn - needed), ended };
  });
}

/**
 * How long savings fill the gaps, month by month through the stretches. In
 * twelfths of a euro (savings x 12 against a stretch's whole yearly gap), so a
 * boundary such as exactly 36 months is exact. Savings fill ONLY a gap; a
 * stretch with money to spare adds nothing to them. Null when nothing is short.
 */
function runwayMonths(intervals, savings) {
  if (intervals.every((entry) => entry.gap === 0)) {
    return null;
  }
  let balance = savings * 12;
  let elapsed = 0;
  for (const entry of intervals) {
    if (entry.gap === 0) {
      if (entry.length === Infinity) return Infinity;
      elapsed += entry.length;
      continue;
    }
    const lasts = balance / entry.gap;
    if (lasts <= entry.length) {
      return elapsed + lasts;
    }
    balance -= entry.gap * entry.length;
    elapsed += entry.length;
  }
  return elapsed;
}

/** What each part of a case is in its first stretch, before any change over time. */
function casePhases(inputs, scenario) {
  const { event, income } = scenario;
  const stoppedId = event ? event.personId : null;
  if (income) {
    return income.phases.map((phase) => ({
      months: phase.months,
      takeHome: Object.fromEntries(inputs.people.map((person) => [person.id, person.id === stoppedId ? 0 : phase.takeHome[person.id]])),
      payment: phase.statePayment ? phase.statePayment.amount : 0
    }));
  }
  let payment = 0;
  if (event) {
    payment = event.type === 'cannotWork' ? event.statePayment : event.survivorsPension;
  }
  return [{
    months: null,
    takeHome: Object.fromEntries(inputs.people.map((person) => [person.id, person.id === stoppedId ? 0 : person.takeHome])),
    payment
  }];
}

function solveCase(inputs, scenario) {
  const { event, income } = scenario;
  const received = scenario.received || [];
  const phases = casePhases(inputs, scenario);

  const regular = received
    .filter((entry) => entry.type === 'regularPayment')
    .map((entry) => ({ amount: entry.amount, months: entry.months, afterMonths: entry.afterMonths || 0 }));
  const lumpSum = received.filter((entry) => entry.type === 'lumpSum').reduce((total, entry) => total + entry.amount, 0);
  const savingsAvailable = inputs.savings + lumpSum;

  const floorAmount = phases[0].payment;
  const floorLabel = event && event.type === 'dies' ? 'Survivor’s pension' : 'State payment';

  // Every slot is always present, in a fixed order, so a screen can move one
  // mark from its old value to its new one. An absent part has amount 0. The
  // slot for a payment the person told us about exists only in a module that
  // has one, so a module without any keeps the shape it always had.
  const segments = [{ id: 'floor', label: floorLabel, amount: floorAmount, kind: 'floor' }];
  if (inputs.hasPaidSlot) {
    segments.push({
      id: 'paid',
      label: 'Payment you told us about',
      amount: regular.filter((entry) => entry.afterMonths === 0).reduce((total, entry) => total + entry.amount, 0),
      kind: 'floor'
    });
  }
  inputs.people.forEach((person) => {
    segments.push({
      id: person.id,
      personId: person.id,
      label: `${person.label}’s take-home`,
      amount: phases[0].takeHome[person.id],
      kind: 'takeHome'
    });
  });

  const moneyIn = segments.reduce((sum, segment) => sum + segment.amount, 0);
  const needed = event && typeof event.neededAfter === 'number' ? event.neededAfter : inputs.needed;
  const neededChanged = needed !== inputs.needed;
  const gap = Math.max(0, needed - moneyIn);
  const spare = Math.max(0, moneyIn - needed);
  const status = gap > 0 ? 'short' : (spare > 0 ? 'left_over' : 'tight');

  const intervals = buildIntervals({ phases, regular, needed });
  const exactMonths = runwayMonths(intervals, savingsAvailable);
  let months = null;
  let beyond = false;
  if (exactMonths !== null) {
    beyond = exactMonths >= PROTECTION_GAP_HORIZON_MONTHS;
    months = beyond ? null : Math.round(exactMonths);
  }
  // Covered at first and short later: the answer says so, and the strip says why it is empty.
  const laterInterval = status !== 'short' && exactMonths !== null
    ? intervals.find((entry) => entry.gap > 0)
    : null;

  const savingsWords = lumpSum > 0 ? 'Your savings and the lump sum' : 'Your savings';
  const earnersCounted = segments.filter((segment) => segment.kind === 'takeHome' && segment.amount > 0).length;
  const headline = buildHeadline({
    status, gap, spare, savings: savingsAvailable, months, beyond, savingsWords,
    later: laterInterval ? { start: laterInterval.start, gap: laterInterval.gap } : null
  });
  const extras = { ...buildPaymentParts({ event, income, received, intervals }), payment: floorAmount };
  const sentence = buildSentence({ event, people: inputs.people, earnersCounted, needed, neededChanged, extras });

  const savingsLead = lumpSum > 0
    ? `Your savings and a lump sum of ${euroText(lumpSum)} would last`
    : `Your savings of ${euroText(inputs.savings)} would last`;
  const savingsLeadNarrow = lumpSum > 0 ? 'Savings and lump sum last' : 'Your savings last';

  return {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    event: event || null,
    income: income || null,
    received,
    segments,
    floorAmount,
    moneyIn,
    needed,
    neededChanged,
    gap,
    spare,
    intervals: intervals.map((entry) => ({
      start: entry.start,
      length: entry.length === Infinity ? null : entry.length,
      moneyIn: entry.moneyIn,
      gap: entry.gap
    })),
    savingsAvailable,
    savingsLead,
    savingsLeadNarrow,
    nothingText: laterInterval ? 'Nothing to fill at first' : 'Nothing to fill',
    exactMonths,
    months,
    beyond,
    status,
    statusWord: { short: 'Short', left_over: 'Left over', tight: 'Tight' }[status],
    headline,
    sentence,
    summary: `${headline.line1} ${headline.line2} ${sentence}`
  };
}

/** One scale for the module, the same in every case, so nothing rescales on a click. */
function computeScaleMax(cases) {
  const highest = Math.max(...cases.map((entry) => Math.max(entry.moneyIn, entry.needed)));
  // Integer arithmetic: 5% headroom, then up to the next 10,000.
  return Math.ceil((highest * SCALE_HEADROOM_PERCENT) / (100 * SCALE_STEP_EUR)) * SCALE_STEP_EUR;
}

function savingsLastText(entry) {
  if (entry.gap <= 0) {
    return 'Not needed';
  }
  return entry.beyond ? 'Beyond three years' : entry.months;
}

/** What the module's cases rest on, read from the cases themselves. */
function incomeSummary(inputs) {
  const incomes = inputs.scenarios.map((scenario) => scenario.income).filter(Boolean);
  const payments = incomes.flatMap((income) => income.phases.map((phase) => phase.statePayment)).filter(Boolean);
  const statedPayment = inputs.scenarios.some((scenario) => scenario.event && !scenario.income)
    || payments.some((payment) => payment.scheme === 'stated');
  return {
    estimated: incomes.some((income) => income.basis === 'estimated'),
    statedPayment,
    illnessBenefit: payments.some((payment) => payment.scheme === 'illnessBenefit'),
    bereavedPension: payments.some((payment) => payment.scheme === 'bereavedPartnerPension'),
    limited: incomes.some((income) => income.phases.length > 1)
      || inputs.scenarios.some((scenario) => (scenario.received || []).some((entry) => entry.type === 'regularPayment')),
    years: [...new Set(incomes.map((income) => income.calculationYear))].sort((left, right) => left - right),
    versions: Object.assign({}, ...incomes.map((income) => income.versions)),
    allocated: incomes.some((income) => income.creditAllocation === 'allocated')
  };
}

/** The footnote. The stated wording is unchanged; a recalculated income says how tax was treated instead. */
function buildFootnote(inputs) {
  const summary = incomeSummary(inputs);
  if (!summary.estimated) {
    return FOOTNOTE;
  }
  const parts = [
    'Amounts are a year. Your savings are used only to fill the gap, with no interest or inflation.',
    'Tax is recalculated for each case.'
  ];
  if (inputs.people.length > 1) {
    parts.push('If one of you stops working, the other person’s take-home may change.');
  }
  parts.push('State payments are shown after estimated tax and depend on eligibility.');
  if (summary.limited) {
    parts.push('A State payment is counted only for the time stated, and not after that.');
  }
  if (summary.statedPayment) {
    parts.push('A State payment you gave us is used as given.');
  }
  return parts.join(' ');
}

function buildAssumptionsTable(inputs) {
  const summary = incomeSummary(inputs);
  const statePayments = [];
  if (summary.illnessBenefit) {
    statePayments.push(`${ILLNESS_BENEFIT_ASSUMPTION} for a year, shown after estimated tax`);
  }
  if (summary.bereavedPension) {
    statePayments.push(`${BEREAVED_PENSION_ASSUMPTION}, shown after estimated tax`);
  }
  if (summary.statedPayment || statePayments.length === 0) {
    statePayments.push('A year, as given');
  }

  const rows = [
    ['Household', inputs.householdLabel || 'As entered'],
    ['What you need', `${euroText(inputs.needed)} a year`],
    ['Your savings', euroText(inputs.savings)],
    ['Take-home pay', summary.estimated ? 'Net pay a year, recalculated for each case' : 'Net pay a year, as given'],
    ['State payments', statePayments.join('; ')]
  ];
  if (summary.estimated) {
    const versionText = Object.entries({ 'tax rules': summary.versions.taxRules, 'State payment rates': summary.versions.socialWelfare })
      .filter(([, value]) => value)
      .map(([name, value]) => `${name} ${value}`)
      .join('; ');
    rows.push(['Tax', `Recalculated for each case for ${summary.years.join(' and ')}${versionText ? `, using ${versionText}` : ''}${summary.allocated ? ', with each person’s tax allocated within a joint assessment' : ''}`]);
  }
  if (summary.limited) {
    rows.push(['How long a payment counts', 'For the time stated, then not at all']);
  }
  rows.push(
    ['How long savings last', 'Savings divided by the gap, to the nearest month, with no interest or inflation'],
    ['Shown for', `${PROTECTION_GAP_HORIZON_MONTHS} months, then “beyond three years”`],
    ['Rounding', 'Amounts are whole euros, as given'],
    ['Not modelled', summary.estimated
      ? 'Limits on State payments, waiting days and a first claim year, and costs that change over time'
      : 'A change in tax when one income stops, limits on State payments, and costs that change over time']
  );
  return { columns: ['Assumption', 'Input Used'], rows };
}

function buildOutputsTable(cases) {
  return {
    columns: [
      'Case',
      'What comes in (€)',
      'What you need (€)',
      'Gap (€)',
      'Left over (€)',
      'Savings last (months)'
    ],
    rows: cases.map((entry) => [
      entry.title,
      entry.moneyIn,
      entry.needed,
      entry.gap,
      entry.spare,
      savingsLastText(entry)
    ])
  };
}

function buildTables(cases) {
  return cases.map((entry) => ({
    title: `${entry.title}: what comes in`,
    columns: ['Part', 'Amount a year (€)'],
    rows: [
      ...entry.segments.filter((segment) => segment.amount > 0).map((segment) => [segment.label, segment.amount]),
      ['What comes in', entry.moneyIn],
      ['What you need', entry.needed],
      entry.gap > 0 ? ['Gap', entry.gap] : ['Left over', entry.spare]
    ]
  }));
}

function buildCharts(inputs, baseCase) {
  return [{
    title: `${inputs.householdLabel || 'Protection gap'}: what comes in and what you need`,
    subtitle: `A year, for “${baseCase.title}”.`,
    type: 'bar',
    labels: ['What comes in', 'What you need'],
    datasets: [{
      label: 'A year',
      data: [baseCase.moneyIn, baseCase.needed]
    }],
    display: {
      valueFormat: 'currency',
      yAxisTitle: '€ a year'
    }
  }];
}

/**
 * Solve every case of a payload.
 *
 * @param {object} rawInputs `generated.protectionGapInputs`
 */
export function computeProtectionGapProjection(rawInputs) {
  const inputs = normalizeProtectionGapInputs(rawInputs);
  const solving = {
    ...inputs,
    hasPaidSlot: inputs.scenarios.some((scenario) => (scenario.received || []).some((entry) => entry.type === 'regularPayment'))
  };
  const cases = inputs.scenarios.map((scenario) => solveCase(solving, scenario));
  const baseCase = cases.find((entry) => entry.id === inputs.baseScenarioId) || cases[0];

  return {
    assumptionsTable: buildAssumptionsTable(inputs),
    outputsTable: buildOutputsTable(cases),
    tables: buildTables(cases),
    // One ordinary chart for the surfaces that have no module to draw for them.
    charts: buildCharts(inputs, baseCase),
    debug: {
      inputs,
      scaleMax: computeScaleMax(cases),
      horizonMonths: PROTECTION_GAP_HORIZON_MONTHS,
      cases,
      baseScenarioId: baseCase.id,
      footnote: buildFootnote(inputs),
      assumptionsUsed: {
        savingsGrowth: 'none',
        inflation: 'none',
        monthsRounding: 'nearest month',
        horizonMonths: PROTECTION_GAP_HORIZON_MONTHS,
        amounts: 'stated, whole euros',
        taxRecalculated: incomeSummary(inputs).estimated,
        incomeContracts: inputs.scenarios.filter((scenario) => scenario.income).map((scenario) => ({
          caseId: scenario.id,
          basis: scenario.income.basis,
          calculationYear: scenario.income.calculationYear,
          versions: scenario.income.versions,
          creditAllocation: scenario.income.creditAllocation
        }))
      }
    }
  };
}


const SUMMARY_INTRO_START = 'This shows how big the gap would be each year if an income stopped, '
  + 'and how many months your savings would fill it. ';
const SUMMARY_INTRO_STATED = 'Take-home pay and State payments are as given.';
const SUMMARY_INTRO_ESTIMATED = 'Tax is recalculated for each case, and State payments are shown after estimated tax.';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The summary shown beside this screen, on the overview card and in the
 * presenter. It is written here from the engine's own answers and never by a
 * model, so it cannot say anything the screen may not: a fixed opening line,
 * then each case's answer in case order.
 *
 * @param {object} projection the result of `computeProtectionGapProjection`
 */
export function protectionGapSummaryHtml(projection) {
  const cases = Array.isArray(projection?.debug?.cases) ? projection.debug.cases : [];
  const items = cases
    .map((entry) => `<li>${escapeHtml(`${entry.title}: ${entry.headline.line1} ${entry.headline.line2}`)}</li>`)
    .join('');
  const intro = SUMMARY_INTRO_START + (projection?.debug?.assumptionsUsed?.taxRecalculated ? SUMMARY_INTRO_ESTIMATED : SUMMARY_INTRO_STATED);
  return `<p>${intro}</p>${items ? `<ul>${items}</ul>` : ''}`;
}
