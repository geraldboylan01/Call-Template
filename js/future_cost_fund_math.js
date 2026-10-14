/**
 * Future cost fund: what it takes to have the money ready for a dated cost.
 *
 * A client knows a cost is coming on a date: college, care for a parent,
 * school fees. This engine takes ONE such cost and up to four ways of funding
 * it, and solves what each way asks of the client. Every way arrives at the
 * same place; what differs is when the money leaves the client's hands.
 *
 * `js/college_funding_math.js` projects what a cost will be. This is the
 * savings half it never had.
 *
 * THE MODEL, AND ITS TIMING CONVENTION
 *
 * Every flow happens at the START of a year. Cost year `k` (0-based) is paid at
 * the start of year `startsInYears + k` and equals
 * `annualCostToday x (1 + priceGrowthRate)^(startsInYears + k)`. Money held
 * grows by the net cash rate over each year. A payment made at the start of year
 * `t` therefore has `startsInYears + k - t` years to grow before cost year `k`
 * is paid.
 *
 *   requiredToday = the present value, at the net cash rate, of every cost year
 *   lump sum today = lumpShare x requiredToday
 *   yearly amount  = (1 - lumpShare) x requiredToday / the present value of
 *                    one euro paid at the start of each saving year
 *
 * A case states HOW the cost is funded, never how much. The engine solves the
 * amounts, so a case that cannot be solved is refused on the way in rather than
 * drawn wrongly.
 *
 * WHERE THE RATES COME FROM
 *
 * Nothing is typed into the payload. The price rate is the central education
 * or general inflation assumption, the cash rate is the central instant-access
 * rate, and DIRT is read from the Irish tax catalogue, so this module holds no
 * copy of any of them. The net cash rate is `gross x (1 - DIRT)`, compounded
 * once a year because DIRT is taken when the interest is credited.
 *
 * `options` exists so tests can inject a design fixture. It is never reachable
 * from a payload.
 */

import { MAX_MODULE_SCENARIO_CASES } from './scenario_cap.js';
import { resolvePlanningAssumptions } from './planning/planeir_assumptions.js';
import { resolveTaxRules } from './planning/tax/resolve.js';
import { IE_TAX_FIRST_YEAR } from './planning/tax/rules_ie.js';

const FIELD = 'generated.futureCostFundInputs';
const COST_KINDS = Object.freeze(['education', 'general']);
const MAX_STARTS_IN_YEARS = 40;
const MAX_DURATION_YEARS = 30;
const MAX_TITLE_LENGTH = 60;
const CLOSING_BALANCE_TOLERANCE_EUR = 0.01;

/** A payload carrying any of these is refused: rates are central, not typed. */
const REFUSED_RATE_FIELDS = Object.freeze([
  'priceGrowthRate',
  'savingsGrowthRate',
  'inflationRate',
  'dirtRate'
]);

const CASE_FIELDS = Object.freeze(['id', 'title', 'description', 'lumpShare', 'savingStartsInYears']);

const NUMBER_WORDS = Object.freeze([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'
]);

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function has(raw, key) {
  return Object.prototype.hasOwnProperty.call(raw, key) && typeof raw[key] !== 'undefined';
}

