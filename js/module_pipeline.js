/**
 * THE PAYLOAD PIPELINE, LIFTED OUT OF THE BROWSER.
 *
 * Everything between a pasted payload and a module that renders: the auto
 * repairs, the contract validation, the merge into a module's generated block,
 * and the engine run that proves the figures can actually be produced. It used
 * to live in `app.js`, reachable only by clicking a button, which meant the
 * only way to find out whether a payload worked was to paste it and see.
 *
 * It is here so there is ONE implementation with two callers: the Dev Panel,
 * and `scripts/check-case-pack.mjs` running in Node. A pack the check passes
 * cannot fail in the browser, because the browser runs this file.
 *
 * NOTHING IN HERE MAY TOUCH THE DOM, `window` OR THE APP'S STATE. The three
 * places that genuinely need the running app -- recording a projection,
 * reading which mortgage case the user has selected, and clearing an open
 * assumptions editor -- go through the host below, which the app binds once and
 * the check leaves inert.
 */

import {
  computeCollegeFundingProjection,
  normalizeCollegeFundingInputs
} from './college_funding_math.js';
import {
  computeHousePurchaseProjection,
  normalizeHousePurchaseInputs
} from './house_purchase/engine.js';
import {
  computeMortgageProjection,
  normalizeMortgageInputs
} from './mortgage_math.js';
import {
  computeNetRetirementProjection,
  normalizeNetRetirementInputs
} from './net_retirement_math.js';
import {
  validateOutputsBucketedPayload
} from './outputs_bucketed_contract.js';
import {
  computePensionProjection,
  normalizePensionInputs
} from './pension_math.js';
import {
  validateReportPayload
} from './report.js';
import {
  computeLiquidityReserve,
  resolveLiquidityReservePolicy
} from './liquidity_reserve.js';
import {
  createEmptyGenerated,
  normalizeGenerated,
  normalizeLiquidityPlan,
  normalizePbsInputs
} from './state.js';

/**
 * The running app, as far as this file is concerned.
 *
 * Inert by default: with nothing bound, the pipeline still normalises,
 * validates and runs every engine, which is exactly what a check wants and
 * exactly what a preflight against a scratch module wants.
 */
const host = {
  recordProjection: () => {},
  resolveMortgageScenarioId: () => '',
  resetAssumptionsEditorState: () => {}
};

/** Called once by the app at start-up. The Node check never calls it. */
export function bindModulePipelineHost(next) {
  Object.assign(host, next);
}

export const TABLE_HIGHLIGHT_KINDS = Object.freeze(['assumptions', 'outputs']);

export function nowIso() {
  return new Date().toISOString();
}

