import {
  loadSession,
  createStateManager,
  getModuleById,
  getOrderedModules,
  ensureActiveModule,
  createEmptyGenerated,
  normalizeGenerated,
  exportSession,
  importSession,
  newSession
} from './state.js';
import { computeBestOverviewLayout } from './layout.js';
import {
  zoomToModuleFromOverview,
  zoomOutToOverview,
  getIsZoomAnimating
} from './zoom.js';
import { mountInitialPane, swipeToPane } from './swipe.js';
import { renderChartsForPane, cleanupDetachedCharts, destroyAllCharts } from './charts.js';
import {
  getUiElements,
  renderGreeting,
  buildFocusedPane,
  renderOverview,
  setMode,
  updateControls,
  updateSessionStatus,
  getFocusedCardElement,
  getOverviewCardElement,
  ensureLayerVisibleForMeasure
} from './render.js';
import { normalizePensionInputs, computePensionProjection } from './pension_math.js';

const ui = getUiElements();
const stateManager = createStateManager(300, {
  onDirtyChange: (isDirty) => {
    updateSessionStatus(ui, isDirty);
  }
});

const appState = {
  session: loadSession(),
  mode: 'greeting',
  sortable: null,
  transitionLock: false,
  devPanelOpen: false,
  pensionShowMaxByModuleId: new Map(),
  chartHydrationRunId: 0
};

const EXAMPLE_PAYLOADS = [
  {
    id: 'summary-kpis',
    label: 'Summary + KPI Charts',
    payload: {
      title: 'Q2 Revenue and Margin Outlook',
      generated: {
        summaryHtml: '<p><strong>Headline:</strong> Revenue is tracking above plan while margin remains stable under current spend assumptions.</p><ul><li>Upside driven by enterprise segment.</li><li>Primary risk is slower onboarding in mid-market.</li></ul>',
        assumptions: {
          columns: ['Assumption', 'Value', 'Notes'],
          rows: [
            ['Pipeline conversion', '32%', 'Assumes stronger outbound response'],
            ['Avg contract value', '$42,000', 'Weighted enterprise mix'],
            ['CAC growth', '4%', 'Conservative against Q1 baseline']
          ]
        },
        outputs: {
          columns: ['Metric', 'Q1 Actual', 'Q2 Forecast'],
          rows: [
            ['Revenue', 1.9, 2.2],
            ['Gross Margin %', 58, 59],
            ['New Logos', 28, 35]
          ]
        },
        charts: [
          {
            title: 'Revenue by Month',
            type: 'line',
            labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
            datasets: [
              { label: 'Actual / Forecast', data: [0.54, 0.62, 0.74, 0.69, 0.78, 0.82] }
            ]
          },
          {
            title: 'Segment Contribution',
            type: 'bar',
            labels: ['Enterprise', 'Mid-Market', 'SMB'],
            datasets: [
              { label: 'Q2', data: [1.12, 0.72, 0.36] }
            ]
          }
        ]
      }
    }
  },
  {
    id: 'scenario',
    label: 'Scenario Comparison',
    payload: {
      title: 'Scenario Planning Snapshot',
      generated: {
        summaryHtml: '<p>We modeled <em>base</em>, <em>upside</em>, and <em>downside</em> outcomes. Base case still clears target ARR with room for efficiency gains.</p>',
        assumptions: {
          columns: ['Scenario', 'Win Rate', 'Spend Delta'],
          rows: [
            ['Base', '31%', '+2%'],
            ['Upside', '35%', '+4%'],
            ['Downside', '26%', '0%']
          ]
        },
        outputs: {
          columns: ['Scenario', 'ARR', 'EBITDA'],
          rows: [
            ['Base', 4.8, 1.1],
            ['Upside', 5.4, 1.3],
            ['Downside', 4.1, 0.8]
          ]
        },
        charts: [
          {
            title: 'ARR by Scenario',
            type: 'bar',
            labels: ['Base', 'Upside', 'Downside'],
            datasets: [
              { label: 'ARR ($M)', data: [4.8, 5.4, 4.1] }
            ]
          }
        ]
      }
    }
  }
];

