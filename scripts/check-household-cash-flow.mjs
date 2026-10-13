// Household cash flow: the engine, proved against an independent reference.
//
// The reference below imports NOTHING from `js/household_cash_flow_math.js`. It
// rebuilds every case from first principles: each person's income, the tax
// engine's answer for the case, the allocation of a couple's income tax, a
// stated take-home as a level plus the engine's change, the rounding and the
// month. It calls the tax engine directly, so a rules change moves both sides
// together and no figure here is hard-coded. Only the DESIGN fixture has
// literal figures, because it is injected and the rules cannot move it.
//
// Then it proves, by reading the source, that the module holds no second copy
// of a tax rule, and finally runs the unit suite.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeHouseholdCashFlowProjection } from '../js/household_cash_flow_math.js';
import {
  HOUSEHOLD_CASH_FLOW_DESIGN_EXPECTED,
  HOUSEHOLD_CASH_FLOW_SAMPLE,
  designFixtureOptions,
  runHouseholdCashFlowTests
} from '../js/tests_household_cash_flow_math.js';
import { computeTaxYear } from '../js/planning/tax/engine.js';

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.info(`[HouseholdCashFlowAudit] PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[HouseholdCashFlowAudit] FAIL: ${name}\n    ${error.message}`);
  }
}

const YEAR = 2026;
const clone = (value) => JSON.parse(JSON.stringify(value));
const sum = (values) => values.reduce((total, value) => total + value, 0);
const nearest = (amount, step) => (Math.round(amount / step) * step) || 0;
const eur = (amount) => `€${Math.round(Math.abs(amount)).toLocaleString('en-IE')}`;

/* ---------------------------------------------------------------- reference */

