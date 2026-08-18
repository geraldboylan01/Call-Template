#!/usr/bin/env node

/**
 * PHASE 5 MODULE #2 — THE PERSONAL BALANCE SHEET, PROVED ARITHMETICALLY.
 *
 * This module combines five collections into one number a client will believe.
 * A balance sheet that is wrong does not look wrong: it looks like a net worth.
 * So nothing here is checked against the engine's own opinion of itself.
 *
 * THE REFERENCE CALCULATOR BELOW IS DELIBERATELY SEPARATE from the production
 * engine. It re-adds every case from the case's own declared holdings and
 * cannot import a bucketing rule, a rounding helper or a total from the code
 * under test -- otherwise a shared bug would agree with itself and pass.
 *
 * `reconciliationDifference` is NOT treated as an oracle. The engine computes
 * `netWorth = gross - liabilities` and then `difference = gross - liabilities -
 * netWorth`, so it is zero by construction and can only ever catch a rounding
 * slip. It is asserted for what it is worth and no more; the real check is the
 * independent arithmetic.
 *
 * THE DEFECT THIS PINS. The engine guarded its buckets, its signs and its
 * finiteness, but never that a position appears once. The same 50,000 holding
 * supplied twice became 100,000 of net worth -- and the accounting identity
 * still balanced perfectly, because doubling both sides of a consistent sum
 * keeps it consistent. A wrong balance sheet that passes its own consistency
 * check is precisely the plausible-but-wrong figure this module must be
 * incapable of producing.
 */

import assert from 'node:assert/strict';

import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';
import {
  buildPersonalBalanceSheetInput,
  getPersonalBalanceSheetReadiness
} from '../js/planning/adapters/personal_balance_sheet.js';
import { computePersonalBalanceSheet } from '../js/personal_balance_sheet.js';
import { runPlanningModule } from '../js/planning/module_registry.js';
import { MODULE_FAILURE_CODES, classifyModuleFailure } from '../js/planning/module_failures.js';

const pass = (message) => console.info(`[PBSAudit] PASS: ${message}`);

const NOW = '2026-08-18T09:00:00.000Z';
const TODAY = '2026-08-18';
const EUR = (amount) => ({ amount, currency: 'EUR' });

/* ------------------------------------------------ independent arithmetic */

/**
 * Add up a case by hand, from the holdings the case itself declares.
 *
 * It knows nothing about buckets, ownership or collections -- only that a
 * balance sheet is what you own minus what you owe, each thing counted once.
 */
function reference(holdings, debts) {
  const total = (rows) => rows.reduce((sum, row) => sum + row, 0);
  const grossAssets = total(holdings);
  const totalLiabilities = total(debts);
  return { grossAssets, totalLiabilities, netWorth: grossAssets - totalLiabilities };
}

function profileOf(over) {
  const base = createHouseholdProfile({ profileId: 'pbs', nowIso: NOW, calculationDateIso: TODAY });
  return normalizeHouseholdProfile({
    ...base,
    primaryPerson: { personId: 'primary', role: 'primary', employmentStatus: 'employee', age: 44 },
    partner: { personId: 'partner', role: 'partner', employmentStatus: 'employee', age: 45 },
    expenses: { monthlyEssential: EUR(3000) },
    assumptions: {
      calculationDateIso: TODAY,
      values: { completionFacts: { confirmedNonePaths: { '/liabilities': true } } }
    },
    ...over
  });
}

const balanceSheetFor = (profile) => computePersonalBalanceSheet(buildPersonalBalanceSheetInput(profile));

/**
 * Assert a case against hand arithmetic, and assert the module's own internal
 * identities on top. `expectedHoldings` and `expectedDebts` are the amounts a
 * reader can add up from the case, not anything read back from the engine.
 */
function assertBalanceSheet(profile, expectedHoldings, expectedDebts, note = '') {
  const expected = reference(expectedHoldings, expectedDebts);
  const actual = balanceSheetFor(profile);
  const where = note ? ` (${note})` : '';
  assert.equal(actual.grossAssets, expected.grossAssets, `gross assets${where}`);
  assert.equal(actual.totalLiabilities, expected.totalLiabilities, `total liabilities${where}`);
  assert.equal(actual.netWorth, expected.netWorth, `net worth${where}`);
  // Exact equality is right here: every amount in these cases is a whole
  // number of euro, so no rounding tolerance is warranted or justified.
  assert.equal(actual.reconciliationDifference, 0, `reconciliation difference${where}`);
  const bucketTotal = Object.values(actual.buckets).reduce((sum, detail) => sum + detail.total, 0);
  assert.equal(bucketTotal, actual.grossAssets, `buckets must total gross assets${where}`);
  const counted = Object.values(actual.buckets).flatMap((detail) => detail.positions).length;
  assert.equal(counted, expectedHoldings.length, `every holding appears in exactly one bucket${where}`);
  return actual;
}

