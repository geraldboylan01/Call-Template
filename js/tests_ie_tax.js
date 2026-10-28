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
  resolveTaxRules,
  withTaxCatalogue
} from './planning/tax/resolve.js';
import { crystallise } from './planning/tax/heads/sft.js';
import {
  computeDisposalGain,
  indexationMultiplier,
  section604AShare,
  yearsBetween
} from './planning/tax/heads/capital_gains.js';
import { IE_CGT_FIXED_RULES, IE_INVESTMENT_RULES } from './planning/tax/rules_ie.js';
import { afterTaxInvestmentDisclosures, exitTaxRateOn } from './planning/tax/investment_funds.js';
import { arfImputedDistribution } from './planning/tax/heads/arf_imputed.js';
import {
  TAX_DISCLOSURE_CATALOGUE,
  TAX_NOT_INCLUDED,
  renderTaxDisclosure,
  renderTaxDisclosures,
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

const sale = (fields) => ({ type: 'propertyDisposal', personId: 'a', acquiredBy: 'purchase', homeUse: 'never', ...fields });
const couple = [single('a', 50), single('b', 50)];

/**
 * Capital gains tax on property. C1 to C3 are Revenue's own worked examples
 * (Tax and Duty Manual Part 19-02-13, Examples 1, 4 and 5, all 2026 sales).
 * The rest are worked by hand from the rules in `rules_ie.js`: 33% before
 * 7 October 2026, 31% from then, and a €1,270 exemption per owner.
 */
const CGT_GOLDEN_CASES = Object.freeze([
  {
    id: 'C1',
    note: 'TDM 19-02-13 Example 1: €10,000 paid in 1986/87, sold for €100,000. Gain €83,630; tax (83,630 - 1,270) x 33%',
    command: 'year',
    request: { input: { year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2026-06-01', proceeds: 100_000, acquisitionCost: 10_000, acquisitionDate: '1986-09-01' })] } },
    expected: { capitalGainsTax: 27178.8, chargeableGain: 83630, multiplier: 1.637, lossesCarriedForward: { a: 0 } }
  },
  {
    id: 'C2',
    note: 'TDM 19-02-13 Example 4: €4,200 paid in 2000/01, sold for €4,000. Indexation cannot increase the loss: allowable loss €200',
    command: 'year',
    request: { input: { year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2026-06-01', proceeds: 4_000, acquisitionCost: 4_200, acquisitionDate: '2000-10-01' })] } },
    expected: { capitalGainsTax: 0, chargeableGain: 0, multiplier: 1.144, lossesCarriedForward: { a: 200 } }
  },
  {
    id: 'C3',
    note: 'TDM 19-02-13 Example 5: €2,800 paid in 1986/87, sold for €4,000. Indexation turns the gain into a loss: no gain, no loss',
    command: 'year',
    request: { input: { year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2026-06-01', proceeds: 4_000, acquisitionCost: 2_800, acquisitionDate: '1986-09-01' })] } },
    expected: { capitalGainsTax: 0, chargeableGain: 0, outcome: 'no_gain_no_loss', lossesCarriedForward: { a: 0 } }
  },
  {
    id: 'C4a',
    note: 'Sold 6 October 2026 at 33%: (320,000 - 6,000 - 250,000 - 1,270) x 33%',
    command: 'year',
    request: { input: { year: 2026, status: 'single', people: [single('a', 55)], events: [sale({ disposalDate: '2026-10-06', proceeds: 320_000, sellingCosts: 6_000, acquisitionCost: 250_000, acquisitionDate: '2005-05-01' })] } },
    expected: { capitalGainsTax: 20700.9, chargeableGain: 64000, rate: 0.33 }
  },
  {
    id: 'C4b',
    note: 'The same sale on 7 October 2026, at the 31% rate announced in Budget 2027',
    command: 'year',
    request: { input: { year: 2026, status: 'single', people: [single('a', 55)], events: [sale({ disposalDate: '2026-10-07', proceeds: 320_000, sellingCosts: 6_000, acquisitionCost: 250_000, acquisitionDate: '2005-05-01' })] } },
    expected: { capitalGainsTax: 19446.3, chargeableGain: 64000, rate: 0.31 }
  },
  {
    id: 'C5',
    note: 's.604A: bought 15 June 2013, sold 15 June 2027, exactly 14 years. 7/14 of the €150,000 gain is exempt: (75,000 - 1,270) x 31%',
    command: 'year',
    request: { input: { year: 2027, status: 'single', people: [single('a', 55)], events: [sale({ disposalDate: '2027-06-15', proceeds: 400_000, acquisitionCost: 250_000, acquisitionDate: '2013-06-15' })] } },
    expected: { capitalGainsTax: 22856.3, chargeableGain: 75000, exemptShare: 0.5 }
  },
  {
    id: 'C6',
    note: 'C5 inherited rather than bought: s.604A needs a purchase at market value, so the whole gain is taxed',
    command: 'year',
    request: { input: { year: 2027, status: 'single', people: [single('a', 55)], events: [sale({ disposalDate: '2027-06-15', proceeds: 400_000, acquisitionCost: 250_000, acquisitionDate: '2013-06-15', acquiredBy: 'gift_or_inheritance' })] } },
    expected: { capitalGainsTax: 46106.3, chargeableGain: 150000, exemptShare: 0 }
  },
  {
    id: 'C7',
    note: 'C4b owned jointly by a married couple in 2027: two exemptions, 2 x (32,000 - 1,270) x 31%',
    command: 'year',
    request: { input: { year: 2027, status: 'married_or_civil_partners', people: couple, events: [sale({ personId: 'joint', disposalDate: '2027-03-01', proceeds: 320_000, sellingCosts: 6_000, acquisitionCost: 250_000, acquisitionDate: '2005-05-01', homeUse: 'unknown' })] } },
    expected: { capitalGainsTax: 19052.6, chargeableGain: 64000, lossesCarriedForward: { a: 0, b: 0 } }
  },
  {
    id: 'C8',
    note: 'The family home throughout: principal private residence relief asserted, no tax',
    command: 'year',
    request: { input: { year: 2027, status: 'single', people: [single('a', 55)], events: [sale({ disposalDate: '2027-03-01', proceeds: 650_000, acquisitionCost: 300_000, acquisitionDate: '2010-01-01', homeUse: 'throughout' })] } },
    expected: { capitalGainsTax: 0, chargeableGain: 0 }
  },
  {
    id: 'C9',
    note: "Jointly assessed: a's €10,000 loss is set against b's €40,000 gain. (40,000 - 10,000 - 1,270) x 31%",
    command: 'year',
    request: { input: { year: 2027, status: 'married_or_civil_partners', people: couple, events: [
      sale({ personId: 'a', disposalDate: '2027-03-01', proceeds: 190_000, acquisitionCost: 200_000, acquisitionDate: '2008-01-01' }),
      sale({ personId: 'b', disposalDate: '2027-05-01', proceeds: 290_000, acquisitionCost: 250_000, acquisitionDate: '2009-01-01' })
    ] } },
    expected: { capitalGainsTax: 8906.3, lossesCarriedForward: { a: 0, b: 0 } }
  },
  {
    id: 'C10',
    note: 'A €30,000 loss carried in from earlier years against a €50,000 gain in 2028: (50,000 - 30,000 - 1,270) x 31%',
    command: 'year',
    request: {
      state: { people: { a: { cgtLossesCarriedForward: 30_000 } } },
      input: { year: 2028, status: 'single', people: [single('a', 62)], events: [sale({ disposalDate: '2028-04-01', proceeds: 300_000, acquisitionCost: 250_000, acquisitionDate: '2010-01-01' })] }
    },
    expected: { capitalGainsTax: 5806.3, chargeableGain: 50000, lossesCarriedForward: { a: 0 } }
  }
]);

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
    // Held forward from the 2027 block (Budget 2027, announced). By hand: 20% of 40,000 is 8,000, less credits of
    // 2,125 personal + 245 age + 2,125 employee (s.784A treats ARF payments as emoluments) = 3,505. USC: 12,012 at
    // 0.5% + 18,288 at 2% + 9,700 at 3% = 60.06 + 365.76 + 291 = 716.82. PRSI 4.7% of 40,000 = 1,880.
    // 40,000 - 3,505 - 716.82 - 1,880 = 33,898.18. (On the 2026 rules this case was 3,755, 732.82 and 33,632.18.)
    expected: { incomeTax: 3505, usc: 716.82, prsi: 1880, netIncome: 33898.18, prsiRate: 0.047 }
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
    // As G10a for income tax (3,505). Age 70: reduced USC, 12,012 at 0.5% + 27,988 at 2% = 60.06 + 559.76 = 619.82,
    // which the 2% ceiling does not touch. No PRSI from 70. 40,000 - 3,505 - 619.82 = 35,875.18.
    expected: { incomeTax: 3505, usc: 619.82, prsi: 0, netIncome: 35875.18 }
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
  },
  ...CGT_GOLDEN_CASES
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

function checkGoldenCapitalGains(goldenCase) {
  const outcome = runGoldenCaseInEngine(goldenCase);
  const { result, nextState } = outcome;
  const expected = goldenCase.expected;
  const record = result.capitalGains.disposals[0];
  assertCents(result.totals.capitalGainsTax, expected.capitalGainsTax, `${goldenCase.id} capital gains tax`);
  assertCents(
    result.capitalGains.disposals.reduce((total, entry) => total + entry.tax, 0),
    expected.capitalGainsTax,
    `${goldenCase.id} tax attributed to the sales`
  );
  assertCents(result.totals.totalTax, expected.capitalGainsTax, `${goldenCase.id} total tax is the CGT alone`);
  assertCents(result.totals.netIncome, 0, `${goldenCase.id} a sale is not income`);
  if (typeof expected.chargeableGain === 'number') {
    assertCents(record.chargeableGain, expected.chargeableGain, `${goldenCase.id} chargeable gain`);
  }
  if (typeof expected.multiplier === 'number') {
    assert(record.indexation.multiplier === expected.multiplier, `${goldenCase.id} multiplier ${record.indexation.multiplier}`);
  }
  if (typeof expected.rate === 'number') {
    assert(record.rate === expected.rate, `${goldenCase.id} rate ${record.rate}`);
  }
  if (typeof expected.exemptShare === 'number') {
    assertCents(record.section604A.exemptShare, expected.exemptShare, `${goldenCase.id} s.604A exempt share`);
  }
  if (expected.outcome) {
    assert(record.outcome === expected.outcome, `${goldenCase.id} outcome ${record.outcome}`);
  }
  Object.entries(expected.lossesCarriedForward || {}).forEach(([personId, amount]) => {
    assertCents(nextState.people[personId].cgtLossesCarriedForward, amount, `${goldenCase.id} losses carried forward for ${personId}`);
  });
  return result;
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
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [{ type: 'benefitCrystallisation', personId: 'a' }] }, /input\.events\[0\]\.fundValue/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2027-01-01', proceeds: 1, acquisitionCost: 1, acquisitionDate: '2010-01-01' })] }, /input\.events\[0\]\.disposalDate 2027-01-01 is not in the tax year 2026/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2026-02-30', proceeds: 1, acquisitionCost: 1, acquisitionDate: '2010-01-01' })] }, /input\.events\[0\]\.disposalDate "2026-02-30" is not a real date/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2026-05-01', proceeds: 1, acquisitionCost: 1, acquisitionDate: '01/01/2010' })] }, /input\.events\[0\]\.acquisitionDate must be a date written YYYY-MM-DD/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2026-05-01', proceeds: 1, acquisitionCost: 1, acquisitionDate: '2026-06-01' })] }, /input\.events\[0\]\.acquisitionDate 2026-06-01 is after the disposalDate/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2026-05-01', proceeds: 1, acquisitionCost: 1, acquisitionDate: '1974-04-05' })] }, /input\.events\[0\]\.acquisitionDate 1974-04-05 is before 6 April 1974/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2026-05-01', proceeds: -1, acquisitionCost: 1, acquisitionDate: '2010-01-01' })] }, /input\.events\[0\]\.proceeds/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2026-05-01', proceeds: 1, acquisitionDate: '2010-01-01' })] }, /input\.events\[0\]\.acquisitionCost/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2026-05-01', proceeds: 1, acquisitionCost: 1, acquisitionDate: '2010-01-01', sellingCosts: -2 })] }, /input\.events\[0\]\.sellingCosts/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2026-05-01', proceeds: 1, acquisitionCost: 1, acquisitionDate: '2010-01-01', acquiredBy: 'bought' })] }, /input\.events\[0\]\.acquiredBy must be one of/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2026-05-01', proceeds: 1, acquisitionCost: 1, acquisitionDate: '2010-01-01', homeUse: 'sometimes' })] }, /input\.events\[0\]\.homeUse must be one of/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ personId: 'joint', disposalDate: '2026-05-01', proceeds: 1, acquisitionCost: 1, acquisitionDate: '2010-01-01' })] }, /input\.events\[0\]\.personId "joint" splits a sale between two people/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], events: [sale({ personId: 'z', disposalDate: '2026-05-01', proceeds: 1, acquisitionCost: 1, acquisitionDate: '2010-01-01' })] }, /input\.events\[0\]\.personId must match/],
  [{ year: 2026, status: 'single', people: [single('a', 60)], items: [item('a', 'propertyDisposal', 5)] }, /input\.items\[0\]\.type "propertyDisposal" is not a recognised type/]
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

  cases.push(runCase('resolveTaxRules(2040) holds the 2027 Budget figures and the legislated end points', () => {
    const rules = resolveTaxRules(2040);
    const base = resolveTaxRules(2027);
    assert(rules.rulesYear === 2027, 'rulesYear 2027');
    assert(rules.heldForward === true, 'heldForward');
    assert(base.heldForward === false, '2027 is not held forward');
    assert(rules.incomeTax.standardRateBand.single === 46_500, 'single band €46,500');
    assert(rules.sft.amount === 2_800_000 && rules.sftBasis === 'held', 'SFT €2.8m held');
    assertCents(rules.prsi.rate * 1e4, 0.047 * 1e4, 'PRSI 4.7%');
    assert(rules.status === 'announced' && rules.announcedBy === 'Budget 2027' && rules.enactedBy === undefined, 'announced, not yet law');
    assert(rules.version === DEFAULT_IE_TAX_CATALOGUE.version, 'version');
    assert(resolveTaxRules(2026).status === 'enacted' && resolveTaxRules(2026).enactedBy === 'Finance Act 2025', '2026 is still enacted');
  }));

  cases.push(runCase('No year after 2027 produces different bands, credits, exemption limits or USC thresholds', () => {
    const base = resolveTaxRules(2027);
    for (let year = 2028; year <= 2110; year += 1) {
      const rules = resolveTaxRules(year);
      ['incomeTax', 'ageExemption', 'usc', 'lumpSum'].forEach((key) => {
        assert(JSON.stringify(rules[key]) === JSON.stringify(base[key]), `${key} changed in ${year}`);
      });
    }
  }));

  cases.push(runCase('Budget 2027 changes the bands, the main credits and the USC 2% ceiling, and leaves every other rule as it was', () => {
    const before = resolveTaxRules(2026);
    const after = resolveTaxRules(2027);
    const band = after.incomeTax.standardRateBand;
    assert(band.single === 46_500 && band.widowed === 46_500 && band.marriedOneIncome === 55_500 && band.secondIncomeIncreaseMax === 37_500, 'bands');
    assert(before.incomeTax.standardRateBand.single === 44_000 && before.incomeTax.standardRateBand.marriedOneIncome === 53_000, '2026 bands untouched');
    const credit = after.incomeTax.personalCredit;
    assert(credit.single === 2_125 && credit.married === 4_250, 'personal credits');
    assert(credit.widowed === credit.single + 540, 'widowed is the personal credit plus the 540 widowed person credit (s.461A)');
    assert(after.incomeTax.employeeCredit.amount === 2_125, 'employee credit');
    assert(after.usc.bands[1].upTo === 30_300 && before.usc.bands[1].upTo === 28_700, 'the 2% ceiling');
    assert(after.usc.bands[0].upTo === 12_012 && after.usc.bands[2].upTo === 70_044 && after.usc.bands[3].rate === 0.08, 'the other USC bands');
    for (const key of ['ageExemption', 'lumpSum', 'dirt']) {
      assert(after[key] === before[key], `${key} is the 2026 rule itself, not a copy`);
    }
    // The resolver rebuilds these two, so they are compared by content.
    for (const key of ['chargeableExcessTax', 'capitalGainsTax']) {
      assert(JSON.stringify(after[key]) === JSON.stringify(before[key]), `${key} is unchanged`);
    }
    assert(after.incomeTax.ageCredit === before.incomeTax.ageCredit, 'the age credit is the 2026 rule itself');
    assert(after.usc.reduced === before.usc.reduced && after.usc.surcharge === before.usc.surcharge, 'reduced USC and the surcharge are the 2026 rules');
    assert(after.prsi.liableUnderAge === before.prsi.liableUnderAge && after.prsi.exemptFromAge === before.prsi.exemptFromAge, 'PRSI age rules');
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

  /**
   * Nursing home fees, relieved at the payer's marginal rate (Revenue, Tax and
   * Duty Manual Part 15-01-12, section 4). The first two are the Manual's own
   * Examples 1 and 2, with the figures for the nursing home fees alone: the
   * Manual adds a 20% credit on its other health expenses, which is not here.
   */
  const nursingHome = (people, items, fees, status = 'single') => {
    const year = (extra) => computeTaxYear({ input: { year: 2026, status, people, items: [...items, ...extra] } }).result;
    const without = year([]);
    const withFees = year(fees === 0 ? [] : [item(people[0].id, 'nursingHomeExpenses', fees)]);
    return {
      without,
      withFees,
      relief: without.totals.incomeTax - withFees.totals.incomeTax
    };
  };

  cases.push(runCase('Nursing home fees come off income at the highest rate of tax paid, as in Revenue’s Manual', () => {
    const higher = nursingHome([single('a', 55)], [item('a', 'employment', 60_000)], 3_000);
    assertCents(higher.without.totals.incomeTax, 11_200, 'the Manual: tax paid before relief on 60,000 is 11,200');
    assertCents(higher.withFees.totals.incomeTax, 10_000, 'taxable income 57,000, tax 14,000, less 4,000 of credits');
    assertCents(higher.relief, 1_200, 'Example 1: 3,000 of fees at 40%');
    const straddling = nursingHome([single('a', 55)], [item('a', 'employment', 46_000)], 9_000);
    assertCents(straddling.without.totals.incomeTax, 5_600, 'the Manual: tax paid before relief on 46,000 is 5,600');
    assertCents(straddling.relief, 2_200, 'Example 2: 2,000 at 40% and 7,000 at 20%');
    const standard = nursingHome([single('a', 55)], [item('a', 'employment', 30_000)], 5_000);
    assertCents(standard.relief, 1_000, 'a standard-rate payer gets 20%');
  }));

  cases.push(runCase('Nursing home fee relief is never more than the income tax there is to relieve', () => {
    const exempt = nursingHome([single('a', 70)], [item('a', 'occupationalPension', 15_000)], 8_000);
    assertCents(exempt.without.totals.incomeTax, 0, 'under the over-65 exemption there is no tax');
    assertCents(exempt.relief, 0, 'so no relief');
    const covered = nursingHome([single('a', 55)], [item('a', 'employment', 20_000)], 5_000);
    assertCents(covered.without.totals.incomeTax, 0, 'credits cover the tax on 20,000');
    assertCents(covered.relief, 0, 'so no relief');
    const huge = nursingHome([single('a', 55)], [item('a', 'employment', 30_000)], 50_000);
    assertCents(huge.withFees.totals.incomeTax, 0, 'fees above income leave no tax');
    assertCents(huge.relief, huge.without.totals.incomeTax, 'the relief is exactly the tax that was due, never more');
    assertCents(huge.withFees.assessments[0].incomeAfterNursingHome, 0, 'taxable income floors at nothing');
  }));

  cases.push(runCase('Nursing home fees change income tax only: USC and PRSI do not move', () => {
    const mixed = nursingHome([single('a', 55)], [item('a', 'employment', 60_000), item('a', 'rentalProfit', 12_000)], 20_000);
    assert(mixed.relief > 0, 'there is relief');
    assertCents(mixed.withFees.totals.usc, mixed.without.totals.usc, 'USC is charged on income before the deduction');
    assertCents(mixed.withFees.totals.prsi, mixed.without.totals.prsi, 'PRSI is charged on income before the deduction');
    assert(mixed.withFees.assessments[0].nursingHomeExpenses === 20_000, 'the assessment records the fees');
  }));

  cases.push(runCase('A jointly assessed couple’s nursing home fees come off their combined income', () => {
    const joint = nursingHome(
      [single('a', 60), single('b', 58)],
      [item('a', 'employment', 70_000), item('b', 'employment', 20_000)],
      10_000,
      'married_or_civil_partners'
    );
    assert(joint.withFees.assessments[0].basis === 'joint', 'one joint assessment');
    assertCents(joint.without.totals.incomeTax - joint.withFees.totals.incomeTax, 4_000, '10,000 of fees at 40% on the couple’s total');
    const byOther = computeTaxYear({
      input: {
        year: 2026, status: 'married_or_civil_partners', people: [single('a', 60), single('b', 58)],
        items: [item('a', 'employment', 70_000), item('b', 'employment', 20_000), item('b', 'nursingHomeExpenses', 10_000)]
      }
    }).result;
    assertCents(byOther.totals.incomeTax, joint.withFees.totals.incomeTax, 'either partner can pay and the relief is the same');
  }));

  cases.push(runCase('Nursing home fees are an income tax rule with a source, a disclosure and a refusal of negative amounts', () => {
    const rules = resolveTaxRules(2026);
    assert(rules.incomeTax.nursingHomeExpenses.ruleId === 'ie.income_tax.nursing_home_expenses.2026', 'the rule has an id');
    assert(rules.incomeTax.nursingHomeExpenses.sources.length === 2, 'Revenue’s page and the Manual are the sources');
    assert(resolveTaxRules(2031).incomeTax.nursingHomeExpenses.ruleId === rules.incomeTax.nursingHomeExpenses.ruleId, 'held forward');
    const withFees = nursingHome([single('a', 55)], [item('a', 'employment', 60_000)], 3_000);
    assert(withFees.withFees.disclosureCodes.includes('IT_NURSING_HOME_RELIEF'), 'the relief is disclosed');
    assert(!withFees.without.disclosureCodes.includes('IT_NURSING_HOME_RELIEF'), 'and only when fees are paid');
    assertThrows(() => nursingHome([single('a', 55)], [item('a', 'employment', 60_000)], -1), /greater than or equal to 0/, 'negative fees');
    assert(!/medical expenses/.test(taxNotIncludedLine()), 'medical expenses are no longer listed as not modelled in full');
  }));

  /**
   * Illness Benefit (plan section 6, "Approved illness-scenario assumption"):
   * the recipient's own taxable income, income tax only. It earns the
   * recipient's Employee Tax Credit and counts as the recipient's income for the
   * extra standard rate band of a jointly assessed couple. Every figure comes
   * from the selected year's rules.
   */
  const illnessYear = (people, items, status = 'single', yearNumber = 2026) => computeTaxYear({
    input: { year: yearNumber, status, people, items }
  }).result;
  const couple = [single('a', 45), single('b', 45)];

  cases.push(runCase('Illness Benefit is income tax only: no USC and no PRSI, and the same USC and PRSI as without it', () => {
    const payOnly = illnessYear([single('a', 45)], [item('a', 'illnessBenefit', 13_208)]);
    assertCents(payOnly.totals.usc, 0, 'no USC on the benefit');
    assertCents(payOnly.totals.prsi, 0, 'no PRSI on the benefit');
    assertCents(payOnly.totals.incomeTax, 0, '13,208 at 20% is 2,641.60, less the personal and employee credits');
    assertCents(payOnly.totals.netIncome, 13_208, 'all of it is left after tax');
    assert(payOnly.people[0].income.illnessBenefit === 13_208, 'it is recorded as its own income type');
    const salaryOnly = illnessYear([single('a', 45)], [item('a', 'employment', 30_000)]);
    const both = illnessYear([single('a', 45)], [item('a', 'employment', 30_000), item('a', 'illnessBenefit', 10_000)]);
    assertCents(both.totals.usc, salaryOnly.totals.usc, 'USC does not move');
    assertCents(both.totals.prsi, salaryOnly.totals.prsi, 'PRSI does not move');
    assert(both.totals.incomeTax > salaryOnly.totals.incomeTax, 'income tax does');
    assertCents(both.totals.incomeTax - salaryOnly.totals.incomeTax, 2_000, 'at the 20% rate on 10,000 of benefit, all inside the standard rate band');
    assert(both.people[0].usc.aggregateIncome === 30_000, 'USC aggregate income leaves the benefit out');
    assert(both.people[0].prsi.prsiableIncome === 30_000, 'PRSI base leaves the benefit out');
  }));

  cases.push(runCase('Illness Benefit earns the recipient’s own Employee Tax Credit, below and above the credit threshold', () => {
    const rules = resolveTaxRules(2026);
    const credit = rules.incomeTax.employeeCredit;
    const threshold = credit.amount / credit.maxShareOfQualifyingIncome;
    // With 20,000 of other taxed income the tax is 20% of the lot, so the credit shows as euros of tax.
    const run = (benefit) => illnessYear(
      [single('a', 45)],
      [item('a', 'rentalProfit', 32_000 - benefit), item('a', 'illnessBenefit', benefit)]
    );
    const below = run(threshold / 2);
    assertCents(below.assessments[0].credits.employee.a, credit.amount / 2, 'half the threshold earns half the credit');
    const above = run(threshold + 2_208);
    assertCents(above.assessments[0].credits.employee.a, credit.amount, 'above the threshold earns the full credit');
    const at = run(threshold);
    assertCents(at.assessments[0].credits.employee.a, credit.amount, 'exactly at the threshold earns the full credit');
    const none = run(0);
    assertCents(none.assessments[0].credits.employee.a ?? 0, 0, 'no benefit and no earnings, no credit');
    assertCents(none.totals.incomeTax - above.totals.incomeTax, credit.amount, 'the credit is worth its full amount in tax');
  }));

  cases.push(runCase('Illness Benefit in a jointly assessed couple: the extra band belongs to the recipient (the plan’s worked example)', () => {
    const rules = resolveTaxRules(2026);
    const band = rules.incomeTax.standardRateBand;
    const sick = illnessYear(couple, [item('a', 'employment', 75_000), item('b', 'illnessBenefit', 13_208)], 'married_or_civil_partners');
    assertCents(sick.assessments[0].bandIncrease, 13_208, 'the increase is the recipient’s 13,208');
    assertCents(sick.assessments[0].standardRateBand, 66_208, 'the plan’s 66,208 combined 20% band');
    assertCents(sick.assessments[0].standardRateBand, band.marriedOneIncome + 13_208, 'built from the year’s own band, not typed in');
    // The same benefit paid to the earner, with the other person on nothing, is one income: no increase.
    const earnerSick = illnessYear(couple, [item('a', 'employment', 75_000), item('a', 'illnessBenefit', 13_208)], 'married_or_civil_partners');
    assertCents(earnerSick.assessments[0].bandIncrease, 0, 'a second income is needed for an increase');
    assertCents(earnerSick.assessments[0].standardRateBand, band.marriedOneIncome, 'so the band is the one-income band');
    // Hand check of the first: 88,208 taxable, 66,208 at 20% and 22,000 at 40%, less 4,000 and two 2,000 credits.
    assertCents(sick.totals.incomeTax, (66_208 * 0.2) + (22_000 * 0.4) - 8_000, 'income tax by hand');
    assertCents(sick.assessments[0].credits.employee.b, 2_000, 'the recipient has their own employee credit');
    assertCents(sick.assessments[0].credits.employee.a, 2_000, 'the earner has theirs');
    const alone = illnessYear(couple, [item('a', 'employment', 75_000)], 'married_or_civil_partners');
    assertCents(sick.totals.usc, alone.totals.usc, 'USC is the earner’s alone');
    assertCents(sick.totals.prsi, alone.totals.prsi, 'PRSI is the earner’s alone');
    assert(sick.assessments[0].bandIncrease <= band.secondIncomeIncreaseMax, 'and never above the cap');
  }));

  cases.push(runCase('Illness Benefit: the band increase is capped, shared by two recipients and never moves between people', () => {
    const band = resolveTaxRules(2026).incomeTax.standardRateBand;
    const bothSick = illnessYear(couple, [item('a', 'illnessBenefit', 13_208), item('b', 'illnessBenefit', 13_208)], 'married_or_civil_partners');
    assertCents(bothSick.assessments[0].bandIncrease, 13_208, 'the lower person’s income');
    assertCents(bothSick.totals.incomeTax, 0, '26,416 at 20%, less 4,000 and two 2,000 credits, never below nothing');
    const capped = illnessYear(couple, [item('a', 'employment', 80_000), item('b', 'illnessBenefit', band.secondIncomeIncreaseMax + 20_000)], 'married_or_civil_partners');
    assertCents(capped.assessments[0].bandIncrease, band.secondIncomeIncreaseMax, 'the cap holds');
    // The employee credit stays with the person who has the income.
    const lowEarnerSick = illnessYear(couple, [item('a', 'employment', 60_000), item('b', 'illnessBenefit', 4_000)], 'married_or_civil_partners');
    assertCents(lowEarnerSick.assessments[0].credits.employee.b, 800, 'the recipient’s credit is 20% of their own 4,000');
    assertCents(lowEarnerSick.assessments[0].credits.employee.a, 2_000, 'the earner’s credit is not topped up or shared');
    const noBenefit = illnessYear(couple, [item('a', 'employment', 60_000)], 'married_or_civil_partners');
    assertCents(noBenefit.assessments[0].credits.employee.b, 0, 'with no income of their own the other person has no credit to receive');
  }));

  cases.push(runCase('Illness Benefit of nothing changes nothing, and is not mentioned', () => {
    const base = illnessYear(couple, [item('a', 'employment', 70_000)], 'married_or_civil_partners');
    const zero = illnessYear(couple, [item('a', 'employment', 70_000), item('b', 'illnessBenefit', 0)], 'married_or_civil_partners');
    assertCents(zero.totals.incomeTax, base.totals.incomeTax, 'the same income tax');
    assertCents(zero.assessments[0].standardRateBand, base.assessments[0].standardRateBand, 'the same band');
    assertCents(zero.totals.netIncome, base.totals.netIncome, 'the same net income');
    assert(!zero.disclosureCodes.includes('IT_ILLNESS_BENEFIT'), 'no disclosure for a benefit of nothing');
    assert(illnessYear(couple, [item('b', 'illnessBenefit', 1)], 'married_or_civil_partners').disclosureCodes.includes('IT_ILLNESS_BENEFIT'), 'and one for any payment');
  }));

  cases.push(runCase('Illness Benefit is refused when shared or negative, and has a rule with an id and sources', () => {
    assertThrows(
      () => illnessYear(couple, [item('joint', 'illnessBenefit', 10_000)], 'married_or_civil_partners'),
      /recipient's own income/,
      'a shared benefit'
    );
    assertThrows(() => illnessYear([single('a', 45)], [item('a', 'illnessBenefit', -1)]), /greater than or equal to 0/, 'a negative benefit');
    const rules = resolveTaxRules(2026);
    assert(rules.incomeTax.illnessBenefit.ruleId === 'ie.income_tax.illness_benefit.2026', 'the rule has an id');
    assert(rules.incomeTax.illnessBenefit.sources.length === 3, 'Revenue’s benefit, credit and joint assessment pages');
    assert(resolveTaxRules(2027).incomeTax.illnessBenefit.ruleId === rules.incomeTax.illnessBenefit.ruleId, 'carried into the next year');
    assert(resolveTaxRules(2031).incomeTax.illnessBenefit.ruleId === rules.incomeTax.illnessBenefit.ruleId, 'held forward');
  }));

  cases.push(runCase('Illness Benefit: the same household in any order gives the same answers and changes no input', () => {
    const makeInput = (benefit, salary) => deepFreeze({
      year: 2026,
      status: 'married_or_civil_partners',
      people: [single('a', 45), single('b', 45)],
      items: [item('a', 'employment', salary), item('b', 'illnessBenefit', benefit)]
    });
    const sickInput = makeInput(13_208, 75_000);
    const wellInput = deepFreeze({
      year: 2026,
      status: 'married_or_civil_partners',
      people: [single('a', 45), single('b', 45)],
      items: [item('a', 'employment', 75_000), item('b', 'employment', 40_000)]
    });
    const run = (input) => JSON.stringify(computeTaxYear({ input }).result);
    const firstSick = run(sickInput);
    const firstWell = run(wellInput);
    // sick, well, sick and well, sick, well: each run starts afresh.
    assert(run(wellInput) === firstWell, 'well after sick');
    assert(run(sickInput) === firstSick, 'sick after well');
    assert(run(sickInput) === firstSick && run(wellInput) === firstWell, 'and again');
    assert(sickInput.items.length === 2 && sickInput.items[1].amount === 13_208, 'the input is as it was');
  }));

  cases.push(runCase('The Bereaved Partner’s Contributory Pension is treated like Illness Benefit: income tax only, the recipient’s own income', () => {
    const survivor = (items, status = 'widowed_or_surviving_civil_partner') => illnessYear([single('a', 45)], items, status);
    const pensionOnly = survivor([item('a', 'bereavedPartnerPension', 13_494)]);
    assertCents(pensionOnly.totals.usc, 0, 'no USC');
    assertCents(pensionOnly.totals.prsi, 0, 'no PRSI');
    assert(pensionOnly.people[0].income.bereavedPartnerPension === 13_494, 'its own income type, not the State Pension');
    assert(pensionOnly.people[0].income.statePension === 0, 'never entered as a State Pension');
    assert(pensionOnly.disclosureCodes.includes('IT_BEREAVED_PARTNER_PENSION') && !pensionOnly.disclosureCodes.includes('USC_STATE_PENSION_EXEMPT'), 'and described as itself');
    const withSalary = survivor([item('a', 'employment', 30_000), item('a', 'bereavedPartnerPension', 10_000)]);
    const salaryOnly = survivor([item('a', 'employment', 30_000)]);
    assertCents(withSalary.totals.usc, salaryOnly.totals.usc, 'USC does not move');
    assertCents(withSalary.totals.prsi, salaryOnly.totals.prsi, 'PRSI does not move');
    assert(withSalary.totals.incomeTax > salaryOnly.totals.incomeTax, 'income tax does');
    assertThrows(() => illnessYear(couple, [item('joint', 'bereavedPartnerPension', 1)], 'married_or_civil_partners'), /recipient's own income/, 'never shared');
    const joint = illnessYear(couple, [item('a', 'employment', 75_000), item('b', 'illnessBenefit', 13_208)], 'married_or_civil_partners').assessments[0];
    assertCents(joint.taxableIncomeByPerson.a, 75_000, 'each person’s taxable income is reported, for allocating a joint assessment');
    assertCents(joint.taxableIncomeByPerson.b, 13_208, 'including the benefit');
  }));

  cases.push(runCase('Every disclosure renders in plain words, with its figures filled in and no em dashes', () => {
    const rules = resolveTaxRules(2031);
    const params = {
      IT_AGE_EXEMPTION: { years: [2031, 2032, 2033, 2035] },
      IT_MARGINAL_RELIEF: { years: [2031] },
      IT_NURSING_HOME_RELIEF: { years: [2031] },
      OTHER_INCOME_AS_PENSION: { title: 'Land lease income' },
      LUMP_SUM_PRIOR: { amount: 150_000 },
      SFT_THRESHOLD: { amount: 2_800_000, years: [2031] },
      SFT_HELD: { heldAmount: 2_800_000, years: [2031] },
      SFT_CET: { rate: 0.4 },
      SFT_CREDIT: { amount: 30_000 },
      SFT_ALREADY_USED: { amount: 400_000 },
      CGT_RATE: { rate: 0.31, exemption: 1_270 },
      CGT_RATE_ANNOUNCED: { rate: 0.31, effectiveFrom: '2026-10-07', announcedBy: 'Budget 2027' },
      CGT_INDEXATION: { period: '1986/87', multiplier: 1.637 },
      CGT_INDEXATION_NO_GAIN: { period: '1986/87', multiplier: 1.637 },
      CGT_2011_2014: { share: 0.5185 },
      CGT_LOSSES_USED: { amount: 30_000 },
      CGT_LOSS_SPOUSE: { amount: 10_000 },
      CGT_LOSS_CARRIED: { amount: 200 },
      PENSION_AT_RELIEF_LIMIT: { share: 0.25, earningsCap: 115_000 },
      INVESTMENT_FUND_TAX: { rate: 0.38 },
      INVESTMENT_FUND_TAX_ANNOUNCED: { rate: 0.35, effectiveFrom: '2027-01-01', announcedBy: 'Budget 2027', inForce: false },
      INVESTMENT_ACCOUNT: { asOf: '2026-10-14' }
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

  CGT_GOLDEN_CASES.forEach((goldenCase) => {
    cases.push(runCase(`${goldenCase.id}: capital gains tax on property to the cent`, () => {
      checkGoldenCapitalGains(goldenCase);
    }));
  });

  cases.push(runCase('CGT disclosures say what was applied and what was assumed', () => {
    const codes = (id) => checkGoldenCapitalGains(golden(id)).disclosureCodes;
    assert(codes('C1').includes('CGT_INDEXATION') && codes('C1').includes('CGT_COSTS_ENTERED'), 'C1 names indexation and the costs deducted');
    assert(codes('C3').includes('CGT_INDEXATION_NO_GAIN'), 'C3 says there is no gain and no loss');
    assert(codes('C2').includes('CGT_LOSS_CARRIED'), 'C2 carries its loss forward');
    assert(!codes('C4a').includes('CGT_RATE_ANNOUNCED') && codes('C4b').includes('CGT_RATE_ANNOUNCED'), 'only the 31% rate is flagged as announced');
    assert(codes('C5').includes('CGT_2011_2014'), 'C5 applies the 2011 to 2014 relief');
    assert(codes('C6').includes('CGT_2011_2014_NOT_BOUGHT'), 'C6 says why the relief is not applied');
    assert(codes('C7').includes('CGT_HOME_UNKNOWN') && codes('C7').includes('CGT_JOINT_SPLIT'), 'C7 flags a possible former home and the split');
    assert(!codes('C1').includes('CGT_HOME_UNKNOWN'), 'a property never lived in raises no home note');
    const c8 = codes('C8');
    assert(c8.includes('CGT_HOME_EXEMPT') && !c8.includes('CGT_RATE') && !c8.includes('CGT_OTHER_GAINS'), 'the family home raises only its own line');
    assert(codes('C9').includes('CGT_LOSS_SPOUSE'), 'C9 says a loss moved between spouses');
    assert(codes('C10').includes('CGT_LOSSES_USED') && !codes('C10').includes('CGT_OTHER_GAINS'), 'C10 says earlier losses were used');
    const rules = resolveTaxRules(2027);
    const relief = renderTaxDisclosure({ code: 'CGT_2011_2014', params: { share: 0.5 } }, { rules }).text;
    assert(relief.includes('7 December 2011 and 31 December 2014') && relief.includes('50% of the gain'), `relief wording: ${relief}`);
    const whole = renderTaxDisclosure({ code: 'CGT_2011_2014', params: { share: 1 } }, { rules }).text;
    assert(whole.includes('the whole gain is exempt'), `whole relief wording: ${whole}`);
  }));

  cases.push(runCase('Indexation multipliers follow the statute, by tax year of purchase', () => {
    const rules = IE_CGT_FIXED_RULES.indexation;
    assert(rules.periods.length === 29, '27 April-to-April years, then 2001 and 2002');
    [
      ['1974-04-06', 7.528, '1974/75'],
      ['1975-04-05', 7.528, '1974/75'],
      ['1975-04-06', 6.08, '1975/76'],
      ['1986-09-01', 1.637, '1986/87'],
      ['1999-12-31', 1.193, '1999/00'],
      ['2001-04-05', 1.144, '2000/01'],
      ['2001-04-06', 1.087, '2001'],
      ['2001-12-31', 1.087, '2001'],
      ['2002-01-01', 1.049, '2002'],
      ['2002-12-31', 1.049, '2002'],
      ['2003-01-01', 1, null],
      ['2013-06-15', 1, null]
    ].forEach(([date, multiplier, period]) => {
      const found = indexationMultiplier(date, rules);
      assert(found.multiplier === multiplier && found.period === period, `${date}: expected ${multiplier} (${period}), got ${found.multiplier} (${found.period})`);
    });
    assertThrows(() => indexationMultiplier('1974-04-05', rules), /before 6 April 1974/, 'before April 1974');
    let previous = Infinity;
    rules.periods.forEach((entry) => {
      assert(entry.multiplier < previous && entry.multiplier > 1, `${entry.period} multipliers fall year by year`);
      previous = entry.multiplier;
    });
  }));

  cases.push(runCase('s.604A matches Revenue\'s examples and its date rules', () => {
    const rules = IE_CGT_FIXED_RULES.section604A;
    const share = (acquisitionDate, disposalDate, acquiredBy = 'purchase') => section604AShare({ acquisitionDate, disposalDate, acquiredBy }, rules);
    // TDM 19-07-03A Example 2: 10 years, 7/10 of a €300,000 gain exempt.
    assertCents(share('2012-03-01', '2022-03-01').exemptShare * 300_000, 210_000, 'ten years exactly');
    // Revenue's example sells a day after the anniversary. Part years are
    // counted exactly, so the relief is a little less, never more.
    const printed = share('2012-03-01', '2022-03-02').exemptShare * 300_000;
    assert(printed < 210_000 && printed > 209_900, `Example 2 as printed gives ${printed}`);
    // Example 1: just over 7 years. Example 3: 6 years, sold after 2018.
    assert(share('2014-03-01', '2021-03-01').exemptShare === 1, 'seven years exactly is fully exempt');
    assert(share('2014-03-01', '2021-03-02').exemptShare > 0.999, 'Example 1 is all but fully exempt');
    assert(share('2012-03-01', '2018-03-02').exemptShare === 1, 'Example 3: 4 to 7 years and sold from 2018');
    assert(share('2014-03-01', '2017-03-02').exemptShare === 0, 'held 3 years: no relief');
    assert(share('2012-03-01', '2017-03-02').exemptShare === 0, 'sold before 2018 after 5 years: no relief');
    assert(share('2011-12-07', '2025-12-07').inWindow && share('2014-12-31', '2028-12-31').inWindow, 'both end dates are included');
    assert(!share('2011-12-06', '2025-12-06').inWindow && !share('2015-01-01', '2029-01-01').inWindow, 'a day outside the dates is not');
    assert(share('2013-06-15', '2027-06-15', 'gift_or_inheritance').exemptShare === 0, 'a gift or inheritance does not qualify');
    assertCents(yearsBetween('2013-06-15', '2027-12-15'), 14 + 183 / 366, 'part years are measured in days of that year');
    assertCents(yearsBetween('2012-02-29', '2013-02-28'), 1, 'a 29 February purchase reaches its anniversary on the 28th');
  }));

  cases.push(runCase('A loss is allowable only where a gain would be chargeable', () => {
    const cgtRules = resolveTaxRules(2027).capitalGainsTax;
    const base = { personId: 'a', disposalDate: '2027-06-01', proceeds: 200_000, sellingCosts: 0, acquisitionCost: 260_000, acquisitionDate: '2013-06-01', acquiredBy: 'purchase', homeUse: 'never' };
    const relieved = computeDisposalGain(base, cgtRules);
    assertCents(relieved.allowableLoss, 60_000 * (1 - 0.5), 'half the loss on a 14-year s.604A holding');
    const home = computeDisposalGain({ ...base, acquisitionDate: '2005-06-01', homeUse: 'throughout' }, cgtRules);
    assertCents(home.allowableLoss, 0, 'no allowable loss on an exempt home');
  }));

  cases.push(runCase('Losses carry between years through the state, and survive JSON', () => {
    const loss = computeTaxYear({ input: { year: 2027, status: 'single', people: [single('a', 60)], events: [sale({ disposalDate: '2027-02-01', proceeds: 200_000, acquisitionCost: 230_000, acquisitionDate: '2008-01-01' })] } });
    assertCents(loss.nextState.people.a.cgtLossesCarriedForward, 30_000, 'the loss is carried');
    const roundTripped = JSON.parse(JSON.stringify(loss.nextState));
    const gain = computeTaxYear({ state: roundTripped, input: golden('C10').request.input });
    assertCents(gain.result.totals.capitalGainsTax, golden('C10').expected.capitalGainsTax, 'the carried loss is used the next year');
    assertCents(gain.nextState.people.a.cgtLossesCarriedForward, 0, 'and used up');
    const small = computeTaxYear({ state: { people: { a: { cgtLossesCarriedForward: 30_000 } } }, input: { year: 2028, status: 'single', people: [single('a', 62)], events: [sale({ disposalDate: '2028-04-01', proceeds: 260_000, acquisitionCost: 250_000, acquisitionDate: '2010-01-01' })] } });
    assertCents(small.result.totals.capitalGainsTax, 0, 'losses come before the exemption');
    assertCents(small.nextState.people.a.cgtLossesCarriedForward, 20_000, 'only what the gain needs is used');
  }));

  cases.push(runCase('A property sale works with marginalTax, leaves its arguments alone and does not change income tax', () => {
    const input = deepFreeze({ year: 2027, status: 'single', people: [single('a', 55)], items: [item('a', 'employment', 80_000)] });
    const delta = deepFreeze(sale({ disposalDate: '2027-06-15', proceeds: 400_000, acquisitionCost: 250_000, acquisitionDate: '2013-06-15' }));
    const marginal = marginalTax({ input, delta });
    assertCents(marginal.byHead.capitalGainsTax, 22856.3, 'the extra tax is the CGT');
    assertCents(marginal.byHead.incomeTax, 0, 'no change to income tax');
    assertCents(marginal.total, 22856.3, 'total');
    assertCents(marginal.netIncomeChange, 0, 'a sale is not income');
  }));

  cases.push(runCase('DIRT is a catalogue rate: 33% in 2026, held forward unchanged in 2031', () => {
    const base = resolveTaxRules(2026);
    const later = resolveTaxRules(2031);
    assert(base.dirt.rate === 0.33, 'DIRT 33% in 2026');
    assert(base.dirt.ruleId === 'ie.dirt.2026', 'rule id');
    assert(base.dirt.sources.length === 1 && /revenue\.ie/.test(base.dirt.sources[0].url), 'Revenue is the source');
    assert(base.heldForward === false, '2026 is not held forward');
    assert(later.dirt.rate === 0.33, 'DIRT 33% in 2031');
    assert(later.heldForward === true && later.rulesYear === 2027, '2031 is held forward from the 2027 block');
    assert(resolveTaxRules(2027).dirt === base.dirt, 'the 2027 block carries the 2026 DIRT rule itself, not a copy');
    assert(later.dirt === base.dirt, 'the held block is the same rule, not a copy');
  }));

  cases.push(runCase('A catalogue with another DIRT rate resolves to it, and nothing else in the year moves', () => {
    const block = DEFAULT_IE_TAX_CATALOGUE.rulesByYear[2026];
    const changed = {
      ...DEFAULT_IE_TAX_CATALOGUE,
      rulesByYear: {
        ...DEFAULT_IE_TAX_CATALOGUE.rulesByYear,
        2026: { ...block, dirt: { ...block.dirt, rate: 0.4 } }
      }
    };
    const base = resolveTaxRules(2026);
    const rules = resolveTaxRules(2026, { catalogue: changed });
    assert(rules.dirt.rate === 0.4, 'the changed rate is read');
    ['incomeTax', 'usc', 'prsi', 'lumpSum', 'capitalGainsTax'].forEach((key) => {
      assert(JSON.stringify(rules[key]) === JSON.stringify(base[key]), `${key} must not move with DIRT`);
    });
  }));

  cases.push(runCase('Exit tax is read by date: 41% to 2025, 38% in 2026, 35% announced from 2027 and held after', () => {
    const rules = resolveTaxRules(2026);
    assert(exitTaxRateOn('2025-06-01', rules).rate === 0.41, '41% in 2025');
    const now = exitTaxRateOn('2026-10-14', rules);
    assert(now.rate === 0.38 && now.status === 'enacted' && now.enactedBy === 'Finance Act 2025', '38% in force, enacted');
    assert(/revenue\.ie/.test(now.source.url), 'Revenue is the source for 38%');
    const next = exitTaxRateOn('2027-01-01', rules);
    assert(next.rate === 0.35 && next.status === 'announced' && next.announcedBy === 'Budget 2027', '35% from 1 January 2027, announced');
    assert(exitTaxRateOn('2040-06-01', rules).rate === 0.35, 'the last rate is held');
    assertThrows(() => exitTaxRateOn('2014-12-31', rules), /No exit tax rate is recorded/, 'before the first entry');
    assertThrows(() => exitTaxRateOn('14/10/2026', rules), /YYYY-MM-DD/, 'a date in another format');
    assertThrows(() => exitTaxRateOn('2026-13-40', rules), /valid calendar date/, 'a date that does not exist');
    assertThrows(() => exitTaxRateOn('2026-02-30', rules), /valid calendar date/, 'the 30th of February');
    assert(exitTaxRateOn(' 2026-10-14 ', rules).rate === 0.38, 'spaces round a date are trimmed before it is compared');
    assert(afterTaxInvestmentDisclosures({ asOf: ' 2026-10-14 ', rules }).length === 3, 'and the notes read the trimmed date');
    assert(rules.investmentFunds.deemedDisposal.everyYears === 8, 'the eight-year rule');
    assert(JSON.stringify(resolveTaxRules(2031).investmentFunds) === JSON.stringify(rules.investmentFunds), 'held unchanged in later years');
  }));

  cases.push(runCase('Pension at the relief limit: the notes beside an after-tax investment, in October 2026', () => {
    const rules = resolveTaxRules(2026);
    const disclosures = afterTaxInvestmentDisclosures({
      asOf: '2026-10-14',
      rules,
      pensionAtReliefLimit: true,
      reliefLimit: { share: 0.25, earningsCap: 115_000 }
    });
    assert(JSON.stringify(disclosures.map((entry) => entry.code)) === JSON.stringify([
      'PENSION_AT_RELIEF_LIMIT', 'INVESTMENT_FUND_TAX', 'INVESTMENT_FUND_TAX_ANNOUNCED', 'INVESTMENT_ACCOUNT'
    ]), `codes: ${disclosures.map((entry) => entry.code)}`);
    const texts = renderTaxDisclosures(disclosures, { rules }).map((entry) => entry.text);
    const expected = [
      'Your pension contributions are at the most income tax relief allows at your age, 25% of earnings up to €115,000. Money you invest beyond that gets no income tax relief.',
      'Gains on investment funds, ETFs and investment life policies are taxed at 38% when you sell, and every eight years as if you had sold, even if you have not. Tax paid at each eight-year point is set against the tax due when you finally sell.',
      'A cut to 35% from 1 January 2027 was announced in Budget 2027. It could change before the Finance Act is passed.',
      'A new Investment Account was announced in Budget 2027 to open on 1 July 2027, taking up to €12,000 a year with no exit tax and no eight-year charge, and 1% a year on its value above €50,000. The details could change before they become law.'
    ];
    expected.forEach((text, index) => {
      assert(texts[index] === text, `note ${index + 1}:\n  got      ${texts[index]}\n  expected ${text}`);
    });
    const plain = afterTaxInvestmentDisclosures({ asOf: '2026-10-14', rules, includeInvestmentAccount: false });
    assert(JSON.stringify(plain.map((entry) => entry.code)) === JSON.stringify(['INVESTMENT_FUND_TAX', 'INVESTMENT_FUND_TAX_ANNOUNCED']), 'no pension note or account when not asked');
    const noFigures = renderTaxDisclosures(afterTaxInvestmentDisclosures({ asOf: '2026-10-14', rules, pensionAtReliefLimit: true }), { rules })[0].text;
    assert(noFigures === 'Your pension contributions are at the most income tax relief allows at your age. Money you invest beyond that gets no income tax relief.', `without the limit's figures: ${noFigures}`);
    assertThrows(() => afterTaxInvestmentDisclosures({ asOf: '2026-10', rules }), /YYYY-MM-DD/, 'asOf must be a date');
  }));

  cases.push(runCase('Before Budget day nothing is called announced: a date earlier than the announcement gets the law as it stood', () => {
    const rules = resolveTaxRules(2026);
    const before = afterTaxInvestmentDisclosures({ asOf: '2026-01-01', rules }).map((entry) => entry.code);
    assert(JSON.stringify(before) === JSON.stringify(['INVESTMENT_FUND_TAX']), `before Budget 2027: ${before}`);
    const onTheDay = afterTaxInvestmentDisclosures({ asOf: '2026-10-06', rules }).map((entry) => entry.code);
    assert(JSON.stringify(onTheDay) === JSON.stringify(['INVESTMENT_FUND_TAX', 'INVESTMENT_FUND_TAX_ANNOUNCED', 'INVESTMENT_ACCOUNT']), `on Budget day: ${onTheDay}`);
    assert(exitTaxRateOn('2026-01-01', rules).rate === 0.38, '38% at the start of 2026');
  }));

  cases.push(runCase('In 2027 the announced 35% is the rate in force, and the note still says it is not yet law', () => {
    const rules = resolveTaxRules(2027);
    const texts = renderTaxDisclosures(afterTaxInvestmentDisclosures({ asOf: '2027-03-01', rules, includeInvestmentAccount: false }), { rules })
      .map((entry) => entry.text);
    assert(texts[0].includes('taxed at 35% when you sell'), `rate in force: ${texts[0]}`);
    assert(texts[1] === 'The 35% rate was announced in Budget 2027 for gains from 1 January 2027. It could change before the Finance Act is passed.', `announced: ${texts[1]}`);
  }));

  cases.push(runCase('When the Finance Act passes, the not-yet-law notes fall away and the account note follows its start date', () => {
    const schedules = DEFAULT_IE_TAX_CATALOGUE.schedules;
    const enacted = {
      ...DEFAULT_IE_TAX_CATALOGUE,
      schedules: {
        ...schedules,
        investmentFundExitTaxRate: schedules.investmentFundExitTaxRate.map((entry) => (
          entry.status === 'announced' ? { ...entry, status: 'enacted', enactedBy: 'Finance Act 2026' } : entry
        ))
      },
      investmentRules: {
        ...IE_INVESTMENT_RULES,
        investmentAccount: { ...IE_INVESTMENT_RULES.investmentAccount, status: 'enacted' }
      }
    };
    const before = resolveTaxRules(2026, { catalogue: enacted });
    const beforeCodes = afterTaxInvestmentDisclosures({ asOf: '2026-10-14', rules: before }).map((entry) => entry.code);
    assert(JSON.stringify(beforeCodes) === JSON.stringify(['INVESTMENT_FUND_TAX', 'INVESTMENT_ACCOUNT']), `codes: ${beforeCodes}`);
    const opens = renderTaxDisclosures(afterTaxInvestmentDisclosures({ asOf: '2026-10-14', rules: before }), { rules: before })[1].text;
    assert(opens === 'A new Investment Account opens on 1 July 2027, taking up to €12,000 a year with no exit tax and no eight-year charge, and 1% a year on its value above €50,000.', `before it opens: ${opens}`);
    const after = resolveTaxRules(2027, { catalogue: enacted });
    const open = renderTaxDisclosures(afterTaxInvestmentDisclosures({ asOf: '2027-08-01', rules: after }), { rules: after }).map((entry) => entry.text);
    assert(open[0].includes('taxed at 35% when you sell'), `rate: ${open[0]}`);
    assert(open[1] === 'The Investment Account takes up to €12,000 a year with no exit tax and no eight-year charge, and 1% a year on its value above €50,000.', `once open: ${open[1]}`);
    // Once law, the announcement date still holds: a date before Budget day
    // gets the law as it then stood, with no account and no 35%.
    const earlier = afterTaxInvestmentDisclosures({ asOf: '2026-01-01', rules: before });
    assert(JSON.stringify(earlier.map((entry) => entry.code)) === JSON.stringify(['INVESTMENT_FUND_TAX']), `before Budget day, once enacted: ${earlier.map((entry) => entry.code)}`);
    assert(earlier[0].params.rate === 0.38, `38% before Budget day, once enacted: ${earlier[0].params.rate}`);
  }));

  cases.push(runCase('An exit tax schedule the law could not produce is refused', () => {
    const schedules = DEFAULT_IE_TAX_CATALOGUE.schedules;
    const reversed = {
      ...DEFAULT_IE_TAX_CATALOGUE,
      schedules: { ...schedules, investmentFundExitTaxRate: [...schedules.investmentFundExitTaxRate].reverse() }
    };
    assertThrows(() => resolveTaxRules(2026, { catalogue: reversed }), /investmentFundExitTaxRate\[1\]\.effectiveFrom must be later/, 'dates must rise');
    const unmarked = {
      ...DEFAULT_IE_TAX_CATALOGUE,
      schedules: { ...schedules, investmentFundExitTaxRate: [{ effectiveFrom: '2026-01-01', rate: 0.38 }] }
    };
    assertThrows(() => resolveTaxRules(2026, { catalogue: unmarked }), /status must be enacted or announced/, 'a rate needs a status');
  }));

  cases.push(runCase('A 60-year household projection with a solver every year runs quickly', () => {
    const elapsed = benchmarkSixtyYearProjection();
    console.info(`[IeTaxTests] 60-year household projection with a solver every year: ${elapsed} ms`);
    // The brief's bound is 300 ms in Node. A browser Dev Panel run can be
    // slower, so this only guards against something pathological.
    assert(elapsed < 3000, `took ${elapsed} ms`);
  }));

  /**
   * The Department of Finance's own worked figures for Budget 2027 (Tax Policy
   * Changes, Table 2: single person, no children, PAYE employee, full-rate PRSI).
   * Typed here from the printed table, independent of the catalogue, so a slip in
   * the 2027 block cannot agree with itself. Each row is gross pay, then income
   * tax, PRSI and USC as the table prints them for 2026 ("existing") and 2027
   * ("proposed"), to the euro. PRSI includes the scheduled rises, which is why
   * 2027 is blended: 4.35% to September and 4.5% from October.
   */
  const DEPARTMENT_TABLE_2 = Object.freeze([
    [30_000, [2_000, 1_271, 433], [1_750, 1_316, 420]],
    [35_000, [3_000, 1_483, 583], [2_750, 1_536, 567]],
    [40_000, [4_000, 1_695, 733], [3_750, 1_755, 717]],
    [45_000, [5_200, 1_907, 883], [4_750, 1_974, 867]],
    [50_000, [7_200, 2_119, 1_033], [6_450, 2_194, 1_017]],
    [55_000, [9_200, 2_331, 1_183], [8_450, 2_413, 1_167]],
    [65_000, [13_200, 2_754, 1_483], [12_450, 2_852, 1_467]],
    [75_000, [17_200, 3_178, 2_031], [16_450, 3_291, 2_015]],
    [100_000, [27_200, 4_238, 4_031], [26_450, 4_388, 4_015]],
    [125_000, [37_200, 5_297, 6_031], [36_450, 5_484, 6_015]],
    [150_000, [47_200, 6_356, 8_031], [46_450, 6_581, 8_015]],
    [175_000, [57_200, 7_416, 10_031], [56_450, 7_678, 10_015]]
  ]);

  cases.push(runCase('withTaxCatalogue pins a catalogue for one run and puts the built-in one back, even after an error', () => {
    const pinned = { ...DEFAULT_IE_TAX_CATALOGUE, rulesByYear: { 2026: DEFAULT_IE_TAX_CATALOGUE.rulesByYear[2026] } };
    assert(resolveTaxRules(2031).rulesYear === 2027, 'the built-in catalogue holds 2027 forward');
    assert(withTaxCatalogue(pinned, () => resolveTaxRules(2031).rulesYear) === 2026, 'pinned to 2026 held forward');
    assert(withTaxCatalogue(pinned, () => resolveSft(2027).amount) === 2_400_000, 'the threshold schedule follows the pinned catalogue');
    assert(resolveTaxRules(2031).rulesYear === 2027, 'restored afterwards');
    assertThrows(() => withTaxCatalogue(pinned, () => { throw new Error('boom'); }), /boom/, 'an error passes through');
    assert(resolveTaxRules(2031).rulesYear === 2027, 'restored after an error');
    const first = withTaxCatalogue(pinned, () => resolveTaxRules(2031));
    assert(withTaxCatalogue(pinned, () => resolveTaxRules(2031)) === first, 'a pinned catalogue is cached like the built-in one');
    assert(resolveTaxRules(2031, { catalogue: pinned }).rulesYear === 2026, 'an explicit catalogue still wins');
  }));

  cases.push(runCase('Budget 2027: the engine reproduces the Department of Finance\'s Table 2 for a single PAYE employee, 2026 and 2027, to the euro', () => {
    for (const [gross, existing, proposed] of DEPARTMENT_TABLE_2) {
      for (const [year, [incomeTax, prsi, usc]] of [[2026, existing], [2027, proposed]]) {
        const { result } = computeTaxYear({ input: { year, status: 'single', people: [single('a', 40)], items: [item('a', 'employment', gross)] } });
        const label = `${year} on ${gross}`;
        assert(Math.round(result.totals.incomeTax) === incomeTax, `${label}: income tax ${result.totals.incomeTax}, table ${incomeTax}`);
        assert(Math.round(result.totals.prsi) === prsi, `${label}: PRSI ${result.totals.prsi}, table ${prsi}`);
        assert(Math.round(result.totals.usc) === usc, `${label}: USC ${result.totals.usc}, table ${usc}`);
      }
    }
  }));

  cases.push(runCase('Budget 2027: a married couple with one income, by hand from the Bill: band 55,500, credits 4,250 and 2,125', () => {
    // 20% of 55,000 = 11,000, less the married credit 4,250 and the employee credit 2,125. The Department's Table 3
    // prints 2,575 for this couple because it also gives the home carer credit (2,050 in 2027), which this engine
    // leaves out: 11,000 - 6,375 = 4,625, and 4,625 - 2,050 = 2,575.
    const { result } = computeTaxYear({ input: { year: 2027, status: 'married_or_civil_partners', people: [single('a', 40), single('b', 40)], items: [item('a', 'employment', 55_000)] } });
    assertCents(result.totals.incomeTax, 4_625, 'income tax');
    assertCents(result.assessments[0].standardRateBand, 55_500, 'the band');
  }));

  cases.push(runCase('Budget 2027: a couple with two incomes gets the 37,500 second-income increase, capped at the lower income', () => {
    // 60,000 and 40,000. The band is 55,500 plus the lower income capped at 37,500 = 93,000. Tax by hand: the first
    // earner has 55,500 at 20% and 4,500 at 40% = 12,900; the second 37,500 at 20% and 2,500 at 40% = 8,500.
    // 21,400 less credits of 4,250 married + 2 x 2,125 employee = 12,900.
    const { result } = computeTaxYear({ input: { year: 2027, status: 'married_or_civil_partners', people: [single('a', 40), single('b', 40)], items: [item('a', 'employment', 60_000), item('b', 'employment', 40_000)] } });
    assertCents(result.totals.incomeTax, 12_900, 'income tax');
    assertCents(result.assessments[0].standardRateBand, 93_000, 'the band');
    // A lower income below the cap adds only itself: 30,000 gives 55,500 + 30,000 = 85,500.
    const small = computeTaxYear({ input: { year: 2027, status: 'married_or_civil_partners', people: [single('a', 40), single('b', 40)], items: [item('a', 'employment', 60_000), item('b', 'employment', 30_000)] } }).result;
    // 60,000: 11,100 + 1,800 = 12,900. 30,000 at 20% = 6,000. 18,900 less 8,500 credits = 10,400.
    assertCents(small.totals.incomeTax, 10_400, 'income tax with a lower income under the cap');
    assertCents(small.assessments[0].standardRateBand, 85_500, 'the band with a lower income under the cap');
  }));

  cases.push(runCase('Budget 2027: a widowed person without dependent children has the 2,125 personal credit plus the 540 widowed credit', () => {
    // 20% of 40,000 = 8,000, less 2,125 + 540 personal and 2,125 employee = 3,210. Under the 2026 rules it was
    // 8,000 - (2,000 + 540) - 2,000 = 3,460.
    const input = (year) => ({ input: { year, status: 'widowed_or_surviving_civil_partner', people: [single('a', 55)], items: [item('a', 'employment', 40_000)] } });
    assertCents(computeTaxYear(input(2027)).result.totals.incomeTax, 3_210, '2027 income tax');
    assertCents(computeTaxYear(input(2026)).result.totals.incomeTax, 3_460, '2026 income tax');
  }));

  cases.push(runCase('Budget 2027: USC at the new 2% ceiling, by hand, including the band edge', () => {
    // 30,300 exactly: 12,012 at 0.5% + 18,288 at 2% = 60.06 + 365.76 = 425.82. One euro more is taxed at 3%.
    const usc = (gross) => computeTaxYear({ input: { year: 2027, status: 'single', people: [single('a', 40)], items: [item('a', 'rentalProfit', gross)] } }).result.totals.usc;
    assertCents(usc(30_300), 425.82, 'USC at the ceiling');
    assertCents(usc(30_301) - usc(30_300), 0.03, 'the next euro is taxed at 3%');
    assertCents(usc(13_000), 0, 'no USC at or below 13,000');
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
