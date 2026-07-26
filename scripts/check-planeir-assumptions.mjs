// Centrally approved Planéir assumptions.
//
// Pension and college figures reach consumers, so the assumptions behind them
// are defined once, versioned, and stated in plain language wherever a number is
// shown. These assertions hold that: the engines read the central values rather
// than a local copy, the wording presents planning assumptions rather than
// guaranteed outcomes, and the college projection handles several children with
// overlapping years.

import assert from 'node:assert/strict';

import {
  PLANEIR_ASSUMPTIONS,
  PLANEIR_ASSUMPTIONS_VERSION,
  approvedCollegeScenarios,
  assumptionRecord,
  resolvePlanningAssumptions
} from '../js/planning/planeir_assumptions.js';
import {
  buildCollegeFundingInput,
  getCollegeFundingReadiness
} from '../js/planning/adapters/college_funding.js';
import {
  buildPensionProjectionInput,
  getPensionProjectionReadiness
} from '../js/planning/adapters/retirement.js';
import { computeCollegeFundingProjection } from '../js/college_funding_math.js';
import {
  applyProfilePatch,
  createHouseholdProfile,
  extractRulesOnlyProfilePatch
} from '../js/planning/index.js';

const NOW = '2026-07-26T09:00:00.000Z';
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.info(`[PlaneirAssumptions] PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[PlaneirAssumptions] FAIL: ${name}\n    ${error.message}`);
  }
}

function emptyProfile(id) {
  return createHouseholdProfile({ profileId: id, nowIso: NOW, calculationDateIso: NOW.slice(0, 10) });
}

function apply(profile, operations) {
  return applyProfilePatch(profile, {
    patchId: 'assumption-test',
    operations: operations.map((operation) => ({
      ...operation,
      provenance: {
        source: 'user_statement', confidence: 'high', certainty: 'exact',
        capturedAt: NOW, confirmedByUser: false
      }
    }))
  }, { nowIso: NOW }).profile;
}

function collegeProfile(children) {
  let profile = emptyProfile('assumption-college');
  return apply(profile, [
    { op: 'add', path: '/goals/-', value: { goalId: 'edu', type: 'fund_education', title: 'Fund education', priority: 'high', status: 'active' } },
    ...children.map((child) => ({
      op: 'add', path: '/dependants/-',
      value: { dependantId: child.id, displayName: child.name, currentAge: child.age }
    }))
  ]);
}

// ---------------------------------------------------------------------------
// Central configuration
// ---------------------------------------------------------------------------

check('the approved values are versioned and centrally defined', () => {
  assert.equal(PLANEIR_ASSUMPTIONS.version, PLANEIR_ASSUMPTIONS_VERSION);
  assert.equal(PLANEIR_ASSUMPTIONS.investment.nominalGrowthRate, 0.05);
  assert.equal(PLANEIR_ASSUMPTIONS.inflation.generalRate, 0.02);
  assert.equal(PLANEIR_ASSUMPTIONS.inflation.educationRate, 0.04);
  assert.equal(PLANEIR_ASSUMPTIONS.collegeFunding.startAge, 18);
  assert.equal(PLANEIR_ASSUMPTIONS.collegeFunding.durationYears, 4);
});

check('advisers cannot override the central assumptions in this version', () => {
  const overridden = resolvePlanningAssumptions({
    adviserOverrides: { investment: { nominalGrowthRate: 0.09 } }
  });
  assert.equal(overridden.investment.nominalGrowthRate, 0.05,
    'adviser overrides must not take effect while assumptions are centrally controlled');
  assert.equal(overridden, PLANEIR_ASSUMPTIONS);
});

// ---------------------------------------------------------------------------
// Pension
// ---------------------------------------------------------------------------

check('the pension engine reads the central growth and inflation values', () => {
  let profile = emptyProfile('assumption-pension');
  const extraction = extractRulesOnlyProfilePatch(
    "I'm 45 and earn €90k. I want to retire at 62 with €50k a year in retirement. My pension pot is €220k, I contribute 8% and my employer contributes 6%.",
    { profile, capturedAt: NOW, conversationTurnId: 'turn' }
  );
  profile = applyProfilePatch(profile, extraction.patch, { nowIso: NOW }).profile;
  const input = buildPensionProjectionInput(profile);
  assert.equal(input.growthRate, PLANEIR_ASSUMPTIONS.investment.nominalGrowthRate);
  assert.equal(input.inflationRate, PLANEIR_ASSUMPTIONS.inflation.generalRate);
});

check('the pension growth assumption explains its basis without promising a return', () => {
  const record = assumptionRecord('investmentGrowth');
  assert.equal(record.value, 0.05);
  assert.match(record.reason, /medium-risk diversified portfolio/i);
  assert.match(record.reason, /long term/i);
  assert.match(record.reason, /planning assumption/i);
  assert.match(record.reason, /not a guaranteed return/i);
  assert.ok(record.reason.includes(PLANEIR_ASSUMPTIONS_VERSION), 'the assumption must name its version');
  assert.doesNotMatch(record.reason, /\b(?:will earn|guarantees?|expected return of)\b/i);
});

check('pension disclosures do not expose the gated retirement analysis', () => {
  let profile = emptyProfile('assumption-pension-warning');
  const extraction = extractRulesOnlyProfilePatch(
    'I want to retire at 65 and review my pension.',
    { profile, capturedAt: NOW, conversationTurnId: 'warning-turn' }
  );
  profile = applyProfilePatch(profile, extraction.patch, { nowIso: NOW }).profile;
  const readiness = getPensionProjectionReadiness(profile);
  const copy = (readiness.warnings || []).join(' ');
  assert.match(copy, /shown before tax/i);
  assert.doesNotMatch(copy, /net retirement|cash-flow view|net_retirement_cashflow/i);
});