const PLAYBOOKS = [
  {
    id: 'personal_balance_sheet',
    name: 'Personal Balance Sheet',
    payload: {
      title: 'Personal Balance Sheet',
      generated: {
        summaryHtml: '<p>We grouped your assets into four buckets &mdash; Lifestyle, Liquidity, Longevity and Legacy &mdash; to separate essential lifestyle assets from liquid reserves, long-term retirement assets, and higher-risk/illiquid holdings. Below we summarise totals by bucket, total liabilities, and estimated net worth.</p>',
        assumptions: {
          columns: ['Bucket', 'Purpose', 'Examples'],
          rows: [
            ['Lifestyle', 'Assets you use to live on; not relied on for investment returns', 'Home, holiday home'],
            ['Liquidity', 'Highly liquid, low-risk reserves', 'Cash, savings, money market funds'],
            ['Longevity', 'Diversified long-term return assets for goals/retirement', 'Pensions, diversified portfolios, multi-asset funds'],
            ['Legacy', 'Concentrated/illiquid/high-vol assets for long horizon / generational wealth', 'Single stocks, crypto, structured products, art/watches, private business']
          ]
        },
        outputs: {
          columns: ['Metric', 'Amount (€)', 'Notes'],
          rows: [
            ['Total gross assets', '', ''],
            ['Total liabilities', '', ''],
            ['Net worth', '', 'Net worth = assets − liabilities'],
            ['Lifestyle total', '', ''],
            ['Liquidity total', '', ''],
            ['Longevity total', '', ''],
            ['Legacy total', '', '']
          ]
        },
        charts: [
          {
            title: 'Assets by bucket (€)',
            type: 'bar',
            labels: ['Lifestyle', 'Liquidity', 'Longevity', 'Legacy'],
            datasets: [
              { label: '€', data: [0, 0, 0, 0] }
            ]
          },
          {
            title: 'Gross assets vs liabilities vs net worth (€)',
            type: 'bar',
            labels: ['Gross assets', 'Liabilities', 'Net worth'],
            datasets: [
              { label: '€', data: [0, 0, 0] }
            ]
          }
        ]
      }
    }
  }
];

function nowIso() {
  return new Date().toISOString();
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function makeModuleId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
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

function createBlankModule() {
  const timestamp = nowIso();
  return {
    id: makeModuleId(),
    createdAt: timestamp,
    updatedAt: timestamp,
    title: '',
    notes: '',
    generated: createEmptyGenerated()
  };
}

function getModulesInOrder() {
  return getOrderedModules(appState.session);
}

function getActiveIndex() {
  return appState.session.order.indexOf(appState.session.activeModuleId);
}

function hasModules() {
  return appState.session.modules.length > 0;
}

function normalizeClientName(value) {
  return value.trim();
}

function ensureGenerated(module) {
  if (!module.generated || typeof module.generated !== 'object') {
    module.generated = createEmptyGenerated();
  }

  module.generated = normalizeGenerated(module.generated);
}

function showToast(message, type = 'success') {
  if (!ui.toastHost) {
    return;
  }

  const toast = document.createElement('div');
  toast.className = `toast${type === 'error' ? ' error' : ''}`;
  toast.textContent = message;

  ui.toastHost.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 2600);
}

function setDevPanelOpen(open) {
  appState.devPanelOpen = open;

  if (!ui.devPanel) {
    return;
  }

  ui.devPanel.classList.toggle('is-hidden', !open);
  ui.devPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function populateDevExamples() {
  if (!ui.devExampleSelect) {
    return;
  }

  ui.devExampleSelect.innerHTML = '';

  EXAMPLE_PAYLOADS.forEach((example) => {
    const option = document.createElement('option');
    option.value = example.id;
    option.textContent = example.label;
    ui.devExampleSelect.appendChild(option);
  });
}

function populatePlaybooks() {
  if (!ui.playbookSelect) {
    return;
  }

  ui.playbookSelect.innerHTML = '';

  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.textContent = 'Playbooks';
  ui.playbookSelect.appendChild(placeholderOption);

  PLAYBOOKS.forEach((playbook) => {
    const option = document.createElement('option');
    option.value = playbook.id;
    option.textContent = playbook.name;
    ui.playbookSelect.appendChild(option);
  });

  ui.playbookSelect.value = '';
}

function loadSelectedExampleIntoEditor() {
  if (!ui.devExampleSelect || !ui.devPayloadInput) {
    return;
  }

  const selected = EXAMPLE_PAYLOADS.find((example) => example.id === ui.devExampleSelect.value) || EXAMPLE_PAYLOADS[0];
  if (!selected) {
    return;
  }

  ui.devPayloadInput.value = JSON.stringify(selected.payload, null, 2);
}

function normalizeEditorJsonInput(rawInput) {
  return String(rawInput ?? '')
    .trim()
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2018|\u2019/g, '\'');
}

