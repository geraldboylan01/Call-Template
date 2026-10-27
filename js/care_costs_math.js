/**
 * Care costs: what nursing home care could cost, what Fair Deal asks of the
 * person, and what is left for the family, year by year.
 *
 * THE MODEL
 *
 * Every flow happens at the START of a year. For each year of care `k` (0-based)
 * the engine works out:
 *
 *   the fee            weekly fee x 52, grown from today at the central
 *                      education and healthcare rate, plus extras grown alike
 *   the contribution   what Fair Deal asks of the person that year, assessed
 *                      afresh each year from the savings left at the end of
 *                      the year before (`planning/care/fair_deal.js`)
 *   what is due        by the case's basis: `lower_of` pays the lower of the
 *                      contribution and the fee, `private_fee` the fee, and
 *                      `fair_deal_with_loan` defers the home part to the loan
 *   who pays it        the person's income, then their savings (as the case
 *                      says), then the family. The HSE pays fee less
 *                      contribution in a year Fair Deal applies.
 *   relief             the payer's fall in income tax from deducting the
 *                      nursing home part of the family's share, from the tax
 *                      engine (`nursingHomeExpenses`)
 *
 * This file stops at the family's yearly amounts before and after relief. What
 * needs the funding core (the lump sum now, the ways to pay) and the dated-cost
 * contract the plan reads are not built yet; `debug.notYetBuilt` lists them.
 *
 * WHERE THE RULES AND RATES COME FROM
 *
 * Nothing is typed into the payload. The Fair Deal rules are the dated
 * catalogue, the State Pension (Non-Contributory) rate is the social welfare
 * catalogue's at the date of the application, tax and relief come from the tax
 * engine, and the fee, its growth, prices and cash come from the central
 * assumptions. A payload that carries a rate, a percentage, a cap or a
 * disregard is refused.
 *
 * `options` exists so tests can inject a catalogue, the central assumptions, a
 * date, or the course's own conventions (a flat relief rate, no personal
 * allowance in a private year). It is never reachable from a payload.
 */

import { MAX_MODULE_SCENARIO_CASES } from './scenario_cap.js';
import { resolvePlanningAssumptions } from './planning/planeir_assumptions.js';
import { TAX_STATUSES, computeTaxYear } from './planning/tax/engine.js';
import { resolveTaxRules, withTaxCatalogue } from './planning/tax/resolve.js';
import { SOCIAL_WELFARE_RATES_VERSION } from './planning/social_welfare_ie.js';
import { socialWelfareRateOn } from './planning/social_welfare_rates.js';
import { FAIR_DEAL_RULES_VERSION, resolveFairDealRules } from './planning/care/fair_deal_rules_ie.js';
import { assessFairDeal } from './planning/care/fair_deal.js';

const FIELD = 'generated.careCostInputs';
const STATE_PENSION_SERIES = 'ie.social_welfare.state_pension_non_contributory.personal_66_to_79';
const WEEKS_IN_YEAR = 52;
const MAX_TAX_AGE = 150;
/** Savings that fall short of what they were asked for by less than this are not short. */
const SAVINGS_TOLERANCE_EUR = 0.01;

const MIN_AGE = 18;
const MAX_AGE = 115;
const MAX_LABEL_LENGTH = 24;
const MAX_TITLE_LENGTH = 60;
const MAX_STARTS_IN_YEARS = 40;
const MAX_DURATION_YEARS = 30;
const MAX_YEARS_IN_CARE_SO_FAR = 30;
const MAX_COMPARE_DURATIONS = 2;

const PERSON_INCOME_TYPES = Object.freeze([
  'statePension', 'occupationalPension', 'arfDistribution', 'employment', 'rentalProfit'
]);
const PAYER_INCOME_TYPES = Object.freeze([...PERSON_INCOME_TYPES, 'employmentPensionContribution']);

const BASES = Object.freeze(['lower_of', 'fair_deal_with_loan', 'private_fee']);
const PERSON_MONEY = Object.freeze(['first', 'alongside', 'kept']);
const FAMILY_FUNDING = Object.freeze(['each_year', 'lump_sum_now', 'save_then_pay']);
const CASE_FIELDS = Object.freeze(['id', 'title', 'description', 'basis', 'personMoney', 'familyFunding']);

/** A payload carrying any of these is refused: rules and rates are central, not typed. */
const REFUSED_FIELDS = Object.freeze([
  'feeGrowthRate', 'priceGrowthRate', 'savingsGrowthRate', 'inflationRate', 'dirtRate', 'cashRate',
  'assetRate', 'incomeShare', 'disregard', 'homeCapYears', 'capYears', 'statePensionRate',
  'reliefRate', 'flatReliefRate', 'privateAllowance'
]);

const TOP_LEVEL_FIELDS = Object.freeze([
  'personLabel', 'age', 'county', 'weeklyFee', 'weeklyExtras', 'couple', 'incomes', 'otherDeductions',
  'cash', 'home', 'homeRent', 'otherProperty', 'transferredInLastFiveYears', 'yearsInCareSoFar',
  'startsInYears', 'durationYears', 'compareDurations', 'payer', 'baseScenarioId', 'scenarios'
]);

/**
 * Text a payload supplies (the person's label, a case's title and description,
 * a property's label) reaches the screen, the video and the presenter as it is,
 * so it is held to the module's wording on the way in and not only in a test.
 * It describes and never recommends or ranks, and names no product, provider,
 * insurer or home.
 */
const BANNED_PHRASES = Object.freeze([
  /we\s+recommend/i,
  /you\s+should/i,
  /best\s+option/i,
  /\bbest\b/i,
  /\bideal\b/i,
  /\boptimal\b/i,
  /\bbetter\b/i,
  /\bworse\b/i,
  /\bcheapest\b/i,
  /p\.a\./i,
  /\bAIB\b/i,
  /\bBank\s+of\s+Ireland\b/i,
  /\bBOI\b/i,
  /\bPTSB\b/i,
  /\bPermanent\s+TSB\b/i,
  /\bRevolut\b/i,
  /\bZurich\b/i,
  /\bIrish\s+Life\b/i,
  /\bAviva\b/i,
  /\bVHI\b/i,
  /\bLaya\b/i,
  /\bBupa\b/i,
  /\bDavy\b/i,
  /\binsurance\b/i
]);

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A field is present when it is neither missing nor null, so a normalised payload normalises to itself. */
function present(raw, key) {
  return raw[key] !== undefined && raw[key] !== null;
}

