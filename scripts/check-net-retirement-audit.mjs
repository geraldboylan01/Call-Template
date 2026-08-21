#!/usr/bin/env node

/**
 * PHASE 5 MODULE #7 — NET RETIREMENT CASH FLOW, PROVED ARITHMETICALLY.
 *
 * WHAT THIS MODULE IS FOR, taken from the playbook rather than inferred: it
 * compares the household's NET spending need with NET recurring income and
 * converts the annual shortfalls into the required NET investment fund today.
 * The playbook is explicit that it exists precisely "where pension taxation is
 * too uncertain for a true net-income pension projection", that "all income and
 * expenditure figures are treated as after-tax net amounts", and it names
 * using `generated.pensionInputs` here as an anti-pattern.
 *
 * SO THE GAP IS THE DESIGN. Pension pots and gross DB or State Pension income
 * do not flow in from `/pensions`, and must not: a €20,000 gross DB pension
 * silently becoming €20,000 of spendable income would understate the funding
 * requirement by exactly the tax nobody deducted, and the answer would still
 * look entirely reasonable. This file audits whether that boundary HOLDS,
 * rather than treating it as a defect.
 *
 * THE REFERENCE CALCULATOR BELOW IS DELIBERATELY SEPARATE from the engine. It
 * re-derives each year's spending, income and discounted shortfall from first
 * principles and imports nothing from `net_retirement_math.js`.
 */

import assert from 'node:assert/strict';

import { computeNetRetirementProjection } from '../js/net_retirement_math.js';
import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';
import {
  buildNetRetirementInput,
  getNetRetirementReadiness,
  validateNetRetirementInput
} from '../js/planning/adapters/retirement.js';
import { runPlanningModule } from '../js/planning/module_registry.js';
import { MODULE_FAILURE_CODES, classifyModuleFailure } from '../js/planning/module_failures.js';

const pass = (message) => console.info(`[NetRetirementAudit] PASS: ${message}`);

const NOW = '2026-08-18T09:00:00.000Z';
const TODAY = '2026-08-18';
const EUR = (amount) => ({ amount, currency: 'EUR' });

/* ------------------------------------------------ independent arithmetic */

/**
 * The required net fund, worked out from first principles.
 *
 * Year zero is today: undiscounted and un-inflated. Each later year inflates
 * the spending need and discounts the shortfall back. A year with more income
 * than spending contributes nothing — a surplus is not carried forward.
 */
function referenceRequiredFund({
  currentAge, horizonEndAge, annualExpenditureToday, expenditureInflationRate,
  presentValueRate, incomeSources = []
}) {
  let required = 0;
  const rows = [];
  for (let age = currentAge; age <= horizonEndAge; age += 1) {
    const offset = age - currentAge;
    const spending = annualExpenditureToday * Math.pow(1 + expenditureInflationRate, offset);
    const income = incomeSources.reduce((total, source) => {
      const started = age >= (source.startAge ?? currentAge);
      const ended = typeof source.endAge === 'number' && age > source.endAge;
      if (!started || ended) return total;
      const indexed = source.inflationIndexed
        ? source.annualAmountToday * Math.pow(1 + (source.inflationRate ?? expenditureInflationRate), offset)
        : source.annualAmountToday;
      return total + indexed;
    }, 0);
    const shortfall = Math.max(spending - income, 0);
    const discounted = shortfall / Math.pow(1 + presentValueRate, offset);
    rows.push({ age, spending, income, shortfall, discounted });
    required += discounted;
  }
  return { required, rows };
}

