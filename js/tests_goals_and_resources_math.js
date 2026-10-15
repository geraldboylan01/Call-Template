import {
  PENSION_DEBUG_FIELDS_READ,
  computeGoalsAndResourcesProjection,
  getDefaultGoalsAndResourcesScenarioId,
  getGoalsAndResourcesCases,
  normalizeGoalsAndResourcesInputs
} from './goals_and_resources_math.js';
import { computePensionProjection } from './pension_math.js';
import { renderTaxDisclosures } from './planning/tax/disclosures.js';
import { resolveTaxRules } from './planning/tax/resolve.js';

/**
 * The illustrative household every figure in the brief is proved against.
 * Illustrative household, not real figures.
 */
export const GOALS_AND_RESOURCES_SAMPLE = Object.freeze({
  spareCash: 60_000,
  leftOverEachYear: 6_000,
  householdTaxStatus: 'married_or_civil_partners',
  mortgage: Object.freeze({
    currentBalance: 380_000,
    annualInterestRate: 0.04,
    startDateIso: '2026-11-01',
    remainingTermYears: 18,
    currentAge: 45,
    clearByAge: 60
  }),
  pensions: Object.freeze([
    Object.freeze({ id: 'niamh', title: 'Niamh', currentAge: 45, currentSalary: 90_000, currentPot: 100_000, personalPct: 0.05, employerPct: 0.05, includeStatePension: true }),
    Object.freeze({ id: 'dara', title: 'Dara', currentAge: 45, currentSalary: 60_000, currentPot: 40_000, personalPct: 0.04, employerPct: 0.04, includeStatePension: true })
  ]),
  retirement: Object.freeze({ retirementAge: 62, targetIncomeToday: 50_000 }),
  laterRetirement: Object.freeze({ retirementAge: 65, targetIncomeToday: 46_000 }),
  children: Object.freeze([
    Object.freeze({ id: 'child-1', title: 'First child', age: 10 }),
    Object.freeze({ id: 'child-2', title: 'Second child', age: 8 })
  ])
});

/** What the brief says the sample household shows, to the euro. */
export const GOALS_AND_RESOURCES_EXPECTED = Object.freeze({
  wholeMortgageLump: 45_974,
  wholeCollege: 59_635,
  extraGross: 15_442,
  extraRelief: 6_177,
  extraCost: 9_265,
  cases: Object.freeze([
    Object.freeze({ id: 'cash-stays', mortgageLump: 0, collegeLump: 0, needed: 20_062, shortfall: 14_062, life: 834_168, laterNeeded: 10_797, laterLife: 666_495 }),
    Object.freeze({ id: 'college-today', mortgageLump: 0, collegeLump: 59_635, needed: 13_346, shortfall: 7_346, life: 833_847, laterNeeded: 4_081, laterLife: 666_173 }),
    Object.freeze({ id: 'mortgage-all-cash', mortgageLump: 60_000, collegeLump: 0, needed: 14_736, shortfall: 8_736, life: 814_282, laterNeeded: 5_471, laterLife: 646_608 }),
    Object.freeze({ id: 'mortgage-then-college', mortgageLump: 45_974, collegeLump: 14_026, needed: 14_402, shortfall: 8_402, life: 818_855, laterNeeded: 5_137, laterLife: 651_181 })
  ])
});

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
    console.info(`[GoalsAndResourcesTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[GoalsAndResourcesTests] FAIL: ${name}\n    ${error.message}`);
    return { name, pass: false, error: error.message };
  }
}

const euro = (value) => Math.round(value);

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

function bannedWording(text) {
  return /we recommend|you should|best option|\bbest\b|\bideal\b|\boptimal\b|p\.a\.|Bank of Ireland|AIB\b|Permanent TSB|Revolut/i.test(text);
}

