/**
 * Household cash flow: after everything you pay, what is left each year, and
 * what would change it?
 *
 * One ordinary year, in today's money. Income comes in, tax, pension
 * contributions and the costs the adviser states go out, and what remains is
 * the answer. A case is the same household with one or two things changed
 * (a loan cleared, an extra pension contribution) and the engine solves what
 * each does to the amount left over.
 *
 * WHERE TAX COMES FROM
 *
 * Nothing in the payload states tax. By default every case runs through the
 * Irish tax engine (`computeTaxYear`), so this module holds no rate, band or
 * credit of its own. A person's take-home pay may be STATED, and then it sets
 * the level of that person's tax: a payslip beats an estimate. What a case
 * changes about tax is still the engine's estimate, because a payslip cannot
 * know what a pension contribution would save.
 *
 * COUPLES
 *
 * The engine assesses a married couple's income tax jointly, as one figure,
 * while USC and PRSI are per person. Per-person take-home therefore needs a
 * convention, and this is it: in the base case each person's share of the
 * income tax is their income before tax over the household's, and a case's
 * CHANGE in household income tax goes to whoever pays the contribution, split
 * by amount. The people's tax always sums to the household's. Take-home marked
 * `allocated` is a convention, not a payslip figure.
 *
 * PENSION MONEY (D7)
 *
 * A contribution is drawn at its full amount, because that is what goes into
 * the pension, and the income tax relief on it shows as lower tax. What it
 * costs the household is the difference, and that is what moves the amount
 * left over. `summary` carries both, so a reader that needs growth reads the
 * gross figure and a reader that needs cash flow reads the cost after relief.
 *
 * RELIEF LIMIT
 *
 * The tax engine relieves any contribution in full. The limit on what gets
 * relief (an age-band share of earnings up to a cap) lives in `pension_math.js`,
 * so a case that would pay more than a person can have relieved is refused here
 * rather than shown with a saving it would not get. Earnings are employment
 * income only. When today's contributions arrive, the limit applies to today's
 * contribution plus the extra.
 *
 * `options` exists so tests can inject a design fixture. It is never reachable
 * from a payload.
 */

import { MAX_MODULE_SCENARIO_CASES } from './scenario_cap.js';
import { computeTaxYear, mergeDisclosures, TAX_STATUSES } from './planning/tax/engine.js';
import { resolveTaxRules } from './planning/tax/resolve.js';
import { IE_TAX_FIRST_YEAR } from './planning/tax/rules_ie.js';
import { TAX_NOT_INCLUDED, renderTaxDisclosures } from './planning/tax/disclosures.js';
import { PLANEIR_ASSUMPTIONS_VERSION } from './planning/planeir_assumptions.js';
import {
  PENSION_EARNINGS_CAP,
  maxRelievableContributionRatePercent,
  maxRelievablePersonalContribution
} from './pension_math.js';

const FIELD = 'generated.householdCashFlowInputs';
const JOINT = 'joint';

const MAX_PEOPLE = 2;
const MAX_INCOME_ITEMS = 6;
const MAX_OUTGOINGS = 6;
const MAX_CHANGES = 3;
const MAX_OUTGOING_LABEL = 24;
const MAX_PERSON_LABEL = 40;
const MAX_CASE_TITLE = 40;
const MIN_AGE = 16;
const MAX_AGE = 110;

/** A stated take-home further than this from the estimate is a warning, never a refusal. */
const STATED_TAKE_HOME_WARNING_SHARE = 0.15;

/** The people's tax must sum to the engine's household total within this. */
const TAX_SUM_TOLERANCE_EUR = 0.01;

/**
 * What a household's income may be made of. The engine validates the same
 * list again; a test proves every entry here is one it accepts.
 * `employmentPensionContribution` is deliberately absent: only a case change
 * produces one, until today's contributions are designed.
 */
export const HOUSEHOLD_CASH_FLOW_INCOME_TYPES = Object.freeze([
  'employment',
  'rentalProfit',
  'statePension',
  'occupationalPension',
  'arfDistribution'
]);

const CHANGE_TYPES = Object.freeze(['clearOutgoing', 'extraPension']);
const RESERVED_LINE_IDS = Object.freeze(['tax', 'pensions', 'left_over']);
const PERSON_FIELDS = Object.freeze(['id', 'age', 'label', 'statedTakeHome']);
// `mappedFromJoint` is written by normalising, so a normalised payload can be normalised again.
const INCOME_FIELDS = Object.freeze(['personId', 'type', 'amount', 'mappedFromJoint']);
const OUTGOING_FIELDS = Object.freeze(['id', 'label', 'amount']);
const CASE_FIELDS = Object.freeze(['id', 'title', 'description', 'changes']);
const CLEAR_FIELDS = Object.freeze(['type', 'outgoingId', 'paidFrom']);
const PENSION_FIELDS = Object.freeze(['type', 'amount', 'personId']);

/** A payload carrying any of these is refused: tax is calculated, never stated. */
const REFUSED_TAX_FIELDS = Object.freeze(['tax', 'totalTax', 'taxRate', 'incomeTax', 'usc', 'prsi']);

