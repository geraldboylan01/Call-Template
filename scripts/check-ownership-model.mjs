#!/usr/bin/env node

/**
 * PHASE 5 — WHO OWNS WHAT, AND WHAT THAT MEANS FOR A CALCULATION.
 *
 * THE DEFECT THIS PINS. `ownerId: 'household'` was legal on every collection,
 * and the live lane deliberately wrote it for income it could not attribute to
 * one person. It was introduced for a real reason -- refusing joint rent lost
 * 2,250 a month on a live call -- but it solved that by inventing a third
 * person who owns things, and a household is not a person:
 *
 *   - a household-owned income counted in `netHouseholdIncome` while
 *     contributing NOTHING to either applicant's employment income, so a
 *     couple could show full household income and zero mortgage capacity;
 *   - "we earn 150,000 between us" could become a position that looked like
 *     somebody's salary without either person having stated one;
 *   - the schema admitted the same pseudo-owner on pensions, where it has no
 *     meaning at all.
 *
 * THE MODEL NOW. Ownership follows what the thing IS.
 *
 *   - A salary, a trade, a pension in payment, a State Pension entitlement and
 *     a pension position each belong to ONE named person. There is no joint
 *     salary, and a combined figure is not evidence of either person's.
 *   - Rent from a jointly owned property genuinely belongs to both. It is
 *     recorded ONCE naming both people -- the established `ownerIds` shape --
 *     never duplicated per person and never hidden behind a pseudo-owner.
 *   - A combined household figure is kept as a household aggregate, which is
 *     not a position and can never answer "what does each of you earn?".
 */

import assert from 'node:assert/strict';

import {
  JOINT_CAPABLE_INCOME_TYPES,
  SINGLE_OWNER_INCOME_TYPES,
  createHouseholdProfile,
  isJointCapableIncomeType,
  normalizeHouseholdProfile
} from '../js/planning/profile.js';
import {
  grossEmploymentIncome,
  householdAggregateNetIncome,
  netHouseholdIncome
} from '../js/planning/adapters/common.js';
import {
  buildHousePurchaseInput,
  getHousePurchaseReadiness
} from '../js/planning/adapters/house_purchase.js';

const pass = (message) => console.info(`[Ownership] PASS: ${message}`);

const NOW = '2026-08-18T09:00:00.000Z';
const TODAY = '2026-08-18';
const EUR = (amount) => ({ amount, currency: 'EUR' });

function household({ incomeSources = [], pensions = [], householdIncome = {}, partner = true, ...rest } = {}) {
  const base = createHouseholdProfile({ profileId: 'own', nowIso: NOW, calculationDateIso: TODAY });
  return normalizeHouseholdProfile({
    ...base,
    primaryPerson: {
      personId: 'primary', role: 'primary', employmentStatus: 'employee', age: 40, displayName: 'Aoife'
    },
    ...(partner
      ? {
        partner: {
          personId: 'partner', role: 'partner', employmentStatus: 'employee', age: 41, displayName: 'Cian'
        }
      }
      : {}),
    incomeSources,
    pensions,
    householdIncome,
    ...rest
  });
}

const refusalFrom = (build) => {
  try {
    build();
    return null;
  } catch (error) {
    return error.message;
  }
};

/* --------------------------------------------------- the type vocabulary */

{
  // Every income type is deliberately classified. An unclassified type would
  // fall through to whichever branch happened to be permissive.
  const all = [...SINGLE_OWNER_INCOME_TYPES, ...JOINT_CAPABLE_INCOME_TYPES];
  assert.deepEqual([...new Set(all)].sort(), all.sort(), 'no type is in both lists');
  assert.deepEqual(
    all.sort(),
    ['employment', 'other', 'pension', 'rental', 'self_employment', 'state_pension'],
    'every income type is classified exactly once'
  );
  for (const type of SINGLE_OWNER_INCOME_TYPES) {
    assert.equal(isJointCapableIncomeType(type), false, `${type} is single-owner`);
  }
  for (const type of JOINT_CAPABLE_INCOME_TYPES) {
    assert.equal(isJointCapableIncomeType(type), true, `${type} is joint-capable`);
  }
  pass('every income type is classified as single-owner or joint-capable, exactly once');
}

