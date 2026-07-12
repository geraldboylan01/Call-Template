import { computePensionProjection } from './pension_math.js';
import { computeCollegeFundingProjection } from './college_funding_math.js';
import { computeNetRetirementProjection } from './net_retirement_math.js';
import { computeMortgageProjection } from './mortgage_math.js';
import { computeHousePurchaseProjection } from './house_purchase/engine.js';

export const VIDEO_SCENE_MANIFEST_VERSION = 1;
export const VIDEO_SCENE_STORAGE_KEY = 'call_canvas_video_scene_current';

const MAX_STORY_METRICS = 3;
const MAX_CHART_LABELS = 14;
const MAX_CHART_DATASETS = 3;
const MAX_FLOW_NODES = 5;
const PBS_CURRENT_SCENARIO_ID = 'current';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asTrimmedText(value, fallback = '') {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text || fallback;
}

function toPlainText(value) {
  return asTrimmedText(String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatMetricValue(value, valueFormat = '') {
  if (typeof value === 'string') {
    return asTrimmedText(value, '—');
  }

  if (!isFiniteNumber(value)) {
    return '—';
  }

  if (valueFormat === 'percent') {
    return `${value.toLocaleString('en-IE', { maximumFractionDigits: 1 })}%`;
  }

  if (valueFormat === 'currency') {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: 0
    }).format(value);
  }

  return value.toLocaleString('en-IE', { maximumFractionDigits: 1 });
}

function inferMetricFormat(label, value) {
  const token = String(label || '').toLowerCase();
  if (/%|percent|rate|yield|return/.test(token)) {
    return 'percent';
  }
  if (/[€£$]|income|fund|pot|balance|cost|value|assets|liabilities|mortgage|loan|payment|rent|worth|wealth|shortfall|salary|interest/.test(token)) {
    return 'currency';
  }
  return typeof value === 'number' ? 'number' : '';
}

export function getVideoModuleKind(module) {
  const generated = asObject(module?.generated);
  if (generated.housePurchaseInputs) {
    return { id: 'house-purchase', label: 'House purchase planner' };
  }
  if (generated.report) {
    return { id: 'report', label: 'Report' };
  }
  if (generated.education) {
    return { id: 'education', label: 'Education guide' };
  }
  if (generated.netRetirementInputs) {
    return { id: 'net-retirement', label: 'Net retirement cash flow' };
  }
  if (generated.collegeFundingInputs) {
    return { id: 'college-funding', label: 'College funding' };
  }
  if (generated.pensionInputs) {
    return { id: 'pension', label: 'Retirement projection' };
  }
  if (generated.loanInputs) {
    return { id: 'loan', label: 'Loan projection' };
  }
  if (generated.mortgageInputs) {
    return { id: 'mortgage', label: 'Mortgage projection' };
  }
  if (generated.outputsBucketed) {
    return { id: 'balance-sheet', label: 'Personal balance sheet' };
  }
  return { id: 'analysis', label: 'Planning analysis' };
}

function getSelectedPbsScenario(generated, requestedId = '') {
  const outputsBucketed = asObject(generated.outputsBucketed);
  const base = {
    id: PBS_CURRENT_SCENARIO_ID,
    title: 'Current position',
    summaryHtml: generated.summaryHtml || '',
    sections: Array.isArray(outputsBucketed.sections) ? outputsBucketed.sections : [],
    movements: []
  };
  const scenarios = Array.isArray(outputsBucketed.scenarios) ? outputsBucketed.scenarios : [];
  const requested = asTrimmedText(requestedId);

  if (!requested || requested === PBS_CURRENT_SCENARIO_ID) {
    return base;
  }

  const found = scenarios.find((scenario) => asTrimmedText(scenario?.id) === requested);
  if (!found || !Array.isArray(found.sections) || found.sections.length === 0) {
    return base;
  }

  return {
    id: requested,
    title: asTrimmedText(found.title, 'Alternative position').replace(/\s+scenario$/i, ''),
    summaryHtml: asTrimmedText(found.summaryHtml, generated.summaryHtml || ''),
    sections: found.sections,
    movements: Array.isArray(found.movements) ? found.movements : []
  };
}

