import assert from 'node:assert/strict';

import { computePersonalBalanceSheet } from '../js/personal_balance_sheet.js';
import { buildPersonalBalanceSheetInput } from '../js/planning/adapters/personal_balance_sheet.js';
import {
  applyProfilePatch,
  createHouseholdProfile,
  getModuleReadiness,
  getPlanningModuleDefinition,
  runPlanningModule
} from '../js/planning/index.js';
import { summarizeAnalysisResults } from '../js/planning/result_summary.js';

const NOW = '2026-07-14T10:00:00.000Z';
const provenance = {
  source: 'user_confirmation',
  confidence: 'high',
  certainty: 'exact',
  capturedAt: NOW,
  confirmedByUser: true
};

const direct = computePersonalBalanceSheet({
  assetPositions: [
    { id: 'home', label: 'Home', bucket: 'lifestyle_assets', amount: 400_000 },
    { id: 'cash', label: 'Cash', bucket: 'spendable_reserves', amount: 30_000 },
    { id: 'pension', label: 'Pension', bucket: 'retirement_funding', amount: 100_000 },
    { id: 'shares', label: 'Shares', bucket: 'concentrated_assets', amount: 20_000 }
  ],
  liabilityPositions: [{ id: 'mortgage', label: 'Mortgage', amount: 250_000 }],
  monthlyExpenditure: 3_000
});
assert.equal(direct.grossAssets, 550_000);
assert.equal(direct.totalLiabilities, 250_000);
assert.equal(direct.netWorth, 300_000);
assert.equal(direct.spendableReserves, 30_000);
assert.equal(direct.reserveMonths, 10);
assert.equal(direct.reconciliationDifference, 0);
assert.throws(() => computePersonalBalanceSheet({
  assetPositions: [{ bucket: 'invented_bucket', amount: 1 }]
}), /Unsupported Personal Balance Sheet bucket/);

let profile = createHouseholdProfile({
  profileId: 'pbs-profile',
  nowIso: NOW,
  calculationDateIso: '2026-07-14'
});
profile = applyProfilePatch(profile, {
  patchId: 'pbs-facts',
  operations: [
    {
      op: 'add',
      path: '/assets/-',
      value: { assetId: 'cash', ownerIds: ['primary'], type: 'cash', label: 'Savings', currentValue: { amount: 30_000, currency: 'EUR' }, liquid: true },
      provenance
    },
    {
      op: 'add',
      path: '/assets/-',
      value: { assetId: 'home-generic', ownerIds: ['primary'], type: 'property', label: 'Home', currentValue: { amount: 400_000, currency: 'EUR' }, liquid: false },
      provenance
    },
    {
      op: 'add',
      path: '/assets/-',
      value: { assetId: 'pension-generic', ownerIds: ['primary'], type: 'pension', label: 'Main pension', currentValue: { amount: 100_000, currency: 'EUR' }, liquid: false },
      provenance
    },
    {
      op: 'add',
      path: '/properties/-',
      value: { propertyId: 'home-specialist', ownerIds: ['primary'], use: 'home', associatedLiabilityIds: ['mortgage'], currentValue: { amount: 400_000, currency: 'EUR' } },
      provenance
    },
    {
      op: 'add',
      path: '/properties/-',
      value: { propertyId: 'rental-specialist', ownerIds: ['primary'], use: 'rental', associatedLiabilityIds: [], currentValue: { amount: 200_000, currency: 'EUR' } },
      provenance
    },
    {
      op: 'add',
      path: '/pensions/-',
      value: { pensionId: 'pension', ownerId: 'primary', type: 'occupational', currentValue: { amount: 100_000, currency: 'EUR' } },
      provenance
    },
    {
      op: 'add',
      path: '/pensions/-',
      value: { pensionId: 'second-pension', ownerId: 'primary', type: 'prsa', currentValue: { amount: 50_000, currency: 'EUR' } },
      provenance
    },
    {
      op: 'add',
      path: '/liabilities/-',
      value: { liabilityId: 'mortgage', ownerIds: ['primary'], type: 'mortgage', label: 'Mortgage', currentBalance: { amount: 250_000, currency: 'EUR' } },
      provenance
    },
    {
      op: 'add',
      path: '/expenses/monthlyEssential',
      value: { amount: 3_000, currency: 'EUR' },
      provenance
    }
  ]
}, { nowIso: NOW }).profile;

