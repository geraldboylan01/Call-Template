import { computeTaxYear } from './planning/tax/engine.js';
import { computeProtectionGapProjection, normalizeProtectionGapInputs } from './protection_gap_math.js';
import {
  ILLNESS_BENEFIT_MONTHS,
  ILLNESS_BENEFIT_QUANTITY,
  buildProtectionIncomeCases,
  illnessBenefitScope
} from './planning/protection_income.js';
import { getFigures } from './planning/figures/get_figures.js';

/**
 * Protection in the plan: the income contract built from the shared tax engine
 * and the figures register (plan document, section 6, "Approved illness-scenario
 * assumption"). Every figure is also worked out here straight from the tax
 * engine, so the adapter is checked against the engine and not against itself.
 */

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
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

function runCase(name, fn) {
  try {
    fn();
    console.info(`[ProtectionIncomeTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[ProtectionIncomeTests] FAIL: ${name}\n    ${error.message}`);
    return { name, pass: false, error: error.message };
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const PEOPLE = [
  { id: 'niamh', label: 'Niamh', age: 45, employment: 'employee' },
  { id: 'dara', label: 'Dara', age: 45, employment: 'employee' }
];

/** Two employees, married, jointly assessed: 75,000 and 40,000. */
const COUPLE = {
  year: 2026,
  taxStatus: 'married_or_civil_partners',
  people: PEOPLE,
  income: [
    { personId: 'niamh', type: 'employment', amount: 75_000 },
    { personId: 'dara', type: 'employment', amount: 40_000 }
  ]
};

const SINGLE = {
  year: 2026,
  taxStatus: 'single',
  people: [{ id: 'ann', label: 'Ann', age: 40, employment: 'employee' }],
  income: [{ personId: 'ann', type: 'employment', amount: 52_000 }]
};

const withFacts = (base, patch) => ({ ...JSON.parse(JSON.stringify(base)), ...patch });
const stops = (personId, extra = {}) => ({ kind: 'incomeStops', personId, ...extra });

/** The engine, run directly, for a set of people and items. */
function engine(year, status, people, items) {
  return computeTaxYear({
    input: { year, status, people: people.map(({ id, age }) => ({ id, age })), items }
  }).result;
}

function onlyCase(facts, request) {
  return buildProtectionIncomeCases(facts, [request]).cases[0];
}

export function runProtectionIncomeTests() {
  const cases = [];

  cases.push(runCase('Scope: only a confirmed employee with employment income gets the Illness Benefit default', () => {
    assertEqual(illnessBenefitScope({ employment: 'employee', employmentIncome: 40_000 }).applies, true, 'an employee');
    [
      ['self_employed', 'self_employed', /self-employment/],
      ['retired', 'retired', /retired/],
      ['contractor', 'contractor', /employment or self-employment/],
      ['other', 'other', /not described as employment/],
      [undefined, 'unknown', /has not been confirmed/],
      ['unknown', 'unknown', /has not been confirmed/]
    ].forEach(([employment, code, pattern]) => {
      const scope = illnessBenefitScope({ employment, employmentIncome: 40_000 });
      assertEqual(scope.applies, false, `${employment}: not applied`);
      assertEqual(scope.code, code, `${employment}: code`);
      assert(pattern.test(scope.reason), `${employment}: reason "${scope.reason}"`);
    });
    assertEqual(illnessBenefitScope({ employment: 'employee', employmentIncome: 0 }).code, 'no_employment_income', 'an employee with no employment income');
  }));

  cases.push(runCase('The plan’s example: jointly assessed, 75,000 salary and 13,208 of Illness Benefit, checked against the tax engine', () => {
    const facts = withFacts(COUPLE, {});
    const found = onlyCase(facts, stops('dara'));
    assertEqual(found.shown, true, 'shown');
    const { income } = found.scenario;
    const [during, after] = income.phases;

    const figure = getFigures({ onDate: '2026-01-01' }).find((entry) => entry.id.startsWith(`${ILLNESS_BENEFIT_QUANTITY}.from_`));
    assertEqual(figure.value, 254, 'the register’s 2026 rate');
    assertEqual(during.statePayment.weeklyRate, 254, 'the rate used is the register’s');
    assertEqual(during.statePayment.weeks, 52, 'for 52 weeks');
    assertEqual(during.statePayment.grossAmount, 13_208, 'the plan’s 13,208');
    assertEqual(during.statePayment.figure.id, figure.id, 'traceable to the register’s figure');
    assertEqual(during.statePayment.scheme, 'illnessBenefit', 'the scheme');

    // The engine, worked directly: the benefit is Dara's own income, 75,000 is Niamh's.
    const direct = engine(2026, facts.taxStatus, PEOPLE, [
      { personId: 'niamh', type: 'employment', amount: 75_000 },
      { personId: 'dara', type: 'illnessBenefit', amount: 13_208 }
    ]);
    assertEqual(direct.assessments[0].standardRateBand, 66_208, 'the combined 20% band');
    assertEqual(direct.assessments[0].bandIncrease, 13_208, 'the increase is the benefit recipient’s');
    assertEqual(direct.people[1].usc.usc + direct.people[1].prsi.prsi, 0, 'no USC or PRSI on the benefit');
    const parts = during.takeHome.niamh + during.takeHome.dara + during.statePayment.amount;
    assertEqual(during.householdNetIncome, Math.round(direct.totals.netIncome), 'the household net income is the engine’s');
    assertEqual(parts, during.householdNetIncome, 'and the parts add up to it');
    assertEqual(during.takeHome.dara, 0, 'Dara’s pay has stopped');
    assertEqual(during.statePayment.amount + during.statePayment.estimatedTax, during.statePayment.grossAmount, 'gross, tax and net trace');
    assertEqual(during.months, ILLNESS_BENEFIT_MONTHS, 'counted for a year');

    // The second phase is its own calculation: the year is over and the extra band has gone.
    const later = engine(2026, facts.taxStatus, PEOPLE, [{ personId: 'niamh', type: 'employment', amount: 75_000 }]);
    assertEqual(after.statePayment, null, 'no payment after the year');
    assertEqual(after.takeHome.dara, 0, 'still not working');
    assertEqual(after.householdNetIncome, Math.round(later.totals.netIncome), 'a fresh calculation of Niamh alone');
    assertEqual(after.takeHome.niamh, after.householdNetIncome, 'all of it is Niamh’s');
    assertEqual(after.months, undefined, 'and it carries on');
    assertEqual(direct.assessments[0].standardRateBand - later.assessments[0].standardRateBand, 13_208, 'the household’s band is 13,208 lower once the benefit has gone');

    assertEqual(income.versions.taxRules, direct.rulesVersion, 'the tax rules version');
    assertEqual(income.versions.socialWelfare, figure.catalogueVersion, 'the State payment rates version');
    assertEqual(income.calculationYear, 2026, 'the calculation year');
    assertEqual(income.basis, 'estimated', 'the basis');
    assertEqual(income.creditAllocation, 'allocated', 'a joint assessment says it is allocated');
  }));

  cases.push(runCase('Either person can be the one who cannot work, and the household total is the engine’s each time', () => {
    const facts = withFacts(COUPLE, {});
    ['niamh', 'dara'].forEach((id) => {
      const other = id === 'niamh' ? 'dara' : 'niamh';
      const found = onlyCase(facts, stops(id));
      const [during] = found.scenario.income.phases;
      const direct = engine(2026, facts.taxStatus, PEOPLE, [
        ...COUPLE.income.filter((item) => item.personId === other),
        { personId: id, type: 'illnessBenefit', amount: 13_208 }
      ]);
      assertEqual(during.householdNetIncome, Math.round(direct.totals.netIncome), `${id}: household net income`);
      assertEqual(during.takeHome[other] + during.statePayment.amount, during.householdNetIncome, `${id}: parts add up`);
      assertEqual(found.scenario.event.personId, id, `${id}: the event`);
      assertEqual(found.scenario.id, `${id}-cannot-work`, `${id}: the case id`);
    });
  }));

  cases.push(runCase('A single person: the benefit is taxed as theirs alone, the allocation is their own, and the engine accepts it', () => {
    const found = onlyCase(SINGLE, stops('ann'));
    const [during, after] = found.scenario.income.phases;
    assertEqual(found.scenario.income.creditAllocation, 'own', 'no allocation for one person');
    const direct = engine(2026, 'single', SINGLE.people, [{ personId: 'ann', type: 'illnessBenefit', amount: 13_208 }]);
    assertEqual(during.statePayment.amount, Math.round(13_208 - direct.totals.incomeTax), 'gross less the engine’s tax on it');
    assertEqual(during.statePayment.estimatedTax, 0, '13,208 is covered by the credits');
    assertEqual(after.householdNetIncome, 0, 'nothing after the year');
    const projection = computeProtectionGapProjection({
      people: [{ id: 'ann', label: 'Ann', takeHome: 40_000 }], needed: 36_000, savings: 12_000,
      scenarios: [{ id: 'today' }, found.scenario]
    });
    assert(!projection.debug.footnote.includes('the other person'), 'a single person has no partner sentence');
    assert(projection.debug.footnote.includes('Tax is recalculated for each case.'), 'but tax is recalculated');
  }));

  cases.push(runCase('The rate is the register’s for the year the plan applies: 2027 reads the announced rate, and says so', () => {
    const found = onlyCase(withFacts(COUPLE, { year: 2027 }), stops('dara'));
    const payment = found.scenario.income.phases[0].statePayment;
    assertEqual(payment.weeklyRate, 264, 'the announced 2027 rate');
    assertEqual(payment.grossAmount, 13_728, '264 for 52 weeks');
    assertEqual(payment.figure.status, 'announced', 'it says it is announced');
    assertEqual(payment.figure.effectiveFrom, '2027-01-01', 'from when');
    assertEqual(found.scenario.income.calculationYear, 2027, 'the year');
    const later = onlyCase(withFacts(COUPLE, { year: 2031 }), stops('dara')).scenario.income.phases[0].statePayment;
    assertEqual(later.weeklyRate, 264, 'a later year holds the latest rate');
    const earlier = (() => {
      try {
        onlyCase(withFacts(COUPLE, { year: 2020 }), stops('dara'));
        return '';
      } catch (error) {
        return error.message;
      }
    })();
    assert(/2026 or later|no .* rate in force/.test(earlier), `a year before the register: ${earlier}`);
  }));

  cases.push(runCase('It never applies silently outside employment: self-employment, retirement and unconfirmed work are not shown, with the reason', () => {
    ['self_employed', 'retired', 'contractor', 'other', undefined].forEach((employment) => {
      const facts = withFacts(COUPLE, {});
      facts.people[1].employment = employment;
      const found = onlyCase(facts, stops('dara'));
      assertEqual(found.shown, false, `${employment}: not shown`);
      assert(typeof found.reason === 'string' && found.reason.length > 20, `${employment}: a reason is given`);
      assert(!/Illness Benefit/.test(found.reason) || /No State payment has been assumed/.test(found.reason), `${employment}: the reason says nothing was assumed`);
      assertEqual(found.scenario, undefined, `${employment}: no case is made`);
    });
    // A payment the person states is used as given, for anyone.
    const facts = withFacts(COUPLE, {});
    facts.people[1].employment = 'self_employed';
    const stated = onlyCase(facts, stops('dara', { statePayment: 9_000 }));
    assertEqual(stated.shown, true, 'a stated payment is shown');
    const payment = stated.scenario.income.phases[0].statePayment;
    assertEqual(payment.scheme, 'stated', 'as a stated payment');
    assertEqual(payment.amount, 9_000, 'as given');
    assertEqual(stated.scenario.income.phases.length, 1, 'it is not ended by the engine, which was not given a time');
    assert(!JSON.stringify(stated.scenario).includes('illnessBenefit'), 'and no Illness Benefit is assumed');
    // A stated zero is a confirmed none.
    const zero = onlyCase(facts, stops('dara', { statePayment: 0 }));
    assertEqual(zero.scenario.income.phases[0].statePayment.amount, 0, 'a stated zero');
    assertEqual(computeProtectionGapProjection({
      people: [{ id: 'niamh', label: 'Niamh', takeHome: 55_000 }, { id: 'dara', label: 'Dara', takeHome: 32_000 }],
      needed: 70_000, savings: 10_000, scenarios: [{ id: 'today' }, zero.scenario]
    }).debug.cases[1].floorAmount, 0, 'no payment counted');
  }));

  cases.push(runCase('Income that carries on beside the stopped pay is not hidden: the case is not shown, and says why', () => {
    const rental = withFacts(COUPLE, {});
    rental.income.push({ personId: 'dara', type: 'rentalProfit', amount: 6_000 });
    const found = onlyCase(rental, stops('dara'));
    assertEqual(found.shown, false, 'not shown');
    assertEqual(found.code, 'other_income_continues', 'the code');
    const shared = withFacts(COUPLE, {});
    shared.income.push({ personId: 'joint', type: 'rentalProfit', amount: 8_000 });
    assertEqual(onlyCase(shared, stops('niamh')).code, 'other_income_continues', 'shared income too');
    assertEqual(onlyCase(shared, { kind: 'death', personId: 'niamh' }).code, 'joint_income', 'and a death');
    // The other person’s own rent is fine: it carries on in their take-home.
    const theirs = withFacts(COUPLE, {});
    theirs.income.push({ personId: 'niamh', type: 'rentalProfit', amount: 6_000 });
    assertEqual(onlyCase(theirs, stops('dara')).shown, true, 'the other person’s rent is theirs');
  }));

  cases.push(runCase('Cases are independent: any order, repeated, gives the same answers, and the facts are never changed', () => {
    const facts = deepFreeze(withFacts(COUPLE, {}));
    const a = stops('niamh');
    const b = stops('dara');
    const death = { kind: 'death', personId: 'niamh' };
    const solo = {
      a: JSON.stringify(buildProtectionIncomeCases(facts, [a]).cases[0]),
      b: JSON.stringify(buildProtectionIncomeCases(facts, [b]).cases[0]),
      d: JSON.stringify(buildProtectionIncomeCases(facts, [death]).cases[0])
    };
    const sequences = [[a, b, a], [b, a, b], [death, a, b, death], [a, death, b]];
    sequences.forEach((sequence, index) => {
      const run = buildProtectionIncomeCases(facts, sequence);
      sequence.forEach((request, position) => {
        const key = request === a ? 'a' : (request === b ? 'b' : 'd');
        assertEqual(JSON.stringify(run.cases[position]), solo[key], `sequence ${index + 1}, position ${position + 1}`);
      });
    });
    assertEqual(JSON.stringify(facts), JSON.stringify(withFacts(COUPLE, {})), 'the facts are as they were');
    assertEqual(JSON.stringify(buildProtectionIncomeCases(facts, [a, b]).today), JSON.stringify(buildProtectionIncomeCases(facts, [b, a]).today), 'today does not depend on the cases');
  }));

  cases.push(runCase('Stated bank pay sets the level, and a case moves it by what the engine says changes', () => {
    const anchored = withFacts(COUPLE, {});
    anchored.people[0].anchorTakeHome = 56_000;
    anchored.people[1].anchorTakeHome = 33_000;
    const plain = onlyCase(withFacts(COUPLE, {}), stops('dara'));
    const found = onlyCase(anchored, stops('dara'));
    const today = buildProtectionIncomeCases(withFacts(COUPLE, {}), []).today;
    const [during] = found.scenario.income.phases;
    const estimateChange = plain.scenario.income.phases[0].takeHome.niamh - today.takeHome.niamh;
    assertWithin(during.takeHome.niamh, 56_000 + estimateChange, 1.01, 'Niamh’s stated pay, moved by the engine’s change');
    assertWithin(found.reconciliation.statedPayAdjustment, 56_000 - today.takeHome.niamh, 1.01, 'the adjustment is returned beside the totals');
    assertEqual(during.takeHome.niamh + during.statePayment.amount, during.householdNetIncome, 'and the parts still add up');
  }));

  cases.push(runCase('Personal pension contributions come out of pay but not out of the household’s net income, and stop with the pay', () => {
    const facts = withFacts(COUPLE, {});
    facts.people[0].personalPensionContribution = 5_000;
    facts.people[1].personalPensionContribution = 2_000;
    const found = onlyCase(facts, stops('dara'));
    const [during, after] = found.scenario.income.phases;
    const direct = engine(2026, facts.taxStatus, PEOPLE, [
      { personId: 'niamh', type: 'employment', amount: 75_000 },
      { personId: 'niamh', type: 'employmentPensionContribution', amount: 5_000 },
      { personId: 'dara', type: 'illnessBenefit', amount: 13_208 }
    ]);
    assertEqual(during.householdNetIncome, Math.round(direct.totals.netIncome - 5_000), 'net of the one contribution still being paid');
    assertEqual(found.reconciliation.personalPension, 5_000, 'Dara’s stops with Dara’s pay');
    assert(after.takeHome.niamh > 0, 'Niamh’s pay continues');
  }));

  cases.push(runCase('A death: the survivor’s pension is the register’s rate for their age, taxed as theirs, or a stated amount as given', () => {
    const facts = withFacts(COUPLE, {});
    const found = onlyCase(facts, { kind: 'death', personId: 'niamh' });
    const [phase] = found.scenario.income.phases;
    assertEqual(found.scenario.income.phases.length, 1, 'a survivor’s pension carries on');
    assertEqual(phase.statePayment.scheme, 'bereavedPartnerPension', 'the scheme');
    assertEqual(phase.statePayment.weeklyRate, 259.5, 'the under-66 rate');
    assertEqual(phase.statePayment.grossAmount, 13_494, '259.50 for 52 weeks');
    assert(/personal_under_66\.from_2026_01_01$/.test(phase.statePayment.figure.id), 'traceable to the register’s figure');
    assertEqual(phase.takeHome.niamh, 0, 'Niamh’s take-home stops');
    const alone = engine(2026, 'widowed_or_surviving_civil_partner', [PEOPLE[1]], [
      { personId: 'dara', type: 'employment', amount: 40_000 },
      { personId: 'dara', type: 'bereavedPartnerPension', amount: 13_494 }
    ]);
    assertEqual(phase.householdNetIncome, Math.round(alone.totals.netIncome), 'the engine’s net income for the survivor alone');
    assertEqual(phase.takeHome.dara + phase.statePayment.amount, phase.householdNetIncome, 'the parts add up');
    assertEqual(alone.people[0].usc.usc, engine(2026, 'widowed_or_surviving_civil_partner', [PEOPLE[1]], [{ personId: 'dara', type: 'employment', amount: 40_000 }]).people[0].usc.usc, 'no USC on the pension');

    const older = withFacts(COUPLE, {});
    older.people[1].age = 70;
    assertEqual(onlyCase(older, { kind: 'death', personId: 'niamh' }).scenario.income.phases[0].statePayment.weeklyRate, 299.3, 'the 66 to 79 rate');

    const stated = onlyCase(facts, { kind: 'death', personId: 'niamh', survivorsPension: 11_000 });
    const statedPayment = stated.scenario.income.phases[0].statePayment;
    assertEqual(statedPayment.scheme, 'stated', 'a stated survivor’s pension');
    assertEqual(statedPayment.amount, 11_000, 'used as given');
    assert(!JSON.stringify(stated.scenario).includes('bereavedPartnerPension'), 'with no rate assumed');

    const lone = onlyCase(SINGLE, { kind: 'death', personId: 'ann' });
    assertEqual(lone.shown, false, 'a household of one has no survivor');
    assertEqual(lone.code, 'needs_two_people', 'and says so');
  }));

  cases.push(runCase('Every case the adapter makes is accepted by the protection gap engine and speaks in its approved words', () => {
    const facts = withFacts(COUPLE, {});
    const built = buildProtectionIncomeCases(facts, [stops('niamh'), stops('dara'), { kind: 'death', personId: 'niamh' }]);
    const input = {
      people: PEOPLE.map((person) => ({ id: person.id, label: person.label, takeHome: Math.round(built.today.takeHome[person.id]) })),
      needed: 72_000,
      savings: 25_000,
      scenarios: [{ id: 'today' }, ...built.cases.map((entry) => entry.scenario)]
    };
    normalizeProtectionGapInputs(input);
    const projection = computeProtectionGapProjection(input);
    assertEqual(projection.debug.cases.length, 4, 'today and three cases');
    projection.debug.cases.slice(1).forEach((entry) => {
      assertEqual(entry.income.basis, 'estimated', `${entry.id}: estimated`);
      assertEqual(entry.income.calculationYear, 2026, `${entry.id}: the year`);
      assertEqual(entry.income.versions.taxRules, 'ie-tax-2026.7', `${entry.id}: the tax rules`);
    });
    assert(projection.debug.cases[1].sentence.includes('Assumes the standard personal rate of Illness Benefit'), 'the approved wording');
    assert(projection.debug.footnote.includes('Tax is recalculated for each case. If one of you stops working, the other person’s take-home may change.'), 'the footnote');
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };
  if (failed > 0) {
    console.warn('[ProtectionIncomeTests] Completed with failures', summary);
  } else {
    console.info('[ProtectionIncomeTests] All tests passed', { total: summary.total, passed: summary.passed });
  }
  return summary;
}