// Sums of up to forty discounted terms: a cent is the meaningful tolerance,
// and anything larger is a real disagreement rather than float representation.
const CENT = 0.01;
const close = (actual, expected, tolerance, note) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${note}: expected ${expected}, got ${actual} (tolerance ${tolerance})`
);

const ENGINE_BASE = {
  currentYear: 2026, currentAge: 60, horizonEndAge: 62,
  expenditureInflationRate: 0, presentValueRate: 0,
  annualExpenditureToday: 40_000, availableInvestmentFundToday: 0,
  incomeSources: [], scenarios: [{ id: 'base', title: 'Base' }]
};
const project = (over = {}, scenarioId = '') =>
  computeNetRetirementProjection({ ...ENGINE_BASE, ...over }, { scenarioId });
const scenarioOf = (result) => result.debug.scenario;

/* ------------------------------------------------------- hand-checkable */

{
  // One year, no income, no inflation, no discounting: the required fund is
  // simply the year's spending.
  const oneYear = project({ horizonEndAge: 60 });
  assert.equal(scenarioOf(oneYear).annualRows.length, 1, 'the current year is included');
  close(scenarioOf(oneYear).requiredFundToday, 40_000, CENT, 'one year of spending');

  const threeYears = project({});
  assert.equal(scenarioOf(threeYears).annualRows.length, 3, 'ages 60, 61 and 62 inclusive');
  close(scenarioOf(threeYears).requiredFundToday, 120_000, CENT, 'three years of spending');
  pass('hand-checkable: with no income, inflation or discounting the fund is just the spending');
}

{
  // Year zero is TODAY: neither inflated nor discounted. Year one carries one
  // period of each. This is the timing convention everything else rests on.
  const result = project({ horizonEndAge: 61, expenditureInflationRate: 0.02, presentValueRate: 0.04 });
  const rows = scenarioOf(result).annualRows;
  close(rows[0].netExpenditure, 40_000, CENT, 'today’s spending is today’s money');
  close(rows[0].presentValueShortfall, 40_000, CENT, 'and today’s shortfall is not discounted');
  close(rows[1].netExpenditure, 40_800, CENT, 'one year of inflation');
  close(rows[1].presentValueShortfall, 40_800 / 1.04, CENT, 'and one year of discounting');
  close(
    scenarioOf(result).requiredFundToday,
    40_000 + (40_800 / 1.04),
    CENT,
    'the required fund is the sum of the discounted shortfalls'
  );
  pass('year zero is today: un-inflated and undiscounted, with one period applied per year after');
}

{
  // A surplus year contributes nothing and does not offset a later shortfall.
  // That is a deliberate conservatism, and it is worth pinning as such.
  const result = project({
    horizonEndAge: 61,
    incomeSources: [{
      id: 'windfall', title: 'One-off net income', annualAmountToday: 100_000,
      startAge: 60, endAge: 60, inflationIndexed: false
    }]
  });
  const rows = scenarioOf(result).annualRows;
  assert.equal(rows[0].netShortfall, 0, 'a year with more income than spending has no shortfall');
  close(rows[0].surplus, 60_000, CENT, 'the surplus is reported');
  close(scenarioOf(result).requiredFundToday, 40_000, CENT, 'but it does not fund the following year');
  pass('a surplus year is reported and deliberately does not offset a later shortfall');
}

/* ------------------------------------------- reference-calculator cases */

{
  // Every lever at once, over a realistic retirement horizon.
  const shape = {
    currentAge: 60, horizonEndAge: 100,
    annualExpenditureToday: 90_000, expenditureInflationRate: 0.02, presentValueRate: 0.04,
    incomeSources: [
      { id: 'irish-rent', annualAmountToday: 10_000, startAge: 60, inflationIndexed: false },
      { id: 'eu-rent', annualAmountToday: 14_000, startAge: 60, inflationIndexed: true, inflationRate: 0.02 },
      { id: 'state-pension', annualAmountToday: 7_781.80, startAge: 66, inflationIndexed: false }
    ]
  };
  const expected = referenceRequiredFund(shape);
  const result = project({
    currentAge: shape.currentAge,
    horizonEndAge: shape.horizonEndAge,
    annualExpenditureToday: shape.annualExpenditureToday,
    expenditureInflationRate: shape.expenditureInflationRate,
    presentValueRate: shape.presentValueRate,
    incomeSources: shape.incomeSources.map((source) => ({ ...source, title: source.id }))
  });
  close(
    scenarioOf(result).requiredFundToday,
    expected.required,
    CENT,
    'forty-one years of discounted shortfalls vs the reference'
  );
  assert.equal(scenarioOf(result).annualRows.length, expected.rows.length);
  // And row by row, not just in total.
  scenarioOf(result).annualRows.forEach((row, index) => {
    close(row.netExpenditure, expected.rows[index].spending, CENT, `spending at age ${row.age}`);
    close(row.netIncome, expected.rows[index].income, CENT, `income at age ${row.age}`);
    close(row.presentValueShortfall, expected.rows[index].discounted, CENT, `discounted shortfall at age ${row.age}`);
  });
  pass('a full forty-one-year projection matches the reference row by row and in total');
}

{
  // Income start and end ages are honoured exactly.
  const result = project({
    horizonEndAge: 63,
    incomeSources: [{
      id: 'later', title: 'Net income from 62', annualAmountToday: 10_000,
      startAge: 62, inflationIndexed: false
    }]
  });
  const income = scenarioOf(result).annualRows.map((row) => row.netIncome);
  assert.deepEqual(income, [0, 0, 10_000, 10_000], 'nothing before the start age, everything from it');
  close(scenarioOf(result).requiredFundToday, 40_000 + 40_000 + 30_000 + 30_000, CENT, 'and the fund reflects it');
  pass('an income source starts and stops on its own ages');
}

/* --------------------------------------- the gross-versus-net boundary */

const profileOf = (over = {}) => normalizeHouseholdProfile({
  ...createHouseholdProfile({ profileId: 'nrc', nowIso: NOW, calculationDateIso: TODAY }),
  primaryPerson: {
    personId: 'primary', role: 'primary', employmentStatus: 'retired', age: 60, intendedRetirementAge: 60
  },
  assets: [{ assetId: 'cash', ownerIds: ['primary'], type: 'cash', label: 'Cash', currentValue: EUR(500_000) }],
  incomeSources: [{
    incomeId: 'rent', ownerIds: ['primary'], type: 'rental', label: 'Net rent', netAnnual: EUR(10_000)
  }],
  expenses: { annualTotal: EUR(40_000) },
  goals: [{ goalId: 'g1', type: 'retire', priority: 'high', status: 'active', title: 'Retire' }],
  assumptions: { calculationDateIso: TODAY, values: {} },
  ...over
});

const asset = (assetId, type, value, liquid) => ({
  assetId, ownerIds: ['primary'], type, label: type, currentValue: EUR(value),
  ...(typeof liquid === 'undefined' ? {} : { liquid })
});

{
  // WHAT MAY FUND A NET REQUIREMENT. Cash and investments the client called
  // liquid; nothing else. A pension pot is gross and cannot stand in for an
  // after-tax fund, whether it is recorded as a pension-typed asset or as a
  // pension position.
  const cases = [
    ['cash', [asset('a', 'cash', 100_000)], [], 100_000],
    ['liquid investment', [asset('a', 'investment', 100_000, true)], [], 100_000],
    ['illiquid investment', [asset('a', 'investment', 100_000, false)], [], 0],
    ['investment with liquidity unstated', [asset('a', 'investment', 100_000)], [], 0],
    ['pension-typed asset', [asset('a', 'pension', 500_000)], [], 0],
    ['property', [asset('a', 'property', 500_000)], [], 0],
    ['business', [asset('a', 'business', 500_000)], [], 0],
    ['a pension position', [], [{
      pensionId: 'p', ownerId: 'primary', type: 'occupational', label: 'DC', currentValue: EUR(500_000)
    }], 0]
  ];
  for (const [name, assets, pensions, expected] of cases) {
    const input = buildNetRetirementInput(profileOf({ assets, pensions }));
    assert.equal(input.availableInvestmentFundToday, expected, `available fund from ${name}`);
  }
  pass('only cash and explicitly liquid investments fund a net requirement — never a pension pot');
}

{
  // WHAT MAY BE NET INCOME. A stated net amount, and nothing else: a source
  // carrying only a gross figure is excluded rather than read as net.
  const netOnly = buildNetRetirementInput(profileOf({
    incomeSources: [{
      incomeId: 'rent', ownerIds: ['primary'], type: 'rental', label: 'Net rent', netAnnual: EUR(10_000)
    }]
  }));
  assert.deepEqual(netOnly.incomeSources.map((source) => source.annualAmountToday), [10_000]);

  const grossOnly = buildNetRetirementInput(profileOf({
    incomeSources: [{
      incomeId: 'rent', ownerIds: ['primary'], type: 'rental', label: 'Gross rent', grossAnnual: EUR(10_000)
    }]
  }));
  assert.deepEqual(grossOnly.incomeSources, [], 'a gross-only source never becomes net income');

  const both = buildNetRetirementInput(profileOf({
    incomeSources: [{
      incomeId: 'rent', ownerIds: ['primary'], type: 'rental', label: 'Rent',
      grossAnnual: EUR(14_000), netAnnual: EUR(10_000)
    }]
  }));
  assert.deepEqual(both.incomeSources.map((source) => source.annualAmountToday), [10_000],
    'where both are stated the net figure is the one used');
  pass('only a stated net amount becomes net income; a gross figure is excluded, never converted');
}

{
  // A DEFINED-BENEFIT PENSION DOES NOT CROSS THE BOUNDARY. Pension Projection
  // knows this €20,000, and it is gross — so it stays out until somebody
  // supplies an after-tax figure.
  const input = buildNetRetirementInput(profileOf({
    pensions: [{
      pensionId: 'db', ownerId: 'primary', type: 'defined_benefit', label: 'DB scheme',
      projectedAnnualIncome: EUR(20_000), benefitStartAge: 65
    }]
  }));
  assert.deepEqual(
    input.incomeSources.map((source) => source.id),
    ['rent'],
    'the gross DB payment is absent from the net cash flow'
  );
  assert.ok(
    !input.incomeSources.some((source) => source.annualAmountToday === 20_000),
    'and its amount appears nowhere'
  );

  // The same client CAN have it counted, by stating a net amount as an income
  // source. That is the supported route, and it works.
  const withNet = buildNetRetirementInput(profileOf({
    pensions: [{
      pensionId: 'db', ownerId: 'primary', type: 'defined_benefit', label: 'DB scheme',
      projectedAnnualIncome: EUR(20_000), benefitStartAge: 65
    }],
    incomeSources: [
      { incomeId: 'rent', ownerIds: ['primary'], type: 'rental', label: 'Net rent', netAnnual: EUR(10_000) },
      {
        incomeId: 'db-net', ownerIds: ['primary'], type: 'pension',
        label: 'Net DB pension', netAnnual: EUR(15_000), startAge: 65
      }
    ]
  }));
  const dbNet = withNet.incomeSources.filter((source) => source.id === 'db-net');
  assert.equal(dbNet.length, 1, 'a client-supplied net pension amount does count');
  assert.equal(dbNet[0].annualAmountToday, 15_000, 'at the after-tax figure, not the gross one');
  assert.equal(dbNet[0].startAge, 65);
  pass('a gross DB pension stays out; a client-supplied net pension amount is counted at its net figure');
}

{
  // STATE PENSION follows exactly the same rule, and the rules catalogue says
  // so in as many words on the entry itself.
  const grossSp = buildNetRetirementInput(profileOf({
    incomeSources: [{
      incomeId: 'sp', ownerIds: ['primary'], type: 'state_pension', label: 'State Pension',
      grossAnnual: EUR(15_563.60)
    }]
  }));
  assert.deepEqual(grossSp.incomeSources, [], 'a gross State Pension is not net income');

  const netSp = buildNetRetirementInput(profileOf({
    incomeSources: [{
      incomeId: 'sp', ownerIds: ['primary'], type: 'state_pension', label: 'Net State Pension',
      netAnnual: EUR(7_781.80), startAge: 66
    }]
  }));
  assert.equal(netSp.incomeSources.length, 1);
  assert.equal(netSp.incomeSources[0].annualAmountToday, 7_781.80, 'a stated net amount is used as given');
  pass('State Pension enters only as a stated net amount, never at its gross catalogue rate');
}

/* ------------------------------------------------ household and ownership */

{
  const couple = (incomeSources) => profileOf({
    partner: {
      personId: 'partner', role: 'partner', employmentStatus: 'retired', age: 58, intendedRetirementAge: 58
    },
    incomeSources
  });

  // A jointly owned net rent is ONE source at its full amount.
  const joint = buildNetRetirementInput(couple([{
    incomeId: 'rent', ownerIds: ['primary', 'partner'], type: 'rental',
    label: 'Joint net rent', netAnnual: EUR(12_000)
  }]));
  assert.equal(joint.incomeSources.length, 1, 'two owners is not two incomes');
  assert.equal(joint.incomeSources[0].annualAmountToday, 12_000, 'and not twice the amount');

  // Each person's own net income is kept, and neither is lost.
  const separate = buildNetRetirementInput(couple([
    {
      incomeId: 'p1', ownerIds: ['primary'], type: 'pension',
      label: 'Net pension (primary)', netAnnual: EUR(9_000)
    },
    {
      incomeId: 'p2', ownerIds: ['partner'], type: 'pension',
      label: 'Net pension (partner)', netAnnual: EUR(7_000)
    }
  ]));
  const byId = Object.fromEntries(separate.incomeSources.map((source) => [source.id, source.annualAmountToday]));
  assert.deepEqual(byId, { p1: 9_000, p2: 7_000 }, 'both people’s income survives, once each');
  pass('a joint net income counts once and neither person’s own income is lost or doubled');
}

/* ------------------------------------------------------------- scenarios */

const SCENARIO_BASE = {
  ...ENGINE_BASE,
  availableInvestmentFundToday: 1_027_000,
  incomeSources: [
    { id: 'irish-rent', title: 'Net Irish rent', annualAmountToday: 10_000, startAge: 60, inflationIndexed: false },
    { id: 'eu-rent', title: 'Net EU rent', annualAmountToday: 14_000, startAge: 60, inflationIndexed: false }
  ]
};
const withScenarios = (scenarios, id) =>
  computeNetRetirementProjection({ ...SCENARIO_BASE, scenarios }, { scenarioId: id });

{
  const base = withScenarios([{ id: 'base', title: 'Keep the rental' }], 'base');
  close(scenarioOf(base).requiredFundToday, 3 * 16_000, CENT, 'three years of a 16,000 shortfall');
  close(scenarioOf(base).surplusVsRequired, 1_027_000 - 48_000, CENT, 'against the available fund');
  pass('the base scenario nets income against spending and compares the fund to the requirement');
}

{
  // KEEP VERSUS SELL. Selling loses the rent AND raises the fund, and the
  // scenario must state both: the engine does not infer one from the other.
  const scenarios = [
    { id: 'base', title: 'Keep the rental' },
    {
      id: 'sell', title: 'Sell the Irish rental',
      excludedIncomeSourceIds: ['irish-rent'],
      availableInvestmentFundToday: 1_477_000
    }
  ];
  const sell = withScenarios(scenarios, 'sell');
  close(scenarioOf(sell).requiredFundToday, 3 * 26_000, CENT, 'the rent is genuinely gone from the requirement');
  assert.equal(scenarioOf(sell).availableInvestmentFundToday, 1_477_000, 'and the proceeds are in the fund');
  const irish = scenarioOf(sell).incomeSources.find((source) => source.id === 'irish-rent');
  assert.equal(irish.annualAmountToday, 0, 'the sold asset produces no income');
  close(scenarioOf(sell).incomeLostToday, 10_000, CENT, 'and the income given up is reported');

  // The proceeds are NOT also counted as income: the requirement rose by
  // exactly the lost rent, and the fund rose by exactly the stated proceeds.
  const base = withScenarios(scenarios, 'base');
  close(
    scenarioOf(sell).requiredFundToday - scenarioOf(base).requiredFundToday,
    3 * 10_000,
    CENT,
    'the requirement moved by the lost rent alone'
  );
  close(
    scenarioOf(sell).availableInvestmentFundToday - scenarioOf(base).availableInvestmentFundToday,
    450_000,
    CENT,
    'and the fund by the stated proceeds alone'
  );

  // Selecting the base scenario is unaffected by the sell scenario existing.
  close(scenarioOf(base).requiredFundToday, 3 * 16_000, CENT);
  assert.equal(scenarioOf(base).availableInvestmentFundToday, 1_027_000);
  pass('selling the rental loses its income and adds its proceeds, each counted exactly once');
}

{
  // Overrides and additional sources.
  const halved = withScenarios([
    { id: 'base', title: 'Base' },
    { id: 'half', title: 'Halve the EU rent', incomeSourceOverrides: [{ sourceId: 'eu-rent', annualAmountToday: 7_000 }] }
  ], 'half');
  close(scenarioOf(halved).requiredFundToday, 3 * 23_000, CENT, 'the override changes only that source');

  const added = withScenarios([
    { id: 'base', title: 'Base' },
    {
      id: 'annuity', title: 'Buy an annuity',
      additionalIncomeSources: [{
        id: 'ann', title: 'Net annuity', annualAmountToday: 6_000, startAge: 60, inflationIndexed: false
      }]
    }
  ], 'annuity');
  close(scenarioOf(added).requiredFundToday, 3 * 10_000, CENT, 'an added source reduces the requirement');
  assert.equal(scenarioOf(added).incomeSources.length, 3, 'and joins the existing ones rather than replacing them');
  pass('scenario overrides and additional income sources apply to exactly what they name');
}

/* --------------------------------------------------- failing closed */

{
  // Unknown spending is the one input that must never become zero: a household
  // that needs nothing needs no fund, which is the most reassuring wrong answer
  // this module could give.
  const noSpending = profileOf({ expenses: {} });
  const readiness = getNetRetirementReadiness(noSpending);
  assert.equal(readiness.status, 'missing_information', 'the module stays unready');
  assert.ok(readiness.requiredMissing.some((item) => item.fieldPath.startsWith('/expenses')));
  assert.equal(buildNetRetirementInput(noSpending).annualExpenditureToday, null, 'and never substitutes zero');
  assert.throws(
    () => validateNetRetirementInput(buildNetRetirementInput(noSpending)),
    /annualExpenditureToday must be a finite number/,
    'the contract refuses it outright'
  );
  pass('unknown spending stays unknown and is refused, never rounded down to needing nothing');
}

{
  // An unknown fund withholds the comparison rather than asserting either way.
  const unknownFund = project({ availableInvestmentFundToday: null });
  assert.equal(scenarioOf(unknownFund).surplusVsRequired, null, 'no surplus is claimed');
  assert.equal(scenarioOf(unknownFund).gapVsRequired, null, 'and no gap either');
  assert.ok(scenarioOf(unknownFund).requiredFundToday > 0, 'while the requirement is still stated');

  // A household with no recorded liquid assets is reported as needing the whole
  // fund, which is the conservative direction, not a false reassurance.
  const noAssets = buildNetRetirementInput(profileOf({ assets: [] }));
  assert.equal(noAssets.availableInvestmentFundToday, 0);
  const result = project({ availableInvestmentFundToday: 0 });
  assert.ok(scenarioOf(result).gapVsRequired > 0, 'the client is shown a gap, never a surplus');
  pass('an unknown fund withholds the comparison, and no recorded assets errs toward a gap');
}

{
  const valid = buildNetRetirementInput(profileOf());
  assert.doesNotThrow(() => validateNetRetirementInput(valid));
  const refusals = [
    [{ ...valid, annualExpenditureToday: -1 }, /must not be negative/, 'negative spending'],
    [{ ...valid, annualExpenditureToday: Number.NaN }, /finite number/, 'non-finite spending'],
    [{ ...valid, availableInvestmentFundToday: -1 }, /must not be negative/, 'a negative fund'],
    [
      { ...valid, incomeSources: [{ id: 'x', title: 'X', annualAmountToday: -5, startAge: 60 }] },
      /must not be negative/, 'a negative income source'
    ],
    [{ ...valid, presentValueRate: -1 }, /greater than -1/, 'a discount rate of -100%'],
    [{ ...valid, horizonEndAge: 10 }, /greater than or equal to currentAge/, 'a horizon behind the client'],
    [
      {
        ...valid,
        incomeSources: [
          { id: 'dup', title: 'A', annualAmountToday: 1_000, startAge: 60 },
          { id: 'dup', title: 'B', annualAmountToday: 2_000, startAge: 60 }
        ]
      },
      /must be unique/, 'two income sources sharing an id'
    ]
  ];
  for (const [input, pattern, note] of refusals) {
    assert.throws(() => validateNetRetirementInput(input), pattern, `refused: ${note}`);
  }
  // A null fund is deliberately allowed: unknown is a real state here.
  assert.doesNotThrow(() => validateNetRetirementInput({ ...valid, availableInvestmentFundToday: null }));
  pass('the input contract refuses negatives, impossible horizons and duplicate ids, and allows an unknown fund');
}

/* ------------------------------------------------------------- end to end */

{
  const profile = profileOf();
  const result = await runPlanningModule('net_retirement_cashflow', profile, {
    calculationVersion: 'test', calculatedAt: NOW, scenarioOverrides: {}
  });
  assert.equal(result.moduleId, 'net_retirement_cashflow');

  const input = buildNetRetirementInput(profile);
  const expected = referenceRequiredFund({
    currentAge: input.currentAge,
    horizonEndAge: input.horizonEndAge,
    annualExpenditureToday: input.annualExpenditureToday,
    expenditureInflationRate: input.expenditureInflationRate,
    presentValueRate: input.presentValueRate,
    incomeSources: input.incomeSources
  });
  close(
    result.semanticResult.requiredNetFundToday,
    expected.required,
    CENT,
    'the module reports the independently computed required net fund'
  );
  // The output names itself net, so it cannot be read as a gross pension figure.
  assert.ok(
    Object.hasOwn(result.semanticResult, 'requiredNetFundToday'),
    'the client-facing field says net in its own name'
  );
  pass('net retirement cash flow runs end to end and reports the independently computed net fund');
}

{
  const profile = profileOf({ expenses: {} });
  let error = null;
  try {
    await runPlanningModule('net_retirement_cashflow', profile, {
      calculationVersion: 'test', calculatedAt: NOW
    });
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, 'a profile with no spending fails the run');
  assert.equal(
    classifyModuleFailure(error),
    MODULE_FAILURE_CODES.INPUT_INVALID,
    'and reports as an invalid input rather than an engine crash'
  );
  pass('a missing spending figure reports module_input_invalid through the run path');
}

console.info('[NetRetirementAudit] All net retirement cash-flow audit checks passed.');