const definition = getPlanningModuleDefinition('personal_balance_sheet');
assert.equal(definition.kind, 'calculation');
assert.equal(definition.consumerAvailable, true);
const unresolvedReconciliation = getModuleReadiness('personal_balance_sheet', profile);
assert.equal(unresolvedReconciliation.status, 'missing_information');
assert.equal(
  unresolvedReconciliation.requiredMissing.filter((item) => item.fieldPath.includes('specialistAssetReconciliation')).length,
  4,
  'Every overlapping specialist position needs an explicit record-level decision.'
);
profile = applyProfilePatch(profile, {
  patchId: 'pbs-reconciliation',
  operations: [{
    op: 'add',
    path: '/assumptions/values/completionFacts',
    value: {
      specialistAssetReconciliation: {
        property: {
          'home-specialist': 'duplicate',
          'rental-specialist': 'distinct'
        },
        pension: {
          pension: 'duplicate',
          'second-pension': 'distinct'
        }
      }
    },
    provenance
  }]
}, { nowIso: NOW }).profile;
assert.equal(getModuleReadiness('personal_balance_sheet', profile).status, 'ready');

const result = await runPlanningModule('personal_balance_sheet', profile, {
  calculationDateIso: '2026-07-14',
  calculationVersion: 'pbs-test-v1',
  calculatedAt: NOW,
  scenarioOverrides: {}
});
assert.equal(result.semanticResult.grossAssets, 780_000, 'duplicates are excluded while separate rental and pension positions remain');
assert.equal(result.semanticResult.totalLiabilities, 250_000);
assert.equal(result.semanticResult.netWorth, 530_000);
assert.equal(result.semanticResult.reconciliationDifference, 0);
assert.equal(result.semanticResult.bucketTotals.retirement_funding, 150_000);
assert.ok(result.warnings.some((warning) => warning.includes('explicit duplicate reconciliation')));
assert.ok(result.warnings.some((warning) => warning.includes('explicit distinct-position reconciliation')));

const summary = summarizeAnalysisResults({
  results: [result],
  errors: [],
  analysisPlan: { requiredQuestions: [] }
});
assert.equal(summary.generatedBy, 'deterministic_rules');
assert.ok(summary.speakableText.includes('€780,000'));
assert.ok(summary.speakableText.includes('€530,000'));
assert.equal(summary.highlights[0].numericFacts.netWorth, 530_000);
assert.equal(summary.headline, 'Recorded assets and liabilities are reconciled');
assert.doesNotMatch(
  [summary.headline, summary.speakableText, ...summary.nextSteps].join(' '),
  /personal balance sheet|personal_balance_sheet/i
);

