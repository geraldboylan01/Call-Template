const STORAGE_KEY = 'call_canvas_session_current';
const LEGACY_STORAGE_KEY = 'call-template-session-v1';
const SESSION_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function makeSessionId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return `session-${window.crypto.randomUUID()}`;
  }

  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRow(row) {
  if (!Array.isArray(row)) {
    return [];
  }

  return row.map((value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      return value;
    }

    return String(value ?? '');
  });
}

function normalizeTable(table) {
  if (!table || typeof table !== 'object') {
    return {
      columns: [],
      rows: []
    };
  }

  const columns = Array.isArray(table.columns)
    ? table.columns.map((column) => String(column ?? ''))
    : [];

  const rows = Array.isArray(table.rows)
    ? table.rows.map((row) => normalizeRow(row))
    : [];

  return {
    columns,
    rows
  };
}

function normalizeChartDataset(dataset, index) {
  const label = typeof dataset?.label === 'string'
    ? dataset.label
    : `Series ${index + 1}`;
  const data = Array.isArray(dataset?.data)
    ? dataset.data.map((value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    })
    : [];

  return {
    label,
    data
  };
}

function normalizeCharts(charts) {
  if (!Array.isArray(charts)) {
    return [];
  }

  return charts
    .filter((chart) => chart && typeof chart === 'object')
    .map((chart, index) => ({
      id: typeof chart.id === 'string' && chart.id.trim()
        ? chart.id
        : `chart-${index + 1}`,
      title: typeof chart.title === 'string' ? chart.title : `Chart ${index + 1}`,
      type: chart.type === 'bar' ? 'bar' : 'line',
      labels: Array.isArray(chart.labels)
        ? chart.labels.map((label) => String(label ?? ''))
        : [],
      datasets: Array.isArray(chart.datasets)
        ? chart.datasets.map((dataset, datasetIndex) => normalizeChartDataset(dataset, datasetIndex))
        : []
    }));
}

function normalizeGeneratedTables(tables) {
  if (!Array.isArray(tables)) {
    return [];
  }

  return tables
    .filter((table) => table && typeof table === 'object' && !Array.isArray(table))
    .map((table, index) => ({
      title: typeof table.title === 'string' && table.title.trim()
        ? table.title
        : `Table ${index + 1}`,
      ...normalizeTable(table)
    }));
}

function normalizeOutputsBucketed(outputsBucketed) {
  if (!outputsBucketed || typeof outputsBucketed !== 'object' || Array.isArray(outputsBucketed)) {
    return null;
  }

  const sections = Array.isArray(outputsBucketed.sections)
    ? outputsBucketed.sections
      .filter((section) => section && typeof section === 'object' && !Array.isArray(section))
      .map((section, index) => {
        const title = typeof section.title === 'string' && section.title.trim()
          ? section.title.trim()
          : `Section ${index + 1}`;
        const key = typeof section.key === 'string' && section.key.trim()
          ? section.key.trim().toLowerCase()
          : `section_${index + 1}`;
        const columns = Array.isArray(section.columns) && section.columns.length === 2
          ? section.columns.map((column) => String(column ?? ''))
          : ['Asset', 'Amount (€)'];
        const rows = Array.isArray(section.rows)
          ? section.rows
            .filter((row) => Array.isArray(row) && row.length >= 2 && typeof row[1] === 'number' && Number.isFinite(row[1]))
            .map((row) => [String(row[0] ?? ''), row[1]])
          : [];
        const subtotalLabel = typeof section.subtotalLabel === 'string' && section.subtotalLabel.trim()
          ? section.subtotalLabel
          : 'Subtotal';
        const subtotalValue = typeof section.subtotalValue === 'number' && Number.isFinite(section.subtotalValue)
          ? section.subtotalValue
          : null;
        const notes = typeof section.notes === 'string' ? section.notes : '';

        return {
          key,
          title,
          columns,
          rows,
          subtotalLabel,
          subtotalValue,
          notes
        };
      })
    : [];

  if (sections.length === 0) {
    return null;
  }

  return {
    currencySymbol: typeof outputsBucketed.currencySymbol === 'string' && outputsBucketed.currencySymbol.trim()
      ? outputsBucketed.currencySymbol
      : '€',
    sections
  };
}

