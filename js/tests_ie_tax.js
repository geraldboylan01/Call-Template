import {
  TAX_UNSUPPORTED_TYPES,
  computeTaxYear,
  createTaxState,
  marginalTax,
  solveForNet
} from './planning/tax/engine.js';
import {
  DEFAULT_IE_TAX_CATALOGUE,
  recordPublishedSft,
  resolveSft,
  resolveTaxRules
} from './planning/tax/resolve.js';
import { crystallise } from './planning/tax/heads/sft.js';
import { arfImputedDistribution } from './planning/tax/heads/arf_imputed.js';
import {
  TAX_DISCLOSURE_CATALOGUE,
  TAX_NOT_INCLUDED,
  renderTaxDisclosure,
  taxNotIncludedLine
} from './planning/tax/disclosures.js';
import { computePensionProjection } from './pension_math.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/** Golden figures are to the cent; solver figures to the euro. */
function assertCents(actual, expected, message) {
  const delta = Math.abs(actual - expected);
  if (!(delta < 0.005)) {
    throw new Error(`${message} (expected ${expected}, got ${actual}, delta ${delta})`);
  }
}

function assertWithin(actual, expected, tolerance, message) {
  const delta = Math.abs(actual - expected);
  if (!(delta <= tolerance)) {
    throw new Error(`${message} (expected ${expected}, got ${actual}, delta ${delta})`);
  }
}

function assertThrows(fn, pattern, message) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert(error, `${message}: expected an error`);
  assert(pattern.test(error.message), `${message}: unexpected error "${error.message}"`);
}

function runCase(name, testFn) {
  try {
    testFn();
    console.info(`[IeTaxTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[IeTaxTests] FAIL: ${name}`, error);
    return { name, pass: false, error: error?.message || String(error) };
  }
}

/** The State Pension (Contributory) maximum for 2026, as the brief's cases use it. */
const SP = 15563.6;

const single = (id, age, extra = {}) => ({ id, age, ...extra });
const item = (personId, type, amount) => ({ personId, type, amount });

/**
 * The brief's golden cases (section 9), as requests the engine and the CLI
 * both answer. Kept as data so the Node runner can put the same requests
 * through `scripts/ie-tax.mjs` and compare.
 */