export function resolveModuleForVideo(module, activeScenario = {}) {
  const source = cloneJson(module || {});
  const generated = asObject(source.generated);
  const kind = getVideoModuleKind(source);
  const resolved = {
    ...source,
    generated: {
      ...generated,
      assumptions: asObject(generated.assumptions),
      outputs: asObject(generated.outputs),
      tables: Array.isArray(generated.tables) ? generated.tables : [],
      charts: Array.isArray(generated.charts) ? generated.charts : []
    }
  };

  try {
    if (kind.id === 'house-purchase') {
      const scenarioOverrides = asObject(activeScenario?.housePurchaseScenarioOverrides);
      const projection = computeHousePurchaseProjection(generated.housePurchaseInputs, { scenarioOverrides });
      resolved.generated.assumptions = projection.assumptionsTable;
      resolved.generated.outputs = projection.outputsTable;
      resolved.generated.outputsBucketed = null;
      resolved.generated.tables = projection.tables;
      resolved.generated.charts = projection.charts;
      resolved.generated.summaryHtml = generated.summaryHtml || projection.summaryHtml;
      resolved.generated.housePurchaseResult = projection.result;

      const supportCase = asTrimmedText(scenarioOverrides.supportCase, 'none');
      const isWhatIf = Object.keys(scenarioOverrides).length > 0;
      return {
        module: resolved,
        activeScenario: {
          id: isWhatIf ? `what-if-${supportCase}` : 'base',
          title: isWhatIf ? 'House purchase what-if illustration' : 'Published base plan',
          housePurchaseScenarioOverrides: cloneJson(scenarioOverrides)
        },
        projectionDebug: projection.debug,
        projectionResult: projection.result,
        calculationStatus: 'resolved'
      };
    }

    if (kind.id === 'pension') {
      const scenarioId = asTrimmedText(activeScenario.pensionScenarioId);
      const projection = computePensionProjection(generated.pensionInputs, scenarioId ? { scenarioId } : {});
      resolved.generated.assumptions = projection.assumptionsTable;
      resolved.generated.outputs = projection.outputsTable;
      resolved.generated.charts = projection.charts;
      return {
        module: resolved,
        activeScenario: {
          id: projection.debug?.currentScenario?.id || scenarioId || 'base',
          title: projection.debug?.currentScenario?.title || 'Current retirement case'
        },
        projectionDebug: projection.debug,
        calculationStatus: 'resolved'
      };
    }

    if (kind.id === 'net-retirement') {
      const scenarioId = asTrimmedText(activeScenario.netRetirementScenarioId);
      const projection = computeNetRetirementProjection(generated.netRetirementInputs, scenarioId ? { scenarioId } : {});
      resolved.generated.assumptions = projection.assumptionsTable;
      resolved.generated.outputs = projection.outputsTable;
      resolved.generated.tables = projection.tables;
      resolved.generated.charts = projection.charts;
      return {
        module: resolved,
        activeScenario: {
          id: projection.debug?.scenarioId || scenarioId || 'base',
          title: projection.debug?.scenario?.title || 'Current cash-flow case'
        },
        projectionDebug: projection.debug,
        calculationStatus: 'resolved'
      };
    }

    if (kind.id === 'college-funding') {
      const projection = computeCollegeFundingProjection(generated.collegeFundingInputs);
      resolved.generated.assumptions = projection.assumptionsTable;
      resolved.generated.outputs = projection.outputsTable;
      resolved.generated.tables = projection.tables;
      resolved.generated.charts = projection.charts;
      return {
        module: resolved,
        activeScenario: { id: 'current', title: 'Current funding assumptions' },
        projectionDebug: projection.debug,
        calculationStatus: 'resolved'
      };
    }

    if (kind.id === 'mortgage' || kind.id === 'loan') {
      const inputs = kind.id === 'loan' ? generated.loanInputs : generated.mortgageInputs;
      const projection = computeMortgageProjection(inputs, { defaultLoanKind: kind.id === 'loan' ? 'loan' : 'mortgage' });
      resolved.generated.assumptions = projection.assumptionsTable;
      resolved.generated.outputs = projection.outputsTable;
      resolved.generated.charts = projection.charts;
      resolved.generated.summaryHtml = projection.summaryHtml || generated.summaryHtml;
      return {
        module: resolved,
        activeScenario: { id: 'current', title: 'Current repayment assumptions' },
        projectionDebug: projection.debug,
        calculationStatus: 'resolved'
      };
    }

    if (kind.id === 'balance-sheet') {
      const scenario = getSelectedPbsScenario(generated, activeScenario.pbsScenarioId);
      resolved.generated.outputsBucketed = {
        ...asObject(generated.outputsBucketed),
        sections: scenario.sections
      };
      resolved.generated.summaryHtml = scenario.summaryHtml;
      return {
        module: resolved,
        activeScenario: { id: scenario.id, title: scenario.title },
        pbsMovements: scenario.movements,
        calculationStatus: 'structured'
      };
    }
  } catch (error) {
    if (kind.id === 'house-purchase') {
      resolved.generated.assumptions = {};
      resolved.generated.outputs = {};
      resolved.generated.outputsBucketed = null;
      resolved.generated.tables = [];
      resolved.generated.charts = [];
      delete resolved.generated.housePurchaseResult;
    }
    return {
      module: resolved,
      activeScenario: { id: 'source', title: 'Source module data' },
      calculationStatus: 'source-fallback',
      calculationError: error?.message || 'The calculator could not be recomputed.'
    };
  }

  return {
    module: resolved,
    activeScenario: { id: 'current', title: 'Current module' },
    calculationStatus: 'structured'
  };
}