function normalizePensionInputs(pensionInputs) {
  if (!pensionInputs || typeof pensionInputs !== 'object' || Array.isArray(pensionInputs)) {
    return null;
  }

  const normalized = {};

  [
    'currentAge',
    'retirementAge',
    'currentSalary',
    'currentPot',
    'personalPct',
    'employerPct',
    'growthRate',
    'targetIncomeToday',
    'targetIncomePctOfSalary',
    'inflationRate',
    'wageGrowthRate',
    'horizonEndAge',
    'currentYear'
  ].forEach((key) => {
    if (typeof pensionInputs[key] === 'number' && Number.isFinite(pensionInputs[key])) {
      normalized[key] = pensionInputs[key];
    }
  });

  if (typeof pensionInputs.minDrawdownMode === 'boolean') {
    normalized.minDrawdownMode = pensionInputs.minDrawdownMode;
  }

  const incomeMode = typeof pensionInputs.incomeMode === 'string'
    ? pensionInputs.incomeMode.trim().toLowerCase()
    : '';
  if (incomeMode === 'target' || incomeMode === 'affordable') {
    normalized.incomeMode = incomeMode;
  }

  if (Array.isArray(pensionInputs.affordableEndAges)) {
    const dedupedSorted = [...new Set(
      pensionInputs.affordableEndAges
        .filter((value) => typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value))
    )].sort((left, right) => left - right);

    if (dedupedSorted.length > 0) {
      normalized.affordableEndAges = dedupedSorted;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeMortgageInputs(mortgageInputs, { defaultLoanKind = 'mortgage' } = {}) {
  if (!mortgageInputs || typeof mortgageInputs !== 'object' || Array.isArray(mortgageInputs)) {
    return null;
  }

  const normalized = {};
  [
    'currentBalance',
    'annualInterestRate',
    'remainingTermYears',
    'fixedPaymentAmount',
    'oneOffOverpayment',
    'annualOverpayment'
  ].forEach((key) => {
    if (typeof mortgageInputs[key] === 'number' && Number.isFinite(mortgageInputs[key])) {
      normalized[key] = mortgageInputs[key];
    }
  });

  if (typeof mortgageInputs.startDateIso === 'string' && mortgageInputs.startDateIso.trim()) {
    normalized.startDateIso = mortgageInputs.startDateIso.trim();
  }

  if (typeof mortgageInputs.endDateIso === 'string' && mortgageInputs.endDateIso.trim()) {
    normalized.endDateIso = mortgageInputs.endDateIso.trim();
  }

  if (mortgageInputs.fixedPaymentAmount === null) {
    normalized.fixedPaymentAmount = null;
  }

  if (typeof mortgageInputs.repaymentType === 'string' && mortgageInputs.repaymentType.trim()) {
    normalized.repaymentType = mortgageInputs.repaymentType.trim();
  }

  const loanKindRaw = typeof mortgageInputs.loanKind === 'string'
    ? mortgageInputs.loanKind.trim().toLowerCase()
    : '';
  if (loanKindRaw === 'mortgage' || loanKindRaw === 'loan') {
    normalized.loanKind = loanKindRaw;
  } else {
    const fallbackLoanKind = String(defaultLoanKind || 'mortgage').trim().toLowerCase();
    normalized.loanKind = fallbackLoanKind === 'loan' ? 'loan' : 'mortgage';
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function createEmptyGenerated() {
  return {
    summaryHtml: '',
    assumptions: {
      columns: [],
      rows: []
    },
    outputs: {
      columns: [],
      rows: []
    },
    tables: [],
    pensionInputs: null,
    mortgageInputs: null,
    loanInputs: null,
    outputsBucketed: null,
    charts: []
  };
}

export function normalizeGenerated(generated) {
  if (!generated || typeof generated !== 'object') {
    return createEmptyGenerated();
  }

  return {
    summaryHtml: typeof generated.summaryHtml === 'string' ? generated.summaryHtml : '',
    assumptions: normalizeTable(generated.assumptions),
    outputs: normalizeTable(generated.outputs),
    tables: normalizeGeneratedTables(generated.tables),
    pensionInputs: normalizePensionInputs(generated.pensionInputs),
    mortgageInputs: normalizeMortgageInputs(generated.mortgageInputs, { defaultLoanKind: 'mortgage' }),
    loanInputs: normalizeMortgageInputs(generated.loanInputs, { defaultLoanKind: 'loan' }),
    outputsBucketed: normalizeOutputsBucketed(generated.outputsBucketed),
    charts: normalizeCharts(generated.charts)
  };
}

function createDefaultTableHighlightState() {
  return {
    selected: [],
    anchor: null
  };
}

function normalizeTableHighlightAnchor(anchor) {
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

function normalizeTableHighlightState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return createDefaultTableHighlightState();
  }

  const selected = Array.isArray(state.selected)
    ? [...new Set(state.selected
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean))]
    : [];

  return {
    selected,
    anchor: normalizeTableHighlightAnchor(state.anchor)
  };
}

function normalizeModuleUi(ui) {
  const tableHighlights = ui && typeof ui === 'object' && !Array.isArray(ui)
    && ui.tableHighlights && typeof ui.tableHighlights === 'object' && !Array.isArray(ui.tableHighlights)
    ? ui.tableHighlights
    : {};

  return {
    tableHighlights: {
      assumptions: normalizeTableHighlightState(tableHighlights.assumptions),
      outputs: normalizeTableHighlightState(tableHighlights.outputs)
    }
  };
}

function normalizeModules(modules) {
  if (!Array.isArray(modules)) {
    return [];
  }

  return modules
    .filter((item) => item && typeof item.id === 'string')
    .map((item) => ({
      id: item.id,
      createdAt: item.createdAt || nowIso(),
      updatedAt: item.updatedAt || item.createdAt || nowIso(),
      title: typeof item.title === 'string' ? item.title : '',
      notes: typeof item.notes === 'string' ? item.notes : '',
      generated: normalizeGenerated(item.generated),
      ui: normalizeModuleUi(item.ui)
    }));
}

function normalizeOrder(order, modules) {
  const ids = new Set(modules.map((module) => module.id));
  const cleanOrder = Array.isArray(order)
    ? order.filter((id) => typeof id === 'string' && ids.has(id))
    : [];

  const seen = new Set(cleanOrder);
  for (const module of modules) {
    if (!seen.has(module.id)) {
      cleanOrder.push(module.id);
      seen.add(module.id);
    }
  }

  return cleanOrder;
}

function normalizeSession(raw) {
  const modules = normalizeModules(raw?.modules);
  const order = normalizeOrder(raw?.order, modules);
  const activeModuleId = order.includes(raw?.activeModuleId)
    ? raw.activeModuleId
    : order[0] || null;

  return {
    version: SESSION_VERSION,
    sessionId: typeof raw?.sessionId === 'string' && raw.sessionId.trim()
      ? raw.sessionId
      : makeSessionId(),
    clientName: typeof raw?.clientName === 'string' && raw.clientName.trim()
      ? raw.clientName
      : 'Client',
    createdAt: raw?.createdAt || nowIso(),
    updatedAt: raw?.updatedAt || raw?.createdAt || nowIso(),
    modules,
    order,
    activeModuleId
  };
}

export function newSession(clientName = 'Client') {
  const timestamp = nowIso();
  return {
    version: SESSION_VERSION,
    sessionId: makeSessionId(),
    clientName,
    createdAt: timestamp,
    updatedAt: timestamp,
    modules: [],
    order: [],
    activeModuleId: null
  };
}

export function createFreshSession() {
  return newSession('Client');
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return createFreshSession();
    }

    const parsed = JSON.parse(raw);
    if (!parsed || (typeof parsed.version === 'number' && parsed.version !== SESSION_VERSION)) {
      return createFreshSession();
    }

    return normalizeSession(parsed);
  } catch (_error) {
    return createFreshSession();
  }
}

