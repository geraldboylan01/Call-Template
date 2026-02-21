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
import {
  renderChartsForPane,
  updateChartsForPane,
  cleanupDetachedCharts,
  destroyAllCharts
} from './charts.js';
import {
  getUiElements,
  renderGreeting,
  buildFocusedPane,
  patchFocusedGeneratedCards,
  renderOverview,
  setMode,
  updateControls,
  updateSessionStatus,
  getFocusedCardElement,
  getOverviewCardElement,
  ensureLayerVisibleForMeasure
} from './render.js';
import { normalizePensionInputs, computePensionProjection } from './pension_math.js';
import { normalizeMortgageInputs, computeMortgageProjection } from './mortgage_math.js';
import { runMortgageMathTests } from './tests_mortgage_math.js';
import { encryptSessionJson } from './crypto_session.js';

const ui = getUiElements();
const runtimeConfig = {
  readOnly: false,
  allowDevPanel: true,
  allowPublish: true,
  showPensionToggle: true,
  persistLocalSession: true
};

const IS_LOCAL_DEV_HOST = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
const WORKER_BASE_URL = (() => {
  const override = typeof window.__WORKER_BASE_URL === 'string'
    ? window.__WORKER_BASE_URL.trim()
    : '';

  if (override) {
    return override.replace(/\/+$/, '');
  }

  if (IS_LOCAL_DEV_HOST) {
    return 'http://127.0.0.1:8787';
  }

  return '';
})();

const PUBLIC_BASE_URL = (() => {
  const override = typeof window.__PUBLIC_BASE_URL === 'string'
    ? window.__PUBLIC_BASE_URL.trim()
    : '';
  const raw = override || new URL('./', window.location.href).toString();
  return raw.replace(/\/+$/, '');
})();

const stateManager = createStateManager(300, {
  onDirtyChange: (isDirty) => {
    if (runtimeConfig.readOnly) {
      if (ui.sessionStatus) {
        ui.sessionStatus.textContent = 'Read only';
        ui.sessionStatus.classList.remove('is-dirty');
      }
      return;
    }
    updateSessionStatus(ui, isDirty);
  }
});

const ASSUMPTIONS_UPDATED_FEEDBACK_MS = 800;
const OVERVIEW_UNDO_SECONDS = 15;

const appState = {
  session: newSession('Client'),
  mode: 'greeting',
  sortable: null,
  transitionLock: false,
  devPanelOpen: false,
  overviewSelection: [],
  compare: null,
  compareScrollCleanup: null,
  undoAction: null,
  pensionShowMaxByModuleId: new Map(),
  assumptionsEditorStateByModuleId: new Map(),
  lastValidProjectionByModuleId: new Map(),
  chartHydrationRunId: 0,
  publishedAccess: null
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
  },
  {
    id: 'pension-inline-assumptions-demo',
    label: 'Pension Inline Assumptions Demo',
    payload: {
      title: 'Pension Projection (Inline Assumptions Demo)',
      generated: {
        summaryHtml: '<p>Use the Assumptions pencil to edit pension inputs inline.</p>',
        pensionInputs: {
          currentAge: 42,
          retirementAge: 67,
          currentSalary: 85000,
          currentPot: 180000,
          personalPct: 0.08,
          employerPct: 0.06,
          growthRate: 0.05,
          inflationRate: 0.02,
          wageGrowthRate: 0.025,
          horizonEndAge: 92,
          targetIncomeToday: 42000,
          currentYear: 2026,
          minDrawdownMode: false
        }
      }
    }
  },
  {
    id: 'mortgage-inline-assumptions-demo',
    label: 'Mortgage Inline Assumptions Demo',
    payload: {
      title: 'Mortgage Projection (Inline Assumptions Demo)',
      generated: {
        summaryHtml: '<p>Use the Assumptions pencil to edit mortgage inputs inline.</p>',
        mortgageInputs: {
          currentBalance: 320000,
          annualInterestRate: 0.0425,
          startDateIso: '2026-01-01',
          endDateIso: '2052-12-01',
          repaymentType: 'repayment',
          fixedPaymentAmount: null,
          oneOffOverpayment: 0,
          annualOverpayment: 3000
        }
      }
    }
  },
  {
    id: 'loan-inline-assumptions-demo',
    label: 'Loan Inputs Demo',
    payload: {
      title: 'Loan Projection (Inline Assumptions Demo)',
      generated: {
        summaryHtml: '<p>Use the Assumptions pencil to edit loan inputs inline.</p>',
        loanInputs: {
          loanKind: 'loan',
          currentBalance: 320000,
          annualInterestRate: 0.0425,
          startDateIso: '2026-01-01',
          endDateIso: '2052-12-01',
          repaymentType: 'repayment',
          fixedPaymentAmount: null,
          oneOffOverpayment: 0,
          annualOverpayment: 3000
        }
      }
    }
  },
  {
    id: 'outputsbucketed-auto-repair',
    label: 'OutputsBucketed Auto-Repair',
    payload: {
      title: 'OutputsBucketed Repair Demo',
      generated: {
        summaryHtml: '<p>This payload intentionally includes outputsBucketed issues for auto-repair.</p>',
        outputsBucketed: {
          sections: [
            {
              key: 'liquidity',
              title: 'Liquidity',
              columns: ['Asset', 'Amount (€)'],
              rows: [
                ['Cash', 12000],
                ['Savings', 4500]
              ]
            },
            {
              key: 'cashflow',
              title: 'Cashflow by Year',
              columns: ['Year', 'Income', 'Expenses', 'Net'],
              rows: [
                ['2026', 120000, 80000, 40000],
                ['2027', 128000, 85000, 43000]
              ]
            }
          ]
        }
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

function hasNextModule() {
  const activeIndex = getActiveIndex();
  return activeIndex >= 0 && activeIndex < appState.session.order.length - 1;
}

function getModuleIdSet(session = appState.session) {
  return new Set(Array.isArray(session?.order) ? session.order : []);
}

function pruneOverviewSelection() {
  const validIds = getModuleIdSet();
  const nextSelection = appState.overviewSelection.filter((moduleId) => validIds.has(moduleId));
  appState.overviewSelection = [...new Set(nextSelection)];

  const nextPensionMap = new Map();
  appState.pensionShowMaxByModuleId.forEach((value, moduleId) => {
    if (validIds.has(moduleId)) {
      nextPensionMap.set(moduleId, value);
    }
  });
  appState.pensionShowMaxByModuleId = nextPensionMap;

  return appState.overviewSelection;
}

function isSelected(moduleId) {
  return typeof moduleId === 'string' && appState.overviewSelection.includes(moduleId);
}

function toggleSelected(moduleId) {
  if (typeof moduleId !== 'string' || !moduleId) {
    return appState.overviewSelection;
  }

  const validIds = getModuleIdSet();
  if (!validIds.has(moduleId)) {
    return appState.overviewSelection;
  }

  if (isSelected(moduleId)) {
    appState.overviewSelection = appState.overviewSelection.filter((id) => id !== moduleId);
  } else {
    appState.overviewSelection = [...appState.overviewSelection, moduleId];
  }

  return appState.overviewSelection;
}

function clearSelection() {
  appState.overviewSelection = [];
  return appState.overviewSelection;
}

function keepMostRecentTwoSelected() {
  if (appState.overviewSelection.length <= 2) {
    return appState.overviewSelection;
  }

  appState.overviewSelection = appState.overviewSelection.slice(-2);
  return appState.overviewSelection;
}

function getSelectedPair() {
  const selected = pruneOverviewSelection();
  if (selected.length !== 2) {
    return null;
  }

  return [selected[0], selected[1]];
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

function getAssumptionsEditorState(moduleId) {
  if (!appState.assumptionsEditorStateByModuleId.has(moduleId)) {
    appState.assumptionsEditorStateByModuleId.set(moduleId, {
      isEditing: false,
      phase: 'idle',
      errors: {},
      draftValues: {},
      phaseTimerId: 0
    });
  }

  return appState.assumptionsEditorStateByModuleId.get(moduleId);
}

function clearAssumptionsEditorTimers(state) {
  if (!state) {
    return;
  }

  if (state.phaseTimerId) {
    window.clearTimeout(state.phaseTimerId);
    state.phaseTimerId = 0;
  }
}

function resetAssumptionsEditorState(moduleId) {
  const state = appState.assumptionsEditorStateByModuleId.get(moduleId);
  if (!state) {
    return;
  }

  clearAssumptionsEditorTimers(state);
  state.isEditing = false;
  state.phase = 'idle';
  state.errors = {};
  state.draftValues = {};
}

function clearAllAssumptionsEditorState() {
  appState.assumptionsEditorStateByModuleId.forEach((state) => {
    clearAssumptionsEditorTimers(state);
  });
  appState.assumptionsEditorStateByModuleId.clear();
}

function getAssumptionsEditorRenderStatus(moduleId) {
  const state = appState.assumptionsEditorStateByModuleId.get(moduleId);
  if (!state) {
    return {
      isEditing: false,
      phase: 'idle',
      errors: {},
      draftValues: {}
    };
  }

  return {
    isEditing: Boolean(state.isEditing),
    phase: state.phase,
    errors: { ...state.errors },
    draftValues: { ...state.draftValues }
  };
}

function getActiveFocusedModuleCard(moduleId) {
  if (!ui.swipeStage || typeof moduleId !== 'string' || !moduleId) {
    return null;
  }

  return ui.swipeStage.querySelector(`.focused-module-card[data-module-id="${moduleId}"]`);
}

function patchFocusedModuleGeneratedContent(moduleId, {
  patchSummary = true,
  patchAssumptions = true,
  patchOutputs = true,
  updateCharts = true
} = {}) {
  if (appState.mode !== 'focused' || appState.session.activeModuleId !== moduleId) {
    return;
  }

  const module = getModuleById(appState.session, moduleId);
  if (!module) {
    return;
  }

  const focusedCard = getActiveFocusedModuleCard(moduleId);
  if (!focusedCard) {
    return;
  }

  patchFocusedGeneratedCards({
    focusedCard,
    module,
    onPatchInputs: (action) => handleAssumptionsEditorPatch(action),
    assumptionsEditorStatus: getAssumptionsEditorRenderStatus(moduleId),
    readOnly: runtimeConfig.readOnly,
    patchSummary,
    patchAssumptions,
    patchOutputs
  });

  if (!updateCharts) {
    return;
  }

  const activePane = focusedCard.closest('.swipe-pane')
    || ui.swipeStage.querySelector('.swipe-pane.active');
  if (!activePane) {
    return;
  }

  updateChartsForPane(activePane, module, {
    clientName: appState.session.clientName || 'Client',
    moduleTitle: module.title?.trim() || 'Untitled Module',
    paneKey: 'focused-active'
  });
}

function refreshInlineAssumptionsCard(moduleId) {
  patchFocusedModuleGeneratedContent(moduleId, {
    patchSummary: false,
    patchAssumptions: true,
    patchOutputs: false,
    updateCharts: false
  });
}

function setAssumptionsEditorPhase(moduleId, phase) {
  const state = getAssumptionsEditorState(moduleId);

  if (state.phaseTimerId) {
    window.clearTimeout(state.phaseTimerId);
    state.phaseTimerId = 0;
  }

  state.phase = phase;
  refreshInlineAssumptionsCard(moduleId);

  if (phase === 'updated') {
    state.phaseTimerId = window.setTimeout(() => {
      const liveState = getAssumptionsEditorState(moduleId);
      if (liveState.phase === 'updated') {
        liveState.phase = 'idle';
        refreshInlineAssumptionsCard(moduleId);
      }
      liveState.phaseTimerId = 0;
    }, ASSUMPTIONS_UPDATED_FEEDBACK_MS);
  }
}

function normalizeNumericInputText(rawValue) {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return String(rawValue);
  }

  return String(rawValue ?? '')
    .trim()
    .replace(/\u00A0/g, ' ')
    .replace(/[\s,]+/g, '')
    .replace(/[€$£]/g, '');
}

function parseIsoDateToMonthDate(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, 1));
}

function deriveRemainingTermYearsFromMortgageInputs(mortgageInputs) {
  if (Number.isFinite(mortgageInputs?.remainingTermYears) && mortgageInputs.remainingTermYears > 0) {
    return mortgageInputs.remainingTermYears;
  }

  const startMonthDate = parseIsoDateToMonthDate(mortgageInputs?.startDateIso);
  const endMonthDate = parseIsoDateToMonthDate(mortgageInputs?.endDateIso);
  if (!startMonthDate || !endMonthDate) {
    return null;
  }

  const deltaMonths = ((endMonthDate.getUTCFullYear() - startMonthDate.getUTCFullYear()) * 12)
    + (endMonthDate.getUTCMonth() - startMonthDate.getUTCMonth());
  const monthCount = deltaMonths + 1;
  if (!Number.isInteger(monthCount) || monthCount <= 0) {
    return null;
  }

  return monthCount / 12;
}

function getLoanEngineInputs(module) {
  return module?.generated?.loanInputs || module?.generated?.mortgageInputs || null;
}

function getLoanEngineSource(module) {
  if (module?.generated?.loanInputs) {
    return 'loanInputs';
  }
  if (module?.generated?.mortgageInputs) {
    return 'mortgageInputs';
  }
  return 'mortgageInputs';
}

function getDefaultLoanKindForSource(source, loanEngineInputs = null) {
  if (loanEngineInputs?.loanKind === 'loan') {
    return 'loan';
  }
  if (loanEngineInputs?.loanKind === 'mortgage') {
    return 'mortgage';
  }
  return source === 'loanInputs' ? 'loan' : 'mortgage';
}

function setLoanEngineInputs(module, normalizedInputs, { source = null } = {}) {
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

function parseLooseNumber(rawValue, { label, required = true } = {}) {
  const cleaned = normalizeNumericInputText(rawValue);
  if (!cleaned) {
    if (required) {
      return { error: `${label} is required.` };
    }
    return { value: null };
  }

  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric)) {
    return { error: `${label} must be a valid number.` };
  }

  return { value: numeric };
}

