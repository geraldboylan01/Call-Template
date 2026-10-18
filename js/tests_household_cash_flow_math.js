import {
  HOUSEHOLD_CASH_FLOW_INCOME_TYPES,
  computeHouseholdCashFlowProjection,
  getDefaultHouseholdCashFlowScenarioId,
  getHouseholdCashFlowCases,
  normalizeHouseholdCashFlowInputs
} from './household_cash_flow_math.js';
import { TAX_STATUSES, computeTaxYear } from './planning/tax/engine.js';
import {
  PENSION_EARNINGS_CAP,
  maxRelievableContributionRatePercent,
  maxRelievablePersonalContribution
} from './pension_math.js';

/**
 * The four sample cases, and the three fixtures every figure is proved against.
 *
 * The DESIGN fixture is what the design frames were drawn from: tax of 48,000,
 * then 44,000 once the pension is in. It is injected through `taxFor`, which a
 * payload cannot reach, and it is the only fixture with literal expected
 * figures. The ENGINE fixture reads the real tax engine, and the STATED fixture
 * is the same household with one person's take-home given. Neither carries a
 * tax figure here, because the tax rules move and the reference calculator in
 * `scripts/check-household-cash-flow.mjs` derives them at test time.
 */
export const HOUSEHOLD_CASH_FLOW_SAMPLE = Object.freeze({
  householdTaxStatus: 'married_or_civil_partners',
  people: Object.freeze([
    Object.freeze({ id: 'niamh', age: 45, label: 'Niamh' }),
    Object.freeze({ id: 'dara', age: 45, label: 'Dara' })
  ]),
  income: Object.freeze([
    Object.freeze({ personId: 'niamh', type: 'employment', amount: 75_000 }),
    Object.freeze({ personId: 'dara', type: 'employment', amount: 75_000 })
  ]),
  outgoings: Object.freeze([
    Object.freeze({ id: 'mortgage', label: 'Mortgage', amount: 30_000 }),
    Object.freeze({ id: 'car', label: 'Car loan', amount: 6_000 }),
    Object.freeze({ id: 'living', label: 'Living costs', amount: 48_000 }),
    Object.freeze({ id: 'children', label: 'Children', amount: 9_000 }),
    Object.freeze({ id: 'insurance', label: 'Insurance', amount: 3_000 })
  ]),
  scenarios: Object.freeze([
    Object.freeze({ id: 'today' }),
    Object.freeze({
      id: 'clear-car',
      changes: Object.freeze([
        Object.freeze({ type: 'clearOutgoing', outgoingId: 'car', paidFrom: 'savings' })
      ])
    }),
    Object.freeze({
      id: 'pension',
      changes: Object.freeze([Object.freeze({ type: 'extraPension', amount: 10_000 })])
    }),
    Object.freeze({
      id: 'both',
      changes: Object.freeze([
        Object.freeze({ type: 'clearOutgoing', outgoingId: 'car', paidFrom: 'savings' }),
        Object.freeze({ type: 'extraPension', amount: 10_000 })
      ])
    })
  ])
});

/**
 * The same household with living costs of 60,000, so TODAY is short. The short
 * frames were drawn from this one (with the tax engine, short by 2,800 today).
 */
export const HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE = Object.freeze({
  ...HOUSEHOLD_CASH_FLOW_SAMPLE,
  outgoings: Object.freeze(HOUSEHOLD_CASH_FLOW_SAMPLE.outgoings.map((line) => (
    line.id === 'living' ? Object.freeze({ ...line, amount: 60_000 }) : line
  )))
});

/**
 * The sample with 20,000 into the pension, so today leaves money over and ONE
 * case tips it below nothing: the other direction across the floor.
 */
export const HOUSEHOLD_CASH_FLOW_PENSION_SHORT_SAMPLE = Object.freeze({
  ...HOUSEHOLD_CASH_FLOW_SAMPLE,
  scenarios: Object.freeze(HOUSEHOLD_CASH_FLOW_SAMPLE.scenarios.map((entry) => (
    entry.id === 'pension'
      ? Object.freeze({ id: 'pension', changes: Object.freeze([Object.freeze({ type: 'extraPension', amount: 20_000 })]) })
      : entry
  )))
});

/** The tax the design frames assumed: 24,000 each, less 40% relief on what each pays in. */
export function designFixtureOptions() {
  return {
    calculationYear: 2026,
    taxFor: ({ contributions }) => {
      const paid = contributions.reduce((sum, entry) => sum + entry.amount, 0);
      const each = 24_000 - (paid * 0.4) / 2;
      return { niamh: each, dara: each };
    }
  };
}

export const HOUSEHOLD_CASH_FLOW_DESIGN_EXPECTED = Object.freeze({
  tax: Object.freeze([48_000, 48_000, 44_000, 44_000]),
  pensions: Object.freeze([0, 0, 10_000, 10_000]),
  car: Object.freeze([6_000, 0, 6_000, 0]),
  leftOver: Object.freeze([6_000, 12_000, 0, 6_000]),
  monthly: Object.freeze(['€500 a month', '€1,000 a month', '€0 a month', '€500 a month']),
  status: Object.freeze(['left_over', 'left_over', 'tight', 'left_over']),
  titles: Object.freeze([
    'Today',
    'Clear your car loan from savings',
    'Pay €10,000 more into your pensions',
    'Both'
  ]),
  sentences: Object.freeze([
    'Today, €144,000 of your €150,000 goes out and you have €6,000 left over.',
    'Clearing your car loan from savings stops €6,000 a year going out, so the amount you have left over doubles, from €6,000 to €12,000.',
    'Paying €10,000 more into your pensions lowers your tax by €4,000, so €6,000 more goes out each year and you have nothing left over.',
    'You have the same €6,000 left over as today, but your car loan is gone and €10,000 more goes into your pensions each year, with your tax €4,000 lower.'
  ])
});

/**
 * The short state under the same design tax, so every figure is a literal. The
 * sentences are the ones on the approved frames, with these figures.
 */
const HOUSEHOLD_CASH_FLOW_SHORT_EXPECTED = Object.freeze({
  leftOver: Object.freeze([-6_000, 0, -12_000, -6_000]),
  monthly: Object.freeze(['€500 a month', '€0 a month', '€1,000 a month', '€500 a month']),
  signedMonthly: Object.freeze([-500, 0, -1_000, -500]),
  status: Object.freeze(['short', 'tight', 'short', 'short']),
  sentences: Object.freeze([
    'Today, €156,000 goes out against your €150,000, and you are short by €6,000.',
    'Clearing your car loan from savings stops €6,000 a year going out, so you have nothing left over instead of being short by €6,000.',
    'Paying €10,000 more into your pensions lowers your tax by €4,000, so €6,000 more goes out each year and you are short by €12,000 instead of €6,000.',
    'You are short by the same €6,000 as today, but your car loan is gone and €10,000 more goes into your pensions each year, with your tax €4,000 lower.'
  ])
});

