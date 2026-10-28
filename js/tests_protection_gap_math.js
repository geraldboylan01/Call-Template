import {
  PROTECTION_GAP_HORIZON_MONTHS,
  computeProtectionGapProjection,
  getDefaultProtectionGapScenarioId,
  getProtectionGapCases,
  normalizeProtectionGapInputs,
  protectionGapSummaryHtml
} from './protection_gap_math.js';

/**
 * The sample household and the figures every one of its cases must show.
 *
 * Stated, whole euros. Niamh and Dara take home 57,000 and 45,000, need 96,000
 * a year and have 60,000 in savings. This is the design fixture the frames were
 * drawn from, and the first thing the engine is proved against.
 */
export const PROTECTION_GAP_SAMPLE = Object.freeze({
  householdLabel: 'Niamh and Dara, both 45',
  people: Object.freeze([
    Object.freeze({ id: 'niamh', label: 'Niamh', takeHome: 57_000 }),
    Object.freeze({ id: 'dara', label: 'Dara', takeHome: 45_000 })
  ]),
  needed: 96_000,
  savings: 60_000,
  scenarios: Object.freeze([
    Object.freeze({ id: 'today' }),
    Object.freeze({
      id: 'niamh-cannot-work',
      event: Object.freeze({ type: 'cannotWork', personId: 'niamh', statePayment: 13_000 })
    }),
    Object.freeze({
      id: 'dara-cannot-work',
      event: Object.freeze({ type: 'cannotWork', personId: 'dara', statePayment: 13_000 })
    }),
    Object.freeze({
      id: 'niamh-died',
      event: Object.freeze({
        type: 'dies',
        personId: 'niamh',
        survivorsPension: 13_500,
        neededAfter: 60_000,
        neededBecause: Object.freeze(['mortgageCleared', 'livingCostsLower'])
      })
    })
  ])
});

/** One row per case, in order. `segments` is [floor, Niamh, Dara]. */
export const PROTECTION_GAP_EXPECTED = Object.freeze({
  ids: ['today', 'niamh-cannot-work', 'dara-cannot-work', 'niamh-died'],
  titles: ['Today', 'Niamh cannot work', 'Dara cannot work', 'If Niamh died'],
  segments: [[0, 57_000, 45_000], [13_000, 0, 45_000], [13_000, 57_000, 0], [13_500, 0, 45_000]],
  floorLabels: ['State payment', 'State payment', 'State payment', 'Survivor’s pension'],
  moneyIn: [102_000, 58_000, 70_000, 58_500],
  needed: [96_000, 96_000, 96_000, 60_000],
  gap: [0, 38_000, 26_000, 1_500],
  spare: [6_000, 0, 0, 0],
  months: [null, 19, 28, null],
  beyond: [false, false, false, true],
  status: ['left_over', 'short', 'short', 'short'],
  scaleMax: 110_000,
  headlines: [
    ['You have €6,000 a year left over.', 'There is nothing for your savings to fill.'],
    ['You are €38,000 a year short.', 'Your savings would last 19 months.'],
    ['You are €26,000 a year short.', 'Your savings would last 28 months.'],
    ['You are €1,500 a year short.', 'Your savings would last beyond three years.']
  ],
  sentences: [
    'Both of your take-home pays come in, and you need €96,000.',
    'Niamh’s take-home stops and a State payment starts. You still need €96,000.',
    'Dara’s take-home stops and a State payment starts. You still need €96,000.',
    'Niamh’s take-home stops and a survivor’s pension starts. You need €60,000, because your mortgage is cleared and your living costs drop.'
  ],
  footnote: 'Amounts are a year. Your savings are used only to fill the gap, with no interest or inflation. '
    + 'State payments are as given and depend on eligibility. '
    + 'When one income stops, the other person’s tax can change, so your take-home may differ from what is shown.'
});

const FIELD = 'generated.protectionGapInputs';

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
    console.info(`[ProtectionGapTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[ProtectionGapTests] FAIL: ${name}\n    ${error.message}`);
    return { name, pass: false, error: error.message };
  }
}

/** A one-person household, built to land exactly on the boundary being tested. */
function onePerson({ takeHome = 50_000, needed = 60_000, savings = 30_000, scenarios } = {}) {
  return {
    people: [{ id: 'ann', label: 'Ann', takeHome }],
    needed,
    savings,
    scenarios: scenarios || [{ id: 'base' }]
  };
}

/** The sample with its cases replaced, for the event rules. */
function sampleWith(scenarios) {
  return { ...PROTECTION_GAP_SAMPLE, people: PROTECTION_GAP_SAMPLE.people, scenarios };
}

function died(extra) {
  return {
    id: 'died',
    event: { type: 'dies', personId: 'niamh', survivorsPension: 13_500, ...extra }
  };
}

function bannedWording(text) {
  return [
    /\bcover(s|ed|ing|age)?\b/i,
    /premium/i,
    /\bpolic(y|ies)\b/i,
    /insur/i,
    /\bquote/i,
    /income protection/i,
    /serious illness/i,
    /p\.a\./i,
    /we recommend/i,
    /you should/i,
    /best option/i,
    /\bbest\b/i,
    /\bideal\b/i,
    /\boptimal\b/i,
    /Bank of Ireland|AIB|Permanent TSB|PTSB|Revolut/i,
    /\b(he|she|his|her|hers|him)\b/i,
    /the household/i,
    /the client/i
  ].some((pattern) => pattern.test(text));
}

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

function clientFacingStrings(projection) {
  return collectStrings({
    assumptionsTable: projection.assumptionsTable,
    outputsTable: projection.outputsTable,
    tables: projection.tables,
    charts: projection.charts,
    footnote: projection.debug.footnote,
    cases: projection.debug.cases.map((entry) => ({
      title: entry.title,
      description: entry.description,
      statusWord: entry.statusWord,
      headline: entry.headline,
      sentence: entry.sentence,
      summary: entry.summary,
      segments: entry.segments.map((segment) => segment.label)
    }))
  });
}


/**
 * A recalculated case, as the planning layer hands it over: Niamh cannot work,
 * the standard personal rate of Illness Benefit counts for a year (shown after
 * estimated tax), and the tax is calculated afresh for the whole household in
 * each phase. After the year there is no payment, and Dara's tax is higher
 * because the extra band that came with Niamh's benefit has gone.
 */
export const PROTECTION_GAP_ILLNESS_CASE = Object.freeze({
  id: 'niamh-ill',
  event: Object.freeze({ type: 'cannotWork', personId: 'niamh' }),
  income: Object.freeze({
    basis: 'estimated',
    calculationYear: 2026,
    versions: Object.freeze({ taxRules: 'ie-tax-2026.7', socialWelfare: 'ie-social-welfare-2026.2' }),
    creditAllocation: 'allocated',
    phases: Object.freeze([
      Object.freeze({
        months: 12,
        takeHome: Object.freeze({ niamh: 0, dara: 44_000 }),
        statePayment: Object.freeze({
          personId: 'niamh',
          scheme: 'illnessBenefit',
          amount: 12_508,
          grossAmount: 13_208,
          estimatedTax: 700,
          weeklyRate: 254,
          weeks: 52,
          figure: Object.freeze({ id: 'ie.social_welfare.illness_benefit.personal_highest.from_2026_01_01', status: 'in_force' })
        }),
        householdNetIncome: 56_508
      }),
      Object.freeze({
        takeHome: Object.freeze({ niamh: 0, dara: 43_200 }),
        statePayment: null,
        householdNetIncome: 43_200
      })
    ])
  })
});

function withIllness(overrides = {}, base = PROTECTION_GAP_SAMPLE) {
  const scenario = JSON.parse(JSON.stringify(PROTECTION_GAP_ILLNESS_CASE));
  Object.assign(scenario, overrides);
  return { ...JSON.parse(JSON.stringify(base)), scenarios: [{ id: 'today' }, scenario] };
}