function getOutputsBucketedMetrics(outputsBucketed) {
  const sections = Array.isArray(outputsBucketed?.sections) ? outputsBucketed.sections : [];
  const summary = sections.find((section) => String(section?.key || '').toLowerCase() === 'summary')
    || sections.find((section) => /summary|net worth|net assets/i.test(String(section?.title || '')));
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];

  return rows
    .filter((row) => Array.isArray(row) && row.length >= 2)
    .slice(0, MAX_STORY_METRICS)
    .map((row) => {
      const label = asTrimmedText(row[0], 'Metric');
      const value = row[row.length - 1];
      const format = inferMetricFormat(label, value);
      return {
        label,
        value: formatMetricValue(value, format),
        rawValue: isFiniteNumber(value) ? value : null,
        valueFormat: format || 'text'
      };
    });
}

function getTableMetrics(table) {
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  return rows
    .filter((row) => Array.isArray(row) && row.length >= 2)
    .slice(0, MAX_STORY_METRICS)
    .map((row) => {
      const label = asTrimmedText(row[0], 'Metric');
      const values = row.slice(1);
      const format = inferMetricFormat(label, values[values.length - 1]);
      return {
        label,
        value: values.map((value) => formatMetricValue(value, format)).join(' → '),
        rawValue: isFiniteNumber(values[values.length - 1]) ? values[values.length - 1] : null,
        valueFormat: format || 'text'
      };
    });
}

function getEducationMetrics(education) {
  return (Array.isArray(education?.metrics) ? education.metrics : [])
    .slice(0, MAX_STORY_METRICS)
    .map((metric, index) => {
      const label = asTrimmedText(metric?.label || metric?.title, `Key point ${index + 1}`);
      const raw = metric?.value ?? metric?.detail ?? metric?.body;
      return {
        label,
        value: asTrimmedText(raw, 'See the guide'),
        rawValue: isFiniteNumber(raw) ? raw : null,
        valueFormat: inferMetricFormat(label, raw) || 'text'
      };
    });
}

function getReportMetrics(report) {
  const metrics = [];
  const blocks = Array.isArray(report?.blocks) ? report.blocks : [];
  blocks.forEach((block) => {
    if (metrics.length >= MAX_STORY_METRICS || !block || typeof block !== 'object') {
      return;
    }
    const items = Array.isArray(block.items) ? block.items : (Array.isArray(block.metrics) ? block.metrics : []);
    items.forEach((item) => {
      if (metrics.length >= MAX_STORY_METRICS || !item || typeof item !== 'object') {
        return;
      }
      const label = asTrimmedText(item.label || item.title, 'Key point');
      const raw = item.value ?? item.detail ?? item.body;
      if (!asTrimmedText(raw) && !isFiniteNumber(raw)) {
        return;
      }
      metrics.push({
        label,
        value: isFiniteNumber(raw) ? formatMetricValue(raw, inferMetricFormat(label, raw)) : asTrimmedText(raw),
        rawValue: isFiniteNumber(raw) ? raw : null,
        valueFormat: inferMetricFormat(label, raw) || 'text'
      });
    });
  });
  return metrics;
}