const cash = (assetId, ownerIds, amount, label = 'Savings') => ({
  assetId, ownerIds, type: 'cash', label, currentValue: EUR(amount)
});

/* --------------------------------------------------- hand-checkable case */

{
  // 300,000 home plus 10,000 cash, less a 200,000 mortgage. 110,000, and a
  // reader can confirm every step without running anything.
  const profile = profileOf({
    assets: [cash('c1', ['household'], 10_000)],
    properties: [{
      propertyId: 'pr1', ownerIds: ['primary', 'partner'], use: 'home', label: 'Home', currentValue: EUR(300_000)
    }],
    liabilities: [{
      liabilityId: 'l1', ownerIds: ['primary', 'partner'], type: 'mortgage', label: 'Mortgage', currentBalance: EUR(200_000)
    }],
    assumptions: { calculationDateIso: TODAY, values: {} }
  });
  const result = assertBalanceSheet(profile, [300_000, 10_000], [200_000], 'hand-checkable');
  assert.equal(result.netWorth, 110_000);
  assert.equal(result.buckets.lifestyle_assets.total, 300_000, 'the home they live in is a lifestyle asset');
  assert.equal(result.buckets.spendable_reserves.total, 10_000);
  pass('hand-checkable case: 300,000 home + 10,000 cash - 200,000 mortgage = 110,000');
}

/* ------------------------------------------------------- ownership shapes */

{
  // THE HEADLINE OWNERSHIP GUARANTEE. A joint 100,000 holding is 100,000 of
  // household net worth, not 200,000 because two people own it.
  const profile = profileOf({ assets: [cash('a1', ['primary', 'partner'], 100_000, 'Joint savings')] });
  const result = assertBalanceSheet(profile, [100_000], [], 'joint asset');
  assert.equal(result.netWorth, 100_000);
  assert.notEqual(result.netWorth, 200_000, 'two owners is not two holdings');
  pass('a joint 100,000 asset contributes 100,000, not 200,000');
}

{
  // Four ownership shapes at once, each counted exactly once.
  const profile = profileOf({
    assets: [
      cash('a1', ['primary'], 10_000, 'Aoife savings'),
      cash('a2', ['partner'], 20_000, 'Cian savings'),
      cash('a3', ['primary', 'partner'], 30_000, 'Joint savings'),
      cash('a4', ['household'], 40_000, 'Household savings')
    ]
  });
  const result = assertBalanceSheet(profile, [10_000, 20_000, 30_000, 40_000], [], 'mixed ownership');
  assert.equal(result.netWorth, 100_000);
  pass('primary, partner, joint and household holdings together total once each');
}

{
  // A partner-only holding belongs in the household balance sheet, at its full
  // value, without being reassigned to the primary.
  const profile = profileOf({ assets: [cash('a1', ['partner'], 75_000, 'Cian savings')] });
  const input = buildPersonalBalanceSheetInput(profile);
  assertBalanceSheet(profile, [75_000], [], 'partner-only');
  assert.equal(input.assetPositions.length, 1);
  assert.equal(input.assetPositions[0].id, 'a1', 'the partner’s holding appears, by its own identity');
  pass('a partner-only asset appears in the household sheet without being reassigned');
}

{
  // Pensions are single-owner by schema and reach the sheet per person.
  const profile = profileOf({
    assets: [cash('c1', ['household'], 5_000)],
    pensions: [
      { pensionId: 'p1', ownerId: 'primary', type: 'occupational', label: 'Aoife pension', currentValue: EUR(150_000) },
      { pensionId: 'p2', ownerId: 'partner', type: 'prsa', label: 'Cian pension', currentValue: EUR(80_000) }
    ]
  });
  const result = assertBalanceSheet(profile, [5_000, 150_000, 80_000], [], 'individual pensions');
  assert.equal(result.buckets.retirement_funding.total, 230_000, 'both pensions, once each');
  const ids = buildPersonalBalanceSheetInput(profile).assetPositions.map((position) => position.id);
  assert.deepEqual([...ids].sort(), ['c1', 'p1', 'p2'], 'resolved by identity, not by position');
  pass('individually owned pensions reach the sheet once each and keep their identity');
}

