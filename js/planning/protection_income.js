/**
 * Protection in the plan: what each "if income stopped" case takes home, and
 * the State payment beside it, worked out from the shared tax engine and the
 * figures register. The protection gap engine holds no tax rule and no rate, so
 * everything it is given for a case is built here (the implementation plan, section 6,
 * "Approved illness-scenario assumption").
 *
 * THE ILLNESS BENEFIT DEFAULT
 *
 * For a person whose employment facts say they are an employee, the income-stops
 * case assumes the standard personal rate of Illness Benefit from the register
 * (`ie.social_welfare.illness_benefit.personal_highest`), for the year the plan
 * is calculated in. It never applies silently to anyone else: a self-employed
 * person, a retired person, or a person whose employment is not confirmed gets a
 * case that is not shown, with the reason, unless a payment is stated. A person
 * who is not asked to predict their entitlement is not asked: this is a stated
 * assumption, shown as one.
 *
 * It represents a full year at that rate. It is not a first claim year, not a
 * promise, and not extended: after the year the second phase has no payment, and
 * is its own full tax calculation (the extra standard rate band that came with a
 * taxable payment goes with it).
 *
 * EVERY CASE IS ITS OWN CALCULATION
 *
 * Each case, and each phase of it, starts from the same household and the same
 * facts, builds its income items afresh, and runs `computeTaxYear` for the whole
 * household with no carried state. No case's state is passed into another, so
 * running cases in any order gives the same answers, and nothing supplied is
 * changed.
 *
 * THE TWO PEOPLE OF A JOINT ASSESSMENT
 *
 * The tax engine assesses a married couple together, as one figure. A person's
 * take-home therefore needs a convention, and this is it (`creditAllocation:
 * 'allocated'`): each person first uses their own share of the standard rate
 * band, which is the base band for the higher income and the extra band for the
 * lower one (so the extra band that comes with Illness Benefit belongs to the
 * person who has the benefit, and does not give the person who is working
 * more of their pay at 20%). Band one person does not use passes to the other.
 * Each person has their own Employee Tax Credit, and the joint personal credit
 * is shared equally. A credit a person cannot use is set against the other's tax,
 * as the engine does for a jointly assessed couple. The people's tax always adds
 * up to the engine's. It is an allocation, not a payroll figure, and says so.
 *
 * RECONCILIATION
 *
 * The take-home of each person and the State payment add up to the household's
 * net income from the engine, less the personal pension contributions that come
 * out of pay. Amounts are rounded to whole euros so they still add up to the
 * rounded total. Where a person's own bank pay is given, it sets the level (a
 * payslip beats an estimate) and the case changes by what the engine says changes;
 * the adjustment is returned beside the totals.
 */

import { computeTaxYear } from './tax/engine.js';
import { resolveTaxRules } from './tax/resolve.js';
import { getFigures } from './figures/get_figures.js';
import { PLANEIR_ASSUMPTIONS_VERSION } from './planeir_assumptions.js';

export const ILLNESS_BENEFIT_QUANTITY = 'ie.social_welfare.illness_benefit.personal_highest';
const BEREAVED_PARTNER_QUANTITIES = Object.freeze([
  Object.freeze({ upToAge: 66, quantity: 'ie.social_welfare.bereaved_partners_contributory.personal_under_66' }),
  Object.freeze({ upToAge: 80, quantity: 'ie.social_welfare.bereaved_partners_contributory.personal_66_to_79' }),
  Object.freeze({ upToAge: Infinity, quantity: 'ie.social_welfare.bereaved_partners_contributory.personal_80_and_over' })
]);

/** A full year of weekly payments, which is how the register's references express a year. */
const ILLNESS_BENEFIT_WEEKS = 52;
/** The months the default counts the payment for. */
export const ILLNESS_BENEFIT_MONTHS = 12;

const SURVIVOR_RULE_PREFIX = 'planeir.assumption.survivor_rule.';
const SURVIVOR_DB_SHARE_ID = 'planeir.assumption.survivor_db_spouse_pension_share';