function requireWholeYears(value, fieldName, { min, max = Infinity, rangeText }) {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${FIELD}.${fieldName} must be a whole number of years${rangeText}.`);
  }
  return value;
}

/** "4%" when whole, otherwise at most two decimals ("0.2%", "0.13%"). */
export function percentText(decimal) {
  const percent = decimal * 100;
  const rounded = Math.round(percent * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

export function euroText(amount) {
  return `€${Math.round(amount).toLocaleString('en-IE')}`;
}

export function roundToHundred(amount) {
  return Math.round(amount / 100) * 100;
}

function yearsText(count) {
  const word = count >= 0 && count <= 10 ? NUMBER_WORDS[count] : String(count);
  return `${word} ${count === 1 ? 'year' : 'years'}`;
}

/** The title a case gets when the payload gives none. */
function derivedCaseTitle({ lumpShare, savingStartsInYears }) {
  if (lumpShare >= 1) {
    return 'Lump sum today';
  }
  if (lumpShare > 0) {
    return 'Part now, part each year';
  }
  if (savingStartsInYears > 0) {
    return `Start in ${savingStartsInYears} years`;
  }
  return 'Save every year';
}

function normalizeCase(rawCase, index, startsInYears) {
  const label = `scenarios[${index}]`;
  if (!rawCase || typeof rawCase !== 'object' || Array.isArray(rawCase)) {
    throw new Error(`${FIELD}.${label} must be an object.`);
  }

  if (typeof rawCase.id !== 'string' || rawCase.id.trim() === '') {
    throw new Error(`${FIELD}.${label}.id must be a non-empty string.`);
  }
  const id = rawCase.id.trim();

  let lumpShare = 0;
  if (has(rawCase, 'lumpShare')) {
    if (!isFiniteNumber(rawCase.lumpShare) || rawCase.lumpShare < 0 || rawCase.lumpShare > 1) {
      throw new Error(`${FIELD}.${label} (${id}): lumpShare must be a number from 0 to 1.`);
    }
    lumpShare = rawCase.lumpShare;
  }

  let savingStartsInYears = 0;
  if (has(rawCase, 'savingStartsInYears')) {
    if (!isFiniteNumber(rawCase.savingStartsInYears)
      || !Number.isInteger(rawCase.savingStartsInYears)
      || rawCase.savingStartsInYears < 0) {
      throw new Error(`${FIELD}.${label} (${id}): savingStartsInYears must be a whole number of years, 0 or more.`);
    }
    savingStartsInYears = rawCase.savingStartsInYears;
  }

  // A lump sum that covers the whole cost leaves nothing to save, so a start
  // for the saving is ignored rather than refused.
  if (lumpShare >= 1) {
    savingStartsInYears = 0;
  }

  const title = typeof rawCase.title === 'string' && rawCase.title.trim()
    ? rawCase.title.trim()
    : derivedCaseTitle({ lumpShare, savingStartsInYears });

  Object.keys(rawCase).forEach((key) => {
    if (!CASE_FIELDS.includes(key)) {
      throw new Error(`${FIELD}.${label} (${title}): "${key}" is not a case field.`);
    }
  });

  if (lumpShare < 1 && savingStartsInYears >= startsInYears) {
    throw new Error(`${FIELD}.${label} (${title}): savingStartsInYears must be less than startsInYears.`);
  }

  const description = typeof rawCase.description === 'string' ? rawCase.description.trim() : '';

  return { id, title, description, lumpShare, savingStartsInYears };
}

/**
 * Validate a payload and return it in canonical form.
 *
 * Idempotent: normalising a normalised payload returns an equal one.
 */
export function normalizeFutureCostFundInputs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${FIELD} must be an object.`);
  }

  REFUSED_RATE_FIELDS.forEach((key) => {
    if (has(raw, key)) {
      throw new Error(`${FIELD}.${key} is not accepted. Rates are set centrally in the Planéir assumptions.`);
    }
  });

  const costTitle = typeof raw.costTitle === 'string' ? raw.costTitle.trim() : '';
  if (costTitle.length < 1 || costTitle.length > MAX_TITLE_LENGTH) {
    throw new Error(`${FIELD}.costTitle must be 1 to ${MAX_TITLE_LENGTH} characters.`);
  }

  if (!COST_KINDS.includes(raw.costKind)) {
    throw new Error(`${FIELD}.costKind must be "education" or "general".`);
  }

  const startsInYears = requireWholeYears(raw.startsInYears, 'startsInYears', {
    min: 1,
    max: MAX_STARTS_IN_YEARS,
    rangeText: ` from 1 to ${MAX_STARTS_IN_YEARS}`
  });
  const durationYears = requireWholeYears(raw.durationYears, 'durationYears', {
    min: 1,
    max: MAX_DURATION_YEARS,
    rangeText: ` from 1 to ${MAX_DURATION_YEARS}`
  });

  if (!isFiniteNumber(raw.annualCostToday) || raw.annualCostToday <= 0) {
    throw new Error(`${FIELD}.annualCostToday must be greater than 0.`);
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
    const normalized = normalizeCase(rawCase, index, startsInYears);
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

  return {
    costTitle,
    costKind: raw.costKind,
    startsInYears,
    durationYears,
    annualCostToday: raw.annualCostToday,
    baseScenarioId,
    scenarios
  };
}

/** `[{ id, title, description }]`, for the presenter and the case buttons. */
export function getFutureCostFundCases(rawInputs) {
  return normalizeFutureCostFundInputs(rawInputs).scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    description: scenario.description
  }));
}

export function getDefaultFutureCostFundScenarioId(rawInputs) {
  return normalizeFutureCostFundInputs(rawInputs).baseScenarioId;
}

/**
 * The rates in force, and where each came from.
 *
 * `assumptions` and `taxCatalogue` are the injection points tests use. With
 * neither, every rate is the central one.
 */