let incomplete = createHouseholdProfile({
  profileId: 'pbs-incomplete-positions',
  nowIso: NOW,
  calculationDateIso: '2026-07-14'
});
incomplete = applyProfilePatch(incomplete, {
  patchId: 'pbs-incomplete-position-values',
  operations: [
    {
      op: 'add',
      path: '/assets/-',
      value: { assetId: 'known-cash', ownerIds: ['primary'], type: 'cash', label: 'Known cash', currentValue: { amount: 10_000, currency: 'EUR' }, liquid: true },
      provenance
    },
    {
      op: 'add',
      path: '/properties/-',
      value: { propertyId: 'unvalued-home', ownerIds: ['primary'], use: 'home', associatedLiabilityIds: [] },
      provenance
    },
    {
      op: 'add',
      path: '/liabilities/-',
      value: { liabilityId: 'known-loan', ownerIds: ['primary'], type: 'loan', label: 'Known loan', currentBalance: { amount: 2_000, currency: 'EUR' } },
      provenance
    },
    {
      op: 'add',
      path: '/liabilities/-',
      value: { liabilityId: 'unvalued-loan', ownerIds: ['primary'], type: 'loan', label: 'Unvalued loan' },
      provenance
    }
  ]
}, { nowIso: NOW }).profile;
const incompleteReadiness = getModuleReadiness('personal_balance_sheet', incomplete);
assert.equal(incompleteReadiness.status, 'missing_information');
assert.deepEqual(
  incompleteReadiness.requiredMissing
    .filter((item) => (item.importance ?? 'required') === 'required')
    .map((item) => item.fieldPath).sort(),
  ['/liabilities/1/currentBalance', '/properties/0/currentValue'],
  'Every existing unvalued financial position must block the balance-sheet run.'
);
// Monthly spending is ASKED FOR but never blocks: reserves expressed as months
// of cover need it, and plenty of people do not know what they spend.
assert.ok(
  incompleteReadiness.requiredMissing.some((item) => (
    item.fieldPath === '/expenses/monthlyEssential' && item.importance === 'assumed'
  )),
  'monthly spending is requested alongside, without blocking'
);
assert.throws(
  () => definition.buildInput(incomplete),
  /Personal Balance Sheet position values are incomplete/,
  'The deterministic input boundary must also fail closed if readiness is bypassed.'
);

let empty = createHouseholdProfile({ profileId: 'pbs-empty', nowIso: NOW, calculationDateIso: '2026-07-14' });
// Assets and liabilities BLOCK; monthly spending is asked for alongside them.
assert.equal(
  getModuleReadiness('personal_balance_sheet', empty).requiredMissing
    .filter((item) => (item.importance ?? 'required') === 'required').length,
  2
);
assert.equal(getModuleReadiness('personal_balance_sheet', empty).requiredMissing.length, 3);
empty = applyProfilePatch(empty, {
  patchId: 'pbs-none',
  operations: [
    { op: 'add', path: '/assumptions/values/completionFacts', value: { confirmedNonePaths: { '/assets': true, '/liabilities': true } }, provenance }
  ]
}, { nowIso: NOW }).profile;
assert.equal(getModuleReadiness('personal_balance_sheet', empty).status, 'ready');

// A METRIC WE COULD NOT CALCULATE IS LEFT OUT, NEVER SHOWN AS A BLANK.
// reserveMonths is null whenever monthly spending is unknown, and it was
// reaching a client-facing table as the literal word "null" -- an agent-driven
// call as a Cork nurse ended with "Reserve months: null" in her balance sheet.
{
  const buildProfile = (monthlyEssential) => {
    let profile = createHouseholdProfile({ profileId: 'pbs-null', nowIso: NOW, calculationDateIso: '2026-07-14' });
    return applyProfilePatch(profile, {
      patchId: 'pbs-null-1',
      operations: [
        { op: 'add', path: '/assets/-', value: { assetId: 'cash', label: 'Savings', type: 'cash', currentValue: { amount: 30_000, currency: 'EUR' }, liquid: true }, provenance },
        { op: 'add', path: '/assumptions/values/completionFacts', value: { confirmedNonePaths: { '/liabilities': true } }, provenance },
        ...(monthlyEssential === null ? [] : [
          { op: 'add', path: '/expenses/monthlyEssential', value: { amount: monthlyEssential, currency: 'EUR' }, provenance }
        ])
      ]
    }, { nowIso: NOW }).profile;
  };
  const rowsFor = async (monthlyEssential) => {
    const result = await runPlanningModule('personal_balance_sheet', buildProfile(monthlyEssential), {
      calculationDateIso: '2026-07-14'
    });
    return result.outputs.rows;
  };
  const withSpending = await rowsFor(3_000);
  assert.ok(withSpending.some(([label]) => label === 'Reserve months'),
    'a calculable figure is still shown');
  const withoutSpending = await rowsFor(null);
  assert.ok(!withoutSpending.some(([label]) => label === 'Reserve months'),
    'an uncalculable figure is omitted, never rendered blank');
  assert.ok(withoutSpending.every(([, value]) => value !== null && value !== undefined),
    'no client-facing row may carry a null');
  assert.equal(withoutSpending.length, withSpending.length - 1,
    'only the uncalculable row is dropped');
}