function makeModuleId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `module-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toSlug(value, fallback) {
  const clean = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return clean || fallback;
}

function makeChartId(moduleId, chartTitle, index) {
  return `${moduleId}-${toSlug(chartTitle, `chart-${index + 1}`)}-${index + 1}`;
}

export function createBlankModule() {
  const timestamp = nowIso();
  return {
    id: makeModuleId(),
    createdAt: timestamp,
    updatedAt: timestamp,
    title: '',
    notes: '',
    generated: createEmptyGenerated(),
    media: {
      images: []
    },
    ui: {
      tableHighlights: {
        assumptions: {
          selected: [],
          anchor: null
        },
        outputs: {
          selected: [],
          anchor: null
        }
      },
      hiddenCardIds: [],
      housePurchaseEditor: null
    }
  };
}

export function ensureGenerated(module) {
  if (!module.generated || typeof module.generated !== 'object') {
    module.generated = createEmptyGenerated();
  }

  module.generated = normalizeGenerated(module.generated);
  ensureModuleUi(module);
  if (module.generated.housePurchaseInputs) {
    try {
      applyHousePurchaseProjectionToModule(module);
    } catch (error) {
      console.warn('[CallCanvas] house purchase projection could not be refreshed', error);
    }
  }
}

function createEmptyTableHighlightState() {
  return {
    selected: [],
    anchor: null
  };
}

export function normalizeTableHighlightAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
    return null;
  }

  const key = typeof anchor.key === 'string' ? anchor.key.trim() : '';
  const rowIndex = Number(anchor.rowIndex);
  const colIndex = Number(anchor.colIndex);
  if (!key || !Number.isInteger(rowIndex) || !Number.isInteger(colIndex)) {
    return null;
  }

  return {
    key,
    rowIndex,
    colIndex
  };
}

export function ensureModuleUi(module) {
  if (!module || typeof module !== 'object') {
    return null;
  }

  if (!module.ui || typeof module.ui !== 'object' || Array.isArray(module.ui)) {
    module.ui = {};
  }

  if (!module.ui.tableHighlights || typeof module.ui.tableHighlights !== 'object' || Array.isArray(module.ui.tableHighlights)) {
    module.ui.tableHighlights = {};
  }

  TABLE_HIGHLIGHT_KINDS.forEach((tableKind) => {
    const current = module.ui.tableHighlights[tableKind];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      module.ui.tableHighlights[tableKind] = createEmptyTableHighlightState();
      return;
    }

    const selected = Array.isArray(current.selected)
      ? [...new Set(current.selected
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean))]
      : [];
    module.ui.tableHighlights[tableKind] = {
      selected,
      anchor: normalizeTableHighlightAnchor(current.anchor)
    };
  });

  if (!Array.isArray(module.ui.hiddenCardIds)) {
    module.ui.hiddenCardIds = [];
  } else {
    module.ui.hiddenCardIds = [...new Set(module.ui.hiddenCardIds
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean))];
  }

  if (!Array.isArray(module.ui.cardOrder)) {
    module.ui.cardOrder = [];
  } else {
    module.ui.cardOrder = [...new Set(module.ui.cardOrder
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean))];
  }

  if (typeof module.ui.pbsScenarioId !== 'string') {
    module.ui.pbsScenarioId = '';
  } else {
    module.ui.pbsScenarioId = module.ui.pbsScenarioId.trim();
  }

  if (!module.ui.housePurchaseEditor || typeof module.ui.housePurchaseEditor !== 'object' || Array.isArray(module.ui.housePurchaseEditor)) {
    module.ui.housePurchaseEditor = null;
  } else {
    const editor = module.ui.housePurchaseEditor;
    module.ui.housePurchaseEditor = {
      active: editor.active === true,
      stepIndex: Number.isInteger(Number(editor.stepIndex))
        ? Math.min(8, Math.max(0, Number(editor.stepIndex)))
        : 0,
      draft: editor.draft && typeof editor.draft === 'object' && !Array.isArray(editor.draft)
        ? editor.draft
        : null
    };
  }

  return module.ui;
}

export function getLoanEngineInputs(module) {
  return module?.generated?.loanInputs || module?.generated?.mortgageInputs || null;
}

export function getLoanEngineSource(module) {
  if (module?.generated?.loanInputs) {
    return 'loanInputs';
  }
  if (module?.generated?.mortgageInputs) {
    return 'mortgageInputs';
  }
  return 'mortgageInputs';
}

export function getDefaultLoanKindForSource(source, loanEngineInputs = null) {
  if (loanEngineInputs?.loanKind === 'loan') {
    return 'loan';
  }
  if (loanEngineInputs?.loanKind === 'mortgage') {
    return 'mortgage';
  }
  return source === 'loanInputs' ? 'loan' : 'mortgage';
}

export function setLoanEngineInputs(module, normalizedInputs, { source = null } = {}) {
  const targetSource = source || getLoanEngineSource(module);
  if (targetSource === 'loanInputs') {
    module.generated.loanInputs = normalizedInputs;
    module.generated.mortgageInputs = null;
    return 'loanInputs';
  }

  module.generated.mortgageInputs = normalizedInputs;
  module.generated.loanInputs = null;
  return 'mortgageInputs';
}

export function applyPensionProjectionToModule(module, { updateSummary = true } = {}) {
  const projection = computePensionProjection(module.generated.pensionInputs);
  const currentScenario = projection.debug?.currentScenario || {
    contribEurSeries: [],
    growthEurSeries: []
  };

  module.generated.assumptions = projection.assumptionsTable;
  module.generated.outputs = projection.outputsTable;
  module.generated.outputsBucketed = null;
  module.generated.charts = projection.charts.map((chart, index) => ({
    ...chart,
    id: chart.id || makeChartId(module.id, chart.title, index)
  }));

  if (updateSummary) {
    module.generated.summaryHtml = injectAutoPensionSummarySentences(
      module.generated.summaryHtml,
      {
        readinessSentence: projection.debug.readinessSentence,
        sftSentence: projection.debug.sftSentence,
        personalCapSentence: projection.debug.currentPersonalCapSentence
      }
    );
  }

  console.info('[CallCanvas] pension projection computed', {
    inputs: projection.debug.inputs,
    projectedPotCurrent: projection.debug.projectedPotCurrent,
    projectedPotMaxPersonal: projection.debug.projectedPotMaxPersonal,
    requiredPot: projection.debug.requiredPot,
    retirementYear: projection.debug.retirementYear,
    sftValue: projection.debug.sftValue,
    sftYearUsed: projection.debug.sftYearUsed,
    heldConstantBeyond2029: projection.debug.sftHeldConstantBeyond2029,
    breaches: projection.debug.sftBreaches
  });
  console.info('[pension] chart1 dataset labels', projection.charts[0].datasets.map((dataset) => dataset.label));
  console.info(
    '[pension] contrib sample',
    currentScenario.contribEurSeries.slice(0, 3),
    currentScenario.growthEurSeries.slice(0, 3)
  );

  if (Array.isArray(projection.debug.maxSeriesMonotonicIssues) && projection.debug.maxSeriesMonotonicIssues.length > 0) {
    console.warn('[CallCanvas] max personal series is not monotonic non-decreasing', {
      issues: projection.debug.maxSeriesMonotonicIssues
    });
  }

  host.recordProjection(module.id, {
    calculator: 'pension',
    inputs: { ...module.generated.pensionInputs },
    debug: projection.debug
  });

  return projection;
}

function applyCollegeFundingProjectionToModule(module) {
  const projection = computeCollegeFundingProjection(module.generated.collegeFundingInputs);

  module.generated.assumptions = projection.assumptionsTable;
  module.generated.outputs = projection.outputsTable;
  module.generated.outputsBucketed = null;
  module.generated.tables = projection.tables;
  module.generated.charts = projection.charts.map((chart, index) => ({
    ...chart,
    id: chart.id || makeChartId(module.id, chart.title, index)
  }));

  console.info('[CallCanvas] college funding projection computed', {
    inputs: projection.debug.inputs,
    yearsUntilCollege: projection.debug.yearsUntilCollege,
    todayRange: projection.debug.todayRange,
    nominalRange: projection.debug.nominalRange,
    stressScenario: projection.debug.stressScenario?.title
  });

  host.recordProjection(module.id, {
    calculator: 'collegeFunding',
    inputs: { ...module.generated.collegeFundingInputs },
    debug: projection.debug
  });

  return projection;
}

export function applyHousePurchaseProjectionToModule(module) {
  const projection = computeHousePurchaseProjection(module.generated.housePurchaseInputs);

  module.generated.assumptions = projection.assumptionsTable;
  module.generated.outputs = projection.outputsTable;
  module.generated.outputsBucketed = null;
  module.generated.tables = projection.tables;
  module.generated.charts = projection.charts.map((chart, index) => ({
    ...chart,
    id: chart.id || makeChartId(module.id, chart.title, index)
  }));

  host.recordProjection(module.id, {
    calculator: 'housePurchase',
    inputs: cloneSessionValue(module.generated.housePurchaseInputs),
    result: projection.result,
    debug: projection.debug
  });

  return projection;
}

export function applyNetRetirementProjectionToModule(module) {
  const projection = computeNetRetirementProjection(module.generated.netRetirementInputs);

  module.generated.assumptions = projection.assumptionsTable;
  module.generated.outputs = projection.outputsTable;
  module.generated.outputsBucketed = null;
  module.generated.tables = projection.tables;
  module.generated.charts = projection.charts.map((chart, index) => ({
    ...chart,
    id: chart.id || makeChartId(module.id, chart.title, index)
  }));

  console.info('[CallCanvas] net retirement projection computed', {
    inputs: projection.debug.inputs,
    scenarioId: projection.debug.scenarioId,
    firstYearShortfall: projection.debug.firstYearShortfall,
    requiredFundToday: projection.debug.requiredFundToday,
    surplusVsRequired: projection.debug.surplusVsRequired
  });

  host.recordProjection(module.id, {
    calculator: 'netRetirement',
    inputs: { ...module.generated.netRetirementInputs },
    debug: projection.debug
  });

  return projection;
}

export function applyMortgageProjectionToModule(module, { updateSummary = true } = {}) {
  const loanEngineInputs = getLoanEngineInputs(module);
  if (!loanEngineInputs) {
    throw new Error('Loan inputs are unavailable for this module.');
  }
  const source = getLoanEngineSource(module);
  const defaultLoanKind = getDefaultLoanKindForSource(source, loanEngineInputs);
  const normalizedInputs = normalizeMortgageInputs(loanEngineInputs, { defaultLoanKind });
  const resolvedSource = setLoanEngineInputs(module, normalizedInputs, { source });
  // The inputs are stored before the case is resolved, because resolving a
  // case reads the module's own case list back out of them.
  const scenarioId = host.resolveMortgageScenarioId(module.id);
  const projection = computeMortgageProjection(normalizedInputs, { defaultLoanKind, scenarioId });

  module.generated.assumptions = projection.assumptionsTable;
  module.generated.outputs = projection.outputsTable;
  module.generated.outputsBucketed = null;
  module.generated.charts = projection.charts.map((chart, index) => ({
    ...chart,
    id: chart.id || makeChartId(module.id, chart.title, index)
  }));

  if (updateSummary) {
    module.generated.summaryHtml = projection.summaryHtml;
  }

  console.info('[CallCanvas] mortgage projection computed', {
    loanSource: resolvedSource,
    inputs: normalizedInputs,
    monthsPlanned: projection.debug?.monthsPlanned,
    monthsSimulated: projection.debug?.monthsSimulated,
    monthlyPayment: projection.debug?.paymentUsedMonthly,
    payoffYear: projection.debug?.payoffYear,
    totalInterestLifetime: projection.debug?.totalInterestLifetime,
    totalPaidLifetime: projection.debug?.totalPaidLifetime,
    scenarioId: projection.debug?.scenarioId,
    interestSaved: projection.debug?.interestSaved
  });

  host.recordProjection(module.id, {
    calculator: 'mortgage',
    inputs: { ...normalizedInputs },
    debug: projection.debug
  });

  return projection;
}

function toGenericTableRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map((row) => {
    if (!Array.isArray(row)) {
      return [];
    }

    return row.map((value) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      return String(value ?? '');
    });
  });
}

function isPlainPayloadObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasGeneratedTableShape(value) {
  return isPlainPayloadObject(value) && Array.isArray(value.columns) && Array.isArray(value.rows);
}

function hasLabelValueItemShape(value) {
  return isPlainPayloadObject(value)
    && (
      'label' in value
      || 'title' in value
      || 'name' in value
      || 'value' in value
      || 'detail' in value
      || 'body' in value
    );
}

function normalizeLabelValueItem(item, index) {
  const label = String(item.label || item.title || item.name || `Assumption ${index + 1}`).trim();
  const value = 'value' in item
    ? item.value
    : ('detail' in item ? item.detail : item.body);
  return [
    label || `Assumption ${index + 1}`,
    formatGeneratedObjectValue(value)
  ];
}

function formatGeneratedObjectValue(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function humanizePayloadKey(key) {
  const value = String(key ?? '').trim();
  if (!value) {
    return 'Assumption';
  }

  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parsePayloadNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/[,$€£\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    const leadingNumber = normalized.match(/^-?\d+(\.\d+)?/);
    if (!leadingNumber) {
      return null;
    }

    const leadingParsed = Number(leadingNumber[0]);
    return Number.isFinite(leadingParsed) ? leadingParsed : null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function getFirstPayloadNumber(source, keys) {
  if (!isPlainPayloadObject(source)) {
    return null;
  }

  for (const key of keys) {
    if (key in source) {
      const parsed = parsePayloadNumber(source[key]);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return null;
}

function normalizePayloadToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findPayloadAmountColumnIndex(columns, rows = []) {
  const preferredTokens = new Set([
    'amount',
    'assetvalue',
    'balance',
    'currentbalance',
    'netvalue',
    'value'
  ]);
  const exactIndex = columns.findIndex((column) => preferredTokens.has(normalizePayloadToken(column)));
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const likelyIndex = columns.findIndex((column) => {
    const token = normalizePayloadToken(column);
    return token.includes('amount') || token.includes('balance') || token.includes('value');
  });
  if (likelyIndex >= 0) {
    return likelyIndex;
  }

  const maxColumns = columns.length;
  for (let columnIndex = 1; columnIndex < maxColumns; columnIndex += 1) {
    const hasNumericValue = rows.some((row) => Array.isArray(row) && parsePayloadNumber(row[columnIndex]) !== null);
    if (hasNumericValue) {
      return columnIndex;
    }
  }

  return -1;
}

function repairOutputBucketedSectionColumns(section, columns, rows, sectionTitle, warnings) {
  if (columns.length === 2) {
    return null;
  }

  const amountColumnIndex = findPayloadAmountColumnIndex(columns, rows);
  if (amountColumnIndex < 0) {
    return null;
  }

  const labelColumnIndex = amountColumnIndex === 0 ? 1 : 0;
  const ownerColumnIndex = columns.findIndex((column, columnIndex) => (
    columnIndex !== labelColumnIndex
    && columnIndex !== amountColumnIndex
    && normalizePayloadToken(column) === 'owner'
  ));
  const labelColumn = columns[labelColumnIndex] || 'Item';
  const amountColumn = columns[amountColumnIndex] || 'Amount';
  const repairedRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => Array.isArray(row) && row.length > Math.max(labelColumnIndex, amountColumnIndex))
    .map((row) => {
      let label = String(row[labelColumnIndex] ?? '').trim();
      const owner = ownerColumnIndex >= 0 ? String(row[ownerColumnIndex] ?? '').trim() : '';
      if (owner && normalizePayloadToken(owner) !== 'household' && !normalizePayloadToken(label).includes(normalizePayloadToken(owner))) {
        label = `${owner} ${label}`.trim();
      }
      const value = parsePayloadNumber(row[amountColumnIndex]);
      if (value === null) {
        warnings.push(`Normalized non-numeric value to 0 in outputsBucketed section '${sectionTitle}'.`);
        return [label, 0];
      }
      return [label, value];
    });

  warnings.push(`Reduced outputsBucketed section '${sectionTitle}' to 2 columns using '${amountColumn}' as the amount column.`);

  return {
    columns: [labelColumn, amountColumn],
    rows: repairedRows
  };
}

function inferCurrencySymbol(value) {
  const rawValue = String(value ?? '').trim();
  const upperValue = rawValue.toUpperCase();

  if (!upperValue) {
    return '€';
  }

  if (rawValue === '$' || upperValue === 'USD') {
    return '$';
  }

  if (rawValue === '€' || upperValue === 'EUR') {
    return '€';
  }

  if (rawValue === '£' || upperValue === 'GBP') {
    return '£';
  }

  return rawValue;
}

function extractPbsItemRows(items, fallbackPrefix) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => {
      if (!isPlainPayloadObject(item)) {
        return null;
      }

      const label = String(item.name || item.label || item.title || `${fallbackPrefix} ${index + 1}`).trim();
      const value = getFirstPayloadNumber(item, ['value', 'amount', 'balance', 'currentBalance']);

      if (!label || value === null) {
        return null;
      }

      return [label, value];
    })
    .filter(Boolean);
}

function findPbsProjectBucket(buckets, bucketKey) {
  const targetToken = normalizePayloadToken(bucketKey);
  return buckets.find((bucket) => (
    isPlainPayloadObject(bucket)
    && (
      normalizePayloadToken(bucket.key) === targetToken
      || normalizePayloadToken(bucket.name) === targetToken
      || normalizePayloadToken(bucket.title) === targetToken
    )
  )) || null;
}

function buildOutputsBucketedFromProjectPbs(generated, sourceAssumptions = null) {
  if (!Array.isArray(generated?.buckets)) {
    return null;
  }

  const assumptions = isPlainPayloadObject(sourceAssumptions) && !hasGeneratedTableShape(sourceAssumptions)
    ? sourceAssumptions
    : {};
  const metrics = isPlainPayloadObject(generated.metrics) ? generated.metrics : {};
  const currencySymbol = inferCurrencySymbol(assumptions.currency || generated.currencySymbol || generated.currency);
  const amountColumn = `Amount (${currencySymbol})`;
  const assetBucketMeta = [
    { key: 'lifestyle', title: 'Lifestyle', subtotalLabel: 'Lifestyle assets' },
    { key: 'liquidity', title: 'Liquidity', subtotalLabel: 'Liquid reserves' },
    { key: 'longevity', title: 'Longevity', subtotalLabel: 'Longevity assets' },
    { key: 'legacy', title: 'Legacy', subtotalLabel: 'Legacy assets' }
  ];

  const assetSections = assetBucketMeta.map((meta) => {
    const bucket = findPbsProjectBucket(generated.buckets, meta.key);
    const rows = extractPbsItemRows(bucket?.assets, 'Asset');
    const subtotalValue = getFirstPayloadNumber(bucket, ['grossValue', 'assetValue', 'netValue'])
      ?? rows.reduce((total, row) => total + row[1], 0);

    return {
      key: meta.key,
      title: meta.title,
      columns: ['Asset', amountColumn],
      rows,
      subtotalLabel: meta.subtotalLabel,
      subtotalValue,
      notes: typeof bucket?.description === 'string' ? bucket.description : ''
    };
  });

  const bucketLiabilityRows = generated.buckets.flatMap((bucket) => extractPbsItemRows(bucket?.liabilities, 'Liability'));
  const payloadLiabilityRows = extractPbsItemRows(generated.liabilities, 'Liability');
  const liabilityRows = bucketLiabilityRows.length > 0 ? bucketLiabilityRows : payloadLiabilityRows;
  const totalLiabilities = getFirstPayloadNumber(metrics, ['totalLiabilities', 'liabilities'])
    ?? liabilityRows.reduce((total, row) => total + row[1], 0);
  const grossAssets = getFirstPayloadNumber(metrics, ['grossAssets', 'totalAssets'])
    ?? assetSections.reduce((total, section) => total + section.subtotalValue, 0);
  const netWorth = getFirstPayloadNumber(metrics, ['netWorth'])
    ?? (grossAssets - totalLiabilities);

  return {
    currencySymbol,
    sections: [
      ...assetSections,
      {
        key: 'liabilities',
        title: 'Liabilities',
        columns: ['Liability', amountColumn],
        rows: liabilityRows,
        subtotalLabel: 'Total liabilities',
        subtotalValue: totalLiabilities
      },
      {
        key: 'summary',
        title: 'Summary',
        columns: ['Metric', amountColumn],
        rows: [
          ['Gross assets', grossAssets],
          ['Total liabilities', totalLiabilities],
          ['Net worth', netWorth]
        ],
        subtotalLabel: 'Net worth',
        subtotalValue: netWorth
      }
    ]
  };
}

function looksLikePbsProjectPayload(payload, generated) {
  const moduleToken = normalizePayloadToken(payload.module || payload.moduleType || payload.type);
  const titleToken = normalizePayloadToken(payload.title);

  return moduleToken === 'pbs'
    || titleToken.includes('personalbalancesheet')
    || Array.isArray(generated?.buckets)
    || isPlainPayloadObject(generated?.metrics);
}

function repairChartMetadataPayload(generated, warnings) {
  if (!Array.isArray(generated?.charts)) {
    return;
  }

  generated.charts.forEach((chart, chartIndex) => {
    if (!isPlainPayloadObject(chart)) {
      return;
    }

    if (Array.isArray(chart.insights)) {
      let repairedInsights = false;
      chart.insights = chart.insights
        .map((insight, insightIndex) => {
          if (isPlainPayloadObject(insight)) {
            return insight;
          }

          if (typeof insight === 'string' && insight.trim()) {
            repairedInsights = true;
            return {
              label: `Insight ${insightIndex + 1}`,
              detail: insight.trim()
            };
          }

          repairedInsights = true;
          return null;
        })
        .filter(Boolean);

      if (repairedInsights) {
        warnings.push(`Converted Chart ${chartIndex + 1}.insights entries into insight objects.`);
      }
    }

    if (Array.isArray(chart.annotations)) {
      let repairedAnnotations = false;
      chart.annotations = chart.annotations
        .map((annotation, annotationIndex) => {
          if (isPlainPayloadObject(annotation)) {
            return annotation;
          }

          if (typeof annotation === 'string' && annotation.trim()) {
            repairedAnnotations = true;
            return {
              label: `Annotation ${annotationIndex + 1}`,
              body: annotation.trim()
            };
          }

          repairedAnnotations = true;
          return null;
        })
        .filter(Boolean);

      if (repairedAnnotations) {
        warnings.push(`Converted Chart ${chartIndex + 1}.annotations entries into annotation objects.`);
      }
    }
  });
}

function getPayloadTableRows(table) {
  return Array.isArray(table?.rows) ? table.rows.filter((row) => Array.isArray(row)) : [];
}

function findPayloadTableValue(table, labelPatterns) {
  const patterns = labelPatterns.map((pattern) => (
    pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i')
  ));
  const row = getPayloadTableRows(table).find((candidate) => {
    const label = String(candidate[0] ?? '');
    return patterns.some((pattern) => pattern.test(label));
  });
  return row ? row[1] : undefined;
}

function parsePayloadPercent(value) {
  const parsed = parsePayloadNumber(value);
  if (parsed === null) {
    return null;
  }
  return parsed > 1 ? parsed / 100 : parsed;
}

function looksLikeCollegeFundingPayload(payload, generated) {
  const moduleToken = normalizePayloadToken(payload.module || payload.moduleType || payload.type);
  const titleToken = normalizePayloadToken(payload.title);
  const outputColumns = Array.isArray(generated?.outputs?.columns)
    ? generated.outputs.columns.map((column) => normalizePayloadToken(column)).join(' ')
    : '';

  return moduleToken === 'collegefunding'
    || moduleToken === 'educationfunding'
    || titleToken.includes('collegefunding')
    || titleToken.includes('educationfunding')
    || (
      outputColumns.includes('scenario')
      && outputColumns.includes('todaysterms')
      && outputColumns.includes('futurenominalcost')
    );
}

function buildCollegeFundingInputsFromLegacyTables(payload, generated) {
  if (!looksLikeCollegeFundingPayload(payload, generated)) {
    return null;
  }

  const assumptions = generated.assumptions;
  const childrenCount = parsePayloadNumber(findPayloadTableValue(assumptions, [/number of children/i]));
  const childCurrentAge = parsePayloadNumber(findPayloadTableValue(assumptions, [/children.*current age/i, /child.*current age/i]));
  const collegeStartAge = parsePayloadNumber(findPayloadTableValue(assumptions, [/college start age/i]));
  const collegeDurationYears = parsePayloadNumber(findPayloadTableValue(assumptions, [/college duration/i]));
  const inflationRate = parsePayloadPercent(findPayloadTableValue(assumptions, [/inflation/i]));
  const atHomeAnnual = parsePayloadNumber(findPayloadTableValue(assumptions, [/at.home.*college support/i, /living at home/i]));
  const awayAnnual = parsePayloadNumber(findPayloadTableValue(assumptions, [/away.*from.*home.*college support/i, /away from home/i]));
  const carSupport = parsePayloadNumber(findPayloadTableValue(assumptions, [/optional car support/i, /car support/i]));

  if (childrenCount === null && atHomeAnnual === null && awayAnnual === null) {
    return null;
  }

  const normalized = {};
  if (childrenCount !== null) normalized.childrenCount = childrenCount;
  if (childCurrentAge !== null) normalized.childCurrentAge = childCurrentAge;
  if (collegeStartAge !== null) normalized.collegeStartAge = collegeStartAge;
  if (collegeDurationYears !== null) normalized.collegeDurationYears = collegeDurationYears;
  if (inflationRate !== null) normalized.inflationRate = inflationRate;
  if (atHomeAnnual !== null) normalized.atHomeAnnualCostTodayPerChild = atHomeAnnual;
  if (awayAnnual !== null) normalized.awayAnnualCostTodayPerChild = awayAnnual;
  if (carSupport !== null) normalized.carSupportTodayPerChild = carSupport;
  normalized.planningNote = 'Education costs are modelled separately from normal household spending.';

  return normalized;
}

export function normalizeDevPanelPayload(payload) {
  const warnings = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload, warnings };
  }

  const generated = payload.generated;
  if (!generated || typeof generated !== 'object' || Array.isArray(generated)) {
    return { payload, warnings };
  }

  const rawGeneratedAssumptions = generated.assumptions;

  if (typeof generated.summary === 'string' && generated.summary.trim() && typeof generated.summaryHtml !== 'string') {
    generated.summaryHtml = `<p>${escapeHtmlText(generated.summary.trim())}</p>`;
    warnings.push('Moved generated.summary into generated.summaryHtml.');
  }

  if ('assumptions' in generated && !hasGeneratedTableShape(generated.assumptions)) {
    if (isPlainPayloadObject(generated.assumptions)) {
      generated.assumptions = {
        columns: ['Assumption', 'Value'],
        rows: Object.entries(generated.assumptions).map(([key, value]) => [
          humanizePayloadKey(key),
          formatGeneratedObjectValue(value)
        ])
      };
      warnings.push('Converted generated.assumptions object into a two-column table.');
    } else if (Array.isArray(generated.assumptions) && generated.assumptions.every(hasLabelValueItemShape)) {
      generated.assumptions = {
        columns: ['Assumption', 'Value'],
        rows: generated.assumptions.map((item, index) => normalizeLabelValueItem(item, index))
      };
      warnings.push('Converted generated.assumptions label/value list into a two-column table.');
    } else if (generated.assumptions == null) {
      delete generated.assumptions;
      warnings.push('Removed empty generated.assumptions.');
    }
  }

  if (looksLikePbsProjectPayload(payload, generated)) {
    const sourceAssumptions = isPlainPayloadObject(rawGeneratedAssumptions) && !hasGeneratedTableShape(rawGeneratedAssumptions)
      ? rawGeneratedAssumptions
      : {};
    const pbsInputSource = {
      annualExpenditure: getFirstPayloadNumber(sourceAssumptions, ['annualExpenditure'])
        ?? getFirstPayloadNumber(generated.metrics, ['annualExpenditure']),
      currentAge: getFirstPayloadNumber(sourceAssumptions, ['currentAge', 'clientAge'])
        ?? getFirstPayloadNumber(generated.metrics, ['currentAge', 'clientAge'])
    };
    const normalizedPbsInputs = normalizePbsInputs(pbsInputSource);

    if (normalizedPbsInputs && !generated.pbsInputs) {
      generated.pbsInputs = normalizedPbsInputs;
      warnings.push('Created generated.pbsInputs from PBS assumptions.');
    }

    if (!isPlainPayloadObject(generated.outputsBucketed)) {
      const repairedOutputsBucketed = buildOutputsBucketedFromProjectPbs(generated, rawGeneratedAssumptions);
      if (repairedOutputsBucketed) {
        generated.outputsBucketed = repairedOutputsBucketed;
        warnings.push('Created generated.outputsBucketed from PBS buckets and metrics.');
      }
    }
  }

  if (!generated.collegeFundingInputs && !generated.collegeFunding) {
    const repairedCollegeFundingInputs = buildCollegeFundingInputsFromLegacyTables(payload, generated);
    if (repairedCollegeFundingInputs) {
      generated.collegeFundingInputs = repairedCollegeFundingInputs;
      warnings.push('Created generated.collegeFundingInputs from college funding tables.');
    }
  }

  repairChartMetadataPayload(generated, warnings);

  const outputsBucketed = generated.outputsBucketed;
  if (!outputsBucketed || typeof outputsBucketed !== 'object' || Array.isArray(outputsBucketed)) {
    return { payload, warnings };
  }

  if (typeof outputsBucketed.currencySymbol !== 'string' || !outputsBucketed.currencySymbol.trim()) {
    outputsBucketed.currencySymbol = '€';
    warnings.push('Filled missing generated.outputsBucketed.currencySymbol with "€".');
  } else {
    const normalizedCurrencySymbol = inferCurrencySymbol(outputsBucketed.currencySymbol);
    if (normalizedCurrencySymbol !== outputsBucketed.currencySymbol) {
      outputsBucketed.currencySymbol = normalizedCurrencySymbol;
      warnings.push(`Normalized generated.outputsBucketed.currencySymbol to "${normalizedCurrencySymbol}".`);
    }
  }

  if (!Array.isArray(outputsBucketed.sections)) {
    outputsBucketed.sections = [];
    warnings.push('Filled missing generated.outputsBucketed.sections with an empty array.');
  }

  if (!Array.isArray(generated.tables)) {
    generated.tables = [];
  }

  const nextSections = [];

  outputsBucketed.sections.forEach((rawSection, sectionIndex) => {
    if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) {
      warnings.push(`Dropped outputsBucketed section at index ${sectionIndex} because it is not a valid object.`);
      return;
    }

    const section = { ...rawSection };
    const fallbackTitle = typeof section.key === 'string' && section.key.trim()
      ? section.key.trim()
      : `Section ${sectionIndex + 1}`;
    const sectionTitle = typeof section.title === 'string' && section.title.trim()
      ? section.title.trim()
      : fallbackTitle;
    section.title = sectionTitle;

    let columns = Array.isArray(section.columns)
      ? section.columns.map((column) => String(column ?? ''))
      : [];
    const sourceRows = Array.isArray(section.rows) ? section.rows : [];

    if (columns.length !== 2) {
      const repairedSection = repairOutputBucketedSectionColumns(section, columns, sourceRows, sectionTitle, warnings);
      if (!repairedSection) {
        const migratedTable = {
          title: sectionTitle,
          columns: columns.length > 0 ? columns : ['Item', 'Value'],
          rows: toGenericTableRows(section.rows)
        };
        generated.tables.push(migratedTable);
        warnings.push(`Moved outputsBucketed section '${sectionTitle}' into generated.tables because outputsBucketed only supports 2-column sections.`);
        return;
      }

      columns = repairedSection.columns;
      section.rows = repairedSection.rows;
    }

    section.columns = columns;

    if (!Array.isArray(section.rows)) {
      section.rows = [];
      warnings.push(`Filled missing rows for outputsBucketed section '${sectionTitle}' with an empty array.`);
    }

    section.rows = section.rows
      .filter((row) => Array.isArray(row) && row.length >= 2)
      .map((row) => {
        const label = String(row[0] ?? '');
        const numericValue = parsePayloadNumber(row[1]);
        if (numericValue === null) {
          warnings.push(`Normalized non-numeric value to 0 in outputsBucketed section '${sectionTitle}'.`);
          return [label, 0];
        }
        return [label, numericValue];
      });

    if (!('subtotalValue' in section)) {
      section.subtotalValue = 0;
      warnings.push(`Filled missing subtotalValue = 0 for outputsBucketed section '${sectionTitle}'.`);
    } else if (typeof section.subtotalValue !== 'number' || !Number.isFinite(section.subtotalValue)) {
      const parsedSubtotal = parsePayloadNumber(section.subtotalValue);
      if (parsedSubtotal === null) {
        section.subtotalValue = 0;
        warnings.push(`Normalized invalid subtotalValue to 0 for outputsBucketed section '${sectionTitle}'.`);
      } else {
        section.subtotalValue = parsedSubtotal;
        warnings.push(`Parsed subtotalValue for outputsBucketed section '${sectionTitle}' as a number.`);
      }
    }

    nextSections.push(section);
  });

  outputsBucketed.sections = nextSections;

  return {
    payload,
    warnings
  };
}

const AUTO_SFT_SPAN_PATTERN = /<span\b[^>]*\bdata-auto=(["'])sft\1[^>]*>[\s\S]*?<\/span>/gi;

const AUTO_PERSONAL_CAP_SPAN_PATTERN = /<span\b[^>]*\bdata-auto=(["'])personal-cap\1[^>]*>[\s\S]*?<\/span>/gi;

const AUTO_READINESS_SPAN_PATTERN = /<span\b[^>]*\bdata-auto=(["'])readiness\1[^>]*>[\s\S]*?<\/span>/gi;

function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function removeAutoSftSummarySpan(summaryHtml) {
  return String(summaryHtml ?? '')
    .replace(AUTO_SFT_SPAN_PATTERN, '')
    .replace(AUTO_PERSONAL_CAP_SPAN_PATTERN, '')
    .replace(AUTO_READINESS_SPAN_PATTERN, '')
    .replace(/\s+<\/p>/gi, '</p>')
    .trim();
}

function injectAutoSummarySentence(summaryHtml, sentence, autoKey) {
  const cleaned = String(summaryHtml ?? '').trim();
  if (!sentence) {
    return cleaned;
  }

  const safeAutoKey = String(autoKey ?? '').trim() || 'note';
  const autoSpan = `<span data-auto=\"${escapeHtmlText(safeAutoKey)}\">${escapeHtmlText(sentence)}</span>`;

  if (!cleaned) {
    return `<p>${autoSpan}</p>`;
  }

  const firstParagraphCloseMatch = /<\/p>/i.exec(cleaned);
  if (!firstParagraphCloseMatch || typeof firstParagraphCloseMatch.index !== 'number') {
    return `${cleaned}<p>${autoSpan}</p>`;
  }

  const closeTagIndex = firstParagraphCloseMatch.index;
  return `${cleaned.slice(0, closeTagIndex)} ${autoSpan}${cleaned.slice(closeTagIndex)}`;
}