/* -------------------------------------------------- individual attribution */

{
  const profile = household({
    incomeSources: [
      { incomeId: 'i-primary', ownerIds: ['primary'], type: 'employment', label: 'Salary', grossAnnual: EUR(62000) },
      { incomeId: 'i-partner', ownerIds: ['partner'], type: 'employment', label: 'Salary', grossAnnual: EUR(54000) }
    ]
  });
  assert.equal(grossEmploymentIncome(profile, 'primary'), 62000);
  assert.equal(grossEmploymentIncome(profile, 'partner'), 54000);
  pass('primary employment income is the primary’s only, and the partner’s is the partner’s only');
}

{
  // The legacy singular shape is a change of format, not of meaning, so it
  // still reads as exactly the same one owner.
  const profile = household({
    incomeSources: [
      { incomeId: 'i-1', ownerId: 'partner', type: 'employment', label: 'Salary', grossAnnual: EUR(54000) }
    ]
  });
  assert.deepEqual(profile.incomeSources[0].ownerIds, ['partner']);
  assert.equal(Object.hasOwn(profile.incomeSources[0], 'ownerId'), false, 'the singular field is not kept alongside');
  assert.equal(grossEmploymentIncome(profile, 'partner'), 54000);
  assert.equal(grossEmploymentIncome(profile, 'primary'), 0, 'and it is not the other person’s');
  pass('a legacy singular ownerId migrates to the same single owner without inventing a second');
}

/* ------------------------------------- "we earn 150k between us" fabricates */

{
  const messages = [
    refusalFrom(() => household({
      incomeSources: [
        { incomeId: 'i-1', ownerId: 'household', type: 'employment', label: 'Household income', grossAnnual: EUR(150000) }
      ]
    })),
    refusalFrom(() => household({
      incomeSources: [
        { incomeId: 'i-1', ownerIds: ['primary', 'partner'], type: 'employment', label: 'Joint salary', grossAnnual: EUR(150000) }
      ]
    }))
  ];
  assert.ok(messages[0], 'a household-owned salary is refused');
  assert.match(messages[0], /cannot be the household/);
  assert.ok(messages[1], 'a two-owner salary is refused');
  assert.match(messages[1], /exactly one person for employment/);
  pass('"we earn 150,000 between us" cannot become a salary, jointly owned or household owned');
}

{
  // And the aggregate does not quietly become two half-salaries either.
  const profile = household({ householdIncome: { grossAnnual: EUR(150000) } });
  assert.equal(profile.incomeSources.length, 0, 'an aggregate creates no position');
  assert.equal(grossEmploymentIncome(profile, 'primary'), 0);
  assert.equal(grossEmploymentIncome(profile, 'partner'), 0);
  pass('a household aggregate fabricates neither a salary nor a split');
}

/* --------------------------------------------- aggregate versus individual */

{
  // The module needs each applicant's gross salary. A combined figure does not
  // supply it, so the module stays unready and asks.
  const profile = household({
    householdIncome: { netMonthly: EUR(7000), grossAnnual: EUR(150000) },
    assets: [{ assetId: 'c1', ownerIds: ['household'], type: 'cash', label: 'Savings', currentValue: EUR(40000) }],
    expenses: { monthlyEssential: EUR(2400), currentMonthlyRent: EUR(1800) },
    goals: [{
      goalId: 'g1', type: 'buy_home', priority: 'high', status: 'active',
      title: 'Buy', targetAmount: EUR(420000), targetDate: '2028-06-01'
    }],
    assumptions: { calculationDateIso: TODAY, values: { housePurchase: { lendingCategory: 'first_time_buyer' } } }
  });
  const readiness = getHousePurchaseReadiness(profile);
  assert.equal(readiness.status, 'missing_information');
  assert.ok(
    readiness.requiredMissing.some((item) => item.fieldPath === '/incomeSources'),
    'it still asks for the individual incomes'
  );
  pass('an analysis needing individual salaries stays unready on a household aggregate alone');
}

