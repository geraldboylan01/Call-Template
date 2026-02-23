const COLOR_PALETTE = ['#2ea3ff', '#67d7ff', '#7bffbf', '#ffd166', '#ff8fa3', '#b28dff'];
const chartRegistry = new Map();
const OVERLAY_LAYER_ID = 'chart-overlay-layer';
const SCALE_EPSILON = 0.01;
const PENSION_DATASET_LABELS = {
  currentPath: 'Pot (current)',
  maxPath: 'Pot (max)',
  personalCurrent: 'Personal (current)',
  employerCurrent: 'Employer (current)',
  growthCurrent: 'Growth (current)',
  personalMax: 'Personal (max)',
  employerMax: 'Employer (max)',
  growthMax: 'Growth (max)',
  sustainabilityCurrent: 'Balance (current)',
  sustainabilityMax: 'Balance (max)',
  requiredReference: 'Required pot path',
  withdrawals: 'Withdrawals'
};
const MORTGAGE_DATASET_LABELS = {
  balance: 'Remaining balance',
  principal: 'Principal repaid (annual)',
  interest: 'Interest paid (annual)'
};
const EURO_FORMATTER = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const warnedDprMismatchCanvases = new WeakSet();
const CHART_DIAGNOSTICS_QUERY_PARAM = 'chartdiag';
let overlaySyncRafId = 0;
let overlaySyncListenersBound = false;

function getElementScale(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') {
    return {
      scaleX: 1,
      scaleY: 1,
      rect: { width: 0, height: 0 }
    };
  }

  const rect = el.getBoundingClientRect();
  const widthRef = el.offsetWidth > 0
    ? el.offsetWidth
    : (el.clientWidth > 0 ? el.clientWidth : rect.width);
  const heightRef = el.offsetHeight > 0
    ? el.offsetHeight
    : (el.clientHeight > 0 ? el.clientHeight : rect.height);
  const rawScaleX = widthRef > 0 ? rect.width / widthRef : 1;
  const rawScaleY = heightRef > 0 ? rect.height / heightRef : 1;

  return {
    scaleX: Number.isFinite(rawScaleX) && rawScaleX > 0 ? rawScaleX : 1,
    scaleY: Number.isFinite(rawScaleY) && rawScaleY > 0 ? rawScaleY : 1,
    rect
  };
}

function getScaleInfo(el) {
  const self = getElementScale(el);
  let maxScaleX = self.scaleX;
  let maxScaleY = self.scaleY;
  let firstScaledAncestor = null;
  let current = el;

  while (current && current.nodeType === 1) {
    const { scaleX, scaleY } = getElementScale(current);
    const scaled = Math.abs(scaleX - 1) > SCALE_EPSILON || Math.abs(scaleY - 1) > SCALE_EPSILON;

    if (scaled && !firstScaledAncestor) {
      firstScaledAncestor = {
        tag: current.tagName?.toLowerCase() || 'unknown',
        className: typeof current.className === 'string' ? current.className : '',
        scaleX,
        scaleY
      };
    }

    if (Math.abs(scaleX - 1) > Math.abs(maxScaleX - 1)) {
      maxScaleX = scaleX;
    }
    if (Math.abs(scaleY - 1) > Math.abs(maxScaleY - 1)) {
      maxScaleY = scaleY;
    }

    if (current === document.body) {
      break;
    }
    current = current.parentElement;
  }

  return {
    selfScaleX: self.scaleX,
    selfScaleY: self.scaleY,
    maxScaleX,
    maxScaleY,
    firstScaledAncestor
  };
}

function hasScaleMismatch(scaleInfo) {
  const maxDelta = Math.max(
    Math.abs((scaleInfo?.maxScaleX ?? 1) - 1),
    Math.abs((scaleInfo?.maxScaleY ?? 1) - 1)
  );
  return maxDelta > SCALE_EPSILON;
}

function ensureOverlayLayer() {
  let layer = document.getElementById(OVERLAY_LAYER_ID);
  if (layer) {
    return layer;
  }

  layer = document.createElement('div');
  layer.id = OVERLAY_LAYER_ID;
  Object.assign(layer.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '100vw',
    height: '100vh',
    pointerEvents: 'none',
    zIndex: '1200'
  });
  document.body.appendChild(layer);
  return layer;
}

function positionOverlayForBlock(sourceEl, overlayWrapper) {
  if (!sourceEl || !overlayWrapper || typeof sourceEl.getBoundingClientRect !== 'function') {
    return;
  }

  const rect = sourceEl.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    overlayWrapper.style.display = 'none';
    return;
  }

  overlayWrapper.style.display = 'block';
  overlayWrapper.style.left = `${rect.left}px`;
  overlayWrapper.style.top = `${rect.top}px`;
  overlayWrapper.style.width = `${rect.width}px`;
  overlayWrapper.style.height = `${rect.height}px`;
}

function hasOverlayEntries() {
  for (const entry of chartRegistry.values()) {
    if (entry?.mode === 'overlay') {
      return true;
    }
  }
  return false;
}

function updateOverlayPositions() {
  for (const entry of chartRegistry.values()) {
    if (entry?.mode !== 'overlay') {
      continue;
    }

    if (!entry.overlayWrapper || !entry.positionSourceEl || !entry.positionSourceEl.isConnected) {
      continue;
    }

    positionOverlayForBlock(entry.positionSourceEl, entry.overlayWrapper);
  }
}

function scheduleOverlayPositionUpdate() {
  if (!hasOverlayEntries()) {
    return;
  }

  if (overlaySyncRafId) {
    return;
  }

  overlaySyncRafId = window.requestAnimationFrame(() => {
    overlaySyncRafId = 0;
    updateOverlayPositions();
  });
}

function handleOverlayViewportMutation() {
  scheduleOverlayPositionUpdate();
}

function ensureOverlaySyncListeners() {
  if (overlaySyncListenersBound) {
    return;
  }

  overlaySyncListenersBound = true;
  window.addEventListener('resize', handleOverlayViewportMutation, { passive: true });
  window.addEventListener('scroll', handleOverlayViewportMutation, { passive: true, capture: true });
}

function maybeTearDownOverlayInfrastructure() {
  if (hasOverlayEntries()) {
    return;
  }

  if (overlaySyncRafId) {
    window.cancelAnimationFrame(overlaySyncRafId);
    overlaySyncRafId = 0;
  }

  if (overlaySyncListenersBound) {
    window.removeEventListener('resize', handleOverlayViewportMutation);
    window.removeEventListener('scroll', handleOverlayViewportMutation, true);
    overlaySyncListenersBound = false;
  }

  const layer = document.getElementById(OVERLAY_LAYER_ID);
  if (layer) {
    layer.remove();
  }
}

function getEventPointer(event) {
  const source = event?.native || event;
  if (!source) {
    return null;
  }

  if (source.touches && source.touches.length > 0) {
    return source.touches[0];
  }

  if (source.changedTouches && source.changedTouches.length > 0) {
    return source.changedTouches[0];
  }

  return source;
}

function isChartDiagnosticsEnabled() {
  if (window.__CHART_DIAGNOSTICS__ === true) {
    return true;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    return params.get(CHART_DIAGNOSTICS_QUERY_PARAM) === '1';
  } catch (_error) {
    return false;
  }
}

