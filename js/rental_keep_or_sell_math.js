/**
 * Rental property: what it gives each year if you keep it, and what you would
 * have in hand if you sold it.
 *
 * The household states every figure. Nothing here is estimated and no tax is
 * calculated: the tax on the rental profit and the tax on the gain arrive as
 * stated amounts. The engine's job is to put them in order, so that a headline
 * (the rent, the sale price) can be cut down, step by step, to what actually
 * reaches the household.
 *
 * THE MODEL
 *
 * Both cases have the same shape, so a screen can move every mark from one
 * case to the other: a start, three cuts, a result. Five rows, always.
 *
 *   Keep: Rent, Loan repayments, Running costs, Tax on the rental profit,
 *         Net each year
 *   Sell: Sale price, Selling costs, Loan repaid, Tax on the gain, In hand
 *
 * `run` begins at the start amount. Each cut spans `[run - amount, run]` and
 * then `run -= amount`. The result is the final `run` and may be negative. Its
 * bar spans `[min(0, result), max(0, result)]`.
 *
 * There is no `scenarios` array. The two cases are fixed, with the ids `keep`
 * and `sell`.
 *
 * WHAT IS SHOWN, AND WHAT IT ADDS TO
 *
 * Amounts are shown to the nearest euro, and a figure that is rounded on its own
 * can contradict the ones beside it: a start of 100.40 less three cuts of 33.40
 * is 0.20, but its rows round to 100, 33, 33 and 33. So every row carries a
 * `shownAmount`, and the result shown is DERIVED from the rows shown (the shown
 * start less the shown cuts), as the household cash flow does. The exact figures
 * stay beside them for the checks. Whatever is on screen adds down to its last
 * line.
 *
 * WHAT COMES OFF
 *
 * `debug.cases[].comesOff` is the sum of the three cuts, with a name for what it
 * is, and `shownComesOff` is the sum of the cuts as shown. It exists for the
 * video, which shows three figures that add up. The screen never prints it.
 */

const FIELD = 'generated.rentalKeepOrSellInputs';

const CASE_IDS = Object.freeze(['keep', 'sell']);
const POSITIVE_FIELDS = Object.freeze(['salePrice']);
const NON_NEGATIVE_FIELDS = Object.freeze([
  'rentPerYear',
  'loanRepaymentsPerYear',
  'runningCostsPerYear',
  'taxOnRentalProfitPerYear',
  'sellingCosts',
  'loanBalance',
  'taxOnGain'
]);
const INPUT_FIELDS = Object.freeze([...POSITIVE_FIELDS, ...NON_NEGATIVE_FIELDS, 'baseScenarioId']);

/** Each case: where its start comes from, its three cuts in order, and its result. */
const CASE_SPECS = Object.freeze({
  keep: Object.freeze({
    id: 'keep',
    title: 'Keep',
    description: 'What the property gives each year if you keep it.',
    startName: 'Rent',
    startField: 'rentPerYear',
    cuts: Object.freeze([
      Object.freeze({ name: 'Loan repayments', field: 'loanRepaymentsPerYear' }),
      Object.freeze({ name: 'Running costs', field: 'runningCostsPerYear' }),
      Object.freeze({ name: 'Tax on the rental profit', field: 'taxOnRentalProfitPerYear' })
    ]),
    resultName: 'Net each year',
    comesOffName: 'Loan repayments, running costs and tax'
  }),
  sell: Object.freeze({
    id: 'sell',
    title: 'Sell',
    description: 'What you would have in hand if you sold it.',
    startName: 'Sale price',
    startField: 'salePrice',
    cuts: Object.freeze([
      Object.freeze({ name: 'Selling costs', field: 'sellingCosts' }),
      Object.freeze({ name: 'Loan repaid', field: 'loanBalance' }),
      Object.freeze({ name: 'Tax on the gain', field: 'taxOnGain' })
    ]),
    resultName: 'In hand',
    comesOffName: 'Selling costs, the loan and tax'
  })
});

const CLOSING_TOLERANCE_EUR = 0.01;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function has(raw, key) {
  return Object.prototype.hasOwnProperty.call(raw, key) && typeof raw[key] !== 'undefined';
}