export function injectAutoPensionSummarySentences(summaryHtml, {
  readinessSentence = '',
  sftSentence = '',
  personalCapSentence = ''
} = {}) {
  let next = removeAutoSftSummarySpan(summaryHtml);
  next = injectAutoSummarySentence(next, readinessSentence, 'readiness');
  next = injectAutoSummarySentence(next, sftSentence, 'sft');
  next = injectAutoSummarySentence(next, personalCapSentence, 'personal-cap');
  return next;
}

function isPersonalBalanceSheetModule(module) {
  const generated = module?.generated;
  if (generated?.pbsInputs) {
    return true;
  }

  const sections = Array.isArray(generated?.outputsBucketed?.sections)
    ? generated.outputsBucketed.sections
    : [];
  const sectionTokens = new Set(
    sections.map((section) => String(section?.key || section?.title || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ''))
  );
  const hasPbsBucketShape = ['lifestyle', 'liquidity', 'longevity', 'legacy']
    .every((token) => sectionTokens.has(token));
  if (hasPbsBucketShape) {
    return true;
  }

  const title = typeof module?.title === 'string' ? module.title.toLowerCase() : '';
  return title.includes('personal balance sheet');
}

function validateTablePayload(table, label) {
  if (!table || typeof table !== 'object') {
    throw new Error(`${label} must be an object with columns and rows.`);
  }

  if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) {
    throw new Error(`${label} must include columns[] and rows[].`);
  }

  const columns = table.columns.map((column) => String(column ?? ''));
  const rows = table.rows.map((row) => Array.isArray(row)
    ? row.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : String(value ?? '')))
    : []);

  return {
    columns,
    rows
  };
}