const AUTO_SFT_SPAN_PATTERN = /<span\b[^>]*\bdata-auto=(["'])sft\1[^>]*>[\s\S]*?<\/span>/gi;

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
    .replace(/\s+<\/p>/gi, '</p>')
    .trim();
}

function injectAutoSftSummarySentence(summaryHtml, sftSentence) {
  const cleaned = removeAutoSftSummarySpan(summaryHtml);
  if (!sftSentence) {
    return cleaned;
  }

  const sftSpan = `<span data-auto=\"sft\">${escapeHtmlText(sftSentence)}</span>`;

  if (!cleaned) {
    return `<p>${sftSpan}</p>`;
  }

  const firstParagraphCloseMatch = /<\/p>/i.exec(cleaned);
  if (!firstParagraphCloseMatch || typeof firstParagraphCloseMatch.index !== 'number') {
    return `${cleaned}<p>${sftSpan}</p>`;
  }

  const closeTagIndex = firstParagraphCloseMatch.index;
  return `${cleaned.slice(0, closeTagIndex)} ${sftSpan}${cleaned.slice(closeTagIndex)}`;
}

function getPlaybookById(playbookId) {
  return PLAYBOOKS.find((playbook) => playbook.id === playbookId) || null;
}

function isPersonalBalanceSheetModule(module) {
  const title = typeof module?.title === 'string' ? module.title.toLowerCase() : '';
  return title.includes('personal balance sheet');
}

function sanitizeFilenameToken(input, fallback) {
  const raw = String(input || fallback || '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function getSessionDownloadFilename(session) {
  const clientToken = sanitizeFilenameToken(session.clientName, 'Client');
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');

  return `CallCanvas_${clientToken}_${yyyy}-${mm}-${dd}_${hh}${min}.json`;
}

function downloadJsonFile(filename, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function replaceSession(nextSession, options = {}) {
  const { markClean = true } = options;

  destroySortable();
  destroyAllCharts();

  appState.transitionLock = false;
  appState.session = nextSession;
  appState.pensionShowMaxByModuleId = new Map();

  ensureActiveModule(appState.session);
  stateManager.saveNow(appState.session);

  if (markClean) {
    stateManager.markClean();
  }

  renderGreeting(ui, appState.session.clientName);

  if (appState.session.modules.length > 0) {
    appState.mode = 'focused';
    await renderFocused({ useSwipe: false, revealMode: true });
  } else {
    appState.mode = 'greeting';
    setMode(ui, 'greeting');
    updateUiChrome();
  }

  cleanupDetachedCharts();
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

function validateOutputsBucketedPayload(outputsBucketed, label = 'generated.outputsBucketed') {
  if (!outputsBucketed || typeof outputsBucketed !== 'object' || Array.isArray(outputsBucketed)) {
    throw new Error(`${label} must be an object with sections[].`);
  }

  if (!Array.isArray(outputsBucketed.sections)) {
    throw new Error(`${label}.sections must be an array.`);
  }

  const sections = outputsBucketed.sections.map((section, sectionIndex) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new Error(`${label}.sections[${sectionIndex}] must be an object.`);
    }

    if (typeof section.title !== 'string' || !section.title.trim()) {
      throw new Error(`${label}.sections[${sectionIndex}].title must be a non-empty string.`);
    }

    if (!Array.isArray(section.columns) || section.columns.length !== 2) {
      throw new Error(`${label}.sections[${sectionIndex}].columns must be an array of exactly 2 strings.`);
    }

    const columns = section.columns.map((column, columnIndex) => {
      if (typeof column !== 'string') {
        throw new Error(`${label}.sections[${sectionIndex}].columns[${columnIndex}] must be a string.`);
      }
      return column;
    });

    if (!Array.isArray(section.rows)) {
      throw new Error(`${label}.sections[${sectionIndex}].rows must be an array.`);
    }

    const rows = section.rows.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== 2) {
        throw new Error(`${label}.sections[${sectionIndex}].rows[${rowIndex}] must be [string, number].`);
      }

      if (typeof row[0] !== 'string') {
        throw new Error(`${label}.sections[${sectionIndex}].rows[${rowIndex}][0] must be a string.`);
      }

      if (typeof row[1] !== 'number' || !Number.isFinite(row[1])) {
        throw new Error(`${label}.sections[${sectionIndex}].rows[${rowIndex}][1] must be a finite number.`);
      }

      return [row[0], row[1]];
    });

    const key = typeof section.key === 'string' && section.key.trim()
      ? section.key.trim().toLowerCase()
      : `section_${sectionIndex + 1}`;
    const title = section.title.trim();
    const isSummary = key === 'summary' || title.toLowerCase() === 'summary';
    const hasSubtotal = 'subtotalValue' in section;

    if (!isSummary && !hasSubtotal) {
      throw new Error(`${label}.sections[${sectionIndex}].subtotalValue is required for non-summary sections.`);
    }

    let subtotalValue = null;
    if (hasSubtotal) {
      if (typeof section.subtotalValue !== 'number' || !Number.isFinite(section.subtotalValue)) {
        throw new Error(`${label}.sections[${sectionIndex}].subtotalValue must be a finite number.`);
      }
      subtotalValue = section.subtotalValue;
    }

    if ('notes' in section && typeof section.notes !== 'string') {
      throw new Error(`${label}.sections[${sectionIndex}].notes must be a string when provided.`);
    }

    return {
      key,
      title,
      columns,
      rows,
      subtotalLabel: typeof section.subtotalLabel === 'string' && section.subtotalLabel.trim()
        ? section.subtotalLabel
        : 'Subtotal',
      subtotalValue,
      notes: typeof section.notes === 'string' ? section.notes : ''
    };
  });

  return {
    currencySymbol: typeof outputsBucketed.currencySymbol === 'string' && outputsBucketed.currencySymbol.trim()
      ? outputsBucketed.currencySymbol
      : '€',
    sections
  };
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

    return {
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

        return {
          label: typeof dataset.label === 'string' ? dataset.label : `Series ${datasetIndex + 1}`,
          data: dataset.data.map((value) => {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
              throw new Error(`Chart ${index + 1} contains non-numeric data.`);
            }
            return value;
          })
        };
      })
    };
  });
}