{
  // Liabilities, individually and jointly owned, each counted once.
  const profile = profileOf({
    assets: [cash('a1', ['household'], 250_000)],
    liabilities: [
      { liabilityId: 'l1', ownerIds: ['primary', 'partner'], type: 'mortgage', label: 'Mortgage', currentBalance: EUR(180_000) },
      { liabilityId: 'l2', ownerIds: ['primary'], type: 'loan', label: 'Car loan', currentBalance: EUR(12_000) },
      { liabilityId: 'l3', ownerIds: ['household'], type: 'credit_card', label: 'Card', currentBalance: EUR(3_000) }
    ],
    assumptions: { calculationDateIso: TODAY, values: {} }
  });
  const result = assertBalanceSheet(profile, [250_000], [180_000, 12_000, 3_000], 'mixed liabilities');
  assert.equal(result.totalLiabilities, 195_000);
  assert.equal(result.netWorth, 55_000);
  pass('individually and jointly owned liabilities are each counted once');
}

/* -------------------------------------------------------- no double count */

{
  // The duplication guard. A home recorded BOTH as a generic property asset
  // and as a specialist property record must not be counted twice; the module
  // refuses to run until someone says which it is.
  const profile = profileOf({
    assets: [
      cash('a1', ['household'], 10_000),
      { assetId: 'a2', ownerIds: ['primary', 'partner'], type: 'property', label: 'Home', currentValue: EUR(300_000) }
    ],
    properties: [{
      propertyId: 'pr1', ownerIds: ['primary', 'partner'], use: 'home', label: 'Home', currentValue: EUR(300_000)
    }]
  });
  const readiness = getPersonalBalanceSheetReadiness(profile);
  assert.equal(readiness.status, 'missing_information', 'an unreviewed overlap blocks the sheet');
  assert.ok(
    readiness.requiredMissing.some((item) => item.fieldPath.includes('specialistAssetReconciliation/property')),
    'and says exactly which record needs the decision'
  );
  // Even called directly, the unreviewed specialist record stays out: 310,000,
  // never 610,000.
  const result = balanceSheetFor(profile);
  assert.equal(result.grossAssets, 310_000);
  assert.notEqual(result.grossAssets, 610_000, 'the home is never counted twice');
  pass('a home recorded twice blocks the sheet and is never double counted');
}

{
  // Reviewed as a duplicate, the specialist record stays out and the sheet runs.
  const profile = profileOf({
    assets: [
      cash('a1', ['household'], 10_000),
      { assetId: 'a2', ownerIds: ['primary', 'partner'], type: 'property', label: 'Home', currentValue: EUR(300_000) }
    ],
    properties: [{
      propertyId: 'pr1', ownerIds: ['primary', 'partner'], use: 'home', label: 'Home', currentValue: EUR(300_000)
    }],
    assumptions: {
      calculationDateIso: TODAY,
      values: {
        completionFacts: {
          confirmedNonePaths: { '/liabilities': true },
          specialistAssetReconciliation: { property: { pr1: 'duplicate' } }
        }
      }
    }
  });
  assert.equal(getPersonalBalanceSheetReadiness(profile).status, 'ready');
  assertBalanceSheet(profile, [10_000, 300_000], [], 'reviewed duplicate');
  pass('a reviewed duplicate is excluded and the sheet totals each holding once');
}

{
  // Reviewed as distinct -- a second, genuinely separate property -- both count.
  const profile = profileOf({
    assets: [
      cash('a1', ['household'], 10_000),
      { assetId: 'a2', ownerIds: ['primary', 'partner'], type: 'property', label: 'Home', currentValue: EUR(300_000) }
    ],
    properties: [{
      propertyId: 'pr1', ownerIds: ['primary'], use: 'rental', label: 'Rental', currentValue: EUR(220_000)
    }],
    assumptions: {
      calculationDateIso: TODAY,
      values: {
        completionFacts: {
          confirmedNonePaths: { '/liabilities': true },
          specialistAssetReconciliation: { property: { pr1: 'distinct' } }
        }
      }
    }
  });
  const result = assertBalanceSheet(profile, [10_000, 300_000, 220_000], [], 'reviewed distinct');
  assert.equal(result.grossAssets, 530_000);
  assert.equal(result.buckets.concentrated_assets.total, 520_000,
    'a rental is held for a return, and so is the untyped generic property asset');
  pass('a reviewed distinct property is included, and neither holding is lost');
}

