/**
 * Home, trade down: what a yearly repayment you are comfortable with buys.
 *
 * A household owns a home with a mortgage. A case either stays, or moves and
 * repays a stated amount a year on a new loan. The engine solves the loan that
 * repayment supports and the home budget it makes, and shows what the move
 * frees each year.
 *
 * THE MODEL
 *
 *   released       = homeValue - mortgageBalance - sellingCosts
 *   cashTowardHome = released - buyingCosts
 *
 *   Stay:  block 1 = homeValue - mortgageBalance, block 2 = mortgageBalance,
 *          budget = homeValue, freed = 0.
 *   Move at a yearly repayment R:
 *          loan   = (R / 12) x (1 - (1 + i)^-n) / i, where i is the annual rate
 *                   over 12 and n is the term in months
 *          budget = cashTowardHome + loan
 *          freed  = currentAnnualRepayments - R
 *
 * Payments are monthly, compounded monthly. That is what reproduces the design
 * sample (a loan of 203,000 at 18,000 a year, 135,000 at 12,000 a year, over 15
 * years at 4%). Annual compounding gives 200,131 and 133,421.
 *
 * A case states how much is repaid, never how big the home is.
 *
 * WHERE THE LOAN TERMS COME FROM
 *
 * `newLoanTermYears` and `newLoanAnnualRate` are inputs: they belong to the
 * client's loan, not to a central assumption, and there is no default.
 *
 * ROUNDING
 *
 * The new loan is rounded to the nearest €1,000 for display. Every other amount
 * is shown to the euro, and what is shown adds up, as the household cash flow
 * does: each input is rounded on its own, and every figure that depends on them
 * is DERIVED from those rounded figures, not rounded from the exact sum.
 *
 *   released shown = home shown - mortgage shown - selling costs shown
 *   cash shown     = released shown - buying costs shown
 *   budget shown   = cash shown (or home less mortgage, staying) + loan shown
 *   freed shown    = repaid today, shown - repaid on the new loan, shown
 *
 * With cents in the inputs, 100.60 repaid today and 33.40 repaid on the new loan
 * frees 67.20, which rounds to 67 and sits beside 101 and 33. Derived, it shows
 * 68, so 101 less 33 is what the screen says. The exact figures stay beside the
 * shown ones in `debug`.
 *
 * WORDING
 *
 * A case title or description is shown as given. They are checked here, on the
 * way in, against the banned wording, which the view's own scan uses too.
 */

import { MAX_MODULE_SCENARIO_CASES } from './scenario_cap.js';

const FIELD = 'generated.homeTradeDownInputs';

const KINDS = Object.freeze(['stay', 'move']);
const INPUT_FIELDS = Object.freeze([
  'homeValue',
  'mortgageBalance',
  'currentAnnualRepayments',
  'sellingCosts',
  'buyingCosts',
  'newLoanTermYears',
  'newLoanAnnualRate',
  'baseScenarioId',
  'scenarios'
]);
const CASE_FIELDS = Object.freeze(['id', 'kind', 'title', 'description', 'annualRepayment']);

/**
 * Words that may never be on this screen: no recommendation, and no "we", "us"
 * or "our" (the screen speaks to you). The view's own scan uses these, and so
 * does the input check, because a case title or description is shown as given.
 */
export const HOME_TRADE_DOWN_BANNED_PHRASES = Object.freeze([
  /\bwe recommend\b/i,
  /\byou should\b/i,
  /\bbest option\b/i,
  /\bbest\b/i,
  /\bideal\b/i,
  /\boptimal\b/i,
  /\bp\.a\./i,
  /\bwe\b/i,
  /\bus\b/i,
  /\bour\b/i
]);

const MIN_TERM_YEARS = 1;
const MAX_TERM_YEARS = 40;
const MAX_ANNUAL_RATE = 0.15;
const LOAN_ROUNDING_EUR = 1_000;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function has(raw, key) {
  return Object.prototype.hasOwnProperty.call(raw, key) && typeof raw[key] !== 'undefined';
}