function validatePensionInputsPayload(pensionInputs) {
  return normalizePensionInputs(pensionInputs);
}

function normalizePayload(payload) {
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

    if ('charts' in payload.generated) {
      generatedPatch.charts = validateChartsPayload(payload.generated.charts);
    }

    if ('pensionInputs' in payload.generated) {
      generatedPatch.pensionInputs = validatePensionInputsPayload(payload.generated.pensionInputs);
    }

    normalized.generated = generatedPatch;
  }

  if (!('title' in normalized) && !('generated' in normalized)) {
    throw new Error('Payload must include at least one of: title, generated.');
  }

  return normalized;
}

function hydrateChartsForActivePane() {
  const activeModule = getModuleById(appState.session, appState.session.activeModuleId);
  const activePane = ui.swipeStage.querySelector('.swipe-pane.active');

  if (!activeModule || !activePane) {
    cleanupDetachedCharts();
    return;
  }

  renderChartsForPane(activePane, activeModule, {
    clientName: appState.session.clientName || 'Client',
    moduleTitle: activeModule.title?.trim() || 'Untitled Module'
  });
}

function summarizeHydrationSnapshot(snapshot) {
  const paneRect = snapshot?.paneRect
    ? {
      width: Number(snapshot.paneRect.width.toFixed(2)),
      height: Number(snapshot.paneRect.height.toFixed(2))
    }
    : null;

  return {
    zoomAnimating: Boolean(snapshot?.zoomAnimating),
    paneConnected: Boolean(snapshot?.pane?.isConnected),
    paneVisible: Boolean(snapshot?.paneVisible),
    paneOpacityVisible: Boolean(snapshot?.paneOpacityVisible),
    paneRect,
    paneOpacity: snapshot?.paneOpacity ?? null,
    paneTransform: snapshot?.paneTransform ?? null,
    stageTransform: snapshot?.stageTransform ?? null,
    focusTransform: snapshot?.focusTransform ?? null
  };
}

function getActivePaneHydrationSnapshot() {
  const zoomAnimating = getIsZoomAnimating();
  const pane = ui.swipeStage?.querySelector('.swipe-pane.active') || null;

  if (!pane) {
    return {
      zoomAnimating,
      pane,
      paneRect: null,
      paneVisible: false,
      paneOpacityVisible: false,
      paneOpacity: null,
      paneTransform: null,
      stageTransform: null,
      focusTransform: null,
      isStable: false
    };
  }

  const paneStyle = window.getComputedStyle(pane);
  const stageStyle = ui.swipeStage ? window.getComputedStyle(ui.swipeStage) : null;
  const focusStyle = ui.focusLayer ? window.getComputedStyle(ui.focusLayer) : null;
  const paneRect = pane.getBoundingClientRect();
  const paneVisible = pane.isConnected
    && pane.offsetWidth > 0
    && pane.offsetHeight > 0
    && paneRect.width > 0
    && paneRect.height > 0;
  const opacityNumber = Number.parseFloat(paneStyle.opacity);
  const paneOpacityVisible = paneStyle.opacity !== '0'
    && (!Number.isFinite(opacityNumber) || opacityNumber > 0);
  const paneTransform = paneStyle.transform || 'none';
  const stageTransform = stageStyle?.transform || 'none';
  const focusTransform = focusStyle?.transform || 'none';
  const isStable = !zoomAnimating
    && paneVisible
    && paneOpacityVisible
    && paneTransform === 'none'
    && stageTransform === 'none'
    && focusTransform === 'none';

  return {
    zoomAnimating,
    pane,
    paneRect,
    paneVisible,
    paneOpacityVisible,
    paneOpacity: paneStyle.opacity,
    paneTransform,
    stageTransform,
    focusTransform,
    isStable
  };
}