function extractStoryMetrics(module, kind) {
  const generated = asObject(module.generated);
  let metrics = [];

  if (kind.id === 'balance-sheet') {
    metrics = getOutputsBucketedMetrics(generated.outputsBucketed);
  } else if (kind.id === 'education') {
    metrics = getEducationMetrics(generated.education);
  } else if (kind.id === 'report') {
    metrics = getReportMetrics(generated.report);
  }

  if (metrics.length === 0) {
    metrics = getTableMetrics(generated.outputs);
  }

  if (metrics.length === 0) {
    metrics = getTableMetrics(generated.assumptions);
  }

  const chartInsights = (Array.isArray(generated.charts) ? generated.charts : [])
    .flatMap((chart) => Array.isArray(chart?.insights) ? chart.insights : [])
    .map((insight) => ({
      label: asTrimmedText(insight?.label, 'Insight'),
      value: asTrimmedText(insight?.value || insight?.detail, 'See chart'),
      rawValue: null,
      valueFormat: 'text'
    }));

  return [...metrics, ...chartInsights].slice(0, MAX_STORY_METRICS);
}

function normalizeChart(chart, index) {
  const labels = (Array.isArray(chart?.labels) ? chart.labels : [])
    .slice(0, MAX_CHART_LABELS)
    .map((label, labelIndex) => asTrimmedText(label, String(labelIndex + 1)));
  const datasets = (Array.isArray(chart?.datasets) ? chart.datasets : [])
    .slice(0, MAX_CHART_DATASETS)
    .map((dataset, datasetIndex) => ({
      label: asTrimmedText(dataset?.label, `Series ${datasetIndex + 1}`),
      type: dataset?.type === 'bar' ? 'bar' : 'line',
      data: (Array.isArray(dataset?.data) ? dataset.data : [])
        .slice(0, labels.length || MAX_CHART_LABELS)
        .map((value) => Number.isFinite(Number(value)) ? Number(value) : 0),
      color: asTrimmedText(dataset?.borderColor || dataset?.backgroundColor)
    }))
    .filter((dataset) => dataset.data.length > 0);

  if (labels.length === 0 || datasets.length === 0) {
    return null;
  }

  const display = asObject(chart?.display);
  return {
    id: asTrimmedText(chart?.id, `chart-${index + 1}`),
    title: asTrimmedText(chart?.title, 'Key trend'),
    subtitle: asTrimmedText(chart?.subtitle),
    type: chart?.type === 'bar' ? 'bar' : 'line',
    labels,
    datasets,
    valueFormat: ['currency', 'percent', 'number'].includes(display.valueFormat)
      ? display.valueFormat
      : 'number'
  };
}

function extractCharts(module) {
  return (Array.isArray(module?.generated?.charts) ? module.generated.charts : [])
    .map(normalizeChart)
    .filter(Boolean);
}

function extractFlowNodes(module, kind, pbsMovements = []) {
  const generated = asObject(module.generated);
  let source = [];

  if (kind.id === 'education') {
    source = Array.isArray(generated.education?.steps) && generated.education.steps.length > 0
      ? generated.education.steps
      : (Array.isArray(generated.education?.sections) ? generated.education.sections : []);
  } else if (kind.id === 'report') {
    source = Array.isArray(generated.report?.blocks) ? generated.report.blocks : [];
  } else if (kind.id === 'balance-sheet' && Array.isArray(pbsMovements) && pbsMovements.length > 0) {
    source = pbsMovements;
  } else if (kind.id === 'house-purchase') {
    source = Array.isArray(generated.housePurchaseResult?.actions)
      ? generated.housePurchaseResult.actions
      : [];
  }

  return source.slice(0, MAX_FLOW_NODES).map((item, index) => ({
    id: asTrimmedText(item?.id, `step-${index + 1}`),
    kicker: asTrimmedText(item?.kicker || item?.action || item?.type, `Step ${index + 1}`),
    title: asTrimmedText(item?.title || item?.label || item?.rowLabel || item?.fromLabel || item?.toLabel, `Step ${index + 1}`),
    detail: toPlainText(item?.bodyHtml || item?.body || item?.whyItMatters || item?.detail || '')
  }));
}