export const IE_TAX_GOLDEN_CASES = Object.freeze([
  {
    id: 'G1',
    command: 'year',
    request: {
      input: {
        year: 2026,
        status: 'single',
        people: [single('a', 67, { receivingStatePensionContributory: true })],
        items: [item('a', 'statePension', SP), item('a', 'arfDistribution', 30000)]
      }
    },
    expected: { incomeTax: 5180.44, usc: 432.82, prsi: 0, netIncome: 39950.34 }
  },
  {
    id: 'G2',
    command: 'year',
    request: {
      input: {
        year: 2026,
        status: 'married_or_civil_partners',
        people: [
          single('a', 72, { receivingStatePensionContributory: true }),
          single('b', 72, { receivingStatePensionContributory: true })
        ],
        items: [item('a', 'statePension', SP), item('a', 'arfDistribution', 40000), item('b', 'statePension', SP)]
      }
    },
    expected: { incomeTax: 6248.16, usc: 619.82, prsi: 0, netIncome: 64259.22, band: 68563.6, credits: 8490, uscByPerson: { a: 619.82, b: 0 } }
  },
  {
    id: 'G2b',
    command: 'year',
    request: {
      input: {
        year: 2026,
        status: 'single',
        people: [
          single('a', 72, { receivingStatePensionContributory: true }),
          single('b', 72, { receivingStatePensionContributory: true })
        ],
        items: [item('a', 'statePension', SP), item('a', 'arfDistribution', 40000), item('b', 'statePension', SP)]
      }
    },
    expected: { incomeTax: 9180.44, usc: 619.82, prsi: 0, netIncome: 61326.94 }
  },
  {
    id: 'G3',
    command: 'year',
    request: {
      input: { year: 2026, status: 'single', people: [single('a', 65)], items: [item('a', 'rentalProfit', 20000)] }
    },
    expected: { incomeTax: 800, usc: 219.82, prsi: 847.5, netIncome: 18132.68, normalTax: 1755 }
  },
  {
    id: 'G4',
    command: 'year',
    request: {
      input: { year: 2026, status: 'single', people: [single('a', 62)], items: [item('a', 'arfDistribution', 50000)] }
    },
    expected: { incomeTax: 7200, usc: 1032.82, prsi: 2118.75, netIncome: 39648.43 }
  },
  {
    id: 'G9',
    command: 'year',
    request: {
      input: { year: 2026, status: 'single', people: [single('a', 60)], items: [item('a', 'rentalProfit', 150000)] }
    },
    expected: { incomeTax: 49200, usc: 9530.62, prsi: 6356.25, netIncome: 84913.13, uscSurcharge: 1500 }
  },
  {
    id: 'G10a',
    command: 'year',
    request: {
      input: {
        year: 2029,
        status: 'single',
        people: [{ id: 'a', age: 67, birthYear: 1962, receivingStatePensionContributory: false }],
        items: [item('a', 'arfDistribution', 40000)]
      }
    },
    expected: { incomeTax: 3755, usc: 732.82, prsi: 1880, netIncome: 33632.18, prsiRate: 0.047 }
  },
  {
    id: 'G10b',
    command: 'year',
    request: {
      input: {
        year: 2032,
        status: 'single',
        people: [{ id: 'a', age: 70, birthYear: 1962, receivingStatePensionContributory: false }],
        items: [item('a', 'arfDistribution', 40000)]
      }
    },
    expected: { incomeTax: 3755, usc: 619.82, prsi: 0, netIncome: 35625.18 }
  },
  {
    id: 'G13',
    command: 'year',
    request: {
      input: {
        year: 2026,
        status: 'widowed_or_surviving_civil_partner',
        people: [single('a', 68, { receivingStatePensionContributory: true })],
        items: [item('a', 'statePension', SP), item('a', 'occupationalPension', 20000)]
      }
    },
    expected: { incomeTax: 2327.72, usc: 219.82, prsi: 0, netIncome: 33016.06 }
  },
  {
    id: 'G14',
    command: 'year',
    request: {
      input: {
        year: 2026,
        status: 'single',
        people: [single('a', 70, { receivingStatePensionContributory: true })],
        items: [item('a', 'statePension', SP), item('a', 'occupationalPension', 12000)]
      }
    },
    expected: { incomeTax: 1267.72, usc: 0, prsi: 0, netIncome: 26295.88 }
  },
  ...[
    { id: 'G5', year: 2029, fundValue: 3_200_000, lumpSum: 500_000, expected: { lumpSumTax: 60000, scheduleE: 0, chargeableExcess: 400000, grossCet: 160000, creditApplied: 60000, netCet: 100000, creditCarriedForward: 0, drawdownFund: 2600000, netLumpSum: 440000, sft: 2800000, sftBasis: 'fixed' } },
    { id: 'G5b', year: 2029, fundValue: 3_600_000, lumpSum: 900_000, expected: { lumpSumTax: 60000, scheduleE: 400000, chargeableExcess: 800000, grossCet: 320000, creditApplied: 60000, netCet: 260000, creditCarriedForward: 0, drawdownFund: 2440000, sft: 2800000, sftBasis: 'fixed' } },
    { id: 'G7', year: 2026, fundValue: 2_275_000, lumpSum: 500_000, expected: { lumpSumTax: 60000, scheduleE: 0, chargeableExcess: 75000, grossCet: 30000, creditApplied: 30000, netCet: 0, creditCarriedForward: 30000, drawdownFund: 1775000, sft: 2200000, sftBasis: 'fixed' } },
    { id: 'G15', year: 2031, fundValue: 3_400_000, lumpSum: 500_000, expected: { lumpSumTax: 60000, scheduleE: 0, chargeableExcess: 600000, grossCet: 240000, creditApplied: 60000, netCet: 180000, creditCarriedForward: 0, drawdownFund: 2720000, netLumpSum: 440000, sft: 2800000, sftBasis: 'held' } }
  ].map((entry) => ({
    id: entry.id,
    command: 'year',
    crystallisation: { year: entry.year, fundValue: entry.fundValue, lumpSum: entry.lumpSum },
    request: {
      input: {
        year: entry.year,
        status: 'single',
        people: [single('m', 65)],
        items: [],
        events: [{ type: 'benefitCrystallisation', personId: 'm', fundValue: entry.fundValue, lumpSum: entry.lumpSum }]
      }
    },
    expected: entry.expected
  })),
  ...[6800, 21250].map((contribution) => ({
    id: `G11-${contribution}`,
    command: 'marginal',
    request: {
      input: { year: 2026, status: 'single', people: [single('a', 42)], items: [item('a', 'employment', 85000)] },
      delta: item('a', 'employmentPensionContribution', contribution)
    },
    expected: contribution === 6800
      ? { relief: 2720, netCost: 4080, monthly: 340 }
      : { relief: 8500, netCost: 12750, monthly: 1062.5 }
  })),
  {
    id: 'G12-solve',
    command: 'solve',
    request: {
      input: {
        year: 2026,
        status: 'single',
        people: [single('a', 67, { receivingStatePensionContributory: true })],
        items: [item('a', 'statePension', SP), item('a', 'arfDistribution', 20000)]
      },
      targetNet: 40000,
      adjustable: { split: [{ personId: 'a', type: 'arfDistribution', share: 1 }] }
    },
    expected: { amount: 10087.11, netIncome: 40000 }
  }
]);

/** The golden case as the engine answers it, in the CLI's own output shape. */
export function runGoldenCaseInEngine(goldenCase) {
  const request = goldenCase.request;
  if (goldenCase.command === 'year') {
    return computeTaxYear({ state: request.state ?? null, input: request.input });
  }
  if (goldenCase.command === 'marginal') {
    return marginalTax({ state: request.state ?? null, input: request.input, delta: request.delta });
  }
  const split = request.adjustable.split;
  const totalShare = split.reduce((total, entry) => total + entry.share, 0);
  return solveForNet({
    state: request.state ?? null,
    input: request.input,
    targetNet: request.targetNet,
    adjustable: (amount) => split.map((entry) => ({
      personId: entry.personId,
      type: entry.type,
      amount: amount * (entry.share / totalShare)
    }))
  });
}