function reference(payload, { year = YEAR, taxFor = null } = {}) {
  const ids = payload.people.map((person) => person.id);
  const status = payload.householdTaxStatus || 'single';
  const baseId = payload.baseScenarioId || payload.scenarios[0].id;

  // Income before tax by person. "joint" is half each, or the one person.
  const gross = Object.fromEntries(ids.map((id) => [id, 0]));
  payload.income.forEach((item) => {
    const owners = item.personId === 'joint' ? ids : [item.personId];
    owners.forEach((owner) => {
      gross[owner] += item.amount / owners.length;
    });
  });
  const income = sum(Object.values(gross));

  const extraFor = (scenario) => {
    const paid = Object.fromEntries(ids.map((id) => [id, 0]));
    (scenario.changes || []).filter((change) => change.type === 'extraPension').forEach((change) => {
      const owners = (change.personId || 'joint') === 'joint' ? ids : [change.personId];
      owners.forEach((owner) => {
        paid[owner] += change.amount / owners.length;
      });
    });
    return paid;
  };

  // The tax for one set of contributions, straight from the engine.
  const taxRun = (paid, caseId) => {
    if (taxFor) {
      const contributions = Object.entries(paid).filter(([, amount]) => amount > 0).map(([personId, amount]) => ({ personId, amount }));
      const byPerson = taxFor({ caseId, year, status, people: payload.people, income: payload.income, contributions });
      return { total: sum(ids.map((id) => byPerson[id])), flat: byPerson };
    }
    const items = payload.income.map((item) => ({ ...item, personId: item.personId === 'joint' && ids.length === 1 ? ids[0] : item.personId }));
    ids.forEach((id) => {
      if (paid[id] > 0) {
        items.push({ personId: id, type: 'employmentPensionContribution', amount: paid[id] });
      }
    });
    const { result } = computeTaxYear({
      input: { year, status, people: payload.people.map((person) => ({ id: person.id, age: person.age })), items }
    });
    return {
      total: result.totals.recurringTax,
      units: result.assessments.map((assessment) => ({ members: assessment.personIds, incomeTax: assessment.incomeTax })),
      own: Object.fromEntries(result.people.map((person) => [person.id, person.usc.usc + person.prsi.prsi]))
    };
  };

  const baseScenario = payload.scenarios.find((scenario) => scenario.id === baseId);
  const basePaid = extraFor(baseScenario);
  const baseRun = taxRun(basePaid, baseId);

  // A person's ESTIMATED tax in a case.
  const estimatedTax = (run, paid, id) => {
    if (run.flat) {
      return run.flat[id];
    }
    const unit = run.units.find((entry) => entry.members.includes(id));
    if (unit.members.length === 1) {
      return run.own[id] + unit.incomeTax;
    }
    const baseUnit = baseRun.units.find((entry) => entry.members.includes(id));
    const members = unit.members;
    const share = gross[id] / sum(members.map((member) => gross[member]));
    const change = unit.incomeTax - baseUnit.incomeTax;
    const extra = members.map((member) => Math.max(0, paid[member] - basePaid[member]));
    const portion = sum(extra) > 0 ? extra[members.indexOf(id)] / sum(extra) : share;
    return run.own[id] + baseUnit.incomeTax * share + change * portion;
  };

  const cases = payload.scenarios.map((scenario) => {
    const paid = extraFor(scenario);
    const run = scenario.id === baseId ? baseRun : taxRun(paid, scenario.id);
    const people = payload.people.map((person) => {
      const estimated = estimatedTax(run, paid, person.id);
      const baseEstimated = estimatedTax(baseRun, basePaid, person.id);
      const tax = person.statedTakeHome == null
        ? estimated
        : (gross[person.id] - person.statedTakeHome) + (estimated - baseEstimated);
      return { id: person.id, tax, takeHome: gross[person.id] - tax };
    });
    const tax = sum(people.map((person) => person.tax));
    const pensions = sum(Object.values(paid));
    const cleared = new Set((scenario.changes || []).filter((change) => change.type === 'clearOutgoing').map((change) => change.outgoingId));
    const stated = payload.outgoings.map((line) => ({ id: line.id, amount: cleared.has(line.id) ? 0 : line.amount }));
    const statedTotal = sum(stated.map((line) => line.amount));
    const none = taxRun(Object.fromEntries(ids.map((id) => [id, 0])), `${scenario.id}:none`);
    const relief = pensions > 0 ? Math.max(0, none.total - run.total) : 0;

    const shownTax = nearest(tax, 100);
    const shownPensions = nearest(pensions, 100);
    const shownStated = stated.map((line) => nearest(line.amount, 100));
    const shownIncome = nearest(income, 100);
    const shownOut = shownTax + shownPensions + sum(shownStated);
    const shownLeft = shownIncome - shownOut;
    const monthlyExact = shownLeft / 12;
    const monthly = nearest(monthlyExact, 10);
    return {
      id: scenario.id,
      people,
      tax,
      pensions,
      statedTotal,
      leftOver: income - tax - pensions - statedTotal,
      relief,
      shownTax,
      shownPensions,
      shownStated,
      shownIncome,
      shownOut,
      shownLeft,
      monthlyText: `${Math.abs(monthlyExact - monthly) < 0.005 ? '' : 'About '}${eur(monthly)} a month`
    };
  });

  return { income, gross, cases };
}

/** The four sample shapes' sentences, rebuilt from the reference's own numbers. */
function referenceSentences(ref) {
  const [today, clear, pension, both] = ref.cases;
  const effect = (left, base) => {
    if (left === base) return `you have the same ${eur(left)} left over as today`;
    if (left === 0) return 'you have nothing left over';
    if (base > 0 && left === 2 * base) return `the amount you have left over doubles, from ${eur(base)} to ${eur(left)}`;
    if (left > base) return `the amount you have left over rises by ${eur(left - base)}, from ${eur(base)} to ${eur(left)}`;
    return `the amount you have left over falls from ${eur(base)} to ${eur(left)}`;
  };
  const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);
  const taxDrop = (entry) => today.shownTax - entry.shownTax;
  const carToday = today.shownStated[1];
  return [
    `Today, ${eur(today.shownOut)} of your ${eur(today.shownIncome)} goes out and you have ${eur(today.shownLeft)} left over.`,
    `Clearing your car loan from savings stops ${eur(carToday)} a year going out, so ${effect(clear.shownLeft, today.shownLeft)}.`,
    `Paying ${eur(pension.shownPensions)} more into your pensions lowers your tax by ${eur(taxDrop(pension))}, `
      + `so ${eur(pension.shownPensions - taxDrop(pension))} more goes out each year and ${effect(pension.shownLeft, today.shownLeft)}.`,
    `${cap(effect(both.shownLeft, today.shownLeft))}, but your car loan is gone and ${eur(both.shownPensions)} more goes into your pensions each year, `
      + `with your tax ${eur(taxDrop(both))} ${taxDrop(both) > 0 ? 'lower' : 'higher'}.`
  ];
}