function buildBeats({ title, summary, metrics, charts, flowNodes }) {
  const primaryMetric = metrics[0] || null;
  const primaryChart = charts[0] || null;
  const primaryFlow = flowNodes[0] || null;
  const beats = [
    {
      id: 'hook',
      durationMs: 3200,
      label: 'The question',
      title,
      body: summary || 'Start with the central decision and the number that changes it.'
    }
  ];

  if (primaryMetric) {
    beats.push({
      id: 'metric',
      durationMs: 3600,
      label: primaryMetric.label,
      title: primaryMetric.value,
      body: 'The number to anchor before discussing the detail.'
    });
  }

  if (primaryChart || primaryFlow) {
    beats.push({
      id: primaryChart ? 'visual' : 'flow',
      durationMs: 5200,
      label: primaryChart ? primaryChart.title : primaryFlow.kicker,
      title: primaryChart ? 'Read the direction, not every data point.' : primaryFlow.title,
      body: primaryChart ? (primaryChart.subtitle || 'Use this visual to explain the change.') : primaryFlow.detail
    });
  }

  beats.push({
    id: 'takeaway',
    durationMs: 3600,
    label: 'What it means',
    title: 'Bring the decision back to the client.',
    body: summary || 'Use the final beat to transition back to the conversation.'
  });

  return beats.slice(0, 5);
}

export function buildVideoSceneManifest({
  session,
  module,
  activeScenario = {}
} = {}) {
  if (!module || typeof module !== 'object') {
    throw new Error('A module is required to create a video scene.');
  }

  const kind = getVideoModuleKind(module);
  const resolved = resolveModuleForVideo(module, activeScenario);
  const resolvedModule = resolved.module;
  const title = asTrimmedText(resolvedModule.title, 'Planning conversation');
  const summary = toPlainText(resolvedModule.generated?.summaryHtml || '');
  const metrics = extractStoryMetrics(resolvedModule, kind);
  const charts = extractCharts(resolvedModule);
  const flowNodes = extractFlowNodes(resolvedModule, kind, resolved.pbsMovements);
  const beats = buildBeats({ title, summary, metrics, charts, flowNodes });

  return {
    version: VIDEO_SCENE_MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    reviewRequired: true,
    capture: {
      width: 1920,
      height: 1080,
      aspectRatio: '16:9',
      presenterSafeZone: 'right'
    },
    source: {
      sessionId: asTrimmedText(session?.sessionId),
      clientName: asTrimmedText(session?.clientName, 'Client'),
      moduleId: asTrimmedText(resolvedModule.id),
      moduleKind: kind.id,
      moduleKindLabel: kind.label,
      activeScenario: resolved.activeScenario,
      calculationStatus: resolved.calculationStatus,
      calculationError: asTrimmedText(resolved.calculationError)
    },
    story: {
      title,
      summary,
      metrics,
      charts,
      flowNodes,
      beats
    },
    review: {
      visibleMetrics: metrics.map((metric) => ({ label: metric.label, value: metric.value })),
      presenterSafeZone: 'right third remains intentionally empty during capture.'
    }
  };
}

export function saveVideoSceneManifest(manifest, storage = window.sessionStorage) {
  storage.setItem(VIDEO_SCENE_STORAGE_KEY, JSON.stringify(manifest));
}

export function readVideoSceneManifest(storage = window.sessionStorage) {
  const raw = storage.getItem(VIDEO_SCENE_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const manifest = JSON.parse(raw);
    if (manifest?.version !== VIDEO_SCENE_MANIFEST_VERSION) {
      return null;
    }
    return manifest;
  } catch (_error) {
    return null;
  }
}