function resolveRates(inputs, { assumptions, calculationYear, taxCatalogue } = {}) {
  const central = assumptions || resolvePlanningAssumptions();
  const year = Number.isInteger(calculationYear)
    ? calculationYear
    : Math.max(IE_TAX_FIRST_YEAR, new Date().getFullYear());
  const taxRules = resolveTaxRules(year, taxCatalogue ? { catalogue: taxCatalogue } : {});

  const isEducation = inputs.costKind === 'education';
  const priceGrowthRate = isEducation ? central.inflation.educationRate : central.inflation.generalRate;
  const cashRateGross = central.cash.instantAccessGrossRate;
  const dirtRate = taxRules.dirt.rate;
  const cashRateNet = cashRateGross * (1 - dirtRate);

  return {
    priceGrowthRate,
    priceGrowthSource: isEducation ? 'inflation.educationRate' : 'inflation.generalRate',
    cashRateGross,
    dirtRate,
    dirtRuleId: taxRules.dirt.ruleId,
    cashRateNet,
    assumptionsVersion: central.version,
    taxRulesVersion: taxRules.version,
    calculationYear: year
  };
}

/** Present value, at the start of year 0, of one euro paid at the start of each year in [from, to). */
function annuityPresentValue(rate, from, to) {
  let sum = 0;
  for (let year = from; year < to; year += 1) {
    sum += (1 + rate) ** -year;
  }
  return sum;
}

function buildCostYears(inputs, rates) {
  const costs = [];
  for (let k = 0; k < inputs.durationYears; k += 1) {
    const yearIndex = inputs.startsInYears + k;
    costs.push({
      yearIndex,
      cost: inputs.annualCostToday * (1 + rates.priceGrowthRate) ** yearIndex
    });
  }
  return costs;
}

function solveCase(inputs, scenario, rates, costs, requiredToday) {
  const r = rates.cashRateNet;
  const totalCost = costs.reduce((sum, entry) => sum + entry.cost, 0);

  const lumpSumToday = scenario.lumpShare * requiredToday;
  const savingYears = scenario.lumpShare >= 1
    ? 0
    : inputs.startsInYears - scenario.savingStartsInYears;
  const yearlyAmount = savingYears > 0
    ? ((1 - scenario.lumpShare) * requiredToday)
      / annuityPresentValue(r, scenario.savingStartsInYears, inputs.startsInYears)
    : 0;

  const lastYear = inputs.startsInYears + inputs.durationYears - 1;
  const rows = [];
  let carried = 0;
  for (let yearIndex = 0; yearIndex <= lastYear; yearIndex += 1) {
    const openingBalance = yearIndex === 0 ? 0 : carried * (1 + r);
    const payment = (yearIndex === 0 ? lumpSumToday : 0)
      + (savingYears > 0
        && yearIndex >= scenario.savingStartsInYears
        && yearIndex < inputs.startsInYears
        ? yearlyAmount
        : 0);
    const cost = costs.find((entry) => entry.yearIndex === yearIndex)?.cost ?? 0;
    const closingBalance = openingBalance + payment - cost;
    rows.push({ yearIndex, openingBalance, payment, cost, closingBalance });
    carried = closingBalance;
  }

  const finalClosing = rows[rows.length - 1].closingBalance;
  if (Math.abs(finalClosing) > CLOSING_BALANCE_TOLERANCE_EUR) {
    throw new Error(
      `${FIELD}.scenarios (${scenario.title}): the fund does not close at zero (${finalClosing.toFixed(4)}).`
    );
  }
  rows.forEach((row) => {
    if (row.closingBalance < -CLOSING_BALANCE_TOLERANCE_EUR) {
      throw new Error(
        `${FIELD}.scenarios (${scenario.title}): the fund goes below zero in year ${row.yearIndex}.`
      );
    }
  });

  const paidIn = lumpSumToday + savingYears * yearlyAmount;
  const growth = totalCost - paidIn;
  const costStart = rows[inputs.startsInYears];

  return {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    lumpShare: scenario.lumpShare,
    savingStartsInYears: scenario.savingStartsInYears,
    savingYears,
    lumpSumToday,
    yearlyAmount,
    paidIn,
    growth,
    totalCost,
    openingBalanceAtCostStart: costStart.openingBalance,
    peakOpeningBalance: Math.max(...rows.map((row) => row.openingBalance)),
    rows
  };
}

