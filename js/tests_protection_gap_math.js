import {
  PROTECTION_GAP_HORIZON_MONTHS,
  computeProtectionGapProjection,
  getDefaultProtectionGapScenarioId,
  getProtectionGapCases,
  normalizeProtectionGapInputs
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
    + 'State payments are as given and depend on each person’s PRSI record. '
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
    assertThrows(run(make({ scenarios: [{ id: 'a', event: { type: 'cannotWork', personId: 'niamh', statePayment: 0 } }] })),
      `${FIELD}.scenarios[0] (Niamh cannot work): statePayment must be a whole number of euros greater than 0.`, 'no State payment');
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
    const based = { ...PROTECTION_GAP_SAMPLE, baseScenarioId: 'dara-cannot-work' };
    assertEqual(getDefaultProtectionGapScenarioId(based), 'dara-cannot-work', 'a stated base');
    assertEqual(computeProtectionGapProjection(based).debug.baseScenarioId, 'dara-cannot-work', 'base in the projection');
    const titled = computeProtectionGapProjection({
      ...PROTECTION_GAP_SAMPLE,
      scenarios: [{ id: 'a', title: 'Your own title', description: 'One line.' }]
    }).debug.cases[0];
    assertEqual(titled.title, 'Your own title', 'a stated title wins');
    assertEqual(titled.description, 'One line.', 'description kept');
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