function validateGeneratedTablesPayload(tables, label = 'generated.tables') {
  if (!Array.isArray(tables)) {
    throw new Error(`${label} must be an array of table objects.`);
  }

  return tables.map((table, tableIndex) => {
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      throw new Error(`${label}[${tableIndex}] must be an object.`);
    }

    const validated = validateTablePayload(table, `${label}[${tableIndex}]`);
    return {
      title: typeof table.title === 'string' && table.title.trim()
        ? table.title.trim()
        : `Table ${tableIndex + 1}`,
      columns: validated.columns,
      rows: validated.rows
    };
  });
}

function normalizePayloadTone(value) {
  const tone = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    : '';
  return tone || '';
}

function validateInsightItemsPayload(items, label, fallbackPrefix = 'insight') {
  if (typeof items === 'undefined') {
    return [];
  }

  if (!Array.isArray(items)) {
    throw new Error(`${label} must be an array when provided.`);
  }

  return items.map((item, itemIndex) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label}[${itemIndex}] must be an object.`);
    }

    if ('label' in item && typeof item.label !== 'string') {
      throw new Error(`${label}[${itemIndex}].label must be a string when provided.`);
    }

    if ('title' in item && typeof item.title !== 'string') {
      throw new Error(`${label}[${itemIndex}].title must be a string when provided.`);
    }

    if ('value' in item && typeof item.value !== 'string' && typeof item.value !== 'number') {
      throw new Error(`${label}[${itemIndex}].value must be a string or number when provided.`);
    }

    if ('detail' in item && typeof item.detail !== 'string') {
      throw new Error(`${label}[${itemIndex}].detail must be a string when provided.`);
    }

    if ('body' in item && typeof item.body !== 'string') {
      throw new Error(`${label}[${itemIndex}].body must be a string when provided.`);
    }

    const normalized = {
      id: typeof item.id === 'string' && item.id.trim()
        ? item.id.trim()
        : `${fallbackPrefix}-${itemIndex + 1}`,
      label: typeof item.label === 'string' && item.label.trim()
        ? item.label.trim()
        : (typeof item.title === 'string' && item.title.trim()
          ? item.title.trim()
          : `Insight ${itemIndex + 1}`)
    };

    if (typeof item.value === 'number' && Number.isFinite(item.value)) {
      normalized.value = String(item.value);
    } else if (typeof item.value === 'string' && item.value.trim()) {
      normalized.value = item.value.trim();
    }

    const detail = typeof item.detail === 'string' && item.detail.trim()
      ? item.detail.trim()
      : (typeof item.body === 'string' && item.body.trim() ? item.body.trim() : '');
    if (detail) {
      normalized.detail = detail;
    }

    const tone = normalizePayloadTone(item.tone);
    if (tone) {
      normalized.tone = tone;
    }

    if (item.featured === true) {
      normalized.featured = true;
    }

    return normalized;
  });
}

function validateChartDisplayPayload(display, label) {
  if (typeof display === 'undefined') {
    return null;
  }

  if (!display || typeof display !== 'object' || Array.isArray(display)) {
    throw new Error(`${label} must be an object when provided.`);
  }

  const normalized = {};
  const variant = typeof display.variant === 'string'
    ? display.variant.trim().toLowerCase()
    : '';
  if (variant) {
    if (variant !== 'hero' && variant !== 'compact' && variant !== 'wide' && variant !== 'pension-drawdown-composite') {
      throw new Error(`${label}.variant must be "hero", "compact", "wide", or "pension-drawdown-composite" when provided.`);
    }
    normalized.variant = variant;
  }

  const valueFormat = typeof display.valueFormat === 'string'
    ? display.valueFormat.trim().toLowerCase()
    : '';
  if (valueFormat) {
    if (valueFormat !== 'currency' && valueFormat !== 'percent' && valueFormat !== 'number') {
      throw new Error(`${label}.valueFormat must be "currency", "percent", or "number" when provided.`);
    }
    normalized.valueFormat = valueFormat;
  }

  ['xAxisTitle', 'yAxisTitle', 'highlightDataset'].forEach((key) => {
    if (key in display) {
      if (typeof display[key] !== 'string') {
        throw new Error(`${label}.${key} must be a string when provided.`);
      }
      if (display[key].trim()) {
        normalized[key] = display[key].trim();
      }
    }
  });

  if ('showLegend' in display) {
    if (typeof display.showLegend !== 'boolean') {
      throw new Error(`${label}.showLegend must be a boolean when provided.`);
    }
    normalized.showLegend = display.showLegend;
  }

  if ('stacked' in display) {
    if (typeof display.stacked !== 'boolean') {
      throw new Error(`${label}.stacked must be a boolean when provided.`);
    }
    normalized.stacked = display.stacked;
  }

  ['yMin', 'yMax', 'suggestedMin', 'suggestedMax'].forEach((key) => {
    if (key in display) {
      const value = Number(display[key]);
      if (!Number.isFinite(value)) {
        throw new Error(`${label}.${key} must be a finite number when provided.`);
      }
      normalized[key] = value;
    }
  });

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function validateChartAnnotationsPayload(annotations, label) {
  if (typeof annotations === 'undefined') {
    return [];
  }

  if (!Array.isArray(annotations)) {
    throw new Error(`${label} must be an array when provided.`);
  }

  return annotations.map((annotation, annotationIndex) => {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) {
      throw new Error(`${label}[${annotationIndex}] must be an object.`);
    }

    if ('label' in annotation && typeof annotation.label !== 'string') {
      throw new Error(`${label}[${annotationIndex}].label must be a string when provided.`);
    }

    if ('body' in annotation && typeof annotation.body !== 'string') {
      throw new Error(`${label}[${annotationIndex}].body must be a string when provided.`);
    }

    if ('xLabel' in annotation && typeof annotation.xLabel !== 'string') {
      throw new Error(`${label}[${annotationIndex}].xLabel must be a string when provided.`);
    }

    if ('yValue' in annotation && (typeof annotation.yValue !== 'number' || !Number.isFinite(annotation.yValue))) {
      throw new Error(`${label}[${annotationIndex}].yValue must be a finite number when provided.`);
    }

    const normalized = {
      id: typeof annotation.id === 'string' && annotation.id.trim()
        ? annotation.id.trim()
        : `annotation-${annotationIndex + 1}`,
      label: typeof annotation.label === 'string' && annotation.label.trim()
        ? annotation.label.trim()
        : `Annotation ${annotationIndex + 1}`
    };

    if (typeof annotation.body === 'string' && annotation.body.trim()) {
      normalized.body = annotation.body.trim();
    }

    if (typeof annotation.xLabel === 'string' && annotation.xLabel.trim()) {
      normalized.xLabel = annotation.xLabel.trim();
    }

    if (typeof annotation.yValue === 'number' && Number.isFinite(annotation.yValue)) {
      normalized.yValue = annotation.yValue;
    }

    const tone = normalizePayloadTone(annotation.tone);
    if (tone) {
      normalized.tone = tone;
    }

    return normalized;
  });
}

function validateChartsPayload(charts) {
  if (!Array.isArray(charts)) {
    throw new Error('generated.charts must be an array.');
  }

  return charts.map((chart, index) => {
    if (!chart || typeof chart !== 'object') {
      throw new Error(`Chart ${index + 1} must be an object.`);
    }

    if (typeof chart.title !== 'string' || !chart.title.trim()) {
      throw new Error(`Chart ${index + 1} requires a non-empty title.`);
    }

    if (chart.type !== 'line' && chart.type !== 'bar') {
      throw new Error(`Chart ${index + 1} type must be "line" or "bar".`);
    }

    if (!Array.isArray(chart.labels)) {
      throw new Error(`Chart ${index + 1} labels must be an array.`);
    }

    if (!Array.isArray(chart.datasets) || chart.datasets.length === 0) {
      throw new Error(`Chart ${index + 1} datasets must be a non-empty array.`);
    }

    const normalizedChart = {
      id: typeof chart.id === 'string' && chart.id.trim() ? chart.id : '',
      title: chart.title,
      type: chart.type,
      labels: chart.labels.map((label) => String(label ?? '')),
      datasets: chart.datasets.map((dataset, datasetIndex) => {
        if (!dataset || typeof dataset !== 'object') {
          throw new Error(`Chart ${index + 1}, dataset ${datasetIndex + 1} must be an object.`);
        }

        if (!Array.isArray(dataset.data)) {
          throw new Error(`Chart ${index + 1}, dataset ${datasetIndex + 1} must include data[].`);
        }

        const normalizedDataset = {
          label: typeof dataset.label === 'string' ? dataset.label : `Series ${datasetIndex + 1}`,
          data: dataset.data.map((value) => {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
              throw new Error(`Chart ${index + 1} contains non-numeric data.`);
            }
            return value;
          })
        };

        if ('type' in dataset) {
          if (dataset.type !== 'line' && dataset.type !== 'bar') {
            throw new Error(`Chart ${index + 1}, dataset ${datasetIndex + 1}.type must be "line" or "bar" when provided.`);
          }
          normalizedDataset.type = dataset.type;
        }
        if ('stack' in dataset) {
          if (typeof dataset.stack !== 'string') {
            throw new Error(`Chart ${index + 1}, dataset ${datasetIndex + 1}.stack must be a string when provided.`);
          }
          if (dataset.stack.trim()) {
            normalizedDataset.stack = dataset.stack.trim();
          }
        }

        [
          'backgroundColor',
          'borderColor',
          'pointBackgroundColor',
          'pointBorderColor'
        ].forEach((key) => {
          if (key in dataset) {
            if (typeof dataset[key] !== 'string') {
              throw new Error(`Chart ${index + 1}, dataset ${datasetIndex + 1}.${key} must be a string when provided.`);
            }
            if (dataset[key].trim()) {
              normalizedDataset[key] = dataset[key].trim();
            }
          }
        });

        return normalizedDataset;
      })
    };

    if ('subtitle' in chart) {
      if (typeof chart.subtitle !== 'string') {
        throw new Error(`Chart ${index + 1} subtitle must be a string when provided.`);
      }
      if (chart.subtitle.trim()) {
        normalizedChart.subtitle = chart.subtitle.trim();
      }
    }

    const display = validateChartDisplayPayload(chart.display, `Chart ${index + 1}.display`);
    if (display) {
      normalizedChart.display = display;
    }

    const annotations = validateChartAnnotationsPayload(chart.annotations, `Chart ${index + 1}.annotations`);
    if (annotations.length > 0) {
      normalizedChart.annotations = annotations;
    }

    const insights = validateInsightItemsPayload(chart.insights, `Chart ${index + 1}.insights`, 'chart-insight');
    if (insights.length > 0) {
      normalizedChart.insights = insights;
    }

    return normalizedChart;
  });
}

function cloneEducationSpecValue(value, depth = 0) {
  if (depth > 24) {
    return null;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => cloneEducationSpecValue(entry, depth + 1))
      .filter((entry) => typeof entry !== 'undefined');
  }

  if (value && typeof value === 'object') {
    const clone = {};
    Object.entries(value).forEach(([key, childValue]) => {
      const normalized = cloneEducationSpecValue(childValue, depth + 1);
      if (typeof normalized !== 'undefined') {
        clone[key] = normalized;
      }
    });
    return clone;
  }

  return undefined;
}

function validateEducationPayload(education) {
  if (education === null) {
    return null;
  }

  if (!education || typeof education !== 'object' || Array.isArray(education)) {
    throw new Error('generated.education must be an object.');
  }

  const normalized = {
    topic: typeof education.topic === 'string' ? education.topic : '',
    sections: [],
    visuals: [],
    references: []
  };

  if ('audience' in education) {
    if (typeof education.audience !== 'string') {
      throw new Error('generated.education.audience must be a string when provided.');
    }
    if (education.audience.trim()) {
      normalized.audience = education.audience.trim();
    }
  }

  if ('sections' in education) {
    if (!Array.isArray(education.sections)) {
      throw new Error('generated.education.sections must be an array when provided.');
    }

    normalized.sections = education.sections.map((section, sectionIndex) => {
      if (!section || typeof section !== 'object' || Array.isArray(section)) {
        throw new Error(`generated.education.sections[${sectionIndex}] must be an object.`);
      }

      const bullets = Array.isArray(section.bullets)
        ? section.bullets.map((bullet, bulletIndex) => {
          if (typeof bullet !== 'string') {
            throw new Error(`generated.education.sections[${sectionIndex}].bullets[${bulletIndex}] must be a string.`);
          }
          return bullet;
        })
        : [];

      if ('bodyHtml' in section && typeof section.bodyHtml !== 'string') {
        throw new Error(`generated.education.sections[${sectionIndex}].bodyHtml must be a string when provided.`);
      }

      if ('whyItMatters' in section && typeof section.whyItMatters !== 'string') {
        throw new Error(`generated.education.sections[${sectionIndex}].whyItMatters must be a string when provided.`);
      }

      if ('defaultOpen' in section && typeof section.defaultOpen !== 'boolean') {
        throw new Error(`generated.education.sections[${sectionIndex}].defaultOpen must be a boolean when provided.`);
      }

      return {
        id: typeof section.id === 'string' && section.id.trim()
          ? section.id.trim()
          : `section-${sectionIndex + 1}`,
        title: typeof section.title === 'string' && section.title.trim()
          ? section.title.trim()
          : `Section ${sectionIndex + 1}`,
        bodyHtml: typeof section.bodyHtml === 'string' ? section.bodyHtml : '',
        bullets,
        ...(typeof section.whyItMatters === 'string' && section.whyItMatters.trim()
          ? { whyItMatters: section.whyItMatters.trim() }
          : {}),
        ...(typeof section.defaultOpen === 'boolean'
          ? { defaultOpen: section.defaultOpen }
          : {})
      };
    });
  }

  if ('metrics' in education) {
    normalized.metrics = validateInsightItemsPayload(education.metrics, 'generated.education.metrics', 'education-metric');
  }

  if ('steps' in education) {
    if (!Array.isArray(education.steps)) {
      throw new Error('generated.education.steps must be an array when provided.');
    }

    normalized.steps = education.steps.map((step, stepIndex) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        throw new Error(`generated.education.steps[${stepIndex}] must be an object.`);
      }

      ['title', 'bodyHtml', 'kicker', 'focus'].forEach((key) => {
        if (key in step && typeof step[key] !== 'string') {
          throw new Error(`generated.education.steps[${stepIndex}].${key} must be a string when provided.`);
        }
      });

      const bullets = Array.isArray(step.bullets)
        ? step.bullets.map((bullet, bulletIndex) => {
          if (typeof bullet !== 'string') {
            throw new Error(`generated.education.steps[${stepIndex}].bullets[${bulletIndex}] must be a string.`);
          }
          return bullet;
        })
        : [];

      return {
        id: typeof step.id === 'string' && step.id.trim()
          ? step.id.trim()
          : `step-${stepIndex + 1}`,
        title: typeof step.title === 'string' && step.title.trim()
          ? step.title.trim()
          : `Step ${stepIndex + 1}`,
        bodyHtml: typeof step.bodyHtml === 'string' ? step.bodyHtml : '',
        bullets,
        ...(typeof step.kicker === 'string' && step.kicker.trim()
          ? { kicker: step.kicker.trim() }
          : {}),
        ...(typeof step.focus === 'string' && step.focus.trim()
          ? { focus: step.focus.trim() }
          : {})
      };
    });
  }

  if ('visuals' in education) {
    if (!Array.isArray(education.visuals)) {
      throw new Error('generated.education.visuals must be an array when provided.');
    }

    normalized.visuals = education.visuals.map((visual, visualIndex) => {
      if (!visual || typeof visual !== 'object' || Array.isArray(visual)) {
        throw new Error(`generated.education.visuals[${visualIndex}] must be an object.`);
      }

      const type = String(visual.type || '').trim().toLowerCase();
      const title = typeof visual.title === 'string' ? visual.title : '';
      const subtitle = typeof visual.subtitle === 'string' ? visual.subtitle : '';

      if (type === 'svg') {
        if (!visual.svgSpec || typeof visual.svgSpec !== 'object' || Array.isArray(visual.svgSpec)) {
          throw new Error(`generated.education.visuals[${visualIndex}].svgSpec must be an object for type \"svg\".`);
        }

        return {
          type: 'svg',
          title,
          subtitle,
          svgSpec: cloneEducationSpecValue(visual.svgSpec) || {}
        };
      }

      if (type === 'chart') {
        if (!visual.chart || typeof visual.chart !== 'object' || Array.isArray(visual.chart)) {
          throw new Error(`generated.education.visuals[${visualIndex}].chart must be an object for type \"chart\".`);
        }

        const chart = validateChartsPayload([visual.chart])[0];
        return {
          type: 'chart',
          title,
          subtitle,
          chart
        };
      }

      throw new Error(`generated.education.visuals[${visualIndex}].type must be \"svg\" or \"chart\".`);
    });
  }

  if ('references' in education) {
    if (!Array.isArray(education.references)) {
      throw new Error('generated.education.references must be an array when provided.');
    }

    normalized.references = education.references.map((reference, referenceIndex) => {
      if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
        throw new Error(`generated.education.references[${referenceIndex}] must be an object.`);
      }

      if ('label' in reference && typeof reference.label !== 'string') {
        throw new Error(`generated.education.references[${referenceIndex}].label must be a string when provided.`);
      }

      if ('url' in reference && typeof reference.url !== 'string') {
        throw new Error(`generated.education.references[${referenceIndex}].url must be a string when provided.`);
      }

      if ('kind' in reference && typeof reference.kind !== 'string') {
        throw new Error(`generated.education.references[${referenceIndex}].kind must be a string when provided.`);
      }

      if ('note' in reference && typeof reference.note !== 'string') {
        throw new Error(`generated.education.references[${referenceIndex}].note must be a string when provided.`);
      }

      return {
        label: typeof reference.label === 'string' && reference.label.trim()
          ? reference.label.trim()
          : `Reference ${referenceIndex + 1}`,
        url: typeof reference.url === 'string' ? reference.url.trim() : '',
        kind: typeof reference.kind === 'string' ? reference.kind.trim() : '',
        note: typeof reference.note === 'string' ? reference.note : ''
      };
    });
  }

  return normalized;
}