/* ------------------------------------------------------------- utilities */

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Present and not null: a normalised payload writes null for "not given". */
function has(raw, key) {
  return Object.prototype.hasOwnProperty.call(raw, key)
    && typeof raw[key] !== 'undefined'
    && raw[key] !== null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function euroText(amount) {
  return `€${Math.round(Math.abs(amount)).toLocaleString('en-IE')}`;
}

function roundToHundred(amount) {
  return (Math.round(amount / 100) * 100) || 0;
}

function roundToTen(amount) {
  return (Math.round(amount / 10) * 10) || 0;
}

/** "Car loan" -> "car loan", but "HSE loan" keeps its capitals. */
function lowerFirst(text) {
  if (text.length < 2) {
    return text.toLowerCase();
  }
  return /^[A-Z]{2}/.test(text) ? text : `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

function joinWithAnd(parts) {
  if (parts.length <= 1) {
    return parts.join('');
  }
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function capitalise(text) {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

function rejectUnknownKeys(raw, allowed, where) {
  Object.keys(raw).forEach((key) => {
    if (!allowed.includes(key)) {
      throw new Error(`${where}: "${key}" is not a field.`);
    }
  });
}

/* ----------------------------------------------------------- normalising */

function normalizePeople(raw) {
  if (!Array.isArray(raw.people) || raw.people.length === 0) {
    throw new Error(`${FIELD}.people must be an array with 1 or 2 people.`);
  }
  if (raw.people.length > MAX_PEOPLE) {
    throw new Error(`${FIELD}.people supports at most ${MAX_PEOPLE} people; received ${raw.people.length}.`);
  }

  const ids = new Set();
  return raw.people.map((rawPerson, index) => {
    const where = `${FIELD}.people[${index}]`;
    if (!isPlainObject(rawPerson)) {
      throw new Error(`${where} must be an object.`);
    }
    const id = typeof rawPerson.id === 'string' ? rawPerson.id.trim() : '';
    if (!id || !/^[a-z0-9_-]+$/.test(id) || id === JOINT) {
      throw new Error(`${where}.id must be lower case letters, numbers, "-" or "_", and cannot be "${JOINT}".`);
    }
    if (ids.has(id)) {
      throw new Error(`${where}.id must be unique.`);
    }
    ids.add(id);
    rejectUnknownKeys(rawPerson, PERSON_FIELDS, `${where} (${id})`);

    if (!isFiniteNumber(rawPerson.age) || !Number.isInteger(rawPerson.age)
      || rawPerson.age < MIN_AGE || rawPerson.age > MAX_AGE) {
      throw new Error(`${where} (${id}): age must be a whole number from ${MIN_AGE} to ${MAX_AGE}.`);
    }

    let label = '';
    // An empty label is how a normalised one-person payload says "not given".
    if (has(rawPerson, 'label') && rawPerson.label !== '') {
      label = typeof rawPerson.label === 'string' ? rawPerson.label.trim() : '';
      if (label.length < 1 || label.length > MAX_PERSON_LABEL) {
        throw new Error(`${where} (${id}): label must be 1 to ${MAX_PERSON_LABEL} characters.`);
      }
    }
    if (raw.people.length > 1 && !label) {
      throw new Error(`${where} needs a label when there are two people.`);
    }

    let statedTakeHome = null;
    if (has(rawPerson, 'statedTakeHome')) {
      if (!isFiniteNumber(rawPerson.statedTakeHome) || rawPerson.statedTakeHome <= 0) {
        throw new Error(`${where} (${label || id}): statedTakeHome must be a number greater than 0.`);
      }
      statedTakeHome = rawPerson.statedTakeHome;
    }

    return { id, age: rawPerson.age, label, statedTakeHome };
  });
}

function normalizeIncome(raw, people) {
  if (!Array.isArray(raw.income) || raw.income.length === 0) {
    throw new Error(`${FIELD}.income must be an array with at least 1 item.`);
  }
  if (raw.income.length > MAX_INCOME_ITEMS) {
    throw new Error(`${FIELD}.income supports at most ${MAX_INCOME_ITEMS} items; received ${raw.income.length}.`);
  }

  const personIds = people.map((person) => person.id);
  return raw.income.map((rawItem, index) => {
    const where = `${FIELD}.income[${index}]`;
    if (!isPlainObject(rawItem)) {
      throw new Error(`${where} must be an object.`);
    }
    rejectUnknownKeys(rawItem, INCOME_FIELDS, where);

    if (rawItem.type === 'employmentPensionContribution') {
      throw new Error(
        `${where}: today's pension contributions are not supported yet. A case's extraPension adds one.`
      );
    }
    if (!HOUSEHOLD_CASH_FLOW_INCOME_TYPES.includes(rawItem.type)) {
      throw new Error(`${where}.type must be one of: ${HOUSEHOLD_CASH_FLOW_INCOME_TYPES.join(', ')}.`);
    }
    if (!isFiniteNumber(rawItem.amount) || rawItem.amount <= 0) {
      throw new Error(`${where}.amount must be greater than 0.`);
    }

    let personId = typeof rawItem.personId === 'string' ? rawItem.personId.trim() : '';
    let mappedFromJoint = false;
    if (personId === JOINT && people.length === 1) {
      // The engine refuses "joint" for one person. In a one-person household it
      // means that person, so say so here rather than let the engine refuse it.
      personId = people[0].id;
      mappedFromJoint = true;
    }
    if (personId !== JOINT && !personIds.includes(personId)) {
      throw new Error(`${where}.personId "${personId}" is not one of the people.`);
    }

    return { personId, type: rawItem.type, amount: rawItem.amount, mappedFromJoint };
  });
}

function normalizeOutgoings(raw) {
  if (!Array.isArray(raw.outgoings) || raw.outgoings.length === 0) {
    throw new Error(`${FIELD}.outgoings must be an array with at least 1 line.`);
  }
  if (raw.outgoings.length > MAX_OUTGOINGS) {
    throw new Error(`${FIELD}.outgoings supports at most ${MAX_OUTGOINGS} lines; received ${raw.outgoings.length}.`);
  }

  const ids = new Set();
  return raw.outgoings.map((rawLine, index) => {
    const where = `${FIELD}.outgoings[${index}]`;
    if (!isPlainObject(rawLine)) {
      throw new Error(`${where} must be an object.`);
    }
    const label = typeof rawLine.label === 'string' ? rawLine.label.trim() : '';
    const id = typeof rawLine.id === 'string' ? rawLine.id.trim() : '';

    if (id.toLowerCase() === 'tax' || label.toLowerCase() === 'tax') {
      throw new Error(
        `${where} (${label || id}): tax is calculated from income by the Irish tax engine and cannot be stated `
        + "as a cost. Give a person's take-home in people[].statedTakeHome instead."
      );
    }
    rejectUnknownKeys(rawLine, OUTGOING_FIELDS, `${where} (${label || id})`);

    if (!id || !/^[a-z0-9_]+$/.test(id) || RESERVED_LINE_IDS.includes(id)) {
      throw new Error(
        `${where}.id must be lower case letters, numbers or "_", and cannot be one of: ${RESERVED_LINE_IDS.join(', ')}.`
      );
    }
    if (ids.has(id)) {
      throw new Error(`${where}.id must be unique.`);
    }
    ids.add(id);
    if (label.length < 1 || label.length > MAX_OUTGOING_LABEL) {
      throw new Error(`${where} (${id}): label must be 1 to ${MAX_OUTGOING_LABEL} characters.`);
    }
    if (!isFiniteNumber(rawLine.amount) || rawLine.amount < 0) {
      throw new Error(`${where} (${label}): amount must be 0 or more.`);
    }

    return { id, label, amount: rawLine.amount };
  });
}

function singleChangeTitle(change, outgoingsById) {
  if (change.type === 'clearOutgoing') {
    const label = outgoingsById.get(change.outgoingId)?.label || change.outgoingId;
    return `Clear your ${lowerFirst(label)}${change.paidFrom === 'savings' ? ' from savings' : ''}`;
  }
  return `Pay ${euroText(change.amount)} more into your pensions`;
}

/** The button title a case gets when the payload gives none. */
function derivedCaseTitle(changes, outgoingsById) {
  if (changes.length === 0) {
    return 'Today';
  }
  if (changes.length === 1) {
    return singleChangeTitle(changes[0], outgoingsById);
  }
  return changes.length === 2 ? 'Both' : 'All three';
}

function parseChange(rawChange, where, people, outgoingsById) {
  if (!isPlainObject(rawChange)) {
    throw new Error(`${where} must be an object.`);
  }
  if (!CHANGE_TYPES.includes(rawChange.type)) {
    throw new Error(`${where}.type must be one of: ${CHANGE_TYPES.join(', ')}.`);
  }

  if (rawChange.type === 'clearOutgoing') {
    rejectUnknownKeys(rawChange, CLEAR_FIELDS, where);
    const outgoingId = typeof rawChange.outgoingId === 'string' ? rawChange.outgoingId.trim() : '';
    if (has(rawChange, 'paidFrom') && rawChange.paidFrom !== 'savings') {
      throw new Error(`${where}.paidFrom must be "savings" when given.`);
    }
    return {
      type: 'clearOutgoing',
      outgoingId,
      paidFrom: rawChange.paidFrom === 'savings' ? 'savings' : null
    };
  }

  rejectUnknownKeys(rawChange, PENSION_FIELDS, where);
  if (!isFiniteNumber(rawChange.amount) || rawChange.amount <= 0) {
    throw new Error(`${where}.amount must be greater than 0.`);
  }
  let personId = has(rawChange, 'personId') && typeof rawChange.personId === 'string'
    ? rawChange.personId.trim()
    : JOINT;
  if (personId === JOINT && people.length === 1) {
    personId = people[0].id;
  }
  return { type: 'extraPension', amount: rawChange.amount, personId };
}

function normalizeScenarios(raw, people, outgoings) {
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) {
    throw new Error(`${FIELD}.scenarios must be an array with at least 1 case.`);
  }
  if (raw.scenarios.length > MAX_MODULE_SCENARIO_CASES) {
    throw new Error(
      `${FIELD}.scenarios supports at most ${MAX_MODULE_SCENARIO_CASES} cases; received ${raw.scenarios.length}.`
    );
  }

  const outgoingsById = new Map(outgoings.map((line) => [line.id, line]));
  const personIds = people.map((person) => person.id);
  const usedIds = new Set();

  return raw.scenarios.map((rawCase, index) => {
    const where = `${FIELD}.scenarios[${index}]`;
    if (!isPlainObject(rawCase)) {
      throw new Error(`${where} must be an object.`);
    }
    const id = typeof rawCase.id === 'string' ? rawCase.id.trim() : '';
    if (!id) {
      throw new Error(`${where}.id must be a non-empty string.`);
    }
    if (usedIds.has(id)) {
      throw new Error(`${where}.id must be unique.`);
    }
    usedIds.add(id);

    if (has(rawCase, 'changes') && !Array.isArray(rawCase.changes)) {
      throw new Error(`${where} (${id}).changes must be an array.`);
    }
    const rawChanges = has(rawCase, 'changes') ? rawCase.changes : [];
    if (rawChanges.length > MAX_CHANGES) {
      throw new Error(`${where} (${id}).changes supports at most ${MAX_CHANGES} changes; received ${rawChanges.length}.`);
    }
    const changes = rawChanges.map((rawChange, changeIndex) => (
      parseChange(rawChange, `${where} (${id}).changes[${changeIndex}]`, people, outgoingsById)
    ));

    let title = '';
    if (has(rawCase, 'title')) {
      title = typeof rawCase.title === 'string' ? rawCase.title.trim() : '';
      if (title.length < 1 || title.length > MAX_CASE_TITLE) {
        throw new Error(`${where} (${id}): title must be 1 to ${MAX_CASE_TITLE} characters.`);
      }
    }
    if (!title) {
      title = derivedCaseTitle(changes, outgoingsById);
    }
    rejectUnknownKeys(rawCase, CASE_FIELDS, `${where} (${title})`);

    // Now that the case has a name, the checks that quote it.
    const cleared = new Set();
    let pensionChanges = 0;
    changes.forEach((change) => {
      if (change.type === 'clearOutgoing') {
        if (!outgoingsById.has(change.outgoingId)) {
          throw new Error(`${where} (${title}): outgoingId "${change.outgoingId}" is not one of the outgoings.`);
        }
        if (cleared.has(change.outgoingId)) {
          throw new Error(`${where} (${title}): "${change.outgoingId}" is cleared twice.`);
        }
        cleared.add(change.outgoingId);
      } else {
        pensionChanges += 1;
        if (pensionChanges > 1) {
          throw new Error(`${where} (${title}): a case can have only one extraPension.`);
        }
        if (change.personId !== JOINT && !personIds.includes(change.personId)) {
          throw new Error(`${where} (${title}): personId "${change.personId}" is not one of the people.`);
        }
      }
    });

    const description = typeof rawCase.description === 'string' ? rawCase.description.trim() : '';
    return { id, title, description, changes };
  });
}

/** Each person's income before tax: their own items plus half of any joint item. */
function grossByPerson(people, income) {
  const gross = Object.fromEntries(people.map((person) => [person.id, 0]));
  const earnings = Object.fromEntries(people.map((person) => [person.id, 0]));
  income.forEach((item) => {
    const owners = item.personId === JOINT ? people.map((person) => person.id) : [item.personId];
    owners.forEach((ownerId) => {
      const share = item.amount / owners.length;
      gross[ownerId] += share;
      if (item.type === 'employment') {
        earnings[ownerId] += share;
      }
    });
  });
  return { gross, earnings };
}

/** What each person pays into a pension in a case, by person. */
function contributionsForCase(scenario, people, todayContributions) {
  const byPerson = Object.fromEntries(people.map((person) => [person.id, todayContributions[person.id] || 0]));
  scenario.changes.forEach((change) => {
    if (change.type !== 'extraPension') {
      return;
    }
    const owners = change.personId === JOINT ? people.map((person) => person.id) : [change.personId];
    owners.forEach((ownerId) => {
      byPerson[ownerId] += change.amount / owners.length;
    });
  });
  return byPerson;
}

function checkReliefLimits(scenarios, people, gross, earnings, todayContributions) {
  scenarios.forEach((scenario, index) => {
    const paid = contributionsForCase(scenario, people, todayContributions);
    people.forEach((person) => {
      const total = paid[person.id];
      if (!(total > 0)) {
        return;
      }
      const limit = maxRelievablePersonalContribution(person.age, earnings[person.id]);
      if (total > limit + 0.005) {
        const rate = maxRelievableContributionRatePercent(person.age);
        throw new Error(
          `${FIELD}.scenarios[${index}] (${scenario.title}): ${person.label || person.id} would pay ${euroText(total)} `
          + `a year into a pension, which is more than the ${euroText(limit)} a year that gets tax relief `
          + `at age ${person.age} (${rate}% of earnings up to ${euroText(PENSION_EARNINGS_CAP)}).`
        );
      }
    });
  });
}

/**
 * Validate a payload and return it in canonical form.
 *
 * Idempotent: normalising a normalised payload returns an equal one.
 */
export function normalizeHouseholdCashFlowInputs(raw) {
  if (!isPlainObject(raw)) {
    throw new Error(`${FIELD} must be an object.`);
  }

  if (has(raw, 'leftOver')) {
    throw new Error(`${FIELD}.leftOver is not accepted. It is calculated.`);
  }
  REFUSED_TAX_FIELDS.forEach((key) => {
    if (has(raw, key)) {
      throw new Error(
        `${FIELD}.${key} is not accepted. Tax is calculated by the Irish tax engine. `
        + "Give a person's take-home in people[].statedTakeHome instead."
      );
    }
  });

  const people = normalizePeople(raw);

  let taxStatus = 'single';
  let taxStatusDefaulted = true;
  if (has(raw, 'householdTaxStatus') && raw.householdTaxStatus !== null) {
    if (!TAX_STATUSES.includes(raw.householdTaxStatus)) {
      throw new Error(`${FIELD}.householdTaxStatus must be one of: ${TAX_STATUSES.join(', ')}.`);
    }
    if (raw.householdTaxStatus === 'widowed_or_surviving_civil_partner' && people.length !== 1) {
      throw new Error(
        `${FIELD}.householdTaxStatus widowed_or_surviving_civil_partner describes one person, `
        + `but the payload has ${people.length} people.`
      );
    }
    taxStatus = raw.householdTaxStatus;
    taxStatusDefaulted = false;
  }

  const income = normalizeIncome(raw, people);
  const outgoings = normalizeOutgoings(raw);

  let calculationYear = null;
  if (has(raw, 'calculationYear')) {
    if (!isFiniteNumber(raw.calculationYear) || !Number.isInteger(raw.calculationYear)
      || raw.calculationYear < IE_TAX_FIRST_YEAR || raw.calculationYear > 2100) {
      throw new Error(`${FIELD}.calculationYear must be a whole tax year from ${IE_TAX_FIRST_YEAR}.`);
    }
    calculationYear = raw.calculationYear;
  }

  const { gross, earnings } = grossByPerson(people, income);
  people.forEach((person, index) => {
    if (person.statedTakeHome === null) {
      return;
    }
    if (!(gross[person.id] > 0)) {
      throw new Error(
        `${FIELD}.people[${index}] (${person.label || person.id}): statedTakeHome needs income before tax for this person.`
      );
    }
    if (person.statedTakeHome >= gross[person.id]) {
      throw new Error(
        `${FIELD}.people[${index}] (${person.label || person.id}): statedTakeHome (${euroText(person.statedTakeHome)}) `
        + `must be less than income before tax (${euroText(gross[person.id])}).`
      );
    }
  });

  const scenarios = normalizeScenarios(raw, people, outgoings);

  let baseScenarioId = scenarios[0].id;
  if (has(raw, 'baseScenarioId')) {
    const requested = typeof raw.baseScenarioId === 'string' ? raw.baseScenarioId.trim() : '';
    if (!requested || !scenarios.some((scenario) => scenario.id === requested)) {
      throw new Error(`${FIELD}.baseScenarioId must match a case id.`);
    }
    baseScenarioId = requested;
  }
  const baseIndex = scenarios.findIndex((scenario) => scenario.id === baseScenarioId);
  if (scenarios[baseIndex].changes.length > 0) {
    throw new Error(
      `${FIELD}.scenarios[${baseIndex}] (${scenarios[baseIndex].title}): the base case is today and cannot carry changes.`
    );
  }

  // Today's contributions are not accepted from a payload yet. The field is
  // internal and zero, so the follow-up adds an input instead of reshaping the
  // model, and the relief limit already applies to today's plus the extra.
  const todayContributions = Object.fromEntries(people.map((person) => [person.id, 0]));
  checkReliefLimits(scenarios, people, gross, earnings, todayContributions);

  return {
    taxStatus,
    taxStatusDefaulted,
    people,
    income,
    outgoings,
    calculationYear,
    baseScenarioId,
    scenarios,
    todayContributions,
    grossByPerson: gross,
    earningsByPerson: earnings,
    incomeTotal: Object.values(gross).reduce((sum, value) => sum + value, 0)
  };
}

/** `[{ id, title, description }]`, for the presenter and the case buttons. */
export function getHouseholdCashFlowCases(rawInputs) {
  return normalizeHouseholdCashFlowInputs(rawInputs).scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    description: scenario.description
  }));
}

export function getDefaultHouseholdCashFlowScenarioId(rawInputs) {
  return normalizeHouseholdCashFlowInputs(rawInputs).baseScenarioId;
}

/* ------------------------------------------------------------------- tax */

/**
 * One tax estimate for one set of contributions.
 *
 * `units` are the engine's assessments: a person assessed on their own is a
 * unit of one, and a jointly assessed couple is a unit of two with ONE income
 * tax figure, which is why per-person income tax is an allocation.
 */
function estimateWithEngine(inputs, year, contributionsByPerson) {
  const items = inputs.income.map((item) => ({
    personId: item.personId,
    type: item.type,
    amount: item.amount
  }));
  Object.entries(contributionsByPerson).forEach(([personId, amount]) => {
    if (amount > 0) {
      items.push({ personId, type: 'employmentPensionContribution', amount });
    }
  });

  const { result } = computeTaxYear({
    input: {
      year,
      status: inputs.taxStatus,
      people: inputs.people.map((person) => ({ id: person.id, age: person.age })),
      items
    }
  });

  const people = {};
  result.people.forEach((person) => {
    people[person.id] = { usc: person.usc.usc, prsi: person.prsi.prsi };
  });
  const units = result.assessments.map((assessment) => ({
    personIds: assessment.personIds.slice(),
    incomeTax: assessment.incomeTax
  }));

  const summed = units.reduce((sum, unit) => sum + unit.incomeTax, 0)
    + Object.values(people).reduce((sum, entry) => sum + entry.usc + entry.prsi, 0);
  if (Math.abs(summed - result.totals.recurringTax) > TAX_SUM_TOLERANCE_EUR) {
    throw new Error(
      `${FIELD}: the engine's recurring tax (${result.totals.recurringTax}) does not equal its assessments plus USC and PRSI (${summed}).`
    );
  }

  return {
    injected: false,
    total: result.totals.recurringTax,
    people,
    units,
    disclosures: result.disclosures,
    disclosureCodes: result.disclosureCodes,
    rulesVersion: result.rulesVersion,
    rulesYear: result.rulesYear,
    heldForward: result.heldForward
  };
}