const EMPLOYMENT_ITEM = 'employment';
const PENSION_CONTRIBUTION_ITEM = 'employmentPensionContribution';
const CENT = 1e-9;

/* ----------------------------------------------------------------- scope */

const SCOPE_REASONS = Object.freeze({
  self_employed: 'The standard Illness Benefit assumption is not used for self-employment, because Class S PRSI does not cover Illness Benefit.',
  contractor: 'The standard Illness Benefit assumption is not used for contractor work, which is treated as self-employment, because Class S PRSI does not cover Illness Benefit.',
  retired: 'The standard Illness Benefit assumption is not used for someone who is retired.',
  other: 'The standard Illness Benefit assumption is not used until the work is confirmed as employment.',
  unknown: 'The standard Illness Benefit assumption is not used until the work is confirmed as employment.',
  no_employment_income: 'There is no employment income to stop, so there is no income-stops case.'
});

/**
 * Whether the Illness Benefit default may apply to a person. Only employment
 * facts decide it: someone confirmed as an employee, with employment income.
 *
 * @param {{ employment: string|undefined, employmentIncome: number }} person
 * @returns {{ applies: true } | { applies: false, code: string, reason: string }}
 */
export function illnessBenefitScope({ employment, employmentIncome } = {}) {
  if (!(employmentIncome > 0)) {
    return { applies: false, code: 'no_employment_income', reason: SCOPE_REASONS.no_employment_income };
  }
  if (employment === 'employee') {
    return { applies: true };
  }
  const code = ['self_employed', 'contractor', 'retired', 'other'].includes(employment) ? employment : 'unknown';
  return { applies: false, code, reason: SCOPE_REASONS[code] };
}

/* --------------------------------------------------------------- figures */

function dateInYear(year) {
  return `${year}-01-01`;
}

/**
 * The register's weekly rate for a quantity in the year the plan is calculated
 * in, with what is needed to trace it. A rate announced for that year but not yet
 * payable is used and said to be announced.
 */
function registerRate(quantity, year) {
  const matches = getFigures({ onDate: dateInYear(year) }).filter((figure) => figure.id.startsWith(`${quantity}.from_`));
  if (matches.length !== 1) {
    throw new Error(`The figures register holds no ${quantity} rate in force for ${year}.`);
  }
  const figure = matches[0];
  return {
    weeklyRate: figure.value,
    figure: {
      id: figure.id,
      effectiveFrom: figure.effectiveFrom,
      status: figure.status,
      checkedOn: figure.checkedOn,
      catalogueVersion: figure.catalogueVersion,
      sourceUrl: figure.source.url
    }
  };
}

function bereavedPartnerQuantity(age) {
  return BEREAVED_PARTNER_QUANTITIES.find((band) => age < band.upToAge).quantity;
}

/**
 * What the story needs to explain an assumption: the register's own words for it,
 * its source, the day it was checked and the catalogue version. Read from the
 * register, never typed here.
 */
function provenance(figures) {
  return figures.map((figure) => ({
    id: figure.id,
    label: figure.label,
    valueShown: figure.valueShown,
    status: figure.status,
    effectiveFrom: figure.effectiveFrom,
    checkedOn: figure.checkedOn,
    catalogueVersion: figure.catalogueVersion,
    source: { title: figure.source.title, url: figure.source.url }
  }));
}

function registerFigures(ids) {
  return getFigures({ ids });
}

/** The central rules a death follows, from the register, in a fixed order. */
function survivorRuleFigures({ includeQualifies }) {
  const rules = getFigures({ kinds: ['planeir_assumption'] }).filter((figure) => figure.id.startsWith(SURVIVOR_RULE_PREFIX));
  return rules.filter((figure) => includeQualifies || !figure.id.endsWith('.qualifies'));
}

