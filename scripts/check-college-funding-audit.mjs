#!/usr/bin/env node

/**
 * PHASE 5 MODULE #8 — COLLEGE FUNDING, PROVED ARITHMETICALLY.
 *
 * The last runnable module, and the most self-contained: every figure in it is
 * a Planéir assumption rather than something the client supplied, so the risks
 * are not in the numbers but in WHICH numbers and WHOSE.
 *
 * Two things distinguish it from every other module audited:
 *
 *   - It inflates at the EDUCATION rate (4%), deliberately higher than the
 *     general rate (2%). Silently using the general rate would understate
 *     every future year, and would look entirely plausible.
 *   - Its whole point is the PEAK year, when two children's college terms
 *     overlap. That is the year a household actually has to fund, and it is
 *     the likeliest place for an off-by-one to hide.
 *
 * THE REFERENCE CALCULATOR BELOW IS DELIBERATELY SEPARATE from the engine. It
 * builds each child's own window and each year's household total from first
 * principles, importing nothing from `college_funding_math.js`.
 *
 * THE DEFECT THIS PINS. `children: []` — an explicit statement that there are
 * no children — fell through to the legacy `childrenCount`/`childCurrentAge`
 * path, which invented one child aged thirteen and produced a €20,000 college
 * plan for a dependant nobody had. An absent `children` key genuinely does
 * mean "legacy shape"; an empty one means "none", and the two are now told
 * apart.
 */

import assert from 'node:assert/strict';

import { computeCollegeFundingProjection } from '../js/college_funding_math.js';
import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';
import {
  buildCollegeFundingInput,
  getCollegeFundingReadiness,
  validateCollegeFundingInput
} from '../js/planning/adapters/college_funding.js';
import { PLANEIR_ASSUMPTIONS, approvedCollegeScenarios } from '../js/planning/planeir_assumptions.js';
import { runPlanningModule } from '../js/planning/module_registry.js';
import { MODULE_FAILURE_CODES, classifyModuleFailure } from '../js/planning/module_failures.js';

const pass = (message) => console.info(`[CollegeAudit] PASS: ${message}`);

const NOW = '2026-08-18T09:00:00.000Z';
const TODAY = '2026-08-18';
const CURRENT_YEAR = 2026;

/* ------------------------------------------------ independent arithmetic */

/**
 * The household's college bill, year by year, from first principles.
 *
 * Each child attends from the year they reach the start age, for the duration,
 * and each year's cost is today's cost inflated from today by that many years.
 * The household total in a year is simply what every attending child costs.
 */
function referenceSchedule({ children, currentYear, inflationRate, annualCostTodayPerChild }) {
  const windows = children.map((child) => {
    const firstYear = currentYear + (child.collegeStartAge - child.currentAge);
    return { id: child.id, firstYear, finalYear: firstYear + child.collegeDurationYears - 1 };
  });
  const firstCollegeYear = Math.min(...windows.map((window) => window.firstYear));
  const finalCollegeYear = Math.max(...windows.map((window) => window.finalYear));
  const rows = [];
  for (let year = firstCollegeYear; year <= finalCollegeYear; year += 1) {
    const attending = windows.filter((window) => year >= window.firstYear && year <= window.finalYear).length;
    const today = attending * annualCostTodayPerChild;
    rows.push({
      year,
      attending,
      today,
      nominal: today * Math.pow(1 + inflationRate, year - currentYear)
    });
  }
  return {
    firstCollegeYear,
    finalCollegeYear,
    fundingPeriodYears: finalCollegeYear - firstCollegeYear + 1,
    rows,
    costToday: rows.reduce((total, row) => total + row.today, 0),
    nominalCost: rows.reduce((total, row) => total + row.nominal, 0),
    peakAnnualCost: Math.max(...rows.map((row) => row.nominal)),
    peakChildrenAttending: Math.max(...rows.map((row) => row.attending))
  };
}