// THE FOUR BUCKETS ANSWER "WHAT JOB DOES THIS MONEY DO". Checked against the
// published contract in docs/prompt-pack/MASTER_PROJECT_PROMPT.md, because the
// engine disagreed with it in two ways that both flattered the client's
// position: an investment property counted as a Lifestyle asset, and anything
// unrecognised -- crypto, single shares, collectibles -- fell to Lifestyle too.
{
  const NOW_B = '2026-08-02T09:00:00.000Z';
  const prov2 = {
    source: 'user_confirmation', confidence: 'high', certainty: 'exact',
    capturedAt: NOW_B, confirmedByUser: true
  };
  const built = applyProfilePatch(
    createHouseholdProfile({ profileId: 'pbs-buckets', nowIso: NOW_B, calculationDateIso: '2026-08-02' }),
    {
      patchId: 'pbs-buckets-1',
      operations: [
        { op: 'add', path: '/properties/-', value: { propertyId: 'home', label: 'Family home', use: 'home', currentValue: { amount: 950_000, currency: 'EUR' } }, provenance: prov2 },
        { op: 'add', path: '/properties/-', value: { propertyId: 'rental', label: 'Investment property', use: 'rental', currentValue: { amount: 500_000, currency: 'EUR' } }, provenance: prov2 },
        { op: 'add', path: '/pensions/-', value: { pensionId: 'bond', ownerId: 'primary', label: 'Aviva buyout bond', type: 'buyout_bond', currentValue: { amount: 380_000, currency: 'EUR' } }, provenance: prov2 },
        { op: 'add', path: '/assets/-', value: { assetId: 'cash', label: 'Cash savings', type: 'cash', currentValue: { amount: 38_000, currency: 'EUR' }, liquid: true }, provenance: prov2 },
        // Typed as a liquid investment on purpose: crypto is ALWAYS Legacy, and
        // a "liquid" flag must not route it into spendable reserves.
        { op: 'add', path: '/assets/-', value: { assetId: 'btc', label: 'Bitcoin', type: 'investment', currentValue: { amount: 1_500, currency: 'EUR' }, liquid: true }, provenance: prov2 }
      ]
    },
    { nowIso: NOW_B }
  ).profile;
  const byLabel = Object.fromEntries(
    buildPersonalBalanceSheetInput(built).assetPositions.map((item) => [item.label, item.bucket])
  );
  assert.equal(byLabel['Family home'], 'lifestyle_assets', 'the home they live in is a lifestyle asset');
  assert.equal(byLabel['Investment property'], 'concentrated_assets', 'a rental is Legacy, not Lifestyle');
  assert.equal(byLabel['Aviva buyout bond'], 'retirement_funding');
  assert.equal(byLabel['Cash savings'], 'spendable_reserves');
  assert.equal(byLabel.Bitcoin, 'concentrated_assets', 'crypto is always Legacy, however it is typed');
  // The client's own name for a holding survives onto the page.
  assert.ok(Object.hasOwn(byLabel, 'Family home') && Object.hasOwn(byLabel, 'Aviva buyout bond'),
    'property and pension labels are preserved, not replaced with generic ones');
}

console.info('[ConsumerPersonalBalanceSheet] PASS: deterministic totals, category reconciliation, readiness, number-preserving speech, and no null in a client-facing table.');