/* ----------------------------------------------------------------- fixtures */

const withIncome = (niamh, dara, living = 48_000) => {
  const payload = clone(HOUSEHOLD_CASH_FLOW_SAMPLE);
  payload.income[0].amount = niamh;
  payload.income[1].amount = dara;
  payload.outgoings[2].amount = living;
  return payload;
};

const statedOne = clone(HOUSEHOLD_CASH_FLOW_SAMPLE);
statedOne.people[0].statedTakeHome = 50_000;

const statedBoth = clone(HOUSEHOLD_CASH_FLOW_SAMPLE);
statedBoth.people[0].statedTakeHome = 55_000;
statedBoth.people[1].statedTakeHome = 60_000;

const separate = withIncome(100_000, 50_000, 40_000);
separate.householdTaxStatus = 'single';

const defaulted = withIncome(100_000, 50_000, 40_000);
delete defaulted.householdTaxStatus;

const onePerson = {
  householdTaxStatus: 'single',
  people: [{ id: 'alex', age: 52 }],
  income: [{ personId: 'joint', type: 'employment', amount: 90_000 }, { personId: 'alex', type: 'rentalProfit', amount: 8_000 }],
  outgoings: [{ id: 'rent', label: 'Rent', amount: 24_000 }, { id: 'living', label: 'Living costs', amount: 30_000 }],
  scenarios: [
    { id: 'today' },
    { id: 'pension', changes: [{ type: 'extraPension', amount: 12_000 }] },
    { id: 'rent', changes: [{ type: 'clearOutgoing', outgoingId: 'rent' }] }
  ]
};

const SAMPLE_SHAPED = [
  ['engine, 75,000 each', HOUSEHOLD_CASH_FLOW_SAMPLE],
  ['engine, 120,000 and 30,000', withIncome(120_000, 30_000, 40_000)],
  ['engine, 100,000 and 50,000', withIncome(100_000, 50_000, 40_000)],
  ['one person stated', statedOne],
  ['both stated', statedBoth],
  ['two people assessed separately', separate],
  ['tax status not given', defaulted]
];

/* ------------------------------------------------------------------ checks */

function compare(payload, ref, projection, label) {
  assert.equal(projection.summary.cases.length, ref.cases.length, `${label}: case count`);
  ref.cases.forEach((expected, index) => {
    const where = `${label}: ${expected.id}`;
    const summary = projection.summary.cases[index];
    const detail = projection.debug.cases[index];
    assert.ok(Math.abs(summary.outgoings.tax - expected.tax) < 0.005, `${where}: tax ${summary.outgoings.tax} vs ${expected.tax}`);
    assert.ok(Math.abs(summary.outgoings.pensionContributions - expected.pensions) < 0.005, `${where}: pensions`);
    assert.ok(Math.abs(summary.outgoings.statedTotal - expected.statedTotal) < 0.005, `${where}: stated total`);
    assert.ok(Math.abs(summary.leftOver.amount - expected.leftOver) < 0.005, `${where}: left over`);
    assert.ok(Math.abs(summary.pensionContributions.taxRelief - expected.relief) < 0.005, `${where}: relief`);
    assert.equal(detail.shownLeftOver, expected.shownLeft, `${where}: shown left over`);
    assert.equal(detail.monthly.text, expected.monthlyText, `${where}: month`);
    expected.people.forEach((person) => {
      const found = summary.takeHome.byPerson.find((entry) => entry.personId === person.id);
      assert.ok(Math.abs(found.tax - person.tax) < 0.005, `${where}: ${person.id} tax ${found.tax} vs ${person.tax}`);
      assert.ok(Math.abs(found.takeHome - person.takeHome) < 0.005, `${where}: ${person.id} take-home`);
    });
    const shownLines = Object.fromEntries(detail.lines.map((line) => [line.id, line.shownAmount]));
    assert.equal(shownLines.tax, expected.shownTax, `${where}: shown tax`);
    assert.equal(shownLines.pensions, expected.shownPensions, `${where}: shown pensions`);
    payload.outgoings.forEach((line, lineIndex) => {
      assert.equal(shownLines[line.id], expected.shownStated[lineIndex], `${where}: shown ${line.id}`);
    });
  });
}