function parseRateInput(rawValue, { label }) {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return { value: rawValue };
  }

  const original = String(rawValue ?? '').trim();
  const cleaned = normalizeNumericInputText(original).replace(/%/g, '');
  if (!cleaned) {
    return { error: `${label} is required.` };
  }

  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric)) {
    return { error: `${label} must be a valid rate.` };
  }

  const hasPercentSymbol = original.includes('%');
  const decimal = hasPercentSymbol || Math.abs(numeric) > 1
    ? (numeric / 100)
    : numeric;

  return { value: decimal };
}

function parseIntegerInput(rawValue, { label }) {
  const parsed = parseLooseNumber(rawValue, { label });
  if (parsed.error) {
    return parsed;
  }

  if (!Number.isInteger(parsed.value)) {
    return { error: `${label} must be a whole number.` };
  }

  return { value: parsed.value };
}

function parsePositiveNumberInput(rawValue, { label }) {
  const parsed = parseLooseNumber(rawValue, { label });
  if (parsed.error) {
    return parsed;
  }

  if (!(parsed.value > 0)) {
    return { error: `${label} must be greater than 0.` };
  }

  return parsed;
}

function parseNonNegativeNumberInput(rawValue, { label }) {
  const parsed = parseLooseNumber(rawValue, { label });
  if (parsed.error) {
    return parsed;
  }

  if (parsed.value < 0) {
    return { error: `${label} must be greater than or equal to 0.` };
  }

  return parsed;
}

function mapPensionNormalizationErrorToField(message) {
  if (message.includes('.currentAge')) {
    return 'currentAge';
  }
  if (message.includes('.growthRate')) {
    return 'growthRate';
  }
  if (message.includes('.wageGrowthRate')) {
    return 'wageGrowthRate';
  }
  if (message.includes('.inflationRate')) {
    return 'inflationRate';
  }
  if (message.includes('.retirementAge')) {
    return 'retirementAge';
  }
  if (message.includes('.currentSalary')) {
    return 'currentSalary';
  }
  if (message.includes('.currentPot')) {
    return 'currentPot';
  }
  if (message.includes('.personalPct')) {
    return 'personalPct';
  }
  if (message.includes('.employerPct')) {
    return 'employerPct';
  }
  if (message.includes('.targetIncomeToday')) {
    return 'targetIncomeToday';
  }
  if (message.includes('.horizonEndAge')) {
    return 'horizonEndAge';
  }
  return null;
}

function mapMortgageNormalizationErrorToField(message) {
  if (message.includes('.currentBalance')) {
    return 'currentBalance';
  }
  if (message.includes('.annualInterestRate')) {
    return 'annualInterestRate';
  }
  if (message.includes('.remainingTermYears') || message.includes('.endDateIso')) {
    return 'termMonths';
  }
  if (message.includes('.oneOffOverpayment')) {
    return 'oneOffOverpayment';
  }
  if (message.includes('.annualOverpayment')) {
    return 'annualOverpayment';
  }
  if (message.includes('.fixedPaymentAmount')) {
    return 'fixedPaymentAmount';
  }
  return null;
}

function shouldRefreshMortgageSummary(summaryHtml) {
  const text = String(summaryHtml || '');
  if (!text.trim()) {
    return true;
  }

  return /[\d€%]/.test(text);
}

function hasOwnPropertyValue(object, key) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

function parseTermMonthsInput(rawValue, { label }) {
  const normalized = String(rawValue ?? '')
    .toLowerCase()
    .replace(/months?/g, '')
    .trim();
  const parsed = parseIntegerInput(normalized, { label });
  if (parsed.error) {
    return parsed;
  }

  if (parsed.value <= 0) {
    return { error: `${label} must be greater than 0.` };
  }

  return parsed;
}

function parsePensionFieldInput(field, rawValue) {
  switch (field) {
    case 'currentAge':
      return parseIntegerInput(rawValue, { label: 'Current age' });
    case 'retirementAge':
      return parseIntegerInput(rawValue, { label: 'Retirement age' });
    case 'currentSalary':
      return parseNonNegativeNumberInput(rawValue, { label: 'Current salary' });
    case 'currentPot':
      return parseNonNegativeNumberInput(rawValue, { label: 'Current pension value' });
    case 'personalPct':
      return parseRateInput(rawValue, { label: 'Personal contribution' });
    case 'employerPct':
      return parseRateInput(rawValue, { label: 'Employer contribution' });
    case 'growthRate':
      return parseRateInput(rawValue, { label: 'Growth rate' });
    case 'wageGrowthRate':
      return parseRateInput(rawValue, { label: 'Wage growth' });
    case 'inflationRate':
      return parseRateInput(rawValue, { label: 'Inflation' });
    case 'targetIncomeToday':
      return parseNonNegativeNumberInput(rawValue, { label: 'Target retirement income' });
    default:
      return { error: 'Unsupported pension assumption field.' };
  }
}