// ---------------------------------------------------------------------------
// College funding
// ---------------------------------------------------------------------------

check('the college scenarios are the approved standard costs', () => {
  const scenarios = approvedCollegeScenarios();
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  assert.equal(byId.get('living_at_home').annualCostTodayPerChild, 5_000);
  assert.equal(byId.get('living_away').annualCostTodayPerChild, 15_000);
  assert.equal(scenarios.length, 2);
});

check('college readiness no longer demands a client-supplied cost basis', () => {
  const readiness = getCollegeFundingReadiness(collegeProfile([{ id: 'a', name: 'Child', age: 10 }]));
  assert.ok(
    !(readiness.requiredMissing || []).some((item) => item.fieldPath.includes('collegeFunding/scenarios')),
    'a client cannot be expected to supply an approved cost basis'
  );
  const keys = (readiness.assumptionsUsed || []).map((item) => item.key);
  for (const key of ['collegeAnnualCostsToday', 'educationInflationRate', 'collegeStartAge', 'collegeDurationYears']) {
    assert.ok(keys.includes(key), `readiness must disclose ${key}`);
  }
  assert.ok((readiness.warnings || []).some((warning) => (
    /planning estimates/i.test(warning) && /not guaranteed future costs/i.test(warning)
  )), 'readiness must say these are estimates rather than guaranteed costs');
});

check('the college engine uses education inflation, not general inflation', () => {
  const input = buildCollegeFundingInput(collegeProfile([{ id: 'a', name: 'Child', age: 10 }]));
  assert.equal(input.inflationRate, PLANEIR_ASSUMPTIONS.inflation.educationRate);
  assert.notEqual(input.inflationRate, PLANEIR_ASSUMPTIONS.inflation.generalRate);
  assert.equal(input.children[0].collegeStartAge, 18);
  assert.equal(input.children[0].collegeDurationYears, 4);
  assert.deepEqual(input.scenarios.map((item) => item.annualCostTodayPerChild), [5_000, 15_000]);
});

check('education inflation explains why it is higher than general inflation', () => {
  const record = assumptionRecord('educationInflation');
  assert.equal(record.value, 0.04);
  assert.match(record.reason, /faster than general consumer prices/i);
});

check('each child is projected from their own age for four years', () => {
  const profile = collegeProfile([
    { id: 'older', name: 'Older', age: 16 },
    { id: 'younger', name: 'Younger', age: 12 }
  ]);
  const projection = computeCollegeFundingProjection(buildCollegeFundingInput(profile));
  const children = projection.debug.inputs.children;
  const older = children.find((child) => child.id === 'older');
  const younger = children.find((child) => child.id === 'younger');
  // 2026 + (18 - 16) = 2028, running four years to 2031.
  assert.equal(older.firstCollegeYear, 2028);
  assert.equal(older.finalCollegeYear, 2031);
  assert.equal(younger.firstCollegeYear, 2032);
  assert.equal(younger.finalCollegeYear, 2035);
});

check('overlapping college years are modelled, not double-counted or dropped', () => {
  // Ages 14 and 12: first child 2030-2033, second 2032-2035, overlapping in
  // 2032 and 2033.
  const profile = collegeProfile([
    { id: 'first', name: 'First', age: 14 },
    { id: 'second', name: 'Second', age: 12 }
  ]);
  const projection = computeCollegeFundingProjection(buildCollegeFundingInput(profile));
  const atHome = projection.debug.scenarios.find((scenario) => scenario.id === 'living_at_home');
  const years = atHome.years;
  const attending = atHome.childrenAttendingSeries;
  assert.equal(years.length, attending.length);

  const overlapYears = years.filter((_year, index) => attending[index] === 2);
  assert.deepEqual(overlapYears, [2032, 2033], 'both children attend in 2032 and 2033');

  // An overlap year must cost more than a single-child year in the same run.
  const singleIndex = years.indexOf(2030);
  for (const overlapYear of overlapYears) {
    const index = years.indexOf(overlapYear);
    assert.ok(
      atHome.annualNominalSeries[index] > atHome.annualNominalSeries[singleIndex],
      `${overlapYear} has two children and must cost more than a single-child year`
    );
  }

  // Eight child-years in total: two children at four years each, none lost.
  assert.equal(attending.reduce((total, count) => total + count, 0), 8);
  assert.equal(atHome.peakChildrenAttending, 2);
});

check('a later child costs more than an earlier one under education inflation', () => {
  const profile = collegeProfile([
    { id: 'soon', name: 'Soon', age: 17 },
    { id: 'later', name: 'Later', age: 5 }
  ]);
  const projection = computeCollegeFundingProjection(buildCollegeFundingInput(profile));
  const atHome = projection.debug.scenarios.find((scenario) => scenario.id === 'living_at_home');
  const first = atHome.annualNominalSeries[atHome.years.indexOf(2027)];
  const last = atHome.annualNominalSeries[atHome.years.indexOf(2042)];
  assert.ok(last > first * 1.5,
    'costs 15 years further out must be materially higher under 4% education inflation');
});

check('living away costs three times living at home in today’s money', () => {
  const scenarios = approvedCollegeScenarios();
  const atHome = scenarios.find((item) => item.id === 'living_at_home');
  const away = scenarios.find((item) => item.id === 'living_away');
  assert.equal(away.annualCostTodayPerChild / atHome.annualCostTodayPerChild, 3);
});

if (failures > 0) {
  console.error(`\n[PlaneirAssumptions] ${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.info('\n[PlaneirAssumptions] central assumptions, disclosures and multi-child projection all hold.');
}