function validatePensionInputsPayload(pensionInputs) {
  return normalizePensionInputs(pensionInputs);
}

function validateCollegeFundingInputsPayload(collegeFundingInputs) {
  return normalizeCollegeFundingInputs(collegeFundingInputs);
}

function validateHousePurchaseInputsPayload(housePurchaseInputs) {
  return normalizeHousePurchaseInputs(housePurchaseInputs);
}

function validateNetRetirementInputsPayload(netRetirementInputs) {
  return normalizeNetRetirementInputs(netRetirementInputs);
}

function validateMortgageInputsPayload(mortgageInputs) {
  return normalizeMortgageInputs(mortgageInputs, { defaultLoanKind: 'mortgage' });
}

function validateLoanInputsPayload(loanInputs) {
  return normalizeMortgageInputs(loanInputs, { defaultLoanKind: 'loan' });
}

function validatePbsInputsPayload(pbsInputs) {
  return normalizePbsInputs(pbsInputs);
}

function validateLiquidityPlanPayload(liquidityPlan) {
  const normalized = normalizeLiquidityPlan(liquidityPlan);
  if (!normalized) {
    throw new Error('generated.liquidityPlan must include liquidity planning data.');
  }
  return normalized;
}

export function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be a JSON object.');
  }

  const normalized = {};

  if ('moduleId' in payload) {
    if (typeof payload.moduleId !== 'string' || !payload.moduleId.trim()) {
      throw new Error('moduleId must be a non-empty string when provided.');
    }

    normalized.moduleId = payload.moduleId;
  }

  if ('title' in payload) {
    if (typeof payload.title !== 'string') {
      throw new Error('title must be a string when provided.');
    }

    normalized.title = payload.title;
  }

  if ('generated' in payload) {
    if (!payload.generated || typeof payload.generated !== 'object' || Array.isArray(payload.generated)) {
      throw new Error('generated must be an object when provided.');
    }

    const generatedPatch = {};

    if ('summaryHtml' in payload.generated) {
      if (typeof payload.generated.summaryHtml !== 'string') {
        throw new Error('generated.summaryHtml must be a string.');
      }
      generatedPatch.summaryHtml = payload.generated.summaryHtml;
    }

    if ('assumptions' in payload.generated) {
      generatedPatch.assumptions = validateTablePayload(payload.generated.assumptions, 'generated.assumptions');
    }

    if ('outputs' in payload.generated) {
      generatedPatch.outputs = validateTablePayload(payload.generated.outputs, 'generated.outputs');
    }

    if ('outputsBucketed' in payload.generated) {
      generatedPatch.outputsBucketed = validateOutputsBucketedPayload(payload.generated.outputsBucketed);
    }

    if ('tables' in payload.generated) {
      generatedPatch.tables = validateGeneratedTablesPayload(payload.generated.tables);
    }

    if ('pbsInputs' in payload.generated) {
      generatedPatch.pbsInputs = validatePbsInputsPayload(payload.generated.pbsInputs);
    }

    if ('personalBalanceSheetInputs' in payload.generated && !('pbsInputs' in payload.generated)) {
      generatedPatch.pbsInputs = validatePbsInputsPayload(payload.generated.personalBalanceSheetInputs);
    }

    if ('liquidityPlan' in payload.generated) {
      generatedPatch.liquidityPlan = validateLiquidityPlanPayload(payload.generated.liquidityPlan);
    }

    if ('liquidity' in payload.generated && !('liquidityPlan' in payload.generated)) {
      generatedPatch.liquidityPlan = validateLiquidityPlanPayload(payload.generated.liquidity);
    }

    if ('charts' in payload.generated) {
      generatedPatch.charts = validateChartsPayload(payload.generated.charts);
    }

    if ('pensionInputs' in payload.generated) {
      generatedPatch.pensionInputs = validatePensionInputsPayload(payload.generated.pensionInputs);
    }

    if ('collegeFundingInputs' in payload.generated) {
      generatedPatch.collegeFundingInputs = validateCollegeFundingInputsPayload(payload.generated.collegeFundingInputs);
    }

    if ('collegeFunding' in payload.generated && !('collegeFundingInputs' in payload.generated)) {
      generatedPatch.collegeFundingInputs = validateCollegeFundingInputsPayload(payload.generated.collegeFunding);
    }

    if ('housePurchaseInputs' in payload.generated) {
      generatedPatch.housePurchaseInputs = validateHousePurchaseInputsPayload(payload.generated.housePurchaseInputs);
    }

    if ('netRetirementInputs' in payload.generated) {
      generatedPatch.netRetirementInputs = validateNetRetirementInputsPayload(payload.generated.netRetirementInputs);
    }

    if ('netCashflowInputs' in payload.generated && !('netRetirementInputs' in payload.generated)) {
      generatedPatch.netRetirementInputs = validateNetRetirementInputsPayload(payload.generated.netCashflowInputs);
    }

    if ('mortgageInputs' in payload.generated) {
      generatedPatch.mortgageInputs = validateMortgageInputsPayload(payload.generated.mortgageInputs);
    }

    if ('loanInputs' in payload.generated) {
      generatedPatch.loanInputs = validateLoanInputsPayload(payload.generated.loanInputs);
    }

    if ('education' in payload.generated) {
      generatedPatch.education = validateEducationPayload(payload.generated.education);
    }

    if ('report' in payload.generated) {
      generatedPatch.report = validateReportPayload(payload.generated.report);
    }

    normalized.generated = generatedPatch;
  }

  if (!('title' in normalized) && !('generated' in normalized)) {
    throw new Error('Payload must include at least one of: title, generated.');
  }

  return normalized;
}

