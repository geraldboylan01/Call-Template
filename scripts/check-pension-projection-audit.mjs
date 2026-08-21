#!/usr/bin/env node

/**
 * PHASE 5 MODULE #6 — PENSION PROJECTION, PROVED ARITHMETICALLY.
 *
 * The largest assumption surface in the phase, and the module where the
 * product-type rules matter most: what belongs in a pot, what is income
 * instead, and who owns each of them.
 *
 * THE REFERENCE CALCULATOR BELOW IS DELIBERATELY SEPARATE from the engine. It
 * accumulates a pot year by year from first principles and imports nothing
 * from `pension_math.js` except the versioned rule constants it is checking
 * were applied. Timing is established by hand FIRST — €100,000 at 5% with no
 * contributions must go 100,000 → 105,000 → 110,250 — so that every later case
 * rests on a convention that was measured rather than assumed.
 *
 * WHAT THE TIMING TURNED OUT TO BE, measured rather than read off the code:
 *
 *   - growth periods = retirementAge − currentAge;
 *   - a contribution is made in every year where age < retirementAge, so the
 *     retirement year itself receives none;
 *   - contributions are added BEFORE that year's growth, so the first
 *     contribution does earn growth in its first year;
 *   - salary escalates from year one, so the first contribution is a
 *     percentage of today's salary, not of next year's.
 *
 * TWO THINGS THIS AUDIT DELIBERATELY DOES NOT CALL DEFECTS, having tested
 * them rather than assumed:
 *
 *   - With staggered retirement the combined pot at the later reference year
 *     is SMALLER than the sum of each pot at its own retirement. That is the
 *     earlier retiree funding the household through the bridge years, not a
 *     lost pension: set the target income to zero and both pots survive.
 *   - A retired pot still shrinks slightly against pure growth. That is the
 *     ARF minimum drawdown, which is the documented post-retirement treatment.
 */

import assert from 'node:assert/strict';

import { computePensionProjection } from '../js/pension_math.js';
import { createHouseholdProfile, normalizeHouseholdProfile, ownerConfirmedNonePath } from '../js/planning/profile.js';
import {
  buildPensionProjectionInput,
  getPensionProjectionReadiness,
  validatePensionProjectionInput
} from '../js/planning/adapters/retirement.js';
import { PLANEIR_ASSUMPTIONS } from '../js/planning/planeir_assumptions.js';
import {
  IRISH_ARF_MINIMUM_DRAWDOWN,
  IRISH_STATE_PENSION_CONTRIBUTORY,
  irishArfMinimumRate
} from '../js/planning/ireland_rules.js';
import { runPlanningModule } from '../js/planning/module_registry.js';
import { MODULE_FAILURE_CODES, classifyModuleFailure } from '../js/planning/module_failures.js';

const pass = (message) => console.info(`[PensionAudit] PASS: ${message}`);

const NOW = '2026-08-18T09:00:00.000Z';
const TODAY = '2026-08-18';
const EUR = (amount) => ({ amount, currency: 'EUR' });

/* ------------------------------------------------ independent arithmetic */

/**
 * A pot accumulated from first principles.
 *
 * One period per year until retirement. In each: this year's contribution goes
 * in, then the whole balance grows. Salary escalates from the year after the
 * first. Nothing here is imported from the engine.
 */
function referencePot({
  currentPot, currentSalary = 0, personalPct = 0, employerPct = 0,
  growthRate, wageGrowthRate = 0, years
}) {
  let balance = currentPot;
  for (let period = 0; period < years; period += 1) {
    const salary = currentSalary * Math.pow(1 + wageGrowthRate, period);
    balance = (balance + (salary * personalPct) + (salary * employerPct)) * (1 + growthRate);
  }
  return balance;
}