/** "€18,000". */
export function euroText(amount) {
  return `€${Math.round(amount).toLocaleString('en-IE')}`;
}

function roundLoan(amount) {
  return Math.round(amount / LOAN_ROUNDING_EUR) * LOAN_ROUNDING_EUR;
}

/** The title a case gets when the payload gives none. */
function derivedCaseTitle(kind, annualRepayment) {
  if (kind === 'stay') {
    return 'Stay';
  }
  return annualRepayment > 0 ? `Repay ${euroText(annualRepayment)} a year` : 'No mortgage';
}

/**
 * The loan a yearly repayment supports: the inverse of the monthly payment on a
 * loan, with payments monthly and compounded monthly.
 */
export function loanFromAnnualRepayment(annualRepayment, termYears, annualRate) {
  if (annualRepayment === 0) {
    return 0;
  }
  const months = termYears * 12;
  const monthly = annualRepayment / 12;
  const monthlyRate = annualRate / 12;
  if (monthlyRate === 0) {
    return monthly * months;
  }
  // 1 - (1 + r)^-n, written so that a rate near zero keeps its digits. Computed
  // directly, 1 + r is exactly 1 at a rate of 1e-16 (the loan comes out as 0) and
  // keeps only a few digits at 1e-14 (a loan of 191,847 where 180,000 is right).
  // log1p and expm1 do not form 1 + r or subtract two numbers that are nearly
  // equal, and they agree with the direct form at every ordinary rate.
  const growth = -Math.expm1(-months * Math.log1p(monthlyRate));
  return (monthly * growth) / monthlyRate;
}

/**
 * The inputs as the screen shows them, and what follows from them as shown.
 *
 * Each input is rounded on its own, and what depends on them is derived from the
 * rounded figures, so every row adds down to the next.
 */
function shownFigures(inputs) {
  const homeValue = Math.round(inputs.homeValue);
  const mortgageBalance = Math.round(inputs.mortgageBalance);
  const sellingCosts = Math.round(inputs.sellingCosts);
  const buyingCosts = Math.round(inputs.buyingCosts);
  const released = homeValue - mortgageBalance - sellingCosts;
  return {
    homeValue,
    mortgageBalance,
    sellingCosts,
    buyingCosts,
    currentAnnualRepayments: Math.round(inputs.currentAnnualRepayments),
    released,
    cashTowardHome: released - buyingCosts
  };
}

/**
 * What a move at a yearly repayment buys, as the screen will show it.
 *
 * Shared by the normaliser, which refuses a budget above the current home, and
 * the projection, so the two cannot disagree about it.
 */
function priceMove(inputs, annualRepayment, cashTowardHome) {
  const loanUnrounded = loanFromAnnualRepayment(
    annualRepayment,
    inputs.newLoanTermYears,
    inputs.newLoanAnnualRate
  );
  const block1 = shownFigures(inputs).cashTowardHome;
  const block2 = roundLoan(loanUnrounded);
  return {
    loanUnrounded,
    block1,
    block2,
    homeBudget: block1 + block2,
    homeBudgetUnrounded: cashTowardHome + loanUnrounded
  };
}

/** Refuse client-facing text this screen may not show. */
function refuseForbiddenWording(text, path) {
  if (HOME_TRADE_DOWN_BANNED_PHRASES.some((pattern) => pattern.test(text))) {
    throw new Error(
      `${FIELD}.${path} ("${text}"): this screen shows what a repayment buys, `
      + 'never a recommendation, and speaks to you, never as "we", "us" or "our".'
    );
  }
}