{
  // THE ENGINE'S OWN GUARANTEE, tested at the engine rather than through the
  // adapter: the same position supplied twice is refused outright.
  assert.throws(
    () => computePersonalBalanceSheet({
      assetPositions: [
        { id: 'a1', label: 'Savings', bucket: 'spendable_reserves', amount: 50_000, source: 'assets' },
        { id: 'a1', label: 'Savings', bucket: 'spendable_reserves', amount: 50_000, source: 'assets' }
      ],
      liabilityPositions: []
    }),
    /counted exactly once/,
    'a duplicated asset position is refused'
  );
  assert.throws(
    () => computePersonalBalanceSheet({
      assetPositions: [{ id: 'a1', label: 'S', bucket: 'spendable_reserves', amount: 10, source: 'assets' }],
      liabilityPositions: [
        { id: 'l1', label: 'Loan', amount: 30_000, source: 'liabilities' },
        { id: 'l1', label: 'Loan', amount: 30_000, source: 'liabilities' }
      ]
    }),
    /counted exactly once/,
    'a duplicated liability position is refused'
  );
  pass('a position supplied twice is refused rather than silently doubled');
}

{
  // ...but identity is the collection PLUS the id. Two different things that
  // happen to share an id are still two things, and refusing them would reject
  // a correct balance sheet.
  const profile = profileOf({
    assets: [cash('shared-id', ['primary'], 10_000)],
    businesses: [{
      businessId: 'shared-id', ownerIds: ['primary'], label: 'Consultancy', agricultural: false, estimatedValue: EUR(90_000)
    }]
  });
  const result = assertBalanceSheet(profile, [10_000, 90_000], [], 'colliding ids across collections');
  assert.equal(result.grossAssets, 100_000);
  pass('two different holdings sharing an id are still counted as two holdings');
}

/* ------------------------------------------------------------ edge cases */

{
  const profile = profileOf({
    assumptions: {
      calculationDateIso: TODAY,
      values: { completionFacts: { confirmedNonePaths: { '/assets': true, '/liabilities': true } } }
    }
  });
  const result = assertBalanceSheet(profile, [], [], 'empty household');
  assert.equal(result.netWorth, 0);
  assert.equal(result.reserveMonths, 0, 'no reserves is zero months, not null or infinite');
  pass('zero assets and zero liabilities produce a zero sheet, not a failure');
}

{
  const profile = profileOf({
    assets: [cash('a1', ['household'], 5_000)],
    liabilities: [{ liabilityId: 'l1', ownerIds: ['primary'], type: 'loan', label: 'Loan', currentBalance: EUR(30_000) }],
    assumptions: { calculationDateIso: TODAY, values: {} }
  });
  const result = assertBalanceSheet(profile, [5_000], [30_000], 'negative net worth');
  assert.equal(result.netWorth, -25_000, 'a household that owes more than it owns is reported, not floored at zero');
  pass('negative net worth is reported honestly rather than clamped');
}

{
  // Reserve months, checked independently: 24,000 of reserves against 3,000 a
  // month is 8 months. Nothing else in the sheet changes it.
  const profile = profileOf({
    assets: [cash('a1', ['household'], 24_000), {
      assetId: 'a2', ownerIds: ['primary'], type: 'property', label: 'Land', currentValue: EUR(500_000)
    }],
    expenses: { monthlyEssential: EUR(2_000), monthlyDiscretionary: EUR(1_000) }
  });
  const result = balanceSheetFor(profile);
  assert.equal(result.monthlyExpenditure, 3_000, 'essential plus discretionary');
  assert.equal(result.spendableReserves, 24_000, 'only the spendable bucket counts as reserves');
  assert.equal(result.reserveMonths, 8, '24,000 / 3,000');
  pass('reserve months is spendable reserves over monthly spending, and illiquid wealth does not inflate it');
}