function parseMortgageFieldInput(field, rawValue) {
  switch (field) {
    case 'currentBalance':
      return parsePositiveNumberInput(rawValue, { label: 'Current balance' });
    case 'annualInterestRate':
      return parseRateInput(rawValue, { label: 'Annual interest rate' });
    case 'termMonths':
      return parseTermMonthsInput(rawValue, { label: 'Term (months)' });
    case 'oneOffOverpayment':
      return parseNonNegativeNumberInput(rawValue, { label: 'One-off overpayment' });
    case 'annualOverpayment':
      return parseNonNegativeNumberInput(rawValue, { label: 'Annual overpayment' });
    case 'fixedPaymentAmount':
      return parsePositiveNumberInput(rawValue, { label: 'Fixed monthly payment' });
    default:
      return { error: 'Unsupported mortgage assumption field.' };
  }
}

function clearAssumptionsFieldErrors(state, fields) {
  const nextErrors = { ...(state.errors || {}) };
  fields.forEach((field) => {
    delete nextErrors[field];
  });
  state.errors = nextErrors;
}

function setAssumptionsFieldError(state, field, message) {
  state.errors = {
    ...(state.errors || {}),
    [field]: message
  };
}

function clearAssumptionsDraftFields(state, fields) {
  const nextDraft = { ...(state.draftValues || {}) };
  fields.forEach((field) => {
    delete nextDraft[field];
  });
  state.draftValues = nextDraft;
}

function applyUpdatedProjectionToModule({
  module,
  calculator,
  normalizedInputs
}) {
  if (calculator === 'pension') {
    module.generated.pensionInputs = normalizedInputs;
    module.generated.mortgageInputs = null;
    module.generated.loanInputs = null;
    applyPensionProjectionToModule(module, { updateSummary: true });
    return;
  }

  if (calculator === 'mortgage') {
    const existingSource = getLoanEngineSource(module);
    const targetSource = existingSource === 'loanInputs' || normalizedInputs?.loanKind === 'loan'
      ? 'loanInputs'
      : 'mortgageInputs';
    setLoanEngineInputs(module, normalizedInputs, { source: targetSource });
    module.generated.pensionInputs = null;
    const shouldUpdateSummary = shouldRefreshMortgageSummary(module.generated.summaryHtml);
    applyMortgageProjectionToModule(module, { updateSummary: shouldUpdateSummary });
  }
}

function commitPensionAssumptionField({
  module,
  state,
  field,
  rawValue
}) {
  const baseInputs = module?.generated?.pensionInputs;
  if (!baseInputs) {
    return {
      ok: false,
      field,
      message: 'Pension inputs are unavailable for this module.'
    };
  }

  const candidate = { ...baseInputs };
  const parsed = parsePensionFieldInput(field, rawValue);
  if (parsed.error) {
    return {
      ok: false,
      field,
      message: parsed.error
    };
  }
  candidate[field] = parsed.value;

  let normalizedInputs;
  try {
    normalizedInputs = normalizePensionInputs(candidate);
  } catch (error) {
    const message = error?.message || 'Invalid pension assumptions.';
    const mappedField = mapPensionNormalizationErrorToField(message) || field;
    return {
      ok: false,
      field: mappedField,
      message
    };
  }

  applyUpdatedProjectionToModule({
    module,
    calculator: 'pension',
    normalizedInputs
  });
  clearAssumptionsDraftFields(state, [field]);
  return {
    ok: true
  };
}

function getMortgagePaymentModeForCommit({ state, baseInputs, modeOverride = null }) {
  if (modeOverride === 'fixed' || modeOverride === 'calculated') {
    return modeOverride;
  }

  const draftMode = String(state?.draftValues?.fixedPaymentMode || '').trim().toLowerCase();
  if (draftMode === 'fixed' || draftMode === 'calculated') {
    return draftMode;
  }

  return Number.isFinite(baseInputs?.fixedPaymentAmount) && baseInputs.fixedPaymentAmount > 0
    ? 'fixed'
    : 'calculated';
}

function commitMortgageAssumptionField({
  module,
  state,
  field,
  rawValue,
  modeOverride = null
}) {
  const baseInputs = getLoanEngineInputs(module);
  if (!baseInputs) {
    return {
      ok: false,
      field: field || 'currentBalance',
      message: 'Loan inputs are unavailable for this module.'
    };
  }

  const candidate = { ...baseInputs, repaymentType: 'repayment' };
  let nextMode = getMortgagePaymentModeForCommit({
    state,
    baseInputs,
    modeOverride
  });

  if (field && field !== 'fixedPaymentMode') {
    const parsed = parseMortgageFieldInput(field, rawValue);
    if (parsed.error) {
      return {
        ok: false,
        field,
        message: parsed.error
      };
    }

    if (field === 'termMonths') {
      const termYears = Number((parsed.value / 12).toFixed(2));
      candidate.remainingTermYears = termYears;
      candidate.endDateIso = null;
    } else {
      candidate[field] = parsed.value;
    }
  }

  if (field === 'fixedPaymentMode') {
    nextMode = modeOverride === 'fixed' ? 'fixed' : 'calculated';
  }

  if (nextMode === 'fixed') {
    const fixedRawValue = field === 'fixedPaymentAmount'
      ? rawValue
      : (
        hasOwnPropertyValue(state?.draftValues, 'fixedPaymentAmount')
          ? state.draftValues.fixedPaymentAmount
          : baseInputs.fixedPaymentAmount
      );
    const fixedParsed = parsePositiveNumberInput(fixedRawValue, { label: 'Fixed monthly payment' });
    if (fixedParsed.error) {
      return {
        ok: false,
        field: 'fixedPaymentAmount',
        message: fixedParsed.error
      };
    }
    candidate.fixedPaymentAmount = fixedParsed.value;
  } else {
    candidate.fixedPaymentAmount = null;
  }

  if (!Number.isFinite(candidate.remainingTermYears) && !candidate.endDateIso) {
    candidate.remainingTermYears = deriveRemainingTermYearsFromMortgageInputs(baseInputs);
  }

  let normalizedInputs;
  try {
    const source = getLoanEngineSource(module);
    const defaultLoanKind = getDefaultLoanKindForSource(source, baseInputs);
    normalizedInputs = normalizeMortgageInputs(candidate, { defaultLoanKind });
  } catch (error) {
    const message = error?.message || 'Invalid mortgage assumptions.';
    const mappedField = mapMortgageNormalizationErrorToField(message) || field || 'currentBalance';
    return {
      ok: false,
      field: mappedField,
      message
    };
  }

  applyUpdatedProjectionToModule({
    module,
    calculator: 'mortgage',
    normalizedInputs
  });
  const clearedFields = [
    field,
    'fixedPaymentMode',
    nextMode === 'fixed' ? 'fixedPaymentAmount' : null
  ].filter(Boolean);
  clearAssumptionsDraftFields(state, clearedFields);
  return {
    ok: true
  };
}

function applyPensionProjectionToModule(module, { updateSummary = true } = {}) {
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
    module.generated.summaryHtml = injectAutoSftSummarySentence(
      module.generated.summaryHtml,
      projection.debug.sftSentence
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

  appState.lastValidProjectionByModuleId.set(module.id, {
    calculator: 'pension',
    inputs: { ...module.generated.pensionInputs },
    debug: projection.debug
  });

  return projection;
}

function applyMortgageProjectionToModule(module, { updateSummary = true } = {}) {
  const loanEngineInputs = getLoanEngineInputs(module);
  if (!loanEngineInputs) {
    throw new Error('Loan inputs are unavailable for this module.');
  }
  const source = getLoanEngineSource(module);
  const defaultLoanKind = getDefaultLoanKindForSource(source, loanEngineInputs);
  const normalizedInputs = normalizeMortgageInputs(loanEngineInputs, { defaultLoanKind });
  const resolvedSource = setLoanEngineInputs(module, normalizedInputs, { source });
  const projection = computeMortgageProjection(normalizedInputs, { defaultLoanKind });

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
    totalPaidLifetime: projection.debug?.totalPaidLifetime
  });

  appState.lastValidProjectionByModuleId.set(module.id, {
    calculator: 'mortgage',
    inputs: { ...normalizedInputs },
    debug: projection.debug
  });

  return projection;
}

function cloneSessionSnapshot(session) {
  try {
    return JSON.parse(JSON.stringify(session));
  } catch (_error) {
    return JSON.parse(exportSession(session));
  }
}

function captureUndoSnapshot() {
  return {
    session: cloneSessionSnapshot(appState.session),
    mode: appState.mode,
    compare: appState.compare
      ? {
        leftId: appState.compare.leftId,
        rightId: appState.compare.rightId,
        syncScroll: appState.compare.syncScroll !== false
      }
      : null,
    overviewSelection: [...appState.overviewSelection],
    pensionShowMaxEntries: [...appState.pensionShowMaxByModuleId.entries()]
  };
}

function clearCompareScrollSyncCleanup() {
  if (typeof appState.compareScrollCleanup === 'function') {
    appState.compareScrollCleanup();
  }
  appState.compareScrollCleanup = null;
}

function clearUndoActionState() {
  const undo = appState.undoAction;
  if (ui.toastHost) {
    ui.toastHost.classList.remove('has-interactive-toast');
  }
  if (!undo) {
    return;
  }

  if (undo.intervalId) {
    window.clearInterval(undo.intervalId);
  }
  if (undo.timeoutId) {
    window.clearTimeout(undo.timeoutId);
  }
  if (undo.toastEl?.isConnected) {
    undo.toastEl.remove();
  }

  appState.undoAction = null;
}