{
  // The same module's affordability side asks only for combined take-home, and
  // a stated aggregate may answer that.
  const profile = household({
    incomeSources: [
      { incomeId: 'i-p', ownerIds: ['primary'], type: 'employment', label: 'Salary', grossAnnual: EUR(90000) },
      { incomeId: 'i-s', ownerIds: ['partner'], type: 'employment', label: 'Salary', grossAnnual: EUR(60000) }
    ],
    householdIncome: { netMonthly: EUR(7000) },
    assets: [{ assetId: 'c1', ownerIds: ['household'], type: 'cash', label: 'Savings', currentValue: EUR(40000) }],
    expenses: { monthlyEssential: EUR(2400), currentMonthlyRent: EUR(1800) },
    goals: [{
      goalId: 'g1', type: 'buy_home', priority: 'high', status: 'active',
      title: 'Buy', targetAmount: EUR(420000), targetDate: '2028-06-01'
    }],
    assumptions: { calculationDateIso: TODAY, values: { housePurchase: { lendingCategory: 'first_time_buyer' } } }
  });
  assert.equal(householdAggregateNetIncome(profile), 84000, '7,000 a month is 84,000 a year');
  assert.equal(netHouseholdIncome(profile), 84000, 'the aggregate answers the household question');
  const readiness = getHousePurchaseReadiness(profile);
  assert.equal(readiness.status, 'ready_with_assumptions');
  assert.ok(
    readiness.assumptionsUsed.some((item) => item.key === 'monthlyNetHouseholdIncome'),
    'and using it is declared rather than silent'
  );
  const input = buildHousePurchaseInput(profile);
  assert.equal(input.monthlyNetHouseholdIncome, 7000);
  // The applicant figures remain the ones each person actually stated.
  const applicant = (id) => input.applicants.find((entry) => entry.id === id);
  assert.equal(applicant('primary').grossAnnualIncome, 90000);
  assert.equal(applicant('partner').grossAnnualIncome, 60000);
  pass('a module needing only combined household net income may use the stated aggregate');
}

{
  // Per-source net figures are more specific, so they win; the aggregate is
  // only ever the fallback.
  const profile = household({
    incomeSources: [
      { incomeId: 'i-p', ownerIds: ['primary'], type: 'employment', label: 'Salary', netAnnual: EUR(43000) },
      { incomeId: 'i-s', ownerIds: ['partner'], type: 'employment', label: 'Salary', netAnnual: EUR(38000) }
    ],
    householdIncome: { netAnnual: EUR(999999) }
  });
  assert.equal(netHouseholdIncome(profile), 81000, 'stated positions outrank the aggregate');
  pass('per-source net income outranks a household aggregate when both exist');
}

/* ------------------------------------------------- genuinely joint income */

{
  const profile = household({
    incomeSources: [
      { incomeId: 'i-rent', ownerIds: ['primary', 'partner'], type: 'rental', label: 'Rent', netAnnual: EUR(27000) }
    ]
  });
  assert.equal(profile.incomeSources.length, 1, 'joint rent is ONE position, not one per owner');
  assert.deepEqual([...profile.incomeSources[0].ownerIds].sort(), ['partner', 'primary']);
  assert.equal(netHouseholdIncome(profile), 27000, 'and it counts once, not 54,000');
  assert.equal(grossEmploymentIncome(profile, 'primary'), 0, 'rent is not employment income');
  assert.equal(grossEmploymentIncome(profile, 'partner'), 0);
  pass('jointly owned rental income is held once, attributed to both, and never doubled');
}

{
  const profile = household({
    incomeSources: [
      { incomeId: 'i-rent', ownerIds: ['primary', 'partner'], type: 'rental', label: 'Rent', netAnnual: EUR(27000) },
      { incomeId: 'i-p', ownerIds: ['primary'], type: 'employment', label: 'Salary', netAnnual: EUR(43000) }
    ]
  });
  assert.equal(netHouseholdIncome(profile), 70000, '27,000 joint rent plus 43,000 salary, each once');
  pass('joint and individual income combine without double counting');
}

{
  const message = refusalFrom(() => household({
    incomeSources: [
      { incomeId: 'i-rent', ownerIds: ['household'], type: 'rental', label: 'Rent', netAnnual: EUR(27000) }
    ]
  }));
  assert.ok(message, 'the pseudo-owner is refused even where joint is legitimate');
  assert.match(message, /cannot be the household/);
  assert.match(message, /householdIncome/, 'and the message says where a combined figure belongs');
  pass('joint income names real people rather than a household pseudo-owner');
}

