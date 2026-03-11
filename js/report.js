const REPORT_BLOCK_TYPES = new Set([
  'callout',
  'markdown',
  'table',
  'chart',
  'svg',
  'timeline',
  'checklist',
  'sourcelist',
  'kpirow'
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneReportValue(value, depth = 0) {
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
      .map((entry) => cloneReportValue(entry, depth + 1))
      .filter((entry) => typeof entry !== 'undefined');
  }

  if (isPlainObject(value)) {
    const clone = {};
    Object.entries(value).forEach(([key, childValue]) => {
      const normalized = cloneReportValue(childValue, depth + 1);
      if (typeof normalized !== 'undefined') {
        clone[key] = normalized;
      }
    });
    return clone;
  }

  return undefined;
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

function normalizeDataset(dataset, datasetIndex) {
  const label = toTrimmedString(dataset?.label) || `Series ${datasetIndex + 1}`;
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

function normalizeChart(chart, index = 0) {
  if (!isPlainObject(chart)) {
    return { chart: null, errorMessage: 'Chart block requires a chart object.' };
  }

  const labels = Array.isArray(chart.labels)
    ? chart.labels.map((label) => String(label ?? ''))
    : [];
  const datasets = Array.isArray(chart.datasets)
    ? chart.datasets
      .filter((dataset) => isPlainObject(dataset))
      .map((dataset, datasetIndex) => normalizeDataset(dataset, datasetIndex))
    : [];

  if (datasets.length === 0) {
    return { chart: null, errorMessage: 'Chart block requires a non-empty datasets array.' };
  }

  return {
    chart: {
      id: toTrimmedString(chart.id) || `report-chart-${index + 1}`,
      title: toTrimmedString(chart.title) || `Chart ${index + 1}`,
      type: chart.type === 'bar' ? 'bar' : 'line',
      labels,
      datasets
    },
    errorMessage: ''
  };
}

function normalizeTableRow(row) {
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

function normalizeTablePayload(table) {
  if (!isPlainObject(table)) {
    return {
      title: '',
      columns: [],
      rows: []
    };
  }

  return {
    title: toTrimmedString(table.title),
    columns: Array.isArray(table.columns)
      ? table.columns.map((column) => String(column ?? ''))
      : [],
    rows: Array.isArray(table.rows)
      ? table.rows.map((row) => normalizeTableRow(row))
      : []
  };
}

function normalizeChecklistItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => {
      if (typeof item === 'string') {
        const label = item.trim();
        return label
          ? {
            id: `item-${index + 1}`,
            label,
            checked: false,
            note: ''
          }
          : null;
      }

      if (!isPlainObject(item)) {
        return null;
      }

      const label = toTrimmedString(item.label)
        || toTrimmedString(item.text)
        || toTrimmedString(item.title)
        || `Item ${index + 1}`;
      const note = toTrimmedString(item.note) || toTrimmedString(item.detail);
      const checked = item.checked === true
        || item.done === true
        || item.completed === true
        || toTrimmedString(item.status).toLowerCase() === 'done';

      return {
        id: toTrimmedString(item.id) || `item-${index + 1}`,
        label,
        checked,
        note
      };
    })
    .filter(Boolean);
}

function normalizeSourceItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => {
      if (typeof item === 'string') {
        const label = item.trim();
        return label
          ? {
            id: `source-${index + 1}`,
            label,
            url: '',
            note: '',
            kind: ''
          }
          : null;
      }

      if (!isPlainObject(item)) {
        return null;
      }

      const label = toTrimmedString(item.label)
        || toTrimmedString(item.title)
        || toTrimmedString(item.name)
        || `Source ${index + 1}`;

      return {
        id: toTrimmedString(item.id) || `source-${index + 1}`,
        label,
        url: toTrimmedString(item.url) || toTrimmedString(item.href),
        note: toTrimmedString(item.note) || toTrimmedString(item.summary),
        kind: toTrimmedString(item.kind) || toTrimmedString(item.type)
      };
    })
    .filter(Boolean);
}

function normalizeKpiItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => {
      if (!isPlainObject(item)) {
        return null;
      }

      const label = toTrimmedString(item.label)
        || toTrimmedString(item.title)
        || toTrimmedString(item.metric)
        || `KPI ${index + 1}`;
      const value = typeof item.value === 'number' && Number.isFinite(item.value)
        ? String(item.value)
        : toTrimmedString(item.value);
      const detail = toTrimmedString(item.detail)
        || toTrimmedString(item.note)
        || toTrimmedString(item.change)
        || toTrimmedString(item.context);
      const tone = toTrimmedString(item.tone) || toTrimmedString(item.variant);

      return {
        id: toTrimmedString(item.id) || `kpi-${index + 1}`,
        label,
        value,
        detail,
        tone
      };
    })
    .filter(Boolean);
}