function refuseForbiddenWording(text, where) {
  if (BANNED_PHRASES.some((pattern) => pattern.test(text)) || /€\d{4,}/.test(text)) {
    throw new Error(
      `${where} ("${text}"): this screen describes and never recommends or ranks, names no product, provider `
      + 'or home, and writes amounts with a thousands separator.'
    );
  }
}

function requireNumber(value, path, { min = 0, minExclusive = false, rangeText } = {}) {
  const tooLow = minExclusive ? value <= min : value < min;
  if (!isFiniteNumber(value) || tooLow) {
    throw new Error(`${path} must be a number ${rangeText ?? (minExclusive ? `greater than ${min}` : `of ${min} or more`)}.`);
  }
  return value;
}

function requireWholeNumber(value, path, { min, max, rangeText }) {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${path} must be a whole number${rangeText}.`);
  }
  return value;
}

function rejectUnknownKeys(raw, allowed, path) {
  Object.keys(raw).forEach((key) => {
    if (!allowed.includes(key)) {
      throw new Error(`${path}.${key} is not a care costs field.`);
    }
  });
}

function normalizeIncomes(raw, path, allowedTypes) {
  if (!Array.isArray(raw)) {
    throw new Error(`${path} must be an array of { type, grossAnnual }.`);
  }
  return raw.map((entry, index) => {
    const where = `${path}[${index}]`;
    if (!isPlainObject(entry)) {
      throw new Error(`${where} must be an object with a type and a grossAnnual.`);
    }
    rejectUnknownKeys(entry, ['type', 'grossAnnual'], where);
    if (!allowedTypes.includes(entry.type)) {
      throw new Error(`${where}.type must be one of: ${allowedTypes.join(', ')}.`);
    }
    return { type: entry.type, grossAnnual: requireNumber(entry.grossAnnual, `${where}.grossAnnual`) };
  });
}

function normalizePayer(raw, field) {
  if (!isPlainObject(raw)) {
    throw new Error(`${field}.payer must be an object with a taxStatus and people.`);
  }
  rejectUnknownKeys(raw, ['taxStatus', 'people'], `${field}.payer`);
  if (!TAX_STATUSES.includes(raw.taxStatus)) {
    throw new Error(`${field}.payer.taxStatus must be one of: ${TAX_STATUSES.join(', ')}.`);
  }
  if (!Array.isArray(raw.people) || raw.people.length < 1 || raw.people.length > 2) {
    throw new Error(`${field}.payer.people must list one or two people.`);
  }
  if (raw.people.length === 2 && raw.taxStatus !== 'married_or_civil_partners') {
    throw new Error(`${field}.payer.people lists two people, which only married_or_civil_partners describes.`);
  }
  const ids = new Set();
  const people = raw.people.map((person, index) => {
    const where = `${field}.payer.people[${index}]`;
    if (!isPlainObject(person)) {
      throw new Error(`${where} must be an object.`);
    }
    rejectUnknownKeys(person, ['id', 'age', 'incomes', 'retiresInYears', 'incomesAfterRetirement'], where);
    const id = typeof person.id === 'string' ? person.id.trim() : '';
    if (!id) {
      throw new Error(`${where}.id must be a non-empty string.`);
    }
    if (ids.has(id)) {
      throw new Error(`${where}.id must be unique.`);
    }
    ids.add(id);
    const normalized = {
      id,
      age: requireWholeNumber(person.age, `${where}.age`, { min: MIN_AGE, max: MAX_AGE, rangeText: ` from ${MIN_AGE} to ${MAX_AGE}` }),
      incomes: normalizeIncomes(person.incomes, `${where}.incomes`, PAYER_INCOME_TYPES),
      retiresInYears: null,
      incomesAfterRetirement: null
    };
    if (present(person, 'retiresInYears')) {
      normalized.retiresInYears = requireWholeNumber(person.retiresInYears, `${where}.retiresInYears`, {
        min: 0, max: 60, rangeText: ' of years from 0 to 60'
      });
      if (!present(person, 'incomesAfterRetirement')) {
        throw new Error(`${where}.incomesAfterRetirement is required when retiresInYears is given.`);
      }
    }
    if (present(person, 'incomesAfterRetirement')) {
      normalized.incomesAfterRetirement = normalizeIncomes(person.incomesAfterRetirement, `${where}.incomesAfterRetirement`, PAYER_INCOME_TYPES);
    }
    return normalized;
  });
  return { taxStatus: raw.taxStatus, people };
}

/** "Mam’s money first": the title a case gets when the payload gives none. */
function derivedCaseTitle(personLabel, { basis, personMoney }) {
  if (basis === 'private_fee') {
    return 'Paid privately, without Fair Deal';
  }
  if (basis === 'fair_deal_with_loan') {
    return 'With the Nursing Home Loan';
  }
  if (personMoney === 'alongside') {
    return `${personLabel}’s money alongside yours`;
  }
  if (personMoney === 'kept') {
    return `${personLabel}’s money kept`;
  }
  return `${personLabel}’s money first`;
}

function normalizeCase(rawCase, index, context) {
  const label = `scenarios[${index}]`;
  if (!isPlainObject(rawCase)) {
    throw new Error(`${FIELD}.${label} must be an object.`);
  }
  if (typeof rawCase.id !== 'string' || rawCase.id.trim() === '') {
    throw new Error(`${FIELD}.${label}.id must be a non-empty string.`);
  }
  const id = rawCase.id.trim();
  const basis = present(rawCase, 'basis') ? rawCase.basis : 'lower_of';
  const personMoney = rawCase.personMoney;
  const familyFunding = rawCase.familyFunding;

  const shown = typeof rawCase.title === 'string' && rawCase.title.trim() ? rawCase.title.trim() : id;
  Object.keys(rawCase).forEach((key) => {
    if (!CASE_FIELDS.includes(key)) {
      throw new Error(`${FIELD}.${label} (${shown}): "${key}" is not a case field.`);
    }
  });
  if (!BASES.includes(basis)) {
    throw new Error(`${FIELD}.${label} (${shown}): basis must be "lower_of", "fair_deal_with_loan" or "private_fee".`);
  }
  if (!PERSON_MONEY.includes(personMoney)) {
    throw new Error(`${FIELD}.${label} (${shown}): personMoney must be "first", "alongside" or "kept".`);
  }
  if (!FAMILY_FUNDING.includes(familyFunding)) {
    throw new Error(`${FIELD}.${label} (${shown}): familyFunding must be "each_year", "lump_sum_now" or "save_then_pay".`);
  }
  const title = typeof rawCase.title === 'string' && rawCase.title.trim()
    ? rawCase.title.trim()
    : derivedCaseTitle(context.personLabel, { basis, personMoney });
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error(`${FIELD}.${label} (${title}): title must be at most ${MAX_TITLE_LENGTH} characters.`);
  }
  refuseForbiddenWording(title, `${FIELD}.${label}.title`);
  if (familyFunding === 'save_then_pay' && context.startsInYears < 1) {
    throw new Error(`${FIELD}.${label} (${title}): save_then_pay needs care to start in a later year.`);
  }
  if (basis === 'fair_deal_with_loan' && !context.hasHome) {
    throw new Error(`${FIELD}.${label} (${title}): fair_deal_with_loan needs a home.`);
  }
  const description = typeof rawCase.description === 'string' ? rawCase.description.trim() : '';
  if (description) {
    refuseForbiddenWording(description, `${FIELD}.${label}.description`);
  }
  return { id, title, description, basis, personMoney, familyFunding };
}

/**
 * Validate a payload and return it in canonical form.
 *
 * Idempotent: normalising a normalised payload returns an equal one.
 */
export function normalizeCareCostInputs(raw, { assumptions = null } = {}) {
  if (!isPlainObject(raw)) {
    throw new Error(`${FIELD} must be an object.`);
  }
  REFUSED_FIELDS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(`${FIELD}.${key} is not accepted. Fair Deal rules and rates are set centrally.`);
    }
  });
  rejectUnknownKeys(raw, TOP_LEVEL_FIELDS, FIELD);

  const central = assumptions ?? resolvePlanningAssumptions();
  const care = central.care;

  const personLabel = typeof raw.personLabel === 'string' ? raw.personLabel.trim() : '';
  if (personLabel.length < 1 || personLabel.length > MAX_LABEL_LENGTH) {
    throw new Error(`${FIELD}.personLabel must be 1 to ${MAX_LABEL_LENGTH} characters.`);
  }
  refuseForbiddenWording(personLabel, `${FIELD}.personLabel`);

  const age = requireWholeNumber(raw.age, `${FIELD}.age`, { min: MIN_AGE, max: MAX_AGE, rangeText: ` from ${MIN_AGE} to ${MAX_AGE}` });

  let county = null;
  if (present(raw, 'county')) {
    const requested = typeof raw.county === 'string' ? raw.county.trim().toLowerCase() : '';
    county = Object.keys(care.agreedPrices.countyWeeklyAverages).find((name) => name.toLowerCase() === requested) ?? null;
    if (county === null) {
      throw new Error(`${FIELD}.county must be one of the 26 counties.`);
    }
  }
  const weeklyFee = present(raw, 'weeklyFee')
    ? requireNumber(raw.weeklyFee, `${FIELD}.weeklyFee`, { min: 0, minExclusive: true })
    : null;
  const weeklyExtras = present(raw, 'weeklyExtras') ? requireNumber(raw.weeklyExtras, `${FIELD}.weeklyExtras`) : 0;

  let couple = null;
  if (present(raw, 'couple')) {
    if (!isPlainObject(raw.couple)) {
      throw new Error(`${FIELD}.couple must be an object with partnerIncomes.`);
    }
    rejectUnknownKeys(raw.couple, ['partnerIncomes'], `${FIELD}.couple`);
    const partnerIncomes = normalizeIncomes(raw.couple.partnerIncomes, `${FIELD}.couple.partnerIncomes`, PERSON_INCOME_TYPES);
    if (partnerIncomes.length === 0) {
      throw new Error(`${FIELD}.couple.partnerIncomes needs at least one income.`);
    }
    couple = { partnerIncomes };
  }

  if (!Array.isArray(raw.incomes)) {
    throw new Error(`${FIELD}.incomes must be an array of { type, grossAnnual }.`);
  }
  const incomes = normalizeIncomes(raw.incomes, `${FIELD}.incomes`, PERSON_INCOME_TYPES);
  const otherDeductions = present(raw, 'otherDeductions') ? requireNumber(raw.otherDeductions, `${FIELD}.otherDeductions`) : 0;
  const cash = requireNumber(raw.cash, `${FIELD}.cash`);

  let home = null;
  if (present(raw, 'home')) {
    if (!isPlainObject(raw.home)) {
      throw new Error(`${FIELD}.home must be an object with a value and borrowings.`);
    }
    rejectUnknownKeys(raw.home, ['value', 'borrowings'], `${FIELD}.home`);
    home = {
      value: requireNumber(raw.home.value, `${FIELD}.home.value`, { min: 0, minExclusive: true }),
      borrowings: present(raw.home, 'borrowings') ? requireNumber(raw.home.borrowings, `${FIELD}.home.borrowings`) : 0
    };
  }

  let homeRent = null;
  if (present(raw, 'homeRent')) {
    if (!isPlainObject(raw.homeRent)) {
      throw new Error(`${FIELD}.homeRent must be an object with annual and exemptionApplied.`);
    }
    rejectUnknownKeys(raw.homeRent, ['annual', 'exemptionApplied'], `${FIELD}.homeRent`);
    if (home === null) {
      throw new Error(`${FIELD}.homeRent needs a home.`);
    }
    if (present(raw.homeRent, 'exemptionApplied') && typeof raw.homeRent.exemptionApplied !== 'boolean') {
      throw new Error(`${FIELD}.homeRent.exemptionApplied must be true or false.`);
    }
    homeRent = {
      annual: requireNumber(raw.homeRent.annual, `${FIELD}.homeRent.annual`, { min: 0, minExclusive: true }),
      exemptionApplied: raw.homeRent.exemptionApplied !== false
    };
  }

  let otherProperty = [];
  if (present(raw, 'otherProperty')) {
    if (!Array.isArray(raw.otherProperty)) {
      throw new Error(`${FIELD}.otherProperty must be an array.`);
    }
    otherProperty = raw.otherProperty.map((entry, index) => {
      const where = `${FIELD}.otherProperty[${index}]`;
      if (!isPlainObject(entry)) {
        throw new Error(`${where} must be an object.`);
      }
      rejectUnknownKeys(entry, ['label', 'value', 'borrowings', 'rentAnnual'], where);
      const label = typeof entry.label === 'string' ? entry.label.trim() : '';
      if (label.length < 1 || label.length > MAX_LABEL_LENGTH) {
        throw new Error(`${where}.label must be 1 to ${MAX_LABEL_LENGTH} characters.`);
      }
      refuseForbiddenWording(label, `${where}.label`);
      return {
        label,
        value: requireNumber(entry.value, `${where}.value`, { min: 0, minExclusive: true }),
        borrowings: present(entry, 'borrowings') ? requireNumber(entry.borrowings, `${where}.borrowings`) : 0,
        rentAnnual: present(entry, 'rentAnnual') ? requireNumber(entry.rentAnnual, `${where}.rentAnnual`) : 0
      };
    });
  }

  let transferred = { cash: 0, nonCash: 0 };
  if (present(raw, 'transferredInLastFiveYears')) {
    if (!isPlainObject(raw.transferredInLastFiveYears)) {
      throw new Error(`${FIELD}.transferredInLastFiveYears must be an object with cash and nonCash.`);
    }
    rejectUnknownKeys(raw.transferredInLastFiveYears, ['cash', 'nonCash'], `${FIELD}.transferredInLastFiveYears`);
    transferred = {
      cash: present(raw.transferredInLastFiveYears, 'cash')
        ? requireNumber(raw.transferredInLastFiveYears.cash, `${FIELD}.transferredInLastFiveYears.cash`) : 0,
      nonCash: present(raw.transferredInLastFiveYears, 'nonCash')
        ? requireNumber(raw.transferredInLastFiveYears.nonCash, `${FIELD}.transferredInLastFiveYears.nonCash`) : 0
    };
  }

  const startsInYears = requireWholeNumber(raw.startsInYears, `${FIELD}.startsInYears`, {
    min: 0, max: MAX_STARTS_IN_YEARS, rangeText: ` of years from 0 to ${MAX_STARTS_IN_YEARS}`
  });
  let yearsInCareSoFar = 0;
  if (present(raw, 'yearsInCareSoFar')) {
    yearsInCareSoFar = requireWholeNumber(raw.yearsInCareSoFar, `${FIELD}.yearsInCareSoFar`, {
      min: 0, max: MAX_YEARS_IN_CARE_SO_FAR, rangeText: ` of years from 0 to ${MAX_YEARS_IN_CARE_SO_FAR}`
    });
    if (yearsInCareSoFar > 0 && startsInYears !== 0) {
      throw new Error(`${FIELD}.yearsInCareSoFar can only be given when startsInYears is 0.`);
    }
  }
  const durationYears = present(raw, 'durationYears')
    ? requireWholeNumber(raw.durationYears, `${FIELD}.durationYears`, {
      min: 1, max: MAX_DURATION_YEARS, rangeText: ` of years from 1 to ${MAX_DURATION_YEARS}`
    })
    : care.relativeCare.defaultYears;

  let compareDurations;
  if (present(raw, 'compareDurations')) {
    if (!Array.isArray(raw.compareDurations) || raw.compareDurations.length > MAX_COMPARE_DURATIONS) {
      throw new Error(`${FIELD}.compareDurations must be a list of at most ${MAX_COMPARE_DURATIONS} whole numbers of years.`);
    }
    compareDurations = raw.compareDurations.map((years, index) => {
      const value = requireWholeNumber(years, `${FIELD}.compareDurations[${index}]`, {
        min: 1, max: MAX_DURATION_YEARS, rangeText: ` of years from 1 to ${MAX_DURATION_YEARS}`
      });
      if (value === durationYears) {
        throw new Error(`${FIELD}.compareDurations[${index}] must differ from durationYears.`);
      }
      return value;
    });
    if (new Set(compareDurations).size !== compareDurations.length) {
      throw new Error(`${FIELD}.compareDurations must not repeat a length.`);
    }
  } else {
    compareDurations = care.relativeCare.compareYears.filter((years) => years !== durationYears);
  }

  const payer = normalizePayer(raw.payer, FIELD);

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
    const normalized = normalizeCase(rawCase, index, { personLabel, startsInYears, hasHome: home !== null });
    if (usedIds.has(normalized.id)) {
      throw new Error(`${FIELD}.scenarios[${index}].id must be unique.`);
    }
    usedIds.add(normalized.id);
    return normalized;
  });

  let baseScenarioId = scenarios[0].id;
  if (present(raw, 'baseScenarioId')) {
    const requested = typeof raw.baseScenarioId === 'string' ? raw.baseScenarioId.trim() : '';
    if (!requested || !scenarios.some((scenario) => scenario.id === requested)) {
      throw new Error(`${FIELD}.baseScenarioId must match a case id.`);
    }
    baseScenarioId = requested;
  }

  return {
    personLabel,
    age,
    county,
    weeklyFee,
    weeklyExtras,
    couple,
    incomes,
    otherDeductions,
    cash,
    home,
    homeRent,
    otherProperty,
    transferredInLastFiveYears: transferred,
    yearsInCareSoFar,
    startsInYears,
    durationYears,
    compareDurations,
    payer,
    baseScenarioId,
    scenarios
  };
}

/** `[{ id, title, description }]`, for the presenter and the case buttons. */
export function getCareCostCases(rawInputs) {
  return normalizeCareCostInputs(rawInputs).scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    description: scenario.description
  }));
}

export function getDefaultCareCostScenarioId(rawInputs) {
  return normalizeCareCostInputs(rawInputs).baseScenarioId;
}

/* ------------------------------------------------------------------ dates */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The same calendar day `years` later; 29 February falls back to the 28th. */
function addYears(isoDate, years) {
  const year = Number(isoDate.slice(0, 4)) + years;
  const monthDay = isoDate.slice(5);
  const safe = monthDay === '02-29' && !isLeapYear(year) ? '02-28' : monthDay;
  return `${String(year).padStart(4, '0')}-${safe}`;
}

/* ------------------------------------------------------------------ rates */

/**
 * The rates in force, and where each came from. `options.assumptions`,
 * `options.taxCatalogue`, `options.today` and `options.fairDealCatalogue` are
 * test injections; with none of them every figure is the central one.
 */
function resolveContext(inputs, options) {
  const central = resolvePlanningAssumptions();
  const assumptions = options.assumptions ?? central;
  const care = assumptions.care ?? central.care;
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  if (!ISO_DATE.test(today)) {
    throw new Error(`options.today must be a YYYY-MM-DD date; received ${JSON.stringify(today)}.`);
  }
  const calculationYear = Number(today.slice(0, 4));
  const taxRules = resolveTaxRules(calculationYear);

  const generalRate = assumptions.inflation.generalRate;
  const feeGrowthRate = assumptions.inflation.educationRate;
  const cashRateGross = assumptions.cash.instantAccessGrossRate;
  const dirtRate = taxRules.dirt.rate;
  const cashRateNet = cashRateGross * (1 - dirtRate);

  const prices = care.agreedPrices;
  let weeklyFee;
  let feeSource;
  if (inputs.weeklyFee !== null) {
    weeklyFee = inputs.weeklyFee;
    feeSource = 'stated';
  } else if (inputs.county !== null) {
    weeklyFee = prices.countyWeeklyAverages[inputs.county].average;
    feeSource = 'county_average';
  } else {
    weeklyFee = prices.nationalWeeklyAverage;
    feeSource = 'national_average';
  }

  // The rate is fixed at the date of the application: the day care starts, or
  // the calculation date for care already under way.
  const careStartDate = addYears(today, inputs.startsInYears);
  const pension = socialWelfareRateOn(STATE_PENSION_SERIES, careStartDate);

  return {
    options,
    today,
    calculationYear,
    careStartDate,
    taxRulesVersion: taxRules.version,
    generalRate,
    feeGrowthRate,
    cashRateGross,
    dirtRate,
    cashRateNet,
    assumptionsVersion: assumptions.version,
    prices,
    weeklyFee,
    feeSource,
    pension,
    fairDealCatalogue: options.fairDealCatalogue
  };
}

/* ------------------------------------------------------------ tax and relief */

function sumGross(incomes, factor) {
  return incomes.reduce((total, income) => total + (income.grossAnnual * factor), 0);
}

/** One person's items for the tax engine, each grown by `factor`. */
function taxItems(personId, incomes, factor) {
  return incomes.map((income) => ({ personId, type: income.type, amount: income.grossAnnual * factor }));
}

function totalTax(result) {
  return result.totals.incomeTax + result.totals.usc + result.totals.prsi;
}

/**
 * What the person is assessed on in year `t`: gross income, less the tax due on
 * it, less the other deductions, with eligible rent on the home kept apart and
 * taxed at the margin it adds.
 */
function assessableIncome(inputs, ctx, t, cache) {
  if (cache.has(t)) {
    return cache.get(t);
  }
  const factor = (1 + ctx.generalRate) ** t;
  const year = ctx.calculationYear + t;
  const personAge = Math.min(inputs.age + t, MAX_TAX_AGE);
  const people = [{ id: 'person', age: personAge }];
  let items = taxItems('person', inputs.incomes, factor);
  inputs.otherProperty.forEach((property) => {
    if (property.rentAnnual > 0) {
      items.push({ personId: 'person', type: 'rentalProfit', amount: property.rentAnnual * factor });
    }
  });
  let status = 'single';
  let gross = sumGross(inputs.incomes, factor) + (inputs.otherProperty.reduce((sum, property) => sum + property.rentAnnual, 0) * factor);
  if (inputs.couple) {
    status = 'married_or_civil_partners';
    people.push({ id: 'partner', age: personAge });
    items = items.concat(taxItems('partner', inputs.couple.partnerIncomes, factor));
    gross += sumGross(inputs.couple.partnerIncomes, factor);
  }

  const exempt = inputs.homeRent !== null && inputs.homeRent.exemptionApplied;
  const rent = inputs.homeRent === null ? 0 : inputs.homeRent.annual * factor;
  const withoutRent = totalTax(computeTaxYear({ input: { year, status, people, items } }).result);
  let eligibleRent = 0;
  let netIncome;
  if (rent > 0) {
    const withRent = totalTax(computeTaxYear({
      input: { year, status, people, items: items.concat([{ personId: 'person', type: 'rentalProfit', amount: rent }]) }
    }).result);
    if (exempt) {
      eligibleRent = rent - (withRent - withoutRent);
      netIncome = gross - withoutRent - (inputs.otherDeductions * factor);
    } else {
      netIncome = gross + rent - withRent - (inputs.otherDeductions * factor);
    }
  } else {
    netIncome = gross - withoutRent - (inputs.otherDeductions * factor);
  }
  const result = { netIncome: Math.max(0, netIncome), eligibleRent: Math.max(0, eligibleRent), tax: withoutRent, gross };
  cache.set(t, result);
  return result;
}

/** The payer's household for the tax engine in year `t`, with the year's incomes grown by prices. */
function payerTaxInput(inputs, ctx, t) {
  const factor = (1 + ctx.generalRate) ** t;
  const people = inputs.payer.people.map((person) => ({ id: person.id, age: Math.min(person.age + t, MAX_TAX_AGE) }));
  const items = inputs.payer.people.flatMap((person) => {
    const retired = person.retiresInYears !== null && t >= person.retiresInYears;
    return taxItems(person.id, retired ? person.incomesAfterRetirement : person.incomes, factor);
  });
  return { year: ctx.calculationYear + t, status: inputs.payer.taxStatus, people, items };
}

/**
 * The payer's income tax saved by deducting `amount` of nursing home fees in
 * year `t`: two full calculations from the same opening state, with and without
 * the expense, so neither carries anything into the other. Where two people
 * are assessed jointly the expense is pooled; the first person is named as the
 * claimant.
 */
function reliefFor(inputs, ctx, t, amount, cache) {
  if (amount <= 0) {
    return { relief: 0, claimantId: inputs.payer.people[0].id };
  }
  if (ctx.options.flatReliefRate !== undefined) {
    return { relief: amount * ctx.options.flatReliefRate, claimantId: inputs.payer.people[0].id };
  }
  const base = payerTaxInput(inputs, ctx, t);
  if (!cache.has(t)) {
    cache.set(t, totalTax(computeTaxYear({ input: base }).result));
  }
  const claimantId = inputs.payer.people[0].id;
  const withExpense = totalTax(computeTaxYear({
    input: { ...base, items: base.items.concat([{ personId: claimantId, type: 'nursingHomeExpenses', amount }]) }
  }).result);
  return { relief: Math.max(0, cache.get(t) - withExpense), claimantId };
}

/* -------------------------------------------------------------- year by year */

/** The savings paid out each year under `alongside`: spread so they last exactly as long as the care. */
function alongsideSpread(openingSavings, durationYears, feeGrowthRate, cashRateNet) {
  const ratio = (1 + feeGrowthRate) / (1 + cashRateNet);
  let factorSum = 0;
  for (let k = 0; k < durationYears; k += 1) {
    factorSum += ratio ** k;
  }
  const first = openingSavings / factorSum;
  return Array.from({ length: durationYears }, (_unused, k) => first * (1 + feeGrowthRate) ** k);
}

function runCase(inputs, scenario, ctx, durationYears, caches) {
  const t0 = inputs.startsInYears;
  const homeStartValue = inputs.home === null ? 0 : inputs.home.value * (1 + ctx.generalRate) ** t0;
  const homeNet = inputs.home === null ? 0 : Math.max(0, homeStartValue - inputs.home.borrowings);
  const otherNet = inputs.otherProperty.reduce(
    (total, property) => total + Math.max(0, (property.value * (1 + ctx.generalRate) ** t0) - property.borrowings),
    0
  ) + inputs.transferredInLastFiveYears.nonCash;
  const feeYear0 = ctx.weeklyFee * WEEKS_IN_YEAR;
  const extrasYear0 = inputs.weeklyExtras * WEEKS_IN_YEAR;
  const openingSavings = inputs.cash * (1 + ctx.cashRateNet) ** t0;
  const spread = scenario.personMoney === 'alongside'
    ? alongsideSpread(openingSavings, durationYears, ctx.feeGrowthRate, ctx.cashRateNet)
    : null;

  const rows = [];
  let savings = openingSavings;
  for (let k = 0; k < durationYears; k += 1) {
    const t = t0 + k;
    const rules = resolveFairDealRules(addYears(ctx.today, t), { catalogue: ctx.fairDealCatalogue });
    const yearInCare = inputs.yearsInCareSoFar + k + 1;
    const homeCounts = inputs.yearsInCareSoFar + k < rules.value('home.cap_years');
    const fee = feeYear0 * (1 + ctx.feeGrowthRate) ** t;
    const extras = extrasYear0 * (1 + ctx.feeGrowthRate) ** t;

    const income = assessableIncome(inputs, ctx, t, caches.income);
    const assessment = assessFairDeal({
      rules,
      isCouple: inputs.couple !== null,
      weeklyPension: ctx.pension.weeklyEur,
      netIncome: income.netIncome,
      eligibleRent: income.eligibleRent,
      cash: savings + inputs.transferredInLastFiveYears.cash,
      otherProperty: otherNet,
      home: homeCounts ? homeNet : 0
    });

    const useFairDeal = scenario.basis !== 'private_fee' && assessment.contribution < fee;
    const contribution = useFairDeal ? assessment.contribution : fee;
    const hsePays = useFairDeal ? fee - assessment.contribution : 0;
    const deferredToLoan = useFairDeal && scenario.basis === 'fair_deal_with_loan' ? assessment.homePart : 0;
    const due = contribution + extras - deferredToLoan;

    // In a private year the person keeps what Fair Deal would have left them,
    // unless the course's own convention says they keep nothing.
    const incomeAvailable = !useFairDeal && ctx.options.privateAllowance === 'none'
      ? income.netIncome + income.eligibleRent
      : assessment.incomePart;
    const fromIncome = Math.min(incomeAvailable, due);
    const remaining = due - fromIncome;
    let wantedFromSavings = 0;
    if (scenario.personMoney === 'first') {
      wantedFromSavings = remaining;
    } else if (scenario.personMoney === 'alongside') {
      wantedFromSavings = Math.min(spread[k], remaining);
    }
    const fromSavings = Math.min(savings, wantedFromSavings);
    const savingsShort = savings + SAVINGS_TOLERANCE_EUR < wantedFromSavings;
    const familyBeforeRelief = remaining - fromSavings;

    // Extras do not qualify, and the family is taken to meet them last, so the
    // relief is on the family's share above the extras.
    const nursingHomePart = Math.max(0, familyBeforeRelief - extras);
    const { relief, claimantId } = reliefFor(inputs, ctx, t, nursingHomePart, caches.payerTax);

    rows.push({
      yearIndex: k,
      yearInCare,
      calendarYear: ctx.calculationYear + t,
      fairDealApplies: useFairDeal,
      fairDealWouldNotLowerTheCost: scenario.basis !== 'private_fee' && !useFairDeal,
      assessedContribution: assessment.contribution,
      contribution,
      fee,
      extras,
      due,
      incomePart: assessment.incomePart,
      savingsPart: assessment.savingsPart,
      otherPropertyPart: assessment.otherPropertyPart,
      homePart: assessment.homePart,
      deferredToLoan,
      hsePays,
      fromIncome,
      fromSavings,
      familyBeforeRelief,
      nursingHomePart,
      relief,
      claimantId,
      familyAfterRelief: familyBeforeRelief - relief,
      savingsShort,
      savingsAtStart: savings,
      savingsAtEnd: (savings - fromSavings) * (1 + ctx.cashRateNet),
      netIncome: income.netIncome,
      eligibleRent: income.eligibleRent,
      retainedIncomeThreshold: assessment.retainedIncomeThreshold,
      safeguardBinds: assessment.safeguardBinds,
      homeCounts
    });
    savings = (savings - fromSavings) * (1 + ctx.cashRateNet);
  }
  return summariseCase(inputs, scenario, ctx, durationYears, rows, homeNet);
}

function sum(rows, pick) {
  return rows.reduce((total, row) => total + pick(row), 0);
}

function retirementYearIndex(inputs) {
  const years = inputs.payer.people.map((person) => person.retiresInYears);
  return years.every((value) => value !== null) ? Math.max(...years) : null;
}

function summariseCase(inputs, scenario, ctx, durationYears, rows, homeNet) {
  const t0 = inputs.startsInYears;
  const capYears = rows[0] ? resolveFairDealRules(addYears(ctx.today, t0), { catalogue: ctx.fairDealCatalogue }).value('home.cap_years') : 0;
  const loanAtEnd = sum(rows, (row) => row.deferredToLoan * (1 + ctx.generalRate) ** (durationYears - row.yearIndex));
  const loanTodaysMoney = sum(rows, (row) => row.deferredToLoan / (1 + ctx.generalRate) ** (t0 + row.yearIndex));
  const exhausted = rows.find((row) => row.savingsShort);
  const retiresAt = retirementYearIndex(inputs);
  const family = (row) => row.familyAfterRelief;
  const homeToday = inputs.home === null ? 0 : Math.max(0, inputs.home.value - inputs.home.borrowings);
  return {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    basis: scenario.basis,
    personMoney: scenario.personMoney,
    familyFunding: scenario.familyFunding,
    durationYears,
    rows,
    fairDealYears: rows.filter((row) => row.fairDealApplies).map((row) => row.yearInCare),
    fairDealYearCount: rows.filter((row) => row.fairDealApplies).length,
    feeTotal: sum(rows, (row) => row.fee + row.extras),
    hseTotal: sum(rows, (row) => row.hsePays),
    familyTotalBeforeRelief: sum(rows, (row) => row.familyBeforeRelief),
    reliefTotal: sum(rows, (row) => row.relief),
    familyTotalAfterRelief: sum(rows, family),
    homePartAssessedTotal: sum(rows, (row) => row.homePart),
    homePartTotal: sum(rows, (row) => (row.fairDealApplies ? row.homePart : 0)),
    homeValueAtCareStart: homeNet,
    homePartEndsAfterYear: inputs.home === null ? null : capYears,
    homePartEndsCalendarYear: inputs.home === null
      ? null
      : ctx.calculationYear + t0 + Math.max(0, capYears - inputs.yearsInCareSoFar),
    savingsLastYears: exhausted ? exhausted.yearIndex : durationYears,
    savingsRunOutYear: exhausted ? exhausted.yearInCare : null,
    savingsLeft: rows.length ? rows[rows.length - 1].savingsAtEnd : 0,
    loanAtEnd,
    loanTodaysMoney,
    estateHomeAfterLoanTodaysMoney: inputs.home === null ? null : homeToday - loanTodaysMoney,
    retirementYearIndex: retiresAt,
    beforeRetirement: retiresAt === null ? null : sum(rows.filter((row) => t0 + row.yearIndex < retiresAt), family),
    afterRetirement: retiresAt === null ? null : sum(rows.filter((row) => t0 + row.yearIndex >= retiresAt), family)
  };
}

/* ------------------------------------------------------------------- tables */

function percentText(decimal) {
  const rounded = Math.round(decimal * 10000) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

function euroText(amount) {
  return `€${Math.round(amount).toLocaleString('en-IE')}`;
}

function roundToHundred(amount) {
  return Math.round(amount / 100) * 100;
}

function dateText(iso) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${months[month - 1]} ${year}`;
}