function buildAssumptionsTable(inputs, rates) {
  const isEducation = inputs.costKind === 'education';
  return {
    columns: ['Assumption', 'Input Used'],
    rows: [
      ['Cost', inputs.costTitle],
      ['Cost today', `${euroText(inputs.annualCostToday)} a year in today’s money`],
      ['Starts in', yearsText(inputs.startsInYears)],
      ['Runs for', yearsText(inputs.durationYears)],
      [
        isEducation ? 'Education cost growth' : 'Price growth',
        `${percentText(rates.priceGrowthRate)} a year`
      ],
      ['Interest on money held in cash, before DIRT', `${percentText(rates.cashRateGross)} a year`],
      ['DIRT', `${percentText(rates.dirtRate)}, applied at the standard rate`],
      ['Interest on money held in cash, after DIRT', `${percentText(rates.cashRateNet)} a year`],
      ['Timing', 'Payments and costs fall at the start of each year'],
      ['Rounding', 'Amounts are shown to the nearest €100'],
      ['Not modelled', 'Grants, savings wrappers, DIRT exemptions and any tax on the way out']
    ]
  };
}

function buildOutputsTable(cases) {
  return {
    columns: [
      'Case',
      'Lump sum today (€)',
      'Yearly saving (€)',
      'Years of saving',
      'You pay in (€)',
      'Growth (€)',
      'Total cost (€)'
    ],
    rows: cases.map((entry) => [
      entry.title,
      roundToHundred(entry.lumpSumToday),
      roundToHundred(entry.yearlyAmount),
      entry.savingYears,
      roundToHundred(entry.paidIn),
      // Always total minus paid in as SHOWN, so the support sentence adds up.
      roundToHundred(entry.totalCost) - roundToHundred(entry.paidIn),
      roundToHundred(entry.totalCost)
    ])
  };
}

function buildTables(cases) {
  return cases.map((entry) => ({
    title: `${entry.title} funding profile`,
    columns: ['Year', 'Fund at start of year (€)', 'You pay in (€)', 'Cost (€)', 'Fund after the year’s flows (€)'],
    rows: entry.rows.map((row) => [
      row.yearIndex === 0 ? 'Today' : `Year ${row.yearIndex}`,
      roundToHundred(row.openingBalance),
      roundToHundred(row.payment),
      roundToHundred(row.cost),
      roundToHundred(row.closingBalance)
    ])
  }));
}

function buildCharts(inputs, baseCase) {
  return [{
    title: `${inputs.costTitle}: money in the fund`,
    subtitle: `The fund at the start of each year for “${baseCase.title}”.`,
    type: 'line',
    labels: baseCase.rows.map((row) => (row.yearIndex === 0 ? 'Today' : `Year ${row.yearIndex}`)),
    datasets: [{
      label: 'Money in the fund',
      data: baseCase.rows.map((row) => roundToHundred(row.openingBalance))
    }],
    display: {
      variant: 'wide',
      valueFormat: 'currency',
      yAxisTitle: 'Fund at the start of the year'
    }
  }];
}

/**
 * Solve every case of a payload.
 *
 * @param {object} rawInputs `generated.futureCostFundInputs`
 * @param {object} [options]
 * @param {object} [options.assumptions] Test injection: replaces the central assumptions.
 * @param {number} [options.calculationYear] The tax year DIRT is read for.
 * @param {object} [options.taxCatalogue] Test injection: replaces the tax catalogue.
 */
export function computeFutureCostFundProjection(rawInputs, options = {}) {
  const inputs = normalizeFutureCostFundInputs(rawInputs);
  const rates = resolveRates(inputs, options);
  const costs = buildCostYears(inputs, rates);
  const totalCost = costs.reduce((sum, entry) => sum + entry.cost, 0);
  const requiredToday = costs.reduce(
    (sum, entry) => sum + entry.cost * (1 + rates.cashRateNet) ** -entry.yearIndex,
    0
  );

  const cases = inputs.scenarios.map((scenario) => solveCase(inputs, scenario, rates, costs, requiredToday));
  const baseCase = cases.find((entry) => entry.id === inputs.baseScenarioId) || cases[0];

  return {
    assumptionsTable: buildAssumptionsTable(inputs, rates),
    outputsTable: buildOutputsTable(cases),
    tables: buildTables(cases),
    // One ordinary chart for the surfaces that have no module to draw for them.
    charts: buildCharts(inputs, baseCase),
    debug: {
      inputs,
      totalCost,
      requiredToday,
      costYears: costs,
      cases,
      baseScenarioId: baseCase.id,
      assumptionsUsed: {
        priceGrowthRate: rates.priceGrowthRate,
        priceGrowthSource: rates.priceGrowthSource,
        cashRateGross: rates.cashRateGross,
        dirtRate: rates.dirtRate,
        dirtRuleId: rates.dirtRuleId,
        cashRateNet: rates.cashRateNet,
        assumptionsVersion: rates.assumptionsVersion,
        taxRulesVersion: rates.taxRulesVersion,
        calculationYear: rates.calculationYear,
        timing: 'start-of-year'
      }
    }
  };
}