function normalizeBlockBase(block, index) {
  const rawType = toTrimmedString(block?.type).toLowerCase();
  return {
    id: toTrimmedString(block?.id) || `report-block-${index + 1}`,
    type: rawType,
    title: toTrimmedString(block?.title),
    subtitle: toTrimmedString(block?.subtitle),
    errorMessage: ''
  };
}

function normalizeCalloutBlock(block, index) {
  const base = normalizeBlockBase(block, index);
  const content = typeof block?.markdown === 'string'
    ? block.markdown
    : (typeof block?.body === 'string'
      ? block.body
      : (typeof block?.content === 'string'
        ? block.content
        : (typeof block?.text === 'string' ? block.text : '')));
  const tone = toTrimmedString(block?.tone)
    || toTrimmedString(block?.variant)
    || toTrimmedString(block?.kind)
    || 'info';

  if (!base.title && !content.trim()) {
    return {
      ...base,
      errorMessage: 'Callout block requires a title or body.'
    };
  }

  return {
    ...base,
    type: 'callout',
    tone,
    markdown: content
  };
}

function normalizeMarkdownBlock(block, index) {
  const base = normalizeBlockBase(block, index);
  const markdown = typeof block?.markdown === 'string'
    ? block.markdown
    : (typeof block?.content === 'string'
      ? block.content
      : (typeof block?.body === 'string'
        ? block.body
        : (typeof block?.rawMarkdown === 'string' ? block.rawMarkdown : '')));

  if (!markdown.trim()) {
    return {
      ...base,
      type: 'markdown',
      errorMessage: 'Markdown block requires markdown content.'
    };
  }

  return {
    ...base,
    type: 'markdown',
    markdown
  };
}

function normalizeTableBlock(block, index) {
  const base = normalizeBlockBase(block, index);
  const source = isPlainObject(block?.table) ? block.table : block;
  const table = normalizeTablePayload(source);

  if (table.columns.length === 0 || table.rows.length === 0) {
    return {
      ...base,
      type: 'table',
      title: base.title || table.title,
      table,
      errorMessage: 'Table block requires columns and rows.'
    };
  }

  return {
    ...base,
    type: 'table',
    title: base.title || table.title,
    table
  };
}

function normalizeChartBlock(block, index) {
  const base = normalizeBlockBase(block, index);
  const { chart, errorMessage } = normalizeChart(block?.chart, index);

  if (!chart) {
    return {
      ...base,
      type: 'chart',
      errorMessage
    };
  }

  return {
    ...base,
    type: 'chart',
    title: base.title || chart.title,
    chart,
    errorMessage: ''
  };
}

function normalizeSvgLikeBlock(block, index, targetType) {
  const base = normalizeBlockBase(block, index);
  const source = isPlainObject(block?.svgSpec)
    ? block.svgSpec
    : (isPlainObject(block?.svg)
      ? block.svg
      : (isPlainObject(block) && toTrimmedString(block.kind) ? block : null));

  if (!source) {
    return {
      ...base,
      type: targetType,
      errorMessage: `${targetType === 'timeline' ? 'Timeline' : 'SVG'} block requires an svgSpec object.`
    };
  }

  const svgSpec = cloneReportValue(source) || {};
  if (targetType === 'timeline' && !toTrimmedString(svgSpec.kind)) {
    svgSpec.kind = 'timeline';
  }

  return {
    ...base,
    type: targetType,
    svgSpec
  };
}

function normalizeTimelineBlock(block, index) {
  const base = normalizeBlockBase(block, index);
  const timelineSource = isPlainObject(block?.timeline)
    ? block.timeline
    : (isPlainObject(block?.svgSpec) ? block.svgSpec : block);

  if (!isPlainObject(timelineSource)) {
    return {
      ...base,
      type: 'timeline',
      errorMessage: 'Timeline block requires a timeline object or svgSpec.'
    };
  }

  const svgSpec = cloneReportValue(timelineSource) || {};
  if (!toTrimmedString(svgSpec.kind)) {
    svgSpec.kind = 'timeline';
  }

  return {
    ...base,
    type: 'timeline',
    svgSpec
  };
}

function normalizeChecklistBlock(block, index) {
  const base = normalizeBlockBase(block, index);
  const source = isPlainObject(block?.checklist) ? block.checklist : block;
  const items = normalizeChecklistItems(firstArray(source.items, source.entries));

  if (items.length === 0) {
    return {
      ...base,
      type: 'checklist',
      errorMessage: 'Checklist block requires a non-empty items array.'
    };
  }

  return {
    ...base,
    type: 'checklist',
    title: base.title || toTrimmedString(source.title),
    items
  };
}

