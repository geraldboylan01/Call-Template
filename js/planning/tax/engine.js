/**
 * The Irish tax engine: one household, one tax year.
 *
 * Deterministic and pure. `computeTaxYear` takes the carried state and one
 * year's income and events, runs the heads in a fixed order (pension events
 * first, then income tax, USC and PRSI) and returns the result with the state
 * that follows. It never changes what it was given.
 *
 * This is the one place tax is calculated. The retirement module, the cashflow
 * module to come, Reports and scripts all call it (directly, or through
 * `scripts/ie-tax.mjs`), and none of them keeps its own copy of a rule.
 */

import { PLANEIR_ASSUMPTIONS_VERSION } from '../planeir_assumptions.js';
import { resolveTaxRules } from './resolve.js';
import { DISCLOSURE_ORDER } from './disclosures.js';
import { lumpSumHead } from './heads/lump_sum.js';
import { sftHead } from './heads/sft.js';
import { arfImputedHead } from './heads/arf_imputed.js';
import { incomeTaxHead } from './heads/income_tax.js';
import { uscHead } from './heads/usc.js';
import { prsiHead } from './heads/prsi.js';

export const TAX_STATUSES = Object.freeze([
  'single',
  'married_or_civil_partners',
  'widowed_or_surviving_civil_partner'
]);

/** Income a caller may enter in Phase 1. */
const TAX_ITEM_TYPES = Object.freeze([
  'statePension',
  'occupationalPension',
  'arfDistribution',
  'employment',
  'employmentPensionContribution',
  'rentalProfit'
]);

/** Events a caller may enter in Phase 1. */
const TAX_EVENT_TYPES = Object.freeze(['benefitCrystallisation']);

/**
 * Types that belong to tax heads not built yet (brief, Part B). They are named
 * here so they can be refused clearly: an untaxed result for any of them would
 * look like an answer and be wrong.
 */
export const TAX_UNSUPPORTED_TYPES = Object.freeze([
  'depositInterest',
  'fundDisposal',
  'fundDeemedDisposal',
  'fundDistribution',
  'shareDisposal',
  'dividend',
  'propertyDisposal',
  'giftMade',
  'giftReceived',
  'inheritanceReceived',
  'death'
]);

/** Created by the engine from a crystallisation, never entered. */
const ENGINE_ONLY_ITEM_TYPES = Object.freeze(['lumpSumScheduleE']);

/** The fixed running order (brief, 3.1): pension events first, then income tax, USC and PRSI. */
const TAX_HEADS = Object.freeze([lumpSumHead, sftHead, arfImputedHead, incomeTaxHead, uscHead, prsiHead]);
const PENSION_EVENT_HEADS = Object.freeze(TAX_HEADS.filter((head) => head.phase === 'pension_events'));

const STANDING_DISCLOSURES = Object.freeze([
  'TAX_ESTIMATE',
  'TAX_RULES_HELD',
  'TAX_LEGISLATED_CHANGES',
  'TAX_RESIDENCE',
  'TAX_CREDITS_INCLUDED',
  'TAX_AGE_RULE'
]);

const JOINT_PERSON_ID = 'joint';
const MAX_AGE = 150;