/* ------------------------------------------------------------- the maths */

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/** Whole euros that still add up to the rounded total (largest remainder, first listed wins a tie). */
function roundToTotal(values) {
  const total = Math.round(sum(values));
  const floors = values.map((value) => Math.floor(value + CENT));
  let remainder = total - sum(floors);
  const order = values
    .map((value, index) => ({ index, fraction: value - floors[index] }))
    .sort((left, right) => (right.fraction - left.fraction) || (left.index - right.index));
  for (let step = 0; remainder > 0 && step < order.length; step += 1, remainder -= 1) {
    floors[order[step].index] += 1;
  }
  return { values: floors, total };
}

/**
 * Each person's share of one assessment's income tax. One person is the whole
 * figure. A couple's follows the convention in the file header.
 */
function allocateAssessment(assessment, rules) {
  const ids = assessment.personIds;
  const total = assessment.incomeTax;
  if (ids.length === 1) {
    return { byPerson: { [ids[0]]: total }, basis: 'own' };
  }

  const taxable = assessment.taxableIncomeByPerson;
  const [first, second] = ids;
  const [high, low] = taxable[first] >= taxable[second] ? [first, second] : [second, first];
  const band = assessment.standardRateBand;
  const cutoff = { [high]: band - assessment.bandIncrease, [low]: assessment.bandIncrease };
  const standard = {};
  const leftover = {};
  ids.forEach((id) => {
    standard[id] = Math.min(taxable[id], cutoff[id]);
    leftover[id] = cutoff[id] - standard[id];
  });
  const over = Object.fromEntries(ids.map((id) => [id, taxable[id] - standard[id]]));
  const other = { [high]: low, [low]: high };
  ids.forEach((id) => {
    const moved = Math.min(over[id], leftover[other[id]]);
    standard[id] += moved;
  });

  const { standardRate, higherRate } = rules.incomeTax;
  const gross = Object.fromEntries(ids.map((id) => [id, (standard[id] * standardRate) + ((taxable[id] - standard[id]) * higherRate)]));
  const shared = (assessment.credits.personal + assessment.credits.age) / ids.length;
  const raw = Object.fromEntries(ids.map((id) => [id, gross[id] - shared - (assessment.credits.employee[id] || 0)]));

  // Only a plain assessment reconciles this way. Fees paid, or a relief on income,
  // change the engine's total in ways a share cannot follow, so the tax is shared
  // by taxable income instead and the result still adds up.
  const reconciles = assessment.nursingHomeExpenses === 0
    && assessment.ageRelief === null
    && Math.abs(sum(Object.values(gross)) - assessment.grossTax) < 0.01;
  const weights = reconciles
    ? Object.fromEntries(ids.map((id) => [id, Math.max(0, raw[id])]))
    : Object.fromEntries(ids.map((id) => [id, taxable[id]]));
  const weightTotal = sum(Object.values(weights));
  const byPerson = Object.fromEntries(ids.map((id) => [id, weightTotal > 0 ? (total * weights[id]) / weightTotal : 0]));
  return { byPerson, basis: 'allocated' };
}

/**
 * One full calculation of the household. Nothing carries over from any other:
 * the items are copied, no state is passed in, and the returned state is dropped.
 */