/** "€18,000". Whole euros: every amount in this module is shown as stated. */
export function euroText(amount) {
  return `€${Math.round(amount).toLocaleString('en-IE')}`;
}

/**
 * Validate a payload and return it in canonical form.
 *
 * Idempotent: normalising a normalised payload returns an equal one.
 */
export function normalizeRentalKeepOrSellInputs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${FIELD} must be an object.`);
  }

  Object.keys(raw).forEach((key) => {
    if (!INPUT_FIELDS.includes(key) && typeof raw[key] !== 'undefined') {
      throw new Error(`${FIELD}.${key} is not an input of this module.`);
    }
  });

  POSITIVE_FIELDS.forEach((key) => {
    if (!isFiniteNumber(raw[key]) || raw[key] <= 0) {
      throw new Error(`${FIELD}.${key} must be a number greater than 0.`);
    }
  });
  NON_NEGATIVE_FIELDS.forEach((key) => {
    if (!isFiniteNumber(raw[key]) || raw[key] < 0) {
      throw new Error(`${FIELD}.${key} must be a number greater than or equal to 0.`);
    }
  });

  let baseScenarioId = 'keep';
  if (has(raw, 'baseScenarioId')) {
    if (!CASE_IDS.includes(raw.baseScenarioId)) {
      throw new Error(`${FIELD}.baseScenarioId must be "keep" or "sell".`);
    }
    baseScenarioId = raw.baseScenarioId;
  }

  return {
    rentPerYear: raw.rentPerYear,
    loanRepaymentsPerYear: raw.loanRepaymentsPerYear,
    runningCostsPerYear: raw.runningCostsPerYear,
    taxOnRentalProfitPerYear: raw.taxOnRentalProfitPerYear,
    salePrice: raw.salePrice,
    sellingCosts: raw.sellingCosts,
    loanBalance: raw.loanBalance,
    taxOnGain: raw.taxOnGain,
    baseScenarioId
  };
}

/** `[{ id, title, description }]`, for the presenter and the case buttons. */
export function getRentalKeepOrSellCases(rawInputs) {
  normalizeRentalKeepOrSellInputs(rawInputs);
  return CASE_IDS.map((id) => ({
    id,
    title: CASE_SPECS[id].title,
    description: CASE_SPECS[id].description
  }));
}

export function getDefaultRentalKeepOrSellScenarioId(rawInputs) {
  return normalizeRentalKeepOrSellInputs(rawInputs).baseScenarioId;
}

function solveCase(inputs, spec) {
  const start = inputs[spec.startField];
  const rows = [{ key: 'start', name: spec.startName, amount: start, lo: 0, hi: start }];

  let run = start;
  let comesOff = 0;
  spec.cuts.forEach((cut, index) => {
    const amount = inputs[cut.field];
    rows.push({ key: `cut${index + 1}`, name: cut.name, amount, lo: run - amount, hi: run });
    run -= amount;
    comesOff += amount;
  });

  const result = start - comesOff;
  if (Math.abs(run - result) > CLOSING_TOLERANCE_EUR) {
    throw new Error(`${FIELD} (${spec.title}): the lines do not add up to the result.`);
  }
  rows.push({
    key: 'result',
    name: spec.resultName,
    amount: result,
    lo: Math.min(0, result),
    hi: Math.max(0, result)
  });

  // THE SHOWN ROWS, AND A RESULT DERIVED FROM THEM.
  const shownStart = Math.round(start);
  rows[0].shownAmount = shownStart;
  rows[0].shownLo = 0;
  rows[0].shownHi = shownStart;
  let shownRun = shownStart;
  let shownComesOff = 0;
  rows.slice(1, 4).forEach((row) => {
    const amount = Math.round(row.amount);
    row.shownAmount = amount;
    row.shownHi = shownRun;
    row.shownLo = shownRun - amount;
    shownRun -= amount;
    shownComesOff += amount;
  });
  // `+ 0` so that nothing is ever shown as minus zero.
  const shownResult = (shownStart - shownComesOff) + 0;
  const resultRow = rows[4];
  resultRow.shownAmount = shownResult;
  resultRow.shownLo = Math.min(0, shownResult);
  resultRow.shownHi = Math.max(0, shownResult);

  let resultTone = 'level';
  if (shownResult > 0) {
    resultTone = 'left_over';
  } else if (shownResult < 0) {
    resultTone = 'short';
  }

  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    startName: spec.startName,
    resultName: spec.resultName,
    rows,
    result,
    shownResult,
    resultTone,
    comesOff,
    shownComesOff,
    comesOffName: spec.comesOffName
  };
}

function buildAssumptionsTable(inputs) {
  return {
    columns: ['Assumption', 'Input Used'],
    rows: [
      ['Rent', `${euroText(inputs.rentPerYear)} a year`],
      ['Loan repayments', `${euroText(inputs.loanRepaymentsPerYear)} a year`],
      ['Running costs', `${euroText(inputs.runningCostsPerYear)} a year`],
      ['Tax on the rental profit', `${euroText(inputs.taxOnRentalProfitPerYear)} a year, as stated`],
      ['Sale price', euroText(inputs.salePrice)],
      ['Selling costs', euroText(inputs.sellingCosts)],
      ['Loan repaid on a sale', euroText(inputs.loanBalance)],
      ['Tax on the gain', `${euroText(inputs.taxOnGain)}, as stated`],
      ['Where the figures come from', 'Every figure is as stated for this property. Nothing here is estimated.'],
      ['Tax', 'The tax figures are as stated. Tax is not calculated here.'],
      ['Period', 'Yearly figures are for one year.'],
      ['Rounding', 'Amounts are shown to the nearest euro.']
    ]
  };
}

function buildOutputsTable(cases) {
  const byKey = (entry, key) => entry.rows.find((row) => row.key === key).shownAmount;
  return {
    columns: [
      'Case',
      'Rent or sale price (€)',
      'Loan (€)',
      'Running or selling costs (€)',
      'Tax (€)',
      'Net each year or in hand (€)'
    ],
    rows: cases.map((entry) => [
      entry.title,
      byKey(entry, 'start'),
      byKey(entry, 'cut1'),
      byKey(entry, 'cut2'),
      byKey(entry, 'cut3'),
      byKey(entry, 'result')
    ])
  };
}

/** Cuts are shown negative, so every table adds down to its last line. */
function signedAmount(row) {
  return row.key === 'start' || row.key === 'result' ? row.shownAmount : -row.shownAmount;
}

function buildTables(cases) {
  return cases.map((entry) => ({
    title: `${entry.title}: from the ${entry.startName.toLowerCase()} to what is left`,
    columns: ['Line', 'Amount (€)'],
    rows: entry.rows.map((row) => [row.name, signedAmount(row)])
  }));
}

function buildCharts(baseCase) {
  return [{
    title: baseCase.id === 'keep'
      ? 'What the property gives each year'
      : 'What you would have in hand',
    subtitle: `${baseCase.title}: from the ${baseCase.startName.toLowerCase()} to what is left.`,
    type: 'bar',
    labels: baseCase.rows.map((row) => row.name),
    datasets: [{
      label: 'Amount',
      data: baseCase.rows.map((row) => signedAmount(row))
    }],
    display: {
      variant: 'wide',
      valueFormat: 'currency',
      yAxisTitle: baseCase.id === 'keep' ? 'Euro a year' : 'Euro'
    }
  }];
}

/**
 * Put both cases in order.
 *
 * @param {object} rawInputs `generated.rentalKeepOrSellInputs`
 */
export function computeRentalKeepOrSellProjection(rawInputs) {
  const inputs = normalizeRentalKeepOrSellInputs(rawInputs);
  const cases = CASE_IDS.map((id) => solveCase(inputs, CASE_SPECS[id]));
  const baseCase = cases.find((entry) => entry.id === inputs.baseScenarioId) || cases[0];

  return {
    assumptionsTable: buildAssumptionsTable(inputs),
    outputsTable: buildOutputsTable(cases),
    tables: buildTables(cases),
    // One ordinary chart for the surfaces that have no module to draw for them.
    charts: buildCharts(baseCase),
    debug: {
      inputs,
      cases,
      baseScenarioId: baseCase.id
    }
  };
}