/** Independent reference: drain savings one month at a time through the two phases. */
function referenceMonths({ needed, savings, firstIn, firstMonths, laterIn }) {
  let balance = savings;
  let months = 0;
  while (months < 2_000) {
    const moneyIn = months < firstMonths ? firstIn : laterIn;
    const gapThisMonth = Math.max(0, needed - moneyIn) / 12;
    if (gapThisMonth > 0 && balance < gapThisMonth) {
      return months + balance / gapThisMonth;
    }
    balance -= gapThisMonth;
    months += 1;
  }
  return Infinity;
}

export function runProtectionGapTests() {
  const cases = [];
  const sample = () => computeProtectionGapProjection(PROTECTION_GAP_SAMPLE);

  cases.push(runCase('The sample: every figure in the design table', () => {
    const { debug } = sample();
    const expected = PROTECTION_GAP_EXPECTED;
    assertEqual(debug.cases.length, 4, 'four cases');
    debug.cases.forEach((entry, index) => {
      const label = `case ${index + 1} (${entry.id})`;
      assertEqual(entry.id, expected.ids[index], `${label}: id`);
      assertEqual(entry.title, expected.titles[index], `${label}: title`);
      assertEqual(entry.moneyIn, expected.moneyIn[index], `${label}: money in`);
      assertEqual(entry.needed, expected.needed[index], `${label}: needed`);
      assertEqual(entry.gap, expected.gap[index], `${label}: gap`);
      assertEqual(entry.spare, expected.spare[index], `${label}: left over`);
      assertEqual(entry.months, expected.months[index], `${label}: months`);
      assertEqual(entry.beyond, expected.beyond[index], `${label}: beyond three years`);
      assertEqual(entry.status, expected.status[index], `${label}: status`);
      assertEqual(entry.segments[0].label, expected.floorLabels[index], `${label}: floor label`);
      assertEqual(
        JSON.stringify(entry.segments.map((segment) => segment.amount)),
        JSON.stringify(expected.segments[index]),
        `${label}: segments`
      );
    });
    assertEqual(debug.baseScenarioId, 'today', 'the first case is the base');
    assertEqual(debug.horizonMonths, PROTECTION_GAP_HORIZON_MONTHS, 'the horizon is exposed');
  }));

  cases.push(runCase('The months come from savings over a monthly gap, rounded to the nearest month', () => {
    const { cases: solved } = sample().debug;
    assertWithin(solved[1].exactMonths, 60_000 / (38_000 / 12), 1e-9, '60,000 against 38,000 a year');
    assertWithin(solved[1].exactMonths, 18.947, 0.001, 'is 18.9 months');
    assertWithin(solved[2].exactMonths, 27.692, 0.001, '60,000 against 26,000 a year is 27.7 months');
    assertWithin(solved[3].exactMonths, 480, 1e-9, '60,000 against 1,500 a year is 40 years');
    assertEqual(solved[0].exactMonths, null, 'no gap, no months');
    assertEqual(solved[0].months, null, 'no gap, no rounded months');
  }));

  cases.push(runCase('The answer, the sentence and the titles are the golden strings', () => {
    const { cases: solved } = sample().debug;
    solved.forEach((entry, index) => {
      assertEqual(entry.headline.line1, PROTECTION_GAP_EXPECTED.headlines[index][0], `case ${index + 1} line 1`);
      assertEqual(entry.headline.line2, PROTECTION_GAP_EXPECTED.headlines[index][1], `case ${index + 1} line 2`);
      assertEqual(entry.sentence, PROTECTION_GAP_EXPECTED.sentences[index], `case ${index + 1} sentence`);
      assertEqual(
        entry.summary,
        `${entry.headline.line1} ${entry.headline.line2} ${entry.sentence}`,
        `case ${index + 1} summary`
      );
    });
  }));

  cases.push(runCase('The footnote is the approved wording', () => {
    assertEqual(sample().debug.footnote, PROTECTION_GAP_EXPECTED.footnote, 'footnote');
  }));

  cases.push(runCase('Invariants hold for every case', () => {
    sample().debug.cases.forEach((entry) => {
      const label = entry.id;
      assertEqual(entry.segments.reduce((sum, segment) => sum + segment.amount, 0), entry.moneyIn, `${label}: segments add up`);
      assertEqual(entry.gap, Math.max(0, entry.needed - entry.moneyIn), `${label}: gap is needed minus money in`);
      assertEqual(entry.spare, Math.max(0, entry.moneyIn - entry.needed), `${label}: left over is money in minus needed`);
      assert(!(entry.gap > 0 && entry.spare > 0), `${label}: never both a gap and a left-over`);
      assertEqual(entry.segments.length, 3, `${label}: the slots are stable (floor and each person)`);
      assertEqual(
        entry.segments.map((segment) => segment.id).join(','),
        'floor,niamh,dara',
        `${label}: the slots keep their order`
      );
    });
  }));

  cases.push(runCase('One scale for the module: the sample is 110,000, and it steps up in 10,000s with 5% headroom', () => {
    assertEqual(sample().debug.scaleMax, 110_000, 'sample scale');
    const scaleFor = (takeHome, needed) => computeProtectionGapProjection(
      onePerson({ takeHome, needed })
    ).debug.scaleMax;
    assertEqual(scaleFor(100_000, 90_000), 110_000, '100,000 plus 5% is 105,000, up to 110,000');
    assertEqual(scaleFor(95_000, 90_000), 100_000, '95,000 plus 5% is 99,750, up to 100,000');
    assertEqual(scaleFor(50_000, 40_000), 60_000, '50,000 plus 5% is 52,500, up to 60,000');
    assertEqual(scaleFor(40_000, 50_000), 60_000, 'the larger of money in and needed sets it');
  }));

  cases.push(runCase('Month boundaries: 36 is beyond, 35.5 rounds to 36, one month and under one month', () => {
    const run = (savings, needed) => computeProtectionGapProjection(onePerson({ savings, needed })).debug.cases[0];
    const exactly36 = run(30_000, 60_000);
    assertEqual(exactly36.exactMonths, 36, 'exactly 36 months');
    assertEqual(exactly36.beyond, true, '36 months is beyond');
    assertEqual(exactly36.months, null, 'beyond has no rounded months');
    assertEqual(exactly36.headline.line2, 'Your savings would last beyond three years.', 'beyond wording');

    const nearly36 = run(35_500, 62_000);
    assertEqual(nearly36.exactMonths, 35.5, '35.5 months');
    assertEqual(nearly36.beyond, false, '35.5 is not beyond');
    assertEqual(nearly36.months, 36, '35.5 rounds to 36');
    assertEqual(nearly36.headline.line2, 'Your savings would last 36 months.', '36 months wording');

    assertEqual(run(35_490, 62_000).months, 35, '35.49 rounds down');

    const oneMonth = run(1_000, 62_000);
    assertEqual(oneMonth.months, 1, 'one month');
    assertEqual(oneMonth.headline.line2, 'Your savings would last 1 month.', 'singular');

    const underMonth = run(100, 62_000);
    assertEqual(underMonth.months, 0, 'under half a month rounds to 0');
    assertEqual(underMonth.headline.line2, 'Your savings would last less than a month.', 'under a month wording');

    const none = run(0, 62_000);
    assertEqual(none.months, 0, 'no savings is 0 months');
    assertEqual(none.headline.line2, 'You have no savings to fill it.', 'no savings wording');
  }));

  cases.push(runCase('Left over and tight: status, answer and status word', () => {
    const left = computeProtectionGapProjection(onePerson({ takeHome: 50_000, needed: 40_000 })).debug.cases[0];
    assertEqual(left.status, 'left_over', 'left over');
    assertEqual(left.statusWord, 'Left over', 'left over word');
    assertEqual(left.months, null, 'nothing to fill');
    assertEqual(left.headline.line1, 'You have €10,000 a year left over.', 'left over line 1');

    const tight = computeProtectionGapProjection(onePerson({ takeHome: 50_000, needed: 50_000 })).debug.cases[0];
    assertEqual(tight.status, 'tight', 'tight is returned, not rejected');
    assertEqual(tight.statusWord, 'Tight', 'tight word');
    assertEqual(tight.gap, 0, 'no gap');
    assertEqual(tight.spare, 0, 'nothing left over');
    assertEqual(tight.headline.line1, 'You have exactly what you need.', 'tight line 1');
    assertEqual(tight.headline.line2, 'There is nothing for your savings to fill.', 'tight line 2');
  }));

  cases.push(runCase('One person: cannotWork is allowed, a death is rejected, the base sentence changes', () => {
    const payload = onePerson({
      scenarios: [
        { id: 'base' },
        { id: 'stops', event: { type: 'cannotWork', personId: 'ann', statePayment: 13_000 } }
      ]
    });
    const solved = computeProtectionGapProjection(payload).debug.cases;
    assertEqual(solved[0].sentence, 'Your take-home pay comes in, and you need €60,000.', 'one earner sentence');
    assertEqual(solved[1].moneyIn, 13_000, 'what comes in is the State payment only');
    assertEqual(solved[1].gap, 47_000, 'the gap');
    assertEqual(solved[1].title, 'Ann cannot work', 'title');

    assertThrows(
      () => computeProtectionGapProjection(onePerson({
        scenarios: [{ id: 'base' }, { id: 'd', event: { type: 'dies', personId: 'ann', survivorsPension: 1 } }]
      })),
      `${FIELD}.scenarios[1] (If Ann died): needs two people in the household.`,
      'a death needs two people'
    );
  }));

  cases.push(runCase('neededAfter rules: reason, no reason, unchanged, higher, reason without a figure', () => {
    const sentence = (extra) => computeProtectionGapProjection(sampleWith([died(extra)])).debug.cases[0].sentence;
    const lead = 'Niamh’s take-home stops and a survivor’s pension starts.';

    assertEqual(sentence({ neededAfter: 60_000, neededBecause: ['mortgageCleared'] }),
      `${lead} You need €60,000, because your mortgage is cleared.`, 'one reason: mortgage');
    assertEqual(sentence({ neededAfter: 60_000, neededBecause: ['livingCostsLower'] }),
      `${lead} You need €60,000, because your living costs drop.`, 'one reason: living costs');
    assertEqual(sentence({ neededAfter: 60_000, neededBecause: ['livingCostsLower', 'mortgageCleared', 'mortgageCleared'] }),
      `${lead} You need €60,000, because your mortgage is cleared and your living costs drop.`, 'both, in order, no repeats');
    assertEqual(sentence({ neededAfter: 60_000 }),
      `${lead} You need €60,000.`, 'a lower need with no reason has no reason clause');
    assertEqual(sentence({ neededAfter: 60_000, neededBecause: [] }),
      `${lead} You need €60,000.`, 'an empty reason list is no reason');
    assertEqual(sentence({}),
      `${lead} You still need €96,000.`, 'no neededAfter: still needed');
    assertEqual(sentence({ neededAfter: 96_000 }),
      `${lead} You still need €96,000.`, 'neededAfter equal to needed: still needed');
    assertEqual(sentence({ neededAfter: 96_000, neededBecause: ['mortgageCleared'] }),
      `${lead} You still need €96,000.`, 'an unchanged need carries no reason');

    assertThrows(
      () => computeProtectionGapProjection(sampleWith([died({ neededAfter: 100_000 })])),
      `${FIELD}.scenarios[0] (If Niamh died): a higher need after a death is not drawn yet.`,
      'a higher need is not drawn'
    );
    assertThrows(
      () => computeProtectionGapProjection(sampleWith([died({ neededBecause: ['mortgageCleared'] })])),
      `${FIELD}.scenarios[0] (If Niamh died): neededBecause needs neededAfter.`,
      'a reason with no figure'
    );
    assertThrows(
      () => computeProtectionGapProjection(sampleWith([died({ neededAfter: 60_000, neededBecause: ['rentFalls'] })])),
      `${FIELD}.scenarios[0] (If Niamh died): neededBecause "rentFalls" is not one of mortgageCleared, livingCostsLower.`,
      'an unknown reason'
    );
  }));

  cases.push(runCase('A survivor’s pension of 0 is not announced as a pension', () => {
    const solved = computeProtectionGapProjection(sampleWith([died({ survivorsPension: 0 })])).debug.cases[0];
    assertEqual(solved.sentence, 'Niamh’s take-home stops. You still need €96,000.', 'no pension, none mentioned');
    assertEqual(solved.moneyIn, 45_000, 'only Dara’s take-home');
    assertEqual(solved.segments[0].amount, 0, 'the floor slot is there with nothing in it');
  }));

  cases.push(runCase('No State payment is a valid cannot-work case, with the full gap and no payment announced', () => {
    const raw = sampleWith([
      { id: 'today' },
      { id: 'no-payment', event: { type: 'cannotWork', personId: 'niamh', statePayment: 0 } }
    ]);
    const projection = computeProtectionGapProjection(raw);
    const solved = projection.debug.cases[1];
    assertEqual(solved.moneyIn, 45_000, 'only Dara’s take-home remains');
    assertEqual(solved.gap, 51_000, 'the full shortfall');
    assertEqual(solved.months, 14, 'savings fill the larger gap for 14 months');
    assertEqual(solved.segments[0].amount, 0, 'the State payment segment has no width');
    assertEqual(solved.sentence, 'Niamh’s take-home stops. You still need €96,000.', 'no payment is announced');
    assert(protectionGapSummaryHtml(projection).includes('€51,000'), 'the generated summary uses the full shortfall');

    const one = computeProtectionGapProjection({
      people: [{ id: 'ann', label: 'Ann', takeHome: 50_000 }],
      needed: 60_000, savings: 30_000,
      scenarios: [{ id: 'today' }, { id: 'stops', event: { type: 'cannotWork', personId: 'ann', statePayment: 0 } }]
    }).debug.cases[1];
    assertEqual(one.moneyIn, 0, 'one person has no remaining income');
    assertEqual(one.gap, 60_000, 'all spending must come from savings');
    assertEqual(one.months, 6, 'savings last six months');
  }));

  cases.push(runCase('A person with no take-home contributes nothing and is not counted as an earner', () => {
    const payload = {
      people: [{ id: 'a', label: 'Ann', takeHome: 0 }, { id: 'b', label: 'Bo', takeHome: 40_000 }],
      needed: 50_000,
      savings: 10_000,
      scenarios: [{ id: 'base' }]
    };
    const solved = computeProtectionGapProjection(payload).debug.cases[0];
    assertEqual(solved.sentence, 'Your take-home pay comes in, and you need €50,000.', 'one earner among two');
    assertEqual(solved.moneyIn, 40_000, 'money in');
  }));

  cases.push(runCase('Validation: every message, exactly', () => {
    const p = PROTECTION_GAP_SAMPLE;
    const make = (patch) => ({ ...p, people: p.people, scenarios: p.scenarios, ...patch });
    const run = (payload) => () => computeProtectionGapProjection(payload);

    assertThrows(run(make({ scenarios: [...p.scenarios, { id: 'fifth' }] })),
      `${FIELD}.scenarios supports at most 4 cases; received 5.`, 'a fifth case');
    assertThrows(run(make({ scenarios: [] })),
      `${FIELD}.scenarios must be an array with at least 1 case.`, 'no cases');
    assertThrows(run(make({ people: [{ id: 'niamh', label: 'Niamh', takeHome: 1000.5 }, p.people[1]] })),
      `${FIELD}.people[0].takeHome must be a whole number of euros.`, 'non-integer take-home');
    assertThrows(run(make({ people: [{ id: 'niamh', label: 'Niamh', takeHome: -1 }, p.people[1]] })),
      `${FIELD}.people[0].takeHome must be a whole number of euros.`, 'negative take-home');
    assertThrows(run(make({ people: [p.people[0], p.people[1], { id: 'cy', label: 'Cy', takeHome: 1 }] })),
      `${FIELD}.people must list 1 or 2 people.`, 'three people');
    assertThrows(run(make({ people: [p.people[0], { ...p.people[1], id: 'niamh' }] })),
      `${FIELD}.people[1].id must be unique.`, 'duplicate person id');
    assertThrows(run(make({ people: [{ id: 'Niamh S', label: 'Niamh', takeHome: 1 }, p.people[1]] })),
      `${FIELD}.people[0].id must be lower case letters, numbers, "-" or "_".`, 'person id pattern');
    assertThrows(run(make({ people: [{ id: 'niamh', label: '', takeHome: 1 }, p.people[1]] })),
      `${FIELD}.people[0].label must be 1 to 24 characters.`, 'empty person label');
    assertThrows(run(make({ needed: 0 })),
      `${FIELD}.needed must be a whole number of euros greater than 0.`, 'needed 0');
    assertThrows(run(make({ savings: -5 })),
      `${FIELD}.savings must be a whole number of euros, 0 or more.`, 'negative savings');
    assertThrows(run(make({ householdLabel: '' })),
      `${FIELD}.householdLabel must be 1 to 60 characters.`, 'empty household label');
    assertThrows(run(make({ baseScenarioId: 'nope' })),
      `${FIELD}.baseScenarioId must match a case id.`, 'unknown base');
    assertThrows(run(make({ scenarios: [{ id: 'a' }, { id: 'a' }] })),
      `${FIELD}.scenarios[1].id must be unique.`, 'duplicate case id');
    assertThrows(run(make({ scenarios: [{ id: 'a', title: 'x'.repeat(41) }] })),
      `${FIELD}.scenarios[0].title must be 1 to 40 characters.`, 'long title');
    assertThrows(run(make({ scenarios: [{ id: 'a', colour: 'red' }] })),
      `${FIELD}.scenarios[0] (a): "colour" is not a field.`, 'unknown case key');
    assertThrows(run(make({ colour: 'red' })),
      `${FIELD}: "colour" is not a field.`, 'unknown top-level key');
    assertThrows(run(make({ scenarios: [{ id: 'a', event: { type: 'retires', personId: 'niamh' } }] })),
      `${FIELD}.scenarios[0].event.type must be "cannotWork" or "dies".`, 'unknown event');
    assertThrows(run(make({ scenarios: [{ id: 'a', event: { type: 'cannotWork', personId: 'zed', statePayment: 1 } }] })),
      `${FIELD}.scenarios[0] (a): personId "zed" is not one of the people.`, 'unknown person');
    [-1, 0.5, null, undefined].forEach((statePayment) => {
      assertThrows(run(make({ scenarios: [{ id: 'a', event: { type: 'cannotWork', personId: 'niamh', statePayment } }] })),
        `${FIELD}.scenarios[0] (Niamh cannot work): statePayment must be a whole number of euros, 0 or more.`, 'invalid State payment');
    });
    assertThrows(run(make({ scenarios: [{ id: 'a', event: { type: 'cannotWork', personId: 'niamh', statePayment: 1, survivorsPension: 1 } }] })),
      `${FIELD}.scenarios[0].event (a): "survivorsPension" is not a field.`, 'a field of the other event');
    assertThrows(run(make({ scenarios: [{ id: 'a', event: [{ type: 'cannotWork' }] }] })),
      `${FIELD}.scenarios[0] (a): a case takes one event.`, 'two events');
    assertThrows(run(make({
      people: [{ id: 'ann', label: 'Ann', takeHome: 0 }, p.people[1]],
      scenarios: [{ id: 'a', event: { type: 'cannotWork', personId: 'ann', statePayment: 5 } }]
    })), `${FIELD}.scenarios[0] (Ann cannot work): personId "ann" has no take-home to stop.`, 'nothing to stop');
  }));

  cases.push(runCase('Calculated fields are refused wherever they appear', () => {
    const p = PROTECTION_GAP_SAMPLE;
    ['gap', 'months', 'spare', 'leftOver'].forEach((key) => {
      assertThrows(() => computeProtectionGapProjection({ ...p, [key]: 1 }),
        `${FIELD}.${key} is not accepted. It is calculated.`, `${key} at the top`);
      assertThrows(() => computeProtectionGapProjection({ ...p, scenarios: [{ id: 'a', [key]: 1 }] }),
        `${FIELD}.scenarios[0].${key} is not accepted. It is calculated.`, `${key} in a case`);
    });
  }));

  cases.push(runCase('The hard limit: no cover, premium or product key, at any level', () => {
    const p = PROTECTION_GAP_SAMPLE;
    const message = (path) => `${FIELD}.${path}: this screen shows the gap and the time, never a cover amount, a premium or a product.`;
    assertThrows(() => computeProtectionGapProjection({ ...p, coverAmount: 100_000 }),
      message('coverAmount'), 'top level');
    assertThrows(() => computeProtectionGapProjection({ ...p, monthlyPremium: 50 }),
      message('monthlyPremium'), 'premium');
    assertThrows(() => computeProtectionGapProjection({
      ...p,
      people: [{ ...p.people[0], product: 'x' }, p.people[1]]
    }), message('people[0].product'), 'in a person');
    assertThrows(() => computeProtectionGapProjection({
      ...p,
      scenarios: [{ id: 'a', provider: 'x' }]
    }), message('scenarios[0].provider'), 'in a case');
    assertThrows(() => computeProtectionGapProjection({
      ...p,
      scenarios: [{ id: 'a', event: { type: 'cannotWork', personId: 'niamh', statePayment: 1, insurerPays: 1 } }]
    }), message('scenarios[0].event.insurerPays'), 'in an event');
    assertThrows(() => computeProtectionGapProjection({ ...p, policyNumber: 'x' }),
      message('policyNumber'), 'policy');
    assertThrows(() => computeProtectionGapProjection({ ...p, quoteRef: 'x' }),
      message('quoteRef'), 'quote');
    // The limit outranks a calculated field and an unknown one.
    assertThrows(() => computeProtectionGapProjection({ ...p, colour: 'x', gap: 1, coverAmount: 1 }),
      message('coverAmount'), 'the hard limit is said first');
  }));

  cases.push(runCase('Normalising twice changes nothing, and the input is never touched', () => {
    const once = normalizeProtectionGapInputs(PROTECTION_GAP_SAMPLE);
    const twice = normalizeProtectionGapInputs(once);
    assertEqual(JSON.stringify(twice), JSON.stringify(once), 'idempotent');
    assertEqual(Object.isFrozen(PROTECTION_GAP_SAMPLE), true, 'the sample is frozen, so a mutation would have thrown');
    assertEqual(once.scenarios[3].event.neededBecause.length, 2, 'reasons kept');
    assertEqual(once.householdLabel, 'Niamh and Dara, both 45', 'household label kept');
    const noLabel = normalizeProtectionGapInputs(onePerson());
    assertEqual('householdLabel' in noLabel, false, 'an absent household label stays absent');
  }));

  cases.push(runCase('Cases for the presenter, the default case and the base case', () => {
    const list = getProtectionGapCases(PROTECTION_GAP_SAMPLE);
    assertEqual(list.length, 4, 'four cases');
    assertEqual(JSON.stringify(Object.keys(list[0])), JSON.stringify(['id', 'title', 'description']), 'shape');
    assertEqual(list[3].title, 'If Niamh died', 'the death case is "If Niamh died"');
    assertEqual(getDefaultProtectionGapScenarioId(PROTECTION_GAP_SAMPLE), 'today', 'default is the first case');
    const reordered = { ...PROTECTION_GAP_SAMPLE, scenarios: [...PROTECTION_GAP_SAMPLE.scenarios.slice(1), PROTECTION_GAP_SAMPLE.scenarios[0]], baseScenarioId: 'today' };
    assertEqual(getDefaultProtectionGapScenarioId(reordered), 'today', 'a stated base');
    assertEqual(computeProtectionGapProjection(reordered).debug.baseScenarioId, 'today', 'base in the projection');
    assertThrows(
      () => computeProtectionGapProjection({ ...PROTECTION_GAP_SAMPLE, baseScenarioId: 'dara-cannot-work' }),
      'generated.protectionGapInputs.baseScenarioId (Dara cannot work): the base case is today, so it cannot have an event. Put the case with no event first, or name it as baseScenarioId.',
      'a base with an event is refused when there are other cases'
    );
    assertThrows(
      () => computeProtectionGapProjection({ ...PROTECTION_GAP_SAMPLE, scenarios: [{ ...PROTECTION_GAP_SAMPLE.scenarios[1], title: 'Best income protection policy' }] }),
      'generated.protectionGapInputs.scenarios[0].title ("Best income protection policy"): this screen shows the gap and the time, never a recommendation, a cover amount, a premium, a product or a provider, and never says "he", "she" or "the household".',
      'a title with forbidden wording is refused'
    );
    assertThrows(
      () => computeProtectionGapProjection({ ...PROTECTION_GAP_SAMPLE, householdLabel: 'The household, insured with Zurich' }),
      'generated.protectionGapInputs.householdLabel ("The household, insured with Zurich"): this screen shows the gap and the time, never a recommendation, a cover amount, a premium, a product or a provider, and never says "he", "she" or "the household".',
      'the household line is checked too'
    );
    assertThrows(
      () => computeProtectionGapProjection({
        ...PROTECTION_GAP_SAMPLE,
        people: [PROTECTION_GAP_SAMPLE.people[0], { id: 'dara', label: 'Zurich', takeHome: 45_000 }]
      }),
      'generated.protectionGapInputs.people[1].label ("Zurich"): a name is shown on this screen, so it is held to the same wording limit (no provider, product, "he" or "she"). If it is the person\'s own name, use another form of it.',
      'a person\'s name is checked too, since it is shown in the sentence and the case title'
    );
    const titled = computeProtectionGapProjection({
      ...PROTECTION_GAP_SAMPLE,
      scenarios: [{ id: 'a', title: 'Your own title', description: 'One line.' }]
    }).debug.cases[0];
    assertEqual(titled.title, 'Your own title', 'a stated title wins');
    assertEqual(titled.description, 'One line.', 'description kept');
  }));

  cases.push(runCase('The summary is written from the engine\'s own answers, escaped', () => {
    assertEqual(
      protectionGapSummaryHtml(sample()),
      '<p>This shows how big the gap would be each year if an income stopped, and how many months your savings would fill it. Take-home pay and State payments are as given.</p>'
        + '<ul><li>Today: You have €6,000 a year left over. There is nothing for your savings to fill.</li>'
        + '<li>Niamh cannot work: You are €38,000 a year short. Your savings would last 19 months.</li>'
        + '<li>Dara cannot work: You are €26,000 a year short. Your savings would last 28 months.</li>'
        + '<li>If Niamh died: You are €1,500 a year short. Your savings would last beyond three years.</li></ul>',
      'a fixed opening line, then each case\'s answer in case order'
    );
    const marked = protectionGapSummaryHtml(computeProtectionGapProjection({
      ...PROTECTION_GAP_SAMPLE,
      scenarios: [{ id: 'a', title: 'A <b>bold</b> & "marked" title' }]
    }));
    assert(marked.includes('<li>A &lt;b&gt;bold&lt;/b&gt; &amp; &quot;marked&quot; title: '), `a title is text, never markup: ${marked}`);
  }));

  cases.push(runCase('Tables and chart: shape, and the figures are the case figures', () => {
    const projection = sample();
    assertEqual(projection.outputsTable.rows.length, 4, 'one row per case');
    assertEqual(
      JSON.stringify(projection.outputsTable.rows[1]),
      JSON.stringify(['Niamh cannot work', 58_000, 96_000, 38_000, 0, 19]),
      'case 2 row'
    );
    assertEqual(projection.outputsTable.rows[0][5], 'Not needed', 'no gap, savings not needed');
    assertEqual(projection.outputsTable.rows[3][5], 'Beyond three years', 'beyond');
    assertEqual(projection.tables.length, 4, 'one table per case');
    assertEqual(
      JSON.stringify(projection.tables[1].rows),
      JSON.stringify([
        ['State payment', 13_000],
        ['Dara’s take-home', 45_000],
        ['What comes in', 58_000],
        ['What you need', 96_000],
        ['Gap', 38_000]
      ]),
      'case 2 table'
    );
    assertEqual(projection.charts.length, 1, 'one ordinary chart');
    assertEqual(projection.charts[0].type, 'bar', 'a bar');
    assertEqual(JSON.stringify(projection.charts[0].datasets[0].data), JSON.stringify([102_000, 96_000]), 'base case figures');
  }));

  cases.push(runCase('Words: no banned phrase, cover or premium wording, pronoun, third-person household or unseparated amount', () => {
    const variants = [
      sample(),
      computeProtectionGapProjection(onePerson({ savings: 0, needed: 62_000 })),
      computeProtectionGapProjection(sampleWith([
        { id: 'today' },
        died({ neededAfter: 60_000 }),
        { ...died({ survivorsPension: 0 }), id: 'nopension' }
      ]))
    ];
    variants.forEach((projection, index) => {
      clientFacingStrings(projection).forEach((text) => {
        assert(!bannedWording(text), `variant ${index + 1}: banned wording in "${text}"`);
        assert(!/€\d{4,}/.test(text), `variant ${index + 1}: amount without a thousands separator in "${text}"`);
      });
    });
    sample().debug.cases.forEach((entry) => {
      const spoken = `${entry.headline.line1} ${entry.headline.line2} ${entry.sentence}`;
      assert(/\byou(r)?\b/i.test(entry.headline.line1), `${entry.id}: line 1 speaks to you`);
      assert(/\byou(r)?\b/i.test(entry.sentence), `${entry.id}: the sentence speaks to you`);
      assert(!/\byou should\b/i.test(spoken), `${entry.id}: never "you should"`);
    });
    assert(/\byour\b/.test(sample().debug.footnote), 'the footnote speaks to you');
  }));


  cases.push(runCase('An income-stops case with recalculated take-home and the State payment kept apart: every figure', () => {
    const projection = computeProtectionGapProjection(withIllness());
    const entry = projection.debug.cases[1];
    assertEqual(entry.title, 'Niamh cannot work', 'the title');
    assertEqual(entry.segments.map((segment) => segment.amount).join(','), '12508,0,44000', 'State payment, Niamh, Dara');
    assertEqual(entry.segments[0].label, 'State payment', 'the payment is its own part, labelled as one');
    assertEqual(entry.moneyIn, 56_508, 'money in is the first phase');
    assertEqual(entry.gap, 39_492, 'the gap is the first phase’s');
    assertEqual(entry.status, 'short', 'short');
    assertEqual(entry.intervals.map((stretch) => `${stretch.start}:${stretch.length}:${stretch.moneyIn}:${stretch.gap}`).join(' '),
      '0:12:56508:39492 12:null:43200:52800', 'two stretches');
    assertEqual(entry.months, 17, 'rounded months');
    assertWithin(entry.exactMonths, 12 + (((60_000 * 12) - (39_492 * 12)) / 52_800), 1e-9, 'unrounded months, by hand');
    assertEqual(entry.headline.line1, 'You are €39,492 a year short.', 'line 1');
    assertEqual(entry.headline.line2, 'Your savings would last 17 months.', 'line 2');
    assertEqual(entry.sentence,
      'Niamh’s take-home stops and a State payment starts, shown after estimated tax. '
      + 'Assumes the standard personal rate of Illness Benefit. '
      + 'You still need €96,000. After a year, the State payment is not counted, and you would be €52,800 a year short.',
      'the sentence says what was assumed and for how long');
  }));

  cases.push(runCase('The runway is not extended: a full year at the rate, then nothing, checked month by month against an independent loop', () => {
    [0, 5_000, 20_000, 60_000, 90_000, 150_000].forEach((savings) => {
      const projection = computeProtectionGapProjection({ ...withIllness(), savings });
      const entry = projection.debug.cases[1];
      const expected = referenceMonths({ needed: 96_000, savings, firstIn: 56_508, firstMonths: 12, laterIn: 43_200 });
      if (Number.isFinite(expected)) {
        assertWithin(entry.exactMonths, expected, 1e-6, `savings ${savings}: months`);
      }
      assertEqual(entry.beyond, expected >= PROTECTION_GAP_HORIZON_MONTHS, `savings ${savings}: beyond three years`);
    });
    // Had the payment carried on, 60,000 of savings would last longer. It must not.
    const carried = computeProtectionGapProjection({ ...withIllness(), scenarios: [{ id: 'today' }, {
      id: 'carried',
      event: { type: 'cannotWork', personId: 'niamh', statePayment: 12_508 }
    }] }).debug.cases[1];
    const counted = computeProtectionGapProjection(withIllness()).debug.cases[1];
    assert(carried.exactMonths > counted.exactMonths, 'a payment that went on for ever would show longer, and is not shown');
  }));

  cases.push(runCase('Covered for the year, short afterwards: the answer says when, the strip says why it is empty', () => {
    const covered = withIllness({}, { ...PROTECTION_GAP_SAMPLE, needed: 54_000 });
    const entry = computeProtectionGapProjection(covered).debug.cases[1];
    assertEqual(entry.status, 'left_over', 'the first stretch has money to spare');
    assertEqual(entry.gap, 0, 'no gap at first');
    assertEqual(entry.headline.line1, 'You have €2,508 a year left over.', 'line 1');
    assertEqual(entry.headline.line2, 'After a year you would be €10,800 a year short, and your savings would last beyond three years.', 'line 2');
    assertEqual(entry.nothingText, 'Nothing to fill at first', 'the strip says it is only at first');
    assertEqual(entry.beyond, true, 'beyond three years');
    const shorter = computeProtectionGapProjection({ ...covered, savings: 10_000 }).debug.cases[1];
    assertEqual(shorter.headline.line2, 'After a year you would be €10,800 a year short, and your savings would last 23 months in all.', 'months run from the day income stops');
    assertWithin(shorter.exactMonths, 12 + ((10_000 * 12) / 10_800), 1e-9, 'twelve covered months, then savings over the later gap');
    const none = computeProtectionGapProjection({ ...covered, savings: 0 }).debug.cases[1];
    assertEqual(none.headline.line2, 'After a year you would be €10,800 a year short, and you have no savings to fill it.', 'no savings');
  }));

  cases.push(runCase('Each case keeps its own contract: version, year, basis and allocation are returned, and reordering cases changes no answer', () => {
    const input = withIllness();
    input.scenarios.push({
      ...JSON.parse(JSON.stringify(PROTECTION_GAP_ILLNESS_CASE)),
      id: 'dara-ill',
      event: { type: 'cannotWork', personId: 'dara' },
      income: {
        ...JSON.parse(JSON.stringify(PROTECTION_GAP_ILLNESS_CASE.income)),
        phases: [
          { months: 12, takeHome: { niamh: 55_000, dara: 0 },
            statePayment: { personId: 'dara', scheme: 'illnessBenefit', amount: 12_508, grossAmount: 13_208, estimatedTax: 700, weeklyRate: 254, weeks: 52 },
            householdNetIncome: 67_508 },
          { takeHome: { niamh: 54_000, dara: 0 }, statePayment: null, householdNetIncome: 54_000 }
        ]
      }
    });
    const frozen = JSON.stringify(input);
    const forward = computeProtectionGapProjection(input);
    assertEqual(JSON.stringify(input), frozen, 'the input is untouched');
    const reversed = computeProtectionGapProjection({ ...input, scenarios: [input.scenarios[0], input.scenarios[2], input.scenarios[1]] });
    const byId = (projection) => Object.fromEntries(projection.debug.cases.map((entry) => [entry.id, JSON.stringify(entry)]));
    assertEqual(byId(reversed)['niamh-ill'], byId(forward)['niamh-ill'], 'Niamh’s case after Dara’s');
    assertEqual(byId(reversed)['dara-ill'], byId(forward)['dara-ill'], 'Dara’s case before Niamh’s');
    const again = computeProtectionGapProjection(input);
    assertEqual(JSON.stringify(again.debug.cases), JSON.stringify(forward.debug.cases), 'and again');
    assertEqual(JSON.stringify(forward.debug.assumptionsUsed.incomeContracts[0]),
      JSON.stringify({ caseId: 'niamh-ill', basis: 'estimated', calculationYear: 2026,
        versions: { taxRules: 'ie-tax-2026.7', socialWelfare: 'ie-social-welfare-2026.2' }, creditAllocation: 'allocated' }),
      'the contract is returned with the year, versions, basis and allocation');
    assertEqual(forward.debug.assumptionsUsed.taxRecalculated, true, 'and the module says tax was recalculated');
  }));

  cases.push(runCase('The footnote says tax is recalculated for each case, with the partner sentence only for a couple', () => {
    const couple = computeProtectionGapProjection(withIllness()).debug.footnote;
    assert(couple.includes('Tax is recalculated for each case. If one of you stops working, the other person’s take-home may change.'), `the approved wording: ${couple}`);
    assert(couple.includes('State payments are shown after estimated tax and depend on eligibility.'), 'the payment is explained as after tax');
    assert(couple.includes('A State payment is counted only for the time stated, and not after that.'), 'and for how long');
    assert(!couple.includes('State payments are as given'), 'the stated wording is replaced');
    const alone = computeProtectionGapProjection({
      people: [{ id: 'ann', label: 'Ann', takeHome: 50_000 }],
      needed: 60_000,
      savings: 30_000,
      scenarios: [{ id: 'today' }, {
        id: 'ann-ill',
        event: { type: 'cannotWork', personId: 'ann' },
        income: {
          basis: 'estimated', calculationYear: 2026, versions: { taxRules: 'ie-tax-2026.7' },
          phases: [{ months: 12, takeHome: { ann: 0 },
            statePayment: { personId: 'ann', scheme: 'illnessBenefit', amount: 13_208, grossAmount: 13_208, estimatedTax: 0 },
            householdNetIncome: 13_208 },
          { takeHome: { ann: 0 }, statePayment: null, householdNetIncome: 0 }]
        }
      }]
    }).debug.footnote;
    assert(alone.includes('Tax is recalculated for each case.'), 'a single person still has tax recalculated');
    assert(!alone.includes('the other person'), 'but there is no partner sentence');
    assertEqual(sample().debug.footnote, PROTECTION_GAP_EXPECTED.footnote, 'a module with only stated figures keeps its wording');
  }));

  cases.push(runCase('A zero State payment, a stated payment beside a recalculated case and a mixed module', () => {
    const zero = withIllness();
    zero.scenarios[1].income.phases[0].statePayment = { personId: 'niamh', scheme: 'stated', amount: 0 };
    zero.scenarios[1].income.phases[0].householdNetIncome = 44_000;
    const entry = computeProtectionGapProjection(zero).debug.cases[1];
    assertEqual(entry.segments[0].amount, 0, 'no payment');
    assert(!entry.sentence.includes('a State payment starts'), 'and none announced');
    assert(!entry.sentence.includes('Illness Benefit'), 'nor any assumed rate');
    const mixed = computeProtectionGapProjection({ ...withIllness(), scenarios: [...withIllness().scenarios,
      { id: 'dara-stated', event: { type: 'cannotWork', personId: 'dara', statePayment: 13_000 } }] });
    assert(mixed.debug.footnote.includes('A State payment you gave us is used as given.'), 'the footnote separates a given payment from a worked-out one');
    assert(mixed.assumptionsTable.rows.some((row) => row[0] === 'State payments' && row[1].startsWith('Assumes the standard personal rate of Illness Benefit') && row[1].includes('A year, as given')), 'and so do the assumptions');
  }));

  cases.push(runCase('The assumptions name the rate assumed, the year and versions of the tax, and how long a payment counts', () => {
    const rows = Object.fromEntries(computeProtectionGapProjection(withIllness()).assumptionsTable.rows);
    assertEqual(rows['State payments'], 'Assumes the standard personal rate of Illness Benefit for a year, shown after estimated tax', 'the assumed rate');
    assertEqual(rows['Take-home pay'], 'Net pay a year, recalculated for each case', 'take-home');
    assert(rows.Tax.includes('2026') && rows.Tax.includes('ie-tax-2026.7') && rows.Tax.includes('ie-social-welfare-2026.2'), `the year and versions: ${rows.Tax}`);
    assert(rows.Tax.includes('allocated'), 'and that a joint assessment is allocated between the two');
    assertEqual(rows['How long a payment counts'], 'For the time stated, then not at all', 'the duration');
  }));

  cases.push(runCase('A death with a survivor’s pension from the register’s rate shown after tax, and one stated as given', () => {
    const dies = {
      id: 'niamh-died',
      event: { type: 'dies', personId: 'niamh' },
      income: {
        basis: 'estimated', calculationYear: 2026, versions: { taxRules: 'ie-tax-2026.7', socialWelfare: 'ie-social-welfare-2026.2' },
        phases: [{ takeHome: { niamh: 0, dara: 42_000 },
          statePayment: { personId: 'dara', scheme: 'bereavedPartnerPension', amount: 13_194, grossAmount: 13_494, estimatedTax: 300, weeklyRate: 259.5, weeks: 52 },
          householdNetIncome: 55_194 }]
      }
    };
    const entry = computeProtectionGapProjection({ ...PROTECTION_GAP_SAMPLE, scenarios: [{ id: 'today' }, dies] }).debug.cases[1];
    assertEqual(entry.segments[0].label, 'Survivor’s pension', 'the label');
    assertEqual(entry.segments[0].amount, 13_194, 'the amount, after tax');
    assert(entry.sentence.startsWith('Niamh’s take-home stops and a survivor’s pension starts, shown after estimated tax. Assumes the standard personal rate of the Bereaved Partner’s (Contributory) Pension.'), entry.sentence);
    assertEqual(entry.intervals.length, 1, 'a survivor’s pension carries on, so one stretch');
    const stated = computeProtectionGapProjection({ ...PROTECTION_GAP_SAMPLE, scenarios: [{ id: 'today' }, {
      ...dies,
      income: { ...dies.income, phases: [{ takeHome: { niamh: 0, dara: 42_000 }, statePayment: { personId: 'dara', scheme: 'stated', amount: 15_000 }, householdNetIncome: 57_000 }] }
    }] }).debug.cases[1];
    assertEqual(stated.segments[0].amount, 15_000, 'a stated survivor’s pension is used as given');
    assert(!stated.sentence.includes('Assumes the standard'), 'with no assumed rate');
  }));

  cases.push(runCase('Stated money received: a lump sum joins the savings and a mortgage protected on that death is cleared', () => {
    const base = { ...PROTECTION_GAP_SAMPLE, scenarios: [{ id: 'today' }, {
      id: 'niamh-died',
      event: { type: 'dies', personId: 'niamh', survivorsPension: 13_500, neededAfter: 60_000, neededBecause: ['mortgageCleared'] },
      received: [{ type: 'lumpSum', amount: 100_000 }]
    }] };
    const entry = computeProtectionGapProjection(base).debug.cases[1];
    assertEqual(entry.savingsAvailable, 160_000, 'savings and the lump sum');
    assertEqual(entry.headline.line2, 'Your savings and the lump sum would last beyond three years.', 'the answer counts it');
    assert(entry.sentence.includes('A lump sum of €100,000, as you told us, is counted with your savings.'), entry.sentence);
    assert(entry.sentence.includes('You need €60,000, because your mortgage is cleared.'), 'the mortgage appears as cleared');
    assertEqual(entry.savingsLead, 'Your savings and a lump sum of €100,000 would last', 'the strip’s lead');
    assert(!/cover|premium|policy|insur|provider|product/i.test(`${entry.sentence} ${entry.headline.line2} ${entry.savingsLead}`), 'never cover wording');
    // Nothing stated, nothing counted: a missing fact is never a zero that is shown.
    const none = computeProtectionGapProjection({ ...base, scenarios: [{ id: 'today' }, base.scenarios[1] && { ...base.scenarios[1], received: undefined }] }).debug.cases[1];
    assertEqual(none.savingsAvailable, 60_000, 'no lump sum is added');
    assert(!none.sentence.includes('lump sum'), 'and none is mentioned');
  }));

  cases.push(runCase('Stated money received: a regular payment while someone cannot work counts for its months only', () => {
    const input = {
      ...PROTECTION_GAP_SAMPLE,
      scenarios: [{ id: 'today' }, {
        id: 'niamh-cannot-work',
        event: { type: 'cannotWork', personId: 'niamh', statePayment: 13_000 },
        received: [{ type: 'regularPayment', amount: 24_000, months: 6 }]
      }]
    };
    const entry = computeProtectionGapProjection(input).debug.cases[1];
    assertEqual(entry.segments.map((segment) => segment.id).join(','), 'floor,paid,niamh,dara', 'a slot for the payment, in a fixed place');
    assertEqual(entry.segments[1].amount, 24_000, 'it is money in');
    assertEqual(entry.moneyIn, 82_000, 'at the start');
    assertEqual(entry.intervals.map((stretch) => `${stretch.start}:${stretch.moneyIn}`).join(' '), '0:82000 6:58000', 'and it stops after six months');
    assertWithin(entry.exactMonths, referenceMonths({ needed: 96_000, savings: 60_000, firstIn: 82_000, firstMonths: 6, laterIn: 58_000 }), 1e-6, 'savings against the reference');
    assert(entry.sentence.includes('A payment of €24,000 a year, as you told us, is counted for 6 months.'), entry.sentence);
    assert(entry.sentence.includes('After 6 months, the payment you told us about stops, and you would be €38,000 a year short.'), entry.sentence);
    // Every case in the module keeps the same slots.
    assertEqual(computeProtectionGapProjection(input).debug.cases[0].segments.length, 4, 'today has the slot too, at 0');
  }));

  cases.push(runCase('An income block is refused when it does not add up, is incomplete or mixes the two ways of giving a payment', () => {
    const fail = (mutate, expected, label) => {
      const input = withIllness();
      mutate(input.scenarios[1]);
      assertThrows(() => normalizeProtectionGapInputs(input), `${FIELD}.scenarios[1] (Niamh cannot work): ${expected}`, label);
    };
    fail((c) => { c.income.phases[0].householdNetIncome = 60_000; },
      'income.phases[0]: the take-home and the State payment add up to 56508, but the household’s net income is 60000. They must reconcile.', 'does not reconcile');
    fail((c) => { delete c.income.phases[0].householdNetIncome; },
      'income.phases[0]: an estimated income needs householdNetIncome from the shared tax engine, so its parts can be checked against it.', 'no household net income');
    fail((c) => { delete c.income.versions.taxRules; },
      'an estimated income needs income.versions.taxRules, the version of the tax rules it was calculated with.', 'no tax rules version');
    fail((c) => { c.event.statePayment = 1; },
      'the State payment is given in income.phases[].statePayment; do not give it in the event as well.', 'both ways');
    fail((c) => { c.income.phases[0].takeHome.niamh = 5; c.income.phases[0].householdNetIncome = 56_513; },
      'income.phases[0]: takeHome.niamh must be 0, because that take-home stops in this case.', 'the stopped take-home');
    fail((c) => { c.income.phases[0].statePayment.estimatedTax = 100; },
      'income.phases[0]: statePayment.amount (12508) is not the gross amount (13208) less the estimated tax (100).', 'gross less tax');
    fail((c) => { c.income.phases[0].statePayment.weeks = 40; },
      'income.phases[0]: statePayment.grossAmount (13208) is not the weekly rate (254) for 40 weeks.', 'weekly rate');
    fail((c) => { c.income.phases[0].statePayment.personId = 'dara'; },
      'income.phases[0]: the State payment is paid to the person who cannot work.', 'paid to the wrong person');
    fail((c) => { c.income.phases[1].months = 6; },
      'income.phases[1]: the last phase carries on, so it has no months.', 'a last phase with months');
    fail((c) => { c.income.phases[0].months = 0; },
      'income.phases[0]: months must be a whole number of months from 1 to 120.', 'zero months');
    fail((c) => { c.income.basis = 'guessed'; },
      'income.basis must be "stated" or "estimated".', 'basis');
    fail((c) => { c.income.phases.push(c.income.phases[1]); },
      'income.phases must list 1 or 2 phases.', 'three phases');
    fail((c) => { c.income.calculationYear = 26; },
      'income.calculationYear must be a whole year.', 'year');
    fail((c) => { delete c.income.phases[0].takeHome.dara; },
      'income.phases[0]: takeHome needs dara.', 'a missing person');
    fail((c) => { c.income.phases[0].statePayment = null; c.income.phases[0].householdNetIncome = 44_000; },
      'income needs the State payment in its first phase, even when it is 0.', 'an income-stops case with no payment given');
    fail((c) => { c.income.phases[0].statePayment.scheme = 'wage'; },
      'income.phases[0]: statePayment.scheme must be one of illnessBenefit, bereavedPartnerPension, stated.', 'scheme');
  }));

  cases.push(runCase('The hard limit holds inside an income block and in money received', () => {
    const forbidden = (mutate, label) => {
      const input = withIllness();
      mutate(input.scenarios[1]);
      let message = '';
      try { normalizeProtectionGapInputs(input); } catch (error) { message = error.message; }
      assert(/never a cover amount, a premium or a product\./.test(message), `${label}: ${message}`);
    };
    forbidden((c) => { c.income.coverAmount = 1; }, 'income');
    forbidden((c) => { c.income.phases[0].premium = 1; }, 'phase');
    forbidden((c) => { c.income.versions.provider = 'x'; }, 'versions');
    forbidden((c) => { c.income.phases[0].takeHome.policy = 1; }, 'take-home');
    forbidden((c) => { c.received = [{ type: 'lumpSum', amount: 1, insurer: 'x' }]; }, 'received');
    const calculated = withIllness();
    calculated.scenarios[1].income.gap = 5;
    assertThrows(() => normalizeProtectionGapInputs(calculated), `${FIELD}.scenarios[1].income.gap is not accepted. It is calculated.`, 'a typed gap in income');
    const badReceived = (received, expected, label) => {
      const input = { ...PROTECTION_GAP_SAMPLE, scenarios: [{ id: 'today' }, { id: 'd', event: { type: 'dies', personId: 'niamh', survivorsPension: 1 }, received }] };
      assertThrows(() => normalizeProtectionGapInputs(input), `${FIELD}.scenarios[1] (If Niamh died): ${expected}`, label);
    };
    badReceived([{ type: 'regularPayment', amount: 1, months: 3 }], 'received[0]: a regular payment is money paid while someone cannot work.', 'a regular payment on a death');
    badReceived([{ type: 'lumpSum', amount: 0 }], 'received[0]: amount must be a whole number of euros greater than 0.', 'a zero lump sum');
    badReceived([], 'received must list 1 to 3 payments.', 'an empty list');
    badReceived([{ type: 'lumpSum', amount: 1 }, { type: 'lumpSum', amount: 1 }, { type: 'lumpSum', amount: 1 }, { type: 'lumpSum', amount: 1 }], 'received must list 1 to 3 payments.', 'four payments');
    assertThrows(
      () => normalizeProtectionGapInputs({ ...PROTECTION_GAP_SAMPLE, scenarios: [{ id: 'today', received: [{ type: 'lumpSum', amount: 1 }] }] }),
      `${FIELD}.scenarios[0] (Today): money received belongs to a case with an event.`,
      'received on a case with no event'
    );
  }));

  cases.push(runCase('Normalising a recalculated case twice changes nothing', () => {
    const once = normalizeProtectionGapInputs(withIllness());
    const twice = normalizeProtectionGapInputs(JSON.parse(JSON.stringify(once)));
    assertEqual(JSON.stringify(twice), JSON.stringify(once), 'idempotent');
    assertEqual(once.scenarios[1].income.phases[1].months, null, 'the last phase has no months, written as null');
  }));

  cases.push(runCase('Words in a recalculated, received-money and survivor module: no banned phrase, and every amount separated', () => {
    const variants = [
      computeProtectionGapProjection(withIllness()),
      computeProtectionGapProjection(withIllness({}, { ...PROTECTION_GAP_SAMPLE, needed: 54_000 })),
      computeProtectionGapProjection({ ...PROTECTION_GAP_SAMPLE, scenarios: [{ id: 'today' }, {
        id: 'd', event: { type: 'dies', personId: 'niamh', survivorsPension: 13_500, neededAfter: 60_000, neededBecause: ['mortgageCleared'] },
        received: [{ type: 'lumpSum', amount: 100_000 }]
      }, { id: 'w', event: { type: 'cannotWork', personId: 'dara', statePayment: 0 }, received: [{ type: 'regularPayment', amount: 20_000, months: 6, afterMonths: 3 }] }] })
    ];
    variants.forEach((projection, index) => {
      clientFacingStrings(projection).forEach((text) => {
        assert(!bannedWording(text), `variant ${index + 1}: banned wording in "${text}"`);
        assert(!/€\d{4,}/.test(text), `variant ${index + 1}: amount without a thousands separator in "${text}"`);
      });
      projection.debug.cases.forEach((entry) => {
        [entry.savingsLead, entry.savingsLeadNarrow, entry.nothingText].forEach((text) => assert(!bannedWording(text), `variant ${index + 1}: banned wording in "${text}"`));
      });
    });
  }));

  cases.push(runCase('The summary opens with the recalculated wording when tax was recalculated', () => {
    assert(protectionGapSummaryHtml(computeProtectionGapProjection(withIllness())).includes('Tax is recalculated for each case, and State payments are shown after estimated tax.'), 'recalculated');
    assert(protectionGapSummaryHtml(sample()).includes('Take-home pay and State payments are as given.'), 'stated');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };

  if (failed > 0) {
    console.warn('[ProtectionGapTests] Completed with failures', summary);
  } else {
    console.info('[ProtectionGapTests] All tests passed', { total: summary.total, passed: summary.passed });
  }

  return summary;
}
