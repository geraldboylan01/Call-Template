// Protection gap: the engine, proved against an independent reference.
//
// The reference below imports NOTHING from `js/protection_gap_math.js`. It
// rebuilds every case from first principles: it adds up what comes in, then
// drains the savings one month at a time against the monthly gap to find how
// long they last. The engine divides savings by the gap; the reference counts
// months, so agreement is a real cross-check and not a copy.
//
// The month count is done in twelfths of a euro (savings x 12, against a step
// of the whole yearly gap), so every number in it is an integer and a boundary
// such as exactly 36 months is exact, not 35.99999999999999.

import assert from 'node:assert/strict';

import { computeProtectionGapProjection } from '../js/protection_gap_math.js';
import {
  PROTECTION_GAP_EXPECTED,
  PROTECTION_GAP_SAMPLE,
  runProtectionGapTests
} from '../js/tests_protection_gap_math.js';
import { runProtectionGapViewTests } from '../js/tests_protection_gap_view.js';
import { runProtectionGapModuleTests } from '../js/tests_protection_gap_module.js';

const HORIZON_MONTHS = 36;
const MAX_REFERENCE_MONTHS = 100_000;

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.info(`[ProtectionGapAudit] PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[ProtectionGapAudit] FAIL: ${name}\n    ${error.message}`);
  }
}

/** What comes in, what is needed, the gap, and how long savings last, for one case. */
function referenceCase(payload, scenario) {
  const event = scenario.event || null;

  let takeHome = 0;
  payload.people.forEach((person) => {
    if (!event || person.id !== event.personId) {
      takeHome += person.takeHome;
    }
  });

  let floor = 0;
  if (event) {
    floor = event.type === 'cannotWork' ? event.statePayment : event.survivorsPension;
  }
  const moneyIn = takeHome + floor;

  let needed = payload.needed;
  if (event && event.type === 'dies' && typeof event.neededAfter === 'number' && event.neededAfter < payload.needed) {
    needed = event.neededAfter;
  }

  const gap = Math.max(0, needed - moneyIn);
  const spare = Math.max(0, moneyIn - needed);

  let exactMonths = null;
  if (gap > 0) {
    // Twelfths of a euro: each month costs `gap` of them.
    let balance = payload.savings * 12;
    let whole = 0;
    while (balance >= gap && whole < MAX_REFERENCE_MONTHS) {
      balance -= gap;
      whole += 1;
    }
    exactMonths = whole >= MAX_REFERENCE_MONTHS ? Infinity : whole + balance / gap;
  }

  const beyond = exactMonths !== null && exactMonths >= HORIZON_MONTHS;
  return {
    moneyIn,
    needed,
    gap,
    spare,
    exactMonths,
    months: exactMonths === null || beyond ? null : Math.round(exactMonths),
    beyond,
    status: gap > 0 ? 'short' : (spare > 0 ? 'left_over' : 'tight')
  };
}

function compare(payload, label) {
  const engine = computeProtectionGapProjection(payload).debug.cases;
  assert.equal(engine.length, payload.scenarios.length, `${label}: one result per case`);
  payload.scenarios.forEach((scenario, index) => {
    const ref = referenceCase(payload, scenario);
    const got = engine[index];
    const where = `${label}/${scenario.id}`;
    assert.equal(got.moneyIn, ref.moneyIn, `${where}: money in`);
    assert.equal(got.needed, ref.needed, `${where}: needed`);
    assert.equal(got.gap, ref.gap, `${where}: gap`);
    assert.equal(got.spare, ref.spare, `${where}: left over`);
    assert.equal(got.status, ref.status, `${where}: status`);
    assert.equal(got.beyond, ref.beyond, `${where}: beyond three years`);
    assert.equal(got.months, ref.months, `${where}: months`);
    if (ref.exactMonths === null) {
      assert.equal(got.exactMonths, null, `${where}: no months when there is no gap`);
    } else if (Number.isFinite(ref.exactMonths)) {
      assert.ok(Math.abs(got.exactMonths - ref.exactMonths) < 1e-9, `${where}: unrounded months ${got.exactMonths} vs ${ref.exactMonths}`);
    }
    assert.equal(
      got.segments.reduce((sum, segment) => sum + segment.amount, 0),
      ref.moneyIn,
      `${where}: segments add up to money in`
    );
  });
}