function normalizeSourceListBlock(block, index) {
  const base = normalizeBlockBase(block, index);
  const source = isPlainObject(block?.sourceList) ? block.sourceList : block;
  const items = normalizeSourceItems(firstArray(source.items, source.sources));

  if (items.length === 0) {
    return {
      ...base,
      type: 'sourceList',
      errorMessage: 'Source list block requires a non-empty items array.'
    };
  }

  return {
    ...base,
    type: 'sourceList',
    title: base.title || toTrimmedString(source.title),
    items
  };
}

function normalizeKpiRowBlock(block, index) {
  const base = normalizeBlockBase(block, index);
  const source = isPlainObject(block?.kpiRow) ? block.kpiRow : block;
  const items = normalizeKpiItems(firstArray(source.items, source.kpis));

  if (items.length === 0) {
    return {
      ...base,
      type: 'kpiRow',
      errorMessage: 'KPI row block requires a non-empty items array.'
    };
  }

  return {
    ...base,
    type: 'kpiRow',
    title: base.title || toTrimmedString(source.title),
    items
  };
}

function normalizeUnknownBlock(block, index) {
  const base = normalizeBlockBase(block, index);
  return {
    ...base,
    errorMessage: `Unsupported report block type "${base.type || 'unknown'}".`
  };
}

function ensureUniqueBlockIds(blocks) {
  const seen = new Map();

  return blocks.map((block, index) => {
    const baseId = toTrimmedString(block?.id) || `report-block-${index + 1}`;
    const count = seen.get(baseId) || 0;
    seen.set(baseId, count + 1);

    if (count === 0) {
      return {
        ...block,
        id: baseId
      };
    }

    return {
      ...block,
      id: `${baseId}-${count + 1}`
    };
  });
}

export function normalizeReportBlock(block, index = 0) {
  if (!isPlainObject(block)) {
    return {
      id: `report-block-${index + 1}`,
      type: 'unknown',
      title: '',
      subtitle: '',
      errorMessage: 'Report blocks must be objects.'
    };
  }

  const rawType = toTrimmedString(block.type).toLowerCase();
  if (!REPORT_BLOCK_TYPES.has(rawType)) {
    return normalizeUnknownBlock(block, index);
  }

  switch (rawType) {
    case 'callout':
      return normalizeCalloutBlock(block, index);
    case 'markdown':
      return normalizeMarkdownBlock(block, index);
    case 'table':
      return normalizeTableBlock(block, index);
    case 'chart':
      return normalizeChartBlock(block, index);
    case 'svg':
      return normalizeSvgLikeBlock(block, index, 'svg');
    case 'timeline':
      return normalizeTimelineBlock(block, index);
    case 'checklist':
      return normalizeChecklistBlock(block, index);
    case 'sourcelist':
      return normalizeSourceListBlock(block, index);
    case 'kpirow':
      return normalizeKpiRowBlock(block, index);
    default:
      return normalizeUnknownBlock(block, index);
  }
}

export function normalizeReport(report) {
  if (!isPlainObject(report)) {
    return null;
  }

  const blocks = Array.isArray(report.blocks)
    ? report.blocks.map((block, index) => normalizeReportBlock(block, index))
    : [];

  return {
    title: typeof report.title === 'string' ? report.title : '',
    rawMarkdown: typeof report.rawMarkdown === 'string' ? report.rawMarkdown : '',
    blocks: ensureUniqueBlockIds(blocks)
  };
}

export function validateReportPayload(report) {
  if (report === null) {
    return null;
  }

  if (!isPlainObject(report)) {
    throw new Error('generated.report must be an object.');
  }

  if ('title' in report && typeof report.title !== 'string') {
    throw new Error('generated.report.title must be a string when provided.');
  }

  if ('rawMarkdown' in report && typeof report.rawMarkdown !== 'string') {
    throw new Error('generated.report.rawMarkdown must be a string when provided.');
  }

  if ('blocks' in report && !Array.isArray(report.blocks)) {
    throw new Error('generated.report.blocks must be an array when provided.');
  }

  return normalizeReport(report);
}

export function isReportModule(module) {
  return isPlainObject(module?.generated?.report);
}

export function getReportChartBlocks(source) {
  const report = isPlainObject(source?.generated)
    ? source.generated.report
    : source;

  if (!isPlainObject(report) || !Array.isArray(report.blocks)) {
    return [];
  }

  return report.blocks
    .filter((block) => block?.type === 'chart' && !block.errorMessage && isPlainObject(block.chart))
    .map((block) => ({
      blockId: block.id,
      title: block.title,
      subtitle: block.subtitle,
      chart: cloneReportValue(block.chart) || null
    }))
    .filter((entry) => entry.chart);
}