/** A test's replacement for the engine: it returns each person's tax for the case. */
function estimateWithInjection(taxFor, inputs, year, caseId, contributionsByPerson) {
  const returned = taxFor({
    caseId,
    year,
    status: inputs.taxStatus,
    people: inputs.people.map((person) => ({ id: person.id, age: person.age, label: person.label })),
    income: inputs.income.map((item) => ({ ...item })),
    contributions: Object.entries(contributionsByPerson)
      .filter(([, amount]) => amount > 0)
      .map(([personId, amount]) => ({ personId, amount }))
  });
  if (!isPlainObject(returned)) {
    throw new Error('taxFor must return an object of tax by person id.');
  }
  const people = {};
  let total = 0;
  inputs.people.forEach((person) => {
    const tax = returned[person.id];
    if (!isFiniteNumber(tax) || tax < 0) {
      throw new Error(`taxFor must return a tax of 0 or more for "${person.id}".`);
    }
    people[person.id] = { usc: 0, prsi: 0, injectedTax: tax };
    total += tax;
  });
  return {
    injected: true,
    total,
    people,
    units: inputs.people.map((person) => ({ personIds: [person.id], incomeTax: people[person.id].injectedTax })),
    disclosures: [],
    disclosureCodes: [],
    rulesVersion: null,
    rulesYear: year,
    heldForward: false
  };
}