/* ------------------------------------------------------------ validation */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireNonNegativeNumber(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a number greater than or equal to 0.`);
  }
  return value;
}

function unsupportedTypeError(fieldName, type) {
  return new Error(
    `${fieldName} "${type}" is not supported yet. It belongs to a tax head that has not been built, `
    + 'so no tax can be estimated for it.'
  );
}

function normalizePerson(raw, index, year) {
  const field = `input.people[${index}]`;
  if (!isPlainObject(raw)) {
    throw new Error(`${field} must be an object.`);
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) {
    throw new Error(`${field}.id must be a non-empty string.`);
  }
  if (id === JOINT_PERSON_ID) {
    throw new Error(`${field}.id cannot be "${JOINT_PERSON_ID}", which means an item shared by two people.`);
  }

  const hasAge = typeof raw.age !== 'undefined';
  const hasBirthYear = typeof raw.birthYear !== 'undefined';
  if (!hasAge && !hasBirthYear) {
    throw new Error(`${field} must include age or birthYear.`);
  }
  // A projection runs to the younger partner's 100th birthday, so the older
  // one can be well past 100 in its last years; only impossible ages are refused.
  if (hasAge && (!Number.isInteger(raw.age) || raw.age < 0 || raw.age > MAX_AGE)) {
    throw new Error(`${field}.age must be a whole number between 0 and ${MAX_AGE}.`);
  }
  if (hasBirthYear && (!Number.isInteger(raw.birthYear) || raw.birthYear > year)) {
    throw new Error(`${field}.birthYear must be a whole year no later than ${year}.`);
  }
  const age = hasAge ? raw.age : year - raw.birthYear;
  const birthYear = hasBirthYear ? raw.birthYear : year - raw.age;
  if (year - birthYear !== age) {
    throw new Error(
      `${field}.age ${age} does not match birthYear ${birthYear} in ${year}: `
      + 'age is the age attained during the tax year.'
    );
  }
  if (typeof raw.receivingStatePensionContributory !== 'undefined'
    && typeof raw.receivingStatePensionContributory !== 'boolean') {
    throw new Error(`${field}.receivingStatePensionContributory must be true or false when provided.`);
  }

  return {
    id,
    age,
    birthYear,
    receivingStatePensionContributory: raw.receivingStatePensionContributory === true
  };
}

function checkItemType(type, fieldName, allowed) {
  if (typeof type !== 'string' || !type) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  if (TAX_UNSUPPORTED_TYPES.includes(type)) {
    throw unsupportedTypeError(fieldName, type);
  }
  if (ENGINE_ONLY_ITEM_TYPES.includes(type)) {
    throw new Error(`${fieldName} "${type}" is created by the engine from a benefitCrystallisation event and cannot be entered directly.`);
  }
  if (!allowed.includes(type)) {
    throw new Error(`${fieldName} "${type}" is not a recognised type. Use one of: ${allowed.join(', ')}.`);
  }
}

/**
 * Check one year's input and put it in the shape the heads read. Every error
 * names the field that caused it.
 */
function normalizeTaxYearInput(input) {
  if (!isPlainObject(input)) {
    throw new Error('input must be an object.');
  }
  const year = input.year;
  if (typeof year !== 'number' || !Number.isInteger(year)) {
    throw new Error('input.year must be an integer tax year.');
  }
  if (!TAX_STATUSES.includes(input.status)) {
    throw new Error(`input.status must be one of: ${TAX_STATUSES.join(', ')}.`);
  }
  if (!Array.isArray(input.people) || input.people.length === 0) {
    throw new Error('input.people must list one or two people.');
  }
  if (input.people.length > 2) {
    throw new Error(`input.people must list one or two people; received ${input.people.length}.`);
  }
  if (input.status === 'widowed_or_surviving_civil_partner' && input.people.length !== 1) {
    throw new Error('input.status widowed_or_surviving_civil_partner describes one person; input.people must list exactly one.');
  }

  const people = input.people.map((raw, index) => normalizePerson(raw, index, year));
  const ids = new Set();
  people.forEach((person, index) => {
    if (ids.has(person.id)) {
      throw new Error(`input.people[${index}].id "${person.id}" is used twice.`);
    }
    ids.add(person.id);
  });

  const items = typeof input.items === 'undefined' ? [] : input.items;
  if (!Array.isArray(items)) {
    throw new Error('input.items must be an array when provided.');
  }
  const normalizedItems = items.map((raw, index) => {
    const field = `input.items[${index}]`;
    if (!isPlainObject(raw)) {
      throw new Error(`${field} must be an object.`);
    }
    checkItemType(raw.type, `${field}.type`, TAX_ITEM_TYPES);
    const personId = typeof raw.personId === 'string' ? raw.personId.trim() : '';
    if (personId === JOINT_PERSON_ID) {
      if (people.length !== 2) {
        throw new Error(`${field}.personId "${JOINT_PERSON_ID}" splits an item between two people, but input.people lists one.`);
      }
    } else if (!ids.has(personId)) {
      throw new Error(`${field}.personId must match an id in input.people, or be "${JOINT_PERSON_ID}".`);
    }
    const amount = requireNonNegativeNumber(raw.amount, `${field}.amount`);
    const normalized = { type: raw.type, personId, amount };
    if (typeof raw.imputedMinimum !== 'undefined') {
      if (raw.type !== 'arfDistribution') {
        throw new Error(`${field}.imputedMinimum applies only to an arfDistribution item.`);
      }
      normalized.imputedMinimum = requireNonNegativeNumber(raw.imputedMinimum, `${field}.imputedMinimum`);
      if (normalized.imputedMinimum > amount + 1e-9) {
        throw new Error(`${field}.imputedMinimum cannot be more than the amount withdrawn, because the minimum is modelled as taken.`);
      }
    }
    return normalized;
  });

  const events = typeof input.events === 'undefined' ? [] : input.events;
  if (!Array.isArray(events)) {
    throw new Error('input.events must be an array when provided.');
  }
  const normalizedEvents = events.map((raw, index) => {
    const field = `input.events[${index}]`;
    if (!isPlainObject(raw)) {
      throw new Error(`${field} must be an object.`);
    }
    checkItemType(raw.type, `${field}.type`, TAX_EVENT_TYPES);
    const personId = typeof raw.personId === 'string' ? raw.personId.trim() : '';
    if (!ids.has(personId)) {
      throw new Error(`${field}.personId must match an id in input.people.`);
    }
    const fundValue = requireNonNegativeNumber(raw.fundValue, `${field}.fundValue`);
    const lumpSum = typeof raw.lumpSum === 'undefined'
      ? 0
      : requireNonNegativeNumber(raw.lumpSum, `${field}.lumpSum`);
    if (lumpSum > fundValue) {
      throw new Error(`${field}.lumpSum of ${lumpSum} is more than its fundValue of ${fundValue}.`);
    }
    return { type: raw.type, personId, fundValue, lumpSum };
  });

  return {
    year,
    status: input.status,
    people,
    items: normalizedItems,
    events: normalizedEvents
  };
}

/* ----------------------------------------------------------------- state */

function emptyPersonState() {
  return {
    lumpSumsSince2005: 0,
    sftUsed: 0,
    unrelievedLumpSumTax: 0,
    // Reserved for Part B. Carried unchanged until those heads exist.
    cgtLossesCarriedForward: 0,
    revisedEntrepreneurReliefUsed: 0,
    catReceivedByGroup: { A: 0, B: 0, C: 0 },
    fundLots: []
  };
}

function normalizePersonState(raw, fieldName) {
  const next = emptyPersonState();
  if (typeof raw === 'undefined' || raw === null) {
    return next;
  }
  if (!isPlainObject(raw)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  ['lumpSumsSince2005', 'sftUsed', 'unrelievedLumpSumTax', 'cgtLossesCarriedForward', 'revisedEntrepreneurReliefUsed']
    .forEach((key) => {
      if (typeof raw[key] !== 'undefined') {
        next[key] = requireNonNegativeNumber(raw[key], `${fieldName}.${key}`);
      }
    });
  if (typeof raw.catReceivedByGroup !== 'undefined') {
    if (!isPlainObject(raw.catReceivedByGroup)) {
      throw new Error(`${fieldName}.catReceivedByGroup must be an object with A, B and C.`);
    }
    ['A', 'B', 'C'].forEach((group) => {
      if (typeof raw.catReceivedByGroup[group] !== 'undefined') {
        next.catReceivedByGroup[group] = requireNonNegativeNumber(
          raw.catReceivedByGroup[group],
          `${fieldName}.catReceivedByGroup.${group}`
        );
      }
    });
  }
  if (typeof raw.fundLots !== 'undefined') {
    if (!Array.isArray(raw.fundLots)) {
      throw new Error(`${fieldName}.fundLots must be an array.`);
    }
    next.fundLots = raw.fundLots.length > 0 ? JSON.parse(JSON.stringify(raw.fundLots)) : [];
  }
  return next;
}

/**
 * A fresh, serialisable state for these people: nothing paid, nothing used.
 * Pass per-person starting values to seed it, for example
 * `createTaxState({ john: { sftUsed: 400000 } })`.
 */
export function createTaxState(seed = {}) {
  const people = {};
  Object.entries(seed || {}).forEach(([id, values]) => {
    people[id] = normalizePersonState(values, `state.people.${id}`);
  });
  return { people };
}

/** A private copy of the state, with an entry for everyone in this year's input. */
function copyState(state, personIds) {
  if (typeof state !== 'undefined' && state !== null && !isPlainObject(state)) {
    throw new Error('state must be an object when provided.');
  }
  const source = state?.people;
  if (typeof source !== 'undefined' && !isPlainObject(source)) {
    throw new Error('state.people must be an object.');
  }
  const people = {};
  Object.keys(source || {}).forEach((id) => {
    people[id] = normalizePersonState(source[id], `state.people.${id}`);
  });
  personIds.forEach((id) => {
    if (!people[id]) {
      people[id] = emptyPersonState();
    }
  });
  return { people };
}

/* ---------------------------------------------------------------- context */

function emptyIncome() {
  return {
    statePension: 0,
    occupationalPension: 0,
    arfDistribution: 0,
    employment: 0,
    employmentPensionContribution: 0,
    rentalProfit: 0,
    lumpSumScheduleE: 0
  };
}

function buildPeople(normalized) {
  const people = normalized.people.map((person) => ({
    ...person,
    income: emptyIncome(),
    imputedMinimum: 0
  }));
  const personById = new Map(people.map((person) => [person.id, person]));

  normalized.items.forEach((item) => {
    const owners = item.personId === JOINT_PERSON_ID ? people : [personById.get(item.personId)];
    const share = item.amount / owners.length;
    owners.forEach((owner) => {
      owner.income[item.type] += share;
      if (item.imputedMinimum) {
        owner.imputedMinimum += item.imputedMinimum / owners.length;
      }
    });
  });

  people.forEach((person, index) => {
    if (person.income.employmentPensionContribution > person.income.employment + 1e-9) {
      throw new Error(
        `input.people[${index}] (${person.id}) has an employmentPensionContribution of `
        + `${person.income.employmentPensionContribution}, more than the employment income of ${person.income.employment}.`
      );
    }
  });

  return { people, personById };
}

function buildAssessmentUnits(status, people) {
  if (status === 'married_or_civil_partners') {
    return [{ basis: 'joint', people }];
  }
  if (status === 'widowed_or_surviving_civil_partner') {
    return [{ basis: 'widowed', people }];
  }
  return people.map((person) => ({ basis: 'single', people: [person] }));
}

function statusDisclosures(status, peopleCount) {
  if (status === 'married_or_civil_partners') {
    return peopleCount === 1
      ? [{ code: 'STATUS_JOINT' }, { code: 'STATUS_SPOUSE_NO_INCOME' }]
      : [{ code: 'STATUS_JOINT' }];
  }
  if (status === 'widowed_or_surviving_civil_partner') {
    return [{ code: 'STATUS_WIDOWED' }];
  }
  return [{ code: 'STATUS_SINGLE' }];
}

function runIncomeHeads(rules, status, people) {
  const context = {
    rules,
    status,
    people,
    assessmentUnits: buildAssessmentUnits(status, people)
  };
  return {
    incomeTax: incomeTaxHead.compute(context),
    usc: uscHead.compute(context),
    prsi: prsiHead.compute(context)
  };
}

function withoutScheduleE(people) {
  return people.map((person) => ({
    ...person,
    income: { ...person.income, lumpSumScheduleE: 0 }
  }));
}

/* ------------------------------------------------------------ disclosures */

const DISCLOSURE_RANK = new Map(DISCLOSURE_ORDER.map((code, index) => [code, index]));

function mergeParams(existing, incoming) {
  if (!incoming) {
    return existing;
  }
  if (!existing) {
    return { ...incoming, ...(Array.isArray(incoming.years) ? { years: [...incoming.years] } : {}) };
  }
  if (Array.isArray(existing.years) && Array.isArray(incoming.years)) {
    return { ...existing, years: [...new Set([...existing.years, ...incoming.years])].sort((a, b) => a - b) };
  }
  return existing;
}

/** What makes two disclosures the same one: the code and every parameter except the years. */
function disclosureKey(code, params) {
  if (!params) {
    return code;
  }
  const { years, ...rest } = params;
  void years;
  return `${code}:${JSON.stringify(rest)}`;
}

/**
 * One entry per distinct disclosure, in catalogue order. Entries that differ
 * only in the years they apply to are merged into one listing every year;
 * entries that differ in anything else (two thresholds) stay separate.
 */
export function mergeDisclosures(list) {
  const byKey = new Map();
  list.forEach((entry) => {
    if (!entry?.code) {
      return;
    }
    const params = entry.params || null;
    const key = disclosureKey(entry.code, params);
    byKey.set(key, { code: entry.code, params: mergeParams(byKey.get(key)?.params || null, params) });
  });
  return [...byKey.values()].sort((left, right) => (
    (DISCLOSURE_RANK.get(left.code) ?? 999) - (DISCLOSURE_RANK.get(right.code) ?? 999)
  ));
}

/* ---------------------------------------------------------------- compute */

function sumIncome(people, pick) {
  return people.reduce((total, person) => total + pick(person.income), 0);
}

function recurringGrossIncome(income) {
  return income.statePension
    + income.occupationalPension
    + income.arfDistribution
    + income.employment
    + income.rentalProfit;
}

/**
 * Tax for one household year.
 *
 * @param {object} args
 * @param {object} [args.state] Carried state from the previous year (3.3).
 * @param {object} args.input One year's people, items and events (3.2).
 * @param {object} [args.assumptions] Planéir assumptions in force; only the version is read.
 * @returns {{ result: object, nextState: object }}
 */
export function computeTaxYear({ state = null, input, assumptions = null } = {}) {
  const normalized = normalizeTaxYearInput(input);
  const rules = resolveTaxRules(normalized.year);
  const workingState = copyState(state, normalized.people.map((person) => person.id));
  const { people, personById } = buildPeople(normalized);

  const crystallisations = normalized.events.map((event) => ({
    personId: event.personId,
    year: normalized.year,
    fundValue: event.fundValue,
    lumpSum: event.lumpSum,
    priorLumpSums: workingState.people[event.personId].lumpSumsSince2005,
    lumpSumTaxFree: 0,
    lumpSumStandardRatePart: 0,
    lumpSumTax: 0,
    scheduleE: 0
  }));

  const context = {
    year: normalized.year,
    rules,
    status: normalized.status,
    people,
    personById,
    crystallisations,
    state: workingState
  };

  const lines = [];
  const disclosures = [
    ...STANDING_DISCLOSURES.map((code) => ({ code })),
    ...statusDisclosures(normalized.status, people.length)
  ];
  if (normalized.items.some((item) => item.type === 'rentalProfit' && item.personId === JOINT_PERSON_ID && item.amount > 0)) {
    disclosures.push({ code: 'RENT_SPLIT_JOINT' });
  }

  PENSION_EVENT_HEADS.forEach((head) => {
    const outcome = head.compute(context);
    lines.push(...outcome.lines);
    disclosures.push(...outcome.disclosures);
  });

  const heads = runIncomeHeads(rules, normalized.status, people);
  Object.values(heads).forEach((outcome) => {
    lines.push(...outcome.lines);
    disclosures.push(...outcome.disclosures);
  });

  const incomeTax = heads.incomeTax.total;
  const usc = heads.usc.total;
  const prsi = heads.prsi.total;

  // Tax the Schedule E part of a lump sum causes is paid out of the lump sum
  // (brief, 7.2), so it is measured here and kept out of recurring net income.
  const scheduleETotal = sumIncome(people, (income) => income.lumpSumScheduleE);
  let scheduleETax = 0;
  let recurring = { incomeTax, usc, prsi };
  if (scheduleETotal > 0) {
    const without = runIncomeHeads(rules, normalized.status, withoutScheduleE(people));
    recurring = { incomeTax: without.incomeTax.total, usc: without.usc.total, prsi: without.prsi.total };
    scheduleETax = (incomeTax + usc + prsi) - (recurring.incomeTax + recurring.usc + recurring.prsi);
    crystallisations.forEach((record) => {
      record.scheduleETax = record.scheduleE > 0 ? scheduleETax * (record.scheduleE / scheduleETotal) : 0;
    });
  }
  crystallisations.forEach((record) => {
    record.scheduleETax = record.scheduleETax || 0;
    record.netLumpSum = record.lumpSum - record.lumpSumTax - record.scheduleETax - (record.cetPaidFromLumpSum || 0);
  });

  const lumpSumTax = crystallisations.reduce((total, record) => total + record.lumpSumTax, 0);
  const chargeableExcessTax = crystallisations.reduce((total, record) => total + (record.netCet || 0), 0);
  const grossIncome = sumIncome(people, recurringGrossIncome);
  const recurringTax = incomeTax + usc + prsi - scheduleETax;
  const merged = mergeDisclosures(disclosures);
  const uscByPerson = new Map(heads.usc.byPerson.map((entry) => [entry.personId, entry]));
  const prsiByPerson = new Map(heads.prsi.byPerson.map((entry) => [entry.personId, entry]));

  const result = {
    year: normalized.year,
    status: normalized.status,
    rulesVersion: rules.version,
    rulesYear: rules.rulesYear,
    heldForward: rules.heldForward,
    rulesStatus: rules.status,
    enactedBy: rules.enactedBy,
    sftBasis: rules.sftBasis,
    prsiRate: rules.prsi.rate,
    assumptionsVersion: assumptions?.version || PLANEIR_ASSUMPTIONS_VERSION,
    people: people.map((person) => ({
      id: person.id,
      age: person.age,
      birthYear: person.birthYear,
      receivingStatePensionContributory: person.receivingStatePensionContributory,
      income: { ...person.income },
      grossIncome: recurringGrossIncome(person.income),
      usc: uscByPerson.get(person.id),
      prsi: prsiByPerson.get(person.id)
    })),
    assessments: heads.incomeTax.assessments,
    crystallisations,
    totals: {
      grossIncome,
      incomeTax,
      usc,
      prsi,
      lumpSumTax,
      chargeableExcessTax,
      lumpSumScheduleETax: scheduleETax,
      totalTax: incomeTax + usc + prsi + lumpSumTax + chargeableExcessTax,
      // Income tax, USC and PRSI on the year's recurring income alone: what
      // the year would owe without the Schedule E part of a lump sum.
      recurring,
      recurringTax,
      netIncome: grossIncome - recurringTax
    },
    lines,
    disclosures: merged,
    disclosureCodes: [...new Set(merged.map((entry) => entry.code))]
  };

  return { result, nextState: workingState };
}

/* --------------------------------------------------------------- marginal */

const MARGINAL_HEADS = Object.freeze(['incomeTax', 'usc', 'prsi', 'lumpSumTax', 'chargeableExcessTax']);

function withDelta(input, delta) {
  if (!isPlainObject(delta)) {
    throw new Error('delta must be one item or one event.');
  }
  if (TAX_EVENT_TYPES.includes(delta.type)) {
    return { ...input, events: [...(input.events || []), delta] };
  }
  return { ...input, items: [...(input.items || []), delta] };
}

/**
 * The extra tax, by head, from adding one item or event to a year. It is the
 * difference between two full calculations, so it is exact to the cent.
 */
export function marginalTax({ state = null, input, delta, assumptions = null } = {}) {
  const base = computeTaxYear({ state, input, assumptions });
  const changed = computeTaxYear({ state, input: withDelta(input, delta), assumptions });
  const byHead = Object.fromEntries(MARGINAL_HEADS.map((head) => [
    head,
    changed.result.totals[head] - base.result.totals[head]
  ]));
  return {
    byHead,
    total: changed.result.totals.totalTax - base.result.totals.totalTax,
    netIncomeChange: changed.result.totals.netIncome - base.result.totals.netIncome,
    base: base.result,
    withDelta: changed.result,
    nextState: changed.nextState
  };
}

/* ------------------------------------------------------------------ solve */

const SOLVER_MAX_ITERATIONS = 100;
const SOLVER_SEARCH_CEILING = 1e10;

/**
 * The amount that brings household net income to `targetNet`, within €1.
 *
 * `adjustable(amount)` returns the items that amount produces, so the caller
 * decides how it is split. Net income is piecewise linear in the amount, with
 * occasional downward steps where a USC threshold is crossed, so the search
 * brackets the target and closes in with a safeguarded secant step. A bracket
 * cannot close on a downward step, so it always ends on a real crossing.
 *
 * @returns {{ amount: number, netIncome: number, met: boolean, gap: number,
 *   surplus: number, result: object, nextState: object, iterations: number }}
 */
export function solveForNet({
  state = null,
  input,
  adjustable,
  targetNet,
  maxAmount = null,
  tolerance = 1,
  assumptions = null
} = {}) {
  if (typeof adjustable !== 'function') {
    throw new Error('adjustable must be a function from an amount to the items it produces.');
  }
  if (typeof targetNet !== 'number' || !Number.isFinite(targetNet)) {
    throw new Error('targetNet must be a finite number.');
  }
  if (maxAmount !== null && (typeof maxAmount !== 'number' || !Number.isFinite(maxAmount) || maxAmount < 0)) {
    throw new Error('maxAmount must be a number greater than or equal to 0 when provided.');
  }
  const baseItems = Array.isArray(input?.items) ? input.items : [];
  let iterations = 0;

  const evaluate = (amount) => {
    iterations += 1;
    const produced = adjustable(amount);
    if (!Array.isArray(produced)) {
      throw new Error('adjustable must return an array of items.');
    }
    const outcome = computeTaxYear({ state, input: { ...input, items: [...baseItems, ...produced] }, assumptions });
    return { amount, net: outcome.result.totals.netIncome, outcome };
  };

  const finish = (point, extra) => ({
    amount: point.amount,
    netIncome: point.net,
    result: point.outcome.result,
    nextState: point.outcome.nextState,
    iterations,
    ...extra
  });

  let low = evaluate(0);
  if (low.net >= targetNet) {
    return finish(low, { met: true, gap: 0, surplus: low.net - targetNet });
  }

  let high;
  if (maxAmount !== null) {
    high = evaluate(maxAmount);
    if (high.net < targetNet - tolerance) {
      return finish(high, { met: false, gap: targetNet - high.net, surplus: 0 });
    }
    if (high.net < targetNet) {
      return finish(high, { met: true, gap: 0, surplus: 0 });
    }
  } else {
    let guess = Math.max(1, (targetNet - low.net) * 2);
    high = evaluate(guess);
    while (high.net < targetNet) {
      if (guess >= SOLVER_SEARCH_CEILING) {
        throw new Error('solveForNet could not reach targetNet; pass maxAmount to cap the search.');
      }
      low = high;
      guess *= 2;
      high = evaluate(guess);
    }
  }

  // Stop at the cent, well inside the €1 the brief allows: on a straight
  // stretch the secant step lands exactly, so the extra precision is cheap.
  const precision = Math.min(tolerance, 0.01);
  // Weights used only to place the next guess. The Illinois step halves the
  // end that has not moved, so a bend in the curve cannot stall the search.
  let lowWeight = low.net - targetNet;
  let highWeight = high.net - targetNet;
  let side = 0;

  for (let step = 0; step < SOLVER_MAX_ITERATIONS; step += 1) {
    if (high.net - targetNet <= precision) {
      return finish(high, { met: true, gap: 0, surplus: 0 });
    }
    if (high.amount - low.amount < 0.005) {
      break;
    }
    let candidate = low.amount - (lowWeight * (high.amount - low.amount)) / (highWeight - lowWeight);
    if (!(candidate > low.amount && candidate < high.amount)) {
      candidate = (low.amount + high.amount) / 2;
    }
    const point = evaluate(candidate);
    const residual = point.net - targetNet;
    if (Math.abs(residual) <= precision) {
      return finish(point, { met: true, gap: 0, surplus: 0 });
    }
    if (residual < 0) {
      low = point;
      lowWeight = residual;
      if (side === -1) {
        highWeight /= 2;
      }
      side = -1;
    } else {
      high = point;
      highWeight = residual;
      if (side === 1) {
        lowWeight /= 2;
      }
      side = 1;
    }
  }

  const closest = Math.abs(high.net - targetNet) <= tolerance ? high : low;
  return finish(closest, {
    met: Math.abs(closest.net - targetNet) <= tolerance || closest.net >= targetNet,
    gap: Math.max(0, targetNet - closest.net),
    surplus: 0
  });
}