/* ----------------------------------------------------------------- helpers */

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertWithin(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message || 'Values differ'}: expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

function assertThrows(fn, expectedMessage, label) {
  try {
    fn();
  } catch (error) {
    if (error.message !== expectedMessage) {
      throw new Error(`${label}: expected "${expectedMessage}", got "${error.message}"`);
    }
    return;
  }
  throw new Error(`${label}: expected it to throw "${expectedMessage}"`);
}

function runCase(name, fn) {
  try {
    fn();
    console.info(`[HouseholdCashFlowTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[HouseholdCashFlowTests] FAIL: ${name}\n    ${error.message}`);
    return { name, pass: false, error: error.message };
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function payload(mutate) {
  const next = clone(HOUSEHOLD_CASH_FLOW_SAMPLE);
  if (mutate) {
    mutate(next);
  }
  return next;
}

const FIELD = 'generated.householdCashFlowInputs';

/** Every string under a value, so wording can be scanned in one place. */
function collectStrings(value, found = []) {
  if (typeof value === 'string') {
    found.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((entry) => collectStrings(entry, found));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => collectStrings(entry, found));
  }
  return found;
}

const BANNED_WORDING = /we recommend|you should|best option|\bbest\b|\bideal\b|\boptimal\b|p\.a\./i;
// Text this module writes may not say "they" or "their" at all. The shared
// engine's own disclosures say "They" of tax figures, so for those only the
// references to the household are scanned for.
const THIRD_PERSON_HOUSEHOLD = /\bthe household\b|\bthe couple\b|\bthe client\b|\bclients\b/i;
const THIRD_PERSON = new RegExp(`${THIRD_PERSON_HOUSEHOLD.source}|\\bthey\\b|\\btheir\\b`, 'i');
const PROVIDER_NAMES = /\b(AIB|Bank of Ireland|BOI|Revolut|Zurich|Irish Life|Aviva|Davy|Standard Life)\b/;
const UNSEPARATED_EURO = /€\d{4,}/;

function wordingProblem(text, { engineOwned = false } = {}) {
  if (BANNED_WORDING.test(text)) return 'banned phrase';
  if ((engineOwned ? THIRD_PERSON_HOUSEHOLD : THIRD_PERSON).test(text)) return 'third person';
  if (PROVIDER_NAMES.test(text)) return 'provider name';
  if (UNSEPARATED_EURO.test(text)) return 'amount without a thousands separator';
  return null;
}

const hundred = (amount) => Math.round(amount / 100) * 100;

/** Invariants that hold for every case of every fixture. */
function checkInvariants(projection, label) {
  const { summary, debug } = projection;
  summary.cases.forEach((entry, index) => {
    const where = `${label}: case ${index + 1} (${entry.title})`;
    assertWithin(
      entry.takeHome.byPerson.reduce((sum, person) => sum + person.takeHome, 0),
      entry.takeHome.total,
      0.005,
      `${where}: the people's take-home sums to the household's`
    );
    assertWithin(
      entry.takeHome.byPerson.reduce((sum, person) => sum + person.tax, 0),
      entry.outgoings.tax,
      0.005,
      `${where}: the people's tax sums to the household's`
    );
    assertWithin(
      entry.takeHome.total - entry.outgoings.pensionContributions - entry.outgoings.statedTotal,
      entry.leftOver.amount,
      0.005,
      `${where}: take-home less pensions and stated costs is left over`
    );
    assertWithin(
      entry.income.total - entry.outgoings.total,
      entry.leftOver.amount,
      0.005,
      `${where}: income less total outgoings is left over`
    );
    assertWithin(
      entry.outgoings.tax + entry.outgoings.pensionContributions + entry.outgoings.statedTotal,
      entry.outgoings.total,
      0.005,
      `${where}: total outgoings is tax, pensions and stated costs`
    );
    assertEqual(entry.pensionContributions.gross, entry.outgoings.pensionContributions, `${where}: gross is the outgoing`);
    assertWithin(
      entry.pensionContributions.gross - entry.pensionContributions.taxRelief,
      entry.pensionContributions.costAfterRelief,
      0.005,
      `${where}: cost after relief`
    );
    assert(entry.pensionContributions.taxRelief >= 0, `${where}: relief is never negative`);
    // The status follows the figure SHOWN, and the month carries its sign.
    const shownLeft = entry.leftOver.shown;
    assertEqual(
      entry.leftOver.status,
      shownLeft > 0 ? 'left_over' : (shownLeft === 0 ? 'tight' : 'short'),
      `${where}: status follows the amount shown`
    );
    assertWithin(
      entry.leftOver.monthly,
      Math.sign(shownLeft) * Math.round(Math.abs(shownLeft) / 12 / 10) * 10,
      0.005,
      `${where}: the month is to the nearest 10 and has the sign of the year`
    );

    const detail = debug.cases[index];
    const shownLines = detail.lines.reduce((sum, line) => sum + line.shownAmount, 0);
    assertEqual(detail.shownIncome - shownLines, detail.shownLeftOver, `${where}: shown income less shown lines`);
    assertEqual(entry.leftOver.shown, detail.shownLeftOver, `${where}: summary shows what the screen shows`);
    for (let i = 1; i < detail.levels.length; i += 1) {
      assert(detail.levels[i].level <= detail.levels[i - 1].level + 1e-9, `${where}: levels never rise`);
    }
    assertWithin(detail.levels[detail.levels.length - 1].level, detail.leftOver, 0.005, `${where}: last level is left over`);
  });
}

/* ------------------------------------------------------------------ suite */

export function runHouseholdCashFlowTests() {
  const cases = [];

  cases.push(runCase('Current pension saving uses bank take-home once and cases add only the extra', () => {
    const raw = {
      householdTaxStatus: 'single', calculationYear: 2026,
      people: [{ id: 'a', age: 40, personalPensionContribution: 5000, statedTakeHome: 50000 }],
      income: [{ personId: 'a', type: 'employment', amount: 75000 }],
      outgoings: [{ id: 'living', label: 'Living costs', amount: 20000 }],
      scenarios: [{ id: 'today' }, { id: 'extra', changes: [{ type: 'extraPension', amount: 10000 }] }]
    };
    const projection = computeHouseholdCashFlowProjection(raw, { taxFor: ({ contributions }) => ({ a: 22000 - 0.4 * contributions.reduce((n, entry) => n + entry.amount, 0) }) });
    checkInvariants(projection, 'current pensions');
    const [today, extra] = projection.summary.cases;
    assertEqual(today.outgoings.tax, 20000, 'gross less current pension and stated bank amount');
    assertEqual(today.pensionContributions.gross, 5000, "today's full contribution");
    assertEqual(today.leftOver.amount, 30000, 'stated bank amount less ordinary spending');
    assertEqual(today.takeHome.byPerson[0].bankTakeHome, 50000, 'bank amount explicit in debug');
    assertEqual(extra.outgoings.tax, 16000, 'case tax change from the pension-aware base');
    assertEqual(extra.pensionContributions.gross, 15000, 'today plus extra');
    assertEqual(extra.leftOver.amount, 24000, 'extra costs 6000 after relief');
    assert(projection.debug.cases[1].sentence.includes('€10,000 more') && !projection.debug.cases[1].sentence.includes('€15,000 more'), 'wording compares with today');
    const todayOnly = computeHouseholdCashFlowProjection({ ...raw, scenarios: [raw.scenarios[0]] });
    assert(todayOnly.debug.drawnLines.some((line) => line.id === 'pensions'), 'current contributions have a drawn row without an extra case');
    const normalized = normalizeHouseholdCashFlowInputs(raw);
    assertEqual(JSON.stringify(normalizeHouseholdCashFlowInputs(normalized)), JSON.stringify(normalized), 'normalises to itself');
  }));

  cases.push(runCase('Pension sentences use the actual extra and matching tax saving across rounding boundaries', () => {
    for (const [current, extra, extraText, taxText, costText] of [
      [3960, 1080, '€1,080', '€432', '€648'],
      [60, 40, '€40', '€16', '€24'],
      [40, 80, '€80', '€32', '€48'],
      [3960.35, 1080.55, '€1,080.55', '€432.22', '€648.33'],
      [60, 0.40, '€0.40', '€0.16', '€0.24']
    ]) {
      const raw = {
        householdTaxStatus: 'single', calculationYear: 2026,
        people: [{ id: 'a', age: 40, personalPensionContribution: current, statedTakeHome: 50000 }],
        income: [{ personId: 'a', type: 'employment', amount: 75000 }],
        outgoings: [{ id: 'car', label: 'Car loan', amount: 2000 }, { id: 'living', label: 'Living costs', amount: 20000 }],
        scenarios: [
          { id: 'today' },
          { id: 'extra', changes: [{ type: 'extraPension', amount: extra }] },
          { id: 'both', changes: [{ type: 'extraPension', amount: extra }, { type: 'clearOutgoing', outgoingId: 'car' }] }
        ]
      };
      const projection = computeHouseholdCashFlowProjection(raw, { taxFor: ({ contributions }) => ({ a: 22000 - 0.4 * contributions.reduce((n, entry) => n + entry.amount, 0) }) });
      checkInvariants(projection, 'actual pension change');
      const [, pension, both] = projection.debug.cases;
      assert(pension.sentence.includes(`Paying ${extraText} more`), `actual extra ${extra}`);
      assert(pension.title.includes(extraText), 'derived case title uses the same actual contribution');
      assert(pension.sentence.includes(`tax by ${taxText}`), 'actual tax saving');
      assert(pension.sentence.includes(`${costText} more goes out`), 'gross less tax saving adds up');
      assert(both.sentence.includes(`${extraText} more goes into`) && both.sentence.includes(`tax ${taxText} lower`), 'combined case uses the same precision');
      assert(projection.debug.footnote.includes('nearest €100') && projection.debug.footnote.includes('Pension changes'), 'precision explained');
      if (current === 3960) {
        assertEqual(projection.outputsTable.rows[0][2], 4000, 'today ledger stays rounded');
        assertEqual(projection.outputsTable.rows[1][2], 5000, 'case ledger stays rounded');
      }
    }
  }));

  cases.push(runCase('A pension line is drawn only when a case shows a nonzero rounded contribution', () => {
    const raw = payload((p) => {
      p.people[0].personalPensionContribution = 20;
      p.people[1].personalPensionContribution = 20;
      p.scenarios = [{ id: 'today' }];
    });
    const tiny = computeHouseholdCashFlowProjection(raw, { calculationYear: 2026 });
    assert(!tiny.debug.hasPensionColumn && !tiny.debug.drawnLines.some((line) => line.id === 'pensions'), '40 rounds to zero, no pension column');
    checkInvariants(tiny, 'hidden current pension');
    const stillHidden = computeHouseholdCashFlowProjection({ ...raw, scenarios: [...raw.scenarios, { id: 'tiny-extra', changes: [{ type: 'extraPension', amount: 4 }] }] }, { calculationYear: 2026 });
    assert(!stillHidden.debug.hasPensionColumn, '40 plus 4 stays hidden in all cases');
    checkInvariants(stillHidden, 'hidden current plus extra pension');
    raw.scenarios.push({ id: 'extra', changes: [{ type: 'extraPension', amount: 20 }] });
    const visible = computeHouseholdCashFlowProjection(raw, { calculationYear: 2026 });
    assert(visible.debug.hasPensionColumn, '60 rounds to 100 in another case, stable column');
    assertEqual(visible.summary.cases[0].pensionContributions.gross, 40, 'exact current saving is retained');
  }));

  cases.push(runCase('Existing and extra pension saving share the per-person relief limit', () => {
    const base = {
      householdTaxStatus: 'single', people: [{ id: 'a', age: 40, personalPensionContribution: 5000 }],
      income: [{ personId: 'a', type: 'employment', amount: 75000 }],
      outgoings: [{ id: 'living', label: 'Living costs', amount: 20000 }],
      scenarios: [{ id: 'today' }, { id: 'extra', changes: [{ type: 'extraPension', amount: 14000 }] }]
    };
    let refused = false;
    try { computeHouseholdCashFlowProjection(base); } catch (error) { refused = /relief|limit/i.test(error.message); }
    assert(refused, '5000 plus 14000 exceeds the limit');
    for (const amount of [-1, NaN, Infinity]) {
      let invalid = false;
      try { normalizeHouseholdCashFlowInputs({ ...base, people: [{ id: 'a', age: 40, personalPensionContribution: amount }] }); }
      catch (_error) { invalid = true; }
      assert(invalid, `bad current contribution ${amount} refused`);
    }
    let impossible = false;
    try { normalizeHouseholdCashFlowInputs({ ...base, people: [{ id: 'a', age: 40, personalPensionContribution: 5000, statedTakeHome: 72000 }] }); }
    catch (error) { impossible = /take.home|pension/i.test(error.message); }
    assert(impossible, 'bank pay plus pension cannot exceed gross');
  }));

  cases.push(runCase('Finite inputs whose calculated totals overflow are refused before rendering', () => {
    const fixtures = [
      ['income', (p) => { p.income.forEach((item) => { item.amount = 1e308; }); }],
      ['outgoings', (p) => { p.outgoings[0].amount = 1e308; p.outgoings[1].amount = 1e308; }],
      ['case total', (p) => { p.outgoings[0].amount = 1e308; }, {
        calculationYear: 2026, taxFor: () => ({ niamh: 6e307, dara: 6e307 })
      }]
    ];
    fixtures.forEach(([label, mutate, options]) => {
      let message = '';
      try {
        computeHouseholdCashFlowProjection(payload(mutate), options || designFixtureOptions());
      } catch (error) { message = error.message; }
      assert(message.startsWith(FIELD) && message.includes('too large to calculate'), `${label}: clear engine refusal (${message})`);
    });
  }));

  cases.push(runCase('Income must remain above zero on the figures shown', () => {
    [1, 49].forEach((amount) => {
      const raw = {
        people: [{ id: 'alex', age: 40 }],
        income: [{ personId: 'alex', type: 'employment', amount }],
        outgoings: [{ id: 'living', label: 'Living costs', amount: 100 }],
        scenarios: [{ id: 'today' }]
      };
      let message = '';
      try { computeHouseholdCashFlowProjection(raw); } catch (error) { message = error.message; }
      assertEqual(message, `${FIELD}.income: your income before tax rounds to €0 on this screen. Give a yearly total of at least €50.`, `income of €${amount}`);
    });
  }));

  cases.push(runCase('Design fixture reproduces the frames: tax, pensions, car loan, left over, month and status', () => {
    const projection = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, designFixtureOptions());
    const expected = HOUSEHOLD_CASH_FLOW_DESIGN_EXPECTED;
    projection.debug.cases.forEach((entry, index) => {
      const line = (id) => entry.lines.find((candidate) => candidate.id === id).shownAmount;
      assertEqual(line('tax'), expected.tax[index], `case ${index + 1} tax`);
      assertEqual(line('pensions'), expected.pensions[index], `case ${index + 1} pensions`);
      assertEqual(line('car'), expected.car[index], `case ${index + 1} car loan`);
      assertEqual(entry.shownLeftOver, expected.leftOver[index], `case ${index + 1} left over`);
      assertEqual(entry.monthly.text, expected.monthly[index], `case ${index + 1} month`);
      assertEqual(entry.status, expected.status[index], `case ${index + 1} status`);
    });
    checkInvariants(projection, 'design');
  }));

  cases.push(runCase('Design fixture titles and sentences are the golden strings', () => {
    const projection = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, designFixtureOptions());
    projection.debug.cases.forEach((entry, index) => {
      assertEqual(entry.title, HOUSEHOLD_CASH_FLOW_DESIGN_EXPECTED.titles[index], `case ${index + 1} title`);
      assertEqual(entry.sentence, HOUSEHOLD_CASH_FLOW_DESIGN_EXPECTED.sentences[index], `case ${index + 1} sentence`);
    });
  }));

  cases.push(runCase('Design fixture: the case that leaves nothing shows "Tight", and the others show "Left over"', () => {
    const projection = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, designFixtureOptions());
    assertEqual(projection.summary.cases[2].leftOver.status, 'tight', 'case 3 is tight');
    assertEqual(projection.summary.cases[2].leftOver.amount, 0, 'case 3 leaves exactly nothing');
  }));

  cases.push(runCase('A case that leaves less than nothing is drawn, not refused: figures, signs, status and the frames\' sentences', () => {
    const projection = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SHORT_SAMPLE, designFixtureOptions());
    const expected = HOUSEHOLD_CASH_FLOW_SHORT_EXPECTED;
    projection.debug.cases.forEach((entry, index) => {
      assertEqual(entry.shownLeftOver, expected.leftOver[index], `case ${index + 1} left over`);
      assertEqual(entry.status, expected.status[index], `case ${index + 1} status`);
      assertEqual(entry.monthly.text, expected.monthly[index], `case ${index + 1} month, as the screen says it`);
      assertEqual(entry.monthly.amount, expected.signedMonthly[index], `case ${index + 1} month, signed`);
      assertEqual(entry.sentence, expected.sentences[index], `case ${index + 1} sentence`);
      const summary = projection.summary.cases[index].leftOver;
      assertEqual(summary.status, expected.status[index], `case ${index + 1} summary status`);
      assertEqual(summary.monthly, expected.signedMonthly[index], `case ${index + 1} summary month is signed`);
      assertEqual(summary.shown, expected.leftOver[index], `case ${index + 1} summary shown`);
    });
    checkInvariants(projection, 'short design');
    // The ledger keeps its sign, and the last level is below the floor.
    const today = projection.debug.cases[0];
    assertEqual(today.levels[today.levels.length - 1].level, -6_000, 'the steps run past the floor');
    assertEqual(projection.outputsTable.rows[0][4], -6_000, 'the outputs table is a ledger: left over is negative');
    assertEqual(projection.outputsTable.rows[0][5], 'About −€500 a month'.replace('About ', ''), 'and so is its month');
    assertEqual(projection.tables[0].rows[projection.tables[0].rows.length - 1][1], -6_000, 'and the case table');
    // What the chart and the video say is the screen's word, with the size.
    const chart = projection.charts[0];
    assertEqual(chart.labels[chart.labels.length - 1], 'Short', 'the chart names it Short');
    assertEqual(chart.datasets[0].data[chart.datasets[0].data.length - 1], 6_000, 'and gives the size');
  }));

  cases.push(runCase('Short, in the other directions: a left over year tipped under, short made smaller, short made left over', () => {
    // Left over today, short in a case.
    const tipped = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_PENSION_SHORT_SAMPLE, designFixtureOptions());
    assertEqual(tipped.debug.cases[0].status, 'left_over', 'today leaves money over');
    assertEqual(tipped.debug.cases[2].shownLeftOver, -6_000, 'the 20,000 case is short');
    assertEqual(
      tipped.debug.cases[2].sentence,
      'Paying €20,000 more into your pensions lowers your tax by €8,000, so €12,000 more goes out each year and you are short by €6,000.',
      'left over to short has no "instead of"'
    );
    checkInvariants(tipped, 'tipped');
    const chart = tipped.charts[0];
    assertEqual(chart.labels[chart.labels.length - 1], 'Left over', 'the chart is for today, which is not short');

    // Short today, and a smaller short, and money left over.
    const living = (amount) => payload((p) => {
      p.outgoings.find((line) => line.id === 'living').amount = amount;
    });
    const smaller = computeHouseholdCashFlowProjection(living(62_000), designFixtureOptions());
    assertEqual(smaller.debug.cases[0].shownLeftOver, -8_000, 'today is short by 8,000');
    assertEqual(
      smaller.debug.cases[1].sentence,
      'Clearing your car loan from savings stops €6,000 a year going out, so you are short by €2,000 instead of €8,000.',
      'short by less than today'
    );
    const over = computeHouseholdCashFlowProjection(living(55_000), designFixtureOptions());
    assertEqual(over.debug.cases[0].shownLeftOver, -1_000, 'today is short by 1,000');
    assertEqual(
      over.debug.cases[1].sentence,
      'Clearing your car loan from savings stops €6,000 a year going out, so you have €5,000 left over instead of being short by €1,000.',
      'left over instead of short'
    );
    [tipped, smaller, over].forEach((projection, index) => checkInvariants(projection, `direction ${index + 1}`));
  }));

  cases.push(runCase('Short follows the amount shown, and a short month rounds as a left over month of the same size does', () => {
    const living = (amount) => payload((p) => {
      p.outgoings.find((line) => line.id === 'living').amount = amount;
    });
    const run = (amount) => computeHouseholdCashFlowProjection(living(amount), designFixtureOptions());
    // €40 short unrounded shows €0, which is Tight and not Short.
    const near = run(54_040).summary.cases[0];
    assertWithin(near.leftOver.amount, -40, 0.005, 'short by 40 unrounded');
    assertEqual(near.leftOver.shown, 0, 'and it shows nothing');
    assertEqual(near.leftOver.status, 'tight', 'so it is tight');
    assertEqual(near.leftOver.monthly, 0, 'with no month, and not a negative zero');
    assert(Object.is(near.leftOver.monthly, 0), 'the month is +0');
    // €60 short shows €100 short.
    const just = run(54_060).summary.cases[0];
    assertEqual(just.leftOver.shown, -100, 'short by 60 shows 100');
    assertEqual(just.leftOver.status, 'short', 'so it is short');
    assertEqual(just.leftOver.monthly, -10, 'and its month is signed');
    // 300 a year is 25 a month: the tie goes up, in both directions.
    const plus = run(53_700).debug.cases[0];
    const minus = run(54_300).debug.cases[0];
    assertEqual(plus.shownLeftOver, 300, 'left over by 300');
    assertEqual(minus.shownLeftOver, -300, 'short by 300');
    assertEqual(plus.monthly.amount, 30, 'a tie rounds up');
    assertEqual(minus.monthly.amount, -30, 'and a short tie rounds the same size, signed');
    assertEqual(plus.monthly.text, minus.monthly.text, 'and says the same words');
  }));

  cases.push(runCase('Case 4 is not case 1: the same left over, and exactly tax, pensions and the car loan changed', () => {
    const fixtures = [
      ['design', computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, designFixtureOptions())],
      ['engine', computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, { calculationYear: 2026 })]
    ];
    fixtures.forEach(([label, projection]) => {
      const [today, , , both] = projection.debug.cases;
      assertEqual(both.shownLeftOver, today.shownLeftOver, `${label}: left over is the same as today`);
      const changed = both.lines.filter((line) => line.deltaVsToday !== 0).map((line) => line.id).sort();
      assertEqual(JSON.stringify(changed), JSON.stringify(['car', 'pensions', 'tax']), `${label}: what changed`);
      assert(both.lines.find((line) => line.id === 'tax').deltaVsToday < 0, `${label}: tax is lower`);
    });
  }));

  cases.push(runCase('Engine fixture: invariants hold, relief is the engine\'s saving, and today needs no case change', () => {
    const projection = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, { calculationYear: 2026 });
    checkInvariants(projection, 'engine');
    const baseItems = HOUSEHOLD_CASH_FLOW_SAMPLE.income.map((item) => ({ ...item }));
    const people = HOUSEHOLD_CASH_FLOW_SAMPLE.people.map((person) => ({ id: person.id, age: person.age }));
    const input = { year: 2026, status: 'married_or_civil_partners', people, items: baseItems };
    const without = computeTaxYear({ input }).result.totals.recurringTax;
    const withPension = computeTaxYear({
      input: { ...input, items: [...baseItems, { personId: 'joint', type: 'employmentPensionContribution', amount: 10_000 }] }
    }).result.totals.recurringTax;
    const pensionCase = projection.summary.cases[2];
    assertWithin(pensionCase.outgoings.tax, withPension, 0.005, 'case tax is the engine\'s');
    assertWithin(pensionCase.pensionContributions.taxRelief, without - withPension, 0.005, 'relief is the engine\'s saving');
    assertWithin(projection.summary.cases[0].outgoings.tax, without, 0.005, 'today\'s tax is the engine\'s');
  }));

  cases.push(runCase('A stated take-home sets the level and the engine supplies only the change', () => {
    const stated = payload((p) => {
      p.people[0].statedTakeHome = 50_000;
    });
    const projection = computeHouseholdCashFlowProjection(stated, { calculationYear: 2026 });
    const estimated = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, { calculationYear: 2026 });
    checkInvariants(projection, 'stated');

    const niamh = (summaryCase) => summaryCase.takeHome.byPerson.find((person) => person.personId === 'niamh');
    const dara = (summaryCase) => summaryCase.takeHome.byPerson.find((person) => person.personId === 'dara');
    assertWithin(niamh(projection.summary.cases[0]).tax, 75_000 - 50_000, 0.005, 'base tax is gross less stated take-home');
    assertEqual(niamh(projection.summary.cases[0]).taxSource, 'stated', 'source is stated');
    assertEqual(dara(projection.summary.cases[0]).taxSource, 'estimated', 'the other person is estimated');
    // Dara is untouched by Niamh's payslip.
    assertWithin(dara(projection.summary.cases[0]).tax, dara(estimated.summary.cases[0]).tax, 0.005, 'Dara\'s tax');

    projection.summary.cases.forEach((entry, index) => {
      const change = niamh(entry).tax - niamh(projection.summary.cases[0]).tax;
      const engineChange = niamh(estimated.summary.cases[index]).tax - niamh(estimated.summary.cases[0]).tax;
      assertWithin(change, engineChange, 0.005, `case ${index + 1}: the change is the engine's`);
    });

    const lines = projection.debug.taxSourceLines;
    assert(lines[0].source === 'stated' && /take-home pay you gave, €50,000 a year/.test(lines[0].text), 'stated line');
    assert(lines[1].source === 'estimated', 'estimated line');
    assert(/for Niamh and an estimate for Dara/.test(projection.debug.footnote), 'the footnote says which was used');
  }));

  cases.push(runCase('Tax is never below nothing: a take-home close to gross pay cannot be relieved into a negative', () => {
    // Codex's example: 75,000 gross, 74,999 stated, 10,000 more into a pension.
    // Relief of 4,000 against 1 of tax used to give tax of -3,999 and a
    // take-home of 78,999, which is more than was earned.
    const near = payload((p) => {
      p.people[0].statedTakeHome = 74_999;
      p.scenarios = [
        { id: 'today' },
        { id: 'pension', changes: [{ type: 'extraPension', amount: 10_000, personId: 'niamh' }] }
      ];
    });
    const projection = computeHouseholdCashFlowProjection(near, { calculationYear: 2026 });
    checkInvariants(projection, 'near gross');
    const niamh = (entry) => entry.takeHome.byPerson.find((person) => person.personId === 'niamh');
    const [today, pension] = projection.summary.cases;

    assertWithin(niamh(today).tax, 1, 0.005, 'today: the 1 of tax the payslip leaves');
    assertEqual(niamh(pension).tax, 0, 'with the pension: held at nothing, not -3,999');
    assertEqual(niamh(pension).takeHome, 75_000, 'and take-home is gross pay, not more than was earned');
    assert(pension.takeHome.byPerson.every((person) => person.tax >= 0 && person.takeHome <= person.gross), 'nobody is taxed below nothing');

    // The relief is what was there to relieve, so the cost after relief adds up.
    assertWithin(pension.pensionContributions.taxRelief, 1, 0.005, 'relief is the 1 of tax that was paid');
    assertWithin(pension.pensionContributions.costAfterRelief, 9_999, 0.005, 'cost after relief');
    assertWithin(
      today.leftOver.amount - pension.leftOver.amount,
      pension.pensionContributions.costAfterRelief,
      0.005,
      'the fall in left over is the cost after relief'
    );

    // And the screen's maker is told, in debug and not on the client's screen.
    const held = projection.debug.warnings.filter((text) => /held at €0/.test(text));
    assertEqual(held.length, 1, 'one warning');
    assert(/scenarios\[1\] \(Pay €10,000 more into your pensions\)/.test(held[0]), 'it names the case');
    assert(/Niamh would have been −€3,999/.test(held[0]), 'and the person and the figure');
  }));

  cases.push(runCase('The floor changes nothing in an ordinary case, and says nothing', () => {
    [HOUSEHOLD_CASH_FLOW_SAMPLE, payload((p) => {
      p.people[0].statedTakeHome = 50_000;
    })].forEach((raw, index) => {
      const projection = computeHouseholdCashFlowProjection(raw, { calculationYear: 2026 });
      assertEqual(projection.debug.warnings.filter((text) => /held at €0/.test(text)).length, 0, `shape ${index + 1}: no warning`);
      projection.debug.cases.forEach((entry) => {
        assert(entry.taxBreakdown.byPerson.every((person) => person.estimatedTax >= 0), 'no negative estimate');
      });
    });
  }));

  cases.push(runCase('A stated figure far from the estimate warns and is never refused', () => {
    // Well above the estimate, so no case is pushed below nothing.
    const stated = payload((p) => {
      p.people[0].statedTakeHome = 62_000;
    });
    const projection = computeHouseholdCashFlowProjection(stated, { calculationYear: 2026 });
    assertEqual(projection.debug.warnings.length, 1, 'one warning');
    assert(/more than 15%/.test(projection.debug.warnings[0]), 'the warning names the threshold');
  }));

  cases.push(runCase('A couple\'s tax is allocated by income share, marked allocated, and always sums to the household', () => {
    [[75_000, 75_000], [100_000, 50_000], [120_000, 30_000]].forEach(([niamhIncome, daraIncome]) => {
      // Lower living costs, so a low earner's smaller relief never leaves a case short.
      const split = payload((p) => {
        p.income[0].amount = niamhIncome;
        p.income[1].amount = daraIncome;
        p.outgoings[2].amount = 40_000;
      });
      const projection = computeHouseholdCashFlowProjection(split, { calculationYear: 2026 });
      checkInvariants(projection, `split ${niamhIncome}/${daraIncome}`);
      projection.summary.cases[0].takeHome.byPerson.forEach((person) => {
        assertEqual(person.basis, 'allocated', 'a jointly assessed person is allocated');
      });
      // A contribution by one person moves only that person's tax.
      const only = payload((p) => {
        p.income[0].amount = niamhIncome;
        p.income[1].amount = daraIncome;
        p.scenarios = [{ id: 'today' }, { id: 'pension', changes: [{ type: 'extraPension', amount: 8_000, personId: 'niamh' }] }];
      });
      const result = computeHouseholdCashFlowProjection(only, { calculationYear: 2026 });
      const [today, changed] = result.summary.cases;
      const dara = (entry) => entry.takeHome.byPerson.find((person) => person.personId === 'dara').tax;
      const niamh = (entry) => entry.takeHome.byPerson.find((person) => person.personId === 'niamh').tax;
      assertWithin(dara(changed), dara(today), 0.005, 'Dara pays the same tax');
      assert(niamh(changed) < niamh(today), 'Niamh pays less tax');
    });
  }));

  cases.push(runCase('Two people assessed separately each keep their own tax, marked own', () => {
    const separate = payload((p) => {
      p.householdTaxStatus = 'single';
      p.income[0].amount = 100_000;
      p.income[1].amount = 50_000;
    });
    const projection = computeHouseholdCashFlowProjection(separate, { calculationYear: 2026 });
    checkInvariants(projection, 'separate');
    projection.summary.cases[0].takeHome.byPerson.forEach((person) => {
      assertEqual(person.basis, 'own', 'assessed alone');
    });
    const own = (id, amount) => computeTaxYear({
      input: {
        year: 2026,
        status: 'single',
        people: [{ id, age: 45 }],
        items: [{ personId: id, type: 'employment', amount }]
      }
    }).result.totals.recurringTax;
    const [niamh, dara] = projection.summary.cases[0].takeHome.byPerson;
    assertWithin(niamh.tax, own('niamh', 100_000), 0.005, 'Niamh\'s own tax');
    assertWithin(dara.tax, own('dara', 50_000), 0.005, 'Dara\'s own tax');
  }));

  cases.push(runCase('A one-person household maps "joint" to the person, for income and for the extra pension', () => {
    const single = {
      householdTaxStatus: 'single',
      people: [{ id: 'alex', age: 40 }],
      income: [{ personId: 'joint', type: 'employment', amount: 80_000 }],
      outgoings: [{ id: 'rent', label: 'Rent', amount: 20_000 }],
      scenarios: [{ id: 'today' }, { id: 'pension', changes: [{ type: 'extraPension', amount: 5_000 }] }]
    };
    const normalized = normalizeHouseholdCashFlowInputs(single);
    assertEqual(normalized.income[0].personId, 'alex', 'joint income is the person\'s');
    assertEqual(normalized.income[0].mappedFromJoint, true, 'and says it was mapped');
    assertEqual(normalized.scenarios[1].changes[0].personId, 'alex', 'the extra pension defaults to the person');
    const projection = computeHouseholdCashFlowProjection(single, { calculationYear: 2026 });
    checkInvariants(projection, 'one person');
    assert(projection.summary.cases[1].pensionContributions.taxRelief > 0, 'relief is found');
    assert(!/for /.test(projection.debug.taxSourceLines[0].text), 'a single person is not named in the tax-source line');
  }));

  cases.push(runCase('A pension above the relievable maximum is refused, naming the person and the limit', () => {
    const rate = maxRelievableContributionRatePercent(45);
    const limit = maxRelievablePersonalContribution(45, 75_000);
    const euro = (amount) => `€${amount.toLocaleString('en-IE')}`;
    const one = payload((p) => {
      p.scenarios[2] = { id: 'pension', changes: [{ type: 'extraPension', amount: 50_000, personId: 'niamh' }] };
    });
    assertThrows(
      () => normalizeHouseholdCashFlowInputs(one),
      `${FIELD}.scenarios[2] (Pay €50,000 more into your pensions): Niamh would pay €50,000 a year into a pension, `
        + `which is more than the ${euro(limit)} a year that gets tax relief at age 45 `
        + `(${rate}% of earnings up to ${euro(PENSION_EARNINGS_CAP)}).`,
      'one person over the limit'
    );
    const joint = payload((p) => {
      p.scenarios[2] = { id: 'pension', changes: [{ type: 'extraPension', amount: 40_000 }] };
    });
    assertThrows(
      () => normalizeHouseholdCashFlowInputs(joint),
      `${FIELD}.scenarios[2] (Pay €40,000 more into your pensions): Niamh would pay €20,000 a year into a pension, `
        + `which is more than the ${euro(limit)} a year that gets tax relief at age 45 `
        + `(${rate}% of earnings up to ${euro(PENSION_EARNINGS_CAP)}).`,
      'a joint contribution is split before the limit is applied'
    );
    // Exactly at the limit is allowed.
    const atLimit = payload((p) => {
      p.scenarios[2] = { id: 'pension', changes: [{ type: 'extraPension', amount: limit, personId: 'niamh' }] };
    });
    normalizeHouseholdCashFlowInputs(atLimit);
  }));

  cases.push(runCase('Rejections carry the exact messages', () => {
    const check = (mutate, expected, label) => assertThrows(
      () => computeHouseholdCashFlowProjection(payload(mutate), designFixtureOptions()),
      expected,
      label
    );

    check((p) => {
      p.outgoings.push({ id: 'tax', label: 'Tax', amount: 48_000 });
    }, `${FIELD}.outgoings[5] (Tax): tax is calculated from income by the Irish tax engine and cannot be stated as a cost. `
      + "Give a person's take-home in people[].statedTakeHome instead.", 'a stated tax line');

    check((p) => {
      p.leftOver = 6_000;
    }, `${FIELD}.leftOver is not accepted. It is calculated.`, 'a typed left over');

    check((p) => {
      p.scenarios.push({ id: 'fifth' });
    }, `${FIELD}.scenarios supports at most 4 cases; received 5.`, 'a fifth case');

    check((p) => {
      p.outgoings.push({ id: 'a', label: 'A', amount: 1 }, { id: 'b', label: 'B', amount: 1 });
    }, `${FIELD}.outgoings supports at most 6 lines; received 7.`, 'a seventh line');

    check((p) => {
      p.scenarios[1].id = 'today';
    }, `${FIELD}.scenarios[1].id must be unique.`, 'a duplicate case id');

    check((p) => {
      p.outgoings[1].id = 'mortgage';
    }, `${FIELD}.outgoings[1].id must be unique.`, 'a duplicate outgoing id');

    check((p) => {
      p.scenarios[1] = { id: 'boat', changes: [{ type: 'clearOutgoing', outgoingId: 'boat' }] };
    }, `${FIELD}.scenarios[1] (Clear your boat): outgoingId "boat" is not one of the outgoings.`, 'an unknown outgoing');

    check((p) => {
      p.scenarios[3] = {
        id: 'both',
        changes: [{ type: 'extraPension', amount: 1_000 }, { type: 'extraPension', amount: 2_000 }]
      };
    }, `${FIELD}.scenarios[3] (Both): a case can have only one extraPension.`, 'two pension changes');

    check((p) => {
      p.scenarios[1] = {
        id: 'twice',
        changes: [{ type: 'clearOutgoing', outgoingId: 'car' }, { type: 'clearOutgoing', outgoingId: 'car' }]
      };
    }, `${FIELD}.scenarios[1] (Both): "car" is cleared twice.`, 'a line cleared twice');

    check((p) => {
      p.baseScenarioId = 'pension';
    }, `${FIELD}.scenarios[2] (Pay €10,000 more into your pensions): the base case is today and cannot carry changes.`,
    'a base case with changes');

    check((p) => {
      p.baseScenarioId = 'nope';
    }, `${FIELD}.baseScenarioId must match a case id.`, 'an unknown base');

    check((p) => {
      delete p.people[1].label;
    }, `${FIELD}.people[1] needs a label when there are two people.`, 'a missing label for two people');

    check((p) => {
      p.people[0].statedTakeHome = 80_000;
    }, `${FIELD}.people[0] (Niamh): statedTakeHome (€80,000) must be less than income before tax (€75,000).`,
    'a stated take-home at or above income');

    check((p) => {
      p.income = [{ personId: 'niamh', type: 'employment', amount: 150_000 }];
      p.people[1].statedTakeHome = 40_000;
    }, `${FIELD}.people[1] (Dara): statedTakeHome needs income before tax for this person.`,
    'a stated take-home for a person with no income');

    check((p) => {
      p.householdTaxStatus = 'married';
    }, `${FIELD}.householdTaxStatus must be one of: ${TAX_STATUSES.join(', ')}.`, 'a bad tax status');

    check((p) => {
      p.householdTaxStatus = 'widowed_or_surviving_civil_partner';
    }, `${FIELD}.householdTaxStatus widowed_or_surviving_civil_partner describes one person, but the payload has 2 people.`,
    'widowed with two people');

    check((p) => {
      p.income.push({ personId: 'niamh', type: 'employmentPensionContribution', amount: 5_000 });
    }, `${FIELD}.income[2]: pension contributions are not income. Use people[].personalPensionContribution for today's gross contribution, or extraPension for an increase.`,
    'today\'s pension contribution in income');
  }));

  cases.push(runCase('Text a payload supplies is held to the module\'s wording at the door, in every place it can be', () => {
    const refused = (mutate) => {
      try {
        normalizeHouseholdCashFlowInputs(payload(mutate));
      } catch (error) {
        return error.message;
      }
      return '';
    };
    const places = [
      ['a person\'s label', (p, text) => { p.people[0].label = text; }, /people\[0\] \(niamh\)\.label/],
      ['an outgoing\'s label', (p, text) => { p.outgoings[0].label = text; }, /outgoings\[0\] \(mortgage\)\.label/],
      ['a case\'s title', (p, text) => { p.scenarios[1].title = text; }, /scenarios\[1\] \(clear-car\)\.title/],
      ['a case\'s description', (p, text) => { p.scenarios[1].description = text; }, /scenarios\[1\] \(clear-car\)\.description/]
    ];
    const bad = [
      'The best option for you',
      'We recommend this',
      'Their mortgage',
      'The household\'s car loan',
      'Paid to AIB',
      'Paid to Standard Life',
      'Paid to Permanent TSB',
      'Paid to ptsb',
      'Permanent  TSB',
      'Bank  of Ireland',
      'irish\tLife',
      'STANDARD   LIFE',
      'Paid to standard life',
      'Paid to aib',
      'Paid to IRISH LIFE',
      'Savings of €12000'
    ];
    places.forEach(([name, set, where]) => {
      bad.forEach((text) => {
        const message = refused((p) => set(p, text));
        assert(where.test(message), `${name}, "${text}": refused where it was said (${message})`);
        assert(message.includes(`("${text}")`), `${name}, "${text}": and quotes it`);
      });
      assertEqual(refused((p) => set(p, 'Your holiday fund')), '', `${name}: plain words go through`);
    });
    // The fixtures' own words are plain, and a label that merely contains a banned
    // word's letters is not refused.
    assertEqual(refused(() => {}), '', 'the sample is accepted');
    assertEqual(refused((p) => { p.outgoings[0].label = 'Bestway rent'; }), '', 'a word is matched whole');
  }));

  cases.push(runCase('Every income type this module allows is one the tax engine accepts', () => {
    HOUSEHOLD_CASH_FLOW_INCOME_TYPES.forEach((type) => {
      const age = type === 'statePension' ? 70 : 45;
      const item = { personId: 'a', type, amount: 20_000 };
      computeTaxYear({
        input: {
          year: 2026,
          status: 'single',
          people: [{ id: 'a', age, receivingStatePensionContributory: type === 'statePension' }],
          items: [item]
        }
      });
    });
    assert(!HOUSEHOLD_CASH_FLOW_INCOME_TYPES.includes('employmentPensionContribution'), 'not an income type here');
  }));

  cases.push(runCase('Normalising is idempotent and the presenter hooks read the same cases', () => {
    // Every shape: a couple with a status, one with no status given, a stated
    // take-home, and one person whose "joint" income was mapped.
    const shapes = [
      HOUSEHOLD_CASH_FLOW_SAMPLE,
      payload((p) => {
        delete p.householdTaxStatus;
      }),
      payload((p) => {
        p.people[0].statedTakeHome = 50_000;
      }),
      {
        householdTaxStatus: 'single',
        people: [{ id: 'alex', age: 40 }],
        income: [{ personId: 'joint', type: 'employment', amount: 80_000 }],
        outgoings: [{ id: 'rent', label: 'Rent', amount: 20_000 }],
        scenarios: [{ id: 'today' }, { id: 'pension', changes: [{ type: 'extraPension', amount: 5_000 }] }]
      }
    ];
    shapes.forEach((shape, index) => {
      const first = normalizeHouseholdCashFlowInputs(shape);
      const second = normalizeHouseholdCashFlowInputs(first);
      assertEqual(JSON.stringify(second), JSON.stringify(first), `shape ${index + 1} normalises to itself`);
    });
    const once = normalizeHouseholdCashFlowInputs(HOUSEHOLD_CASH_FLOW_SAMPLE);
    assertEqual(getDefaultHouseholdCashFlowScenarioId(HOUSEHOLD_CASH_FLOW_SAMPLE), 'today', 'default case');
    const list = getHouseholdCashFlowCases(HOUSEHOLD_CASH_FLOW_SAMPLE);
    assertEqual(list.length, 4, 'four cases');
    assertEqual(list[1].title, 'Clear your car loan from savings', 'a derived title');
  }));

  cases.push(runCase('A payload cannot reach the tax seam or state its own tax', () => {
    const sneaky = payload((p) => {
      p.taxFor = () => ({ niamh: 0, dara: 0 });
    });
    const withSeam = computeHouseholdCashFlowProjection(sneaky, { calculationYear: 2026 });
    const without = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, { calculationYear: 2026 });
    assertEqual(withSeam.summary.cases[0].outgoings.tax, without.summary.cases[0].outgoings.tax, 'tax is unchanged');
    assertThrows(
      () => normalizeHouseholdCashFlowInputs(payload((p) => {
        p.totalTax = 40_000;
      })),
      `${FIELD}.totalTax is not accepted. Tax is calculated by the Irish tax engine. `
        + "Give a person's take-home in people[].statedTakeHome instead.",
      'a stated total tax'
    );
  }));

  cases.push(runCase('The injection seam validates what it is given', () => {
    assertThrows(
      () => computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, { calculationYear: 2026, taxFor: () => ({ niamh: 1 }) }),
      'taxFor must return a tax of 0 or more for "dara".',
      'a missing person'
    );
  }));

  cases.push(runCase('Rounding: shown left over is shown income less shown lines, and the month is to the nearest €10', () => {
    const projection = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, { calculationYear: 2026 });
    projection.debug.cases.forEach((entry, index) => {
      assertEqual(entry.shownLeftOver % 100, 0, `case ${index + 1} left over is a multiple of 100`);
      assertEqual(entry.monthly.amount % 10, 0, `case ${index + 1} month is a multiple of 10`);
      assertEqual(
        entry.monthly.exact,
        Math.abs(entry.shownLeftOver / 12 - entry.monthly.amount) < 0.005,
        `case ${index + 1} says whether the month is exact`
      );
      assertEqual(
        entry.monthly.text.startsWith('About '),
        !entry.monthly.exact,
        `case ${index + 1} prefixes "About" unless exact`
      );
    });
    // 6,600 a year is exactly 550 a month; 9,200 is not exact.
    assertEqual(hundred(9_183), 9_200, 'rounds to the nearest hundred');
  }));

  cases.push(runCase('Engine text and tables hold no banned wording, third person, provider name or bare thousands', () => {
    [
      ['design', computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, designFixtureOptions())],
      ['engine', computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, { calculationYear: 2026 })],
      ['stated', computeHouseholdCashFlowProjection(payload((p) => {
        p.people[0].statedTakeHome = 50_000;
      }), { calculationYear: 2026 })]
    ].forEach(([label, projection]) => {
      // Rows after "Rounding" are the tax engine's own disclosures, rendered by
      // `renderTaxDisclosures`. Everything else is written here.
      const rows = projection.assumptionsTable.rows;
      const split = rows.findIndex((row) => row[0] === 'Rounding') + 1;
      assert(split > 0, `${label}: the assumptions table has a Rounding row`);
      const ours = collectStrings({
        assumptionsTable: { rows: rows.slice(0, split) },
        outputsTable: projection.outputsTable,
        tables: projection.tables,
        charts: projection.charts,
        sentences: projection.debug.cases.map((entry) => [entry.title, entry.sentence]),
        footnote: projection.debug.footnote,
        taxSourceLines: projection.debug.taxSourceLines.map((line) => line.text)
      });
      ours.forEach((entry) => {
        const problem = wordingProblem(entry);
        assert(!problem, `${label}: ${problem} in "${entry}"`);
      });
      collectStrings(rows.slice(split)).forEach((entry) => {
        const problem = wordingProblem(entry, { engineOwned: true });
        assert(!problem, `${label}: ${problem} in the engine's own text "${entry}"`);
      });
    });
  }));

  cases.push(runCase('The assumptions table says what was used and what each figure means', () => {
    const projection = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, { calculationYear: 2026 });
    const rows = projection.assumptionsTable.rows;
    const find = (label) => rows.filter((row) => row[0] === label).map((row) => row[1]).join(' | ');
    assert(/estimate of income tax, USC and PRSI/.test(find('Where your tax comes from')), 'which tax');
    assert(/shown in full/i.test(find('Pension contributions')) && /lower tax/.test(find('Pension contributions')), 'pensions in full (D7)');
    assert(/allocation, not a payslip figure/.test(find('Income tax for a couple')), 'allocation is said (D6)');
    assert(/nearest €100/.test(find('Rounding')), 'rounding');
    assert(rows.some((row) => row[0] === 'Not included in tax estimates'), 'what the estimate leaves out');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };

  if (failed > 0) {
    console.warn('[HouseholdCashFlowTests] Completed with failures', summary);
  } else {
    console.info('[HouseholdCashFlowTests] All tests passed', { total: summary.total, passed: summary.passed });
  }

  return summary;
}