/**
 * One person's ESTIMATED tax in a case.
 *
 * Own USC and PRSI, plus income tax: their own where they are assessed alone,
 * and where a couple is assessed together their income share of the BASE case's
 * household income tax plus whatever the case changed, which goes to whoever
 * pays the contribution.
 */
function estimatedPersonTax(personId, estimate, baseEstimate, contributions, baseContributions, gross) {
  const unit = estimate.units.find((entry) => entry.personIds.includes(personId));
  const own = estimate.people[personId];
  if (unit.personIds.length === 1) {
    return own.usc + own.prsi + unit.incomeTax;
  }

  const baseUnit = baseEstimate.units.find((entry) => entry.personIds.includes(personId));
  const members = unit.personIds;
  const memberGross = members.reduce((sum, id) => sum + gross[id], 0);
  const share = memberGross > 0 ? gross[personId] / memberGross : 1 / members.length;
  const delta = unit.incomeTax - baseUnit.incomeTax;

  const weights = members.map((id) => Math.max(0, (contributions[id] || 0) - (baseContributions[id] || 0)));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const memberIndex = members.indexOf(personId);
  const attributed = weightTotal > 0
    ? delta * (weights[memberIndex] / weightTotal)
    : delta * share;

  return own.usc + own.prsi + share * baseUnit.incomeTax + attributed;
}