function runHousehold({ year, status, people, items }) {
  const { result } = computeTaxYear({
    input: {
      year,
      status,
      people: people.map((person) => ({ id: person.id, age: person.age })),
      items: items.map((item) => ({ personId: item.personId, type: item.type, amount: item.amount }))
    }
  });
  const rules = resolveTaxRules(year);

  const incomeTaxById = {};
  let basis = 'own';
  result.assessments.forEach((assessment) => {
    const allocated = allocateAssessment(assessment, rules);
    Object.assign(incomeTaxById, allocated.byPerson);
    if (allocated.basis === 'allocated') basis = 'allocated';
  });

  const contributions = {};
  people.forEach((person) => {
    contributions[person.id] = items
      .filter((item) => item.personId === person.id && item.type === PENSION_CONTRIBUTION_ITEM)
      .reduce((total, item) => total + item.amount, 0);
  });

  const byPerson = {};
  result.people.forEach((person) => {
    const tax = incomeTaxById[person.id] + person.usc.usc + person.prsi.prsi;
    byPerson[person.id] = {
      gross: person.grossIncome,
      tax,
      incomeTax: incomeTaxById[person.id],
      contribution: contributions[person.id] || 0,
      bank: person.grossIncome - tax - (contributions[person.id] || 0)
    };
  });
  const bankTotal = sum(Object.values(byPerson).map((entry) => entry.bank));
  if (Math.abs(bankTotal - (result.totals.netIncome - sum(Object.values(contributions)))) > 0.01) {
    throw new Error('The people’s take-home does not add up to the tax engine’s household net income.');
  }

  return {
    byPerson,
    basis,
    netIncome: result.totals.netIncome,
    contributions: sum(Object.values(contributions)),
    rulesVersion: result.rulesVersion,
    assumptionsVersion: result.assumptionsVersion
  };
}

/* ----------------------------------------------------------------- facts */

function copyFacts(facts) {
  const people = facts.people.map((person) => ({
    id: person.id,
    label: person.label,
    age: person.age,
    employment: person.employment,
    personalPensionContribution: person.personalPensionContribution || 0,
    anchorTakeHome: typeof person.anchorTakeHome === 'number' ? person.anchorTakeHome : null,
    definedBenefit: person.definedBenefit === true
  }));
  return { year: facts.year, status: facts.taxStatus, people, income: facts.income.map((item) => ({ ...item })) };
}

/** The household's items for one case, built fresh every time from the facts. */
function buildItems(facts, { dropFor = [], keepOnly = null, extra = [] } = {}) {
  const items = [];
  facts.income.forEach((item) => {
    if (item.personId === 'joint') {
      if (!keepOnly) items.push({ ...item });
      return;
    }
    if (keepOnly && item.personId !== keepOnly) return;
    if (dropFor.includes(item.personId) && item.type === EMPLOYMENT_ITEM) return;
    items.push({ ...item });
  });
  facts.people.forEach((person) => {
    if (keepOnly && person.id !== keepOnly) return;
    const stillEmployed = !dropFor.includes(person.id);
    if (stillEmployed && person.personalPensionContribution > 0) {
      items.push({ personId: person.id, type: PENSION_CONTRIBUTION_ITEM, amount: person.personalPensionContribution });
    }
  });
  return [...items, ...extra.map((item) => ({ ...item }))];
}

function employmentIncomeOf(facts, personId) {
  return sum(facts.income.filter((item) => item.personId === personId && item.type === EMPLOYMENT_ITEM).map((item) => item.amount));
}

function otherIncomeOf(facts, personId) {
  return sum(facts.income.filter((item) => item.personId === personId && item.type !== EMPLOYMENT_ITEM).map((item) => item.amount));
}

function otherIncomeOfType(facts, personId, type) {
  return sum(facts.income.filter((item) => item.personId === personId && item.type === type).map((item) => item.amount));
}

function hasJointIncome(facts) {
  return facts.income.some((item) => item.personId === 'joint' && item.amount > 0);
}

/* ----------------------------------------------------------------- cases */

function versionsFor(run, socialWelfare) {
  const versions = { taxRules: run.rulesVersion, assumptions: run.assumptionsVersion || PLANEIR_ASSUMPTIONS_VERSION };
  if (socialWelfare) versions.socialWelfare = socialWelfare;
  return versions;
}

/**
 * Take-home for each person in one phase, anchored to stated bank pay where it
 * is given. The anchor keeps today's pay as it is and moves it only by what the
 * tax engine says changes between today and this phase.
 */
