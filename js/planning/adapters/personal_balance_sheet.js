import { computePersonalBalanceSheet } from '../../personal_balance_sheet.js';
import {
  baseCurrency,
  confirmedNone,
  createModuleRunResult,
  crossCurrencyWarnings,
  getAssumption,
  missing,
  moneyAmount,
  monthlyExpenses,
  readinessFromMissing
} from './common.js';

export const PERSONAL_BALANCE_SHEET_ADAPTER_VERSION = '1.1.0';

const BUCKET_LABELS = Object.freeze({
  lifestyle_assets: 'Lifestyle assets',
  spendable_reserves: 'Spendable reserves',
  retirement_funding: 'Long-term retirement funding',
  concentrated_assets: 'Concentrated or optional assets'
});

/**
 * The module formats its own client-facing values.
 *
 * `outputsTable` is what a client reads, and leaving raw numbers in it pushed
 * the decision onto the view, which had to guess from the label's spelling --
 * "spendable reserves" matched a currency heuristic, "gross assets" did not, so
 * two figures on the same card came out in different shapes. The module knows
 * which of its own numbers are money; nothing else should have to infer it.
 */
function money(amount, currency = 'EUR') {
  if (!Number.isFinite(amount)) return null;
  return new Intl.NumberFormat('en-IE', {
    style: 'currency', currency, maximumFractionDigits: 0
  }).format(amount);
}

function months(value) {
  if (!Number.isFinite(value)) return null;
  return `${new Intl.NumberFormat('en-IE', { maximumFractionDigits: 1 }).format(value)} months`;
}

/**
 * Holdings that are Legacy regardless of how they were typed or flagged.
 * Crypto is the case that matters: it is volatile and concentrated whatever a
 * client says about being able to sell it tomorrow, so a "liquid investment"
 * flag must not route it into spendable reserves.
 */
// A TRAILING "S" IS THE SAME HOLDING. Every one of these matched the singular
// only, so a client saying "prize bonds" -- which is how anyone says it -- had
// EUR 12,000 classified as Legacy instead of Liquidity, and their reserves
// understated by that much on the page they were shown.
const ALWAYS_LEGACY = /\b(?:crypto|bitcoin|btc|ethereum|eth|solana|coinbase|binance|kraken|altcoin|nft)s?\b/i;

/**
 * Short-duration holdings that genuinely are reserves.
 * A money market fund is spendable in a way an equity fund is not.
 */
const MONEY_MARKET = /\b(?:money market|deposit account|savings account|term deposit|state savings|prize bond|cash fund)s?\b/i;

/**
 * DIVERSIFIED means one holding that already spreads the risk for you -- an
 * index tracker, a multi-asset or managed fund. Those are long-term retirement
 * funding. A handful of direct shares is not diversified however large it is,
 * so it stays Legacy.
 *
 * Names are matched rather than looked up because this runs in deterministic
 * planning code with no network and must give the same answer every time. A
 * holding whose nature cannot be read from its name falls to Legacy, which is
 * the documented bias, and the meeting can ask about it.
 */
const DIVERSIFIED_FUND = new RegExp([
  '\\betfs?\\b', '\\bindex\\b', '\\btrackers?\\b',
  's&p ?500', '\\bsp ?500\\b', '\\bmsci\\b', '\\bftse\\b',
  'all[- ]?world', 'world equity', 'global equity', 'emerging markets',
  'multi[- ]?asset', 'managed fund', 'balanced fund', 'lifestyle fund',
  '\\bprisma\\b', '\\bvanguard\\b', '\\bishares\\b', '\\bvwce\\b',
  'mutual funds?', 'unit trusts?', 'index funds?'
].join('|'), 'i');

function bucketForAsset(asset) {
  const label = String(asset?.label || '');
  if (ALWAYS_LEGACY.test(label)) return 'concentrated_assets';
  if (asset.type === 'cash') return 'spendable_reserves';
  if (asset.type === 'investment') {
    if (MONEY_MARKET.test(label)) return 'spendable_reserves';
    // A diversified fund is retirement funding; direct shares are not.
    if (DIVERSIFIED_FUND.test(label)) return 'retirement_funding';
    return 'concentrated_assets';
  }
  if (asset.type === 'pension') return 'retirement_funding';
  if (asset.type === 'business' || asset.type === 'agricultural') return 'concentrated_assets';
  if (asset.type === 'property') return 'concentrated_assets';
  // AMBIGUOUS ITEMS GO TO LEGACY, NOT LIFESTYLE. The buckets answer "what job
  // does this money do", and the fallback was answering "personal use" for
  // anything unrecognised -- so crypto, single shares and collectibles were
  // counted alongside the family home. The published contract is explicit:
  // bias ambiguous items toward Legacy unless they are clearly liquid reserves
  // or clearly long-term retirement assets.
  return 'concentrated_assets';
}