/* ------------------------------------------------------------- pensions */

{
  const message = refusalFrom(() => household({
    pensions: [{ pensionId: 'p1', ownerId: 'household', type: 'occupational', currentValue: EUR(150000) }]
  }));
  assert.ok(message, 'a household-owned pension is refused');
  assert.match(message, /cannot be jointly owned/);
  pass('a pension cannot be household owned');
}

{
  const profile = household({
    pensions: [
      { pensionId: 'p1', ownerId: 'primary', type: 'occupational', currentValue: EUR(150000) },
      { pensionId: 'p2', ownerId: 'partner', type: 'prsa', currentValue: EUR(80000) }
    ]
  });
  const byId = (id) => profile.pensions.find((pension) => pension.pensionId === id);
  assert.equal(byId('p1').ownerId, 'primary');
  assert.equal(byId('p2').ownerId, 'partner', 'the partner’s pension stays the partner’s');
  assert.equal(
    profile.pensions.filter((pension) => pension.ownerId === 'partner').length,
    1,
    'combining household retirement resources downstream does not reassign the position'
  );
  pass('partner pensions remain partner-owned even though projection combines them later');
}

{
  // Invalid ownership must fail at the boundary, loudly. The alternative is
  // exactly what this work removed: a record that is accepted, then invisible.
  const message = refusalFrom(() => household({
    pensions: [{ pensionId: 'p1', ownerId: 'nobody', type: 'occupational', currentValue: EUR(10000) }]
  }));
  assert.ok(message, 'an unknown owner is refused');
  assert.match(message, /unknown household person id/);
  const incomeMessage = refusalFrom(() => household({
    incomeSources: [{ incomeId: 'i1', ownerIds: [], type: 'employment', label: 'Salary', grossAnnual: EUR(1000) }]
  }));
  assert.match(incomeMessage, /must name at least one household person/);
  pass('invalid ownership fails clearly at the boundary, not as latent unusable state');
}

/* ------------------------------------- house purchase must not regress */

{
  // The aggregate must not reach applicant-level affordability. This is the
  // specific regression the ownership work risked introducing.
  const profile = household({
    incomeSources: [
      { incomeId: 'i-p', ownerIds: ['primary'], type: 'employment', label: 'Salary', grossAnnual: EUR(62000) },
      { incomeId: 'i-s', ownerIds: ['partner'], type: 'employment', label: 'Salary', grossAnnual: EUR(54000) },
      { incomeId: 'i-rent', ownerIds: ['primary', 'partner'], type: 'rental', label: 'Rent', netAnnual: EUR(12000) }
    ],
    householdIncome: { netMonthly: EUR(9000) },
    assets: [{ assetId: 'c1', ownerIds: ['household'], type: 'cash', label: 'Savings', currentValue: EUR(40000) }],
    expenses: { monthlyEssential: EUR(2400), currentMonthlyRent: EUR(1800) },
    goals: [{
      goalId: 'g1', type: 'buy_home', priority: 'high', status: 'active',
      title: 'Buy', targetAmount: EUR(420000), targetDate: '2028-06-01'
    }],
    assumptions: { calculationDateIso: TODAY, values: { housePurchase: { lendingCategory: 'first_time_buyer' } } }
  });
  const input = buildHousePurchaseInput(profile);
  const applicant = (id) => input.applicants.find((entry) => entry.id === id);
  assert.equal(applicant('primary').grossAnnualIncome, 62000, 'applicant income is what that person earns');
  assert.equal(applicant('partner').grossAnnualIncome, 54000);
  assert.notEqual(applicant('primary').grossAnnualIncome, 116000, 'never the household total');
  // Rent carries a net figure, so the positions answer the household question
  // and the aggregate stays out of it -- counted once, not once per owner.
  assert.equal(input.monthlyNetHouseholdIncome, 1000, '12,000 of joint rent, once, over twelve months');
  pass('house purchase keeps applicant income individual and counts joint income once');
}

console.info('[Ownership] All income and pension ownership checks passed.');