function takeHomeFor(facts, today, run, stoppedId) {
  const exact = {};
  let adjustment = 0;
  facts.people.forEach((person) => {
    if (person.id === stoppedId || !run.byPerson[person.id]) {
      exact[person.id] = 0;
      return;
    }
    const estimate = run.byPerson[person.id].bank;
    if (person.anchorTakeHome === null) {
      exact[person.id] = Math.max(0, estimate);
      return;
    }
    const anchored = Math.max(0, person.anchorTakeHome + (estimate - today.byPerson[person.id].bank));
    adjustment += anchored - Math.max(0, estimate);
    exact[person.id] = anchored;
  });
  return { exact, adjustment };
}

/** One phase of the contract: rounded parts that add up to the rounded household net income. */
function buildPhase(facts, { takeHome, payment, months }) {
  const ids = facts.people.map((person) => person.id);
  const parts = [...ids.map((id) => takeHome[id]), payment ? payment.net : 0];
  const rounded = roundToTotal(parts);
  const phase = {
    takeHome: Object.fromEntries(ids.map((id, index) => [id, rounded.values[index]])),
    statePayment: null,
    householdNetIncome: rounded.total
  };
  if (months) phase.months = months;
  if (!payment) return phase;

  const net = rounded.values[ids.length];
  phase.statePayment = { personId: payment.personId, scheme: payment.scheme, amount: net };
  if (payment.scheme !== 'stated') {
    // The gross is the rate for the weeks, to the euro. Rounding the parts can leave
    // the net a euro above it, and then the gross is the net: no tax is shown as negative.
    const gross = Math.max(Math.round(payment.gross), net);
    phase.statePayment.grossAmount = gross;
    phase.statePayment.estimatedTax = gross - net;
    phase.statePayment.weeklyRate = payment.weeklyRate;
    phase.statePayment.weeks = payment.weeks;
    phase.statePayment.figure = payment.figure;
  }
  return phase;
}

function notShown(request, code, reason, scope = null) {
  return { id: request.id, kind: request.kind, personId: request.personId, shown: false, code, reason, ...(scope ? { scope } : {}) };
}

function incomeStopsCase(facts, today, request) {
  const person = facts.people.find((entry) => entry.id === request.personId);
  const scope = illnessBenefitScope({ employment: person.employment, employmentIncome: employmentIncomeOf(facts, person.id) });
  const stated = typeof request.statePayment === 'number';
  if (!scope.applies && !stated) {
    return notShown(request, scope.code, scope.reason, scope);
  }
  if (otherIncomeOf(facts, person.id) > 0 || hasJointIncome(facts)) {
    return notShown(
      request,
      'other_income_continues',
      'Other income continues when this income stops, and this illustration cannot yet show it beside the State payment.'
    );
  }

  let payment = null;
  let figure = null;
  let gross = 0;
  if (stated) {
    payment = { personId: person.id, scheme: 'stated', gross: request.statePayment, net: request.statePayment };
  } else {
    figure = registerRate(ILLNESS_BENEFIT_QUANTITY, facts.year);
    gross = figure.weeklyRate * ILLNESS_BENEFIT_WEEKS;
  }

  // Phase one: the payment is the recipient's own income, and the whole household is calculated afresh.
  const withPayment = runHousehold({
    year: facts.year,
    status: facts.status,
    people: facts.people,
    items: buildItems(facts, {
      dropFor: [person.id],
      extra: stated ? [] : [{ personId: person.id, type: 'illnessBenefit', amount: gross }]
    })
  });
  // Phase two: the year is over, the payment is not assumed to go on, and the household is calculated afresh again.
  const without = runHousehold({
    year: facts.year,
    status: facts.status,
    people: facts.people,
    items: buildItems(facts, { dropFor: [person.id] })
  });

  const first = takeHomeFor(facts, today, withPayment, person.id);
  const second = takeHomeFor(facts, today, without, person.id);

  if (!stated) {
    // The payment's net is the recipient's own share of the household's result.
    const recipient = withPayment.byPerson[person.id];
    payment = {
      personId: person.id,
      scheme: 'illnessBenefit',
      gross,
      net: gross - recipient.tax,
      weeklyRate: figure.weeklyRate,
      weeks: ILLNESS_BENEFIT_WEEKS,
      figure: figure.figure
    };
  }

  // A stated payment is used as given and does not end; a worked-out one is counted for the year.
  const phases = stated
    ? [buildPhase(facts, { takeHome: first.exact, payment })]
    : [
      buildPhase(facts, { takeHome: first.exact, payment, months: ILLNESS_BENEFIT_MONTHS }),
      buildPhase(facts, { takeHome: second.exact, payment: null })
    ];
  return {
    id: request.id,
    kind: request.kind,
    personId: person.id,
    shown: true,
    scenario: {
      id: request.id,
      event: { type: 'cannotWork', personId: person.id },
      income: {
        basis: 'estimated',
        calculationYear: facts.year,
        versions: versionsFor(withPayment, stated ? null : figure.figure.catalogueVersion),
        creditAllocation: withPayment.basis,
        phases
      }
    },
    assumptions: stated ? [] : provenance(registerFigures([figure.figure.id])),
    notes: [],
    reconciliation: {
      engineNetIncome: withPayment.netIncome,
      personalPension: withPayment.contributions,
      statedPayAdjustment: first.adjustment,
      statedPaymentAdded: stated ? request.statePayment : 0
    }
  };
}

