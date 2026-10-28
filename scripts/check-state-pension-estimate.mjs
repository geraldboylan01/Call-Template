// The State Pension (Contributory) estimate: the rules, then where each one is used.
//
//  1. The rules and their boundaries, against the Department's published worked example.
//  2. No threshold is typed in the rules: they are read from the figures register.
//  3. The pension engine uses the estimate where no fraction is confirmed, and records the basis.
//  4. The profile adapter and the plan pack use it the same way, and the missing-facts list
//     stops asking for a fraction a person's contribution years already give.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runSocialWelfareRulesTests } from '../js/tests_social_welfare_rules.js';
import { computePensionProjection, normalizePensionInputs } from '../js/pension_math.js';
import { buildPensionProjectionInput } from '../js/planning/adapters/retirement.js';
import { applyProfilePatch, createHouseholdProfile, extractRulesOnlyProfilePatch } from '../js/planning/index.js';
import { planFactsMissing } from '../js/planning/plan_facts_missing.js';
import { compilePlanPack } from '../js/planning/plan_pack/compiler.js';

let failures = 0;
const originalInfo = console.info;
console.info = () => {};

function check(name, fn) {
  try {
    fn();
    originalInfo(`[StatePensionEstimate] PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[StatePensionEstimate] FAIL: ${name}\n    ${error.stack}`);
  }
}

const summary = runSocialWelfareRulesTests();
if (summary.failed > 0) {
  failures += summary.failed;
  console.error(`[StatePensionEstimate] the rules suite has ${summary.failed} failing test(s).`);
}