check('the design fixture reproduces the frames exactly', () => {
  const projection = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, designFixtureOptions());
  const ref = reference(HOUSEHOLD_CASH_FLOW_SAMPLE, { taxFor: designFixtureOptions().taxFor });
  compare(HOUSEHOLD_CASH_FLOW_SAMPLE, ref, projection, 'design');
  assert.deepEqual(ref.cases.map((entry) => entry.shownTax), [...HOUSEHOLD_CASH_FLOW_DESIGN_EXPECTED.tax]);
  assert.deepEqual(ref.cases.map((entry) => entry.shownLeft), [...HOUSEHOLD_CASH_FLOW_DESIGN_EXPECTED.leftOver]);
  assert.deepEqual(projection.debug.cases.map((entry) => entry.sentence), [...HOUSEHOLD_CASH_FLOW_DESIGN_EXPECTED.sentences]);
  assert.deepEqual(referenceSentences(ref), [...HOUSEHOLD_CASH_FLOW_DESIGN_EXPECTED.sentences]);
});

SAMPLE_SHAPED.forEach(([name, payload]) => {
  check(`the engine agrees with the reference: ${name}`, () => {
    const projection = computeHouseholdCashFlowProjection(payload, { calculationYear: YEAR });
    const ref = reference(payload);
    compare(payload, ref, projection, name);
    assert.deepEqual(
      projection.debug.cases.map((entry) => entry.sentence),
      referenceSentences(ref),
      `${name}: the sentences are the templates' output`
    );
  });
});

check('the engine agrees with the reference: one person, other income and a cleared line', () => {
  const projection = computeHouseholdCashFlowProjection(onePerson, { calculationYear: YEAR });
  compare(onePerson, reference(onePerson), projection, 'one person');
});

check('with nothing stated, the people\'s tax sums to the engine\'s household total for every case', () => {
  SAMPLE_SHAPED.filter(([, payload]) => payload.people.every((person) => person.statedTakeHome == null)).forEach(([name, payload]) => {
    const projection = computeHouseholdCashFlowProjection(payload, { calculationYear: YEAR });
    projection.debug.cases.forEach((entry) => {
      assert.ok(
        Math.abs(entry.taxBreakdown.byPerson.reduce((total, person) => total + person.estimatedTax, 0) - entry.taxBreakdown.estimatedTotal) < 0.005,
        `${name}: ${entry.id}`
      );
    });
  });
});

check('a stated take-home never moves the other person, and the change in a case is the engine\'s', () => {
  const estimated = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, { calculationYear: YEAR });
  const stated = computeHouseholdCashFlowProjection(statedOne, { calculationYear: YEAR });
  const tax = (projection, caseIndex, id) => projection.summary.cases[caseIndex].takeHome.byPerson.find((p) => p.personId === id).tax;
  [0, 1, 2, 3].forEach((index) => {
    assert.ok(Math.abs(tax(stated, index, 'dara') - tax(estimated, index, 'dara')) < 0.005, `Dara, case ${index + 1}`);
    const changeStated = tax(stated, index, 'niamh') - tax(stated, 0, 'niamh');
    const changeEstimated = tax(estimated, index, 'niamh') - tax(estimated, 0, 'niamh');
    assert.ok(Math.abs(changeStated - changeEstimated) < 0.005, `Niamh's change, case ${index + 1}`);
  });
});