// Costs run to tens of thousands over two decades of compounding, so a cent is
// the meaningful tolerance; anything larger is a real disagreement.
const CENT = 0.01;
const close = (actual, expected, tolerance, note) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${note}: expected ${expected}, got ${actual} (tolerance ${tolerance})`
);

const COLLEGE = PLANEIR_ASSUMPTIONS.collegeFunding;
const EDUCATION_RATE = PLANEIR_ASSUMPTIONS.inflation.educationRate;
const AT_HOME = approvedCollegeScenarios().find((scenario) => scenario.id === 'living_at_home');
const AWAY = approvedCollegeScenarios().find((scenario) => scenario.id === 'living_away');

const child = (id, currentAge) => ({
  id, title: id, currentAge,
  collegeStartAge: COLLEGE.startAge,
  collegeDurationYears: COLLEGE.durationYears
});

const project = (children, over = {}) => computeCollegeFundingProjection({
  currentYear: CURRENT_YEAR, inflationRate: EDUCATION_RATE, children,
  scenarios: approvedCollegeScenarios(), ...over
});
const atHome = (result) => result.debug.scenarios.find((scenario) => scenario.id === 'living_at_home');

/* --------------------------------------------------- the versioned rules */

{
  assert.equal(COLLEGE.startAge, 18, 'college starts at 18');
  assert.equal(COLLEGE.durationYears, 4, 'and runs four years');
  assert.equal(AT_HOME.annualCostTodayPerChild, 5_000);
  assert.equal(AWAY.annualCostTodayPerChild, 15_000);
  assert.equal(EDUCATION_RATE, 0.04);
  assert.equal(PLANEIR_ASSUMPTIONS.inflation.generalRate, 0.02);
  assert.notEqual(EDUCATION_RATE, PLANEIR_ASSUMPTIONS.inflation.generalRate,
    'education inflation is deliberately not the general rate');
  pass('the start age, duration, scenario costs and education rate all come from the versioned assumptions');
}

/* ------------------------------------------------------ hand-checkable */

{
  // A child aged 17, living at home at €5,000 a year today. College starts
  // next year, so the first year costs €5,200 — every figure confirmable
  // without running anything.
  const result = project([child('a', 17)]);
  const scenario = atHome(result);
  assert.equal(result.debug.collegeStartYear, 2027, 'one year from now');
  assert.equal(result.debug.collegeEndYear, 2030, 'and four years long');
  assert.equal(result.debug.fundingPeriodYears, 4);
  const expected = [1, 2, 3, 4].map((offset) => 5_000 * Math.pow(1.04, offset));
  scenario.totalNominalSeries.forEach((value, index) => {
    close(value, expected[index], CENT, `year ${2027 + index}`);
  });
  close(scenario.totalNominalSeries[0], 5_200, CENT, 'the first year is exactly €5,200');
  close(scenario.costToday, 20_000, CENT, 'four years at today’s cost');
  close(scenario.nominalCost, expected.reduce((a, b) => a + b, 0), CENT, 'and the inflated total');
  pass('hand-checkable: a 17-year-old living at home costs €5,200 in the first year, four years from 2027');
}

{
  // THE ASSUMPTION THAT MATTERS. At the general rate the first year would be
  // €5,100 — plausible, and wrong by the difference education inflation exists
  // to capture.
  const educational = atHome(project([child('a', 17)]));
  const general = atHome(project([child('a', 17)], { inflationRate: PLANEIR_ASSUMPTIONS.inflation.generalRate }));
  close(educational.totalNominalSeries[0], 5_200, CENT, 'education inflation');
  close(general.totalNominalSeries[0], 5_100, CENT, 'the general rate would give €5,100');
  assert.ok(educational.nominalCost > general.nominalCost, 'and understate the whole plan');
  pass('education inflation is applied, not the general rate — €5,200 in year one, not €5,100');
}

{
  // Living away is three times the cost, on the same timeline.
  const result = project([child('a', 17)]);
  const away = result.debug.scenarios.find((scenario) => scenario.id === 'living_away');
  close(away.totalNominalSeries[0], 15_600, CENT, '15,000 inflated one year');
  close(away.costToday, 60_000, CENT);
  assert.equal(away.years.length, atHome(result).years.length, 'the timeline is the same either way');
  pass('the living-away scenario scales the cost without moving the timeline');
}

/* ------------------------------------------- the peak, and the overlap */

{
  // THE MODULE'S WHOLE POINT. A 17-year-old and a 14-year-old overlap in
  // exactly one year, and that year costs two children at once.
  const children = [child('a', 17), child('b', 14)];
  const expected = referenceSchedule({
    children, currentYear: CURRENT_YEAR,
    inflationRate: EDUCATION_RATE, annualCostTodayPerChild: AT_HOME.annualCostTodayPerChild
  });
  const result = project(children);
  const scenario = atHome(result);

  assert.equal(result.debug.collegeStartYear, expected.firstCollegeYear, 'the window starts with the elder');
  assert.equal(result.debug.collegeEndYear, expected.finalCollegeYear, 'and ends with the younger');
  assert.equal(result.debug.fundingPeriodYears, 7, '2027 to 2033 inclusive');
  assert.deepEqual(
    scenario.childrenAttendingSeries,
    expected.rows.map((row) => row.attending),
    'attendance year by year'
  );
  assert.deepEqual(scenario.childrenAttendingSeries, [1, 1, 1, 2, 1, 1, 1], 'they overlap in 2030 alone');
  scenario.totalNominalSeries.forEach((value, index) => {
    close(value, expected.rows[index].nominal, CENT, `household cost in ${expected.rows[index].year}`);
  });
  close(scenario.peakAnnualCost, expected.peakAnnualCost, CENT, 'the peak year');
  close(scenario.peakAnnualCost, 2 * 5_000 * Math.pow(1.04, 4), CENT, 'two children in 2030');
  assert.equal(scenario.peakChildrenAttending, 2);
  // The peak is NOT simply the last year, which is what a naive maximum over a
  // single inflating series would give.
  assert.ok(
    scenario.peakAnnualCost > scenario.totalNominalSeries.at(-1),
    'the overlap year outweighs the most-inflated year'
  );
  pass('two children overlapping in one year produce a peak of two children, not of the last year');
}

{
  // Three children, two overlaps of two and one of three.
  const children = [child('a', 17), child('b', 16), child('c', 15)];
  const expected = referenceSchedule({
    children, currentYear: CURRENT_YEAR,
    inflationRate: EDUCATION_RATE, annualCostTodayPerChild: AT_HOME.annualCostTodayPerChild
  });
  const scenario = atHome(project(children));
  assert.deepEqual(scenario.childrenAttendingSeries, expected.rows.map((row) => row.attending));
  assert.equal(scenario.peakChildrenAttending, 3, 'all three are in college together at the peak');
  close(scenario.peakAnnualCost, expected.peakAnnualCost, CENT);
  close(scenario.nominalCost, expected.nominalCost, CENT, 'and the total matches the reference');
  pass('three closely spaced children peak at three attending at once');
}

{
  // Children far enough apart leave a gap with nobody in college, and the gap
  // must cost nothing rather than carrying a phantom year.
  const children = [child('a', 17), child('b', 10)];
  const expected = referenceSchedule({
    children, currentYear: CURRENT_YEAR,
    inflationRate: EDUCATION_RATE, annualCostTodayPerChild: AT_HOME.annualCostTodayPerChild
  });
  const scenario = atHome(project(children));
  assert.deepEqual(scenario.childrenAttendingSeries, [1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1]);
  scenario.totalNominalSeries.forEach((value, index) => {
    close(value, expected.rows[index].nominal, CENT, `year ${expected.rows[index].year}`);
    if (expected.rows[index].attending === 0) assert.equal(value, 0, 'a gap year costs nothing');
  });
  assert.equal(scenario.peakChildrenAttending, 1, 'they never overlap');
  close(scenario.costToday, 8 * 5_000, CENT, 'eight funded years across two children');
  pass('non-overlapping children leave gap years that cost nothing, and never overlap');
}

/* ---------------------------------------- costs are per child, not per parent */

{
  // The household shape must not touch the bill. One child costs the same
  // whether the profile holds one parent or two.
  const profileOf = (dependants, over = {}) => normalizeHouseholdProfile({
    ...createHouseholdProfile({ profileId: 'col', nowIso: NOW, calculationDateIso: TODAY }),
    primaryPerson: { personId: 'primary', role: 'primary', employmentStatus: 'employee', age: 45 },
    dependants,
    goals: [{ goalId: 'g1', type: 'fund_education', priority: 'high', status: 'active', title: 'Fund college' }],
    assumptions: { calculationDateIso: TODAY, values: {} },
    ...over
  });
  const dependant = (dependantId, currentAge) => ({ dependantId, displayName: dependantId, currentAge });

  const single = buildCollegeFundingInput(profileOf([dependant('kid', 17)]));
  const couple = buildCollegeFundingInput(profileOf([dependant('kid', 17)], {
    partner: { personId: 'partner', role: 'partner', employmentStatus: 'employee', age: 44 }
  }));
  assert.equal(single.children.length, 1);
  assert.deepEqual(
    couple.children.map((entry) => entry.id),
    single.children.map((entry) => entry.id),
    'a second parent does not create a second child'
  );
  close(
    atHome(computeCollegeFundingProjection(couple)).nominalCost,
    atHome(computeCollegeFundingProjection(single)).nominalCost,
    CENT,
    'and does not change the bill'
  );

  // The adapter takes the education rate, and the start age and duration, from
  // the approved assumptions rather than restating them.
  assert.equal(single.inflationRate, EDUCATION_RATE, 'the education rate reaches the engine');
  assert.equal(single.children[0].collegeStartAge, COLLEGE.startAge);
  assert.equal(single.children[0].collegeDurationYears, COLLEGE.durationYears);
  assert.deepEqual(
    single.scenarios.map((scenario) => scenario.id),
    approvedCollegeScenarios().map((scenario) => scenario.id),
    'and the scenarios are the approved ones'
  );

  // Each dependant becomes exactly one child, by their own identity.
  const three = buildCollegeFundingInput(profileOf([
    dependant('eldest', 17), dependant('middle', 14), dependant('youngest', 10)
  ]));
  assert.deepEqual(
    three.children.map((entry) => entry.id).sort(),
    ['eldest', 'middle', 'youngest'],
    'one child per dependant, resolved by id'
  );
  assert.deepEqual(three.children.map((entry) => entry.currentAge), [17, 14, 10], 'each with their own age');
  pass('costs are per child: parents do not multiply them and each dependant appears exactly once');
}

/* ------------------------------------------------------------ edge cases */

{
  // A newborn's college is eighteen years away, and still four years long.
  const result = project([child('a', 0)]);
  assert.equal(result.debug.collegeStartYear, CURRENT_YEAR + 18);
  assert.equal(result.debug.collegeEndYear, CURRENT_YEAR + 21);
  const scenario = atHome(result);
  close(scenario.totalNominalSeries[0], 5_000 * Math.pow(1.04, 18), CENT, 'eighteen years of education inflation');
  pass('a newborn’s college is eighteen years out and still costs four years');
}

{
  // A child who has already reached the start age has no future college to
  // fund on these rules, and the engine refuses rather than DEFLATING the cost
  // back below today's money — which a negative year offset would do.
  for (const age of [18, 20]) {
    assert.throws(
      () => project([child('a', age)]),
      /collegeStartAge must be greater than currentAge/,
      `a child already aged ${age} is refused`
    );
  }
  pass('a child already at or past the start age is refused, never costed at a deflated past-year price');
}

{
  const refusals = [
    [[child('a', -1)], /currentAge must be an integer greater than or equal to 0/, 'a negative age'],
    [[child('a', 10.5)], /currentAge must be an integer/, 'a fractional age'],
    [[child('a', 10), child('a', 12)], /must be unique/, 'two children sharing an id']
  ];
  for (const [children, pattern, note] of refusals) {
    assert.throws(() => project(children), pattern, `refused: ${note}`);
  }
  pass('negative, fractional and duplicated children are all refused at the engine');
}

/* ------------------------------------------------------ the phantom child */

{
  // THE DEFECT. An explicitly empty list said "there are no children" and was
  // answered with an invented thirteen-year-old and a €20,000 plan.
  assert.throws(
    () => project([]),
    /must name at least one child when provided/,
    'an empty children list is refused'
  );

  // The legacy shape it used to fall through to is untouched: an ABSENT
  // `children` key still means "use childrenCount / childCurrentAge".
  const legacy = computeCollegeFundingProjection({
    currentYear: CURRENT_YEAR, inflationRate: EDUCATION_RATE,
    childrenCount: 2, childCurrentAge: 10, scenarios: approvedCollegeScenarios()
  });
  assert.equal(legacy.debug.collegeStartYear, 2034, 'ten-year-olds start college in eight years');
  assert.equal(legacy.debug.collegeEndYear, 2037);
  const legacyScenario = legacy.debug.scenarios.find((scenario) => scenario.id === 'living_at_home');
  close(legacyScenario.costToday, 2 * 4 * 5_000, CENT, 'two children, four years each');
  pass('an empty children list is refused while the legacy childrenCount shape still works');
}

/* ------------------------------------------------------- input contract */

{
  const profile = normalizeHouseholdProfile({
    ...createHouseholdProfile({ profileId: 'col', nowIso: NOW, calculationDateIso: TODAY }),
    primaryPerson: { personId: 'primary', role: 'primary', employmentStatus: 'employee', age: 45 },
    dependants: [{ dependantId: 'kid', displayName: 'Kid', currentAge: 17 }],
    goals: [{ goalId: 'g1', type: 'fund_education', priority: 'high', status: 'active', title: 'Fund college' }],
    assumptions: { calculationDateIso: TODAY, values: {} }
  });
  const valid = buildCollegeFundingInput(profile);
  assert.doesNotThrow(() => validateCollegeFundingInput(valid));

  const refusals = [
    [{ ...valid, children: [] }, /at least one child/, 'no children'],
    [
      { ...valid, children: [valid.children[0], { ...valid.children[0] }] },
      /each child exactly once/, 'the same child twice'
    ],
    [
      { ...valid, children: [{ ...valid.children[0], currentAge: 45 }] },
      /age between 0 and 30/, 'an adult as a dependant child'
    ],
    [
      { ...valid, inflationRate: PLANEIR_ASSUMPTIONS.inflation.generalRate },
      /approved education inflation rate/, 'the general rate in place of the education rate'
    ]
  ];
  for (const [input, pattern, note] of refusals) {
    assert.throws(() => validateCollegeFundingInput(input), pattern, `refused: ${note}`);
  }
  pass('the input contract refuses no children, duplicates, adult ages and the wrong inflation rate');
}

{
  // A household with no dependants at all is asked, not projected.
  const noKids = normalizeHouseholdProfile({
    ...createHouseholdProfile({ profileId: 'col', nowIso: NOW, calculationDateIso: TODAY }),
    primaryPerson: { personId: 'primary', role: 'primary', employmentStatus: 'employee', age: 45 },
    goals: [{ goalId: 'g1', type: 'fund_education', priority: 'high', status: 'active', title: 'Fund college' }],
    assumptions: { calculationDateIso: TODAY, values: {} }
  });
  const readiness = getCollegeFundingReadiness(noKids);
  assert.equal(readiness.status, 'missing_information');
  assert.ok(readiness.requiredMissing.some((item) => item.fieldPath === '/dependants'));

  let error = null;
  try {
    await runPlanningModule('college_funding', noKids, { calculationVersion: 'test', calculatedAt: NOW });
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, 'and a direct run fails rather than inventing a child');
  assert.equal(classifyModuleFailure(error), MODULE_FAILURE_CODES.INPUT_INVALID);
  pass('a household with no dependants is asked for them and never receives an invented projection');
}

/* --------------------------------------------------------- end to end */

{
  const profile = normalizeHouseholdProfile({
    ...createHouseholdProfile({ profileId: 'col', nowIso: NOW, calculationDateIso: TODAY }),
    primaryPerson: { personId: 'primary', role: 'primary', employmentStatus: 'employee', age: 45 },
    partner: { personId: 'partner', role: 'partner', employmentStatus: 'employee', age: 44 },
    dependants: [
      { dependantId: 'eldest', displayName: 'Eldest', currentAge: 11 },
      { dependantId: 'younger', displayName: 'Younger', currentAge: 8 }
    ],
    goals: [{ goalId: 'g1', type: 'fund_education', priority: 'high', status: 'active', title: 'Fund college' }],
    assumptions: { calculationDateIso: TODAY, values: {} }
  });
  const readiness = getCollegeFundingReadiness(profile);
  assert.ok(['ready', 'ready_with_assumptions'].includes(readiness.status));
  // Every assumption the client never supplied is declared back to them, with
  // its basis — including that education inflation is the higher rate.
  const declared = new Map(readiness.assumptionsUsed.map((item) => [item.key, item]));
  assert.deepEqual(
    [...declared.keys()].sort(),
    ['collegeAnnualCostsToday', 'collegeDurationYears', 'collegeStartAge', 'educationInflationRate'],
    'the cost basis, the timing and the inflation rate are all declared'
  );
  assert.equal(declared.get('educationInflationRate').value, EDUCATION_RATE);
  assert.match(declared.get('educationInflationRate').reason, /faster than general consumer prices/);
  assert.equal(declared.get('collegeStartAge').value, COLLEGE.startAge);
  assert.equal(declared.get('collegeDurationYears').value, COLLEGE.durationYears);

  const result = await runPlanningModule('college_funding', profile, {
    calculationVersion: 'test', calculatedAt: NOW, scenarioOverrides: {}
  });
  assert.equal(result.moduleId, 'college_funding');

  const expected = referenceSchedule({
    children: [child('eldest', 11), child('younger', 8)],
    currentYear: CURRENT_YEAR,
    inflationRate: EDUCATION_RATE,
    annualCostTodayPerChild: AT_HOME.annualCostTodayPerChild
  });
  assert.equal(result.semanticResult.firstCollegeYear, expected.firstCollegeYear, '2033');
  assert.equal(result.semanticResult.finalCollegeYear, expected.finalCollegeYear, '2039');
  assert.equal(result.semanticResult.fundingPeriodYears, expected.fundingPeriodYears);
  close(
    result.semanticResult.peakAnnualCostRange.low,
    expected.peakAnnualCost,
    CENT,
    'the peak matches the independently computed overlap year'
  );
  close(result.semanticResult.costTodayRange.low, expected.costToday, CENT, 'as does the cost in today’s money');
  close(result.semanticResult.nominalCostRange.low, expected.nominalCost, CENT, 'and the inflated total');
  pass('college funding runs end to end and reports the independently computed peak and totals');
}

console.info('[CollegeAudit] All college funding audit checks passed.');