function deathCase(facts, today, request) {
  if (facts.people.length !== 2) {
    return notShown(request, 'needs_two_people', 'A death is shown for a household of two people.');
  }
  const gone = facts.people.find((entry) => entry.id === request.personId);
  const survivor = facts.people.find((entry) => entry.id !== request.personId);
  if (hasJointIncome(facts)) {
    return notShown(request, 'joint_income', 'Some income is shared, and this illustration cannot yet show who keeps it after a death.');
  }
  if (!(today.byPerson[gone.id].bank > 0)) {
    return notShown(request, 'no_income_to_stop', 'There is no take-home to stop.');
  }
  // Only the higher of a survivor's own State Pension and the Bereaved Partner's (Contributory) Pension is paid.
  // That is a rule for the retirement years, so a survivor who already has a State Pension is not shown here.
  if (otherIncomeOfType(facts, facts.people.find((entry) => entry.id !== request.personId).id, 'statePension') > 0) {
    return notShown(
      request,
      'survivor_has_state_pension',
      'The survivor already has a State Pension, and only the higher of that and the Bereaved Partner’s (Contributory) Pension is paid. That rule is used in the retirement years, not in this illustration.'
    );
  }

  const stated = typeof request.survivorsPension === 'number';
  let figure = null;
  let gross = 0;
  if (!stated) {
    figure = registerRate(bereavedPartnerQuantity(survivor.age), facts.year);
    gross = figure.weeklyRate * ILLNESS_BENEFIT_WEEKS;
  }

  const survivorFacts = { ...facts, people: [survivor] };
  const base = { year: facts.year, status: 'widowed_or_surviving_civil_partner', people: [survivor] };
  const survivorItems = buildItems(survivorFacts, { keepOnly: survivor.id });
  const salaryRun = runHousehold({ ...base, items: survivorItems });

  let payment;
  let run = salaryRun;
  let engineNetIncome = salaryRun.netIncome;
  if (stated) {
    payment = { personId: survivor.id, scheme: 'stated', gross: request.survivorsPension, net: request.survivorsPension };
  } else {
    const full = runHousehold({
      ...base,
      items: buildItems(survivorFacts, {
        keepOnly: survivor.id,
        extra: [{ personId: survivor.id, type: 'bereavedPartnerPension', amount: gross }]
      })
    });
    // One person's tax on pay and pension is shared by taxable income; what is left is the pay's.
    const entry = full.byPerson[survivor.id];
    const paymentTax = entry.gross > 0 ? entry.tax * (gross / entry.gross) : 0;
    payment = {
      personId: survivor.id,
      scheme: 'bereavedPartnerPension',
      gross,
      net: gross - paymentTax,
      weeklyRate: figure.weeklyRate,
      weeks: ILLNESS_BENEFIT_WEEKS,
      figure: figure.figure
    };
    run = {
      ...full,
      byPerson: { [survivor.id]: { ...entry, tax: entry.tax - paymentTax, bank: entry.bank - (gross - paymentTax) } }
    };
    engineNetIncome = full.netIncome;
  }

  const estimate = run.byPerson[survivor.id].bank;
  const anchored = survivor.anchorTakeHome === null
    ? Math.max(0, estimate)
    : Math.max(0, survivor.anchorTakeHome + (estimate - today.byPerson[survivor.id].bank));
  const adjustment = survivor.anchorTakeHome === null ? 0 : anchored - Math.max(0, estimate);

  return {
    id: request.id,
    kind: request.kind,
    personId: gone.id,
    shown: true,
    scenario: {
      id: request.id,
      event: { type: 'dies', personId: gone.id },
      income: {
        basis: 'estimated',
        calculationYear: facts.year,
        versions: versionsFor(salaryRun, stated ? null : figure.figure.catalogueVersion),
        creditAllocation: 'own',
        phases: [buildPhase(facts, { takeHome: { [gone.id]: 0, [survivor.id]: anchored }, payment })]
      }
    },
    assumptions: provenance([
      ...(stated ? [] : registerFigures([figure.figure.id])),
      ...survivorRuleFigures({ includeQualifies: !stated }),
      ...(gone.definedBenefit ? registerFigures([SURVIVOR_DB_SHARE_ID]) : [])
    ]),
    notes: gone.definedBenefit
      ? [`${gone.label}’s defined benefit pension would pay the survivor ${registerFigures([SURVIVOR_DB_SHARE_ID])[0].valueShown} of it, a central assumption. Its amount is not recorded, so nothing is counted for it.`]
      : [],
    reconciliation: {
      engineNetIncome,
      personalPension: salaryRun.contributions,
      statedPayAdjustment: adjustment,
      statedPaymentAdded: stated ? request.survivorsPension : 0
    }
  };
}