function collectAncestorTransforms(startElement, maxDepth = 5) {
  const transforms = [];
  let current = startElement;
  let depth = 0;

  while (current && depth <= maxDepth) {
    const style = window.getComputedStyle(current);
    transforms.push({
      depth,
      tag: current.tagName?.toLowerCase() || 'unknown',
      id: current.id || '',
      className: typeof current.className === 'string' ? current.className : '',
      transform: style.transform || 'none'
    });

    current = current.parentElement;
    depth += 1;
  }

  return transforms;
}

function hasNonNoneTransform(items) {
  return Array.isArray(items) && items.some((item) => item.transform && item.transform !== 'none');
}

function parseCssPx(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.endsWith('px')) {
    return null;
  }

  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function getExpectedIndexFromPointerX(localX, chart, labelsLength) {
  const chartArea = chart?.chartArea;
  if (!chartArea || !Number.isFinite(localX) || labelsLength <= 1 || chartArea.right <= chartArea.left) {
    return null;
  }

  const fraction = (localX - chartArea.left) / (chartArea.right - chartArea.left);
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.round(clamped * (labelsLength - 1));
}

function maybeWarnDprMismatch(canvas) {
  if (!isChartDiagnosticsEnabled()) {
    return;
  }

  if (!canvas || warnedDprMismatchCanvases.has(canvas) || typeof canvas.getBoundingClientRect !== 'function') {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const expectedWidth = rect.width * dpr;
  const expectedHeight = rect.height * dpr;
  const widthDiffPct = expectedWidth > 0 ? Math.abs(canvas.width - expectedWidth) / expectedWidth : 0;

  if (widthDiffPct > 0.02) {
    warnedDprMismatchCanvases.add(canvas);
    console.warn('[CallCanvas][Chart] backing-size mismatch detected', {
      rectWidth: rect.width,
      rectHeight: rect.height,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      expectedWidth,
      expectedHeight,
      devicePixelRatio: dpr,
      ratioW: rect.width > 0 ? canvas.width / rect.width : null,
      ratioH: rect.height > 0 ? canvas.height / rect.height : null,
      widthDiffPct
    });
  }
}

function logChartCreationDiagnostics({ chart, canvas, block, paneElement, chartData, phase = 'create' }) {
  if (!isChartDiagnosticsEnabled()) {
    return;
  }

  if (!canvas || !block || !paneElement || typeof canvas.getBoundingClientRect !== 'function') {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const parent = canvas.parentElement;
  const parentRect = parent?.getBoundingClientRect?.() || null;
  const paneRect = paneElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const ratioW = rect.width > 0 ? canvas.width / rect.width : 0;
  const ratioH = rect.height > 0 ? canvas.height / rect.height : 0;
  const canvasStyle = window.getComputedStyle(canvas);
  const parentStyle = parent ? window.getComputedStyle(parent) : null;
  const cssWidthCanvas = parseCssPx(canvasStyle.width);
  const cssHeightCanvas = parseCssPx(canvasStyle.height);
  const cssWidthParent = parentStyle ? parseCssPx(parentStyle.width) : null;
  const cssHeightParent = parentStyle ? parseCssPx(parentStyle.height) : null;
  const canvasTransforms = collectAncestorTransforms(canvas, 5);
  const blockTransforms = collectAncestorTransforms(block, 5);
  const paneTransforms = collectAncestorTransforms(paneElement, 5);

  const summary = {
    phase,
    chart: chartData?.title || 'Untitled chart',
    ratioW: Number(ratioW.toFixed(4)),
    ratioH: Number(ratioH.toFixed(4)),
    dpr: Number(dpr.toFixed(4)),
    canvasRect: {
      width: Number(rect.width.toFixed(2)),
      height: Number(rect.height.toFixed(2))
    },
    canvasBuffer: {
      width: canvas.width,
      height: canvas.height
    },
    paneRect: {
      width: Number(paneRect.width.toFixed(2)),
      height: Number(paneRect.height.toFixed(2))
    },
    chartArea: chart?.chartArea || null,
    blockConnected: block.isConnected,
    hasCanvasTransformAncestor: hasNonNoneTransform(canvasTransforms),
    hasBlockTransformAncestor: hasNonNoneTransform(blockTransforms),
    hasPaneTransformAncestor: hasNonNoneTransform(paneTransforms),
    cssCanvasDiffersFromRect: (
      (cssWidthCanvas !== null && Math.abs(cssWidthCanvas - rect.width) > 0.5)
      || (cssHeightCanvas !== null && Math.abs(cssHeightCanvas - rect.height) > 0.5)
    ),
    cssParentDiffersFromRect: parentRect && (
      (cssWidthParent !== null && Math.abs(cssWidthParent - parentRect.width) > 0.5)
      || (cssHeightParent !== null && Math.abs(cssHeightParent - parentRect.height) > 0.5)
    )
  };

  console.info('[ChartDiag][summary]', summary);
  console.debug('[ChartDiag][detail]', {
    summary,
    canvasTransforms,
    blockTransforms,
    paneTransforms,
    css: {
      canvas: {
        width: canvasStyle.width,
        height: canvasStyle.height
      },
      parent: parentStyle ? { width: parentStyle.width, height: parentStyle.height } : null
    }
  });
}

function attachPointerDiagnostics(chart, canvas, chartData) {
  if (!isChartDiagnosticsEnabled()) {
    return null;
  }

  let rafToken = 0;
  let lastEvent = null;

  const flush = () => {
    rafToken = 0;
    const event = lastEvent;
    lastEvent = null;
    if (!event || !canvas.isConnected) {
      return;
    }

    const pointer = getEventPointer(event);
    const rect = canvas.getBoundingClientRect();
    const localX = Number.isFinite(pointer?.clientX) ? pointer.clientX - rect.left : null;
    const localY = Number.isFinite(pointer?.clientY) ? pointer.clientY - rect.top : null;
    const labels = Array.isArray(chartData?.labels) ? chartData.labels : [];
    const expectedIndex = getExpectedIndexFromPointerX(localX, chart, labels.length);
    const expectedLabel = expectedIndex !== null ? labels[expectedIndex] : null;
    const nearest = chart.getElementsAtEventForMode(event, 'nearest', { intersect: false }, false);
    const nearestIndex = nearest[0]?.index ?? null;
    const nearestLabel = nearestIndex !== null ? labels[nearestIndex] : null;

    console.debug('[ChartDiag][pointer]', {
      chart: chartData?.title || 'Untitled chart',
      offsetX: event.offsetX,
      offsetY: event.offsetY,
      clientX: pointer?.clientX,
      clientY: pointer?.clientY,
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      },
      local: {
        x: localX,
        y: localY
      },
      nearest: {
        index: nearestIndex,
        label: nearestLabel
      },
      expected: {
        index: expectedIndex,
        label: expectedLabel
      }
    });
  };

  const onPointerMove = (event) => {
    lastEvent = event;
    if (rafToken) {
      return;
    }
    rafToken = window.requestAnimationFrame(flush);
  };

  canvas.addEventListener('pointermove', onPointerMove, { passive: true });

  return () => {
    if (rafToken) {
      window.cancelAnimationFrame(rafToken);
    }
    canvas.removeEventListener('pointermove', onPointerMove);
  };
}

/*
  Diagnostics summary (enable with window.__CHART_DIAGNOSTICS__=true or ?chartdiag=1):
  - We log DPR ratios, transform chains, chartArea, pointer-vs-nearest index, and
    per-ancestor scale estimates via getBoundingClientRect()/offset size.
  - If ancestors are scaled, we render charts in a fixed overlay outside transformed
    panes so Chart.js pointer math runs in an unscaled coordinate space.
*/
function reflowChart(chart) {
  if (!chart || typeof chart.resize !== 'function' || typeof chart.update !== 'function') {
    return;
  }

  chart.resize();
  chart.update('none');
}

window.__callcanvasReflowCharts = () => {
  for (const entry of chartRegistry.values()) {
    if (entry?.mode === 'overlay' && entry.overlayWrapper && entry.positionSourceEl) {
      positionOverlayForBlock(entry.positionSourceEl, entry.overlayWrapper);
    }
    reflowChart(entry.chart);
  }
  scheduleOverlayPositionUpdate();
};

function nextChartKey(prefix = 'chart') {
  const cleanPrefix = sanitizeFileToken(prefix, 'chart');
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return `${cleanPrefix}-${window.crypto.randomUUID()}`;
  }

  return `${cleanPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatEuro(value) {
  return EURO_FORMATTER.format(clampNumber(value));
}

function formatEuroTick(value) {
  const amount = clampNumber(value);
  const absolute = Math.abs(amount);
  if (absolute >= 1000000) {
    return `€${(amount / 1000000).toFixed(1)}m`;
  }
  if (absolute >= 1000) {
    return `€${Math.round(amount / 1000)}k`;
  }
  return `€${Math.round(amount)}`;
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) {
    return `rgba(46, 163, 255, ${alpha})`;
  }

  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function sanitizeFileToken(input, fallback) {
  const raw = String(input || fallback || '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function round2(value) {
  return Math.round((clampNumber(value) + Number.EPSILON) * 100) / 100;
}

function isMortgageMixedChart(chartData) {
  const chartId = normalizeLabel(chartData?.id).toLowerCase();
  return chartId.startsWith('mortgage-mixed')
    || chartData?.meta?.kind === 'mortgageMixed';
}

function chartToCsv(chartData, _module) {
  const datasets = Array.isArray(chartData.datasets) ? chartData.datasets : [];
  const labels = Array.isArray(chartData.labels) ? chartData.labels : [];

  if (isMortgageMixedChart(chartData)) {
    const labelsLength = labels.length;
    const getValues = (label) => {
      const dataset = datasets.find((entry) => normalizeLabel(entry?.label) === label);
      const values = Array.isArray(dataset?.data) ? dataset.data.map((value) => clampNumber(value)) : [];
      while (values.length < labelsLength) {
        values.push(0);
      }
      return values.slice(0, labelsLength);
    };

    const balanceEndValues = getValues(MORTGAGE_DATASET_LABELS.balance);
    const principalValues = getValues(MORTGAGE_DATASET_LABELS.principal);
    const interestValues = getValues(MORTGAGE_DATASET_LABELS.interest);

    const header = ['Year', 'BalanceStart', 'PrincipalPaid', 'InterestPaid', 'TotalPaid', 'BalanceEnd'];
    const lines = [header.map(csvEscape).join(',')];

    labels.forEach((label, index) => {
      const principalRounded = round2(principalValues[index]);
      const interestRounded = round2(interestValues[index]);
      const balanceEndRounded = round2(balanceEndValues[index]);
      const balanceStartRounded = round2(balanceEndRounded + principalRounded);
      const totalPaidRounded = round2(principalRounded + interestRounded);

      const row = [
        String(label ?? ''),
        balanceStartRounded.toFixed(2),
        principalRounded.toFixed(2),
        interestRounded.toFixed(2),
        totalPaidRounded.toFixed(2),
        balanceEndRounded.toFixed(2)
      ];
      lines.push(row.map(csvEscape).join(','));
    });

    return `${lines.join('\n')}\n`;
  }

  const header = ['Label', ...datasets.map((dataset) => dataset.label || '')];
  const lines = [header.map(csvEscape).join(',')];

  labels.forEach((label, index) => {
    const row = [label, ...datasets.map((dataset) => clampNumber(dataset.data?.[index] ?? ''))];
    lines.push(row.map(csvEscape).join(','));
  });

  return `${lines.join('\n')}\n`;
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildFilename(clientName, moduleTitle, chartTitle) {
  const dateToken = new Date().toISOString().slice(0, 10);
  const clientToken = sanitizeFileToken(clientName, 'Client');
  const moduleToken = sanitizeFileToken(moduleTitle, 'Module');
  const chartToken = sanitizeFileToken(chartTitle, 'Chart');
  return `${clientToken}_${moduleToken}_${chartToken}_${dateToken}.csv`;
}

function buildDatasetStyle(dataset, index, type) {
  const paletteColor = COLOR_PALETTE[index % COLOR_PALETTE.length];
  const color = typeof dataset?.borderColor === 'string' && dataset.borderColor.trim()
    ? dataset.borderColor
    : paletteColor;
  const backgroundColor = typeof dataset?.backgroundColor === 'string' && dataset.backgroundColor.trim()
    ? dataset.backgroundColor
    : hexToRgba(color, type === 'bar' ? 0.52 : 0.24);
  const points = Array.isArray(dataset?.data) ? dataset.data.map((value) => clampNumber(value)) : [];

  if (type === 'bar') {
    return {
      label: dataset.label || `Series ${index + 1}`,
      data: points,
      backgroundColor,
      borderColor: color,
      borderWidth: 1,
      borderRadius: 6,
      maxBarThickness: 46
    };
  }

  return {
    label: dataset.label || `Series ${index + 1}`,
    data: points,
    borderColor: color,
    backgroundColor,
    borderWidth: 2,
    pointBackgroundColor: typeof dataset?.pointBackgroundColor === 'string' && dataset.pointBackgroundColor.trim()
      ? dataset.pointBackgroundColor
      : color,
    pointBorderColor: typeof dataset?.pointBorderColor === 'string' && dataset.pointBorderColor.trim()
      ? dataset.pointBorderColor
      : color,
    pointRadius: 2,
    pointHoverRadius: 4,
    tension: 0.28,
    fill: false
  };
}

function normalizeLabel(value) {
  return String(value || '').trim();
}

function isPensionModule(module) {
  return Boolean(module?.generated?.pensionInputs);
}

function getPensionShowMax(moduleId) {
  if (typeof window.__getPensionShowMaxForModule !== 'function') {
    return false;
  }

  return Boolean(window.__getPensionShowMaxForModule(moduleId));
}

function chartHasDatasetLabel(chartData, label) {
  if (!Array.isArray(chartData?.datasets)) {
    return false;
  }

  return chartData.datasets.some((dataset) => normalizeLabel(dataset?.label) === label);
}

function isPensionAccumulationChart(chartData) {
  const title = String(chartData?.title || '').toLowerCase();
  return title.includes('pension pot at retirement')
    || chartHasDatasetLabel(chartData, PENSION_DATASET_LABELS.currentPath)
    || chartHasDatasetLabel(chartData, PENSION_DATASET_LABELS.maxPath)
    || chartHasDatasetLabel(chartData, PENSION_DATASET_LABELS.personalCurrent);
}

function isPensionSustainabilityChart(chartData) {
  const title = String(chartData?.title || '').toLowerCase();
  return title.includes('retirement sustainability')
    || chartHasDatasetLabel(chartData, PENSION_DATASET_LABELS.requiredReference)
    || chartHasDatasetLabel(chartData, PENSION_DATASET_LABELS.sustainabilityCurrent)
    || chartHasDatasetLabel(chartData, PENSION_DATASET_LABELS.sustainabilityMax)
    || chartHasDatasetLabel(chartData, PENSION_DATASET_LABELS.withdrawals);
}

function isRequiredReferenceLabel(label) {
  const normalized = normalizeLabel(label).toLowerCase();
  return normalized === normalizeLabel(PENSION_DATASET_LABELS.requiredReference).toLowerCase()
    || normalized.includes('required-balance reference')
    || normalized.includes('required pot path');
}

function isCurrentScenarioLabel(label) {
  const normalized = normalizeLabel(label).toLowerCase();
  return normalized.includes('(current)')
    || normalized.includes('current contribution path')
    || normalized.includes('current start pot');
}

function isMaxScenarioLabel(label) {
  const normalized = normalizeLabel(label).toLowerCase();
  return normalized.includes('(max)')
    || normalized.includes('max personal contribution path')
    || normalized.includes('max start pot');
}

function hasSustainabilityLabels(datasets) {
  if (!Array.isArray(datasets)) {
    return false;
  }

  return datasets.some((dataset) => {
    const label = normalizeLabel(dataset?.label);
    const normalized = label.toLowerCase();
    return isRequiredReferenceLabel(label)
      || label === PENSION_DATASET_LABELS.sustainabilityCurrent
      || label === PENSION_DATASET_LABELS.sustainabilityMax
      || label === PENSION_DATASET_LABELS.withdrawals
      || label === 'Balance with target income (current start pot)'
      || label === 'Balance with target income (max start pot)'
      || normalized.startsWith('affordable income (');
  });
}

function ensureAtLeastOneVisibleBarDataset(datasets, showMax) {
  if (!Array.isArray(datasets) || datasets.length === 0) {
    return;
  }

  const barDatasets = datasets.filter((dataset) => dataset?.type === 'bar' || dataset?.yAxisID === 'y1');
  if (barDatasets.length === 0) {
    return;
  }

  const hasVisibleBar = barDatasets.some((dataset) => dataset.hidden !== true);
  if (hasVisibleBar) {
    return;
  }

  const token = showMax ? '(max)' : '(current)';
  const preferred = barDatasets.find((dataset) => normalizeLabel(dataset.label).toLowerCase().includes(token))
    || barDatasets[0];

  if (preferred) {
    preferred.hidden = false;
  }
}

function applySustainabilityLegendFilter(chart, showMax) {
  if (!chart?.options?.plugins?.legend?.labels) {
    return;
  }

  chart.options.plugins.legend.labels.filter = (legendItem, legendData) => {
    const dataset = legendData?.datasets?.[legendItem.datasetIndex];
    if (!dataset) {
      return true;
    }

    const label = normalizeLabel(dataset.label);
    if (label === PENSION_DATASET_LABELS.withdrawals) {
      return false;
    }
    if (
      label === PENSION_DATASET_LABELS.sustainabilityCurrent
      || label === 'Balance with target income (current start pot)'
      || isCurrentScenarioLabel(label)
    ) {
      return !showMax;
    }
    if (
      label === PENSION_DATASET_LABELS.sustainabilityMax
      || label === 'Balance with target income (max start pot)'
      || isMaxScenarioLabel(label)
    ) {
      return showMax;
    }
    return true;
  };
}

function applyPensionShowMaxToChart(chart, showMax) {
  if (!chart?.data || !Array.isArray(chart.data.datasets)) {
    return false;
  }

  let changed = false;
  chart.data.datasets.forEach((dataset) => {
    const label = normalizeLabel(dataset?.label);
    let nextHidden = null;

    if (isRequiredReferenceLabel(label)) {
      nextHidden = false;
    } else if (isMaxScenarioLabel(label)) {
      nextHidden = !showMax;
    } else if (isCurrentScenarioLabel(label)) {
      nextHidden = showMax;
    }

    if (nextHidden !== null && dataset.hidden !== nextHidden) {
      dataset.hidden = nextHidden;
      changed = true;
    }
  });

  ensureAtLeastOneVisibleBarDataset(chart.data.datasets, showMax);

  if (hasSustainabilityLabels(chart.data.datasets)) {
    applySustainabilityLegendFilter(chart, showMax);
    changed = true;
  }

  return changed;
}

function setPensionShowMaxForModuleCharts(moduleId, showMax) {
  if (typeof moduleId !== 'string' || !moduleId) {
    return 0;
  }

  let updated = 0;
  for (const entry of chartRegistry.values()) {
    if (!entry || entry.moduleId !== moduleId || !entry.chart) {
      continue;
    }

    const changed = applyPensionShowMaxToChart(entry.chart, showMax);
    if (changed) {
      entry.chart.update('none');
      if (entry.mode === 'overlay') {
        scheduleOverlayPositionUpdate();
      }
      updated += 1;
    }
  }

  return updated;
}

window.__setPensionShowMaxForModule = (moduleId, showMax) => setPensionShowMaxForModuleCharts(moduleId, Boolean(showMax));

function applyLineColorOverrides(datasetStyle) {
  const label = normalizeLabel(datasetStyle.label);
  const map = {
    [PENSION_DATASET_LABELS.currentPath]: '#2ea3ff',
    [PENSION_DATASET_LABELS.maxPath]: '#7bffbf',
    [PENSION_DATASET_LABELS.sustainabilityCurrent]: '#2ea3ff',
    [PENSION_DATASET_LABELS.sustainabilityMax]: '#7bffbf',
    [PENSION_DATASET_LABELS.requiredReference]: '#B48CFF'
  };
  const color = map[label];

  if (!color) {
    return datasetStyle;
  }

  return {
    ...datasetStyle,
    borderColor: color,
    backgroundColor: hexToRgba(color, 0.2),
    pointBackgroundColor: color,
    pointBorderColor: color
  };
}

function isContributionOrGrowthLabel(label) {
  const normalized = normalizeLabel(label).toLowerCase();
  return normalized.startsWith('personal (')
    || normalized.startsWith('employer (')
    || normalized.startsWith('growth (');
}

function buildPensionAccumulationDataset(dataset, index, showMax) {
  const label = normalizeLabel(dataset?.label);
  const isLine = label === PENSION_DATASET_LABELS.currentPath || label === PENSION_DATASET_LABELS.maxPath;

  if (isLine) {
    const baseLine = applyLineColorOverrides(buildDatasetStyle(dataset, index, 'line'));
    return {
      ...baseLine,
      type: 'line',
      yAxisID: 'y',
      order: 0,
      borderWidth: label === PENSION_DATASET_LABELS.maxPath ? 2.4 : 2,
      hidden: label === PENSION_DATASET_LABELS.maxPath ? !showMax : showMax
    };
  }

  const barSeriesMap = {
    [PENSION_DATASET_LABELS.personalCurrent]: { color: '#2ea3ff', hidden: showMax },
    [PENSION_DATASET_LABELS.employerCurrent]: { color: '#00BFA6', hidden: showMax },
    [PENSION_DATASET_LABELS.growthCurrent]: { color: '#7bffbf', hidden: showMax },
    [PENSION_DATASET_LABELS.personalMax]: { color: '#ffd166', hidden: !showMax },
    [PENSION_DATASET_LABELS.employerMax]: { color: '#ffb703', hidden: !showMax },
    [PENSION_DATASET_LABELS.growthMax]: { color: '#ff8fa3', hidden: !showMax }
  };
  const barMeta = barSeriesMap[label];
  const barBase = buildDatasetStyle(dataset, index, 'bar');

  if (!barMeta && !isContributionOrGrowthLabel(label)) {
    return {
      ...buildDatasetStyle(dataset, index, 'line'),
      type: 'line',
      yAxisID: 'y',
      order: 0
    };
  }
  const fallbackHidden = label.toLowerCase().includes('(max)') ? !showMax : showMax;
  const resolvedBarMeta = barMeta || {
    color: '#2ea3ff',
    hidden: fallbackHidden
  };

  return {
    ...barBase,
    type: 'bar',
    yAxisID: 'y1',
    stack: 'cashflows',
    order: 1,
    borderColor: resolvedBarMeta.color,
    backgroundColor: hexToRgba(resolvedBarMeta.color, 0.5),
    hidden: resolvedBarMeta.hidden
  };
}

function buildPensionSustainabilityDataset(dataset, index, showMax) {
  const label = normalizeLabel(dataset?.label);
  if (label === PENSION_DATASET_LABELS.withdrawals) {
    const barBase = buildDatasetStyle(dataset, index, 'bar');
    const color = '#6FE6D8';
    return {
      ...barBase,
      type: 'bar',
      yAxisID: 'y1',
      order: 1,
      borderColor: color,
      backgroundColor: hexToRgba(color, 0.5),
      borderWidth: 1,
      hidden: false
    };
  }

  const base = applyLineColorOverrides(buildDatasetStyle(dataset, index, 'line'));

  if (label === PENSION_DATASET_LABELS.requiredReference) {
    return {
      ...base,
      type: 'line',
      yAxisID: 'y',
      order: 0,
      hidden: false
    };
  }

  if (label === PENSION_DATASET_LABELS.sustainabilityCurrent) {
    return {
      ...base,
      type: 'line',
      yAxisID: 'y',
      order: 0,
      hidden: showMax
    };
  }

  if (label === PENSION_DATASET_LABELS.sustainabilityMax) {
    return {
      ...base,
      type: 'line',
      yAxisID: 'y',
      order: 0,
      hidden: !showMax
    };
  }

  const hiddenByScenario = isMaxScenarioLabel(label)
    ? !showMax
    : (isCurrentScenarioLabel(label) ? showMax : false);

  return {
    ...base,
    type: 'line',
    yAxisID: 'y',
    order: 0,
    hidden: hiddenByScenario
  };
}

function ensureAtLeastOneAccumulationBarVisible(datasets, showMax) {
  if (!Array.isArray(datasets) || datasets.length === 0) {
    return datasets;
  }

  const barDatasets = datasets.filter((dataset) => dataset?.type === 'bar' && dataset?.yAxisID === 'y1');
  if (barDatasets.length === 0) {
    return datasets;
  }

  const hasVisibleBar = barDatasets.some((dataset) => dataset.hidden !== true);
  if (hasVisibleBar) {
    return datasets;
  }

  const preferredToken = showMax ? '(max)' : '(current)';
  const preferred = barDatasets.find((dataset) => normalizeLabel(dataset.label).toLowerCase().includes(preferredToken))
    || barDatasets[0];

  if (preferred) {
    preferred.hidden = false;
  }

  return datasets;
}

function getRawDatasetValues(chartData, label, labelsLength) {
  if (!Array.isArray(chartData?.datasets)) {
    return Array.from({ length: labelsLength }, () => 0);
  }

  const dataset = chartData.datasets.find((entry) => normalizeLabel(entry?.label) === label);
  if (!dataset || !Array.isArray(dataset.data)) {
    return Array.from({ length: labelsLength }, () => 0);
  }

  const values = dataset.data.map((value) => clampNumber(value));
  while (values.length < labelsLength) {
    values.push(0);
  }

  return values.slice(0, labelsLength);
}

function maxArrayValue(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  return values.reduce((max, value) => Math.max(max, clampNumber(value)), 0);
}

function computeAccumulationAxisMaxes(chartData) {
  const labelsLength = Array.isArray(chartData?.labels) ? chartData.labels.length : 0;
  if (labelsLength === 0) {
    return {
      potMax: 0,
      cashflowMax: 0
    };
  }

  const potCurrentValues = getRawDatasetValues(chartData, PENSION_DATASET_LABELS.currentPath, labelsLength);
  const potMaxValues = getRawDatasetValues(chartData, PENSION_DATASET_LABELS.maxPath, labelsLength);
  const potMax = Math.max(maxArrayValue(potCurrentValues), maxArrayValue(potMaxValues));

  const personalCurrentValues = getRawDatasetValues(chartData, PENSION_DATASET_LABELS.personalCurrent, labelsLength);
  const employerCurrentValues = getRawDatasetValues(chartData, PENSION_DATASET_LABELS.employerCurrent, labelsLength);
  const growthCurrentValues = getRawDatasetValues(chartData, PENSION_DATASET_LABELS.growthCurrent, labelsLength);
  const personalMaxValues = getRawDatasetValues(chartData, PENSION_DATASET_LABELS.personalMax, labelsLength);
  const employerMaxValues = getRawDatasetValues(chartData, PENSION_DATASET_LABELS.employerMax, labelsLength);
  const growthMaxValues = getRawDatasetValues(chartData, PENSION_DATASET_LABELS.growthMax, labelsLength);

  let cashflowMax = 0;
  for (let index = 0; index < labelsLength; index += 1) {
    const currentCash = personalCurrentValues[index] + employerCurrentValues[index] + growthCurrentValues[index];
    const maxCash = personalMaxValues[index] + employerMaxValues[index] + growthMaxValues[index];
    cashflowMax = Math.max(cashflowMax, currentCash, maxCash);
  }

  return {
    potMax,
    cashflowMax
  };
}

function computeSustainabilityWithdrawalMax(chartData) {
  const labelsLength = Array.isArray(chartData?.labels) ? chartData.labels.length : 0;
  if (labelsLength === 0) {
    return 0;
  }

  const withdrawalsValues = getRawDatasetValues(chartData, PENSION_DATASET_LABELS.withdrawals, labelsLength);
  return maxArrayValue(withdrawalsValues);
}

function buildMortgageMixedDataset(dataset, index) {
  const label = normalizeLabel(dataset?.label);

  if (label === MORTGAGE_DATASET_LABELS.balance) {
    const line = buildDatasetStyle(dataset, index, 'line');
    const color = '#2ea3ff';
    return {
      ...line,
      type: 'line',
      yAxisID: 'y',
      order: 0,
      borderColor: color,
      pointBackgroundColor: color,
      pointBorderColor: color,
      backgroundColor: hexToRgba(color, 0.2),
      borderWidth: 2.2
    };
  }

  if (label === MORTGAGE_DATASET_LABELS.principal || label === MORTGAGE_DATASET_LABELS.interest) {
    const bar = buildDatasetStyle(dataset, index, 'bar');
    const color = label === MORTGAGE_DATASET_LABELS.principal ? '#7bffbf' : '#ffd166';
    return {
      ...bar,
      type: 'bar',
      yAxisID: 'y1',
      stack: 'mortgage-repayments',
      order: 1,
      borderColor: color,
      backgroundColor: hexToRgba(color, 0.52)
    };
  }

  return buildDatasetStyle(dataset, index, 'bar');
}

function buildChartConfig(chartData, { module } = {}) {
  const isMortgageMixed = isMortgageMixedChart(chartData);
  const chartType = isMortgageMixed
    ? 'bar'
    : (chartData.type === 'bar' ? 'bar' : 'line');
  const labels = Array.isArray(chartData.labels) ? chartData.labels.map((value) => String(value)) : [];
  const pensionModule = isPensionModule(module);
  const accumulationByTitleOrLabels = isPensionAccumulationChart(chartData);
  const sustainabilityByTitleOrLabels = isPensionSustainabilityChart(chartData);
  const fallbackPensionDetection = !module && (accumulationByTitleOrLabels || sustainabilityByTitleOrLabels);
  const isPensionChart = pensionModule || fallbackPensionDetection;
  const showMax = pensionModule ? getPensionShowMax(module?.id) : false;
  const isAccumulation = isPensionChart && accumulationByTitleOrLabels;
  const isSustainability = isPensionChart && sustainabilityByTitleOrLabels;
  const datasets = Array.isArray(chartData.datasets)
    ? chartData.datasets.map((dataset, index) => {
      if (isMortgageMixed) {
        return buildMortgageMixedDataset(dataset, index);
      }

      if (isAccumulation) {
        return buildPensionAccumulationDataset(dataset, index, showMax);
      }

      if (isSustainability) {
        return buildPensionSustainabilityDataset(dataset, index, showMax);
      }

      return buildDatasetStyle(dataset, index, chartType);
    })
    : [];

  if (isAccumulation) {
    ensureAtLeastOneAccumulationBarVisible(datasets, showMax);
  }

  const config = {
    type: chartType,
    data: {
      labels,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        intersect: true,
        axis: 'x'
      },
      hover: {
        mode: 'nearest',
        intersect: true
      },
      animation: {
        duration: 340,
        easing: 'easeOutCubic'
      },
      plugins: {
        legend: {
          labels: {
            color: '#eaf4ff',
            boxWidth: 14,
            boxHeight: 8,
            useBorderRadius: true,
            borderRadius: 4,
            font: {
              size: 12,
              weight: '600'
            }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(6, 16, 32, 0.95)',
          borderColor: 'rgba(46, 163, 255, 0.5)',
          borderWidth: 1,
          titleColor: '#ffffff',
          bodyColor: '#d9ebff',
          mode: 'nearest',
          intersect: true
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#d3e8ff',
            maxRotation: 0
          },
          grid: {
            color: 'rgba(140, 175, 220, 0.16)',
            drawBorder: false
          }
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: '#d3e8ff'
          },
          grid: {
            color: 'rgba(140, 175, 220, 0.16)',
            drawBorder: false
          }
        }
      }
    }
  };

  if (isAccumulation) {
    config.options.scales.x.stacked = true;
    const { potMax, cashflowMax } = computeAccumulationAxisMaxes(chartData);
    config.options.scales.y.suggestedMax = potMax > 0 ? potMax * 1.05 : 1;
    config.options.scales.y1 = {
      beginAtZero: true,
      stacked: true,
      position: 'right',
      suggestedMax: cashflowMax > 0 ? cashflowMax * 1.10 : 1,
      ticks: {
        color: '#d3e8ff',
        callback: (value) => formatEuroTick(value)
      },
      grid: {
        drawOnChartArea: false,
        color: 'rgba(140, 175, 220, 0.16)',
        drawBorder: false
      }
    };

    config.options.plugins.legend.labels.filter = (legendItem, legendData) => {
      const dataset = legendData?.datasets?.[legendItem.datasetIndex];
      if (!dataset) {
        return true;
      }

      return !(dataset.type === 'bar' || dataset.yAxisID === 'y1');
    };

    const subtitleText = 'Bars (right axis): Personal + Employer contributions, topped by Growth';
    const subtitlePluginAvailable = Boolean(
      window.Chart?.defaults?.plugins
      && Object.prototype.hasOwnProperty.call(window.Chart.defaults.plugins, 'subtitle')
    );

    if (subtitlePluginAvailable) {
      config.options.plugins.subtitle = {
        display: true,
        text: subtitleText,
        color: '#cfe6ff',
        font: {
          size: 12,
          weight: '500'
        },
        padding: {
          top: 6,
          bottom: 10
        }
      };
    } else {
      config.options.plugins.title = {
        display: true,
        text: `${chartData.title || 'Chart'} — ${subtitleText}`,
        color: '#cfe6ff',
        font: {
          size: 12,
          weight: '500'
        },
        padding: {
          top: 6,
          bottom: 10
        }
      };
    }
  }

  if (isSustainability) {
    const withdrawalsMax = computeSustainabilityWithdrawalMax(chartData);
    config.options.scales.y1 = {
      beginAtZero: true,
      position: 'right',
      suggestedMax: withdrawalsMax > 0 ? withdrawalsMax * 1.10 : 1,
      ticks: {
        color: '#d3e8ff',
        callback: (value) => formatEuroTick(value)
      },
      grid: {
        drawOnChartArea: false,
        color: 'rgba(140, 175, 220, 0.16)',
        drawBorder: false
      }
    };

    config.options.plugins.legend.labels.filter = (legendItem, legendData) => {
      const dataset = legendData?.datasets?.[legendItem.datasetIndex];
      if (!dataset) {
        return true;
      }

      const label = normalizeLabel(dataset.label);
      if (label === PENSION_DATASET_LABELS.withdrawals) {
        return false;
      }
      if (label === PENSION_DATASET_LABELS.sustainabilityCurrent || isCurrentScenarioLabel(label)) {
        return !showMax;
      }
      if (label === PENSION_DATASET_LABELS.sustainabilityMax || isMaxScenarioLabel(label)) {
        return showMax;
      }
      return true;
    };

    const subtitleText = 'Bars (right axis): withdrawals per year';
    const subtitlePluginAvailable = Boolean(
      window.Chart?.defaults?.plugins
      && Object.prototype.hasOwnProperty.call(window.Chart.defaults.plugins, 'subtitle')
    );

    if (subtitlePluginAvailable) {
      config.options.plugins.subtitle = {
        display: true,
        text: subtitleText,
        color: '#cfe6ff',
        font: {
          size: 12,
          weight: '500'
        },
        padding: {
          top: 6,
          bottom: 10
        }
      };
    } else {
      config.options.plugins.title = {
        display: true,
        text: `${chartData.title || 'Chart'} — ${subtitleText}`,
        color: '#cfe6ff',
        font: {
          size: 12,
          weight: '500'
        },
        padding: {
          top: 6,
          bottom: 10
        }
      };
    }
  }

  if (isMortgageMixed) {
    config.options.scales.x.stacked = true;
    config.options.scales.y = {
      beginAtZero: true,
      ticks: {
        color: '#d3e8ff',
        callback: (value) => formatEuroTick(value)
      },
      grid: {
        color: 'rgba(140, 175, 220, 0.16)',
        drawBorder: false
      }
    };
    config.options.scales.y1 = {
      beginAtZero: true,
      stacked: true,
      position: 'right',
      ticks: {
        color: '#d3e8ff',
        callback: (value) => formatEuroTick(value)
      },
      grid: {
        drawOnChartArea: false,
        color: 'rgba(140, 175, 220, 0.16)',
        drawBorder: false
      }
    };
    config.options.plugins.tooltip.callbacks = {
      label: (context) => {
        const label = context?.dataset?.label || 'Series';
        const value = typeof context?.parsed?.y === 'number'
          ? context.parsed.y
          : context?.raw;
        return `${label}: ${formatEuro(value)}`;
      }
    };
  }

  if (isAccumulation || isSustainability) {
    config.options.plugins.tooltip.callbacks = {
      label: (context) => {
        const label = context?.dataset?.label || 'Series';
        const value = typeof context?.parsed?.y === 'number'
          ? context.parsed.y
          : context?.raw;
        return `${label}: ${formatEuro(value)}`;
      }
    };
  }

  return config;
}

function destroyChartByKey(chartKey) {
  const existing = chartRegistry.get(chartKey);
  if (!existing) {
    return;
  }

  if (existing.reflowRafId) {
    window.cancelAnimationFrame(existing.reflowRafId);
  }
  if (typeof existing.pointerDiagnosticsCleanup === 'function') {
    existing.pointerDiagnosticsCleanup();
  }
  if (existing.resizeObserver) {
    existing.resizeObserver.disconnect();
  }
  if (existing.transitionTarget && existing.transitionEndHandler) {
    existing.transitionTarget.removeEventListener('transitionend', existing.transitionEndHandler);
  }
  if (existing.windowResizeHandler) {
    window.removeEventListener('resize', existing.windowResizeHandler);
  }
  if (existing.overlayWrapper && existing.overlayWrapper.parentElement) {
    existing.overlayWrapper.remove();
  }
  if (existing.sourceCanvas) {
    if (existing.sourceCanvas.dataset.chartKey === chartKey) {
      delete existing.sourceCanvas.dataset.chartKey;
    }
    existing.sourceCanvas.style.visibility = '';
    existing.sourceCanvas.style.pointerEvents = '';
  }
  if (existing.canvas && existing.canvas !== existing.sourceCanvas && existing.canvas.dataset?.chartKey === chartKey) {
    delete existing.canvas.dataset.chartKey;
  }
  existing.chart.destroy();
  chartRegistry.delete(chartKey);
  maybeTearDownOverlayInfrastructure();
}

export function cleanupDetachedCharts() {
  for (const [chartKey, entry] of chartRegistry.entries()) {
    const sourceDisconnected = !entry.positionSourceEl || !entry.positionSourceEl.isConnected;
    const overlayDetached = entry.mode === 'overlay' && (!entry.overlayWrapper || !entry.overlayWrapper.isConnected);
    const canvasDetached = !entry.canvas || !entry.canvas.isConnected;

    if (sourceDisconnected || overlayDetached || canvasDetached) {
      destroyChartByKey(chartKey);
    }
  }

  if (hasOverlayEntries()) {
    scheduleOverlayPositionUpdate();
  } else {
    maybeTearDownOverlayInfrastructure();
  }
}

export function destroyAllCharts() {
  for (const chartKey of [...chartRegistry.keys()]) {
    destroyChartByKey(chartKey);
  }
  maybeTearDownOverlayInfrastructure();
}

export function renderChartsForPane(paneElement, module, { clientName, moduleTitle, paneKey = 'pane' } = {}) {
  cleanupDetachedCharts();

  if (!paneElement || !module?.generated?.charts || typeof window.Chart === 'undefined') {
    return;
  }

  const paneToken = sanitizeFileToken(
    paneKey || paneElement.dataset.chartPaneKey || paneElement.dataset.comparePane || paneElement.dataset.moduleId || 'pane',
    'pane'
  );
  paneElement.dataset.chartPaneKey = paneToken;

  const blocks = [...paneElement.querySelectorAll('[data-chart-index]')];

  blocks.forEach((block) => {
    const chartIndex = Number(block.dataset.chartIndex);
    if (!Number.isFinite(chartIndex)) {
      return;
    }

    const chartData = module.generated.charts[chartIndex];
    if (!chartData) {
      return;
    }

    const sourceCanvas = block.querySelector('canvas');
    if (!sourceCanvas) {
      return;
    }

    const moduleToken = sanitizeFileToken(module?.id || 'module', 'module');
    sourceCanvas.id = `${paneToken}-canvas-${moduleToken}-${chartIndex}`;

    const existingKey = sourceCanvas.dataset.chartKey;
    if (existingKey) {
      destroyChartByKey(existingKey);
    }

    sourceCanvas.style.visibility = '';
    sourceCanvas.style.pointerEvents = '';

    const canvasRect = sourceCanvas.getBoundingClientRect();
    if (!canvasRect.width || !canvasRect.height) {
      console.warn('[CallCanvas][Chart] skipped chart init: canvas has zero size', {
        moduleId: module?.id || null,
        chartIndex,
        chartTitle: chartData.title || `Chart ${chartIndex + 1}`,
        width: canvasRect.width,
        height: canvasRect.height
      });
      return;
    }

    const scaleInfo = getScaleInfo(sourceCanvas);
    const HAS_SCALE = hasScaleMismatch(scaleInfo);
    console.info('[ChartScale]', {
      title: chartData.title || `Chart ${chartIndex + 1}`,
      chartIndex,
      moduleId: module?.id || null,
      scaleInfo,
      hasScale: HAS_SCALE,
      canvasRect: {
        width: Number(canvasRect.width.toFixed(2)),
        height: Number(canvasRect.height.toFixed(2))
      },
      canvasClient: {
        w: sourceCanvas.clientWidth,
        h: sourceCanvas.clientHeight
      },
      devicePixelRatio: window.devicePixelRatio || 1
    });

    let renderCanvas = sourceCanvas;
    let overlayWrapper = null;
    let chartMode = 'inline';

    if (HAS_SCALE) {
      const overlayLayer = ensureOverlayLayer();
      ensureOverlaySyncListeners();

      overlayWrapper = document.createElement('div');
      overlayWrapper.className = 'callcanvas-chart-overlay-wrapper';
      Object.assign(overlayWrapper.style, {
        position: 'fixed',
        pointerEvents: 'auto',
        margin: '0',
        padding: '0'
      });

      const overlayCanvas = document.createElement('canvas');
      overlayCanvas.className = 'callcanvas-chart-overlay-canvas';
      Object.assign(overlayCanvas.style, {
        width: '100%',
        height: '100%',
        display: 'block'
      });

      overlayWrapper.appendChild(overlayCanvas);
      overlayLayer.appendChild(overlayWrapper);
      positionOverlayForBlock(sourceCanvas, overlayWrapper);

      sourceCanvas.style.visibility = 'hidden';
      sourceCanvas.style.pointerEvents = 'none';
      renderCanvas = overlayCanvas;
      chartMode = 'overlay';
    }

    const context = renderCanvas.getContext('2d');
    if (!context) {
      if (overlayWrapper?.parentElement) {
        overlayWrapper.remove();
      }
      sourceCanvas.style.visibility = '';
      sourceCanvas.style.pointerEvents = '';
      maybeTearDownOverlayInfrastructure();
      return;
    }

    const chartConfig = buildChartConfig(chartData, { module });
    const chart = new window.Chart(context, chartConfig);
    maybeWarnDprMismatch(chart.canvas);
    logChartCreationDiagnostics({
      chart,
      canvas: chart.canvas,
      block,
      paneElement,
      chartData,
      phase: 'create'
    });
    const pointerDiagnosticsCleanup = attachPointerDiagnostics(chart, chart.canvas, chartData);

    const chartKey = nextChartKey(`${paneToken}-chart`);
    sourceCanvas.dataset.chartKey = chartKey;
    if (renderCanvas !== sourceCanvas) {
      renderCanvas.dataset.chartKey = chartKey;
      renderCanvas.id = `${sourceCanvas.id}-overlay`;
    }
    const scheduleReflow = (phase = 'reflow') => {
      const current = chartRegistry.get(chartKey);
      if (!current || current.chart !== chart) {
        return;
      }

      if (current.reflowRafId) {
        return;
      }

      current.reflowRafId = window.requestAnimationFrame(() => {
        const active = chartRegistry.get(chartKey);
        if (!active || active.chart !== chart) {
          return;
        }
        active.reflowRafId = 0;
        if (active.mode === 'overlay' && active.overlayWrapper && active.positionSourceEl) {
          positionOverlayForBlock(active.positionSourceEl, active.overlayWrapper);
        }
        reflowChart(chart);
        scheduleOverlayPositionUpdate();
        maybeWarnDprMismatch(chart.canvas);
        logChartCreationDiagnostics({
          chart,
          canvas: chart.canvas,
          block,
          paneElement,
          chartData,
          phase
        });
      });
    };
    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      const host = block;
      resizeObserver = new ResizeObserver(() => {
        scheduleReflow('resize-observer');
      });
      resizeObserver.observe(host);
    }
    const transitionTarget = block.closest('.swipe-pane') || paneElement;
    const transitionEndHandler = (event) => {
      if (event.target !== transitionTarget) {
        return;
      }
      scheduleReflow('transitionend');
    };
    if (transitionTarget) {
      transitionTarget.addEventListener('transitionend', transitionEndHandler);
    }
    const windowResizeHandler = () => {
      scheduleReflow('window-resize');
    };
    window.addEventListener('resize', windowResizeHandler, { passive: true });
    chartRegistry.set(chartKey, {
      chart,
      canvas: renderCanvas,
      sourceCanvas,
      moduleId: module?.id || '',
      chartIndex,
      mode: chartMode,
      overlayWrapper,
      blockEl: block,
      positionSourceEl: sourceCanvas,
      resizeObserver,
      transitionTarget,
      transitionEndHandler,
      windowResizeHandler,
      pointerDiagnosticsCleanup,
      reflowRafId: 0
    });

    if (chartMode === 'overlay') {
      scheduleOverlayPositionUpdate();
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const current = chartRegistry.get(chartKey);
        if (!current || current.chart !== chart) {
          return;
        }
        if (current.mode === 'overlay' && current.overlayWrapper && current.positionSourceEl) {
          positionOverlayForBlock(current.positionSourceEl, current.overlayWrapper);
        }
        reflowChart(chart);
        scheduleOverlayPositionUpdate();
        maybeWarnDprMismatch(chart.canvas);
        logChartCreationDiagnostics({
          chart,
          canvas: chart.canvas,
          block,
          paneElement,
          chartData,
          phase: 'post-mount'
        });
      });
    });

    const downloadButton = block.querySelector('[data-chart-download]');
    if (downloadButton) {
      downloadButton.onclick = () => {
        const csv = chartToCsv(chartData, module);
        const filename = buildFilename(clientName, moduleTitle, chartData.title || `Chart-${chartIndex + 1}`);
        downloadTextFile(filename, csv);
      };
    }
  });

  cleanupDetachedCharts();
}

function cloneDatasetForUpdate(dataset) {
  if (!dataset || typeof dataset !== 'object') {
    return { data: [] };
  }

  return {
    ...dataset,
    data: Array.isArray(dataset.data) ? [...dataset.data] : []
  };
}

function applyChartConfigToExistingChart(entry, chartData, module) {
  if (!entry?.chart || !chartData) {
    return false;
  }

  const chart = entry.chart;
  const nextConfig = buildChartConfig(chartData, { module });
  chart.config.type = nextConfig.type;
  chart.data.labels = Array.isArray(nextConfig.data?.labels)
    ? [...nextConfig.data.labels]
    : [];
  chart.data.datasets = Array.isArray(nextConfig.data?.datasets)
    ? nextConfig.data.datasets.map((dataset) => cloneDatasetForUpdate(dataset))
    : [];
  chart.options = nextConfig.options || {};

  if (isPensionModule(module)) {
    const showMax = getPensionShowMax(module.id);
    applyPensionShowMaxToChart(chart, showMax);
  }

  chart.update('none');
  if (entry.mode === 'overlay') {
    scheduleOverlayPositionUpdate();
  }
  maybeWarnDprMismatch(chart.canvas);
  return true;
}

export function updateChartsForPane(paneElement, module, { clientName, moduleTitle, paneKey = null } = {}) {
  cleanupDetachedCharts();

  if (!paneElement || !module?.generated?.charts || typeof window.Chart === 'undefined') {
    return;
  }

  const blocks = [...paneElement.querySelectorAll('[data-chart-index]')];
  if (blocks.length === 0) {
    return;
  }

  let fallbackToFullRender = false;
  blocks.forEach((block) => {
    const chartIndex = Number(block.dataset.chartIndex);
    if (!Number.isFinite(chartIndex)) {
      return;
    }

    const chartData = module.generated.charts[chartIndex];
    if (!chartData) {
      fallbackToFullRender = true;
      return;
    }

    const titleEl = block.querySelector('.generated-chart-title');
    if (titleEl) {
      titleEl.textContent = chartData.title || `Chart ${chartIndex + 1}`;
    }

    const downloadButton = block.querySelector('[data-chart-download]');
    if (downloadButton) {
      const titleText = chartData.title || `Chart ${chartIndex + 1}`;
      downloadButton.setAttribute('aria-label', `Download CSV for ${titleText}`);
      downloadButton.onclick = () => {
        const csv = chartToCsv(chartData, module);
        const filename = buildFilename(clientName, moduleTitle, titleText);
        downloadTextFile(filename, csv);
      };
    }

    const sourceCanvas = block.querySelector('canvas');
    if (!sourceCanvas) {
      fallbackToFullRender = true;
      return;
    }

    const chartKey = sourceCanvas.dataset.chartKey;
    const entry = chartKey ? chartRegistry.get(chartKey) : null;
    if (!entry || entry.sourceCanvas !== sourceCanvas) {
      fallbackToFullRender = true;
      return;
    }

    entry.moduleId = module?.id || '';
    entry.chartIndex = chartIndex;

    const updated = applyChartConfigToExistingChart(entry, chartData, module);
    if (!updated) {
      fallbackToFullRender = true;
    }
  });

  if (fallbackToFullRender) {
    renderChartsForPane(paneElement, module, {
      clientName,
      moduleTitle,
      paneKey: paneKey || paneElement?.dataset?.chartPaneKey || paneElement?.dataset?.comparePane || paneElement?.dataset?.moduleId || 'pane'
    });
  }
}