check('relief is the engine\'s saving, so D7 reads: gross for growth, cost after relief for cash flow', () => {
  const projection = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, { calculationYear: YEAR });
  const pension = projection.summary.cases[2];
  assert.equal(pension.pensionContributions.gross, 10_000);
  assert.ok(pension.pensionContributions.taxRelief > 0, 'there is relief');
  assert.ok(
    Math.abs(pension.pensionContributions.costAfterRelief - (10_000 - pension.pensionContributions.taxRelief)) < 0.005,
    'cost after relief'
  );
  // What the household is out of pocket is the cost after relief: the change in left over.
  const today = projection.summary.cases[0];
  assert.ok(
    Math.abs((today.leftOver.amount - pension.leftOver.amount) - pension.pensionContributions.costAfterRelief) < 0.005,
    'the fall in left over is the cost after relief'
  );
});

check('the module holds no second copy of a tax rule (the three-way proof, part 2: the source)', () => {
  const source = readFileSync(new URL('../js/household_cash_flow_math.js', import.meta.url), 'utf8');

  // Imports: the engine, the resolver and the disclosures, and only the first
  // tax year from the rules file.
  const taxImports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.\/planning\/tax\/[^']+)'/g)];
  const allowed = {
    './planning/tax/engine.js': ['computeTaxYear', 'mergeDisclosures', 'TAX_STATUSES'],
    './planning/tax/resolve.js': ['resolveTaxRules'],
    './planning/tax/rules_ie.js': ['IE_TAX_FIRST_YEAR'],
    './planning/tax/disclosures.js': ['TAX_NOT_INCLUDED', 'renderTaxDisclosures']
  };
  taxImports.forEach(([, names, from]) => {
    assert.ok(allowed[from], `unexpected tax import from ${from}`);
    names.split(',').map((name) => name.trim()).filter(Boolean).forEach((name) => {
      assert.ok(allowed[from].includes(name), `${name} from ${from} is not allowed`);
    });
  });
  assert.ok(taxImports.length >= 4, 'the engine, resolver, rules and disclosures are imported');

  // No rate, band, credit or cap written as a number. Strip comments first.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const forbidden = [
    /(?<![\d.])0\.(2|4|33|04|045|0475|08|02|11|03)(?![\d])/,
    /(?<![\d_])(88|44|35|115|4|2|1)[_,]?000(?![\d])/,
    /\b(20|40|33|25|30)%/,
    /standardRateBand|personalCredit|employeeCredit|uscBand|prsiRate/
  ];
  forbidden.forEach((pattern) => {
    const hit = code.match(pattern);
    assert.ok(!hit, `a tax-looking literal "${hit && hit[0]}" appears in the module`);
  });
});

check('the tax seam is the only way to replace the engine, and it is not reachable from a payload', () => {
  const payload = clone(HOUSEHOLD_CASH_FLOW_SAMPLE);
  payload.taxFor = () => ({ niamh: 0, dara: 0 });
  const withSeam = computeHouseholdCashFlowProjection(payload, { calculationYear: YEAR });
  const plain = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, { calculationYear: YEAR });
  assert.equal(withSeam.summary.cases[0].outgoings.tax, plain.summary.cases[0].outgoings.tax);
  const injected = computeHouseholdCashFlowProjection(HOUSEHOLD_CASH_FLOW_SAMPLE, {
    calculationYear: YEAR,
    taxFor: () => ({ niamh: 1_000, dara: 2_000 })
  });
  assert.equal(injected.summary.cases[0].outgoings.tax, 3_000, 'an injected tax is used');
});

// The unit suite, run here so one command proves both.
const summary = runHouseholdCashFlowTests();
if (summary.failed > 0) {
  failures += summary.failed;
}

if (failures > 0) {
  console.error(`[HouseholdCashFlowAudit] ${failures} check(s) failed.`);
  process.exit(1);
}

console.info('[HouseholdCashFlowAudit] the engine matches the independent reference and the unit suite passes.');