export function exportSession(session) {
  const normalized = normalizeSession(session);
  normalized.updatedAt = nowIso();
  return JSON.stringify(normalized, null, 2);
}

export function importSession(input) {
  let parsed = input;

  if (typeof input === 'string') {
    parsed = JSON.parse(input);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Session file must contain a JSON object.');
  }

  if (!Array.isArray(parsed.modules)) {
    throw new Error('Invalid session: modules must be an array.');
  }

  if (!Array.isArray(parsed.order)) {
    throw new Error('Invalid session: order must be an array.');
  }

  if (typeof parsed.clientName !== 'string') {
    throw new Error('Invalid session: clientName must be a string.');
  }

  if (typeof parsed.version === 'number' && parsed.version !== SESSION_VERSION) {
    throw new Error(`Unsupported session version: ${parsed.version}`);
  }

  return normalizeSession(parsed);
}

export function createStateManager(delayMs = 300, options = {}) {
  let timerId = null;
  let dirty = false;
  const onDirtyChange = typeof options.onDirtyChange === 'function'
    ? options.onDirtyChange
    : null;

  function setDirty(nextDirty) {
    if (dirty === nextDirty) {
      return;
    }

    dirty = nextDirty;
    if (onDirtyChange) {
      onDirtyChange(dirty);
    }
  }

  function persist(session) {
    session.updatedAt = nowIso();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }

  function saveNow(session, saveOptions = {}) {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }

    if (saveOptions.markDirty) {
      setDirty(true);
    }

    persist(session);
  }

  function scheduleSave(session) {
    setDirty(true);

    if (timerId) {
      clearTimeout(timerId);
    }

    timerId = window.setTimeout(() => {
      timerId = null;
      persist(session);
    }, delayMs);
  }

  function markDirty() {
    setDirty(true);
  }

  function markClean() {
    setDirty(false);
  }

  function isDirty() {
    return dirty;
  }

  function reset() {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }

    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    setDirty(false);
  }

  return {
    saveNow,
    scheduleSave,
    markDirty,
    markClean,
    isDirty,
    reset
  };
}

export function getModuleById(session, moduleId) {
  return session.modules.find((module) => module.id === moduleId) || null;
}

export function getOrderedModules(session) {
  const moduleById = new Map(session.modules.map((module) => [module.id, module]));
  return session.order
    .map((id) => moduleById.get(id))
    .filter(Boolean);
}

export function ensureActiveModule(session) {
  if (session.order.length === 0) {
    session.activeModuleId = null;
    return;
  }

  if (!session.order.includes(session.activeModuleId)) {
    session.activeModuleId = session.order[0];
  }
}

export function getStorageKey() {
  return STORAGE_KEY;
}