export function clearGeneratedForVideoSummary(module) {
  module.generated.summaryHtml = '';
  module.generated.assumptions = {
    columns: [],
    rows: []
  };
  module.generated.outputs = {
    columns: [],
    rows: []
  };
  module.generated.tables = [];
  module.generated.pbsInputs = null;
  module.generated.liquidityPlan = null;
  module.generated.pensionInputs = null;
  module.generated.mortgageInputs = null;
  module.generated.loanInputs = null;
  module.generated.collegeFundingInputs = null;
  module.generated.housePurchaseInputs = null;
  module.generated.netRetirementInputs = null;
  module.generated.education = null;
  module.generated.report = null;
  module.generated.outputsBucketed = null;
  module.generated.charts = [];
}

function clearVideoSummaryForGeneratedModule(module) {
  if (module?.generated) {
    module.generated.videoSummary = null;
  }
}

function mergeGeneratedPatch(module, generatedPatch) {
  ensureGenerated(module);

  if ('summaryHtml' in generatedPatch) {
    module.generated.summaryHtml = generatedPatch.summaryHtml;
  }

  if ('assumptions' in generatedPatch) {
    module.generated.assumptions = generatedPatch.assumptions;
  }

  if ('outputs' in generatedPatch) {
    module.generated.outputs = generatedPatch.outputs;
  }

  if ('videoSummary' in generatedPatch) {
    module.generated.videoSummary = generatedPatch.videoSummary;
    if (generatedPatch.videoSummary) {
      clearGeneratedForVideoSummary(module);
    }
  }

  if ('liquidityPlan' in generatedPatch) {
    module.generated.liquidityPlan = generatedPatch.liquidityPlan;
    if (generatedPatch.liquidityPlan) {
      module.generated.pbsInputs = null;
      module.generated.pensionInputs = null;
      module.generated.mortgageInputs = null;
      module.generated.loanInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.housePurchaseInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.education = null;
      module.generated.report = null;
      module.generated.outputsBucketed = null;
      module.generated.outputs = { columns: [], rows: [] };
      module.generated.assumptions = { columns: [], rows: [] };
      module.generated.tables = [];
      module.generated.charts = [];
      clearVideoSummaryForGeneratedModule(module);
    }
  }

  if ('pensionInputs' in generatedPatch) {
    module.generated.pensionInputs = generatedPatch.pensionInputs;
    if (generatedPatch.pensionInputs) {
      module.generated.liquidityPlan = null;
      module.generated.mortgageInputs = null;
      module.generated.loanInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.housePurchaseInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.education = null;
      module.generated.report = null;
      clearVideoSummaryForGeneratedModule(module);
    }
  }

  if ('collegeFundingInputs' in generatedPatch) {
    module.generated.collegeFundingInputs = generatedPatch.collegeFundingInputs;
    if (generatedPatch.collegeFundingInputs) {
      module.generated.liquidityPlan = null;
      module.generated.pensionInputs = null;
      module.generated.mortgageInputs = null;
      module.generated.loanInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.housePurchaseInputs = null;
      module.generated.education = null;
      module.generated.report = null;
      clearVideoSummaryForGeneratedModule(module);
    }
  }

  if ('housePurchaseInputs' in generatedPatch) {
    module.generated.housePurchaseInputs = generatedPatch.housePurchaseInputs;
    if (generatedPatch.housePurchaseInputs) {
      module.generated.pbsInputs = null;
      module.generated.liquidityPlan = null;
      module.generated.pensionInputs = null;
      module.generated.mortgageInputs = null;
      module.generated.loanInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.education = null;
      module.generated.report = null;
      module.generated.outputsBucketed = null;
      clearVideoSummaryForGeneratedModule(module);
    }
  }

  if ('netRetirementInputs' in generatedPatch) {
    module.generated.netRetirementInputs = generatedPatch.netRetirementInputs;
    if (generatedPatch.netRetirementInputs) {
      module.generated.liquidityPlan = null;
      module.generated.pensionInputs = null;
      module.generated.mortgageInputs = null;
      module.generated.loanInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.housePurchaseInputs = null;
      module.generated.education = null;
      module.generated.report = null;
      clearVideoSummaryForGeneratedModule(module);
    }
  }

  if ('mortgageInputs' in generatedPatch) {
    module.generated.mortgageInputs = generatedPatch.mortgageInputs;
    if (generatedPatch.mortgageInputs) {
      module.generated.liquidityPlan = null;
      module.generated.pensionInputs = null;
      module.generated.loanInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.housePurchaseInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.education = null;
      module.generated.report = null;
      clearVideoSummaryForGeneratedModule(module);
    }
  }

  if ('loanInputs' in generatedPatch) {
    module.generated.loanInputs = generatedPatch.loanInputs;
    if (generatedPatch.loanInputs) {
      module.generated.liquidityPlan = null;
      module.generated.pensionInputs = null;
      module.generated.mortgageInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.housePurchaseInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.education = null;
      module.generated.report = null;
      clearVideoSummaryForGeneratedModule(module);
    }
  }

  if ('education' in generatedPatch) {
    module.generated.education = generatedPatch.education;
    if (generatedPatch.education) {
      module.generated.liquidityPlan = null;
      module.generated.pensionInputs = null;
      module.generated.mortgageInputs = null;
      module.generated.loanInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.housePurchaseInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.report = null;
      clearVideoSummaryForGeneratedModule(module);
    }
  }

  if ('report' in generatedPatch) {
    module.generated.report = generatedPatch.report;
    if (generatedPatch.report) {
      module.generated.liquidityPlan = null;
      module.generated.pensionInputs = null;
      module.generated.mortgageInputs = null;
      module.generated.loanInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.housePurchaseInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.education = null;
      clearVideoSummaryForGeneratedModule(module);
    }
  }

  if ('outputsBucketed' in generatedPatch) {
    module.generated.outputsBucketed = generatedPatch.outputsBucketed;

    if (isPersonalBalanceSheetModule(module)) {
      module.generated.outputs = {
        columns: [],
        rows: []
      };
    }
  }

  if ('tables' in generatedPatch) {
    module.generated.tables = generatedPatch.tables;
  }

  if ('pbsInputs' in generatedPatch && !module.generated.liquidityPlan) {
    module.generated.pbsInputs = generatedPatch.pbsInputs;
  }

  if ('charts' in generatedPatch) {
    module.generated.charts = generatedPatch.charts.map((chart, index) => ({
      ...chart,
      id: chart.id || makeChartId(module.id, chart.title, index)
    }));
  }
}

