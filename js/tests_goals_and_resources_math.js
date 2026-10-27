import {
  PENSION_DEBUG_FIELDS_READ,
  computeGoalsAndResourcesProjection,
  getDefaultGoalsAndResourcesScenarioId,
  getGoalsAndResourcesCases,
  normalizeGoalsAndResourcesInputs,
  projectGoalsAndResources
} from './goals_and_resources_math.js';
import {
  PENSION_EARNINGS_CAP,
  computePensionProjection,
  computePersonalContributionCosts,
  maxRelievableContributionRatePercent,
  normalizePensionInputs
} from './pension_math.js';
import { renderTaxDisclosures } from './planning/tax/disclosures.js';
import { DEFAULT_IE_TAX_CATALOGUE, resolveTaxRules, withTaxCatalogue } from './planning/tax/resolve.js';

/**
 * The tax rules the brief's figures and the approved frames were drawn on: 2026,
 * held forward, as the catalogue stood before Budget 2027 added its block. The
 * four goals suites run their design fixture on these, so a screen's approved
 * example does not change with every Budget. The engine's figures on the rules in
 * force now are tested separately, below, and recorded in the register's
 * catch-up. The engine takes no catalogue option for its pension years, so the
 * resolver's test hook stands these rules in for the run.
 */
const GOALS_DESIGN_TAX_CATALOGUE = Object.freeze({
  ...DEFAULT_IE_TAX_CATALOGUE,
  rulesByYear: Object.freeze({ 2026: DEFAULT_IE_TAX_CATALOGUE.rulesByYear[2026] })
});

/** Runs `fn`, or the promise it returns, on the rules the design was drawn on. */
export function withDesignTaxRules(fn) {
  return withTaxCatalogue(GOALS_DESIGN_TAX_CATALOGUE, fn);
}

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
  return withDesignTaxRules(runGoalsAndResourcesTestsOnDesignRules);
}