async function restoreUndoSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return;
  }

  destroySortable();
  destroyAllCharts();
  clearCompareScrollSyncCleanup();

  appState.transitionLock = false;
  appState.session = importSession(JSON.stringify(snapshot.session));
  appState.compare = snapshot.compare
    ? {
      leftId: snapshot.compare.leftId,
      rightId: snapshot.compare.rightId,
      syncScroll: snapshot.compare.syncScroll !== false
    }
    : null;
  appState.overviewSelection = Array.isArray(snapshot.overviewSelection)
    ? snapshot.overviewSelection.filter((moduleId) => typeof moduleId === 'string' && moduleId)
    : [];
  appState.pensionShowMaxByModuleId = new Map(
    Array.isArray(snapshot.pensionShowMaxEntries) ? snapshot.pensionShowMaxEntries : []
  );

  ensureActiveModule(appState.session);
  pruneOverviewSelection();
  ui.swipeStage.classList.remove('is-compare');

  const hasComparePair = Boolean(
    appState.compare
    && getModuleById(appState.session, appState.compare.leftId)
    && getModuleById(appState.session, appState.compare.rightId)
  );

  if (!hasModules()) {
    appState.mode = 'greeting';
    ui.swipeStage.innerHTML = '';
    setMode(ui, 'greeting');
    updateUiChrome();
    return;
  }

  if (snapshot.mode === 'compare' && hasComparePair) {
    appState.mode = 'compare';
    await renderCompareView();
    return;
  }

  if (snapshot.mode === 'overview') {
    appState.mode = 'overview';
    setMode(ui, 'overview');
    refreshOverview({ enableSortable: true });
    updateUiChrome();
    return;
  }

  appState.mode = 'focused';
  appState.compare = null;
  await renderFocused({ useSwipe: false, revealMode: true });
}

function startUndoSnackbar({
  message,
  snapshot
}) {
  if (!ui.toastHost || !snapshot) {
    return;
  }

  clearUndoActionState();
  ui.toastHost.classList.add('has-interactive-toast');

  const toast = document.createElement('div');
  toast.className = 'toast toast-undo';

  const messageEl = document.createElement('span');
  messageEl.className = 'toast-undo-message';
  messageEl.textContent = message;

  const controls = document.createElement('div');
  controls.className = 'toast-undo-controls';

  const undoButton = document.createElement('button');
  undoButton.type = 'button';
  undoButton.className = 'toast-undo-btn';

  const countdownEl = document.createElement('span');
  countdownEl.className = 'toast-undo-countdown';

  controls.appendChild(undoButton);
  controls.appendChild(countdownEl);
  toast.appendChild(messageEl);
  toast.appendChild(controls);
  ui.toastHost.appendChild(toast);

  const undoState = {
    snapshot,
    toastEl: toast,
    undoButtonEl: undoButton,
    countdownEl,
    remainingSeconds: OVERVIEW_UNDO_SECONDS,
    intervalId: 0,
    timeoutId: 0
  };

  const renderCountdown = () => {
    undoButton.textContent = `Undo (${undoState.remainingSeconds})`;
    countdownEl.textContent = `${undoState.remainingSeconds}s`;
  };

  const expireUndo = () => {
    clearUndoActionState();
  };

  undoButton.addEventListener('click', async () => {
    if (appState.undoAction !== undoState) {
      return;
    }

    undoButton.disabled = true;
    try {
      await restoreUndoSnapshot(undoState.snapshot);
      markSessionDirty();
      saveSessionNow();
    } catch (error) {
      console.error('[CallCanvas] failed to restore undo snapshot', error);
      showToast('Could not restore the previous state.', 'error');
    } finally {
      clearUndoActionState();
    }
  });

  renderCountdown();
  undoState.intervalId = window.setInterval(() => {
    if (appState.undoAction !== undoState) {
      return;
    }

    undoState.remainingSeconds = Math.max(0, undoState.remainingSeconds - 1);
    renderCountdown();
  }, 1000);
  undoState.timeoutId = window.setTimeout(() => {
    if (appState.undoAction === undoState) {
      expireUndo();
    }
  }, OVERVIEW_UNDO_SECONDS * 1000);

  appState.undoAction = undoState;
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

function saveSessionNow() {
  if (!runtimeConfig.persistLocalSession) {
    return;
  }

  stateManager.saveNow(appState.session);
}

function scheduleSessionSave() {
  if (!runtimeConfig.persistLocalSession) {
    return;
  }

  stateManager.scheduleSave(appState.session);
}

function markSessionDirty() {
  if (!runtimeConfig.persistLocalSession) {
    return;
  }

  stateManager.markDirty();
}

function markSessionClean() {
  if (!runtimeConfig.persistLocalSession) {
    return;
  }

  stateManager.markClean();
}

function setDevPanelOpen(open) {
  if (appState.mode === 'compare' && open) {
    open = false;
  }

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
  renderDevPayloadWarnings([]);
}

function normalizeEditorJsonInput(rawInput) {
  return String(rawInput ?? '')
    .trim()
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2018|\u2019/g, '\'');
}

function ensureDevPayloadWarningHost() {
  if (!ui.devPanel) {
    return null;
  }

  let host = ui.devPanel.querySelector('[data-dev-payload-warnings]');
  if (host) {
    return host;
  }

  host = document.createElement('div');
  host.setAttribute('data-dev-payload-warnings', 'true');
  Object.assign(host.style, {
    display: 'none',
    margin: '10px 16px 0',
    padding: '10px 12px',
    border: '1px solid rgba(255, 209, 102, 0.45)',
    background: 'rgba(54, 36, 7, 0.45)',
    borderRadius: '10px',
    color: '#ffe5a8',
    fontSize: '12px',
    lineHeight: '1.4'
  });

  const actions = ui.devPanel.querySelector('.dev-panel-actions');
  if (actions && actions.parentElement) {
    actions.parentElement.insertBefore(host, actions);
  } else {
    ui.devPanel.appendChild(host);
  }

  return host;
}

function renderDevPayloadWarnings(warnings) {
  const host = ensureDevPayloadWarningHost();
  if (!host) {
    return;
  }

  host.innerHTML = '';
  if (!Array.isArray(warnings) || warnings.length === 0) {
    host.style.display = 'none';
    return;
  }

  host.style.display = 'block';

  const title = document.createElement('div');
  title.textContent = 'Auto-repairs applied:';
  title.style.fontWeight = '700';
  title.style.marginBottom = '6px';
  host.appendChild(title);

  const list = document.createElement('ul');
  list.style.margin = '0';
  list.style.padding = '0 0 0 16px';

  warnings.forEach((warning) => {
    const item = document.createElement('li');
    item.textContent = warning;
    list.appendChild(item);
  });

  host.appendChild(list);
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

function normalizeDevPanelPayload(payload) {
  const warnings = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload, warnings };
  }

  const generated = payload.generated;
  if (!generated || typeof generated !== 'object' || Array.isArray(generated)) {
    return { payload, warnings };
  }

  const outputsBucketed = generated.outputsBucketed;
  if (!outputsBucketed || typeof outputsBucketed !== 'object' || Array.isArray(outputsBucketed)) {
    return { payload, warnings };
  }

  if (typeof outputsBucketed.currencySymbol !== 'string' || !outputsBucketed.currencySymbol.trim()) {
    outputsBucketed.currencySymbol = '€';
    warnings.push('Filled missing generated.outputsBucketed.currencySymbol with "€".');
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

    const columns = Array.isArray(section.columns)
      ? section.columns.map((column) => String(column ?? ''))
      : [];

    if (columns.length !== 2) {
      const migratedTable = {
        title: sectionTitle,
        columns: columns.length > 0 ? columns : ['Item', 'Value'],
        rows: toGenericTableRows(section.rows)
      };
      generated.tables.push(migratedTable);
      warnings.push(`Moved outputsBucketed section '${sectionTitle}' into generated.tables because outputsBucketed only supports 2-column sections.`);
      return;
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
        const numericValue = Number(row[1]);
        if (!Number.isFinite(numericValue)) {
          warnings.push(`Normalized non-numeric value to 0 in outputsBucketed section '${sectionTitle}'.`);
          return [label, 0];
        }
        return [label, numericValue];
      });

    if (!('subtotalValue' in section)) {
      section.subtotalValue = 0;
      warnings.push(`Filled missing subtotalValue = 0 for outputsBucketed section '${sectionTitle}'.`);
    } else if (typeof section.subtotalValue !== 'number' || !Number.isFinite(section.subtotalValue)) {
      const parsedSubtotal = Number(section.subtotalValue);
      section.subtotalValue = Number.isFinite(parsedSubtotal) ? parsedSubtotal : 0;
      warnings.push(`Normalized invalid subtotalValue to 0 for outputsBucketed section '${sectionTitle}'.`);
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

function generate6DigitPin() {
  if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') {
    throw new Error('Secure random generation is unavailable in this browser.');
  }

  const values = new Uint32Array(1);
  window.crypto.getRandomValues(values);
  return String(values[0] % 1000000).padStart(6, '0');
}

function getPublishPinFromInput() {
  if (!ui.publishPinInput) {
    return generate6DigitPin();
  }

  const normalized = String(ui.publishPinInput.value ?? '').replace(/\s+/g, '').trim();
  if (!normalized) {
    return generate6DigitPin();
  }

  if (/^\d{6}$/.test(normalized)) {
    return normalized;
  }

  throw new Error('PIN must be exactly 6 digits.');
}

function normalizePublishSessionId(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) {
    throw new Error('Publish response was missing a session id.');
  }
  return value;
}