async function hydrateChartsWhenStable({ reason = 'unknown' } = {}) {
  const runId = ++appState.chartHydrationRunId;
  const maxFrames = 60;

  await nextFrame();
  await nextFrame();

  for (let attempt = 1; attempt <= maxFrames; attempt += 1) {
    if (runId !== appState.chartHydrationRunId) {
      return false;
    }

    const snapshot = getActivePaneHydrationSnapshot();

    if (attempt === 1) {
      console.info('[CallCanvas][Charts] hydration wait start', {
        reason,
        ...summarizeHydrationSnapshot(snapshot)
      });
    }

    if (snapshot.isStable) {
      hydrateChartsForActivePane();
      console.info('[CallCanvas][Charts] hydration wait complete', {
        reason,
        attempts: attempt,
        ...summarizeHydrationSnapshot(snapshot)
      });
      return true;
    }

    await nextFrame();
  }

  if (runId !== appState.chartHydrationRunId) {
    return false;
  }

  const finalSnapshot = getActivePaneHydrationSnapshot();
  console.warn('[CallCanvas][Charts] hydration wait capped; hydrating anyway', {
    reason,
    attempts: maxFrames,
    ...summarizeHydrationSnapshot(finalSnapshot)
  });
  hydrateChartsForActivePane();
  return false;
}

function getPensionShowMaxForModule(moduleId) {
  if (typeof moduleId !== 'string' || !moduleId) {
    return false;
  }

  return appState.pensionShowMaxByModuleId.get(moduleId) ?? false;
}

function setPensionShowMaxForModule(moduleId, value) {
  if (typeof moduleId !== 'string' || !moduleId) {
    return;
  }

  appState.pensionShowMaxByModuleId.set(moduleId, Boolean(value));

  if (appState.mode === 'focused' && appState.session.activeModuleId === moduleId) {
    void hydrateChartsWhenStable({ reason: 'pension-toggle' });
  }
}

function updateModule(moduleId, patch) {
  const module = getModuleById(appState.session, moduleId);
  if (!module) {
    return;
  }

  ensureGenerated(module);
  Object.assign(module, patch);
  module.updatedAt = nowIso();
  stateManager.scheduleSave(appState.session);

  if (appState.mode === 'overview') {
    refreshOverview({ enableSortable: true });
  }
}

function updateUiChrome() {
  const activeIndex = getActiveIndex();
  updateControls(ui, {
    mode: appState.mode,
    moduleCount: appState.session.modules.length,
    hasPrevious: activeIndex > 0
  });

  renderGreeting(ui, appState.session.clientName);
}

function getFocusedPaneForModule(module) {
  const moduleNumber = Math.max(1, appState.session.order.indexOf(module.id) + 1);

  ensureGenerated(module);

  return buildFocusedPane({
    module,
    moduleNumber,
    onTitleInput: (moduleId, value) => updateModule(moduleId, { title: value }),
    onNotesInput: (moduleId, value) => updateModule(moduleId, { notes: value })
  });
}

async function renderFocused({
  useSwipe = true,
  direction = 'forward',
  revealMode = true,
  deferCharts = false
} = {}) {
  ensureActiveModule(appState.session);

  if (!hasModules()) {
    appState.mode = 'greeting';
    ui.swipeStage.innerHTML = '';
    destroyAllCharts();
    setMode(ui, 'greeting');
    updateUiChrome();
    return;
  }

  const activeModule = getModuleById(appState.session, appState.session.activeModuleId);
  if (!activeModule) {
    return;
  }

  const pane = getFocusedPaneForModule(activeModule);

  if (useSwipe) {
    await swipeToPane(ui.swipeStage, pane, direction);
  } else {
    mountInitialPane(ui.swipeStage, pane);
  }

  if (revealMode) {
    appState.mode = 'focused';
    setMode(ui, 'focused');
    updateUiChrome();
  }

  if (!deferCharts) {
    const reason = useSwipe ? 'swipe-to-pane' : (revealMode ? 'renderFocused-visible' : 'renderFocused');
    await hydrateChartsWhenStable({ reason });
  }
}

function refreshOverview({ enableSortable = appState.mode === 'overview' } = {}) {
  const modules = getModulesInOrder();

  const width = ui.overviewViewport.clientWidth;
  const height = ui.overviewViewport.clientHeight;
  const layout = computeBestOverviewLayout(modules.length, width, height, {
    maxCols: 6,
    gap: width < 900 ? 14 : 18,
    outerPadding: width < 900 ? 22 : 36
  });

  renderOverview({
    ui,
    modules,
    activeModuleId: appState.session.activeModuleId,
    layout,
    viewportWidth: width,
    viewportHeight: height,
    onCardClick: async (moduleId, cardEl) => {
      await zoomIntoModuleFromOverview(moduleId, cardEl);
    }
  });

  if (enableSortable) {
    initSortable();
  }
}

function destroySortable() {
  if (appState.sortable) {
    appState.sortable.destroy();
    appState.sortable = null;
  }
}