check('no threshold or rate is typed in the rules: they are read from the register', () => {
  const source = readFileSync(new URL('../js/planning/social_welfare_rules.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const literal of ['2080', '2_080', '1040', '1_040', '520', '52', '66', '289', '299']) {
    assert.ok(!new RegExp(`(?<![\\w.])${literal}(?![\\w.])`).test(code), `${literal} is typed in the rules`);
  }
});

const LEGACY = Object.freeze({
  currentAge: 45,
  retirementAge: 62,
  currentSalary: 90_000,
  currentPot: 220_000,
  personalPct: 0.08,
  employerPct: 0.06,
  growthRate: 0.05,
  inflationRate: 0.02,
  wageGrowthRate: 0.02,
  horizonEndAge: 92,
  currentYear: 2026,
  incomeMode: 'target',
  targetIncomeToday: 50_000
});

check('the pension engine uses the estimate where no fraction is given, and records its basis', () => {
  // 20 years paying at 45, work to 62: 17 more = 37 years = 1,924 contributions.
  const member = normalizePensionInputs({ ...LEGACY, statePensionYears: { yearsPayingPrsi: 20, yearsCaring: 0 } }).primaryPension;
  assert.equal(member.statePensionFraction, (37 * 52) / 2080);
  assert.equal(member.includeStatePension, true);
  assert.match(member.statePensionBasis, /^An estimate under the Total Contributions Approach, from 20 years paying PRSI so far, 17 more until work stops at 62/);
  assert.deepEqual(member.statePensionYears, { yearsPayingPrsi: 20, yearsCaring: 0 });
  const rows = computePensionProjection({ ...LEGACY, statePensionYears: { yearsPayingPrsi: 20, yearsCaring: 0 } }).assumptionsTable.rows;
  const row = rows.find((entry) => entry[0] === 'State Pension');
  assert.match(row[1], /^93% of maximum from age 66\. An estimate under the Total Contributions Approach/, row[1]);
  assert.match(row[1], /Until 2034 the Department also compares a rate that blends in the yearly-average method/);
});

check('a confirmed fraction is used as it is, an excluded State Pension stays excluded, and caring counts', () => {
  const confirmed = normalizePensionInputs({ ...LEGACY, statePensionFraction: 0.6, statePensionYears: { yearsPayingPrsi: 40, yearsCaring: 0 } }).primaryPension;
  assert.equal(confirmed.statePensionFraction, 0.6, 'the confirmed fraction wins over the estimate');
  assert.equal(confirmed.statePensionBasis, undefined, 'no estimate basis for a confirmed fraction');
  const excluded = normalizePensionInputs({ ...LEGACY, includeStatePension: false, statePensionYears: { yearsPayingPrsi: 40, yearsCaring: 0 } }).primaryPension;
  assert.equal(excluded.statePensionFraction, 0);
  assert.equal(excluded.includeStatePension, false);
  const caring = normalizePensionInputs({ ...LEGACY, statePensionYears: { yearsPayingPrsi: 5, yearsCaring: 20 } }).primaryPension;
  // 5 + 17 = 22 years paid = 1,144, plus 1,040 caring = 2,184: the full rate.
  assert.equal(caring.statePensionFraction, 1);
  const notEnough = normalizePensionInputs({ ...LEGACY, retirementAge: 45, statePensionYears: { yearsPayingPrsi: 9, yearsCaring: 20 } }).primaryPension;
  assert.equal(notEnough.statePensionFraction, 0, '9 years paid is under 520, so no pension');
  assert.equal(notEnough.includeStatePension, false);
});

check('with the years not known the engine keeps the full maximum it always assumed, and says it was not estimated', () => {
  const none = normalizePensionInputs({ ...LEGACY }).primaryPension;
  assert.equal(none.statePensionFraction, 1);
  assert.equal(none.statePensionBasis, undefined, 'nothing changes for an input with no contribution years');
  const unknown = normalizePensionInputs({ ...LEGACY, statePensionYears: { yearsPayingPrsi: 20 } }).primaryPension;
  assert.equal(unknown.statePensionFraction, 1, 'the full maximum, as before');
  assert.match(unknown.statePensionBasis, /^The full maximum is assumed, not estimated\. Not estimated: years at home caring full time not known\./);
  assert.throws(() => normalizePensionInputs({ ...LEGACY, statePensionYears: 'twenty' }), /statePensionYears must be an object/);
});

const NOW = '2026-07-12T12:00:00.000Z';
const LATER = '2026-07-12T12:05:00.000Z';

function retirementProfile() {
  const draft = createHouseholdProfile({ profileId: 'profile-sp', nowIso: NOW, calculationDateIso: '2026-07-12' });
  const extraction = extractRulesOnlyProfilePatch(
    "I'm 45 and earn €90k. I want to retire at 62 with €50k a year in retirement. My pension pot is €220k, I contribute 8% and my employer contributes 6%.",
    { profile: draft, capturedAt: NOW, conversationTurnId: 'turn-sp' }
  );
  return applyProfilePatch(draft, extraction.patch, { nowIso: LATER }).profile;
}

check('the profile adapter uses the estimate where no fraction is confirmed, with its basis', () => {
  const profile = structuredClone(retirementProfile());
  const before = buildPensionProjectionInput(structuredClone(profile)).pensions[0];
  assert.equal(before.statePensionFraction, 1, 'with no facts, the full maximum as before');
  assert.equal(before.statePensionBasis, undefined, 'and no basis is invented');

  profile.assumptions.values.retirement = {
    ...(profile.assumptions.values.retirement || {}),
    statePensionContributions: { primary: { yearsPayingPrsi: 20, yearsCaring: 0 } }
  };
  const member = buildPensionProjectionInput(structuredClone(profile)).pensions[0];
  assert.equal(member.statePensionFraction, (37 * 52) / 2080);
  assert.match(member.statePensionBasis, /^An estimate under the Total Contributions Approach, from 20 years paying PRSI so far/);
  assert.deepEqual(member.statePensionYears, { yearsPayingPrsi: 20, yearsCaring: 0 });
  assert.equal(member.includeStatePension, true);
  // The engine accepts what the adapter builds, and shows the basis.
  const projection = computePensionProjection({ ...LEGACY, pensions: [member] });
  assert.match(projection.assumptionsTable.rows.flat().join(' '), /An estimate under the Total Contributions Approach/);

  const confirmed = structuredClone(profile);
  confirmed.assumptions.values.retirement.statePensionFraction = { primary: 0.5 };
  const kept = buildPensionProjectionInput(confirmed).pensions[0];
  assert.equal(kept.statePensionFraction, 0.5, 'a confirmed fraction wins');
  assert.equal(kept.statePensionBasis, undefined);

  const partial = structuredClone(profile);
  partial.assumptions.values.retirement.statePensionContributions.primary = { yearsPayingPrsi: 20 };
  const unknown = buildPensionProjectionInput(partial).pensions[0];
  assert.equal(unknown.statePensionFraction, 1, 'years caring not known: the full maximum, as before');
  assert.match(unknown.statePensionBasis, /^The full maximum is assumed, not estimated\./);

  const excluded = structuredClone(profile);
  excluded.assumptions.values.retirement.includeStatePension = false;
  assert.equal(buildPensionProjectionInput(excluded).pensions[0].statePensionFraction, 0);
});

check('contribution years stop the missing-facts list asking for a fraction they already give', () => {
  const profile = structuredClone(retirementProfile());
  const asks = (candidate) => planFactsMissing(candidate).some((fact) => fact.factId === 'state_pension_fraction');
  assert.equal(asks(profile), true, 'asked when nothing is known');
  profile.assumptions.values.retirement = {
    ...(profile.assumptions.values.retirement || {}),
    statePensionContributions: { primary: { yearsPayingPrsi: 20 } }
  };
  assert.equal(asks(profile), true, 'still asked while the years caring are not known');
  profile.assumptions.values.retirement.statePensionContributions.primary.yearsCaring = 0;
  assert.equal(asks(profile), false, 'not asked once both are known');
});

const fixture = JSON.parse(readFileSync(new URL('./fixtures/plan-packs/valid-b1.json', import.meta.url), 'utf8'));

async function planAssumptions(mutate) {
  const pack = structuredClone(fixture);
  pack.routes = [{ id: 'current' }];
  pack.narration = {};
  mutate(pack);
  const result = await compilePlanPack(pack);
  assert.equal(result.status, 'compiled', JSON.stringify(result.diagnostics));
  const chapter = result.chapters.find((entry) => entry.id === 'pension_projection');
  return chapter.cases[0];
}

try {
  const plain = await planAssumptions(() => {});
  assert.ok(plain.warnings.some((warning) => /illustration assumption, not a confirmed entitlement/.test(warning)), 'with no facts the existing warning stays');
  const estimated = await planAssumptions((pack) => {
    pack.household.assumptions.values.retirement = {
      ...(pack.household.assumptions.values.retirement || {}),
      statePensionContributions: Object.fromEntries(['niamh', 'dara'].map((id) => [id, { yearsPayingPrsi: 15, yearsCaring: 0 }]))
    };
  });
  const used = estimated.assumptionsUsed.filter((entry) => entry.key.startsWith('statePensionFraction.'));
  assert.equal(used.length, 2, 'one assumption per person');
  used.forEach((entry) => {
    assert.match(entry.reason, /^An estimate under the Total Contributions Approach, from 15 years paying PRSI so far/);
    assert.ok(entry.value > 0 && entry.value < 1, `${entry.key} is an estimated fraction, not the default`);
  });
  assert.ok(estimated.warnings.some((warning) => /is an estimate from years of contributions, not a confirmed entitlement/.test(warning)));
  assert.ok(!estimated.warnings.some((warning) => /illustration assumption/.test(warning)), 'and the default warning is gone');
  originalInfo('[StatePensionEstimate] PASS: the plan pack records the estimate and its basis, and keeps the default warning when nothing is known');
} catch (error) {
  failures += 1;
  console.error(`[StatePensionEstimate] FAIL: the plan pack records the estimate and its basis\n    ${error.stack}`);
}

if (failures > 0) {
  console.error(`[StatePensionEstimate] ${failures} check(s) failed.`);
  process.exit(1);
}
originalInfo('[StatePensionEstimate] the State Pension estimate and the one-payment rule hold, and the engine, adapter and plan pack use them.');