export function cloneSessionValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export function applyNormalizedPayloadToModule(module, normalizedPayload, { resetEditorState = true } = {}) {
  if ('title' in normalizedPayload) {
    module.title = normalizedPayload.title;
  }

  if (normalizedPayload.generated) {
    mergeGeneratedPatch(module, normalizedPayload.generated);

    const hasPensionInputsPatch = 'pensionInputs' in normalizedPayload.generated;
    const hasCollegeFundingInputsPatch = 'collegeFundingInputs' in normalizedPayload.generated;
    const hasHousePurchaseInputsPatch = 'housePurchaseInputs' in normalizedPayload.generated;
    const hasNetRetirementInputsPatch = 'netRetirementInputs' in normalizedPayload.generated;
    const hasMortgageInputsPatch = 'mortgageInputs' in normalizedPayload.generated;
    const hasLoanInputsPatch = 'loanInputs' in normalizedPayload.generated;

    if (hasLoanInputsPatch && module.generated.loanInputs) {
      applyMortgageProjectionToModule(module, { updateSummary: true });
      if (resetEditorState) {
        host.resetAssumptionsEditorState(module.id);
      }
    } else if (hasMortgageInputsPatch && module.generated.mortgageInputs) {
      applyMortgageProjectionToModule(module, { updateSummary: true });
      if (resetEditorState) {
        host.resetAssumptionsEditorState(module.id);
      }
    } else if (hasPensionInputsPatch && module.generated.pensionInputs) {
      applyPensionProjectionToModule(module, { updateSummary: true });
      if (resetEditorState) {
        host.resetAssumptionsEditorState(module.id);
      }
    } else if (hasNetRetirementInputsPatch && module.generated.netRetirementInputs) {
      applyNetRetirementProjectionToModule(module);
      if (resetEditorState) {
        host.resetAssumptionsEditorState(module.id);
      }
    } else if (hasCollegeFundingInputsPatch && module.generated.collegeFundingInputs) {
      applyCollegeFundingProjectionToModule(module);
    } else if (hasHousePurchaseInputsPatch && module.generated.housePurchaseInputs) {
      applyHousePurchaseProjectionToModule(module);
      module.ui.housePurchaseEditor = null;
    }
  }
}

export function preflightGeneratedPayload(normalizedPayload) {
  const scratchModule = createBlankModule();
  applyNormalizedPayloadToModule(scratchModule, normalizedPayload, { resetEditorState: false });
}


/* ------------------------------------------------------------------------
 * READING A PAYLOAD THE WAY THE SCREEN READS IT.
 *
 * These came out of `render.js` so a check can ask a payload the same
 * questions the card asks -- what the net worth is, whether the sections
 * reconcile, how many months of cover there are. A check that worked those
 * out its own way would be measuring its own arithmetic, not the app's.
 * ---------------------------------------------------------------------- */

export const PBS_ASSET_SECTION_KEYS = ['lifestyle', 'liquidity', 'longevity', 'legacy'];

const PBS_NET_WORTH_TOKENS = new Set(['networth', 'netassets', 'netwealth']);

const PBS_BALANCE_CHANGE_WORDS = /\b(change|difference|increase|decrease|movement|delta|gap|variance)\b/i;

export function normalizeSectionToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeReadableLabelText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isPbsNetWorthSummaryLabel(value) {
  const token = normalizeSectionToken(value);
  if (PBS_NET_WORTH_TOKENS.has(token)) {
    return true;
  }

  const text = normalizeReadableLabelText(value);
  if (!/\bnet\s+(worth|assets|wealth)\b/i.test(text)) {
    return false;
  }

  return !PBS_BALANCE_CHANGE_WORDS.test(text);
}

export function findOutputsBucketedSection(sections, targetKey) {
  const targetToken = normalizeSectionToken(targetKey);
  return sections.find((section) => (
    normalizeSectionToken(section?.key) === targetToken
    || normalizeSectionToken(section?.title) === targetToken
  )) || null;
}

export function findOutputsBucketedSectionByKey(sections, targetKey) {
  const targetToken = normalizeSectionToken(targetKey);
  return (Array.isArray(sections) ? sections : []).find((section) => (
    normalizeSectionToken(section?.key) === targetToken
  )) || null;
}

export function isOutputsBucketedSummarySection(section) {
  const keyToken = normalizeSectionToken(section?.key);
  const titleToken = normalizeSectionToken(section?.title);
  if (keyToken === 'summary' || titleToken === 'summary') {
    return true;
  }

  if (keyToken.endsWith('summary') || titleToken.endsWith('summary')) {
    return true;
  }

  const rows = sanitizeSectionRows(section?.rows);
  const hasNetWorth = rows.some(([label]) => isPbsNetWorthSummaryLabel(label));
  const hasBalanceMetric = rows.some(([label]) => (
    ['grossassets', 'totalassets', 'totalliabilities', 'grossliabilities', 'liabilities']
      .includes(normalizeSectionToken(label))
  ));

  return hasNetWorth && hasBalanceMetric;
}