function initSortable() {
  destroySortable();

  if (typeof window.Sortable === 'undefined') {
    return;
  }

  if (appState.session.modules.length < 2 || appState.mode !== 'overview') {
    return;
  }

  appState.sortable = window.Sortable.create(ui.overviewGrid, {
    animation: 180,
    ghostClass: 'overview-drag-ghost',
    chosenClass: 'overview-drag-chosen',
    dragClass: 'overview-drag-dragging',
    onEnd: () => {
      const nextOrder = [...ui.overviewGrid.querySelectorAll('.overview-card')]
        .map((card) => card.dataset.moduleId)
        .filter(Boolean);

      if (nextOrder.length === appState.session.order.length) {
        appState.session.order = nextOrder;
        ensureActiveModule(appState.session);
        stateManager.scheduleSave(appState.session);
      }

      refreshOverview({ enableSortable: true });
    }
  });
}

async function zoomIntoModuleFromOverview(moduleId, sourceCardEl) {
  if (
    appState.transitionLock ||
    appState.mode !== 'overview' ||
    !moduleId ||
    !sourceCardEl ||
    getIsZoomAnimating()
  ) {
    return;
  }

  const targetModule = getModuleById(appState.session, moduleId);
  if (!targetModule) {
    return;
  }

  appState.transitionLock = true;
  destroySortable();
  appState.session.activeModuleId = moduleId;

  const completed = await zoomToModuleFromOverview(moduleId, sourceCardEl, {
    overviewLayer: ui.overviewLayer,
    focusLayer: ui.focusLayer,
    animLayer: ui.animLayer,
    prepareFocusTarget: async () => {
      await renderFocused({ useSwipe: false, revealMode: false, deferCharts: true });
      ensureLayerVisibleForMeasure(ui.focusLayer);
      ui.focusLayer.style.visibility = 'hidden';
      ui.focusLayer.style.opacity = '0';
      await nextFrame();
      return getFocusedCardElement(ui);
    }
  });

  if (completed) {
    appState.mode = 'focused';
    setMode(ui, 'focused');
    updateUiChrome();
    await hydrateChartsWhenStable({ reason: 'zoom-into-completed' });
    stateManager.scheduleSave(appState.session);
  }

  appState.transitionLock = false;
}

async function zoomOutToOverviewMode() {
  if (appState.transitionLock || appState.mode === 'overview' || !hasModules() || getIsZoomAnimating()) {
    return;
  }

  appState.transitionLock = true;
  destroySortable();

  const moduleId = appState.session.activeModuleId;

  const completed = await zoomOutToOverview({
    moduleId,
    overviewLayer: ui.overviewLayer,
    focusLayer: ui.focusLayer,
    animLayer: ui.animLayer,
    getFocusSource: () => getFocusedCardElement(ui),
    prepareOverviewTarget: async (activeModuleId) => {
      ensureLayerVisibleForMeasure(ui.overviewLayer);
      refreshOverview({ enableSortable: false });
      await nextFrame();
      return getOverviewCardElement(ui, activeModuleId)
        || ui.overviewGrid.querySelector('.overview-card');
    }
  });

  if (completed) {
    destroyAllCharts();
    appState.mode = 'overview';
    setMode(ui, 'overview');
    updateUiChrome();
    initSortable();
  }

  appState.transitionLock = false;
}

async function toggleOverview() {
  if (!hasModules() || appState.transitionLock || getIsZoomAnimating()) {
    return;
  }

  if (appState.mode === 'overview') {
    const sourceCardEl = getOverviewCardElement(ui, appState.session.activeModuleId)
      || ui.overviewGrid.querySelector('.overview-card');
    await zoomIntoModuleFromOverview(appState.session.activeModuleId, sourceCardEl);
    return;
  }

  await zoomOutToOverviewMode();
}

async function createNewModule() {
  if (appState.transitionLock || getIsZoomAnimating()) {
    return null;
  }

  const module = createBlankModule();
  appState.session.modules.push(module);
  appState.session.order.push(module.id);
  appState.session.activeModuleId = module.id;

  stateManager.scheduleSave(appState.session);

  if (appState.mode === 'overview') {
    refreshOverview({ enableSortable: false });
    await nextFrame();
    const sourceCardEl = getOverviewCardElement(ui, module.id)
      || ui.overviewGrid.querySelector(`.overview-card[data-module-id="${module.id}"]`);
    await zoomIntoModuleFromOverview(module.id, sourceCardEl);
    return module.id;
  }

  appState.mode = 'focused';
  setMode(ui, 'focused');

  await renderFocused({
    useSwipe: true,
    direction: 'forward',
    revealMode: true
  });

  return module.id;
}