/**
 * The cases for a household, each calculated afresh from the same facts.
 *
 * @param {object} rawFacts
 * @param {number} rawFacts.year the calculation year
 * @param {string} rawFacts.taxStatus the household's tax assessment status
 * @param {Array<{ id: string, label: string, age: number, employment?: string,
 *   personalPensionContribution?: number, anchorTakeHome?: number }>} rawFacts.people
 * @param {Array<{ personId: string, type: string, amount: number }>} rawFacts.income
 *   the household's recurring income, as the cash flow engine takes it
 * @param {Array<{ kind: 'incomeStops'|'death', personId: string, id?: string,
 *   statePayment?: number, survivorsPension?: number }>} requests
 *   `statePayment` and `survivorsPension` are stated net amounts, used as given
 * @returns {{ today: object, cases: object[] }}
 */
export function buildProtectionIncomeCases(rawFacts, requests) {
  const facts = copyFacts(rawFacts);
  const today = runHousehold({
    year: facts.year,
    status: facts.status,
    people: facts.people,
    items: buildItems(facts)
  });
  const cases = requests.map((raw) => {
    const request = {
      ...raw,
      id: raw.id || (raw.kind === 'death' ? `${raw.personId}-died` : `${raw.personId}-cannot-work`)
    };
    if (!facts.people.some((person) => person.id === request.personId)) {
      throw new Error(`${request.kind} names "${request.personId}", who is not one of the people.`);
    }
    if (request.kind === 'incomeStops') return incomeStopsCase(facts, today, request);
    if (request.kind === 'death') return deathCase(facts, today, request);
    throw new Error(`"${request.kind}" is not a protection case. Use incomeStops or death.`);
  });
  return {
    today: {
      year: facts.year,
      creditAllocation: today.basis,
      takeHome: Object.fromEntries(facts.people.map((person) => [person.id, today.byPerson[person.id].bank])),
      netIncome: today.netIncome,
      personalPension: today.contributions,
      versions: versionsFor(today, null)
    },
    cases
  };
}