function normalizeCase(rawCase, index, currentAnnualRepayments) {
  const label = `scenarios[${index}]`;
  if (!rawCase || typeof rawCase !== 'object' || Array.isArray(rawCase)) {
    throw new Error(`${FIELD}.${label} must be an object.`);
  }

  if (typeof rawCase.id !== 'string' || rawCase.id.trim() === '') {
    throw new Error(`${FIELD}.${label}.id must be a non-empty string.`);
  }
  const id = rawCase.id.trim();

  if (!KINDS.includes(rawCase.kind)) {
    throw new Error(`${FIELD}.${label} (${id}): kind must be "stay" or "move".`);
  }
  const { kind } = rawCase;

  const givenTitle = typeof rawCase.title === 'string' && rawCase.title.trim()
    ? rawCase.title.trim()
    : '';

  let annualRepayment = null;
  if (kind === 'move') {
    // A title built from a repayment that is not a number, or is negative,
    // would mislead ("NaN", or "No mortgage" for minus one), so use the id.
    const named = givenTitle
      || (isFiniteNumber(rawCase.annualRepayment) && rawCase.annualRepayment >= 0
        ? derivedCaseTitle('move', rawCase.annualRepayment)
        : id);
    if (!isFiniteNumber(rawCase.annualRepayment)
      || rawCase.annualRepayment < 0
      || rawCase.annualRepayment > currentAnnualRepayments) {
      throw new Error(
        `${FIELD}.${label} (${named}): annualRepayment must be a number from 0 up to currentAnnualRepayments.`
      );
    }
    annualRepayment = rawCase.annualRepayment;
  }

  const title = givenTitle || derivedCaseTitle(kind, annualRepayment);

  Object.keys(rawCase).forEach((key) => {
    if (!CASE_FIELDS.includes(key) && typeof rawCase[key] !== 'undefined') {
      throw new Error(`${FIELD}.${label} (${title}): "${key}" is not a case field.`);
    }
  });

  const description = typeof rawCase.description === 'string' ? rawCase.description.trim() : '';

  // A title built here ("Repay €18,000 a year") is clean by construction, so
  // only what the payload gave is checked, as it will be shown as given.
  if (givenTitle) refuseForbiddenWording(givenTitle, `${label}.title`);
  if (description) refuseForbiddenWording(description, `${label}.description`);

  return { id, kind, title, description, annualRepayment };
}

/**
 * Validate a payload and return it in canonical form.
 *
 * Idempotent: normalising a normalised payload returns an equal one.
 */