// Pension pots run to hundreds of thousands over decades, so a cent-level
// tolerance is the meaningful one: anything larger is a real disagreement, and
// exact float equality across forty compounding periods would be luck.
const CENT = 0.01;
const close = (actual, expected, tolerance, note) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${note}: expected ${expected}, got ${actual} (tolerance ${tolerance})`
);

const ENGINE_BASE = {
  currentYear: 2026,
  growthRate: 0.05,
  inflationRate: 0.02,
  wageGrowthRate: 0,
  targetIncomeToday: 40_000,
  horizonEndAge: 100
};

const engineMember = (over = {}) => ({
  id: 'primary', title: 'Pension', currentAge: 50, retirementAge: 51, currentSalary: 0,
  currentPot: 100_000, personalPct: 0, employerPct: 0, includeStatePension: false, ...over
});

const project = (over = {}, ...members) => computePensionProjection({
  ...ENGINE_BASE, ...over,
  pensions: members.length > 0 ? members : [engineMember()]
});
const projectedPot = (result) => result.debug.projectedPotCurrent;

/* ------------------------------------------------ 1. hand-checkable micro */

{
  // THE CONVENTION, ESTABLISHED BEFORE ANYTHING ELSE RESTS ON IT.
  const expected = [100_000, 105_000, 110_250, 115_762.5];
  for (let years = 0; years < expected.length; years += 1) {
    const result = project({}, engineMember({ retirementAge: 50 + years }));
    close(projectedPot(result), expected[years], CENT, `${years} growth periods`);
    close(
      projectedPot(result),
      referencePot({ currentPot: 100_000, growthRate: 0.05, years }),
      CENT,
      `${years} periods vs reference`
    );
  }
  pass('€100,000 at 5% with no contributions goes 100,000 → 105,000 → 110,250: one period per year to retirement');
}

{
  // Contributions land in every year where age is below the retirement age,
  // and the retirement year itself receives none.
  for (const years of [1, 2, 3]) {
    const result = project({ growthRate: 0 }, engineMember({
      retirementAge: 50 + years, currentPot: 0, currentSalary: 100_000, personalPct: 0.10
    }));
    close(projectedPot(result), years * 10_000, CENT, `${years} contributions of 10,000`);
  }
  pass('a contribution is made in each year before retirement, and none in the retirement year');
}

{
  // Contribution BEFORE growth, so the first contribution earns growth in its
  // own first year. The alternative ordering would give 10,000, not 10,500.
  const oneYear = project({}, engineMember({
    retirementAge: 51, currentPot: 0, currentSalary: 100_000, personalPct: 0.10
  }));
  close(projectedPot(oneYear), 10_500, CENT, 'contribution then growth');
  assert.notEqual(Math.round(projectedPot(oneYear)), 10_000, 'growth is not applied before the contribution');

  const twoYears = project({}, engineMember({
    retirementAge: 52, currentPot: 0, currentSalary: 100_000, personalPct: 0.10
  }));
  // 10,000 compounded twice plus 10,000 compounded once.
  close(projectedPot(twoYears), (10_000 * 1.05 * 1.05) + (10_000 * 1.05), CENT, 'two contributions');
  pass('contributions are added before that year’s growth, so the first one earns growth immediately');
}

{
  // Salary escalates from the second year, so the first contribution is a
  // percentage of today's pay. This is the first/last-year off-by-one risk.
  const result = project({ wageGrowthRate: 0.03, growthRate: 0 }, engineMember({
    retirementAge: 52, currentPot: 0, currentSalary: 100_000, personalPct: 0.10
  }));
  close(projectedPot(result), 10_000 + 10_300, CENT, 'first year uses today’s salary');
  assert.notEqual(Math.round(projectedPot(result)), 20_909, 'wage growth is not applied in the first year');
  close(
    projectedPot(result),
    referencePot({
      currentPot: 0, currentSalary: 100_000, personalPct: 0.10,
      growthRate: 0, wageGrowthRate: 0.03, years: 2
    }),
    CENT,
    'vs reference'
  );
  pass('the first contribution is a share of today’s salary, with wage growth from the second year');
}

{
  const result = project({ growthRate: 0 }, engineMember({
    retirementAge: 52, currentPot: 0, currentSalary: 100_000, personalPct: 0.05, employerPct: 0.07
  }));
  close(projectedPot(result), 24_000, CENT, 'two years of 5% plus 7% of 100,000');
  pass('employee and employer contributions are both included, once each');
}

/* --------------------------------------------- 2. reference-calculator cases */

{
  // Full accumulation with every lever engaged at once, over a realistic span.
  const shape = {
    currentPot: 185_000, currentSalary: 82_000, personalPct: 0.06, employerPct: 0.08,
    growthRate: PLANEIR_ASSUMPTIONS.investment.nominalGrowthRate, wageGrowthRate: 0.02, years: 15
  };
  const result = project({ growthRate: shape.growthRate, wageGrowthRate: shape.wageGrowthRate }, engineMember({
    currentAge: 50, retirementAge: 65, currentPot: shape.currentPot,
    currentSalary: shape.currentSalary, personalPct: shape.personalPct, employerPct: shape.employerPct
  }));
  close(projectedPot(result), referencePot(shape), CENT, 'fifteen-year accumulation vs reference');
  pass('a fifteen-year accumulation with pot, pay rises and both contributions matches the reference exactly');
}

{
  // Two people accumulate independently and their pots combine once.
  const primary = { currentPot: 100_000, growthRate: 0.05, years: 2 };
  const partner = { currentPot: 50_000, growthRate: 0.05, years: 2 };
  const result = project({},
    engineMember({ id: 'primary', currentAge: 50, retirementAge: 52, currentPot: 100_000 }),
    engineMember({ id: 'partner', title: 'Partner', currentAge: 50, retirementAge: 52, currentPot: 50_000 }));
  close(
    projectedPot(result),
    referencePot(primary) + referencePot(partner),
    CENT,
    'two members combine to the sum of their own accumulations'
  );
  close(projectedPot(result), 165_375, CENT, '150,000 grown twice');
  pass('two members accumulate separately and combine exactly once');
}

{
  // STAGGERED RETIREMENT IS DRAWDOWN, NOT A LOST PENSION. With no income to
  // fund, both pots survive to the later reference year; with a target, the
  // earlier retiree funds the bridge. Asserting both directions is what makes
  // the smaller combined figure explainable rather than suspicious.
  const staggered = (targetIncomeToday) => project({ targetIncomeToday },
    engineMember({ id: 'primary', currentAge: 50, retirementAge: 52, currentPot: 100_000 }),
    engineMember({ id: 'partner', title: 'Partner', currentAge: 60, retirementAge: 65, currentPot: 100_000 }));

  const undrawn = projectedPot(staggered(0));
  const drawn = projectedPot(staggered(40_000));
  assert.ok(undrawn > drawn, 'funding a target income depletes the pot that retired first');
  assert.ok(
    undrawn > referencePot({ currentPot: 100_000, growthRate: 0.05, years: 5 }),
    'and with nothing drawn, BOTH pots are still there at the reference year'
  );
  assert.ok(undrawn > 200_000, 'neither member has been dropped from the combined figure');
  pass('staggered retirement depletes the earlier pot through the bridge rather than losing it');
}

/* --------------------------------------------------- 3. product types */

const profileOf = (pensions, over = {}) => normalizeHouseholdProfile({
  ...createHouseholdProfile({ profileId: 'pen', nowIso: NOW, calculationDateIso: TODAY }),
  primaryPerson: {
    personId: 'primary', role: 'primary', employmentStatus: 'employee',
    age: 50, intendedRetirementAge: 65, displayName: 'Aoife'
  },
  incomeSources: [{
    incomeId: 'i1', ownerIds: ['primary'], type: 'employment', label: 'Salary', grossAnnual: EUR(80_000)
  }],
  pensions,
  expenses: { monthlyEssential: EUR(3_000), annualTotal: EUR(40_000) },
  goals: [{ goalId: 'g1', type: 'retire', priority: 'high', status: 'active', title: 'Retire' }],
  assumptions: { calculationDateIso: TODAY, values: {} },
  ...over
});

const dc = (pensionId, ownerId, value, employee = 0.05, employer = 0.07) => ({
  pensionId, ownerId, type: 'occupational', label: `DC ${pensionId}`, currentValue: EUR(value),
  contributionStatus: 'active', employeeContributionRate: employee, employerContributionRate: employer
});

const memberFor = (input, ownerId) => {
  const found = input.pensions.filter((member) => member.id === ownerId);
  assert.equal(found.length, 1, `exactly one projection member for ${ownerId}`);
  return found[0];
};

{
  const input = buildPensionProjectionInput(profileOf([dc('p1', 'primary', 200_000)]));
  const member = memberFor(input, 'primary');
  assert.equal(member.currentPot, 200_000, 'the opening pot is included once');
  assert.equal(member.personalPct, 0.05);
  assert.equal(member.employerPct, 0.07);
  assert.equal(member.currentSalary, 80_000, 'contributions are a share of this person’s own pay');

  const two = buildPensionProjectionInput(profileOf([dc('p1', 'primary', 200_000), dc('p2', 'primary', 50_000, 0.03, 0.04)]));
  assert.equal(memberFor(two, 'primary').currentPot, 250_000, 'two pots aggregate without duplication');
  close(memberFor(two, 'primary').personalPct, 0.08, 1e-9, 'and their contribution rates add');
  close(memberFor(two, 'primary').employerPct, 0.11, 1e-9);
  pass('defined-contribution pots and contributions aggregate once per person');
}

{
  // A PRB CANNOT RECEIVE CONTRIBUTIONS, even when the record carries rates.
  // The value still grows: it is a real pot, just a closed one.
  const input = buildPensionProjectionInput(profileOf([{
    pensionId: 'prb', ownerId: 'primary', type: 'buyout_bond', label: 'PRB',
    currentValue: EUR(150_000), employeeContributionRate: 0.10, employerContributionRate: 0.10
  }]));
  const member = memberFor(input, 'primary');
  assert.equal(member.currentPot, 150_000, 'the bond’s value is projected');
  assert.equal(member.personalPct, 0, 'no employee contribution reaches the engine');
  assert.equal(member.employerPct, 0, 'and no employer contribution either');

  // Alongside a live DC, the PRB adds value but no contributions.
  const mixed = buildPensionProjectionInput(profileOf([
    dc('p1', 'primary', 200_000),
    { pensionId: 'prb', ownerId: 'primary', type: 'buyout_bond', label: 'PRB', currentValue: EUR(150_000) }
  ]));
  assert.equal(memberFor(mixed, 'primary').currentPot, 350_000);
  assert.equal(memberFor(mixed, 'primary').personalPct, 0.05, 'only the DC contributes');
  assert.equal(memberFor(mixed, 'primary').employerPct, 0.07);
  pass('a PRB grows but can never receive a contribution, even carrying contribution rates');
}

{
  // A paid-up DC is the same shape of rule: the money is real, the
  // contributions have stopped.
  const input = buildPensionProjectionInput(profileOf([{
    pensionId: 'old', ownerId: 'primary', type: 'occupational', label: 'Old scheme',
    currentValue: EUR(90_000), contributionStatus: 'paid_up',
    employeeContributionRate: 0.05, employerContributionRate: 0.05
  }]));
  assert.equal(memberFor(input, 'primary').currentPot, 90_000);
  assert.equal(memberFor(input, 'primary').personalPct, 0, 'a paid-up scheme receives nothing further');
  pass('a paid-up scheme keeps its value and receives no further contributions');
}

{
  // A DEFINED-BENEFIT PENSION IS INCOME, NOT A POT — even when the record
  // carries a value, which is the case that would silently inflate a pot.
  const input = buildPensionProjectionInput(profileOf([
    dc('p1', 'primary', 200_000),
    {
      pensionId: 'db', ownerId: 'primary', type: 'defined_benefit', label: 'DB scheme',
      currentValue: EUR(999_999), projectedAnnualIncome: EUR(18_000), benefitStartAge: 65
    }
  ]));
  assert.equal(memberFor(input, 'primary').currentPot, 200_000, 'the DB value never enters the pot');
  assert.equal(memberFor(input, 'primary').personalPct, 0.05, 'nor does it contribute');

  const dbIncome = input.otherIncomeSources.filter((source) => source.id === 'defined-benefit-db');
  assert.equal(dbIncome.length, 1, 'it appears exactly once, as income');
  assert.equal(dbIncome[0].annualAmountToday, 18_000);
  assert.equal(dbIncome[0].startAge, 65, 'starting when the benefit does');
  assert.equal(dbIncome[0].ownerId, 'primary', 'and staying with the person whose scheme it is');
  pass('a defined-benefit pension is income once, never a pot, even carrying a value');
}

{
  // A DB with no stated income cannot become a silent zero-income entry.
  const input = buildPensionProjectionInput(profileOf([
    dc('p1', 'primary', 200_000),
    { pensionId: 'db', ownerId: 'primary', type: 'defined_benefit', label: 'DB', benefitStartAge: 65 }
  ]));
  assert.equal(memberFor(input, 'primary').currentPot, 200_000);
  assert.equal(
    input.otherIncomeSources.filter((source) => source.id.startsWith('defined-benefit')).length,
    0,
    'a DB with no stated income adds nothing rather than adding zero'
  );
  pass('a defined-benefit scheme with no stated income contributes neither pot nor income');
}

/* ------------------------------------------------------ 4. State Pension */

{
  // Sourced from the versioned rules catalogue, not retyped here.
  const spProfile = profileOf([dc('p1', 'primary', 200_000)]);
  const member = memberFor(buildPensionProjectionInput(spProfile), 'primary');
  assert.equal(member.includeStatePension, true);
  assert.equal(member.statePensionFraction, 1);
  assert.equal(
    member.statePensionStartAge,
    IRISH_STATE_PENSION_CONTRIBUTORY.defaultStartAge,
    'the start age comes from the rules catalogue'
  );
  assert.equal(
    member.statePensionEscalationRate,
    IRISH_STATE_PENSION_CONTRIBUTORY.defaultEscalationRate,
    'and so does the escalation rate'
  );

  // It is INCOME. Turning it on must not change the projected pot by a cent.
  const withSp = project({}, engineMember({ retirementAge: 51, includeStatePension: true, statePensionFraction: 1 }));
  const withoutSp = project({}, engineMember({ retirementAge: 51, includeStatePension: false }));
  assert.equal(
    projectedPot(withSp),
    projectedPot(withoutSp),
    'the State Pension is never added to a funded pot'
  );
  pass('State Pension timing and escalation come from the versioned rules, and it never enters the pot');
}

{
  // One entitlement each, and each person's can be switched off on its own.
  const couple = profileOf([dc('p1', 'primary', 200_000), dc('p2', 'partner', 150_000)], {
    partner: {
      personId: 'partner', role: 'partner', employmentStatus: 'employee',
      age: 48, intendedRetirementAge: 67, displayName: 'Cian'
    },
    incomeSources: [
      { incomeId: 'i1', ownerIds: ['primary'], type: 'employment', label: 'Salary', grossAnnual: EUR(80_000) },
      { incomeId: 'i2', ownerIds: ['partner'], type: 'employment', label: 'Salary', grossAnnual: EUR(60_000) }
    ]
  });
  const input = buildPensionProjectionInput(couple);
  assert.equal(input.pensions.length, 2, 'one member per person');
  assert.equal(
    input.pensions.filter((member) => member.includeStatePension).length,
    2,
    'one State Pension entitlement each, not one per household and not doubled'
  );

  const partnerOff = buildPensionProjectionInput(normalizeHouseholdProfile({
    ...couple,
    assumptions: {
      calculationDateIso: TODAY,
      values: { retirement: { includeStatePension: { partner: false } } }
    }
  }));
  assert.equal(memberFor(partnerOff, 'primary').includeStatePension, true);
  assert.equal(memberFor(partnerOff, 'partner').includeStatePension, false, 'and it is switchable per person');
  assert.equal(memberFor(partnerOff, 'partner').statePensionFraction, 0);
  pass('State Pension is counted once per eligible person and stays individually controlled');
}

/* -------------------------------------------------- 5. household ownership */

{
  const couple = (pensions) => profileOf(pensions, {
    partner: {
      personId: 'partner', role: 'partner', employmentStatus: 'employee',
      age: 48, intendedRetirementAge: 67, displayName: 'Cian'
    },
    incomeSources: [
      { incomeId: 'i1', ownerIds: ['primary'], type: 'employment', label: 'Salary', grossAnnual: EUR(80_000) },
      { incomeId: 'i2', ownerIds: ['partner'], type: 'employment', label: 'Salary', grossAnnual: EUR(60_000) }
    ]
  });

  // Different ages and retirement ages stay attached to their own person.
  const both = buildPensionProjectionInput(couple([dc('p1', 'primary', 200_000), dc('p2', 'partner', 150_000)]));
  assert.equal(memberFor(both, 'primary').currentAge, 50);
  assert.equal(memberFor(both, 'primary').retirementAge, 65);
  assert.equal(memberFor(both, 'partner').currentAge, 48);
  assert.equal(memberFor(both, 'partner').retirementAge, 67, 'each person retires on their own timetable');
  assert.equal(memberFor(both, 'primary').currentPot, 200_000);
  assert.equal(memberFor(both, 'partner').currentPot, 150_000, 'and keeps their own pot');
  assert.equal(memberFor(both, 'primary').currentSalary, 80_000);
  assert.equal(memberFor(both, 'partner').currentSalary, 60_000, 'against their own salary');

  // Several pensions for one person aggregate to that person only.
  const lopsided = buildPensionProjectionInput(couple([
    dc('p1', 'primary', 200_000), dc('p1b', 'primary', 60_000, 0, 0), dc('p2', 'partner', 150_000)
  ]));
  assert.equal(memberFor(lopsided, 'primary').currentPot, 260_000);
  assert.equal(memberFor(lopsided, 'partner').currentPot, 150_000, 'nothing leaks across owners');

  // A full mixture: DC + PRB + DB for one, PRSA for the other.
  const mixture = buildPensionProjectionInput(couple([
    dc('p1', 'primary', 200_000),
    { pensionId: 'prb', ownerId: 'primary', type: 'buyout_bond', label: 'PRB', currentValue: EUR(80_000) },
    {
      pensionId: 'db', ownerId: 'primary', type: 'defined_benefit', label: 'DB',
      projectedAnnualIncome: EUR(12_000), benefitStartAge: 65
    },
    {
      pensionId: 'prsa', ownerId: 'partner', type: 'prsa', label: 'PRSA', currentValue: EUR(90_000),
      contributionStatus: 'active', employeeContributionRate: 0.06, employerContributionRate: 0
    }
  ]));
  assert.equal(memberFor(mixture, 'primary').currentPot, 280_000, '200,000 DC plus 80,000 PRB, no DB');
  assert.equal(memberFor(mixture, 'primary').personalPct, 0.05, 'only the DC contributes');
  assert.equal(memberFor(mixture, 'partner').currentPot, 90_000);
  assert.equal(memberFor(mixture, 'partner').personalPct, 0.06);
  const dbIncome = mixture.otherIncomeSources.filter((source) => source.id.startsWith('defined-benefit'));
  assert.equal(dbIncome.length, 1);
  assert.equal(dbIncome[0].ownerId, 'primary', 'the DB stays the primary’s');
  pass('every pension stays individually owned while the household resources combine');
}

{
  // A partner with nothing recorded is asked about, not assumed to have zero.
  const couple = profileOf([dc('p1', 'primary', 200_000)], {
    partner: {
      personId: 'partner', role: 'partner', employmentStatus: 'employee',
      age: 48, intendedRetirementAge: 67, displayName: 'Cian'
    }
  });
  const readiness = getPensionProjectionReadiness(couple);
  assert.equal(readiness.status, 'missing_information');
  assert.ok(
    readiness.requiredMissing.some((item) => item.ownerId === 'partner'),
    'the partner’s pensions are asked for by owner'
  );

  // Once confirmed to have none, the projection runs on one member.
  const confirmed = normalizeHouseholdProfile({
    ...couple,
    assumptions: {
      calculationDateIso: TODAY,
      values: {
        completionFacts: {
          confirmedNonePaths: { [ownerConfirmedNonePath('/pensions', 'partner')]: true }
        }
      }
    }
  });
  const input = buildPensionProjectionInput(confirmed);
  assert.equal(input.pensions.length, 1, 'only the person who has a pension is projected');
  assert.equal(input.pensions[0].id, 'primary');
  pass('a partner with no pension is asked about rather than silently treated as zero');
}

/* --------------------------------------------------- 6. assumption sources */

{
  const input = buildPensionProjectionInput(profileOf([dc('p1', 'primary', 200_000)]));
  assert.equal(
    input.growthRate,
    PLANEIR_ASSUMPTIONS.investment.nominalGrowthRate,
    'growth comes from the central approved assumptions'
  );
  assert.equal(
    input.inflationRate,
    PLANEIR_ASSUMPTIONS.inflation.generalRate,
    'and so does inflation'
  );
  // Applied once: the adapter passes the household rate and the engine does not
  // re-apply a per-member default on top of it.
  assert.ok(
    input.pensions.every((member) => typeof member.growthRate === 'undefined'),
    'the adapter does not also stamp a per-member growth rate that could drift'
  );
  const result = project({ growthRate: PLANEIR_ASSUMPTIONS.investment.nominalGrowthRate },
    engineMember({ retirementAge: 51 }));
  close(
    projectedPot(result),
    100_000 * (1 + PLANEIR_ASSUMPTIONS.investment.nominalGrowthRate),
    CENT,
    'one growth period at the approved rate, applied exactly once'
  );
  pass('growth and inflation come from the versioned assumptions and are applied exactly once');
}

{
  // THE ARF RULES NOW LIVE IN THE RULES CATALOGUE, not as constants inside the
  // engine. The move changed no value: the rates and the threshold are exactly
  // what the engine applied before, and the projection below is pinned to a
  // figure computed when they were still hardcoded.
  assert.equal(IRISH_ARF_MINIMUM_DRAWDOWN.baseRate, 0.04);
  assert.equal(IRISH_ARF_MINIMUM_DRAWDOWN.higherRate, 0.05);
  assert.equal(IRISH_ARF_MINIMUM_DRAWDOWN.higherRateFromAge, 70);
  assert.equal(IRISH_ARF_MINIMUM_DRAWDOWN.highValueRate, 0.06);
  assert.equal(IRISH_ARF_MINIMUM_DRAWDOWN.highValueThresholdEur, 2_000_000);

  // The bands, including that a high-value fund outranks the age band.
  assert.equal(irishArfMinimumRate(65, 500_000), 0.04, 'under 70, ordinary fund');
  assert.equal(irishArfMinimumRate(70, 500_000), 0.05, 'from 70, ordinary fund');
  assert.equal(irishArfMinimumRate(65, 2_500_000), 0.06, 'a high-value fund at any age');
  assert.equal(irishArfMinimumRate(75, 2_500_000), 0.06);
  assert.equal(irishArfMinimumRate(65, 2_000_000), 0.04, 'the threshold is exclusive');

  // And the projection is unchanged. This figure was recorded from a run made
  // while the rates were still hardcoded in pension_math.js.
  const staggered = computePensionProjection({
    ...ENGINE_BASE, targetIncomeToday: 0,
    pensions: [
      engineMember({ id: 'primary', currentAge: 50, retirementAge: 52, currentPot: 100_000 }),
      engineMember({ id: 'partner', title: 'Partner', currentAge: 60, retirementAge: 65, currentPot: 100_000 })
    ]
  });
  close(
    staggered.debug.projectedPotCurrent,
    240_545.38,
    CENT,
    'the drawdown result is identical to the pre-move run'
  );
  pass('the ARF drawdown rules moved to the versioned catalogue without changing a single output');
}

/* ---------------------------------------------------- 7. the input contract */

{
  const valid = buildPensionProjectionInput(profileOf([dc('p1', 'primary', 200_000)]));
  assert.doesNotThrow(() => validatePensionProjectionInput(valid));

  const broken = (patch) => ({ ...valid, pensions: [{ ...valid.pensions[0], ...patch }] });
  const refusals = [
    [broken({ currentPot: -1 }), /must not be negative/, 'a negative pot'],
    [broken({ currentPot: Number.NaN }), /finite number/, 'a non-finite pot'],
    [broken({ currentPot: undefined }), /finite number/, 'a missing pot value'],
    [broken({ personalPct: 5 }), /fraction of salary, not a percentage/, 'a rate given as a percentage'],
    [broken({ employerPct: -0.01 }), /must not be negative/, 'a negative contribution rate'],
    [broken({ currentAge: 250 }), /age between 0 and 120/, 'an impossible age'],
    [broken({ currentAge: 60, retirementAge: 55 }), /must not be before currentAge/, 'retiring before today'],
    [{ ...valid, growthRate: -1.5 }, /greater than -1/, 'a growth rate below -100%'],
    [{ ...valid, pensions: [] }, /at least one household member/, 'no members at all'],
    [
      { ...valid, pensions: [valid.pensions[0], { ...valid.pensions[0] }] },
      /each household member exactly once/,
      'the same member twice'
    ]
  ];
  for (const [input, pattern, note] of refusals) {
    assert.throws(() => validatePensionProjectionInput(input), pattern, `refused: ${note}`);
  }
  pass('the input contract refuses negative pots, percentage-shaped rates, impossible ages and duplicate members');
}

{
  // And the contract is reached through the real run path, not only directly.
  const profile = profileOf([dc('p1', 'primary', 200_000)]);
  let error = null;
  try {
    // Deliberately NOT normalised here: the module must reach its own verdict
    // on a profile it is handed, which is how it arrives in production.
    await runPlanningModule('pension_projection', {
      ...profile,
      primaryPerson: { ...profile.primaryPerson, intendedRetirementAge: 40 }
    }, { calculationVersion: 'test', calculatedAt: NOW });
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, 'a retirement age already behind them fails the run');
  assert.equal(
    classifyModuleFailure(error),
    MODULE_FAILURE_CODES.INPUT_INVALID,
    'and reports as an invalid input rather than an engine crash'
  );
  pass('an impossible retirement age reports module_input_invalid through the run path');
}

/* --------------------------------------------------------- 8. end to end */

{
  const profile = profileOf([dc('p1', 'primary', 200_000)]);
  assert.equal(getPensionProjectionReadiness(profile).status !== 'not_relevant', true);
  const result = await runPlanningModule('pension_projection', profile, {
    calculationVersion: 'test', calculatedAt: NOW, scenarioOverrides: {}
  });
  assert.equal(result.moduleId, 'pension_projection');

  // The whole path must reproduce the reference accumulation: fifteen years
  // from 50 to 65, 5% + 7% of 80,000 escalating at the module's wage rate.
  const input = buildPensionProjectionInput(profile);
  const expected = referencePot({
    currentPot: 200_000,
    currentSalary: 80_000,
    personalPct: 0.05,
    employerPct: 0.07,
    growthRate: input.growthRate,
    wageGrowthRate: input.wageGrowthRate,
    years: 15
  });
  close(
    result.semanticResult.projectedPotAtRetirement,
    expected,
    CENT,
    'the module reports the independently accumulated pot'
  );
  assert.equal(result.semanticResult.retirementYear, 2041, 'fifteen years from 2026');
  assert.ok(Number.isFinite(result.semanticResult.requiredPot), 'and states a required pot to compare it against');
  pass('pension projection runs end to end and reports the independently accumulated pot');
}

console.info('[PensionAudit] All pension projection audit checks passed.');