/* ----------------------------------------------------------- the engine */

function resolveYear(inputs, options) {
  if (Number.isInteger(options.calculationYear)) {
    return options.calculationYear;
  }
  if (Number.isInteger(inputs.calculationYear)) {
    return inputs.calculationYear;
  }
  return Math.max(IE_TAX_FIRST_YEAR, new Date().getFullYear());
}

function personLabelFor(person) {
  return person.label || person.id;
}

function buildCaseModels(inputs, year, options) {
  const injected = typeof options.taxFor === 'function';
  const estimate = (caseId, contributions) => (
    injected
      ? estimateWithInjection(options.taxFor, inputs, year, caseId, contributions)
      : estimateWithEngine(inputs, year, contributions)
  );

  const baseScenario = inputs.scenarios.find((scenario) => scenario.id === inputs.baseScenarioId);
  const baseContributions = contributionsForCase(baseScenario, inputs.people, inputs.todayContributions);
  const baseEstimate = estimate(baseScenario.id, baseContributions);
  const noContributions = Object.fromEntries(inputs.people.map((person) => [person.id, 0]));
  const outgoingsById = new Map(inputs.outgoings.map((line) => [line.id, line]));

  const hasPensionColumn = inputs.scenarios.some((scenario) => (
    scenario.changes.some((change) => change.type === 'extraPension')
  ));

  const personEstimatedInBase = {};
  inputs.people.forEach((person) => {
    personEstimatedInBase[person.id] = injected
      ? baseEstimate.people[person.id].injectedTax
      : estimatedPersonTax(person.id, baseEstimate, baseEstimate, baseContributions, baseContributions, inputs.grossByPerson);
  });

  const models = inputs.scenarios.map((scenario) => {
    const contributions = contributionsForCase(scenario, inputs.people, inputs.todayContributions);
    const isBase = scenario.id === baseScenario.id;
    const caseEstimate = isBase ? baseEstimate : estimate(scenario.id, contributions);

    const people = inputs.people.map((person) => {
      const gross = inputs.grossByPerson[person.id];
      const estimatedTax = injected
        ? caseEstimate.people[person.id].injectedTax
        : estimatedPersonTax(
          person.id,
          caseEstimate,
          baseEstimate,
          contributions,
          baseContributions,
          inputs.grossByPerson
        );
      const stated = person.statedTakeHome !== null;
      const tax = stated
        ? (gross - person.statedTakeHome) + (estimatedTax - personEstimatedInBase[person.id])
        : estimatedTax;
      return {
        personId: person.id,
        label: person.label,
        gross,
        tax,
        takeHome: gross - tax,
        taxSource: stated ? 'stated' : 'estimated',
        basis: inputs.taxStatus === 'married_or_civil_partners' && inputs.people.length === 2 ? 'allocated' : 'own',
        estimatedTax,
        estimatedTakeHome: gross - estimatedTax,
        usc: injected ? null : caseEstimate.people[person.id].usc,
        prsi: injected ? null : caseEstimate.people[person.id].prsi
      };
    });

    const taxTotal = people.reduce((sum, person) => sum + person.tax, 0);
    const pensionsGross = Object.values(contributions).reduce((sum, amount) => sum + amount, 0);

    // What the contribution saves: the same case with no contributions at all.
    // An estimate always, because a payslip cannot know it.
    let taxRelief = 0;
    if (pensionsGross > 0) {
      const without = estimate(`${scenario.id}:without-contributions`, noContributions);
      taxRelief = Math.max(0, without.total - caseEstimate.total);
    }

    const statedLines = inputs.outgoings.map((line) => {
      const cleared = scenario.changes.some((change) => (
        change.type === 'clearOutgoing' && change.outgoingId === line.id
      ));
      return { id: line.id, label: line.label, amount: cleared ? 0 : line.amount, cleared };
    });
    const statedTotal = statedLines.reduce((sum, line) => sum + line.amount, 0);

    const totalOutgoings = taxTotal + pensionsGross + statedTotal;
    const leftOver = inputs.incomeTotal - totalOutgoings;

    return {
      scenario,
      isBase,
      people,
      taxTotal,
      taxEstimatedTotal: caseEstimate.total,
      pensionsGross,
      taxRelief,
      statedLines,
      statedTotal,
      totalOutgoings,
      leftOver,
      estimate: caseEstimate
    };
  });

  return { models, baseEstimate, hasPensionColumn, outgoingsById, injected };
}