export function normalizeHomeTradeDownInputs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${FIELD} must be an object.`);
  }

  Object.keys(raw).forEach((key) => {
    if (!INPUT_FIELDS.includes(key) && typeof raw[key] !== 'undefined') {
      throw new Error(`${FIELD}.${key} is not an input of this module.`);
    }
  });

  ['homeValue', 'mortgageBalance', 'currentAnnualRepayments'].forEach((key) => {
    if (!isFiniteNumber(raw[key]) || raw[key] <= 0) {
      throw new Error(`${FIELD}.${key} must be a number greater than 0.`);
    }
  });
  ['sellingCosts', 'buyingCosts'].forEach((key) => {
    if (!isFiniteNumber(raw[key]) || raw[key] < 0) {
      throw new Error(`${FIELD}.${key} must be a number greater than or equal to 0.`);
    }
  });

  if (!isFiniteNumber(raw.newLoanTermYears)
    || !Number.isInteger(raw.newLoanTermYears)
    || raw.newLoanTermYears < MIN_TERM_YEARS
    || raw.newLoanTermYears > MAX_TERM_YEARS) {
    throw new Error(
      `${FIELD}.newLoanTermYears must be a whole number of years from ${MIN_TERM_YEARS} to ${MAX_TERM_YEARS}.`
    );
  }
  if (!isFiniteNumber(raw.newLoanAnnualRate)
    || raw.newLoanAnnualRate < 0
    || raw.newLoanAnnualRate > MAX_ANNUAL_RATE) {
    throw new Error(`${FIELD}.newLoanAnnualRate must be a number from 0 to ${MAX_ANNUAL_RATE}.`);
  }

  // Both on the exact figures and on the figures as shown, so a payload that
  // clears by less than a euro never shows a minus.
  const released = raw.homeValue - raw.mortgageBalance - raw.sellingCosts;
  const shown = shownFigures(raw);
  if (released < 0 || shown.released < 0) {
    throw new Error(`${FIELD}.sellingCosts: selling would not clear the mortgage.`);
  }
  if (raw.buyingCosts > released || shown.buyingCosts > shown.released) {
    throw new Error(`${FIELD}.buyingCosts: the money from selling does not cover the buying costs.`);
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
    const normalized = normalizeCase(rawCase, index, raw.currentAnnualRepayments);
    if (usedIds.has(normalized.id)) {
      throw new Error(`${FIELD}.scenarios[${index}].id must be unique.`);
    }
    usedIds.add(normalized.id);
    return normalized;
  });

  // What is shown must not outgrow today's home: this module shows trading down.
  const cashTowardHome = released - raw.buyingCosts;
  scenarios.forEach((scenario, index) => {
    if (scenario.kind !== 'move') {
      return;
    }
    const priced = priceMove(raw, scenario.annualRepayment, cashTowardHome);
    if (priced.homeBudget > Math.round(raw.homeValue)) {
      throw new Error(
        `${FIELD}.scenarios[${index}] (${scenario.title}): the home budget is more than the current home. `
        + 'This module shows trading down.'
      );
    }
  });

  let baseScenarioId = scenarios[0].id;
  if (has(raw, 'baseScenarioId')) {
    const requested = typeof raw.baseScenarioId === 'string' ? raw.baseScenarioId.trim() : '';
    if (!requested || !scenarios.some((scenario) => scenario.id === requested)) {
      throw new Error(`${FIELD}.baseScenarioId must match a case id.`);
    }
    baseScenarioId = requested;
  }

  return {
    homeValue: raw.homeValue,
    mortgageBalance: raw.mortgageBalance,
    currentAnnualRepayments: raw.currentAnnualRepayments,
    sellingCosts: raw.sellingCosts,
    buyingCosts: raw.buyingCosts,
    newLoanTermYears: raw.newLoanTermYears,
    newLoanAnnualRate: raw.newLoanAnnualRate,
    baseScenarioId,
    scenarios
  };
}

/** `[{ id, title, description }]`, for the presenter and the case buttons. */
export function getHomeTradeDownCases(rawInputs) {
  return normalizeHomeTradeDownInputs(rawInputs).scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    description: scenario.description
  }));
}

export function getDefaultHomeTradeDownScenarioId(rawInputs) {
  return normalizeHomeTradeDownInputs(rawInputs).baseScenarioId;
}

function solveCase(inputs, scenario, released, cashTowardHome) {
  const shown = shownFigures(inputs);
  let block1;
  let block2;
  let loanUnrounded = 0;
  let repaid;
  let shownRepaid;
  let freed;
  let homeBudgetUnrounded;

  if (scenario.kind === 'stay') {
    // Home worth as shown, less the mortgage as shown, so the two blocks add to
    // the home worth that the assumptions show.
    block2 = shown.mortgageBalance;
    block1 = shown.homeValue - shown.mortgageBalance;
    repaid = inputs.currentAnnualRepayments;
    shownRepaid = shown.currentAnnualRepayments;
    freed = 0;
    homeBudgetUnrounded = inputs.homeValue;
  } else {
    const priced = priceMove(inputs, scenario.annualRepayment, cashTowardHome);
    ({ block1, block2, loanUnrounded, homeBudgetUnrounded } = priced);
    repaid = scenario.annualRepayment;
    shownRepaid = Math.round(scenario.annualRepayment);
    freed = inputs.currentAnnualRepayments - scenario.annualRepayment;
  }

  // What is shown is what must add up: the budget is the two blocks as shown,
  // and what is freed is today's repayments as shown less what is repaid as shown.
  const homeBudget = block1 + block2;
  const shownFreed = shown.currentAnnualRepayments - shownRepaid;

  return {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    kind: scenario.kind,
    annualRepayment: scenario.annualRepayment,
    block1,
    block2,
    loanUnrounded,
    homeBudget,
    homeBudgetUnrounded,
    repaid,
    freed,
    shownRepaid,
    shownFreed,
    released
  };
}

function buildAssumptionsTable(inputs, shown) {
  return {
    columns: ['Assumption', 'Input Used'],
    rows: [
      ['Home value today', euroText(shown.homeValue)],
      ['Mortgage today', euroText(shown.mortgageBalance)],
      ['Repaid on the mortgage today', `${euroText(shown.currentAnnualRepayments)} a year`],
      ['Selling costs', euroText(shown.sellingCosts)],
      ['Released by selling, after the mortgage and selling costs', euroText(shown.released)],
      ['Buying costs', euroText(shown.buyingCosts)],
      ['Cash toward a new home, after buying costs', euroText(shown.cashTowardHome)],
      ['New loan term', `${inputs.newLoanTermYears} ${inputs.newLoanTermYears === 1 ? 'year' : 'years'}`],
      ['New loan rate', `${Number((inputs.newLoanAnnualRate * 100).toFixed(2))}% a year`],
      ['Payments', 'Monthly, with interest compounded monthly'],
      ['Where the figures come from', 'Every figure is as stated. Nothing here is estimated.'],
      ['Rounding', 'Amounts are shown to the euro and add down as shown. New loans are shown to the nearest €1,000. The home budget is the two blocks as shown.'],
      ['Not modelled', 'Whether a lender would offer the loan, and any grants or tax']
    ]
  };
}

function buildOutputsTable(cases) {
  return {
    columns: ['Case', 'Repaid a year (€)', 'Freed a year (€)', 'New loan (€)', 'Home budget (€)'],
    rows: cases.map((entry) => [
      entry.title,
      entry.shownRepaid,
      entry.shownFreed,
      entry.kind === 'stay' ? 0 : entry.block2,
      entry.homeBudget
    ])
  };
}

function buildTables(cases) {
  return cases.map((entry) => {
    const stay = entry.kind === 'stay';
    return {
      title: `${entry.title}: how the home is made up`,
      columns: ['Line', 'Amount (€)'],
      rows: [
        [stay ? 'Your share of the home' : 'From selling, after buying costs', entry.block1],
        [stay ? 'Mortgage' : (entry.block2 > 0 ? 'New loan' : 'No new loan'), entry.block2],
        [stay ? 'Home worth' : 'Home budget', entry.homeBudget]
      ]
    };
  });
}

function buildCharts(cases) {
  return [{
    title: 'The home each case buys',
    subtitle: 'The home worth today, and the home budget of each case.',
    type: 'bar',
    labels: cases.map((entry) => entry.title),
    datasets: [{
      label: 'Home budget',
      data: cases.map((entry) => entry.homeBudget)
    }],
    display: {
      variant: 'wide',
      valueFormat: 'currency',
      yAxisTitle: 'Home budget'
    }
  }];
}

/**
 * Solve every case of a payload.
 *
 * @param {object} rawInputs `generated.homeTradeDownInputs`
 */
export function computeHomeTradeDownProjection(rawInputs) {
  const inputs = normalizeHomeTradeDownInputs(rawInputs);
  const released = inputs.homeValue - inputs.mortgageBalance - inputs.sellingCosts;
  const cashTowardHome = released - inputs.buyingCosts;

  const shown = shownFigures(inputs);
  const cases = inputs.scenarios.map((scenario) => (
    solveCase(inputs, scenario, released, cashTowardHome)
  ));
  const baseCase = cases.find((entry) => entry.id === inputs.baseScenarioId) || cases[0];

  return {
    assumptionsTable: buildAssumptionsTable(inputs, shown),
    outputsTable: buildOutputsTable(cases),
    tables: buildTables(cases),
    // One ordinary chart for the surfaces that have no module to draw for them.
    charts: buildCharts(cases),
    debug: {
      inputs,
      released,
      cashTowardHome,
      shown,
      cases,
      baseScenarioId: baseCase.id,
      assumptionsUsed: {
        newLoanTermYears: inputs.newLoanTermYears,
        newLoanAnnualRate: inputs.newLoanAnnualRate,
        source: 'payload',
        timing: 'monthly, compounded monthly'
      }
    }
  };
}