async function copyToClipboard(value) {
  const text = String(value ?? '');
  if (!text) {
    return false;
  }

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

function setPublishError(message) {
  if (!ui.publishError) {
    return;
  }

  ui.publishError.textContent = String(message || '');
  ui.publishError.classList.toggle('is-visible', Boolean(message));
}

function resetPublishResult() {
  appState.publishedAccess = null;

  if (ui.publishResult) {
    ui.publishResult.classList.add('is-hidden');
  }
  if (ui.publishPinValue) {
    ui.publishPinValue.textContent = '------';
  }
  if (ui.publishLinkValue) {
    ui.publishLinkValue.value = '';
  }
  if (ui.publishPinInput) {
    ui.publishPinInput.value = '';
  }
}

function setPublishModalOpen(open) {
  if (!ui.publishModal) {
    return;
  }

  ui.publishModal.classList.toggle('is-hidden', !open);
  ui.publishModal.setAttribute('aria-hidden', open ? 'false' : 'true');
}

async function publishCurrentSession() {
  const plaintext = exportSession(appState.session);
  const pin = getPublishPinFromInput();
  const encryptedPayload = await encryptSessionJson(pin, plaintext);
  const response = await fetch(`${WORKER_BASE_URL}/api/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(encryptedPayload)
  });

  if (!response.ok) {
    throw new Error(`Publish failed (${response.status}).`);
  }

  const payload = await response.json();
  const sessionId = normalizePublishSessionId(payload?.sessionId);
  const link = `${PUBLIC_BASE_URL}/session.html?id=${encodeURIComponent(sessionId)}`;

  return {
    sessionId,
    pin,
    link
  };
}

async function revokePublishedSession(sessionId) {
  const response = await fetch(`${WORKER_BASE_URL}/api/revoke/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to revoke (${response.status}).`);
  }
}

function applyRuntimeChrome() {
  if (runtimeConfig.readOnly) {
    document.body.classList.add('read-only-session');
    if (ui.clientNameInput) {
      ui.clientNameInput.readOnly = true;
      ui.clientNameInput.setAttribute('aria-readonly', 'true');
    }
    [ui.playbookSelect, ui.newCallButton, ui.loadSessionButton, ui.newModuleButton, ui.resetButton].forEach((element) => {
      if (!element) {
        return;
      }
      element.classList.add('is-hidden');
      element.setAttribute('aria-hidden', 'true');
    });
  } else {
    document.body.classList.remove('read-only-session');
  }

  if (!runtimeConfig.allowPublish && ui.publishSessionButton) {
    ui.publishSessionButton.classList.add('is-hidden');
  }

  if (!runtimeConfig.allowPublish && ui.publishModal) {
    ui.publishModal.classList.add('is-hidden');
    ui.publishModal.setAttribute('aria-hidden', 'true');
  }

  if (!runtimeConfig.allowDevPanel && ui.devPanel) {
    setDevPanelOpen(false);
    ui.devPanel.classList.add('is-hidden');
    ui.devPanel.setAttribute('aria-hidden', 'true');
  }

  if (runtimeConfig.readOnly && ui.sessionStatus) {
    ui.sessionStatus.textContent = 'Read only';
    ui.sessionStatus.classList.remove('is-dirty');
  }
}

function renderPublishedAccess(access) {
  if (!access) {
    return;
  }

  if (ui.publishResult) {
    ui.publishResult.classList.remove('is-hidden');
  }

  if (ui.publishPinValue) {
    ui.publishPinValue.textContent = access.pin;
  }

  if (ui.publishLinkValue) {
    ui.publishLinkValue.value = access.link;
  }
}

async function handlePublishGenerate() {
  if (runtimeConfig.readOnly || !runtimeConfig.allowPublish) {
    return;
  }

  setPublishError('');

  if (ui.publishGenerateButton) {
    ui.publishGenerateButton.disabled = true;
  }

  try {
    const access = await publishCurrentSession();
    appState.publishedAccess = access;
    renderPublishedAccess(access);
  } catch (error) {
    setPublishError(error?.message || 'Failed to publish this session.');
  } finally {
    if (ui.publishGenerateButton) {
      ui.publishGenerateButton.disabled = false;
    }
  }
}

async function handleCopyPublishedPin() {
  if (!appState.publishedAccess?.pin) {
    return;
  }

  try {
    await copyToClipboard(appState.publishedAccess.pin);
    showToast('PIN copied.');
  } catch (_error) {
    showToast('Could not copy PIN.', 'error');
  }
}

async function handleCopyPublishedLink() {
  if (!appState.publishedAccess?.link) {
    return;
  }

  try {
    await copyToClipboard(appState.publishedAccess.link);
    showToast('Link copied.');
  } catch (_error) {
    showToast('Could not copy link.', 'error');
  }
}

async function handleRevokePublishedAccess() {
  const sessionId = appState.publishedAccess?.sessionId;
  if (!sessionId) {
    return;
  }

  const confirmed = window.confirm('Revoke this client link now?');
  if (!confirmed) {
    return;
  }

  try {
    await revokePublishedSession(sessionId);
    showToast('Client access revoked.');
    resetPublishResult();
  } catch (error) {
    setPublishError(error?.message || 'Revoke failed.');
  }
}

async function replaceSession(nextSession, options = {}) {
  const { markClean = true } = options;

  destroySortable();
  destroyAllCharts();
  clearUndoActionState();
  clearCompareScrollSyncCleanup();

  appState.transitionLock = false;
  appState.session = nextSession;
  appState.compare = null;
  appState.overviewSelection = [];
  ui.swipeStage.classList.remove('is-compare');
  appState.pensionShowMaxByModuleId = new Map();
  clearAllAssumptionsEditorState();
  appState.lastValidProjectionByModuleId = new Map();

  ensureActiveModule(appState.session);
  saveSessionNow();

  if (markClean) {
    markSessionClean();
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
      throw new Error(`${label}.sections[${sectionIndex}].columns: outputsBucketed sections only support 2 columns. For multi-column tables, use generated.tables[].`);
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
      throw new Error(`${label}.sections[${sectionIndex}].subtotalValue is required; dev panel now auto-fills missing subtotalValue = 0.`);
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

function validateMortgageInputsPayload(mortgageInputs) {
  return normalizeMortgageInputs(mortgageInputs, { defaultLoanKind: 'mortgage' });
}

function validateLoanInputsPayload(loanInputs) {
  return normalizeMortgageInputs(loanInputs, { defaultLoanKind: 'loan' });
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

    if ('tables' in payload.generated) {
      generatedPatch.tables = validateGeneratedTablesPayload(payload.generated.tables);
    }

    if ('charts' in payload.generated) {
      generatedPatch.charts = validateChartsPayload(payload.generated.charts);
    }

    if ('pensionInputs' in payload.generated) {
      generatedPatch.pensionInputs = validatePensionInputsPayload(payload.generated.pensionInputs);
    }

    if ('mortgageInputs' in payload.generated) {
      generatedPatch.mortgageInputs = validateMortgageInputsPayload(payload.generated.mortgageInputs);
    }

    if ('loanInputs' in payload.generated) {
      generatedPatch.loanInputs = validateLoanInputsPayload(payload.generated.loanInputs);
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
    moduleTitle: activeModule.title?.trim() || 'Untitled Module',
    paneKey: 'focused-active'
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

  const module = getModuleById(appState.session, moduleId);
  if (!module?.generated?.pensionInputs) {
    return false;
  }

  return appState.pensionShowMaxByModuleId.get(moduleId) ?? false;
}

function setPensionShowMaxForModule(moduleId, value) {
  if (runtimeConfig.readOnly || !runtimeConfig.showPensionToggle) {
    return;
  }

  if (typeof moduleId !== 'string' || !moduleId) {
    return;
  }

  const module = getModuleById(appState.session, moduleId);
  if (!module?.generated?.pensionInputs) {
    appState.pensionShowMaxByModuleId.delete(moduleId);
    return;
  }

  const nextValue = Boolean(value);
  appState.pensionShowMaxByModuleId.set(moduleId, nextValue);

  if (appState.mode === 'focused' && appState.session.activeModuleId === moduleId) {
    if (typeof window.__setPensionShowMaxForModule === 'function') {
      window.__setPensionShowMaxForModule(moduleId, nextValue);
    }
  }
}

function updateModule(moduleId, patch) {
  if (runtimeConfig.readOnly) {
    return;
  }

  const module = getModuleById(appState.session, moduleId);
  if (!module) {
    return;
  }

  ensureGenerated(module);
  Object.assign(module, patch);
  module.updatedAt = nowIso();
  scheduleSessionSave();

  if (appState.mode === 'overview') {
    refreshOverview({ enableSortable: true });
  }
}

function toggleAssumptionsEditMode(moduleId) {
  const state = getAssumptionsEditorState(moduleId);
  const nextEditing = !Boolean(state.isEditing);
  state.isEditing = nextEditing;
  state.phase = 'idle';
  state.errors = {};
  state.draftValues = {};
  clearAssumptionsEditorTimers(state);
  refreshInlineAssumptionsCard(moduleId);
}

function cancelAssumptionsInlineDraft(moduleId) {
  const state = getAssumptionsEditorState(moduleId);
  state.phase = 'idle';
  state.errors = {};
  state.draftValues = {};
  clearAssumptionsEditorTimers(state);
  refreshInlineAssumptionsCard(moduleId);
}

function setAssumptionDraftValue(moduleId, field, value) {
  if (!field) {
    return;
  }

  const state = getAssumptionsEditorState(moduleId);
  state.draftValues = {
    ...(state.draftValues || {}),
    [field]: value
  };
  clearAssumptionsFieldErrors(state, [field]);
}

async function commitInlineAssumption({
  moduleId,
  calculator,
  field = null,
  value,
  modeOverride = null
}) {
  if (runtimeConfig.readOnly || !moduleId || !calculator) {
    return;
  }

  const module = getModuleById(appState.session, moduleId);
  if (!module) {
    return;
  }

  ensureGenerated(module);
  const state = getAssumptionsEditorState(moduleId);
  if (field && typeof value !== 'undefined') {
    state.draftValues = {
      ...(state.draftValues || {}),
      [field]: value
    };
  }

  clearAssumptionsFieldErrors(state, [field, 'fixedPaymentMode', 'fixedPaymentAmount'].filter(Boolean));
  setAssumptionsEditorPhase(moduleId, 'updating');

  let result;
  if (calculator === 'pension') {
    const rawValue = hasOwnPropertyValue(state.draftValues, field) ? state.draftValues[field] : value;
    result = commitPensionAssumptionField({
      module,
      state,
      field,
      rawValue
    });
  } else if (calculator === 'mortgage') {
    const rawValue = field && hasOwnPropertyValue(state.draftValues, field) ? state.draftValues[field] : value;
    result = commitMortgageAssumptionField({
      module,
      state,
      field,
      rawValue,
      modeOverride
    });
  } else {
    return;
  }

  if (!result?.ok) {
    const errorField = result?.field || (calculator === 'mortgage' ? 'currentBalance' : 'growthRate');
    setAssumptionsFieldError(state, errorField, result?.message || 'Could not update assumptions.');
    setAssumptionsEditorPhase(moduleId, 'idle');
    return;
  }

  if (modeOverride === 'fixed' || modeOverride === 'calculated') {
    clearAssumptionsDraftFields(state, ['fixedPaymentMode']);
  }

  state.errors = {};
  module.updatedAt = nowIso();
  setAssumptionsEditorPhase(moduleId, 'updated');

  patchFocusedModuleGeneratedContent(moduleId, {
    patchSummary: true,
    patchAssumptions: true,
    patchOutputs: true,
    updateCharts: true
  });

  if (appState.mode === 'overview') {
    refreshOverview({ enableSortable: true });
  }

  markSessionDirty();
  saveSessionNow();
}

function handleAssumptionsEditorPatch(action) {
  if (!action || typeof action !== 'object') {
    return;
  }

  const {
    type,
    moduleId,
    calculator,
    field,
    value,
    mode
  } = action;

  if (runtimeConfig.readOnly || !moduleId) {
    return;
  }

  switch (type) {
    case 'toggle-edit-mode':
      toggleAssumptionsEditMode(moduleId);
      return;
    case 'cancel-edit':
      cancelAssumptionsInlineDraft(moduleId);
      return;
    case 'draft-change':
      if (!field) {
        return;
      }
      setAssumptionDraftValue(moduleId, field, value);
      return;
    case 'set-payment-mode': {
      const normalizedMode = mode === 'fixed' ? 'fixed' : 'calculated';
      setAssumptionDraftValue(moduleId, 'fixedPaymentMode', normalizedMode);
      void commitInlineAssumption({
        moduleId,
        calculator,
        field: 'fixedPaymentMode',
        modeOverride: normalizedMode
      });
      return;
    }
    case 'commit-field':
      if (!field || !calculator) {
        return;
      }
      void commitInlineAssumption({
        moduleId,
        calculator,
        field,
        value
      });
      return;
    default:
      return;
  }
}

function updateUiChrome() {
  const activeIndex = getActiveIndex();
  updateControls(ui, {
    mode: appState.mode,
    moduleCount: appState.session.modules.length,
    hasPrevious: activeIndex > 0,
    hasNext: hasNextModule(),
    readOnly: runtimeConfig.readOnly
  });

  document.body.classList.toggle('compare-mode', appState.mode === 'compare');
  renderGreeting(ui, appState.session.clientName);
}

function getFocusedPaneForModule(module, {
  readOnly = runtimeConfig.readOnly,
  showPensionToggle = runtimeConfig.showPensionToggle,
  cardId = 'focusCard'
} = {}) {
  const moduleNumber = Math.max(1, appState.session.order.indexOf(module.id) + 1);

  ensureGenerated(module);
  const assumptionsEditorStatus = getAssumptionsEditorRenderStatus(module.id);

  return buildFocusedPane({
    module,
    moduleNumber,
    onTitleInput: (moduleId, value) => updateModule(moduleId, { title: value }),
    onNotesInput: (moduleId, value) => updateModule(moduleId, { notes: value }),
    onPatchInputs: (patch) => handleAssumptionsEditorPatch(patch),
    assumptionsEditorStatus,
    readOnly,
    showPensionToggle,
    cardId
  });
}

function getComparePairModules() {
  if (!appState.compare) {
    return null;
  }

  const left = getModuleById(appState.session, appState.compare.leftId);
  const right = getModuleById(appState.session, appState.compare.rightId);
  if (!left || !right) {
    return null;
  }

  return [left, right];
}

function bindCompareScrollSync(leftScrollable, rightScrollable) {
  if (!leftScrollable || !rightScrollable) {
    return () => {};
  }

  let syncLock = false;
  const sync = (source, target) => {
    if (!appState.compare?.syncScroll || syncLock) {
      return;
    }

    syncLock = true;
    target.scrollTop = source.scrollTop;
    target.scrollLeft = source.scrollLeft;
    syncLock = false;
  };

  const onLeftScroll = () => sync(leftScrollable, rightScrollable);
  const onRightScroll = () => sync(rightScrollable, leftScrollable);

  leftScrollable.addEventListener('scroll', onLeftScroll, { passive: true });
  rightScrollable.addEventListener('scroll', onRightScroll, { passive: true });

  if (appState.compare?.syncScroll) {
    rightScrollable.scrollTop = leftScrollable.scrollTop;
    rightScrollable.scrollLeft = leftScrollable.scrollLeft;
  }

  return () => {
    leftScrollable.removeEventListener('scroll', onLeftScroll);
    rightScrollable.removeEventListener('scroll', onRightScroll);
  };
}

async function renderCompareView() {
  const pair = getComparePairModules();
  if (!pair) {
    await exitCompareView({ preserveSelection: true });
    return false;
  }

  const [leftModule, rightModule] = pair;
  destroySortable();
  destroyAllCharts();
  clearCompareScrollSyncCleanup();
  setDevPanelOpen(false);

  const root = document.createElement('section');
  root.className = 'compare-root';
  root.dataset.compareRoot = 'true';

  const controls = document.createElement('header');
  controls.className = 'compare-controls';

  const leftTitle = leftModule.title?.trim() || 'Untitled Module';
  const rightTitle = rightModule.title?.trim() || 'Untitled Module';

  const compareLabel = document.createElement('div');
  compareLabel.className = 'compare-label';
  compareLabel.textContent = `${leftTitle} vs ${rightTitle}`;
  controls.appendChild(compareLabel);

  const buttons = document.createElement('div');
  buttons.className = 'compare-control-buttons';

  const exitButton = document.createElement('button');
  exitButton.type = 'button';
  exitButton.className = 'ui-button compare-control-btn';
  exitButton.textContent = 'Exit compare';
  exitButton.addEventListener('click', async () => {
    await exitCompareView({ preserveSelection: true });
  });
  buttons.appendChild(exitButton);

  const swapButton = document.createElement('button');
  swapButton.type = 'button';
  swapButton.className = 'ui-button compare-control-btn';
  swapButton.textContent = 'Swap';
  swapButton.addEventListener('click', async () => {
    if (!appState.compare) {
      return;
    }
    const previousLeftId = appState.compare.leftId;
    appState.compare.leftId = appState.compare.rightId;
    appState.compare.rightId = previousLeftId;
    await renderCompareView();
  });
  buttons.appendChild(swapButton);

  const syncButton = document.createElement('button');
  syncButton.type = 'button';
  syncButton.className = 'ui-button compare-control-btn';
  syncButton.textContent = `Sync scroll: ${appState.compare?.syncScroll === false ? 'Off' : 'On'}`;
  syncButton.addEventListener('click', async () => {
    if (!appState.compare) {
      return;
    }
    appState.compare.syncScroll = appState.compare.syncScroll === false;
    await renderCompareView();
  });
  buttons.appendChild(syncButton);

  controls.appendChild(buttons);
  root.appendChild(controls);

  const panes = document.createElement('div');
  panes.className = 'compare-panes';

  const buildComparePane = (module, sideKey) => {
    const paneShell = document.createElement('article');
    paneShell.className = `compare-pane compare-pane-${sideKey}`;
    paneShell.dataset.comparePane = sideKey;

    const paneContent = getFocusedPaneForModule(module, {
      readOnly: true,
      showPensionToggle: false,
      cardId: ''
    });
    paneShell.appendChild(paneContent);

    return paneShell;
  };

  const leftPane = buildComparePane(leftModule, 'left');
  const rightPane = buildComparePane(rightModule, 'right');
  panes.appendChild(leftPane);
  panes.appendChild(rightPane);
  root.appendChild(panes);

  ui.swipeStage.innerHTML = '';
  ui.swipeStage.classList.add('is-compare');
  ui.swipeStage.appendChild(root);

  const leftScrollable = leftPane.querySelector('.focused-module-card');
  const rightScrollable = rightPane.querySelector('.focused-module-card');
  appState.compareScrollCleanup = bindCompareScrollSync(leftScrollable, rightScrollable);

  appState.mode = 'compare';
  setMode(ui, 'focused');
  updateUiChrome();

  renderChartsForPane(leftPane, leftModule, {
    clientName: appState.session.clientName || 'Client',
    moduleTitle: leftTitle,
    paneKey: 'compare-left'
  });
  renderChartsForPane(rightPane, rightModule, {
    clientName: appState.session.clientName || 'Client',
    moduleTitle: rightTitle,
    paneKey: 'compare-right'
  });

  return true;
}

async function exitCompareView({ preserveSelection = true } = {}) {
  clearCompareScrollSyncCleanup();
  destroyAllCharts();
  appState.compare = null;
  ui.swipeStage.classList.remove('is-compare');

  if (!preserveSelection) {
    clearSelection();
  }

  if (!hasModules()) {
    appState.mode = 'greeting';
    ui.swipeStage.innerHTML = '';
    setMode(ui, 'greeting');
    updateUiChrome();
    return;
  }

  appState.mode = 'overview';
  setMode(ui, 'overview');
  refreshOverview({ enableSortable: true });
  updateUiChrome();
}

async function renderFocused({
  useSwipe = true,
  direction = 'forward',
  revealMode = true,
  deferCharts = false
} = {}) {
  clearCompareScrollSyncCleanup();
  appState.compare = null;
  ui.swipeStage.classList.remove('is-compare');
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

function getOverviewScrollPosition() {
  return {
    top: ui.overviewViewport?.scrollTop || 0,
    left: ui.overviewViewport?.scrollLeft || 0
  };
}

function restoreOverviewScrollPosition(position) {
  if (!ui.overviewViewport || !position) {
    return;
  }

  ui.overviewViewport.scrollTop = Number(position.top) || 0;
  ui.overviewViewport.scrollLeft = Number(position.left) || 0;
}

async function runCompareFromSelection() {
  const pair = getSelectedPair();
  if (!pair) {
    showToast('Select exactly 2 modules to compare.', 'error');
    return;
  }

  appState.compare = {
    leftId: pair[0],
    rightId: pair[1],
    syncScroll: true
  };
  await renderCompareView();
}

function restoreSessionModeAfterDeletion() {
  if (!hasModules()) {
    appState.mode = 'greeting';
    ui.swipeStage.innerHTML = '';
    destroyAllCharts();
    clearCompareScrollSyncCleanup();
    setMode(ui, 'greeting');
    updateUiChrome();
    return;
  }

  appState.mode = 'overview';
  appState.compare = null;
  clearCompareScrollSyncCleanup();
  ui.swipeStage.classList.remove('is-compare');
  setMode(ui, 'overview');
  refreshOverview({ enableSortable: true });
  updateUiChrome();
}

function deleteSelectedModulesWithUndo() {
  const selectedIds = pruneOverviewSelection();
  if (selectedIds.length === 0) {
    return;
  }

  const snapshot = captureUndoSnapshot();
  const selectedSet = new Set(selectedIds);
  const orderBefore = [...appState.session.order];
  const earliestDeletedIndex = orderBefore.findIndex((moduleId) => selectedSet.has(moduleId));

  appState.session.modules = appState.session.modules.filter((module) => !selectedSet.has(module.id));
  appState.session.order = appState.session.order.filter((moduleId) => !selectedSet.has(moduleId));

  const activeDeleted = selectedSet.has(appState.session.activeModuleId);
  if (appState.session.order.length === 0) {
    appState.session.activeModuleId = null;
  } else if (activeDeleted) {
    let fallbackId = null;
    for (let index = earliestDeletedIndex - 1; index >= 0; index -= 1) {
      const candidate = orderBefore[index];
      if (!selectedSet.has(candidate) && appState.session.order.includes(candidate)) {
        fallbackId = candidate;
        break;
      }
    }

    appState.session.activeModuleId = fallbackId || appState.session.order[0];
  } else {
    ensureActiveModule(appState.session);
  }

  clearSelection();
  restoreSessionModeAfterDeletion();
  markSessionDirty();
  saveSessionNow();

  const label = `${selectedIds.length} module${selectedIds.length === 1 ? '' : 's'} deleted`;
  startUndoSnackbar({
    message: label,
    snapshot
  });
}

function clearSelectionWithUndo() {
  const selectedIds = pruneOverviewSelection();
  if (selectedIds.length === 0) {
    return;
  }

  const snapshot = captureUndoSnapshot();
  clearSelection();
  refreshOverview({ enableSortable: true });
  startUndoSnackbar({
    message: 'Selection cleared',
    snapshot
  });
}

function keepMostRecentTwoWithUndo() {
  const selectedIds = pruneOverviewSelection();
  if (selectedIds.length <= 2) {
    return;
  }

  const snapshot = captureUndoSnapshot();
  keepMostRecentTwoSelected();
  refreshOverview({ enableSortable: true });
  startUndoSnackbar({
    message: 'Kept most recent 2 selections',
    snapshot
  });
}

async function handleOverviewSelectionAction(action) {
  if (appState.mode !== 'overview') {
    return;
  }

  switch (action) {
    case 'clear-selection':
      clearSelectionWithUndo();
      return;
    case 'delete-selected':
      if (runtimeConfig.readOnly) {
        return;
      }
      deleteSelectedModulesWithUndo();
      return;
    case 'compare-selected':
      await runCompareFromSelection();
      return;
    case 'keep-most-recent-two':
      keepMostRecentTwoWithUndo();
      return;
    default:
      return;
  }
}

function refreshOverview({ enableSortable = appState.mode === 'overview' } = {}) {
  pruneOverviewSelection();
  const modules = getModulesInOrder();
  const scrollPosition = getOverviewScrollPosition();

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
    selectedModuleIds: appState.overviewSelection,
    onCardClick: async (moduleId, cardEl, event) => {
      const multiSelect = Boolean(event?.metaKey || event?.ctrlKey);
      if (multiSelect) {
        event.preventDefault();
        toggleSelected(moduleId);
        refreshOverview({ enableSortable: true });
        return;
      }
      await zoomIntoModuleFromOverview(moduleId, cardEl);
    },
    onSelectionAction: async (action) => {
      await handleOverviewSelectionAction(action);
    }
  });
  restoreOverviewScrollPosition(scrollPosition);

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

  if (runtimeConfig.readOnly) {
    return;
  }

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
        scheduleSessionSave();
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
    scheduleSessionSave();
  }

  appState.transitionLock = false;
}

async function zoomOutToOverviewMode() {
  if (appState.transitionLock || appState.mode === 'overview' || appState.mode === 'compare' || !hasModules() || getIsZoomAnimating()) {
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

  if (appState.mode === 'compare') {
    await exitCompareView({ preserveSelection: true });
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
  if (runtimeConfig.readOnly || appState.transitionLock || getIsZoomAnimating()) {
    return null;
  }

  const module = createBlankModule();
  appState.session.modules.push(module);
  appState.session.order.push(module.id);
  appState.session.activeModuleId = module.id;

  scheduleSessionSave();

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
    if (generatedPatch.pensionInputs) {
      module.generated.mortgageInputs = null;
      module.generated.loanInputs = null;
    }
  }

  if ('mortgageInputs' in generatedPatch) {
    module.generated.mortgageInputs = generatedPatch.mortgageInputs;
    if (generatedPatch.mortgageInputs) {
      module.generated.pensionInputs = null;
      module.generated.loanInputs = null;
    }
  }

  if ('loanInputs' in generatedPatch) {
    module.generated.loanInputs = generatedPatch.loanInputs;
    if (generatedPatch.loanInputs) {
      module.generated.pensionInputs = null;
      module.generated.mortgageInputs = null;
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

  if ('charts' in generatedPatch) {
    module.generated.charts = generatedPatch.charts.map((chart, index) => ({
      ...chart,
      id: chart.id || makeChartId(module.id, chart.title, index)
    }));
  }
}

async function applyModuleUpdateInternal(payload, options = {}) {
  if (runtimeConfig.readOnly) {
    throw new Error('This session is read only.');
  }

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

    const hasPensionInputsPatch = 'pensionInputs' in normalizedPayload.generated;
    const hasMortgageInputsPatch = 'mortgageInputs' in normalizedPayload.generated;
    const hasLoanInputsPatch = 'loanInputs' in normalizedPayload.generated;

    if (hasLoanInputsPatch && module.generated.loanInputs) {
      applyMortgageProjectionToModule(module, { updateSummary: true });
      resetAssumptionsEditorState(module.id);
    } else if (hasMortgageInputsPatch && module.generated.mortgageInputs) {
      applyMortgageProjectionToModule(module, { updateSummary: true });
      resetAssumptionsEditorState(module.id);
    } else if (hasPensionInputsPatch && module.generated.pensionInputs) {
      applyPensionProjectionToModule(module, { updateSummary: true });
      resetAssumptionsEditorState(module.id);
    }
  }

  module.updatedAt = nowIso();

  if (appState.session.activeModuleId === module.id && appState.mode === 'focused') {
    await renderFocused({ useSwipe: false, revealMode: true });
  }

  if (appState.mode === 'overview') {
    refreshOverview({ enableSortable: true });
  }

  markSessionDirty();
  saveSessionNow();

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
    renderDevPayloadWarnings([]);
    showToast('Invalid JSON (check quotes)', 'error');
    return;
  }

  const { payload: repairedPayload, warnings } = normalizeDevPanelPayload(parsed);
  renderDevPayloadWarnings(warnings);
  if (warnings.length > 0) {
    console.warn('[CallCanvas][DevPayload] auto-repairs applied', warnings);
  }

  try {
    await applyModuleUpdateInternal(repairedPayload, { createNewModule: createNewModuleFirst });
    showToast(warnings.length > 0
      ? `Payload applied with ${warnings.length} auto-repair${warnings.length === 1 ? '' : 's'}.`
      : 'Payload applied successfully.');
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
  scheduleSessionSave();

  await renderFocused({
    useSwipe: true,
    direction: 'backward',
    revealMode: true
  });
}

async function focusNextModule() {
  if (appState.transitionLock || appState.mode !== 'focused' || getIsZoomAnimating()) {
    return;
  }

  const activeIndex = getActiveIndex();
  if (activeIndex < 0 || activeIndex >= appState.session.order.length - 1) {
    return;
  }

  appState.session.activeModuleId = appState.session.order[activeIndex + 1];
  scheduleSessionSave();

  await renderFocused({
    useSwipe: true,
    direction: 'forward',
    revealMode: true
  });
}

async function handleLoadSessionFromFile(file) {
  if (runtimeConfig.readOnly) {
    return;
  }

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
  if (runtimeConfig.readOnly) {
    return;
  }

  const confirmed = window.confirm('Start a new call? Unsaved changes will be lost.');
  if (!confirmed) {
    return;
  }

  const fresh = newSession('Client');
  await replaceSession(fresh, { markClean: true });
  showToast('New call started.');
}

function bindEvents() {
  if (ui.clientNameInput && !runtimeConfig.readOnly) {
    ui.clientNameInput.addEventListener('input', (event) => {
      appState.session.clientName = normalizeClientName(event.target.value);
      renderGreeting(ui, appState.session.clientName);
      scheduleSessionSave();
    });
  }

  if (!runtimeConfig.readOnly && ui.newCallButton) {
    ui.newCallButton.addEventListener('click', async () => {
      await handleNewCall();
    });
  }

  if (!runtimeConfig.readOnly && runtimeConfig.allowPublish && ui.publishSessionButton) {
    ui.publishSessionButton.addEventListener('click', () => {
      setPublishError('');
      resetPublishResult();
      setPublishModalOpen(true);
    });
  }

  if (ui.publishCloseButton) {
    ui.publishCloseButton.addEventListener('click', () => {
      setPublishModalOpen(false);
    });
  }

  if (ui.publishModal) {
    ui.publishModal.addEventListener('click', (event) => {
      if (event.target === ui.publishModal) {
        setPublishModalOpen(false);
      }
    });
  }

  if (ui.publishGenerateButton) {
    ui.publishGenerateButton.addEventListener('click', async () => {
      await handlePublishGenerate();
    });
  }

  if (ui.publishCopyPinButton) {
    ui.publishCopyPinButton.addEventListener('click', async () => {
      await handleCopyPublishedPin();
    });
  }

  if (ui.publishCopyLinkButton) {
    ui.publishCopyLinkButton.addEventListener('click', async () => {
      await handleCopyPublishedLink();
    });
  }

  if (ui.publishRevokeButton) {
    ui.publishRevokeButton.addEventListener('click', async () => {
      await handleRevokePublishedAccess();
    });
  }

  if (!runtimeConfig.readOnly && ui.loadSessionButton) {
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

  if (!runtimeConfig.readOnly && ui.playbookSelect) {
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

  if (!runtimeConfig.readOnly && ui.newModuleButton) {
    ui.newModuleButton.addEventListener('click', async () => {
      await createNewModule();
    });
  }

  if (ui.nextArrowButton) {
    ui.nextArrowButton.addEventListener('click', async () => {
      if (runtimeConfig.readOnly) {
        await focusNextModule();
      } else {
        await createNewModule();
      }
    });
  }

  if (ui.prevArrowButton) {
    ui.prevArrowButton.addEventListener('click', async () => {
      await focusPreviousModule();
    });
  }

  if (ui.zoomButton) {
    ui.zoomButton.addEventListener('click', async () => {
      await toggleOverview();
    });
  }

  if (!runtimeConfig.readOnly && ui.resetButton) {
    ui.resetButton.addEventListener('click', () => {
      destroyAllCharts();
      stateManager.reset();
      window.location.reload();
    });
  }

  if (runtimeConfig.allowDevPanel && ui.devLoadExampleBtn) {
    ui.devLoadExampleBtn.addEventListener('click', () => {
      loadSelectedExampleIntoEditor();
    });
  }

  if (runtimeConfig.allowDevPanel && ui.devClearBtn) {
    ui.devClearBtn.addEventListener('click', () => {
      if (ui.devPayloadInput) {
        ui.devPayloadInput.value = '';
      }
      renderDevPayloadWarnings([]);
    });
  }

  if (runtimeConfig.allowDevPanel && ui.devApplyBtn) {
    ui.devApplyBtn.addEventListener('click', async () => {
      await applyPayloadFromEditor({ createNewModuleFirst: false });
    });
  }

  if (runtimeConfig.allowDevPanel && ui.devCreateApplyBtn) {
    ui.devCreateApplyBtn.addEventListener('click', async () => {
      await applyPayloadFromEditor({ createNewModuleFirst: true });
    });
  }

  if (runtimeConfig.allowDevPanel && ui.devCloseBtn) {
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

    if (!typing && runtimeConfig.allowDevPanel && appState.mode !== 'compare' && lower === 'd') {
      event.preventDefault();
      setDevPanelOpen(!appState.devPanelOpen);
      return;
    }

    if (typing && key !== 'Escape') {
      return;
    }

    if (lower === 'n') {
      if (appState.mode === 'compare') {
        return;
      }
      if (runtimeConfig.readOnly) {
        return;
      }
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
      if (appState.mode === 'compare') {
        return;
      }
      event.preventDefault();
      if (runtimeConfig.readOnly) {
        await focusNextModule();
      } else {
        await createNewModule();
      }
      return;
    }

    if (key === 'ArrowLeft') {
      if (appState.mode === 'compare') {
        return;
      }
      event.preventDefault();
      await focusPreviousModule();
      return;
    }

    if (key === 'Escape' && ui.publishModal && !ui.publishModal.classList.contains('is-hidden')) {
      event.preventDefault();
      setPublishModalOpen(false);
      return;
    }

    if (runtimeConfig.allowDevPanel && key === 'Escape' && appState.devPanelOpen) {
      event.preventDefault();
      setDevPanelOpen(false);
      return;
    }

    if (key === 'Escape' && appState.mode === 'compare') {
      event.preventDefault();
      await exitCompareView({ preserveSelection: true });
      return;
    }

    if (key === 'Enter' && appState.mode === 'overview') {
      if (getSelectedPair()) {
        event.preventDefault();
        await runCompareFromSelection();
      }
      return;
    }

    if (key === 'Escape' && appState.mode === 'overview') {
      if (appState.overviewSelection.length > 0) {
        event.preventDefault();
        clearSelectionWithUndo();
      }
    }
  });

  window.addEventListener('beforeunload', () => {
    saveSessionNow();
  });
}

function applyRuntimeOptions(options = {}) {
  runtimeConfig.readOnly = Boolean(options.readOnly);
  runtimeConfig.allowDevPanel = !runtimeConfig.readOnly && options.allowDevPanel !== false;
  runtimeConfig.allowPublish = !runtimeConfig.readOnly && options.allowPublish !== false;
  runtimeConfig.showPensionToggle = !runtimeConfig.readOnly && options.showPensionToggle !== false;
  runtimeConfig.persistLocalSession = !runtimeConfig.readOnly && options.persistLocalSession !== false;
}

let initPromise = null;

export async function initApp(options = {}) {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    applyRuntimeOptions(options);
    const workerMissing = !WORKER_BASE_URL;

    if (!runtimeConfig.readOnly && runtimeConfig.allowPublish && workerMissing) {
      runtimeConfig.allowPublish = false;
    }

    if ('initialSession' in options && options.initialSession != null) {
      appState.session = importSession(options.initialSession);
    } else {
      appState.session = loadSession();
    }

    ensureActiveModule(appState.session);
    appState.mode = hasModules() ? 'focused' : 'greeting';

    applyRuntimeChrome();
    resetPublishResult();
    bindEvents();
    populatePlaybooks();

    if (runtimeConfig.allowDevPanel) {
      populateDevExamples();
      loadSelectedExampleIntoEditor();
    } else {
      renderDevPayloadWarnings([]);
    }

    renderGreeting(ui, appState.session.clientName);
    if (!runtimeConfig.readOnly && workerMissing) {
      showToast('Publishing is disabled: worker URL is not configured for this environment.', 'error');
    }
    if (runtimeConfig.readOnly && ui.sessionStatus) {
      ui.sessionStatus.textContent = 'Read only';
      ui.sessionStatus.classList.remove('is-dirty');
    } else {
      updateSessionStatus(ui, stateManager.isDirty());
    }

    window.applyModuleUpdate = async (payload) => {
      if (runtimeConfig.readOnly) {
        throw new Error('This session is read only.');
      }

      const { payload: repairedPayload, warnings } = normalizeDevPanelPayload(payload);
      if (warnings.length > 0) {
        console.warn('[CallCanvas][applyModuleUpdate] auto-repairs applied', warnings);
      }
    return applyModuleUpdateInternal(repairedPayload, {});
  };
  window.__setPensionShowMax = (moduleId, value) => {
    setPensionShowMaxForModule(moduleId, value);
  };
  window.__getPensionShowMaxForModule = (moduleId) => getPensionShowMaxForModule(moduleId);
  window.__runMortgageMathTests = () => runMortgageMathTests();

    if (appState.mode === 'focused') {
      await renderFocused({ useSwipe: false, revealMode: true });
    } else {
      setMode(ui, 'greeting');
      updateUiChrome();
    }
  })();

  return initPromise;
}

if (window.__CALL_CANVAS_AUTO_INIT__ !== false) {
  void initApp();
}