function statusFor(shownLeftOver) {
  return shownLeftOver > 0 ? 'left_over' : 'tight';
}

function monthlyFor(shownLeftOver) {
  const exactMonthly = shownLeftOver / 12;
  const amount = roundToTen(exactMonthly);
  const exact = Math.abs(exactMonthly - amount) < 0.005;
  return {
    amount,
    exact,
    text: `${exact ? '' : 'About '}${euroText(amount)} a month`
  };
}

function effectClause(todayLeft, left) {
  if (left === todayLeft) {
    return `you have the same ${euroText(left)} left over as today`;
  }
  if (left === 0) {
    return 'you have nothing left over';
  }
  if (todayLeft > 0 && left === todayLeft * 2) {
    return `the amount you have left over doubles, from ${euroText(todayLeft)} to ${euroText(left)}`;
  }
  if (left > todayLeft) {
    return `the amount you have left over rises by ${euroText(left - todayLeft)}, from ${euroText(todayLeft)} to ${euroText(left)}`;
  }
  return `the amount you have left over falls from ${euroText(todayLeft)} to ${euroText(left)}`;
}

function buildSentence({ model, today, outgoingsById }) {
  const shownLeft = model.shownLeftOver;
  if (model.isBase) {
    const left = shownLeft === 0 ? 'you have nothing left over' : `you have ${euroText(shownLeft)} left over`;
    return `Today, ${euroText(model.shownOutgoings)} of your ${euroText(model.shownIncome)} goes out and ${left}.`;
  }

  const { changes } = model.scenario;
  const effect = effectClause(today.shownLeftOver, shownLeft);
  const taxDelta = today.shownTax - model.shownTax;

  if (changes.length === 1) {
    const change = changes[0];
    if (change.type === 'clearOutgoing') {
      const line = today.shownLines.find((entry) => entry.id === change.outgoingId);
      const label = lowerFirst(outgoingsById.get(change.outgoingId).label);
      const from = change.paidFrom === 'savings' ? ' from savings' : '';
      return `Clearing your ${label}${from} stops ${euroText(line.shownAmount)} a year going out, so ${effect}.`;
    }
    const net = model.shownPensions - taxDelta;
    const lead = taxDelta > 0
      ? `Paying ${euroText(model.shownPensions)} more into your pensions lowers your tax by ${euroText(taxDelta)}, `
      : `Paying ${euroText(model.shownPensions)} more into your pensions, `;
    return `${lead}so ${euroText(net)} more goes out each year and ${effect}.`;
  }

  const phrases = changes.map((change) => {
    if (change.type === 'clearOutgoing') {
      return `your ${lowerFirst(outgoingsById.get(change.outgoingId).label)} is gone`;
    }
    return `${euroText(model.shownPensions)} more goes into your pensions each year`;
  });
  const taxClause = taxDelta === 0
    ? ''
    : `, with your tax ${euroText(taxDelta)} ${taxDelta > 0 ? 'lower' : 'higher'}`;
  return `${capitalise(effect)}, but ${joinWithAnd(phrases)}${taxClause}.`;
}

/** One line per person saying which tax was used. Derived, never typed. */
function taxSourceLines(inputs, people) {
  const single = inputs.people.length === 1;
  return people.map((person) => {
    const name = single ? '' : ` for ${person.label}`;
    if (person.taxSource === 'stated') {
      const stated = inputs.people.find((entry) => entry.id === person.personId).statedTakeHome;
      return {
        personId: person.personId,
        source: 'stated',
        text: `Your tax${name} uses the take-home pay you gave, ${euroText(stated)} a year. `
          + 'The change each case makes to it is an estimate.'
      };
    }
    return {
      personId: person.personId,
      source: 'estimated',
      text: `Your tax${name} is an estimate of income tax, USC and PRSI.`
    };
  });
}

function taxSourceSentence(inputs, lines) {
  const stated = lines.filter((line) => line.source === 'stated');
  if (stated.length === 0) {
    return 'Your tax is an estimate of income tax, USC and PRSI.';
  }
  if (stated.length === lines.length) {
    return 'Your tax uses the take-home pay you gave. The change each case makes to it is an estimate.';
  }
  const label = (line) => personLabelFor(inputs.people.find((person) => person.id === line.personId));
  const estimated = lines.filter((line) => line.source === 'estimated');
  return `Your tax uses the take-home pay you gave for ${label(stated[0])} and an estimate for ${label(estimated[0])}. `
    + 'The change each case makes to it is an estimate.';
}