export function runGoalsAndResourcesTests() {
  const cases = [];
  let cached = null;
  const projection = () => {
    if (!cached) {
      cached = computeGoalsAndResourcesProjection(GOALS_AND_RESOURCES_SAMPLE, { includeHeadroom: true });
    }
    return cached;
  };

  cases.push(runCase('The sample household reproduces every figure in the brief to the euro', () => {
    const { debug } = projection();
    const expected = GOALS_AND_RESOURCES_EXPECTED;
    assertEqual(euro(debug.wholeMortgageLump), expected.wholeMortgageLump, 'whole mortgage lump');
    assertEqual(euro(debug.wholeCollege.requiredToday), expected.wholeCollege, 'whole college');
    assertEqual(euro(debug.retirement.base.yearlyExtra), expected.extraGross, 'extra paid in, gross');
    assertEqual(euro(debug.retirement.base.yearlyExtraTaxRelief), expected.extraRelief, 'income tax relief on it');
    assertEqual(euro(debug.retirement.base.yearlyExtraCost), expected.extraCost, 'what it costs after relief');
    assertEqual(debug.cases.length, 4, 'four cases');
    debug.cases.forEach((entry, index) => {
      const want = expected.cases[index];
      assertEqual(entry.id, want.id, `case ${index + 1} id`);
      assertEqual(euro(entry.mortgageLump), want.mortgageLump, `case ${index + 1} mortgage lump`);
      assertEqual(euro(entry.collegeLump), want.collegeLump, `case ${index + 1} college lump`);
      assertEqual(euro(entry.neededThisYear), want.needed, `case ${index + 1} needed this year`);
      assertEqual(euro(entry.shortfall), want.shortfall, `case ${index + 1} short by`);
      assertEqual(euro(entry.paidOutOverLife.total), want.life, `case ${index + 1} paid out over the life`);
      assertEqual(euro(entry.laterRetirement.neededThisYear), want.laterNeeded, `case ${index + 1} needed at the later option`);
      assertEqual(euro(entry.laterRetirement.paidOutOverLife.total), want.laterLife, `case ${index + 1} paid out at the later option`);
    });
  }));

  cases.push(runCase('Case 1 keeps the cash; the others are the most different uses, in order of how much they change', () => {
    const { debug } = projection();
    const [first, ...others] = debug.cases;
    assert(first.mortgageLump <= 0.5 && first.collegeLump <= 0.5, 'case 1 moves no cash');
    for (let i = 1; i < others.length; i += 1) {
      assert(others[i - 1].cashUsed <= others[i].cashUsed + 1e-9, 'cases are ordered by cash moved');
    }
    // The three chosen are the largest smallest gap, found by trying every triple.
    const distance = (a, b) => Math.hypot(a.mortgageLump - b.mortgageLump, a.collegeLump - b.collegeLump);
    const pool = debug.uses.filter((entry) => !(entry.mortgageLump <= 0.5 && entry.collegeLump <= 0.5));
    const smallest = (group) => {
      let value = Infinity;
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          value = Math.min(value, distance(group[i], group[j]));
        }
      }
      return value;
    };
    let best = 0;
    for (let a = 0; a < pool.length; a += 1) {
      for (let b = a + 1; b < pool.length; b += 1) {
        for (let c = b + 1; c < pool.length; c += 1) {
          best = Math.max(best, smallest([first, pool[a], pool[b], pool[c]]));
        }
      }
    }
    assertWithin(smallest(debug.cases), best, 1e-6, 'the chosen cases are the furthest apart');
  }));

  cases.push(runCase('Invariants: cash, measures and the ledger agree with each other', () => {
    const { debug } = projection();
    const spare = debug.inputs.spareCash;
    const leftOver = debug.inputs.leftOverEachYear;
    const lumps = new Set();
    debug.cases.forEach((entry) => {
      assert(entry.cashUsed <= spare + 0.01, `${entry.id}: no more cash than there is`);
      assert(entry.cashLeft >= -0.01, `${entry.id}: no negative cash left`);
      assertWithin(entry.cashUsed + entry.cashLeft, spare, 0.01, `${entry.id}: used plus left is the cash`);
      assertWithin(entry.ledger[0].total, entry.neededThisYear, 0.01, `${entry.id}: needed this year is ledger year 0`);
      assertWithin(entry.neededThisYear - leftOver, entry.shortfall > 0 ? entry.shortfall : -entry.spare, 0.01, `${entry.id}: short or spare, never both`);
      assert(!(entry.shortfall > 0 && entry.spare > 0), `${entry.id}: not both short and spare`);
      assertWithin(
        entry.paidOutOverLife.mortgage + entry.paidOutOverLife.college + entry.paidOutOverLife.retirement,
        entry.paidOutOverLife.total,
        0.01,
        `${entry.id}: the parts add up`
      );
      // The later option changes the pension lines and nothing else.
      assertWithin(entry.laterRetirement.paidOutOverLife.mortgage, entry.paidOutOverLife.mortgage, 0.01, `${entry.id}: mortgage unchanged at the later option`);
      assertWithin(entry.laterRetirement.paidOutOverLife.college, entry.paidOutOverLife.college, 0.01, `${entry.id}: college unchanged at the later option`);
      assertWithin(
        entry.laterRetirement.neededThisYear - entry.laterRetirement.pension.yearlyExtraCost,
        entry.neededThisYear - entry.pension.yearlyExtraCost,
        0.01,
        `${entry.id}: the later option moves only the pension line`
      );
      const key = `${Math.round(entry.mortgageLump / 1000)}/${Math.round(entry.collegeLump / 1000)}`;
      assert(!lumps.has(key), `${entry.id}: no two cases use the cash the same way`);
      lumps.add(key);
    });
    assertEqual(new Set(debug.cases.map((entry) => entry.id)).size, 4, 'stable, distinct case ids');
  }));

  cases.push(runCase('Goals are taken in the planning method order: each child by start date, the mortgage, retirement', () => {
    const { debug } = projection();
    debug.cases.forEach((entry) => {
      assertEqual(
        entry.states.map((goal) => goal.goal).join(','),
        'child-1,child-2,mortgage,retirement',
        `${entry.id}: order`
      );
    });
    // Case 1: €6,000 against college €3,603 then €3,113, then the mortgage.
    const first = debug.cases[0].states.map((goal) => goal.state).join(',');
    // Judged year by year: the mortgage and retirement get nothing this year, and
    // are met in later years once the colleges stop, so they are partly covered.
    assertEqual(first, 'covered,partly,partly,partly', 'case 1 states');
    assertEqual(debug.cases[1].states.map((goal) => goal.state).join(','), 'covered,covered,covered,partly', 'case 2 states');
    // A younger child's college comes after an older child's, whatever order they are listed in.
    const swapped = computeGoalsAndResourcesProjection({
      ...GOALS_AND_RESOURCES_SAMPLE,
      children: [GOALS_AND_RESOURCES_SAMPLE.children[1], GOALS_AND_RESOURCES_SAMPLE.children[0]]
    });
    assertEqual(
      swapped.debug.cases[0].states.map((goal) => goal.goal).join(','),
      'child-1,child-2,mortgage,retirement',
      'children are ordered by start date, not by the order listed'
    );
  }));

  cases.push(runCase('Pension money: the search is gross, the cost counts after income tax relief', () => {
    const base = projection().debug.retirement.base;
    assert(base.yearlyExtra > 0 && base.yearlyExtraTaxRelief > 0, 'there is an extra, and it gets relief');
    assertWithin(base.yearlyExtraCost, base.yearlyExtra - base.yearlyExtraTaxRelief, 0.01, 'cost is gross less relief');
    assert(base.yearlyExtraCost < base.yearlyExtra, 'the cost is below what goes in');
    assert(base.personalCostWithExtra < base.personalGrossWithExtra, 'over the life too');
    assertEqual(base.reachedCap, false, 'inside the relief limit');
    const later = projection().debug.retirement.later;
    assertEqual(later.onTrackAtToday, true, 'on track at the later option');
    assertEqual(later.yearlyExtra, 0, 'nothing extra at the later option');
    assertWithin(later.headroomYearly, 430, 5, 'headroom is reported, not counted');
  }));

  cases.push(runCase('Rejections carry the exact messages', () => {
    const base = GOALS_AND_RESOURCES_SAMPLE;
    const normalise = (patch) => () => normalizeGoalsAndResourcesInputs({ ...base, ...patch });
    const FIELD = 'generated.goalsAndResourcesInputs';

    assertThrows(
      normalise({ goalPriorities: ['college', 'mortgage', 'retirement'] }),
      `${FIELD}.goalPriorities is not accepted. Goals are taken in a fixed order: college, then the mortgage, then retirement.`,
      'goalPriorities'
    );
    assertThrows(
      normalise({ scenarios: [] }),
      `${FIELD}.scenarios is not accepted. Cases are derived from the household, not authored.`,
      'authored scenarios'
    );
    ['priceGrowthRate', 'savingsGrowthRate', 'inflationRate', 'dirtRate', 'growthRate', 'wageGrowthRate', 'educationRate'].forEach((key) => {
      assertThrows(
        normalise({ [key]: 0.03 }),
        `${FIELD}.${key} is not accepted. Rates are set centrally in the Planéir assumptions.`,
        key
      );
    });
    assertThrows(
      normalise({ pensions: [{ ...base.pensions[0], growthRate: 0.06 }] }),
      `${FIELD}.pensions[0].growthRate is not accepted. Rates are set centrally in the Planéir assumptions.`,
      'a rate on a person'
    );
    assertThrows(normalise({ spareCash: -1 }), `${FIELD}.spareCash must be a number, 0 or more.`, 'negative cash');
    assertThrows(normalise({ leftOverEachYear: undefined }), `${FIELD}.leftOverEachYear must be a number, 0 or more.`, 'no left over');
    assertThrows(normalise({ mortgage: undefined }), `${FIELD}.mortgage must be an object.`, 'no mortgage');
    assertThrows(
      normalise({ mortgage: { ...base.mortgage, clearByAge: 45 } }),
      `${FIELD}.mortgage.clearByAge must be a whole age later than 45.`,
      'cleared by today'
    );
    assertThrows(
      normalise({ pensions: [] }),
      `${FIELD}.pensions must be an array of one or two people.`,
      'nobody'
    );
    assertThrows(
      normalise({ pensions: [base.pensions[0], { ...base.pensions[1], id: 'niamh' }] }),
      `${FIELD}.pensions[1].id must be unique.`,
      'a duplicate person'
    );
    assertThrows(
      normalise({ children: [{ id: 'a', title: 'Teen', age: 18 }] }),
      `${FIELD}.children[0].age must be a whole age from 0 to 17, below the college start age of 18.`,
      'a child already at college'
    );
    assertThrows(
      normalise({ retirement: { retirementAge: 40, targetIncomeToday: 50_000 } }),
      `${FIELD}.retirement.retirementAge must be a whole age later than 45.`,
      'retiring before today'
    );
    assertThrows(
      normalise({ laterRetirement: { retirementAge: 65, targetIncomeToday: 0 } }),
      `${FIELD}.laterRetirement.targetIncomeToday must be greater than 0.`,
      'no target'
    );
  }));

  cases.push(runCase('The normaliser is idempotent and the cases are stable', () => {
    const once = normalizeGoalsAndResourcesInputs(GOALS_AND_RESOURCES_SAMPLE);
    const twice = normalizeGoalsAndResourcesInputs(once);
    assertEqual(JSON.stringify(twice), JSON.stringify(once), 'normalising twice');
    const ids = getGoalsAndResourcesCases(GOALS_AND_RESOURCES_SAMPLE).map((entry) => entry.id);
    assertEqual(ids.join(','), 'cash-stays,college-today,mortgage-all-cash,mortgage-then-college', 'case ids');
    assertEqual(getDefaultGoalsAndResourcesScenarioId(GOALS_AND_RESOURCES_SAMPLE), 'cash-stays', 'the default case');
    const again = computeGoalsAndResourcesProjection(GOALS_AND_RESOURCES_SAMPLE);
    assertEqual(
      JSON.stringify(again.outputsTable),
      JSON.stringify(projection().outputsTable),
      'the same payload, the same answer'
    );
  }));

  cases.push(runCase('Everything on screen is in "you", with no banned phrase, provider name or "p.a."', () => {
    const result = projection();
    const text = collectStrings({
      assumptionsTable: result.assumptionsTable,
      outputsTable: result.outputsTable,
      tables: result.tables,
      charts: result.charts,
      words: result.debug.cases.map((entry) => entry.words),
      states: result.debug.cases.map((entry) => entry.states.map((goal) => [goal.title, goal.stateWord]))
    });
    text.forEach((entry) => assert(!bannedWording(entry), `banned wording in "${entry}"`));
    result.debug.cases.forEach((entry) => {
      assert(/\byou\b|\byour\b|you’re/i.test(entry.words.headline), `${entry.id}: headline is in "you"`);
      assert(/\byour\b/i.test(entry.words.support), `${entry.id}: support is in "you"`);
      assert(/your cash/i.test(entry.words.amountLine), `${entry.id}: amount line is in "you"`);
    });
    const pensionLine = result.assumptionsTable.rows.find((row) => row[0] === 'Pension money');
    assert(pensionLine && /after income tax relief/.test(pensionLine[1]), 'the assumptions table says how pension money counts');
    const orderLine = result.assumptionsTable.rows.find((row) => row[0] === 'Order of your goals');
    assert(orderLine && /soonest, then your mortgage, then retirement/.test(orderLine[1]), 'the assumptions table says the order');
  }));

  cases.push(runCase('A mortgage that already ends by the goal\'s age is covered with nothing needed', () => {
    const result = computeGoalsAndResourcesProjection({
      ...GOALS_AND_RESOURCES_SAMPLE,
      mortgage: { ...GOALS_AND_RESOURCES_SAMPLE.mortgage, clearByAge: 70 }
    });
    const { debug } = result;
    assertEqual(debug.mortgageAlreadyEnds, true, 'flagged');
    assert(debug.cases.length >= 1 && debug.cases.length < 4, 'fewer than four cases is fine');
    debug.cases.forEach((entry) => {
      assertEqual(entry.mortgageLump, 0, `${entry.id}: no cash into the mortgage`);
      assertEqual(entry.mortgage.yearlyChange, 0, `${entry.id}: no yearly change`);
      assertEqual(entry.states.find((goal) => goal.goal === 'mortgage').state, 'covered', `${entry.id}: covered`);
      assertEqual(entry.words.mortgageNote, 'Your mortgage already ends by 70.', `${entry.id}: the sentence`);
    });
    assertEqual(debug.cases.map((entry) => entry.id).join(','), 'cash-stays,college-today', 'the uses collapse into the others');
    assert(
      result.assumptionsTable.rows.some((row) => row[0] === 'Your mortgage' && /already ends by 70/.test(row[1])),
      'the assumptions table says so'
    );
    assertThrows(
      () => normalizeGoalsAndResourcesInputs({
        ...GOALS_AND_RESOURCES_SAMPLE,
        mortgage: { ...GOALS_AND_RESOURCES_SAMPLE.mortgage, clearByAge: 45 }
      }),
      'generated.goalsAndResourcesInputs.mortgage.clearByAge must be a whole age later than 45.',
      'only an age at or below today is rejected'
    );
  }));

  // ---- the three engine issues found in review of PR #58, and the relief-limit notes

  const withoutLater = (raw) => {
    const copy = { ...raw };
    delete copy.laterRetirement;
    return copy;
  };
  const closesAt = (raw, target, extraPoints) => computePensionProjection({
    currentYear: 2026,
    incomeMode: 'target',
    targetIncomeToday: target.targetIncomeToday,
    targetIncomeBasis: 'net',
    householdTaxStatus: raw.householdTaxStatus,
    pensions: raw.pensions.map((person) => ({
      ...person,
      retirementAge: target.retirementAge,
      personalPct: Math.max(0, person.personalPct + extraPoints)
    }))
  }).debug.currentGapVsRequired === 0;

  /** One person already at today's limit (25% at 49) who will reach the 30%, 35% and 40% bands. */
  const atTodaysLimit = withoutLater({
    ...GOALS_AND_RESOURCES_SAMPLE,
    householdTaxStatus: 'single',
    mortgage: { ...GOALS_AND_RESOURCES_SAMPLE.mortgage, currentAge: 49, clearByAge: 60 },
    pensions: [{
      id: 'sean', title: 'Sean', currentAge: 49, currentSalary: 100_000, currentPot: 150_000,
      personalPct: 0.25, employerPct: 0.05, includeStatePension: true
    }],
    retirement: { retirementAge: 65, targetIncomeToday: 40_000 },
    children: [GOALS_AND_RESOURCES_SAMPLE.children[0]]
  });

  cases.push(runCase('The relief-limit search counts the age bands a person reaches before retiring', () => {
    const { base } = computeGoalsAndResourcesProjection(atTodaysLimit).debug.retirement;
    assertEqual(base.onTrackAtToday, false, 'today\'s contributions do not close it');
    assertEqual(base.reachedCap, false, 'a later, higher band helps, so the limit is not reached');
    assert(base.extraPoints > 0, `the search found an extra (${base.extraPoints})`);
    assertEqual(base.gapLeftOver, 0, 'no gap is left');
    assert(closesAt(atTodaysLimit, atTodaysLimit.retirement, base.extraPoints), 'the retirement module agrees it closes');
    // Room is the 40% band at the last working age (64) less the 25% paid in.
    assertWithin(base.capPointsAvailable, 0.15, 1e-9, 'the ceiling is from the whole schedule');
    assertEqual(base.disclosures.length, 0, 'and there is nothing to say about money beyond the limit');
  }));

  cases.push(runCase('Two people: one at the limit today does not stop the other\'s room from being used', () => {
    const couple = withoutLater({
      ...GOALS_AND_RESOURCES_SAMPLE,
      householdTaxStatus: 'married_or_civil_partners',
      mortgage: { ...GOALS_AND_RESOURCES_SAMPLE.mortgage, currentAge: 49, clearByAge: 60 },
      pensions: [
        atTodaysLimit.pensions[0],
        { id: 'una', title: 'Una', currentAge: 40, currentSalary: 70_000, currentPot: 60_000, personalPct: 0.06, employerPct: 0.05, includeStatePension: true }
      ],
      retirement: { retirementAge: 65, targetIncomeToday: 60_000 },
      children: [GOALS_AND_RESOURCES_SAMPLE.children[0]]
    });
    const { base } = computeGoalsAndResourcesProjection(couple).debug.retirement;
    assertEqual(base.reachedCap, false, 'not at the limit: Una can pay in more');
    assert(closesAt(couple, couple.retirement, base.extraPoints), 'and it closes');
    // The most that helps is the larger of the two people's room: Una at 59
    // gets the 40% band, 34 points more than her 6%.
    assertWithin(base.capPointsAvailable, 0.34, 1e-9, 'the ceiling is the larger headroom');
  }));

  cases.push(runCase('The limit is still reported when no later band helps', () => {
    const atTheTop = withoutLater({
      ...atTodaysLimit,
      mortgage: { ...atTodaysLimit.mortgage, currentAge: 61, clearByAge: 70 },
      pensions: [{ ...atTodaysLimit.pensions[0], currentAge: 61, personalPct: 0.4 }],
      retirement: { retirementAge: 65, targetIncomeToday: 90_000 }
    });
    const { base } = computeGoalsAndResourcesProjection(atTheTop).debug.retirement;
    assertEqual(base.reachedCap, true, 'already at the highest band');
    assert(base.gapLeftOver > 0, 'a gap is left');
    assertEqual(base.extraPoints, 0, 'nothing more can be paid in with relief');
    assertEqual(base.disclosures.length, 4, 'and the notes are raised');
  }));

  const later = {
    ...GOALS_AND_RESOURCES_SAMPLE,
    mortgage: { ...GOALS_AND_RESOURCES_SAMPLE.mortgage, currentAge: 45, clearByAge: 50 },
    retirement: { retirementAge: 65, targetIncomeToday: 50_000 },
    // A later target that still needs an extra, so its years carry a cost.
    laterRetirement: { retirementAge: 67, targetIncomeToday: 56_000 },
    children: [{ id: 'child-1', title: 'First child', age: 1 }]
  };

  cases.push(runCase('The ledger runs to the last active goal, the later retirement option included', () => {
    const { cases: result } = computeGoalsAndResourcesProjection(later).debug;
    // Mortgage 5 years, college starts in 17, retirement 20 years, the later option 22.
    result.forEach((entry) => {
      assertEqual(entry.ledger.length, 22, `${entry.id}: the ledger`);
      assertEqual(entry.laterRetirement.ledger.length, 22, `${entry.id}: the later option's ledger`);
      assertEqual(entry.ledger[4].mortgage, entry.mortgage.yearlyChange, `${entry.id}: the mortgage is in its last year`);
      assertEqual(entry.ledger[5].mortgage, 0, `${entry.id}: nothing for the mortgage once it is cleared`);
      assert(entry.ledger[16].children[0] === entry.ledger[0].children[0], `${entry.id}: college is saved for through year 16`);
      assertEqual(entry.ledger[17].children[0], 0, `${entry.id}: and not after its start`);
      assert(entry.ledger[19].pension > 0, `${entry.id}: retirement saving runs to year 19`);
      assertEqual(entry.ledger[20].pension, 0, `${entry.id}: and stops when it ends`);
      assert(entry.laterRetirement.ledger[20].pension > 0, `${entry.id}: the later option still saves in year 20`);
      assert(entry.laterRetirement.ledger[21].pension > 0, `${entry.id}: and in its last year, 21`);
    });
    // The tables carry the same rows.
    const table = computeGoalsAndResourcesProjection(later).tables[0];
    assertEqual(table.rows.length, 22, 'the "what you need each year" table');
  }));

  cases.push(runCase('Coverage is judged year by year, not on this year\'s cost', () => {
    // Left over of €14,500: this year the retirement saving fits, and it rises
    // with wage growth while the left over does not.
    const raw = { ...GOALS_AND_RESOURCES_SAMPLE, leftOverEachYear: 14_500 };
    const result = computeGoalsAndResourcesProjection(raw).debug.cases;
    const entry = result.find((candidate) => candidate.id === 'mortgage-then-college');
    const retirement = entry.states.find((goal) => goal.goal === 'retirement');
    assert(entry.ledger[0].difference < 0.5, 'this year, everything fits');
    assertEqual(retirement.covered >= retirement.need - 0.5, true, 'this year\'s retirement saving is covered');
    assertEqual(retirement.state, 'partly', 'but it is not covered over the years');
    const firstShort = entry.ledger.findIndex((row) => row.difference > 0.5);
    assert(firstShort >= 1, 'the money runs short after this year');
    assertEqual(retirement.firstShortYear, firstShort, 'and it says which year');

    // With more left over than any year needs, it is covered in every year.
    const plenty = computeGoalsAndResourcesProjection({ ...GOALS_AND_RESOURCES_SAMPLE, leftOverEachYear: 40_000 }).debug.cases;
    plenty.forEach((candidate) => {
      candidate.states.forEach((goal) => {
        assertEqual(goal.state, 'covered', `${candidate.id}: ${goal.goal} covered`);
        assertEqual(goal.firstShortYear, null, `${candidate.id}: ${goal.goal} is never short`);
      });
    });

    // With nothing left over, nothing is covered in any year.
    const none = computeGoalsAndResourcesProjection({ ...GOALS_AND_RESOURCES_SAMPLE, leftOverEachYear: 0 }).debug.cases[0];
    assertEqual(none.states.map((goal) => goal.state).join(','), 'not,not,not,not', 'nothing covered');
    assertEqual(none.states.every((goal) => goal.firstShortYear === 0), true, 'short from this year');

    // And a goal that gets money only in later years is partly covered, not "not covered".
    const sample = projection().debug.cases[0];
    assertEqual(sample.states[2].state, 'partly', 'the mortgage gets nothing now and is met once college saving ends');
    assertEqual(sample.states[2].firstShortYear, 0, 'short from this year');
  }));

  cases.push(runCase('At the relief limit with the target out of reach, the notes beside an after-tax investment are carried', () => {
    const raw = { ...GOALS_AND_RESOURCES_SAMPLE, retirement: { retirementAge: 62, targetIncomeToday: 200_000 } };
    const { debug } = computeGoalsAndResourcesProjection(raw);
    const { base } = debug.retirement;
    assertEqual(base.reachedCap, true, 'at the limit');
    assertEqual(
      base.disclosures.map((entry) => entry.code).join(','),
      'PENSION_AT_RELIEF_LIMIT,INVESTMENT_FUND_TAX,INVESTMENT_FUND_TAX_ANNOUNCED,INVESTMENT_ACCOUNT',
      'the four notes'
    );
    assertEqual(debug.calculationDateIso, '2026-11-01', 'raised as of the calculation date');
    assertEqual(debug.taxRulesYear, 2026, 'with the rules for its year');
    const texts = renderTaxDisclosures(base.disclosures, { rules: resolveTaxRules(debug.taxRulesYear) }).map((entry) => entry.text);
    assertEqual(
      texts[0],
      'Your pension contributions are at the most income tax relief allows at your age, 25% of earnings up to €115,000. '
      + 'Money you invest beyond that gets no income tax relief.',
      'the limit note carries the figures when both people share one limit'
    );
    assertEqual(texts.length, 4, 'four rendered notes');
    // Every case carries the same notes, and the screen can take them from any.
    debug.cases.forEach((entry) => {
      assertEqual(entry.pension.disclosures.length, 4, `${entry.id}: notes`);
    });

    // Two different limits: the note says no figure rather than the wrong one.
    const differing = computeGoalsAndResourcesProjection({
      ...raw,
      pensions: [raw.pensions[0], { ...raw.pensions[1], currentAge: 55 }]
    }).debug.retirement.base.disclosures;
    assertEqual(differing[0].params, null, 'no figures when the two limits differ');
    assertEqual(
      renderTaxDisclosures(differing, { rules: resolveTaxRules(2026) })[0].text,
      'Your pension contributions are at the most income tax relief allows at your age. Money you invest beyond that gets no income tax relief.',
      'and the note reads without them'
    );

    // The target is met: none.
    const met = computeGoalsAndResourcesProjection(GOALS_AND_RESOURCES_SAMPLE).debug;
    assertEqual(met.retirement.base.reachedCap, false, 'the sample is inside the limit');
    assertEqual(met.retirement.base.disclosures.length, 0, 'no notes when the target is met');
    assertEqual(met.retirement.later.disclosures.length, 0, 'nor for the later option');
  }));

  cases.push(runCase('The retirement module still returns every field the search reads, as a number', () => {
    const payload = {
      currentYear: 2026,
      incomeMode: 'target',
      targetIncomeToday: 50_000,
      targetIncomeBasis: 'net',
      householdTaxStatus: 'married_or_civil_partners',
      pensions: GOALS_AND_RESOURCES_SAMPLE.pensions.map((person) => ({ ...person, retirementAge: 62 }))
    };
    const { debug } = computePensionProjection(payload);
    PENSION_DEBUG_FIELDS_READ.forEach((key) => {
      assert(
        typeof debug[key] === 'number' && Number.isFinite(debug[key]),
        `computePensionProjection no longer returns debug.${key} as a number (got ${typeof debug[key]}). `
        + 'The goals and resources search reads it. Update js/goals_and_resources_math.js to match the retirement module.'
      );
    });
    assertEqual(PENSION_DEBUG_FIELDS_READ.join(','), 'requiredPot,projectedPotCurrent,requiredPotDepletionTolerance', 'the three fields, no more');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };

  if (failed > 0) {
    console.warn('[GoalsAndResourcesTests] Completed with failures', summary);
  } else {
    console.info('[GoalsAndResourcesTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