function checkGoldenYear(goldenCase) {
  const { result } = runGoldenCaseInEngine(goldenCase);
  const expected = goldenCase.expected;
  const totals = result.totals;
  ['incomeTax', 'usc', 'prsi', 'netIncome'].forEach((key) => {
    if (typeof expected[key] === 'number') {
      assertCents(totals[key], expected[key], `${goldenCase.id} ${key}`);
    }
  });
  if (typeof expected.band === 'number') {
    assertCents(result.assessments[0].standardRateBand, expected.band, `${goldenCase.id} band`);
    assertCents(result.assessments[0].credits.total, expected.credits, `${goldenCase.id} credits`);
  }
  if (expected.uscByPerson) {
    Object.entries(expected.uscByPerson).forEach(([personId, amount]) => {
      const person = result.people.find((entry) => entry.id === personId);
      assertCents(person.usc.usc, amount, `${goldenCase.id} USC for ${personId}`);
    });
  }
  if (typeof expected.normalTax === 'number') {
    assertCents(result.assessments[0].normalTax, expected.normalTax, `${goldenCase.id} normal tax before marginal relief`);
  }
  if (typeof expected.uscSurcharge === 'number') {
    assertCents(result.people[0].usc.surcharge, expected.uscSurcharge, `${goldenCase.id} USC surcharge`);
  }
  if (typeof expected.prsiRate === 'number') {
    assertCents(result.prsiRate * 10000, expected.prsiRate * 10000, `${goldenCase.id} PRSI rate`);
  }
  return result;
}

function checkGoldenCrystallisation(goldenCase) {
  const expected = goldenCase.expected;
  const direct = crystallise(goldenCase.crystallisation);
  const { result } = runGoldenCaseInEngine(goldenCase);
  const inYear = result.crystallisations[0];
  Object.entries(expected).forEach(([key, value]) => {
    if (key === 'netLumpSum') {
      assertCents(inYear.netLumpSum, value, `${goldenCase.id} net lump sum`);
      return;
    }
    if (typeof value === 'number') {
      assertCents(direct[key], value, `${goldenCase.id} ${key} from crystallise`);
      assertCents(inYear[key], value, `${goldenCase.id} ${key} from computeTaxYear`);
    } else {
      assert(direct[key] === value && inYear[key] === value, `${goldenCase.id} ${key} should be ${value}`);
    }
  });
  return { direct, result };
}

/** Every field an input can fail on, with the field its error must name. */
const INVALID_INPUTS = [
  [{ year: 2025, status: 'single', people: [single('a', 60)] }, /year must be 2026 or later/],
  [{ year: 2026.5, status: 'single', people: [single('a', 60)] }, /input\.year/],
  [{ year: 2026, status: 'cohabiting', people: [single('a', 60)] }, /input\.status/],
  [{ year: 2026, status: 'single', people: [] }, /input\.people/],
  [{ year: 2026, status: 'single', people: [single('a', 60), single('b', 60), single('c', 60)] }, /input\.people/],
  [{ year: 2026, status: 'widowed_or_surviving_civil_partner', people: [single('a', 60), single('b', 60)] }, /input\.status/],
  [{ year: 2026, status: 'single', people: [{ id: '', age: 60 }] }, /input\.people\[0\]\.id/],
  [{ year: 2026, status: 'single', people: [{ id: 'a' }] }, /input\.people\[0\] must include age or birthYear/],
  [{ year: 2026, status: 'single', people: [{ id: 'a', age: 67, birthYear: 1962 }] }, /input\.people\[0\]\.age 67 does not match birthYear 1962/],
  [{ year: 2026, status: 'single', people: [single('a', 60), single('a', 61)] }, /input\.people\[1\]\.id "a" is used twice/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], items: [item('b', 'rentalProfit', 1)] }, /input\.items\[0\]\.personId/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], items: [item('joint', 'rentalProfit', 1)] }, /input\.items\[0\]\.personId "joint"/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], items: [item('a', 'rentalProfit', -5)] }, /input\.items\[0\]\.amount/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], items: [item('a', 'bonus', 5)] }, /input\.items\[0\]\.type "bonus" is not a recognised type/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], items: [item('a', 'lumpSumScheduleE', 5)] }, /input\.items\[0\]\.type "lumpSumScheduleE" is created by the engine/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], items: [item('a', 'employment', 100), item('a', 'employmentPensionContribution', 200)] }, /input\.people\[0\] \(a\) has an employmentPensionContribution/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [{ type: 'benefitCrystallisation', personId: 'a', fundValue: 100, lumpSum: 200 }] }, /input\.events\[0\]\.lumpSum/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [{ type: 'benefitCrystallisation', personId: 'x', fundValue: 100 }] }, /input\.events\[0\]\.personId/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [{ type: 'benefitCrystallisation', personId: 'a' }] }, /input\.events\[0\]\.fundValue/]
];