function householdTaxStatusText(inputs) {
  if (inputs.taxStatusDefaulted) {
    return inputs.people.length > 1
      ? 'Not given, so each of you is assessed as single'
      : 'Single';
  }
  if (inputs.taxStatus === 'married_or_civil_partners') {
    return 'Married or civil partners, assessed together';
  }
  if (inputs.taxStatus === 'widowed_or_surviving_civil_partner') {
    return 'Widowed or a surviving civil partner';
  }
  return 'Single';
}

function renderDisclosureRows(inputs, year, models) {
  const estimates = models.map((model) => model.estimate).filter((entry) => !entry.injected);
  if (estimates.length === 0) {
    return { rows: [], codes: [] };
  }
  let disclosures = mergeDisclosures(estimates.flatMap((entry) => entry.disclosures || []));
  if (inputs.taxStatusDefaulted && inputs.people.length > 1) {
    disclosures = mergeDisclosures(disclosures.map((entry) => (
      entry.code === 'STATUS_SINGLE' ? { code: 'STATUS_DEFAULT_SINGLE' } : entry
    )));
  }
  const rules = resolveTaxRules(year);
  const rendered = renderTaxDisclosures(disclosures, { rules });
  // One row per code, so two entries under one code do not read as one.
  const byCode = new Map();
  rendered.forEach((entry) => {
    const existing = byCode.get(entry.code);
    byCode.set(entry.code, existing ? { ...existing, text: `${existing.text} ${entry.text}` } : entry);
  });
  return {
    rows: Array.from(byCode.values()).map((entry) => [entry.label, entry.text]),
    codes: disclosures.map((entry) => entry.code)
  };
}

function buildAssumptionsTable(inputs, year, models, lines, disclosureRows) {
  const rows = [
    ['One year', 'Every figure is for one ordinary year, in today’s money.'],
    ['Your income before tax', `${euroText(inputs.incomeTotal)} a year`],
    ['Tax year', String(year)],
    ['Your tax status', householdTaxStatusText(inputs)]
  ];
  lines.forEach((line) => rows.push(['Where your tax comes from', line.text]));
  rows.push(
    ['Your take-home pay', 'Your income after income tax, USC and PRSI, before any pension contribution a case adds.'],
    ['Pension contributions', 'Shown in full. The income tax relief on them shows as lower tax.']
  );
  if (models.some((model) => model.people.some((person) => person.basis === 'allocated'))) {
    rows.push([
      'Income tax for a couple',
      'Income tax is assessed together for the two of you, so it is split between you by income. '
        + 'Each of your take-home figures is an allocation, not a payslip figure.'
    ]);
  }
  rows.push(['Rounding', 'Amounts are shown to the nearest €100.']);
  disclosureRows.rows.forEach((row) => rows.push(row));
  if (disclosureRows.rows.length > 0) {
    rows.push(['Not included in tax estimates', TAX_NOT_INCLUDED.map((entry) => entry.text).join(' ')]);
  }
  return { columns: ['Assumption', 'Input Used'], rows };
}

function buildOutputsTable(models) {
  return {
    columns: ['Case', 'Tax (€)', 'Pensions (€)', 'Other outgoings (€)', 'Left over (€)', 'A month'],
    rows: models.map((model) => [
      model.scenario.title,
      model.shownTax,
      model.shownPensions,
      model.shownStated,
      model.shownLeftOver,
      model.monthly.text
    ])
  };
}

function buildTables(models) {
  return models.map((model) => ({
    title: `${model.scenario.title}: where a year goes`,
    columns: ['Line', 'Amount (€)', 'Against today (€)'],
    rows: [
      ['Your income before tax', model.shownIncome, ''],
      ...model.shownLines.map((line) => [line.label, line.shownAmount, line.deltaVsToday]),
      ['Left over', model.shownLeftOver, model.shownLeftOver - model.todayShownLeftOver]
    ]
  }));
}

function buildCharts(baseModel, drawnLines) {
  return [{
    title: 'Where a year of your income goes',
    subtitle: `For “${baseModel.scenario.title}”.`,
    type: 'bar',
    labels: ['Your income before tax', ...drawnLines.map((line) => line.label), 'Left over'],
    datasets: [{
      label: 'A year',
      data: [
        baseModel.shownIncome,
        ...drawnLines.map((line) => baseModel.shownLines.find((entry) => entry.id === line.id).shownAmount),
        baseModel.shownLeftOver
      ]
    }],
    display: {
      variant: 'wide',
      valueFormat: 'currency',
      yAxisTitle: 'A year'
    }
  }];
}

/**
 * Solve every case of a payload.
 *
 * @param {object} rawInputs `generated.householdCashFlowInputs`
 * @param {object} [options]
 * @param {Function} [options.taxFor] Test injection: replaces the tax engine. Called with
 *   `{ caseId, year, status, people, income, contributions }`; returns tax by person id.
 * @param {number} [options.calculationYear] The tax year.
 */