{
  // A holding with no value at all cannot be silently dropped from a balance
  // sheet: the module blocks and names the field.
  const profile = profileOf({
    assets: [
      cash('a1', ['household'], 20_000),
      { assetId: 'a2', ownerIds: ['primary'], type: 'investment', label: 'Shares' }
    ]
  });
  const readiness = getPersonalBalanceSheetReadiness(profile);
  assert.equal(readiness.status, 'missing_information');
  assert.ok(readiness.requiredMissing.some((item) => item.fieldPath === '/assets/1/currentValue'));
  assert.throws(() => buildPersonalBalanceSheetInput(profile), /incomplete/);
  pass('a holding with no value blocks the sheet rather than being omitted from it');
}

{
  // Cross-currency is fail-closed, and says so precisely: the figure is not
  // missing, it is in another currency and will not be converted implicitly.
  const profile = profileOf({
    assets: [
      cash('a1', ['household'], 20_000),
      { assetId: 'a2', ownerIds: ['primary'], type: 'cash', label: 'US savings', currentValue: { amount: 9_000, currency: 'USD' } }
    ]
  });
  const readiness = getPersonalBalanceSheetReadiness(profile);
  assert.equal(readiness.status, 'missing_information', 'foreign holdings are not silently excluded');
  const reason = readiness.requiredMissing.find((item) => item.fieldPath === '/assets/1/currentValue')?.reason || '';
  assert.match(reason, /recorded in USD/, 'and the reason names the currency, not a missing figure');
  assert.match(reason, /no implicit FX conversion/);
  pass('a holding in another currency fails closed with a diagnostic that says why');
}

{
  // A spoken aggregate is a summary, not a holding. It lives outside the
  // position collections and so contributes nothing to net worth -- the
  // alternative being a household counted twice: once in its holdings and
  // again in its own summary of them.
  const profile = profileOf({
    assets: [cash('a1', ['primary'], 30_000), cash('a2', ['partner'], 20_000)],
    householdIncome: { netMonthly: EUR(7_000) },
    assumptions: {
      calculationDateIso: TODAY,
      values: {
        completionFacts: { confirmedNonePaths: { '/liabilities': true } },
        summaries: { totalSavings: { amount: 50_000, currency: 'EUR' } }
      }
    }
  });
  const result = assertBalanceSheet(profile, [30_000, 20_000], [], 'aggregate alongside holdings');
  assert.equal(result.grossAssets, 50_000, 'the two holdings, once');
  assert.notEqual(result.grossAssets, 100_000, 'the summary of them is not a third holding');
  pass('a stated aggregate never becomes a position on the balance sheet');
}

/* ------------------------------------------------- failure classification */

{
  const profile = profileOf({
    assets: [cash('a1', ['household'], 20_000), { assetId: 'a2', ownerIds: ['primary'], type: 'investment', label: 'Shares' }]
  });
  let error = null;
  try {
    await runPlanningModule('personal_balance_sheet', profile, { calculationVersion: 'test', calculatedAt: NOW });
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, 'an incomplete position fails the run');
  assert.equal(classifyModuleFailure(error), MODULE_FAILURE_CODES.INPUT_INVALID,
    'and reports as an invalid input, not as an engine crash');
  pass('a balance sheet that cannot be built reports module_input_invalid');
}

{
  const profile = profileOf({
    assets: [cash('a1', ['household'], 10_000)],
    properties: [{ propertyId: 'pr1', ownerIds: ['primary', 'partner'], use: 'home', label: 'Home', currentValue: EUR(300_000) }],
    liabilities: [{ liabilityId: 'l1', ownerIds: ['primary', 'partner'], type: 'mortgage', label: 'Mortgage', currentBalance: EUR(200_000) }],
    assumptions: { calculationDateIso: TODAY, values: {} }
  });
  const result = await runPlanningModule('personal_balance_sheet', profile, {
    calculationVersion: 'test', calculatedAt: NOW, scenarioOverrides: {}
  });
  assert.equal(result.moduleId, 'personal_balance_sheet');
  assert.equal(result.semanticResult.netWorth, 110_000, 'the run reports the same independently checked figure');
  assert.equal(result.semanticResult.grossAssets, 310_000);
  assert.equal(result.semanticResult.totalLiabilities, 200_000);
  assert.equal(result.semanticResult.reconciliationDifference, 0);
  pass('a healthy balance sheet runs end to end and reports the hand-checked net worth');
}

console.info('[PBSAudit] All Personal Balance Sheet audit checks passed.');
