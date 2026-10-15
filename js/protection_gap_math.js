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
 * No tax. Take-home and State payments are STATED, so this module holds no tax
 * rule and no State rate. When the household cash flow module can supply them
 * they will arrive in the same fields. The surviving partner's changed tax
 * position is not recalculated, and the footnote says so.
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
const CASE_FIELDS = Object.freeze(['id', 'title', 'description', 'event']);
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

const FOOTNOTE = 'Amounts are a year. Your savings are used only to fill the gap, with no interest or inflation. '
  + 'State payments are as given and depend on each person’s PRSI record. '
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
function refuseForbiddenAndDerived(raw, path) {
  Object.keys(raw).forEach((key) => {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new Error(
        `${fieldPath(path, key)}: this screen shows the gap and the time, never a cover amount, a premium or a product.`
      );
    }
  });
  Object.keys(raw).forEach((key) => {
    if (DERIVED_FIELDS.includes(key)) {
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

function normalizeEvent(rawEvent, { path, rawTitle, id, people, neededToday }) {
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
    if (!isWholeEuros(rawEvent.statePayment) || rawEvent.statePayment <= 0) {
      throw new Error(`${where}: statePayment must be a whole number of euros greater than 0.`);
    }
    return { event: { type: 'cannotWork', personId: person.id, statePayment: rawEvent.statePayment }, person, title };
  }

  if (!isWholeEuros(rawEvent.survivorsPension)) {
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

  const event = { type: 'dies', personId: person.id, survivorsPension: rawEvent.survivorsPension };
  // A need that has not changed is the same as none stated, so the reason is dropped with it.
  if (hasNeededAfter && rawEvent.neededAfter < neededToday) {
    event.neededAfter = rawEvent.neededAfter;
    if (reasons.length > 0) {
      event.neededBecause = reasons;
    }
  }
  return { event, person, title };
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

  if (!has(rawCase, 'event')) {
    return { id, title: rawTitle || derivedCaseTitle(null, null), description };
  }
  const { event, title } = normalizeEvent(rawCase.event, { path, rawTitle, id, people, neededToday });
  return { id, title, description, event };
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

/** The sentence under the answer: what this case changes, and what is still needed. */
function buildSentence({ event, people, earnersCounted, needed, neededChanged }) {
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
  if (event.type === 'cannotWork') {
    return `${name}’s take-home stops and a State payment starts. You still need ${need}.`;
  }

  const lead = event.survivorsPension > 0
    ? `${name}’s take-home stops and a survivor’s pension starts.`
    : `${name}’s take-home stops.`;
  if (!neededChanged) {
    return `${lead} You still need ${need}.`;
  }
  const reasons = event.neededBecause || [];
  return reasons.length > 0
    ? `${lead} You need ${need}, because ${reasonText(reasons)}.`
    : `${lead} You need ${need}.`;
}

/** The two-line answer. */
function buildHeadline({ status, gap, spare, savings, months, beyond }) {
  if (status === 'left_over') {
    return {
      line1: `You have ${euroText(spare)} a year left over.`,
      line2: 'There is nothing for your savings to fill.'
    };
  }
  if (status === 'tight') {
    return {
      line1: 'You have exactly what you need.',
      line2: 'There is nothing for your savings to fill.'
    };
  }
  const line1 = `You are ${euroText(gap)} a year short.`;
  if (savings === 0) {
    return { line1, line2: 'You have no savings to fill it.' };
  }
  if (beyond) {
    return { line1, line2: 'Your savings would last beyond three years.' };
  }
  if (months === 0) {
    return { line1, line2: 'Your savings would last less than a month.' };
  }
  return { line1, line2: `Your savings would last ${monthsText(months)}.` };
}

function solveCase(inputs, scenario) {
  const { event } = scenario;
  const stoppedId = event ? event.personId : null;

  let floorAmount = 0;
  if (event) {
    floorAmount = event.type === 'cannotWork' ? event.statePayment : event.survivorsPension;
  }
  const floorLabel = event && event.type === 'dies' ? 'Survivor’s pension' : 'State payment';

  // Every slot is always present, in a fixed order, so a screen can move one
  // mark from its old value to its new one. An absent part has amount 0.
  const segments = [
    { id: 'floor', label: floorLabel, amount: floorAmount, kind: 'floor' },
    ...inputs.people.map((person) => ({
      id: person.id,
      personId: person.id,
      label: `${person.label}’s take-home`,
      amount: person.id === stoppedId ? 0 : person.takeHome,
      kind: 'takeHome'
    }))
  ];

  const moneyIn = segments.reduce((sum, segment) => sum + segment.amount, 0);
  const needed = event && typeof event.neededAfter === 'number' ? event.neededAfter : inputs.needed;
  const neededChanged = needed !== inputs.needed;
  const gap = Math.max(0, needed - moneyIn);
  const spare = Math.max(0, moneyIn - needed);
  const status = gap > 0 ? 'short' : (spare > 0 ? 'left_over' : 'tight');

  let exactMonths = null;
  let months = null;
  let beyond = false;
  if (gap > 0) {
    // Savings x 12 over the yearly gap: whole numbers, so a boundary such as
    // exactly 36 months is exact and not 35.99999999999999.
    exactMonths = (inputs.savings * 12) / gap;
    beyond = exactMonths >= PROTECTION_GAP_HORIZON_MONTHS;
    months = beyond ? null : Math.round(exactMonths);
  }

  const earnersCounted = segments.filter((segment) => segment.kind === 'takeHome' && segment.amount > 0).length;
  const headline = buildHeadline({ status, gap, spare, savings: inputs.savings, months, beyond });
  const sentence = buildSentence({ event, people: inputs.people, earnersCounted, needed, neededChanged });

  return {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    event: event || null,
    segments,
    floorAmount,
    moneyIn,
    needed,
    neededChanged,
    gap,
    spare,
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

function buildAssumptionsTable(inputs) {
  const rows = [
    ['Household', inputs.householdLabel || 'As entered'],
    ['What you need', `${euroText(inputs.needed)} a year`],
    ['Your savings', euroText(inputs.savings)],
    ['Take-home pay', 'Net pay a year, as given'],
    ['State payments', 'A year, as given'],
    ['How long savings last', 'Savings divided by the gap, to the nearest month, with no interest or inflation'],
    ['Shown for', `${PROTECTION_GAP_HORIZON_MONTHS} months, then “beyond three years”`],
    ['Rounding', 'Amounts are whole euros, as given'],
    ['Not modelled', 'A change in tax when one income stops, limits on State payments, and costs that change over time']
  ];
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
  const cases = inputs.scenarios.map((scenario) => solveCase(inputs, scenario));
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
      footnote: FOOTNOTE,
      assumptionsUsed: {
        savingsGrowth: 'none',
        inflation: 'none',
        monthsRounding: 'nearest month',
        horizonMonths: PROTECTION_GAP_HORIZON_MONTHS,
        amounts: 'stated, whole euros',
        taxRecalculated: false
      }
    }
  };
}


const SUMMARY_INTRO = 'This shows how big the gap would be each year if an income stopped, '
  + 'and how many months your savings would fill it. Take-home pay and State payments are as given.';

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
  return `<p>${SUMMARY_INTRO}</p>${items ? `<ul>${items}</ul>` : ''}`;
}