export function computeHouseholdCashFlowProjection(rawInputs, options = {}) {
  const inputs = normalizeHouseholdCashFlowInputs(rawInputs);
  const year = resolveYear(inputs, options);
  const { models, hasPensionColumn, outgoingsById, injected } = buildCaseModels(inputs, year, options);

  // A line that is 0 in every case is not drawn, and Pensions is a column only
  // when some case adds one, so a slot is stable across cases.
  const drawnStated = inputs.outgoings.filter((line) => (
    models.some((model) => model.statedLines.find((entry) => entry.id === line.id).amount !== 0)
  ));

  models.forEach((model) => {
    model.shownIncome = roundToHundred(inputs.incomeTotal);
    model.shownTax = roundToHundred(model.taxTotal);
    model.shownPensions = roundToHundred(model.pensionsGross);
    model.shownLines = [
      { id: 'tax', label: 'Tax', kind: 'tax', amount: model.taxTotal, shownAmount: model.shownTax },
      { id: 'pensions', label: 'Pensions', kind: 'pensions', amount: model.pensionsGross, shownAmount: model.shownPensions },
      ...model.statedLines.map((line) => ({
        id: line.id,
        label: line.label,
        kind: 'stated',
        amount: line.amount,
        shownAmount: roundToHundred(line.amount)
      }))
    ];
    model.shownStated = model.shownLines
      .filter((line) => line.kind === 'stated')
      .reduce((sum, line) => sum + line.shownAmount, 0);
    model.shownOutgoings = model.shownLines.reduce((sum, line) => sum + line.shownAmount, 0);
    // Left over as SHOWN is shown income minus the shown lines, never rounded
    // alone, so the picture always adds up.
    model.shownLeftOver = model.shownIncome - model.shownOutgoings;
  });

  const today = models.find((model) => model.isBase);
  models.forEach((model, index) => {
    if (model.leftOver < -0.005) {
      throw new Error(
        `${FIELD}.scenarios[${index}] (${model.scenario.title}): leaves ${euroText(-model.leftOver)} less than `
        + 'nothing each year, which this screen does not draw yet.'
      );
    }
    model.todayShownLeftOver = today.shownLeftOver;
    model.shownLines.forEach((line) => {
      const todayLine = today.shownLines.find((entry) => entry.id === line.id);
      line.deltaVsToday = line.shownAmount - todayLine.shownAmount;
    });
    model.status = statusFor(model.shownLeftOver);
    model.monthly = monthlyFor(model.shownLeftOver);
  });
  models.forEach((model) => {
    model.sentence = buildSentence({ model, today, outgoingsById });
  });

  const lines = taxSourceLines(inputs, today.people);
  const disclosureRows = renderDisclosureRows(inputs, year, models);
  const footnote = `Your income before tax is ${euroText(inputs.incomeTotal)} a year. `
    + `${taxSourceSentence(inputs, lines)} Amounts are rounded to the nearest €100.`;

  const warnings = [];
  inputs.people.forEach((person, index) => {
    if (person.statedTakeHome === null) {
      return;
    }
    const estimated = today.people.find((entry) => entry.personId === person.id).estimatedTakeHome;
    if (estimated > 0 && Math.abs(person.statedTakeHome - estimated) / estimated > STATED_TAKE_HOME_WARNING_SHARE) {
      warnings.push(
        `${FIELD}.people[${index}] (${personLabelFor(person)}): statedTakeHome (${euroText(person.statedTakeHome)}) `
        + `differs from the estimate (${euroText(estimated)}) by more than ${Math.round(STATED_TAKE_HOME_WARNING_SHARE * 100)}%.`
      );
    }
  });

  const drawnLines = [
    { id: 'tax', label: 'Tax' },
    ...(hasPensionColumn ? [{ id: 'pensions', label: 'Pensions' }] : []),
    ...drawnStated.map((line) => ({ id: line.id, label: line.label }))
  ];

  const summary = {
    calculationYear: year,
    baseCaseId: today.scenario.id,
    period: 'year',
    currency: 'EUR',
    taxStatus: inputs.taxStatus,
    taxStatusDefaulted: inputs.taxStatusDefaulted,
    cases: models.map((model) => ({
      id: model.scenario.id,
      title: model.scenario.title,
      income: {
        total: inputs.incomeTotal,
        byPerson: inputs.people.map((person) => ({ personId: person.id, gross: inputs.grossByPerson[person.id] }))
      },
      takeHome: {
        total: model.people.reduce((sum, person) => sum + person.takeHome, 0),
        byPerson: model.people.map((person) => ({
          personId: person.personId,
          gross: person.gross,
          tax: person.tax,
          takeHome: person.takeHome,
          taxSource: person.taxSource,
          basis: person.basis,
          estimatedTakeHome: person.estimatedTakeHome
        }))
      },
      outgoings: {
        tax: model.taxTotal,
        pensionContributions: model.pensionsGross,
        stated: model.statedLines.map((line) => ({ id: line.id, label: line.label, amount: line.amount })),
        statedTotal: model.statedTotal,
        total: model.totalOutgoings
      },
      pensionContributions: {
        gross: model.pensionsGross,
        taxRelief: model.taxRelief,
        costAfterRelief: model.pensionsGross - model.taxRelief
      },
      leftOver: {
        amount: model.leftOver,
        shown: model.shownLeftOver,
        monthly: model.monthly.amount,
        status: model.status
      }
    }))
  };

  return {
    assumptionsTable: buildAssumptionsTable(inputs, year, models, lines, disclosureRows),
    outputsTable: buildOutputsTable(models),
    tables: buildTables(models),
    charts: buildCharts(today, drawnLines),
    summary,
    debug: {
      inputs,
      baseScenarioId: today.scenario.id,
      hasPensionColumn,
      drawnLines,
      cases: models.map((model) => {
        let levelUnrounded = inputs.incomeTotal;
        let levelShown = model.shownIncome;
        const levels = [{ id: 'income', level: levelUnrounded }];
        const shownLevels = [{ id: 'income', level: levelShown }];
        drawnLines.forEach((drawn) => {
          const line = model.shownLines.find((entry) => entry.id === drawn.id);
          levelUnrounded -= line.amount;
          levelShown -= line.shownAmount;
          levels.push({ id: drawn.id, level: levelUnrounded });
          shownLevels.push({ id: drawn.id, level: levelShown });
        });
        return {
          id: model.scenario.id,
          title: model.scenario.title,
          description: model.scenario.description,
          changes: model.scenario.changes,
          isBase: model.isBase,
          lines: model.shownLines.map((line) => ({
            id: line.id,
            label: line.label,
            amount: line.amount,
            shownAmount: line.shownAmount,
            deltaVsToday: line.deltaVsToday
          })),
          levels,
          shownLevels,
          income: inputs.incomeTotal,
          shownIncome: model.shownIncome,
          leftOver: model.leftOver,
          shownLeftOver: model.shownLeftOver,
          monthly: model.monthly,
          status: model.status,
          sentence: model.sentence,
          taxBreakdown: injected ? null : {
            estimatedTotal: model.taxEstimatedTotal,
            byPerson: model.people.map((person) => ({
              personId: person.personId,
              estimatedTax: person.estimatedTax,
              usc: person.usc,
              prsi: person.prsi
            })),
            unitIncomeTax: model.estimate.units.map((unit) => ({
              personIds: unit.personIds,
              incomeTax: unit.incomeTax
            }))
          },
          disclosureCodes: model.estimate.disclosureCodes
        };
      }),
      assumptionsUsed: {
        taxRulesVersion: injected ? null : today.estimate.rulesVersion,
        taxRulesYear: today.estimate.rulesYear,
        calculationYear: year,
        assumptionsVersion: PLANEIR_ASSUMPTIONS_VERSION,
        taxStatus: inputs.taxStatus,
        taxStatusDefaulted: inputs.taxStatusDefaulted,
        taxSourceByPerson: Object.fromEntries(today.people.map((person) => [person.personId, person.taxSource]))
      },
      taxSourceLines: lines,
      footnote,
      warnings,
      disclosureCodes: disclosureRows.codes
    }
  };
}