/** A small deterministic generator, so a failure can be reproduced. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomPayload(random, number) {
  const int = (low, high) => low + Math.floor(random() * (high - low + 1));
  const step = (low, high) => 500 * int(low, high);

  const personCount = random() < 0.35 ? 1 : 2;
  const people = [];
  for (let i = 0; i < personCount; i += 1) {
    people.push({ id: `p${i + 1}`, label: `Person ${i + 1}`, takeHome: step(1, 200) });
  }
  const needed = step(20, 300);
  const savings = random() < 0.1 ? 0 : step(1, 400);

  const scenarios = [{ id: 'base' }];
  const extra = int(0, 3);
  for (let i = 0; i < extra; i += 1) {
    const person = people[int(0, people.length - 1)];
    const dies = people.length === 2 && random() < 0.5;
    if (dies) {
      const event = { type: 'dies', personId: person.id, survivorsPension: step(0, 40) };
      if (random() < 0.6 && needed > 500) {
        event.neededAfter = step(1, needed / 500 - 1);
        if (random() < 0.7) {
          event.neededBecause = random() < 0.5 ? ['mortgageCleared'] : ['mortgageCleared', 'livingCostsLower'];
        }
      }
      scenarios.push({ id: `case-${number}-${i + 1}`, event });
    } else {
      scenarios.push({
        id: `case-${number}-${i + 1}`,
        event: { type: 'cannotWork', personId: person.id, statePayment: step(1, 40) }
      });
    }
  }
  return { people, needed, savings, scenarios };
}

const onePerson = (takeHome, needed, savings) => ({
  people: [{ id: 'ann', label: 'Ann', takeHome }],
  needed,
  savings,
  scenarios: [{ id: 'base' }]
});

check('the sample household matches the reference, case by case', () => {
  compare(PROTECTION_GAP_SAMPLE, 'sample');
});

check('boundary shapes match the reference', () => {
  const shapes = [
    ['exactly 36 months', onePerson(50_000, 60_000, 30_000)],
    ['35.5 months', onePerson(50_000, 62_000, 35_500)],
    ['35.49 months', onePerson(50_000, 62_000, 35_490)],
    ['one month', onePerson(50_000, 62_000, 1_000)],
    ['under half a month', onePerson(50_000, 62_000, 100)],
    ['no savings', onePerson(50_000, 62_000, 0)],
    ['left over', onePerson(50_000, 40_000, 20_000)],
    ['tight', onePerson(50_000, 50_000, 20_000)],
    ['a gap of one euro a year', onePerson(59_999, 60_000, 10_000)],
    ['very large figures', onePerson(1_500_000, 4_000_000, 900_000)]
  ];
  shapes.forEach(([label, payload]) => compare(payload, label));
});

check('300 generated households match the reference', () => {
  const random = makeRandom(20261013);
  for (let number = 1; number <= 300; number += 1) {
    compare(randomPayload(random, number), `generated ${number}`);
  }
});

check('the scale is the same for every case and covers every case', () => {
  const random = makeRandom(7);
  for (let number = 1; number <= 100; number += 1) {
    const payload = randomPayload(random, number);
    const { debug } = computeProtectionGapProjection(payload);
    const highest = Math.max(...debug.cases.map((entry) => Math.max(entry.moneyIn, entry.needed)));
    assert.equal(debug.scaleMax % 10_000, 0, `generated ${number}: a multiple of 10,000`);
    assert.ok(debug.scaleMax >= highest * 1.05 - 1e-6, `generated ${number}: ${debug.scaleMax} covers ${highest} plus 5%`);
    assert.ok(debug.scaleMax < highest * 1.05 + 10_000, `generated ${number}: no more than one step above`);
  }
});

check('the published sample table is reproduced', () => {
  const { debug } = computeProtectionGapProjection(PROTECTION_GAP_SAMPLE);
  assert.deepEqual(debug.cases.map((entry) => entry.moneyIn), PROTECTION_GAP_EXPECTED.moneyIn);
  assert.deepEqual(debug.cases.map((entry) => entry.gap), PROTECTION_GAP_EXPECTED.gap);
  assert.deepEqual(debug.cases.map((entry) => entry.months), PROTECTION_GAP_EXPECTED.months);
  assert.equal(debug.scaleMax, PROTECTION_GAP_EXPECTED.scaleMax);
});

// The suites, run here so one command proves the engine, the screen's words and
// geometry, and the module's clock and DOM. The wiring suite joins them when the
// module is wired into the app.
const suites = [
  ['engine', runProtectionGapTests()],
  ['view', runProtectionGapViewTests()],
  ['module', await runProtectionGapModuleTests()]
];
suites.forEach(([name, summary]) => {
  if (summary.failed > 0) {
    failures += summary.failed;
    console.error(`[ProtectionGapAudit] the ${name} suite has ${summary.failed} failing test(s).`);
  }
});

if (failures > 0) {
  console.error(`[ProtectionGapAudit] ${failures} check(s) failed.`);
  process.exit(1);
}

console.info('[ProtectionGapAudit] the engine matches the independent reference, and the engine, view and module suites pass.');