function feeBasisText(inputs, ctx) {
  if (ctx.feeSource === 'stated') {
    return `${euroText(ctx.weeklyFee)} a week, the home’s own price as stated`;
  }
  const list = `list ${ctx.prices.listNumber}, ${dateText(ctx.prices.listDate)}`;
  return ctx.feeSource === 'county_average'
    ? `${euroText(ctx.weeklyFee)} a week, the average of the HSE’s agreed prices for private and voluntary homes in Co. ${inputs.county} (${list})`
    : `${euroText(ctx.weeklyFee)} a week, the average of the HSE’s agreed prices for private and voluntary homes nationally (${list})`;
}

function buildAssumptionsTable(inputs, ctx) {
  const rows = [
    ['Fee', feeBasisText(inputs, ctx)],
    ['Extras', inputs.weeklyExtras > 0
      ? `${euroText(inputs.weeklyExtras)} a week, not covered by Fair Deal, growing at the same rate as the fee`
      : 'Extra charges are not included'],
    ['Fees rise', `${percentText(ctx.feeGrowthRate)} a year, the rate used for education and healthcare costs`],
    ['Prices rise', `${percentText(ctx.generalRate)} a year: incomes, rents and property values are assumed to rise with prices`],
    ['Interest on savings, before DIRT', `${percentText(ctx.cashRateGross)} a year`],
    ['Interest on savings, after DIRT', `${percentText(ctx.cashRateNet)} a year, with DIRT at ${percentText(ctx.dirtRate)}`],
    ['Fair Deal rules', `Schedule 1 of the Nursing Homes Support Scheme Act 2009 as it applies to applications from 25 July 2013, rules ${FAIR_DEAL_RULES_VERSION}`],
    ['State Pension (Non-Contributory)', `${euroText(ctx.pension.weeklyEur)} a week, the rate on ${dateText(ctx.careStartDate)}, kept for every year of this care`],
    ['Review', 'A review of the Fair Deal assessment is assumed each year, on the savings left at the end of the year before'],
    ['Timing', 'Payments and costs fall at the start of each year'],
    ['Tax', `Income tax, USC and PRSI from the Irish tax engine, rules ${ctx.taxRulesVersion}; bands are not indexed`]
  ];
  if (inputs.home !== null) {
    rows.push(['The home', 'Valued once, when care starts, and counted for the first three years of care only']);
  }
  rows.push(
    ['Tax relief', 'Relief at the payer’s highest rate on fees paid to a nursing home with 24-hour on-site nursing care. The HSE’s share gets none.'],
    ['Not modelled', 'Care at home, income given away in the last five years, selling the home, applications before 25 July 2013, and the over-65 DIRT exemption'],
    ['Rounding', 'Amounts are shown to the nearest €100']
  );
  return { columns: ['Assumption', 'Input Used'], rows };
}