export function findOutputsBucketedSummarySection(sections) {
  const list = Array.isArray(sections) ? sections : [];
  return findOutputsBucketedSectionByKey(list, 'summary')
    || findOutputsBucketedSection(list, 'summary')
    || list.find((section) => isOutputsBucketedSummarySection(section))
    || null;
}

export function sanitizeSectionRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .filter((row) => Array.isArray(row) && row.length >= 2)
    .map((row) => [String(row[0] ?? ''), Number(row[1])])
    .filter((row) => Number.isFinite(row[1]));
}

export function getPositiveFiniteNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
}

export function getFiniteNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

export function getOptionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  return getFiniteNumber(value);
}

export function getOutputsBucketedSubtotal(section) {
  const subtotalValue = getOptionalFiniteNumber(section?.subtotalValue);
  if (subtotalValue !== null) {
    return subtotalValue;
  }

  return sanitizeSectionRows(section?.rows)
    .reduce((sum, row) => sum + row[1], 0);
}

function getOutputsBucketedRowValue(section, targetLabel) {
  const targetToken = normalizeSectionToken(targetLabel);
  const row = sanitizeSectionRows(section?.rows)
    .find(([label]) => normalizeSectionToken(label) === targetToken);
  return row ? row[1] : null;
}

function getFirstOutputsBucketedRowValueByPredicate(section, predicate) {
  const row = sanitizeSectionRows(section?.rows)
    .find(([label]) => predicate(label));
  return row ? row[1] : null;
}

export function getPbsSummaryNetWorthValue(summarySection) {
  const exactValue = getFirstOutputsBucketedRowValue(summarySection, ['net worth', 'net assets', 'net wealth']);
  if (exactValue !== null) {
    return exactValue;
  }

  const flexibleValue = getFirstOutputsBucketedRowValueByPredicate(summarySection, isPbsNetWorthSummaryLabel);
  if (flexibleValue !== null) {
    return flexibleValue;
  }

  if (isPbsNetWorthSummaryLabel(summarySection?.subtotalLabel)) {
    return getOptionalFiniteNumber(summarySection?.subtotalValue);
  }

  return null;
}

function getFirstOutputsBucketedRowValue(section, targetLabels) {
  for (const targetLabel of targetLabels) {
    const value = getOutputsBucketedRowValue(section, targetLabel);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

export function getPbsBalanceMetrics(outputsBucketed) {
  const sections = outputsBucketed.sections;
  const summarySection = findOutputsBucketedSummarySection(sections);
  const assetSections = PBS_ASSET_SECTION_KEYS
    .map((key) => findOutputsBucketedSectionByKey(sections, key) || findOutputsBucketedSection(sections, key))
    .filter(Boolean);
  const grossAssetsFallback = assetSections.length > 0
    ? assetSections.reduce((sum, section) => sum + getOutputsBucketedSubtotal(section), 0)
    : null;
  const liabilitiesSection = findOutputsBucketedSectionByKey(sections, 'liabilities')
    || findOutputsBucketedSection(sections, 'liabilities');
  const liabilitiesFallback = liabilitiesSection
    ? Math.abs(getOutputsBucketedSubtotal(liabilitiesSection))
    : null;

  const grossAssets = getFirstOutputsBucketedRowValue(summarySection, ['gross assets', 'total assets'])
    ?? grossAssetsFallback;
  const grossLiabilities = getFirstOutputsBucketedRowValue(summarySection, [
    'gross liabilities',
    'total liabilities',
    'liabilities'
  ])
    ?? liabilitiesFallback;
  const normalizedGrossAssets = getOptionalFiniteNumber(grossAssets);
  const normalizedGrossLiabilities = getOptionalFiniteNumber(grossLiabilities);
  const netAssets = getPbsSummaryNetWorthValue(summarySection)
    ?? (
      normalizedGrossAssets !== null && normalizedGrossLiabilities !== null
        ? normalizedGrossAssets - Math.abs(normalizedGrossLiabilities)
        : null
    );

  return {
    netAssets: getOptionalFiniteNumber(netAssets),
    grossAssets: normalizedGrossAssets,
    grossLiabilities: normalizedGrossLiabilities === null ? null : Math.abs(normalizedGrossLiabilities)
  };
}

export function getLiquidityClientStatus(plan = {}) {
  const status = typeof plan.clientStatus === 'string'
    ? plan.clientStatus.trim().toLowerCase()
    : '';
  if (status === 'retired') {
    return 'retired';
  }
  return 'not-retired';
}

export function getLiquidityMonthlyExpenditure(plan = {}) {
  const monthlyExpenditure = getPositiveFiniteNumber(plan.monthlyExpenditure);
  if (monthlyExpenditure !== null) {
    return monthlyExpenditure;
  }

  const annualExpenditure = getPositiveFiniteNumber(plan.annualExpenditure);
  return annualExpenditure !== null ? annualExpenditure / 12 : null;
}

/* ------------------------------------------------------------------------
 * THE CASE PACK: A WHOLE CALL IN ONE FILE.
 *
 * A call is six to ten modules, and pasting them one at a time is slow and
 * easy to get half-right. A pack carries the lot, plus the client it is for,
 * and is checked in full before any of it is applied.
 *
 * Checking REPORTS rather than throws, because the two callers want different
 * things from the same answer: the Dev Panel stops at the first problem and
 * changes nothing, the Node check prints a line per module and exits non-zero.
 * One validator, two presentations.
 * ---------------------------------------------------------------------- */

/** The only format there is. */
export const CASE_PACK_VERSION = 1;

/** Everything a pack may carry at the top level. Anything else is a mistake. */
const CASE_PACK_KEYS = Object.freeze(['casePackVersion', 'clientName', 'modules']);

/** Enough to tell a pack from a module payload, before either is validated. */
export function looksLikeCasePack(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'casePackVersion' in value
    && 'modules' in value;
}

function casePackModuleTitle(payload) {
  return typeof payload?.title === 'string' && payload.title.trim()
    ? payload.title.trim()
    : 'untitled';
}

/** How a problem names the module it came from. */
export function casePackModuleLabel(number, total, title) {
  return `Module ${number} of ${total} (${title})`;
}

/**
 * One payload's whole trip: auto-repair, contract validation, and the engine
 * run that proves the figures can be produced.
 *
 * The same three steps the Dev Panel takes for a single paste, in the same
 * order, so a module that passes here is a module that renders.
 */
export function checkModulePayload(rawPayload, { number = 1, total = 1 } = {}) {
  const title = casePackModuleTitle(rawPayload);
  const row = { number, total, title, ok: false, warnings: [], error: '', payload: null, module: null };

  try {
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      throw new Error('Payload must be a JSON object.');
    }

    const { payload: repaired, warnings } = normalizeDevPanelPayload(rawPayload);
    row.warnings = warnings;

    const normalizedPayload = normalizePayload(repaired);
    if (normalizedPayload.moduleId) {
      throw new Error('moduleId cannot be used in a case pack; every module in a pack is a new one.');
    }

    // Built rather than thrown away: the summary reads its figures off the
    // module the engines actually produced, not off the payload.
    const module = createBlankModule();
    applyNormalizedPayloadToModule(module, normalizedPayload, { resetEditorState: false });

    row.payload = normalizedPayload;
    row.module = module;
    row.ok = true;
  } catch (error) {
    row.error = error?.message || 'could not be applied.';
  }

  return row;
}

/**
 * A whole pack, checked before any of it is applied.
 *
 * Top-level problems stop the check: there is no point reporting on the
 * modules of a file that is not a pack.
 */
export function checkCasePack(rawPack) {
  const result = { ok: false, clientName: '', errors: [], modules: [] };

  if (!rawPack || typeof rawPack !== 'object' || Array.isArray(rawPack)) {
    result.errors.push('Case pack must be a JSON object.');
    return result;
  }

  if (rawPack.casePackVersion !== CASE_PACK_VERSION) {
    result.errors.push(`casePackVersion must be ${CASE_PACK_VERSION}.`);
  }

  if (typeof rawPack.clientName !== 'string' || !rawPack.clientName.trim()) {
    result.errors.push('clientName is required and must be a non-empty string.');
  } else {
    result.clientName = rawPack.clientName.trim();
  }

  if (!Array.isArray(rawPack.modules) || rawPack.modules.length === 0) {
    result.errors.push('modules is required and must be a non-empty array.');
  }

  const unknown = Object.keys(rawPack).filter((key) => !CASE_PACK_KEYS.includes(key));
  if (unknown.length > 0) {
    result.errors.push(`Unknown case pack ${unknown.length === 1 ? 'key' : 'keys'}: ${unknown.sort().join(', ')}.`);
  }

  if (result.errors.length > 0) {
    return result;
  }

  const total = rawPack.modules.length;
  result.modules = rawPack.modules.map((payload, index) => (
    checkModulePayload(payload, { number: index + 1, total })
  ));
  result.ok = result.modules.every((row) => row.ok);
  return result;
}

/** The first thing wrong with a pack, named the way the panel reports it. */
export function firstCasePackProblem(result) {
  if (result.errors.length > 0) {
    return result.errors[0];
  }

  const failed = result.modules.find((row) => !row.ok);
  return failed
    ? `${casePackModuleLabel(failed.number, failed.total, failed.title)}: ${failed.error}`
    : '';
}

/** Auto-repairs across a pack, each one carrying the module it came from. */
export function casePackWarnings(result) {
  return result.modules.flatMap((row) => row.warnings.map((warning) => (
    `${casePackModuleLabel(row.number, row.total, row.title)}: ${warning}`
  )));
}

/**
 * A liquidity plan turned into the reserve calculation the card draws.
 *
 * Here rather than in the renderer so a check can ask a plan how many months
 * of cover it has and get the screen's answer, not its own.
 */
export function resolveLiquidityReserveForPlan(plan = {}) {
  const clientStatus = getLiquidityClientStatus(plan);
  const policy = resolveLiquidityReservePolicy(clientStatus);
  const minimumBufferMonths = getPositiveFiniteNumber(plan.minimumBufferMonths)
    ?? policy.minimumBufferMonths;
  const rawTargetMonths = getPositiveFiniteNumber(plan.targetBufferMonths)
    ?? policy.targetBufferMonths;
  const targetBufferMonths = Math.max(rawTargetMonths, minimumBufferMonths);
  const currentCash = getFiniteNumber(plan.currentCash);
  const monthlyExpenditure = getLiquidityMonthlyExpenditure(plan);

  return {
    clientStatus,
    policy,
    minimumBufferMonths,
    targetBufferMonths,
    currentCash,
    monthlyExpenditure,
    reserve: computeLiquidityReserve({
      currentCash,
      monthlyExpenditure,
      clientStatus,
      minimumBufferMonths,
      targetBufferMonths
    })
  };
}