async function createModuleFromPlaybook(playbookId) {
  const playbook = getPlaybookById(playbookId);
  if (!playbook) {
    throw new Error(`Playbook not found: ${playbookId}`);
  }

  await applyModuleUpdateInternal(playbook.payload, { createNewModule: true });
  return playbook;
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

  if ('pensionInputs' in generatedPatch) {
    module.generated.pensionInputs = generatedPatch.pensionInputs;
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

  if ('charts' in generatedPatch) {
    module.generated.charts = generatedPatch.charts.map((chart, index) => ({
      ...chart,
      id: chart.id || makeChartId(module.id, chart.title, index)
    }));
  }
}

async function applyModuleUpdateInternal(payload, options = {}) {
  const normalizedPayload = normalizePayload(payload);

  let targetModuleId = options.targetModuleId || normalizedPayload.moduleId || appState.session.activeModuleId;

  if (options.createNewModule) {
    const newModuleId = await createNewModule();
    if (!newModuleId) {
      throw new Error('Unable to create a new module while a transition is active.');
    }
    targetModuleId = newModuleId;
  }

  if (!targetModuleId) {
    throw new Error('No active module found. Create a module first, or provide moduleId.');
  }

  const module = getModuleById(appState.session, targetModuleId);
  if (!module) {
    throw new Error(`Module not found: ${targetModuleId}`);
  }

  if ('title' in normalizedPayload) {
    module.title = normalizedPayload.title;
  }

  if (normalizedPayload.generated) {
    mergeGeneratedPatch(module, normalizedPayload.generated);

    if ('pensionInputs' in normalizedPayload.generated && module.generated.pensionInputs) {
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
      module.generated.summaryHtml = injectAutoSftSummarySentence(
        module.generated.summaryHtml,
        projection.debug.sftSentence
      );

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
    }
  }

  module.updatedAt = nowIso();

  if (appState.session.activeModuleId === module.id && appState.mode === 'focused') {
    await renderFocused({ useSwipe: false, revealMode: true });
  }

  if (appState.mode === 'overview') {
    refreshOverview({ enableSortable: true });
  }

  stateManager.markDirty();
  stateManager.saveNow(appState.session);

  const activeModule = getModuleById(appState.session, appState.session.activeModuleId);
  if (activeModule?.generated) {
    const hasOutputsBucketed = Boolean(
      activeModule.generated.outputsBucketed
      && typeof activeModule.generated.outputsBucketed === 'object'
      && !Array.isArray(activeModule.generated.outputsBucketed)
    );
    const hasOutputs = Boolean(
      activeModule.generated.outputs
      && Array.isArray(activeModule.generated.outputs.columns)
      && Array.isArray(activeModule.generated.outputs.rows)
    );

    console.info('[CallCanvas] applyModuleUpdate generated state', {
      moduleId: activeModule.id,
      hasOutputsBucketed,
      hasOutputs
    });
  }

  return {
    ok: true,
    moduleId: module.id
  };
}

async function applyPayloadFromEditor({ createNewModuleFirst }) {
  if (!ui.devPayloadInput) {
    return;
  }

  let parsed;
  try {
    const normalizedInput = normalizeEditorJsonInput(ui.devPayloadInput.value || '{}');
    ui.devPayloadInput.value = normalizedInput;
    parsed = JSON.parse(normalizedInput || '{}');
  } catch (_error) {
    showToast('Invalid JSON (check quotes)', 'error');
    return;
  }

  try {
    await applyModuleUpdateInternal(parsed, { createNewModule: createNewModuleFirst });
    showToast('Payload applied successfully.');
  } catch (error) {
    showToast(error.message || 'Failed to apply payload.', 'error');
  }
}

async function focusPreviousModule() {
  if (appState.transitionLock || appState.mode !== 'focused' || getIsZoomAnimating()) {
    return;
  }

  const activeIndex = getActiveIndex();
  if (activeIndex <= 0) {
    return;
  }

  appState.session.activeModuleId = appState.session.order[activeIndex - 1];
  stateManager.scheduleSave(appState.session);

  await renderFocused({
    useSwipe: true,
    direction: 'backward',
    revealMode: true
  });
}

async function handleSaveSession() {
  try {
    stateManager.saveNow(appState.session);
    const json = exportSession(appState.session);
    const filename = getSessionDownloadFilename(appState.session);
    downloadJsonFile(filename, json);
    stateManager.markClean();
    showToast('Session saved.');
  } catch (_error) {
    showToast('Failed to save session.', 'error');
  }
}

async function handleLoadSessionFromFile(file) {
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const imported = importSession(text);
    await replaceSession(imported, { markClean: true });
    showToast('Session loaded.');
  } catch (_error) {
    showToast('Invalid session file.', 'error');
  }
}

async function handleNewCall() {
  const confirmed = window.confirm('Start a new call? Unsaved changes will be lost unless you save.');
  if (!confirmed) {
    return;
  }

  const fresh = newSession('Client');
  await replaceSession(fresh, { markClean: true });
  showToast('New call started.');
}