function buildOutputsTable(inputs, cases) {
  const possessive = `${inputs.personLabel}’s`;
  return {
    columns: [
      'Case',
      'Years Fair Deal applies',
      'You pay before relief (€)',
      'Tax relief (€)',
      'You pay after relief (€)',
      `${possessive} savings last (years)`,
      'Loan in today’s money (€)'
    ],
    rows: cases.map((entry) => [
      entry.title,
      entry.fairDealYearCount,
      roundToHundred(entry.familyTotalBeforeRelief),
      roundToHundred(entry.reliefTotal),
      // Always before relief less relief as SHOWN, so the sentence adds up.
      roundToHundred(entry.familyTotalBeforeRelief) - roundToHundred(entry.reliefTotal),
      entry.savingsLastYears,
      roundToHundred(entry.loanTodaysMoney)
    ])
  };
}

function buildTables(inputs, cases) {
  const possessive = `${inputs.personLabel}’s`;
  return cases.map((entry) => ({
    title: `${entry.title}: year by year`,
    columns: [
      'Year of care',
      'Fee and extras (€)',
      'The HSE pays (€)',
      `${possessive} income (€)`,
      `${possessive} savings (€)`,
      'You pay before relief (€)',
      'Tax relief (€)',
      'You pay after relief (€)'
    ],
    rows: entry.rows.map((row) => [
      row.fairDealWouldNotLowerTheCost
        ? `Year ${row.yearInCare}: Fair Deal would not lower the cost this year`
        : `Year ${row.yearInCare}`,
      roundToHundred(row.fee + row.extras),
      roundToHundred(row.hsePays),
      roundToHundred(row.fromIncome),
      roundToHundred(row.fromSavings),
      roundToHundred(row.familyBeforeRelief),
      roundToHundred(row.relief),
      roundToHundred(row.familyBeforeRelief) - roundToHundred(row.relief)
    ])
  }));
}