function valuedPositions(records, valueKey, currency) {
  return (records || []).filter((record) => moneyAmount(record?.[valueKey], currency) !== null);
}

const SPECIALIST_CATEGORIES = Object.freeze({
  property: {
    genericMatch: (asset) => asset.type === 'property',
    records: (profile) => valuedPositions(profile.properties, 'currentValue', baseCurrency(profile)),
    id: (record) => record.propertyId,
    label: 'property'
  },
  pension: {
    genericMatch: (asset) => asset.type === 'pension',
    records: (profile) => valuedPositions(profile.pensions, 'currentValue', baseCurrency(profile)),
    id: (record) => record.pensionId,
    label: 'pension'
  },
  business: {
    genericMatch: (asset) => ['business', 'agricultural'].includes(asset.type),
    records: (profile) => valuedPositions(profile.businesses, 'estimatedValue', baseCurrency(profile)),
    id: (record) => record.businessId,
    label: 'business'
  }
});

const POSITION_VALUE_RULES = Object.freeze([
  { collectionKey: 'assets', valueKey: 'currentValue', valueLabel: 'current value', fallbackLabel: 'asset' },
  { collectionKey: 'properties', valueKey: 'currentValue', valueLabel: 'current value', fallbackLabel: 'property' },
  { collectionKey: 'pensions', valueKey: 'currentValue', valueLabel: 'current value', fallbackLabel: 'pension' },
  { collectionKey: 'businesses', valueKey: 'estimatedValue', valueLabel: 'estimated value', fallbackLabel: 'business interest' },
  { collectionKey: 'liabilities', valueKey: 'currentBalance', valueLabel: 'current balance', fallbackLabel: 'liability' }
]);