/** A deep freeze, so any attempt to change an argument throws in strict mode. */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * A 60-year household projection with a solver in every year (brief, 3.4):
 * a married couple drawing an after-tax income from two ARFs, with the tax
 * state carried from year to year. Returns the elapsed milliseconds.
 */
export function benchmarkSixtyYearProjection(now = () => Date.now()) {
  const started = now();
  let state = createTaxState({ a: {}, b: {} });
  let balanceA = 900_000;
  let balanceB = 500_000;
  for (let offset = 0; offset < 60; offset += 1) {
    const year = 2026 + offset;
    const people = [
      { id: 'a', age: 60 + offset, receivingStatePensionContributory: 60 + offset >= 66 },
      { id: 'b', age: 58 + offset, receivingStatePensionContributory: 58 + offset >= 66 }
    ];
    const items = [];
    if (60 + offset >= 66) items.push(item('a', 'statePension', SP * Math.pow(1.02, offset)));
    if (58 + offset >= 66) items.push(item('b', 'statePension', SP * Math.pow(1.02, offset)));
    items.push(item('joint', 'rentalProfit', 12000 * Math.pow(1.02, offset)));
    const total = balanceA + balanceB;
    const solved = solveForNet({
      state,
      input: { year, status: 'married_or_civil_partners', people, items },
      targetNet: 70000 * Math.pow(1.02, offset),
      maxAmount: total,
      adjustable: (amount) => [
        item('a', 'arfDistribution', total > 0 ? amount * (balanceA / total) : 0),
        item('b', 'arfDistribution', total > 0 ? amount * (balanceB / total) : 0)
      ]
    });
    const share = total > 0 ? solved.amount / total : 0;
    balanceA = Math.max(0, balanceA * (1 - share)) * 1.05;
    balanceB = Math.max(0, balanceB * (1 - share)) * 1.05;
    state = solved.nextState;
  }
  return now() - started;
}