/** What is not built yet, so a reader of `debug` is told rather than left to find a gap. */
const NOT_YET_BUILT = Object.freeze([
  'lumpSumNow',
  'yearlyFromHousehold',
  'retirementCapitalNeeded',
  'charts',
  'summary (the dated-cost contract of the plan pack)'
]);

/**
 * Work out every case of a payload, year by year, as far as the family's share
 * before and after relief.
 *
 * @param {object} rawInputs `generated.careCostInputs`
 * @param {object} [options]
 * @param {string} [options.today] The calculation date, YYYY-MM-DD.
 * @param {object} [options.assumptions] Test injection: replaces the central assumptions.
 * @param {object} [options.taxCatalogue] Test injection: replaces the tax catalogue.
 * @param {object[]} [options.fairDealCatalogue] Test injection: Fair Deal rule blocks.
 * @param {number} [options.flatReliefRate] The course's convention: relief at a flat rate on the nursing home part.
 * @param {'none'} [options.privateAllowance] The course's convention: in a private year the person keeps nothing.
 */
export function computeCareCostProjection(rawInputs, options = {}) {
  const compute = () => {
    const inputs = normalizeCareCostInputs(rawInputs, { assumptions: options.assumptions ?? null });
    const ctx = resolveContext(inputs, options);
    const caches = { income: new Map(), payerTax: new Map() };
    const cases = inputs.scenarios.map((scenario) => runCase(inputs, scenario, ctx, inputs.durationYears, caches));
    const baseCase = cases.find((entry) => entry.id === inputs.baseScenarioId) ?? cases[0];
    const baseScenario = inputs.scenarios.find((scenario) => scenario.id === baseCase.id);
    const compareDurations = inputs.compareDurations.map((years) => {
      const compared = runCase(inputs, baseScenario, ctx, years, caches);
      return {
        durationYears: years,
        fairDealYearCount: compared.fairDealYearCount,
        familyTotalBeforeRelief: compared.familyTotalBeforeRelief,
        reliefTotal: compared.reliefTotal,
        familyTotalAfterRelief: compared.familyTotalAfterRelief,
        savingsLastYears: compared.savingsLastYears,
        loanTodaysMoney: compared.loanTodaysMoney
      };
    });
    const firstRules = resolveFairDealRules(ctx.careStartDate, { catalogue: ctx.fairDealCatalogue });

    return {
      assumptionsTable: buildAssumptionsTable(inputs, ctx),
      outputsTable: buildOutputsTable(inputs, cases),
      tables: buildTables(inputs, cases),
      charts: [],
      debug: {
        inputs,
        cases,
        baseScenarioId: baseCase.id,
        compareDurations,
        rulesUsed: {
          fairDealRulesVersion: firstRules.version,
          fairDealRuleIds: [...firstRules.ruleIds],
          fairDealRulesEffectiveFrom: firstRules.effectiveFrom,
          assumptionsVersion: ctx.assumptionsVersion,
          taxRulesVersion: ctx.taxRulesVersion,
          socialWelfareRatesVersion: SOCIAL_WELFARE_RATES_VERSION,
          priceList: { listNumber: ctx.prices.listNumber, listDate: ctx.prices.listDate, feeSource: ctx.feeSource, county: inputs.county },
          statePensionNonContributory: {
            weeklyEur: ctx.pension.weeklyEur,
            effectiveFrom: ctx.pension.effectiveFrom,
            status: ctx.pension.status,
            asOf: ctx.careStartDate
          }
        },
        assumptionsUsed: {
          weeklyFee: ctx.weeklyFee,
          feeSource: ctx.feeSource,
          feeGrowthRate: ctx.feeGrowthRate,
          generalRate: ctx.generalRate,
          cashRateGross: ctx.cashRateGross,
          dirtRate: ctx.dirtRate,
          cashRateNet: ctx.cashRateNet,
          calculationDate: ctx.today,
          timing: 'start-of-year'
        },
        notYetBuilt: NOT_YET_BUILT
      }
    };
  };
  return options.taxCatalogue ? withTaxCatalogue(options.taxCatalogue, compute) : compute();
}