function humanise(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

function positionLabel(record, index, rule) {
  return String(
    record?.label
    || humanise(record?.use)
    || humanise(record?.type)
    || `${humanise(rule.fallbackLabel)} ${index + 1}`
  );
}

function incompletePositionValues(profile, currency) {
  return POSITION_VALUE_RULES.flatMap((rule) => (
    (profile?.[rule.collectionKey] || []).flatMap((record, index) => {
      if (moneyAmount(record?.[rule.valueKey], currency) !== null) return [];
      const suppliedCurrency = typeof record?.[rule.valueKey]?.currency === 'string'
        ? record[rule.valueKey].currency
        : null;
      const label = positionLabel(record, index, rule);
      const reason = suppliedCurrency && suppliedCurrency !== currency
        ? `${label} is recorded in ${suppliedCurrency}. Add a reviewed ${currency} ${rule.valueLabel}; no implicit FX conversion is used.`
        : `Add the ${rule.valueLabel} for ${label} in ${currency}; an existing position cannot be omitted from the balance sheet.`;
      return [{
        fieldPath: `/${rule.collectionKey}/${index}/${rule.valueKey}`,
        reason
      }];
    })
  ));
}

function assertCompletePositionValues(profile, currency) {
  const incomplete = incompletePositionValues(profile, currency);
  if (incomplete.length > 0) {
    throw new Error(`Personal Balance Sheet position values are incomplete: ${incomplete.map((item) => item.fieldPath).join(', ')}.`);
  }
}

function reconciliationDecision(profile, category, recordId) {
  const decisions = getAssumption(
    profile,
    `completionFacts.specialistAssetReconciliation.${category}`,
    {}
  );
  const decision = decisions?.[recordId];
  return ['duplicate', 'distinct'].includes(decision) ? decision : null;
}

function specialistReconciliation(profile) {
  const result = {};
  for (const [category, definition] of Object.entries(SPECIALIST_CATEGORIES)) {
    const hasGeneric = (profile.assets || []).some(definition.genericMatch);
    result[category] = definition.records(profile).map((record) => ({
      record,
      recordId: definition.id(record),
      decision: hasGeneric ? reconciliationDecision(profile, category, definition.id(record)) : 'distinct',
      requiresDecision: hasGeneric
    }));
  }
  return result;
}

function reconciliationWarnings(profile) {
  const warnings = [];
  const reconciliation = specialistReconciliation(profile);
  for (const [category, entries] of Object.entries(reconciliation)) {
    const definition = SPECIALIST_CATEGORIES[category];
    const duplicateCount = entries.filter((entry) => entry.requiresDecision && entry.decision === 'duplicate').length;
    const distinctCount = entries.filter((entry) => entry.requiresDecision && entry.decision === 'distinct').length;
    if (duplicateCount) {
      warnings.push(`${duplicateCount} specialist ${definition.label} ${duplicateCount === 1 ? 'position was' : 'positions were'} excluded after explicit duplicate reconciliation.`);
    }
    if (distinctCount) {
      warnings.push(`${distinctCount} specialist ${definition.label} ${distinctCount === 1 ? 'position was' : 'positions were'} included after explicit distinct-position reconciliation.`);
    }
  }
  return warnings;
}

export function getPersonalBalanceSheetReadiness(profile) {
  const moduleIds = ['personal_balance_sheet'];
  const requiredMissing = [];
  const currency = baseCurrency(profile);
  const assetPositionCount = profile.assets.length
    + profile.properties.length
    + profile.pensions.length
    + profile.businesses.length;
  if (assetPositionCount === 0 && !confirmedNone(profile, '/assets')) {
    requiredMissing.push(missing('/assets', 'Add the household assets and current values, or confirm that there are none.', moduleIds));
  }
  if (profile.liabilities.length === 0 && !confirmedNone(profile, '/liabilities')) {
    requiredMissing.push(missing('/liabilities', 'Add the household debts and current balances, or confirm that there are none.', moduleIds));
  }
  incompletePositionValues(profile, currency).forEach((item) => {
    requiredMissing.push(missing(item.fieldPath, item.reason, moduleIds));
  });
  if (monthlyExpenses(profile) === null) {
    requiredMissing.push(missing(
      '/expenses/monthlyEssential',
      'Add what the household spends in a typical month, so reserves can be expressed as months of cover.',
      moduleIds,
      'assumed'
    ));
  }
  for (const [category, entries] of Object.entries(specialistReconciliation(profile))) {
    const definition = SPECIALIST_CATEGORIES[category];
    entries
      .filter((entry) => entry.requiresDecision && !entry.decision)
      .forEach((entry) => requiredMissing.push(missing(
        `/assumptions/values/completionFacts/specialistAssetReconciliation/${category}/${entry.recordId}`,
        `Review whether specialist ${definition.label} position ${entry.recordId} duplicates a canonical asset or is a distinct position.`,
        moduleIds
      )));
  }
  return readinessFromMissing(requiredMissing, {
    relevant: true,
    warnings: [
      ...crossCurrencyWarnings(profile, [
        ['Assets', profile.assets.map((asset) => asset.currentValue)],
        ['Properties', profile.properties.map((property) => property.currentValue)],
        ['Pensions', profile.pensions.map((pension) => pension.currentValue)],
        ['Businesses', profile.businesses.map((business) => business.estimatedValue)],
        ['Liabilities', profile.liabilities.map((liability) => liability.currentBalance)]
      ]),
      ...reconciliationWarnings(profile)
    ]
  });
}

export function buildPersonalBalanceSheetInput(profile) {
  const currency = baseCurrency(profile);
  // This is a second, fail-closed boundary for direct runtime callers. The
  // orchestrator checks readiness first, but the deterministic input builder
  // must never silently filter an incomplete financial position if reused.
  assertCompletePositionValues(profile, currency);
  const reconciliation = specialistReconciliation(profile);
  const assetPositions = valuedPositions(profile.assets, 'currentValue', currency).map((asset) => ({
    id: asset.assetId,
    label: asset.label,
    bucket: bucketForAsset(asset),
    amount: moneyAmount(asset.currentValue, currency),
    source: 'assets'
  }));

  // Specialist records are included only when there is no overlapping generic
  // category or an explicit record-level review marks that record as distinct.
  // This avoids silently dropping a separate rental, pension or business while
  // still preventing a duplicated home or pension from being counted twice.
  reconciliation.property
    .filter((entry) => entry.decision === 'distinct')
    .forEach(({ record: property }) => assetPositions.push({
      id: property.propertyId,
      // The client's own words for it, when they gave them. "Home" and "rental
      // property" are what the engine invents when nothing better exists.
      label: (typeof property.label === 'string' && property.label.trim())
        || (property.use === 'home' ? 'Home' : `${property.use} property`),
      // ONLY THE HOME THEY LIVE IN IS A LIFESTYLE ASSET. An investment
      // property is Legacy -- illiquid, concentrated, held for a purpose other
      // than daily living. Bucketing a rental as Lifestyle overstated
      // personal-use wealth by its whole value and left Legacy empty.
      // A home and a holiday home are both lifestyle: nice to have, not there to
      // earn. A rental, farm or business property is held for a return.
      bucket: ['home', 'holiday'].includes(property.use) ? 'lifestyle_assets' : 'concentrated_assets',
      amount: moneyAmount(property.currentValue, currency),
      source: 'properties'
    }));
  reconciliation.pension
    .filter((entry) => entry.decision === 'distinct')
    .forEach(({ record: pension }) => assetPositions.push({
      id: pension.pensionId,
      label: (typeof pension.label === 'string' && pension.label.trim())
        || `${pension.type.replaceAll('_', ' ')} pension`,
      bucket: 'retirement_funding',
      amount: moneyAmount(pension.currentValue, currency),
      source: 'pensions'
    }));
  reconciliation.business
    .filter((entry) => entry.decision === 'distinct')
    .forEach(({ record: business }) => assetPositions.push({
      id: business.businessId,
      label: business.label,
      bucket: 'concentrated_assets',
      amount: moneyAmount(business.estimatedValue, currency),
      source: 'businesses'
    }));

  return {
    currency,
    assetPositions,
    liabilityPositions: valuedPositions(profile.liabilities, 'currentBalance', currency).map((liability) => ({
      id: liability.liabilityId,
      label: liability.label,
      amount: moneyAmount(liability.currentBalance, currency),
      source: 'liabilities'
    })),
    monthlyExpenditure: monthlyExpenses(profile),
    reconciliationWarnings: reconciliationWarnings(profile),
    currencyWarnings: crossCurrencyWarnings(profile, [
      ['Assets', profile.assets.map((asset) => asset.currentValue)],
      ['Properties', profile.properties.map((property) => property.currentValue)],
      ['Pensions', profile.pensions.map((pension) => pension.currentValue)],
      ['Businesses', profile.businesses.map((business) => business.estimatedValue)],
      ['Liabilities', profile.liabilities.map((liability) => liability.currentBalance)]
    ])
  };
}

export async function runPersonalBalanceSheet(input, context) {
  const balanceSheet = computePersonalBalanceSheet(input);
  const bucketRows = Object.entries(balanceSheet.buckets).map(([bucket, detail]) => [BUCKET_LABELS[bucket], detail.total]);
  const projection = {
    assumptionsTable: {
      columns: ['Accounting policy', 'Treatment'],
      rows: [
        ['Currency', input.currency],
        ['Reconciliation', 'Overlapping specialist records require an explicit duplicate-or-distinct decision before calculation.'],
        ['Unknown values', 'Excluded rather than estimated']
      ]
    },
    outputsTable: {
      columns: ['Metric', 'Value'],
      // A metric we could not calculate is LEFT OUT, never shown as a blank.
      // reserveMonths is null whenever monthly spending is unknown, and it was
      // reaching a client-facing table as the literal word "null" -- an
      // agent-driven call as a Cork nurse ended with "Reserve months: null" in
      // her balance sheet. This is the module's own stated accounting policy
      // two rows above: unknown values are excluded rather than estimated.
      // A metric we could not calculate is LEFT OUT, never shown as a blank.
      // reserveMonths is null whenever monthly spending is unknown, and it
      // reached a client-facing table as the literal word "null". This is the
      // module's own accounting policy two rows above: unknown values are
      // excluded rather than estimated.
      rows: [
        ['Gross assets', money(balanceSheet.grossAssets)],
        ['Total liabilities', money(balanceSheet.totalLiabilities)],
        ['Net worth', money(balanceSheet.netWorth)],
        ['Spendable reserves', money(balanceSheet.spendableReserves)],
        ['Reserve months', months(balanceSheet.reserveMonths)]
      ].filter(([, value]) => value !== null && value !== undefined).filter(([, value]) => value !== null && value !== undefined)
    },
    tables: [{
      id: 'personal-balance-sheet-buckets',
      title: 'Assets by purpose',
      columns: ['Purpose', input.currency],
      rows: bucketRows
    }, {
      id: 'personal-balance-sheet-liabilities',
      title: 'Liabilities',
      columns: ['Liability', input.currency],
      rows: balanceSheet.liabilities.map((liability) => [liability.label, liability.amount])
    }],
    charts: [{
      id: 'personal-balance-sheet-purpose',
      title: 'Assets by purpose',
      type: 'doughnut',
      labels: bucketRows.map(([label]) => label),
      datasets: [{ label: input.currency, data: bucketRows.map(([, amount]) => amount) }]
    }]
  };
  return createModuleRunResult({
    moduleId: 'personal_balance_sheet',
    moduleVersion: context.moduleVersion,
    input,
    context,
    projection,
    semanticResult: {
      currency: input.currency,
      grossAssets: balanceSheet.grossAssets,
      totalLiabilities: balanceSheet.totalLiabilities,
      netWorth: balanceSheet.netWorth,
      spendableReserves: balanceSheet.spendableReserves,
      reserveMonths: balanceSheet.reserveMonths,
      reconciliationDifference: balanceSheet.reconciliationDifference,
      bucketTotals: Object.fromEntries(Object.entries(balanceSheet.buckets).map(([bucket, detail]) => [bucket, detail.total]))
    },
    warnings: [...input.currencyWarnings, ...input.reconciliationWarnings]
  });
}