function bindEvents() {
  ui.clientNameInput.addEventListener('input', (event) => {
    appState.session.clientName = normalizeClientName(event.target.value);
    renderGreeting(ui, appState.session.clientName);
    stateManager.scheduleSave(appState.session);
  });

  if (ui.newCallButton) {
    ui.newCallButton.addEventListener('click', async () => {
      await handleNewCall();
    });
  }

  if (ui.saveSessionButton) {
    ui.saveSessionButton.addEventListener('click', async () => {
      await handleSaveSession();
    });
  }

  if (ui.loadSessionButton) {
    ui.loadSessionButton.addEventListener('click', () => {
      if (ui.loadSessionInput) {
        ui.loadSessionInput.value = '';
        ui.loadSessionInput.click();
      }
    });
  }

  if (ui.loadSessionInput) {
    ui.loadSessionInput.addEventListener('change', async (event) => {
      const fileInput = event.target;
      const file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      await handleLoadSessionFromFile(file);
      fileInput.value = '';
    });
  }

  if (ui.playbookSelect) {
    ui.playbookSelect.addEventListener('change', async (event) => {
      const playbookId = event.target.value;
      if (!playbookId) {
        return;
      }

      try {
        const playbook = await createModuleFromPlaybook(playbookId);
        showToast(`${playbook.name} module created.`);
      } catch (error) {
        showToast(error.message || 'Failed to apply playbook.', 'error');
      } finally {
        event.target.value = '';
      }
    });
  }

  ui.newModuleButton.addEventListener('click', async () => {
    await createNewModule();
  });

  ui.nextArrowButton.addEventListener('click', async () => {
    await createNewModule();
  });

  ui.prevArrowButton.addEventListener('click', async () => {
    await focusPreviousModule();
  });

  ui.zoomButton.addEventListener('click', async () => {
    await toggleOverview();
  });

  ui.resetButton.addEventListener('click', () => {
    destroyAllCharts();
    stateManager.reset();
    window.location.reload();
  });

  if (ui.devLoadExampleBtn) {
    ui.devLoadExampleBtn.addEventListener('click', () => {
      loadSelectedExampleIntoEditor();
    });
  }

  if (ui.devClearBtn) {
    ui.devClearBtn.addEventListener('click', () => {
      if (ui.devPayloadInput) {
        ui.devPayloadInput.value = '';
      }
    });
  }

  if (ui.devApplyBtn) {
    ui.devApplyBtn.addEventListener('click', async () => {
      await applyPayloadFromEditor({ createNewModuleFirst: false });
    });
  }

  if (ui.devCreateApplyBtn) {
    ui.devCreateApplyBtn.addEventListener('click', async () => {
      await applyPayloadFromEditor({ createNewModuleFirst: true });
    });
  }

  if (ui.devCloseBtn) {
    ui.devCloseBtn.addEventListener('click', () => {
      setDevPanelOpen(false);
    });
  }

  window.addEventListener('resize', () => {
    cleanupDetachedCharts();
    if (appState.mode === 'overview') {
      refreshOverview({ enableSortable: true });
    }
  });

  window.addEventListener('keydown', async (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    );

    const key = event.key;
    const lower = key.toLowerCase();

    if (!typing && lower === 'd') {
      event.preventDefault();
      setDevPanelOpen(!appState.devPanelOpen);
      return;
    }

    if (typing && key !== 'Escape') {
      return;
    }

    if (lower === 'n') {
      event.preventDefault();
      await createNewModule();
      return;
    }

    if (lower === 'o') {
      event.preventDefault();
      await toggleOverview();
      return;
    }

    if (key === 'ArrowRight') {
      event.preventDefault();
      await createNewModule();
      return;
    }

    if (key === 'ArrowLeft') {
      event.preventDefault();
      await focusPreviousModule();
      return;
    }

    if (key === 'Escape' && appState.devPanelOpen) {
      event.preventDefault();
      setDevPanelOpen(false);
      return;
    }

    if (key === 'Escape' && appState.mode === 'overview' && hasModules()) {
      event.preventDefault();
      const sourceCardEl = getOverviewCardElement(ui, appState.session.activeModuleId)
        || ui.overviewGrid.querySelector('.overview-card');
      await zoomIntoModuleFromOverview(appState.session.activeModuleId, sourceCardEl);
    }
  });

  window.addEventListener('beforeunload', () => {
    stateManager.saveNow(appState.session);
  });
}

async function init() {
  ensureActiveModule(appState.session);
  appState.mode = hasModules() ? 'focused' : 'greeting';

  bindEvents();
  populatePlaybooks();
  populateDevExamples();
  loadSelectedExampleIntoEditor();

  renderGreeting(ui, appState.session.clientName);
  updateSessionStatus(ui, stateManager.isDirty());

  window.applyModuleUpdate = async (payload) => {
    return applyModuleUpdateInternal(payload, {});
  };
  window.__setPensionShowMax = (moduleId, value) => {
    setPensionShowMaxForModule(moduleId, value);
  };
  window.__getPensionShowMaxForModule = (moduleId) => getPensionShowMaxForModule(moduleId);

  if (appState.mode === 'focused') {
    await renderFocused({ useSwipe: false, revealMode: true });
  } else {
    setMode(ui, 'greeting');
    updateUiChrome();
  }
}

void init();