function runGoalsAndResourcesTestsOnDesignRules() {
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

  cases.push(runCase('On the rules in force now, Budget 2027 lowers what the retirement goal needs and moves nothing that does not depend on income tax', () => {
    // The suite runs on the design rules. Ask for the built-in catalogue, which carries the announced 2027 block,
    // and compare. These figures are what the engine gives now; the audit script proves it against an independent
    // reference on the same rules (the answer closes the gap, a hundredth of a point less does not).
    const now = withTaxCatalogue(DEFAULT_IE_TAX_CATALOGUE, () => computeGoalsAndResourcesProjection(GOALS_AND_RESOURCES_SAMPLE, { includeHeadroom: true })).debug;
    const design = GOALS_AND_RESOURCES_EXPECTED;
    assertEqual(euro(now.wholeMortgageLump), design.wholeMortgageLump, 'whole mortgage lump is unchanged');
    assertEqual(euro(now.wholeCollege.requiredToday), design.wholeCollege, 'whole college is unchanged');
    assertEqual(euro(now.retirement.base.yearlyExtra), 14_294, 'extra paid in, gross (15,442 on the 2026 rules)');
    assertEqual(euro(now.retirement.base.yearlyExtraTaxRelief), 5_717, 'relief on it (6,177)');
    assertEqual(euro(now.retirement.base.yearlyExtraCost), 8_576, 'what it costs after relief (9,265)');
    const moved = [
      { id: 'cash-stays', needed: 19_373, life: 820_382 },
      { id: 'college-today', needed: 12_657, life: 820_060 },
      { id: 'mortgage-all-cash', needed: 14_048, life: 800_495 },
      { id: 'mortgage-then-college', needed: 13_713, life: 805_069 }
    ];
    now.cases.forEach((entry, index) => {
      const want = moved[index];
      assertEqual(entry.id, want.id, `case ${index + 1} id`);
      assertEqual(euro(entry.neededThisYear), want.needed, `${want.id}: needed this year (${design.cases[index].needed} on the 2026 rules)`);
      assertEqual(euro(entry.paidOutOverLife.total), want.life, `${want.id}: paid out over the life (${design.cases[index].life})`);
      assert(entry.neededThisYear < design.cases[index].needed, `${want.id}: less is needed than on the 2026 rules`);
      assertEqual(euro(entry.mortgageLump), design.cases[index].mortgageLump, `${want.id}: mortgage lump is unchanged`);
      assertEqual(euro(entry.collegeLump), design.cases[index].collegeLump, `${want.id}: college lump is unchanged`);
      assertEqual(euro(entry.laterRetirement.neededThisYear), design.cases[index].laterNeeded, `${want.id}: the later option is already on track, so unchanged`);
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

  cases.push(runCase('The cached projection is the same answer, keyed by payload, and options bypass it', () => {
    const first = projectGoalsAndResources(GOALS_AND_RESOURCES_SAMPLE);
    const again = projectGoalsAndResources({ ...GOALS_AND_RESOURCES_SAMPLE });
    assert(first === again, 'an equal payload is served the kept projection');
    assertEqual(
      JSON.stringify(first.debug.cases.map((entry) => Math.round(entry.neededThisYear))),
      JSON.stringify(computeGoalsAndResourcesProjection(GOALS_AND_RESOURCES_SAMPLE).debug.cases.map((entry) => Math.round(entry.neededThisYear))),
      'and it is the answer the engine gives'
    );

    const other = projectGoalsAndResources({ ...GOALS_AND_RESOURCES_SAMPLE, leftOverEachYear: 7_000 });
    assert(other !== first, 'a different payload is a different projection');
    assertEqual(other.debug.inputs.leftOverEachYear, 7_000, 'and it reflects the change');

    // Options are never cached and never served from the cache.
    const withOptions = projectGoalsAndResources(GOALS_AND_RESOURCES_SAMPLE, { includeHeadroom: true });
    assert(withOptions !== first, 'a call with options is computed afresh');
    assert(projectGoalsAndResources(GOALS_AND_RESOURCES_SAMPLE) === first, 'and does not displace the kept one');

    // The cache is bounded: older payloads fall out, the answers stay right.
    for (let extra = 0; extra < 8; extra += 1) {
      projectGoalsAndResources({ ...GOALS_AND_RESOURCES_SAMPLE, leftOverEachYear: 8_000 + extra });
    }
    const rebuilt = projectGoalsAndResources(GOALS_AND_RESOURCES_SAMPLE);
    assertEqual(
      Math.round(rebuilt.debug.cases[0].neededThisYear),
      Math.round(first.debug.cases[0].neededThisYear),
      'a payload that fell out of the cache is recomputed to the same figure'
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
        `${FIELD}.${key} is not accepted. Rates are set centrally in the Planeir assumptions.`,
        key
      );
    });
    assertThrows(
      normalise({ pensions: [{ ...base.pensions[0], growthRate: 0.06 }] }),
      `${FIELD}.pensions[0].growthRate is not accepted. Rates are set centrally in the Planeir assumptions.`,
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
      assert(
        /^Nothing from your cash$|^€[\d,]+ into the (mortgage|college fund)$|^€[\d,]+, then €[\d,]+$/.test(entry.words.amountLine),
        `${entry.id}: the amount line is one of the agreed shapes (${entry.words.amountLine})`
      );
    });
    const pensionLine = result.assumptionsTable.rows.find((row) => row[0] === 'Pension money');
    assert(pensionLine && /after income tax relief/.test(pensionLine[1]), 'the assumptions table says how pension money counts');
    const orderLine = result.assumptionsTable.rows.find((row) => row[0] === 'Order of your goals');
    assert(orderLine && /soonest, then your mortgage, then retirement/.test(orderLine[1]), 'the assumptions table says the order');
  }));

  cases.push(runCase('The words are the engine\'s alone: the amount line, the headline, the support and the later line', () => {
    const result = projection();
    const lines = result.debug.cases.map((entry) => entry.words.amountLine);
    assertEqual(
      lines.join(' | '),
      'Nothing from your cash | €59,635 into the college fund | €60,000 into the mortgage | €45,974, then €14,026',
      'the amount lines are the frames\' wording'
    );
    assertEqual(
      getGoalsAndResourcesCases(GOALS_AND_RESOURCES_SAMPLE).map((entry) => entry.description).join(' | '),
      lines.join(' | '),
      'the presenter\'s case list carries the same strings'
    );
    // Two lumps read in the order they are taken: the mortgage first (the sample's
    // fourth case, above), except where the college is filled first.
    const older = computeGoalsAndResourcesProjection({
      ...GOALS_AND_RESOURCES_SAMPLE,
      spareCash: 50_000,
      mortgage: { ...GOALS_AND_RESOURCES_SAMPLE.mortgage, currentBalance: 450_000 },
      children: [
        { ...GOALS_AND_RESOURCES_SAMPLE.children[0], age: 17 },
        { ...GOALS_AND_RESOURCES_SAMPLE.children[1], age: 15 }
      ]
    }).debug.cases;
    const collegeFirst = older.find((entry) => entry.words.id === 'college-then-mortgage');
    assert(collegeFirst, 'this household has a case that fills college first');
    assertEqual(collegeFirst.words.amountLine, '€45,745, then €4,255', 'college first, then the mortgage');
    assertEqual(Math.round(collegeFirst.collegeLump), 45_745, 'and the first amount is the college lump');

    // Short: every case of the sample.
    result.debug.cases.forEach((entry) => {
      assertEqual(entry.words.state, 'short', `${entry.id}: short`);
      assert(/^You’re short by €[\d,]+ a year$/.test(entry.words.headline), `${entry.id}: the short headline`);
    });
    assertEqual(result.debug.cases[0].laterRetirement.words.result, 'still short by €4,797', 'later: short');
    assertEqual(result.debug.cases[1].laterRetirement.words.result, '€1,919 to spare', 'later: to spare');
    assertEqual(result.debug.cases[0].laterRetirement.words.label, 'If you retire at 65 on €46,000', 'the later label');
    assertEqual(result.debug.cases[0].laterRetirement.words.neededLine, '€10,797 needed this year', 'the later needed line');

    // Spare, with every goal covered: "to spare".
    const spare = computeGoalsAndResourcesProjection({ ...GOALS_AND_RESOURCES_SAMPLE, leftOverEachYear: 26_000 });
    spare.debug.cases.forEach((entry) => {
      assertEqual(entry.words.state, 'spare', `${entry.id}: spare`);
      assert(/^You have €[\d,]+ a year to spare$/.test(entry.words.headline), `${entry.id}: "to spare"`);
      assert(entry.states.every((goal) => goal.state === 'covered'), `${entry.id}: every goal is covered`);
    });

    // Left over with a goal still not met (the relief limit): never "to spare".
    const atTheLimit = computeGoalsAndResourcesProjection({
      ...GOALS_AND_RESOURCES_SAMPLE,
      leftOverEachYear: 30_000,
      retirement: { retirementAge: 55, targetIncomeToday: 200_000 }
    });
    atTheLimit.debug.cases.forEach((entry) => {
      assertEqual(entry.words.state, 'left', `${entry.id}: left over`);
      assert(/^You have €[\d,]+ a year left over$/.test(entry.words.headline), `${entry.id}: the headline (${entry.words.headline})`);
      assertEqual(
        entry.words.support,
        'Your retirement target is not met, even at the most income tax relief allows.',
        `${entry.id}: the support line`
      );
      assert(entry.spare > 0.5, `${entry.id}: there is money left over`);
      assert(!/to spare/.test(`${entry.words.headline} ${entry.words.support}`), `${entry.id}: not "to spare"`);
    });

    // The later option follows the same rule: its own target out of reach at the limit.
    const laterAtTheLimit = computeGoalsAndResourcesProjection({
      ...GOALS_AND_RESOURCES_SAMPLE,
      leftOverEachYear: 30_000,
      laterRetirement: { retirementAge: 58, targetIncomeToday: 200_000 }
    });
    laterAtTheLimit.debug.cases.forEach((entry) => {
      assertEqual(entry.laterRetirement.words.state, 'left', `${entry.id}: the later option is left over`);
      assert(/^€[\d,]+ left over$/.test(entry.laterRetirement.words.result), `${entry.id}: later result (${entry.laterRetirement.words.result})`);
    });

    // And a case that is short at the limit is still short: the rule is not hidden by the cap.
    const shortAtTheLimit = computeGoalsAndResourcesProjection({
      ...GOALS_AND_RESOURCES_SAMPLE,
      retirement: { retirementAge: 55, targetIncomeToday: 200_000 }
    });
    shortAtTheLimit.debug.cases.forEach((entry) => {
      assertEqual(entry.words.state, 'short', `${entry.id}: short at the limit`);
    });
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

  /**
   * The relief ceiling, worked out here from the pension rules and not from the
   * engine: each working year's relievable euro amount (the age band's share of
   * the salary, up to the earnings cap) as a share of that year's salary, less
   * what is paid in; the largest over the years, then over the people.
   */
  const expectedCeiling = (pensions, retirementAge) => {
    const members = normalizePensionInputs({
      currentYear: 2026,
      incomeMode: 'target',
      targetIncomeToday: 1,
      targetIncomeBasis: 'net',
      householdTaxStatus: pensions.length > 1 ? 'married_or_civil_partners' : 'single',
      pensions: pensions.map((entry) => ({ ...entry, retirementAge }))
    }).pensions;
    return Math.max(...members.map((member) => {
      let room = 0;
      for (let year = 0; year < retirementAge - member.currentAge; year += 1) {
        const salary = member.currentSalary * (1 + member.wageGrowthRate) ** year;
        const share = (maxRelievableContributionRatePercent(member.currentAge + year) / 100)
          * Math.min(salary, PENSION_EARNINGS_CAP) / salary;
        room = Math.max(room, share - member.personalPct);
      }
      return room;
    }));
  };

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
    // Room is the best year's relievable share of salary less the 25% paid in:
    // the 40% band from 60, over a salary that has grown past the €115,000 cap.
    assertWithin(base.capPointsAvailable, expectedCeiling(atTodaysLimit.pensions, 65), 1e-9, 'the ceiling is from the whole schedule');
    assert(base.capPointsAvailable > 0.05, 'later bands do add room beyond today\'s nothing');
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
    // The most that helps is the larger of the two people's room: Una, still
    // under the cap, reaches the 40% band at 60, 34 points more than her 6%.
    assertWithin(base.capPointsAvailable, expectedCeiling(couple.pensions, 65), 1e-9, 'the ceiling is the larger headroom');
    assertWithin(base.capPointsAvailable, 0.34, 1e-9, 'which is Una\'s 34 points');
  }));

  cases.push(runCase('The relief ceiling counts the earnings cap: points above it change nothing and are not offered', () => {
    // €230,000 is above the €115,000 earnings cap, so relief is the age band's
    // share of €115,000, not of the salary: at 45 that is €28,750, which is
    // 12.5% of €230,000, so 7.5 points on the 5% paid in, not the 20 the band
    // alone suggests. Later bands raise it, and wage growth lowers it as a
    // share of a rising salary.
    const highEarner = withoutLater({
      ...atTodaysLimit,
      mortgage: { ...atTodaysLimit.mortgage, currentAge: 45, clearByAge: 60 },
      pensions: [{
        id: 'ciara', title: 'Ciara', currentAge: 45, currentSalary: 230_000, currentPot: 300_000,
        personalPct: 0.05, employerPct: 0.05, includeStatePension: true
      }],
      retirement: { retirementAge: 65, targetIncomeToday: 200_000 }
    });
    const { base } = computeGoalsAndResourcesProjection(highEarner).debug.retirement;
    assertEqual(base.reachedCap, true, 'a target this size is out of reach at the limit');

    const expected = expectedCeiling(highEarner.pensions, 65);
    assertWithin(base.capPointsAvailable, expected, 1e-9, 'the ceiling is from each year\'s salary and the cap');
    assertEqual(base.extraPoints, base.capPointsAvailable, 'at the limit the points are the ceiling');
    assert(base.capPointsAvailable > 0.075, 'later bands do add room beyond this year\'s 7.5 points');
    assert(base.capPointsAvailable < 0.15, `and it is nowhere near the 35 points of the age band alone (${base.capPointsAvailable})`);

    // The properties that make it the ceiling: nothing above it changes anything,
    // and a little under it still does.
    const gapAt = (extra) => {
      const { debug } = computePensionProjection({
        currentYear: 2026,
        incomeMode: 'target',
        targetIncomeToday: highEarner.retirement.targetIncomeToday,
        targetIncomeBasis: 'net',
        householdTaxStatus: highEarner.householdTaxStatus,
        pensions: highEarner.pensions.map((entry) => ({
          ...entry,
          retirementAge: 65,
          personalPct: entry.personalPct + extra
        }))
      });
      return debug.requiredPot - debug.projectedPotCurrent;
    };
    assertWithin(gapAt(base.capPointsAvailable + 0.05), gapAt(base.capPointsAvailable), 1e-6, 'points above it change nothing');
    assert(gapAt(base.capPointsAvailable - 0.005) > gapAt(base.capPointsAvailable) + 1, 'points just under it still do');

    // The euro amounts beside the points are the capped ones: this year at the
    // age band's share of €115,000, and the year the 40% band starts at €46,000.
    const costs = computePersonalContributionCosts({
      currentYear: 2026,
      incomeMode: 'target',
      targetIncomeToday: highEarner.retirement.targetIncomeToday,
      targetIncomeBasis: 'net',
      householdTaxStatus: highEarner.householdTaxStatus,
      pensions: highEarner.pensions.map((entry) => ({
        ...entry,
        retirementAge: 65,
        personalPct: entry.personalPct + base.extraPoints
      }))
    });
    assertWithin(costs.years[0].gross, 0.25 * PENSION_EARNINGS_CAP, 0.01, 'this year\'s contribution is the capped €28,750');
    assertWithin(base.yearlyExtra, 0.25 * PENSION_EARNINGS_CAP - 0.05 * 230_000, 0.01, 'and the extra shown is that less what is paid in');
    assertWithin(costs.years[15].gross, 0.4 * PENSION_EARNINGS_CAP, 0.01, 'from 60 it is the capped €46,000');
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

  cases.push(runCase('Each goal says when it is first short, when money first reaches it, and when it is covered from', () => {
    const offsets = (entry) => entry.states.map((goal) => [goal.firstShortYear, goal.firstMoneyYear, goal.coveredFromYear].map(String).join('/'));

    // The sample, case 1 (years are offsets: 0 is this year). The first child is
    // met every year. The second is short in years 0 to 7 and covered from 8.
    // The mortgage gets nothing until year 8, part of it in 8 and 9, and is
    // covered from 10. Retirement gets nothing until year 10, then some of it
    // and never all of it.
    assertEqual(offsets(projection().debug.cases[0]).join(' '), 'null/0/null 0/0/8 0/8/10 0/10/null', 'case 1');

    // Never covered again: case 4's retirement is short from this year to the end.
    assertEqual(offsets(projection().debug.cases[3]).join(' '), 'null/0/null null/0/null null/null/null 0/0/null', 'case 4');

    // Covered this year, short later, and covered again: €14,500 left over.
    const tight = computeGoalsAndResourcesProjection({ ...GOALS_AND_RESOURCES_SAMPLE, leftOverEachYear: 14_500 }).debug.cases;
    assertEqual(offsets(tight.find((entry) => entry.id === 'mortgage-then-college')).pop(), '1/0/8', 'short from year 1, covered again from 8');
    assertEqual(offsets(tight.find((entry) => entry.id === 'college-today')).pop(), '6/0/15', 'short from year 6, covered again from 15');

    // Nothing at all: not covered in any year, so no money ever reaches a goal.
    const none = computeGoalsAndResourcesProjection({ ...GOALS_AND_RESOURCES_SAMPLE, leftOverEachYear: 0 }).debug.cases[0];
    assertEqual(offsets(none).join(' '), '0/null/null 0/null/null 0/null/null 0/null/null', 'with nothing left over');

    // Plenty: never short, so nothing to recover from.
    const plenty = computeGoalsAndResourcesProjection({ ...GOALS_AND_RESOURCES_SAMPLE, leftOverEachYear: 40_000 }).debug.cases[0];
    assertEqual(offsets(plenty).join(' '), 'null/0/null null/0/null null/0/null null/0/null', 'with plenty');

    // The later option carries them too.
    const laterStates = projection().debug.cases[0].laterRetirement.states;
    laterStates.forEach((goal) => {
      assert('firstMoneyYear' in goal && 'coveredFromYear' in goal, `${goal.goal}: the later option carries the offsets`);
    });

    // Consistency, for every case of every household here: a goal covered from
    // year N is fully met in that year and every year after it that it needs money.
    const ledgerOf = (entry) => entry.ledger;
    [projection().debug.cases, tight, none && [none], plenty && [plenty]].flat().forEach((entry) => {
      entry.states.forEach((goal) => {
        if (goal.coveredFromYear !== null) {
          assert(goal.firstShortYear !== null && goal.coveredFromYear > goal.firstShortYear, `${entry.id} ${goal.goal}: recovery follows a shortfall`);
          assert(goal.coveredFromYear < ledgerOf(entry).length, `${entry.id} ${goal.goal}: and is inside the ledger`);
        }
        if (goal.state === 'not') assertEqual(goal.firstMoneyYear, null, `${entry.id} ${goal.goal}: nothing ever reaches an uncovered goal`);
        if (goal.state === 'covered') assertEqual(goal.firstShortYear, null, `${entry.id} ${goal.goal}: a covered goal is never short`);
      });
    });
  }));

  cases.push(runCase('An unreachable retirement target never reports a coverage recovery', () => {
    const result = computeGoalsAndResourcesProjection({
      ...GOALS_AND_RESOURCES_SAMPLE,
      leftOverEachYear: 30_000,
      retirement: { retirementAge: 55, targetIncomeToday: 200_000 }
    });
    result.debug.cases.forEach((entry) => {
      assert(entry.pension.reachedCap && entry.pension.gapLeftOver > 0, 'the target stays out of reach');
      const retirement = entry.states.find((goal) => goal.kind === 'retirement');
      assertEqual(retirement.coveredFromYear, null, `${entry.id}: finding the contributions does not cover the retirement goal`);
    });
  }));

  cases.push(runCase('The ledger table is headed by calendar years, so a client can read it', () => {
    const rows = computeGoalsAndResourcesProjection(GOALS_AND_RESOURCES_SAMPLE).tables[0].rows;
    assertEqual(rows.length, 20, 'a row for every year to the last goal');
    assertEqual(rows[0][0], '2026', 'the first row is the calculation year, not "This year"');
    assertEqual(rows[1][0], '2027', 'then the next');
    assertEqual(rows[19][0], '2045', 'to the last');
    // The calculation year can be given, and the table follows it.
    const later = computeGoalsAndResourcesProjection(GOALS_AND_RESOURCES_SAMPLE, { calculationYear: 2030 }).tables[0].rows;
    assertEqual(`${later[0][0]}/${later[19][0]}`, '2030/2049', 'for 2030');
    const labels = computeGoalsAndResourcesProjection(GOALS_AND_RESOURCES_SAMPLE).tables.flatMap((table) => table.rows.map((row) => row[0]));
    assert(labels.every((label) => /^\d{4}$/.test(label)), 'every label is a four-digit year');
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