export function runIeTaxTests() {
  const cases = [];
  const golden = (id) => IE_TAX_GOLDEN_CASES.find((entry) => entry.id === id);

  ['G1', 'G2', 'G2b', 'G3', 'G4', 'G9', 'G10a', 'G10b', 'G13', 'G14'].forEach((id) => {
    cases.push(runCase(`${id}: income tax, USC, PRSI and net income to the cent`, () => {
      checkGoldenYear(golden(id));
    }));
  });

  cases.push(runCase('G3 and G13: the over-65 limits and marginal relief say which applied', () => {
    const g3 = checkGoldenYear(golden('G3'));
    assert(g3.disclosureCodes.includes('IT_MARGINAL_RELIEF'), 'G3 uses marginal relief');
    assert(g3.assessments[0].ageRelief.kind === 'marginal', 'G3 records the marginal relief');
    const g13 = checkGoldenYear(golden('G13'));
    assert(!g13.disclosureCodes.includes('IT_MARGINAL_RELIEF'), 'G13 normal tax is lower, so no relief is claimed');
    assert(g13.disclosureCodes.includes('STATUS_WIDOWED'), 'G13 says it is a widowed assessment');
  }));

  cases.push(runCase('G6: Revenue Chapter 27 Example 4, three lump sums in turn', () => {
    let state = null;
    const results = [180_000, 150_000, 450_000].map((lumpSum, index) => {
      const outcome = computeTaxYear({
        state,
        input: {
          year: 2026 + index,
          status: 'single',
          people: [single('m', 60 + index)],
          events: [{ type: 'benefitCrystallisation', personId: 'm', fundValue: lumpSum, lumpSum }]
        }
      });
      state = outcome.nextState;
      return outcome.result.crystallisations[0];
    });
    assertCents(results[0].lumpSumTaxFree, 180_000, 'first lump sum is tax-free');
    assertCents(results[1].lumpSumStandardRatePart, 130_000, 'second: 20% slice');
    assertCents(results[1].lumpSumTax, 26_000, 'second: tax');
    assertCents(results[2].lumpSumStandardRatePart, 170_000, 'third: 20% slice');
    assertCents(results[2].lumpSumTax, 34_000, 'third: tax');
    assertCents(results[2].scheduleE, 280_000, 'third: Schedule E part');
    assertCents(state.people.m.lumpSumsSince2005, 780_000, 'lifetime total carried');
  }));

  ['G5', 'G5b', 'G7', 'G15'].forEach((id) => {
    cases.push(runCase(`${id}: crystallisation, CET and credit to the cent, directly and in a tax year`, () => {
      checkGoldenCrystallisation(golden(id));
    }));
  });

  cases.push(runCase('G5b: the Schedule E part is taxed with the year and never credited against CET', () => {
    const { result } = checkGoldenCrystallisation(golden('G5b'));
    assertCents(result.people[0].income.lumpSumScheduleE, 400_000, 'Schedule E part added to income');
    assert(result.totals.lumpSumScheduleETax > 0, 'the Schedule E part is taxed');
    assertCents(result.crystallisations[0].creditApplied, 60_000, 'only the 20% tax is credited');
    assertCents(result.totals.netIncome, 0, 'none of it counts as recurring net income');
  }));

  cases.push(runCase('G7: unused lump sum credit carries into the next year', () => {
    const { result } = checkGoldenCrystallisation(golden('G7'));
    const outcome = computeTaxYear({ input: golden('G7').request.input });
    assert(outcome.nextState.people.m.unrelievedLumpSumTax === 30_000, 'the carried credit is in the state');
    assert(result.disclosureCodes.includes('SFT_CREDIT'), 'the credit is disclosed');
    const text = renderTaxDisclosure(result.disclosures.find((entry) => entry.code === 'SFT_CREDIT'), { rules: resolveTaxRules(2026) }).text;
    assert(text.includes('€30,000 of unused credit carries forward'), `credit wording: ${text}`);
  }));

  cases.push(runCase('G15: a held threshold is used and SFT_HELD is raised', () => {
    const { result } = checkGoldenCrystallisation(golden('G15'));
    assert(result.sftBasis === 'held', 'sftBasis is held');
    assert(result.disclosureCodes.includes('SFT_HELD'), 'SFT_HELD is raised');
    const text = renderTaxDisclosure(result.disclosures.find((entry) => entry.code === 'SFT_HELD'), { rules: resolveTaxRules(2031) }).text;
    assert(text.includes('held here at €2.8 million') && text.includes('for 2031 may therefore be overstated'), `SFT_HELD wording: ${text}`);
  }));

  cases.push(runCase('G11: relief and net cost of a pension contribution', () => {
    ['G11-6800', 'G11-21250'].forEach((id) => {
      const goldenCase = golden(id);
      const outcome = runGoldenCaseInEngine(goldenCase);
      const contribution = goldenCase.request.delta.amount;
      assertCents(-outcome.byHead.incomeTax, goldenCase.expected.relief, `${id} relief`);
      assertCents(outcome.byHead.usc, 0, `${id} USC is not relieved`);
      assertCents(outcome.byHead.prsi, 0, `${id} PRSI is not relieved`);
      assertCents(contribution + outcome.total, goldenCase.expected.netCost, `${id} net cost a year`);
      assertCents((contribution + outcome.total) / 12, goldenCase.expected.monthly, `${id} net cost a month`);
    });
  }));

  cases.push(runCase('G12: solveForNet finds the elected withdrawal within €1', () => {
    const outcome = runGoldenCaseInEngine(golden('G12-solve'));
    assert(outcome.met, 'the target is met');
    assertWithin(outcome.amount, 10087.11, 1, 'elected withdrawal');
    assertWithin(outcome.netIncome, 40000, 1, 'net income');
  }));

  cases.push(runCase('G12: the retirement engine in net mode', () => {
    const projection = computePensionProjection({
      currentYear: 2026,
      currentAge: 67,
      retirementAge: 67,
      currentSalary: 0,
      currentPot: 500_000,
      personalPct: 0,
      employerPct: 0,
      growthRate: 0.05,
      inflationRate: 0.02,
      wageGrowthRate: 0.02,
      horizonEndAge: 95,
      incomeMode: 'target',
      targetIncomeToday: 40_000,
      targetIncomeBasis: 'net',
      includeStatePension: true
    });
    const simulation = projection.debug.retirementSimulationProjectedCurrent;
    assertWithin(simulation.firstYearMandatoryWithdrawal, 20000, 0.005, 'mandatory withdrawal at 4%');
    assertWithin(simulation.firstYearElectedWithdrawal, 10087.11, 1, 'elected withdrawal');
    assertWithin(simulation.firstYearMandatoryWithdrawal + simulation.firstYearElectedWithdrawal, 30087.11, 1, 'first-year withdrawals');
    assertWithin(simulation.tax.netIncome[0], 40000, 1, 'first-year net income');
    const labels = projection.outputsTable.rows.map((row) => row[0]);
    assert(labels.includes("Target net income (today's money)"), 'target rows read as net');
    assert(projection.debug.tax.disclosureCodes.includes('NET_TARGET'), 'NET_TARGET is disclosed');
  }));

  cases.push(runCase('G5e: the retirement engine crystallises a €3.2m fund in 2029 as G5 does', () => {
    const projection = computePensionProjection({
      currentYear: 2029,
      currentAge: 65,
      retirementAge: 65,
      currentSalary: 0,
      currentPot: 3_200_000,
      personalPct: 0,
      employerPct: 0,
      growthRate: 0.05,
      inflationRate: 0.02,
      wageGrowthRate: 0.02,
      horizonEndAge: 95,
      incomeMode: 'target',
      targetIncomeToday: 60_000,
      includeStatePension: true,
      lumpSum: { mode: 'amount', amount: 500_000 }
    });
    const record = projection.debug.tax.crystallisations.current[0];
    const expected = golden('G5').expected;
    Object.entries(expected).forEach(([key, value]) => {
      if (typeof value === 'number') {
        assertCents(record[key], value, `G5e ${key}`);
      }
    });
    const rows = new Map(projection.outputsTable.rows.map((row) => [row[0], row[1]]));
    assert(rows.get('Estimated chargeable excess tax after credit') === '€100,000', 'net CET row');
    assert(rows.get('Drawdown fund after lump sum and tax') === '€2,600,000', 'drawdown fund row');
    assert(rows.get('Retirement lump sum after tax') === '€440,000', 'net lump sum row');
    assert(projection.debug.sftBreaches.current === true, 'the breach is flagged');
    assert(projection.debug.projectedPotCurrent === 2_600_000, 'the projected pot is the drawdown fund');
    assert(projection.debug.sftSentence.includes('€100,000 of chargeable excess tax'), `CET sentence: ${projection.debug.sftSentence}`);
  }));

  cases.push(runCase('G11 through the retirement engine: net cost of contributing today', () => {
    const projection = computePensionProjection({
      currentAge: 42,
      retirementAge: 67,
      currentSalary: 85000,
      currentPot: 180000,
      personalPct: 0.08,
      employerPct: 0.06,
      growthRate: 0.05,
      inflationRate: 0.02,
      wageGrowthRate: 0.02,
      horizonEndAge: 92,
      currentYear: 2026,
      incomeMode: 'target',
      targetIncomeToday: 42000
    });
    const [entry] = projection.debug.tax.contributionNetCosts;
    assertCents(entry.current.annual, 4080, 'current contribution net cost a year');
    assertCents(entry.current.monthly, 340, 'current contribution net cost a month');
    assertCents(entry.max.annual, 12750, 'maximum contribution net cost a year');
    assertCents(entry.max.monthly, 1062.5, 'maximum contribution net cost a month');
    assert(projection.debug.tax.disclosureCodes.includes('NET_COST_CONTRIBUTIONS'), 'the net cost is disclosed');
  }));

  cases.push(runCase('resolveTaxRules(2040) holds the 2026 Budget figures and the legislated end points', () => {
    const rules = resolveTaxRules(2040);
    const base = resolveTaxRules(2026);
    assert(rules.rulesYear === 2026, 'rulesYear 2026');
    assert(rules.heldForward === true, 'heldForward');
    assert(base.heldForward === false, '2026 is not held forward');
    assert(rules.incomeTax.standardRateBand.single === 44_000, 'single band €44,000');
    assert(rules.sft.amount === 2_800_000 && rules.sftBasis === 'held', 'SFT €2.8m held');
    assertCents(rules.prsi.rate * 1e4, 0.047 * 1e4, 'PRSI 4.7%');
    assert(rules.status === 'enacted' && rules.version === DEFAULT_IE_TAX_CATALOGUE.version, 'status and version');
  }));

  cases.push(runCase('No year after 2026 produces different bands, credits, exemption limits or USC thresholds', () => {
    const base = resolveTaxRules(2026);
    for (let year = 2027; year <= 2110; year += 1) {
      const rules = resolveTaxRules(year);
      ['incomeTax', 'ageExemption', 'usc', 'lumpSum'].forEach((key) => {
        assert(JSON.stringify(rules[key]) === JSON.stringify(base[key]), `${key} changed in ${year}`);
      });
    }
  }));

  cases.push(runCase('PRSI is blended by months in force', () => {
    [[2026, 0.042375], [2027, 0.043875], [2028, 0.0455], [2029, 0.047], [2050, 0.047]].forEach(([year, rate]) => {
      assertWithin(resolveTaxRules(year).prsi.rate, rate, 1e-12, `PRSI ${year}`);
    });
    assert(resolveTaxRules(2026).prsi.blended === true, '2026 blends two rates');
    assert(resolveTaxRules(2029).prsi.blended === false, '2029 has one rate');
  }));

  cases.push(runCase('Years before 2026 throw', () => {
    assertThrows(() => resolveTaxRules(2025), /2026 or later/, 'resolveTaxRules(2025)');
    assertThrows(() => resolveSft(2025), /2026 or later/, 'resolveSft(2025)');
  }));

  cases.push(runCase('The SFT follows the law to 2029 and is held, never projected, after', () => {
    [[2026, 2_200_000], [2027, 2_400_000], [2028, 2_600_000], [2029, 2_800_000]].forEach(([year, amount]) => {
      const sft = resolveSft(year);
      assert(sft.amount === amount && sft.basis === 'fixed', `${year} should be ${amount}, fixed`);
    });
    // 2030, 2031, 2035 and 2040 are the brief's checks; every year to 2100
    // holds the same figure until a published one is recorded.
    for (let year = 2030; year <= 2100; year += 1) {
      const sft = resolveSft(year);
      assert(sft.amount === 2_800_000 && sft.basis === 'held', `${year} should be €2.8m, held`);
      assert(resolveTaxRules(year).sftBasis === 'held', `${year} rules say held`);
    }
    let previous = 0;
    for (let year = 2026; year <= 2100; year += 1) {
      const amount = resolveSft(year).amount;
      assert(amount >= previous, `the threshold fell in ${year}`);
      previous = amount;
    }
  }));

  cases.push(runCase('A published SFT is used for its year and held after it', () => {
    const catalogue = recordPublishedSft(DEFAULT_IE_TAX_CATALOGUE, {
      year: 2030,
      amount: 3_000_000,
      source: { title: 'Hypothetical Revenue publication, for this test only', url: '' }
    });
    const in2030 = resolveSft(2030, catalogue);
    assert(in2030.amount === 3_000_000 && in2030.basis === 'fixed', '2030 is the published figure, fixed');
    [2031, 2040].forEach((year) => {
      const sft = resolveSft(year, catalogue);
      assert(sft.amount === 3_000_000 && sft.basis === 'held', `${year} holds the published figure`);
    });
    assert(resolveSft(2030).amount === 2_800_000, 'the built-in catalogue is unchanged');
    assert(resolveTaxRules(2031, { catalogue }).sft.amount === 3_000_000, 'resolveTaxRules reads the recorded figure');
  }));

  cases.push(runCase('A published SFT below the previous year is refused', () => {
    assertThrows(
      () => recordPublishedSft(DEFAULT_IE_TAX_CATALOGUE, { year: 2030, amount: 2_700_000 }),
      /does not allow the Standard Fund Threshold to fall/,
      'a falling threshold'
    );
  }));

  cases.push(runCase('ARF imputed distributions by attained age and opening value', () => {
    [[500_000, 60, 0], [500_000, 61, 20_000], [500_000, 70, 20_000], [500_000, 71, 25_000], [2_100_000, 61, 126_000], [2_100_000, 58, 0]]
      .forEach(([openingValue, attainedAge, amount]) => {
        assertCents(arfImputedDistribution({ attainedAge, openingValue }).amount, amount, `€${openingValue} at ${attainedAge}`);
      });
  }));

  cases.push(runCase('marginalTax equals the difference between two full calculations, to the cent', () => {
    const input = golden('G2').request.input;
    const deltas = [
      item('a', 'arfDistribution', 10_000),
      item('b', 'arfDistribution', 10_000),
      item('joint', 'rentalProfit', 30_000),
      { type: 'benefitCrystallisation', personId: 'b', fundValue: 3_000_000, lumpSum: 750_000 }
    ];
    deltas.forEach((delta) => {
      const marginal = marginalTax({ input, delta });
      const before = computeTaxYear({ input }).result.totals;
      const withDelta = delta.type === 'benefitCrystallisation'
        ? { ...input, events: [delta] }
        : { ...input, items: [...input.items, delta] };
      const after = computeTaxYear({ input: withDelta }).result.totals;
      ['incomeTax', 'usc', 'prsi', 'lumpSumTax', 'chargeableExcessTax'].forEach((head) => {
        assertCents(marginal.byHead[head], after[head] - before[head], `${delta.type} ${head}`);
      });
      assertCents(marginal.total, after.totalTax - before.totalTax, `${delta.type} total`);
    });
  }));

  cases.push(runCase('computeTaxYear never changes its arguments, and nextState survives a JSON round trip', () => {
    const state = deepFreeze(createTaxState({ m: { lumpSumsSince2005: 100_000, fundLots: [{ cost: 1, value: 2 }] } }));
    const input = deepFreeze({
      year: 2031,
      status: 'married_or_civil_partners',
      people: [single('m', 66), single('n', 64)],
      items: [item('m', 'arfDistribution', 30_000), item('joint', 'rentalProfit', 20_000)],
      events: [{ type: 'benefitCrystallisation', personId: 'm', fundValue: 3_000_000, lumpSum: 700_000 }]
    });
    const snapshot = JSON.stringify({ state, input });
    const first = computeTaxYear({ state, input });
    assert(JSON.stringify({ state, input }) === snapshot, 'the arguments are unchanged');
    const roundTripped = JSON.parse(JSON.stringify(first.nextState));
    assert(JSON.stringify(roundTripped) === JSON.stringify(first.nextState), 'nextState is plain JSON');
    const nextYear = { ...input, year: 2032, people: [single('m', 67), single('n', 65)], events: [] };
    const fromLive = computeTaxYear({ state: first.nextState, input: nextYear });
    const fromJson = computeTaxYear({ state: roundTripped, input: nextYear });
    assert(JSON.stringify(fromLive) === JSON.stringify(fromJson), 'a round-tripped state gives the same next year');
    assert(fromJson.nextState.people.m.fundLots[0].cost === 1, 'reserved Part B keys are carried untouched');
    assert(fromJson.nextState.people.m.catReceivedByGroup.A === 0, 'catReceivedByGroup is reserved');
  }));

  cases.push(runCase('Part B item and event types are refused, never taxed as nothing', () => {
    TAX_UNSUPPORTED_TYPES.forEach((type) => {
      assertThrows(
        () => computeTaxYear({ input: { year: 2026, status: 'single', people: [single('a', 60)], items: [item('a', type, 1000)] } }),
        new RegExp(`input\\.items\\[0\\]\\.type "${type}" is not supported yet`),
        `item ${type}`
      );
      assertThrows(
        () => computeTaxYear({ input: { year: 2026, status: 'single', people: [single('a', 60)], events: [{ type, personId: 'a', fundValue: 1 }] } }),
        new RegExp(`input\\.events\\[0\\]\\.type "${type}" is not supported yet`),
        `event ${type}`
      );
    });
  }));

  cases.push(runCase('Invalid inputs fail with an error that names the field', () => {
    INVALID_INPUTS.forEach(([input, pattern], index) => {
      assertThrows(() => computeTaxYear({ input }), pattern, `invalid input ${index}`);
    });
    assertThrows(
      () => computeTaxYear({ state: { people: { a: { sftUsed: -1 } } }, input: golden('G4').request.input }),
      /state\.people\.a\.sftUsed/,
      'a negative state value'
    );
  }));

  cases.push(runCase('Joint rent is split equally and a spouse with no income is said to have none', () => {
    const shared = computeTaxYear({
      input: {
        year: 2026,
        status: 'married_or_civil_partners',
        people: [single('a', 60), single('b', 58)],
        items: [item('joint', 'rentalProfit', 30_000)]
      }
    }).result;
    assertCents(shared.people[0].income.rentalProfit, 15_000, 'half the rent each');
    assert(shared.disclosureCodes.includes('RENT_SPLIT_JOINT'), 'RENT_SPLIT_JOINT');
    const alone = computeTaxYear({
      input: { year: 2026, status: 'married_or_civil_partners', people: [single('a', 60)], items: [item('a', 'arfDistribution', 60_000)] }
    }).result;
    assert(alone.assessments[0].standardRateBand === 53_000, 'one income, no increase');
    assert(alone.disclosureCodes.includes('STATUS_SPOUSE_NO_INCOME'), 'STATUS_SPOUSE_NO_INCOME');
  }));

  cases.push(runCase('Every disclosure renders in plain words, with its figures filled in and no em dashes', () => {
    const rules = resolveTaxRules(2031);
    const params = {
      IT_AGE_EXEMPTION: { years: [2031, 2032, 2033, 2035] },
      IT_MARGINAL_RELIEF: { years: [2031] },
      OTHER_INCOME_AS_PENSION: { title: 'Land lease income' },
      LUMP_SUM_PRIOR: { amount: 150_000 },
      SFT_THRESHOLD: { amount: 2_800_000, years: [2031] },
      SFT_HELD: { heldAmount: 2_800_000, years: [2031] },
      SFT_CET: { rate: 0.4 },
      SFT_CREDIT: { amount: 30_000 },
      SFT_ALREADY_USED: { amount: 400_000 }
    };
    Object.keys(TAX_DISCLOSURE_CATALOGUE).forEach((code) => {
      const { text } = renderTaxDisclosure({ code, params: params[code] || null }, { rules });
      assert(text && !/[{}]|undefined|NaN/.test(text), `${code} has an unfilled placeholder: ${text}`);
      assert(!text.includes('—'), `${code} uses an em dash`);
      assert(!/you will pay/i.test(text), `${code} says "you will pay"`);
      assert((text.match(/[.!?](\s|$)/g) || []).length <= 2, `${code} is more than two sentences`);
    });
    assert(renderTaxDisclosure({ code: 'IT_AGE_EXEMPTION', params: params.IT_AGE_EXEMPTION }, { rules }).text.startsWith('In 2031 to 2033 and 2035,'), 'years read as ranges');
    assert(renderTaxDisclosure({ code: 'TAX_LEGISLATED_CHANGES' }, { rules }).text.includes('PRSI rises each October to 2028, and the Standard Fund Threshold rises to €2.8 million in 2029.'), 'legislated changes come from the schedules');
    assert(TAX_NOT_INCLUDED.length === 11, 'eleven items are not included');
    assert(TAX_NOT_INCLUDED.every((entry) => !entry.text.includes('—')), 'no em dash in the not-included list');
    assert(!taxNotIncludedLine().includes('—'), 'no em dash in the compact line');
  }));

  cases.push(runCase('A 60-year household projection with a solver every year runs quickly', () => {
    const elapsed = benchmarkSixtyYearProjection();
    console.info(`[IeTaxTests] 60-year household projection with a solver every year: ${elapsed} ms`);
    // The brief's bound is 300 ms in Node. A browser Dev Panel run can be
    // slower, so this only guards against something pathological.
    assert(elapsed < 3000, `took ${elapsed} ms`);
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = {
    total: cases.length,
    passed,
    failed,
    results: cases
  };

  if (failed > 0) {
    console.warn('[IeTaxTests] Completed with failures', summary);
  } else {
    console.info('[IeTaxTests] All tests passed', { total: summary.total, passed: summary.passed });
  }

  return summary;
}
