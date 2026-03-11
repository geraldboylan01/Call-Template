import { computeGridPosition, applyOverviewLayout } from './layout.js';
import { renderSvgDiagram, serializeSvg } from './education_svg.js';
import { getReportChartBlocks, isReportModule } from './report.js';

function formatLocalTime(isoString) {
  try {
    return new Date(isoString).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (_error) {
    return '';
  }
}

function htmlToPlainText(html) {
  if (!html || typeof html !== 'string') {
    return '';
  }

  const temp = document.createElement('template');
  temp.innerHTML = html;
  return (temp.content.textContent || '').replace(/\s+/g, ' ').trim();
}

function sanitizeSummaryHtml(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') {
    return '';
  }

  const template = document.createElement('template');
  template.innerHTML = rawHtml;

  template.content
    .querySelectorAll('script, style, iframe, object, embed, link, meta, form, button, input, textarea')
    .forEach((element) => element.remove());

  template.content.querySelectorAll('*').forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      const attrName = attribute.name.toLowerCase();
      const attrValue = attribute.value;

      if (attrName.startsWith('on')) {
        element.removeAttribute(attribute.name);
        return;
      }

      if ((attrName === 'href' || attrName === 'src') && /^\s*javascript:/i.test(attrValue)) {
        element.removeAttribute(attribute.name);
      }
    });
  });

  return template.innerHTML;
}

function sanitizeExternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return '';
  }

  try {
    const url = new URL(rawUrl, window.location.href);
    const protocol = url.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:' && protocol !== 'tel:') {
      return '';
    }
    return url.href;
  } catch (_error) {
    return '';
  }
}

function findNextInlineMarkdownToken(text, startIndex) {
  const patterns = [
    { type: 'link', regex: /\[([^\]]+)\]\(([^)]+)\)/g },
    { type: 'code', regex: /`([^`]+)`/g },
    { type: 'strong', regex: /\*\*([^*]+)\*\*/g },
    { type: 'emphasis', regex: /\*([^*]+)\*/g },
    { type: 'emphasis', regex: /_([^_]+)_/g }
  ];

  let bestMatch = null;
  patterns.forEach((pattern) => {
    pattern.regex.lastIndex = startIndex;
    const match = pattern.regex.exec(text);
    if (!match) {
      return;
    }

    if (!bestMatch || match.index < bestMatch.match.index) {
      bestMatch = { pattern, match };
    }
  });

  return bestMatch;
}

function renderInlineMarkdown(text) {
  const fragment = document.createDocumentFragment();
  const input = String(text ?? '');
  let cursor = 0;

  while (cursor < input.length) {
    const nextToken = findNextInlineMarkdownToken(input, cursor);
    if (!nextToken) {
      fragment.appendChild(document.createTextNode(input.slice(cursor)));
      break;
    }

    const { pattern, match } = nextToken;
    if (match.index > cursor) {
      fragment.appendChild(document.createTextNode(input.slice(cursor, match.index)));
    }

    if (pattern.type === 'link') {
      const label = match[1];
      const safeHref = sanitizeExternalUrl(match[2]);
      if (safeHref) {
        const anchor = document.createElement('a');
        anchor.href = safeHref;
        anchor.target = '_blank';
        anchor.rel = 'noreferrer noopener';
        anchor.appendChild(renderInlineMarkdown(label));
        fragment.appendChild(anchor);
      } else {
        fragment.appendChild(document.createTextNode(match[0]));
      }
    } else if (pattern.type === 'code') {
      const code = document.createElement('code');
      code.textContent = match[1];
      fragment.appendChild(code);
    } else if (pattern.type === 'strong') {
      const strong = document.createElement('strong');
      strong.appendChild(renderInlineMarkdown(match[1]));
      fragment.appendChild(strong);
    } else if (pattern.type === 'emphasis') {
      const emphasis = document.createElement('em');
      emphasis.appendChild(renderInlineMarkdown(match[1]));
      fragment.appendChild(emphasis);
    } else {
      fragment.appendChild(document.createTextNode(match[0]));
    }

    cursor = match.index + match[0].length;
  }

  return fragment;
}

function renderMarkdownFragment(markdown) {
  const fragment = document.createDocumentFragment();
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const paragraphLines = [];
  const quoteLines = [];
  let listEl = null;
  let listType = '';
  let inCodeFence = false;
  let codeLines = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    const paragraph = document.createElement('p');
    paragraph.appendChild(renderInlineMarkdown(paragraphLines.join(' ')));
    fragment.appendChild(paragraph);
    paragraphLines.length = 0;
  };

  const flushQuote = () => {
    if (quoteLines.length === 0) {
      return;
    }

    const blockquote = document.createElement('blockquote');
    const paragraph = document.createElement('p');
    paragraph.appendChild(renderInlineMarkdown(quoteLines.join(' ')));
    blockquote.appendChild(paragraph);
    fragment.appendChild(blockquote);
    quoteLines.length = 0;
  };

  const flushList = () => {
    if (!listEl) {
      return;
    }

    fragment.appendChild(listEl);
    listEl = null;
    listType = '';
  };

  const flushCode = () => {
    if (codeLines.length === 0) {
      return;
    }

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = codeLines.join('\n');
    pre.appendChild(code);
    fragment.appendChild(pre);
    codeLines = [];
  };

  lines.forEach((line) => {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      flushParagraph();
      flushQuote();
      flushList();
      if (inCodeFence) {
        flushCode();
        inCodeFence = false;
      } else {
        inCodeFence = true;
        codeLines = [];
      }
      return;
    }

    if (inCodeFence) {
      codeLines.push(line);
      return;
    }

    if (!trimmed) {
      flushParagraph();
      flushQuote();
      flushList();
      return;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (headingMatch) {
      flushParagraph();
      flushQuote();
      flushList();

      const headingLevel = Math.min(6, headingMatch[1].length);
      const heading = document.createElement(`h${headingLevel}`);
      heading.appendChild(renderInlineMarkdown(headingMatch[2]));
      fragment.appendChild(heading);
      return;
    }

    const quoteMatch = /^>\s?(.*)$/.exec(trimmed);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      return;
    }

    const unorderedMatch = /^[-*+]\s+(.*)$/.exec(trimmed);
    const orderedMatch = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (unorderedMatch || orderedMatch) {
      flushParagraph();
      flushQuote();

      const nextListType = unorderedMatch ? 'ul' : 'ol';
      if (!listEl || listType !== nextListType) {
        flushList();
        listEl = document.createElement(nextListType);
        listType = nextListType;
      }

      const item = document.createElement('li');
      item.appendChild(renderInlineMarkdown(unorderedMatch ? unorderedMatch[1] : orderedMatch[1]));
      listEl.appendChild(item);
      return;
    }

    flushList();
    flushQuote();
    paragraphLines.push(trimmed);
  });

  if (inCodeFence) {
    flushCode();
  }

  flushParagraph();
  flushQuote();
  flushList();

  return fragment;
}

function makeOverviewSnippet(module) {
  const notes = module.notes || '';
  if (notes.trim()) {
    const cleanNotes = notes.replace(/\s+/g, ' ').trim();
    return cleanNotes.length > 120 ? `${cleanNotes.slice(0, 117)}...` : cleanNotes;
  }

  const summary = htmlToPlainText(module.generated?.summaryHtml || '');
  if (summary) {
    return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
  }

  return 'No notes yet.';
}

function isPensionModule(module) {
  return Boolean(module?.generated?.pensionInputs);
}

function isAffordablePensionMode(module) {
  const inputs = module?.generated?.pensionInputs;
  return Boolean(inputs && inputs.incomeMode === 'affordable' && inputs.minDrawdownMode !== true);
}

function getPensionShowMaxForModule(moduleId) {
  if (typeof window.__getPensionShowMaxForModule !== 'function') {
    return false;
  }

  return Boolean(window.__getPensionShowMaxForModule(moduleId));
}

function filterOutputsRowsForPensionToggle(module, tableData) {
  if (!isAffordablePensionMode(module)) {
    return tableData;
  }

  const columns = Array.isArray(tableData?.columns) ? [...tableData.columns] : [];
  const rows = Array.isArray(tableData?.rows) ? tableData.rows : [];
  if (columns.length === 0 || rows.length === 0) {
    return tableData;
  }

  const showMax = getPensionShowMaxForModule(module?.id);
  const filteredRows = rows.filter((row) => {
    const label = String(Array.isArray(row) ? row[0] ?? '' : '').trim().toLowerCase();
    const isCurrentAffordable = label.startsWith('affordable income (current');
    const isMaxAffordable = label.startsWith('affordable income (max');

    if (!isCurrentAffordable && !isMaxAffordable) {
      return true;
    }

    return showMax ? isMaxAffordable : isCurrentAffordable;
  });

  return {
    columns,
    rows: filteredRows
  };
}

function normalizeCellKeyToken(value, fallback) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  return normalized || fallback;
}

function getTableHighlightState(module, tableKind) {
  if (!module?.ui || typeof module.ui !== 'object' || Array.isArray(module.ui)) {
    return null;
  }

  const tableHighlights = module.ui.tableHighlights;
  if (!tableHighlights || typeof tableHighlights !== 'object' || Array.isArray(tableHighlights)) {
    return null;
  }

  const tableState = tableHighlights[tableKind];
  if (!tableState || typeof tableState !== 'object' || Array.isArray(tableState)) {
    return null;
  }

  return tableState;
}

function getHighlightedCellKeySet(module, tableKind) {
  const tableState = getTableHighlightState(module, tableKind);
  if (!tableState || !Array.isArray(tableState.selected)) {
    return new Set();
  }

  return new Set(tableState.selected.filter((value) => typeof value === 'string' && value));
}

function buildTableCellKey(tableKind, {
  rowLabel,
  rowIndex,
  colLabel,
  colIndex
}) {
  const safeTableKind = tableKind === 'assumptions' || tableKind === 'outputs'
    ? tableKind
    : 'table';
  const safeRowLabel = normalizeCellKeyToken(rowLabel, `row-${rowIndex}`);
  const safeColLabel = normalizeCellKeyToken(colLabel, `col-${colIndex}`);
  return `${safeTableKind}|${safeRowLabel}|${safeColLabel}`;
}

function decorateSelectableTableCell(td, {
  module,
  tableKind,
  rowLabel,
  rowIndex,
  colLabel,
  colIndex,
  selectedSet
}) {
  if (!module?.id || (tableKind !== 'assumptions' && tableKind !== 'outputs')) {
    return;
  }

  const key = buildTableCellKey(tableKind, {
    rowLabel,
    rowIndex,
    colLabel,
    colIndex
  });

  td.dataset.moduleId = module.id;
  td.dataset.tableKind = tableKind;
  td.dataset.rowIndex = String(rowIndex);
  td.dataset.colIndex = String(colIndex);
  td.dataset.cellKey = key;
  td.classList.add('cc-cell-hoverable');
  td.classList.toggle('cc-cell-selected', selectedSet.has(key));
}

function getLoanEngineInputs(module) {
  return module?.generated?.loanInputs || module?.generated?.mortgageInputs || null;
}

function isMortgageModule(module) {
  return Boolean(getLoanEngineInputs(module));
}

function isEducationModule(module) {
  const education = module?.generated?.education;
  if (education && typeof education === 'object' && !Array.isArray(education)) {
    return true;
  }

  const topic = module?.generated?.education?.topic;
  return typeof topic === 'string' && topic.trim().length > 0;
}

function sanitizeFileToken(value, fallback) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized || fallback;
}

function sanitizeEducationChart(chart, index = 0) {
  if (!chart || typeof chart !== 'object' || Array.isArray(chart)) {
    return null;
  }

  const labels = Array.isArray(chart.labels)
    ? chart.labels.map((label) => String(label ?? ''))
    : [];
  const datasets = Array.isArray(chart.datasets)
    ? chart.datasets
      .filter((dataset) => dataset && typeof dataset === 'object' && !Array.isArray(dataset))
      .map((dataset, datasetIndex) => ({
        label: typeof dataset.label === 'string' && dataset.label.trim()
          ? dataset.label
          : `Series ${datasetIndex + 1}`,
        data: Array.isArray(dataset.data)
          ? dataset.data.map((value) => {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : 0;
          })
          : []
      }))
    : [];

  if (datasets.length === 0) {
    return null;
  }

  return {
    id: typeof chart.id === 'string' && chart.id.trim()
      ? chart.id
      : `education-chart-${index + 1}`,
    title: typeof chart.title === 'string' && chart.title.trim()
      ? chart.title
      : `Chart ${index + 1}`,
    type: chart.type === 'bar' ? 'bar' : 'line',
    labels,
    datasets
  };
}

function getEducationVisuals(module) {
  const visuals = module?.generated?.education?.visuals;
  return Array.isArray(visuals) ? visuals : [];
}

export function getEducationChartVisuals(module) {
  const visuals = getEducationVisuals(module);
  const charts = [];

  visuals.forEach((visual) => {
    if (!visual || typeof visual !== 'object' || Array.isArray(visual)) {
      return;
    }

    const type = String(visual.type || '').trim().toLowerCase();
    if (type !== 'chart') {
      return;
    }

    const normalizedChart = sanitizeEducationChart(visual.chart, charts.length);
    if (normalizedChart) {
      charts.push(normalizedChart);
    }
  });

  return charts;
}

export function getChartHydrationModule(module) {
  if (!module || typeof module !== 'object') {
    return module;
  }

  if (isReportModule(module)) {
    return {
      ...module,
      generated: {
        ...(module.generated || {}),
        charts: getReportChartBlocks(module).map((entry) => entry.chart)
      }
    };
  }

  if (!isEducationModule(module)) {
    return module;
  }

  const charts = getEducationChartVisuals(module);
  if (charts.length === 0) {
    return module;
  }

  return {
    ...module,
    generated: {
      ...(module.generated || {}),
      charts
    }
  };
}

function formatNumberForInput(value, maxDecimals = 4) {
  if (!Number.isFinite(value)) {
    return '';
  }

  const fixed = Number(value).toFixed(maxDecimals);
  return fixed.replace(/\.?0+$/, '');
}

function formatRateForInput(value) {
  if (!Number.isFinite(value)) {
    return '';
  }

  return `${formatNumberForInput(value * 100, 4)}%`;
}

function parseIsoDateToMonthDate(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
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

function deriveRemainingTermYears(mortgageInputs) {
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
  const inclusiveMonths = deltaMonths + 1;
  if (!Number.isInteger(inclusiveMonths) || inclusiveMonths <= 0) {
    return null;
  }

  return inclusiveMonths / 12;
}

function getEditorStatusText(status) {
  if (status?.phase === 'updating') {
    return 'Updating...';
  }

  if (status?.phase === 'updated') {
    return 'Updated';
  }

  return '';
}

function getEditorStatusClass(status) {
  if (status?.phase === 'updating') {
    return 'is-updating';
  }

  if (status?.phase === 'updated') {
    return 'is-updated';
  }

  return 'is-idle';
}

function normalizeAssumptionLabelToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function isInlineAssumptionsEditableModule(module) {
  return isPensionModule(module) || isMortgageModule(module);
}

function deriveRemainingTermMonths(mortgageInputs) {
  const years = deriveRemainingTermYears(mortgageInputs);
  if (!Number.isFinite(years) || years <= 0) {
    return null;
  }

  return Math.max(1, Math.round(years * 12));
}

function getDefaultMortgagePaymentMode(mortgageInputs) {
  return Number.isFinite(mortgageInputs?.fixedPaymentAmount) && mortgageInputs.fixedPaymentAmount > 0
    ? 'fixed'
    : 'calculated';
}

function buildGeneratedCardHeader(titleText) {
  const header = document.createElement('div');
  header.className = 'generated-card-header';

  const heading = document.createElement('h3');
  heading.className = 'generated-card-title';
  heading.textContent = titleText;
  header.appendChild(heading);

  const actions = document.createElement('div');
  actions.className = 'generated-card-header-actions';
  header.appendChild(actions);

  return {
    header,
    actions
  };
}

function buildInlineAssumptionInputCell({
  module,
  calculator,
  field,
  value,
  placeholder,
  inputMode,
  onPatchInputs,
  error,
  readOnly = false
}) {
  const wrap = document.createElement('div');
  wrap.className = 'assumptions-inline-editor';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'assumptions-inline-input';
  input.placeholder = placeholder;
  input.inputMode = inputMode;
  input.value = String(value ?? '');
  input.disabled = readOnly;
  input.readOnly = readOnly;
  input.setAttribute('aria-invalid', error ? 'true' : 'false');
  input.classList.toggle('is-invalid', Boolean(error));
  input.dataset.assumptionField = field;

  if (!readOnly && typeof onPatchInputs === 'function') {
    input.addEventListener('input', (event) => {
      onPatchInputs({
        type: 'draft-change',
        moduleId: module.id,
        calculator,
        field,
        value: event.target.value
      });
    });

    input.addEventListener('blur', (event) => {
      if (event.target.dataset.skipCommit === '1') {
        event.target.dataset.skipCommit = '0';
        return;
      }
      onPatchInputs({
        type: 'commit-field',
        moduleId: module.id,
        calculator,
        field,
        value: event.target.value
      });
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        event.target.blur();
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.target.dataset.skipCommit = '1';
        onPatchInputs({
          type: 'cancel-edit',
          moduleId: module.id,
          calculator
        });
        event.target.blur();
      }
    });
  }

  const helper = document.createElement('div');
  helper.className = 'assumptions-inline-field-helper';
  helper.textContent = 'Enter to apply';

  const errorEl = document.createElement('div');
  errorEl.className = 'assumptions-inline-error';
  errorEl.textContent = error ? String(error) : '';

  wrap.appendChild(input);
  wrap.appendChild(helper);
  wrap.appendChild(errorEl);

  return wrap;
}

function buildMortgagePaymentModeEditorCell({
  module,
  status,
  mortgageInputs,
  onPatchInputs,
  readOnly = false
}) {
  const errors = status?.errors && typeof status.errors === 'object' ? status.errors : {};
  const draftValues = status?.draftValues && typeof status.draftValues === 'object' ? status.draftValues : {};
  const defaultMode = getDefaultMortgagePaymentMode(mortgageInputs);
  const draftMode = String(draftValues.fixedPaymentMode || '').trim().toLowerCase();
  const mode = draftMode === 'fixed' || draftMode === 'calculated'
    ? draftMode
    : defaultMode;
  const showFixedInput = mode === 'fixed';

  const wrap = document.createElement('div');
  wrap.className = 'assumptions-inline-mode-cell';

  const toggle = document.createElement('div');
  toggle.className = 'assumptions-inline-mode-toggle';
  toggle.classList.toggle('is-invalid', Boolean(errors.fixedPaymentMode));

  const makeModeButton = (targetMode, label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'assumptions-inline-mode-btn';
    button.textContent = label;
    button.dataset.mode = targetMode;
    button.classList.toggle('is-active', mode === targetMode);
    button.disabled = readOnly;
    if (!readOnly && typeof onPatchInputs === 'function') {
      button.addEventListener('click', () => {
        onPatchInputs({
          type: 'set-payment-mode',
          moduleId: module.id,
          calculator: 'mortgage',
          mode: targetMode
        });
      });
    }
    return button;
  };

  toggle.appendChild(makeModeButton('calculated', 'Calculated'));
  toggle.appendChild(makeModeButton('fixed', 'Fixed'));
  wrap.appendChild(toggle);

  const modeError = document.createElement('div');
  modeError.className = 'assumptions-inline-error';
  modeError.textContent = errors.fixedPaymentMode ? String(errors.fixedPaymentMode) : '';
  wrap.appendChild(modeError);

  if (showFixedInput) {
    const fixedInputValue = draftValues.fixedPaymentAmount ?? formatNumberForInput(mortgageInputs.fixedPaymentAmount, 2);
    wrap.appendChild(buildInlineAssumptionInputCell({
      module,
      calculator: 'mortgage',
      field: 'fixedPaymentAmount',
      value: fixedInputValue,
      placeholder: '1500',
      inputMode: 'decimal',
      onPatchInputs,
      error: errors.fixedPaymentAmount,
      readOnly
    }));
  }

  return wrap;
}

function createEditableAssumptionCell({
  module,
  rowLabel,
  status,
  onPatchInputs,
  readOnly = false
}) {
  const labelToken = normalizeAssumptionLabelToken(rowLabel);
  const draftValues = status?.draftValues && typeof status.draftValues === 'object' ? status.draftValues : {};
  const errors = status?.errors && typeof status.errors === 'object' ? status.errors : {};

  if (isPensionModule(module)) {
    const pensionInputs = module.generated.pensionInputs;
    const pensionFieldMap = {
      currentage: {
        field: 'currentAge',
        value: draftValues.currentAge ?? formatNumberForInput(pensionInputs.currentAge, 0),
        placeholder: '42',
        inputMode: 'numeric'
      },
      retirementage: {
        field: 'retirementAge',
        value: draftValues.retirementAge ?? formatNumberForInput(pensionInputs.retirementAge, 0),
        placeholder: '67',
        inputMode: 'numeric'
      },
      currentsalary: {
        field: 'currentSalary',
        value: draftValues.currentSalary ?? formatNumberForInput(pensionInputs.currentSalary, 2),
        placeholder: '85000',
        inputMode: 'decimal'
      },
      currentpensionvalue: {
        field: 'currentPot',
        value: draftValues.currentPot ?? formatNumberForInput(pensionInputs.currentPot, 2),
        placeholder: '180000',
        inputMode: 'decimal'
      },
      personalcontribution: {
        field: 'personalPct',
        value: draftValues.personalPct ?? formatRateForInput(pensionInputs.personalPct),
        placeholder: '8%',
        inputMode: 'decimal'
      },
      employercontribution: {
        field: 'employerPct',
        value: draftValues.employerPct ?? formatRateForInput(pensionInputs.employerPct),
        placeholder: '6%',
        inputMode: 'decimal'
      },
      growthrate: {
        field: 'growthRate',
        value: draftValues.growthRate ?? formatRateForInput(pensionInputs.growthRate),
        placeholder: '5%',
        inputMode: 'decimal'
      },
      wagegrowth: {
        field: 'wageGrowthRate',
        value: draftValues.wageGrowthRate ?? formatRateForInput(pensionInputs.wageGrowthRate),
        placeholder: '2.5%',
        inputMode: 'decimal'
      },
      inflation: {
        field: 'inflationRate',
        value: draftValues.inflationRate ?? formatRateForInput(pensionInputs.inflationRate),
        placeholder: '2%',
        inputMode: 'decimal'
      },
      targetretirementincome: {
        field: 'targetIncomeToday',
        value: draftValues.targetIncomeToday ?? formatNumberForInput(pensionInputs.targetIncomeToday, 2),
        placeholder: '42000',
        inputMode: 'decimal'
      }
    };

    const descriptor = pensionFieldMap[labelToken];
    if (!descriptor) {
      return null;
    }

    return buildInlineAssumptionInputCell({
      module,
      calculator: 'pension',
      field: descriptor.field,
      value: descriptor.value,
      placeholder: descriptor.placeholder,
      inputMode: descriptor.inputMode,
      onPatchInputs,
      error: errors[descriptor.field],
      readOnly
    });
  }

  if (isMortgageModule(module)) {
    const mortgageInputs = getLoanEngineInputs(module);
    if (!mortgageInputs) {
      return null;
    }
    const termMonths = deriveRemainingTermMonths(mortgageInputs);
    const mortgageFieldMap = {
      currentbalance: {
        field: 'currentBalance',
        value: draftValues.currentBalance ?? formatNumberForInput(mortgageInputs.currentBalance, 2),
        placeholder: '320000',
        inputMode: 'decimal'
      },
      currentmortgagebalance: {
        field: 'currentBalance',
        value: draftValues.currentBalance ?? formatNumberForInput(mortgageInputs.currentBalance, 2),
        placeholder: '320000',
        inputMode: 'decimal'
      },
      currentloanbalance: {
        field: 'currentBalance',
        value: draftValues.currentBalance ?? formatNumberForInput(mortgageInputs.currentBalance, 2),
        placeholder: '320000',
        inputMode: 'decimal'
      },
      annualinterestrate: {
        field: 'annualInterestRate',
        value: draftValues.annualInterestRate ?? formatRateForInput(mortgageInputs.annualInterestRate),
        placeholder: '4.2%',
        inputMode: 'decimal'
      },
      mortgageterm: {
        field: 'termMonths',
        value: draftValues.termMonths ?? formatNumberForInput(termMonths, 0),
        placeholder: '324',
        inputMode: 'numeric'
      },
      loanterm: {
        field: 'termMonths',
        value: draftValues.termMonths ?? formatNumberForInput(termMonths, 0),
        placeholder: '324',
        inputMode: 'numeric'
      },
      oneoffoverpayment: {
        field: 'oneOffOverpayment',
        value: draftValues.oneOffOverpayment ?? formatNumberForInput(mortgageInputs.oneOffOverpayment, 2),
        placeholder: '10000',
        inputMode: 'decimal'
      },
      annualoverpayment: {
        field: 'annualOverpayment',
        value: draftValues.annualOverpayment ?? formatNumberForInput(mortgageInputs.annualOverpayment, 2),
        placeholder: '3000',
        inputMode: 'decimal'
      }
    };

    if (labelToken === 'monthlypaymentsource') {
      return buildMortgagePaymentModeEditorCell({
        module,
        status,
        mortgageInputs,
        onPatchInputs,
        readOnly
      });
    }

    const descriptor = mortgageFieldMap[labelToken];
    if (!descriptor) {
      return null;
    }

    return buildInlineAssumptionInputCell({
      module,
      calculator: 'mortgage',
      field: descriptor.field,
      value: descriptor.value,
      placeholder: descriptor.placeholder,
      inputMode: descriptor.inputMode,
      onPatchInputs,
      error: errors[descriptor.field],
      readOnly
    });
  }

  return null;
}

function buildAssumptionsTableCard(module, {
  onPatchInputs = null,
  status = null,
  readOnly = false
} = {}) {
  const generated = module.generated || { assumptions: { columns: [], rows: [] } };
  const assumptions = generated.assumptions || { columns: [], rows: [] };

  const card = document.createElement('section');
  card.className = 'generated-card generated-table-card';
  card.dataset.generatedCard = 'assumptions';

  const { header, actions } = buildGeneratedCardHeader('Assumptions');
  const hasInlineEditor = !readOnly
    && typeof onPatchInputs === 'function'
    && isInlineAssumptionsEditableModule(module);
  const editMode = Boolean(status?.isEditing);

  if (hasInlineEditor) {
    const statusEl = document.createElement('span');
    statusEl.className = `assumptions-inline-status ${getEditorStatusClass(status)}`;
    statusEl.dataset.assumptionStatus = 'true';
    statusEl.textContent = getEditorStatusText(status);
    actions.appendChild(statusEl);

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'assumptions-inline-edit-btn';
    editButton.title = editMode ? 'Done editing assumptions' : 'Edit assumptions';
    editButton.setAttribute('aria-label', editButton.title);
    editButton.setAttribute('aria-pressed', editMode ? 'true' : 'false');
    editButton.innerHTML = (
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
      + '<path d="M3 17.25V21h3.75l11-11.03-3.75-3.75L3 17.25Zm17.71-10.04a1.004 1.004 0 0 0 0-1.42l-2.5-2.5a1.004 1.004 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 2-1.66Z"></path>'
      + '</svg>'
    );
    editButton.addEventListener('click', () => {
      onPatchInputs({
        type: 'toggle-edit-mode',
        moduleId: module.id,
        calculator: isPensionModule(module) ? 'pension' : 'mortgage'
      });
    });
    actions.appendChild(editButton);
  }

  card.appendChild(header);

  const columns = Array.isArray(assumptions.columns) ? assumptions.columns : [];
  const rows = Array.isArray(assumptions.rows) ? assumptions.rows : [];

  if (columns.length === 0 || rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'No assumptions provided.';
    card.appendChild(empty);
    return card;
  }

  const wrap = document.createElement('div');
  wrap.className = 'generated-table-wrap';

  const table = document.createElement('table');
  table.className = 'generated-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  columns.forEach((column) => {
    const th = document.createElement('th');
    th.textContent = String(column ?? '');
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  tbody.dataset.assumptionsTableBody = module.id;
  const valueColumnIndex = columns.findIndex((column) => String(column).trim().toLowerCase() === 'value');
  const selectedSet = getHighlightedCellKeySet(module, 'assumptions');

  rows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    const safeRow = Array.isArray(row) ? row : [];
    const rowLabel = String(safeRow[0] ?? '');
    const stableRowLabel = normalizeCellKeyToken(rowLabel, `row-${rowIndex}`);

    columns.forEach((_column, index) => {
      const td = document.createElement('td');
      const cellText = String(safeRow[index] ?? '');

      if (editMode && hasInlineEditor && index === valueColumnIndex) {
        const editorCell = createEditableAssumptionCell({
          module,
          rowLabel,
          status,
          onPatchInputs,
          readOnly
        });

        if (editorCell) {
          td.classList.add('assumptions-inline-cell', 'is-editable');
          td.appendChild(editorCell);
        } else {
          td.textContent = cellText;
        }
      } else {
        td.textContent = cellText;
      }

      decorateSelectableTableCell(td, {
        module,
        tableKind: 'assumptions',
        rowLabel: stableRowLabel,
        rowIndex,
        colLabel: columns[index],
        colIndex: index,
        selectedSet
      });

      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);

  return card;
}

function showLayer(layer) {
  if (!layer) {
    return;
  }

  layer.classList.remove('is-hidden');
  layer.setAttribute('aria-hidden', 'false');
}

function hideLayer(layer) {
  if (!layer) {
    return;
  }

  layer.classList.add('is-hidden');
  layer.setAttribute('aria-hidden', 'true');
}

function buildTableCard(cardTitle, tableData, {
  dataGeneratedCard = '',
  module = null,
  tableKind = ''
} = {}) {
  const card = document.createElement('section');
  card.className = 'generated-card generated-table-card';
  if (dataGeneratedCard) {
    card.dataset.generatedCard = dataGeneratedCard;
  }

  const { header } = buildGeneratedCardHeader(cardTitle);
  card.appendChild(header);

  const columns = Array.isArray(tableData?.columns) ? tableData.columns : [];
  const rows = Array.isArray(tableData?.rows) ? tableData.rows : [];
  const tableHighlightEnabled = (tableKind === 'assumptions' || tableKind === 'outputs') && Boolean(module?.id);
  const selectedSet = tableHighlightEnabled ? getHighlightedCellKeySet(module, tableKind) : new Set();

  if (columns.length === 0 || rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = `No ${cardTitle.toLowerCase()} provided.`;
    card.appendChild(empty);
    return card;
  }

  const wrap = document.createElement('div');
  wrap.className = 'generated-table-wrap';

  const table = document.createElement('table');
  table.className = 'generated-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  columns.forEach((column) => {
    const th = document.createElement('th');
    th.textContent = String(column ?? '');
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    const safeRow = Array.isArray(row) ? row : [];
    const stableRowLabel = normalizeCellKeyToken(safeRow[0], `row-${rowIndex}`);

    columns.forEach((column, index) => {
      const td = document.createElement('td');
      td.textContent = String(safeRow[index] ?? '');

      if (tableHighlightEnabled) {
        decorateSelectableTableCell(td, {
          module,
          tableKind,
          rowLabel: stableRowLabel,
          rowIndex,
          colLabel: column,
          colIndex: index,
          selectedSet
        });
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);

  return card;
}

function formatBucketedAmount(value) {
  if (!Number.isFinite(value)) {
    return '';
  }

  if (Number.isInteger(value)) {
    return value.toLocaleString();
  }

  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function hasOutputsBucketed(outputsBucketed) {
  return Boolean(
    outputsBucketed &&
    typeof outputsBucketed === 'object' &&
    !Array.isArray(outputsBucketed) &&
    Array.isArray(outputsBucketed.sections) &&
    outputsBucketed.sections.length > 0
  );
}

function isOutputsBucketedPresent(outputsBucketed) {
  return Boolean(
    outputsBucketed &&
    typeof outputsBucketed === 'object' &&
    !Array.isArray(outputsBucketed)
  );
}

function normalizeSectionToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function findOutputsBucketedSection(sections, targetKey) {
  const targetToken = normalizeSectionToken(targetKey);
  return sections.find((section) => (
    normalizeSectionToken(section?.key) === targetToken
    || normalizeSectionToken(section?.title) === targetToken
  )) || null;
}

function sanitizeSectionRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .filter((row) => Array.isArray(row) && row.length >= 2)
    .map((row) => [String(row[0] ?? ''), Number(row[1])])
    .filter((row) => Number.isFinite(row[1]));
}

function buildOutputsBucketedMiniTablesContent(outputsBucketed) {
  const wrap = document.createElement('div');
  wrap.className = 'pbs-bucket-tables';

  const currencySymbol = typeof outputsBucketed.currencySymbol === 'string' && outputsBucketed.currencySymbol.trim()
    ? outputsBucketed.currencySymbol
    : '€';

  outputsBucketed.sections.forEach((section, sectionIndex) => {
    const sectionWrap = document.createElement('article');
    sectionWrap.className = 'pbs-bucket-section';

    const columns = Array.isArray(section.columns) && section.columns.length === 2
      ? section.columns
      : ['Asset', `Amount (${currencySymbol})`];
    const rows = sanitizeSectionRows(section.rows);
    const key = typeof section.key === 'string' ? section.key.toLowerCase() : '';
    const title = typeof section.title === 'string' && section.title.trim()
      ? section.title
      : `Section ${sectionIndex + 1}`;
    const subtotalLabel = typeof section.subtotalLabel === 'string' && section.subtotalLabel.trim()
      ? section.subtotalLabel
      : 'Subtotal';
    const hasSubtotal = Number.isFinite(Number(section.subtotalValue));
    const isSummary = key === 'summary' || title.trim().toLowerCase() === 'summary';

    const table = document.createElement('table');
    table.className = 'generated-table pbs-bucket-table';

    const thead = document.createElement('thead');

    const titleRow = document.createElement('tr');
    titleRow.className = 'pbs-bucket-title-row';
    const titleCell = document.createElement('th');
    titleCell.colSpan = 2;
    titleCell.textContent = title;
    titleRow.appendChild(titleCell);
    thead.appendChild(titleRow);

    const headerRow = document.createElement('tr');
    columns.forEach((column, columnIndex) => {
      const th = document.createElement('th');
      th.textContent = String(column ?? '');
      if (columnIndex === 1) {
        th.classList.add('pbs-amount-col');
      }
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      const label = row[0];
      const amount = row[1];

      const labelCell = document.createElement('td');
      labelCell.textContent = label;
      tr.appendChild(labelCell);

      const amountCell = document.createElement('td');
      amountCell.className = 'pbs-amount-col';
      amountCell.textContent = formatBucketedAmount(amount);
      tr.appendChild(amountCell);

      if (isSummary && normalizeSectionToken(label) === 'networth') {
        tr.classList.add('pbs-net-worth-row');
      }

      tbody.appendChild(tr);
    });

    if (hasSubtotal) {
      const subtotalRow = document.createElement('tr');
      subtotalRow.className = 'pbs-subtotal-row';

      const subtotalLabelCell = document.createElement('td');
      subtotalLabelCell.textContent = subtotalLabel;
      subtotalRow.appendChild(subtotalLabelCell);

      const subtotalValueCell = document.createElement('td');
      subtotalValueCell.className = 'pbs-amount-col';
      subtotalValueCell.textContent = formatBucketedAmount(Number(section.subtotalValue));
      subtotalRow.appendChild(subtotalValueCell);

      tbody.appendChild(subtotalRow);
    }

    table.appendChild(tbody);
    sectionWrap.appendChild(table);

    if (typeof section.notes === 'string' && section.notes.trim()) {
      const note = document.createElement('p');
      note.className = 'pbs-bucket-note';
      note.textContent = section.notes;
      sectionWrap.appendChild(note);
    }

    wrap.appendChild(sectionWrap);
  });

  return wrap;
}

function buildOutputsBucketedDetailCard(section, {
  defaultTitle,
  defaultColumns,
  highlightNetWorth = false
} = {}) {
  const card = document.createElement('section');
  card.className = 'pbs-stacked-card';

  const title = typeof section.title === 'string' && section.title.trim()
    ? section.title
    : defaultTitle;
  const columns = Array.isArray(section.columns) && section.columns.length === 2
    ? section.columns
    : defaultColumns;
  const rows = sanitizeSectionRows(section.rows);
  const subtotalLabel = typeof section.subtotalLabel === 'string' && section.subtotalLabel.trim()
    ? section.subtotalLabel
    : 'Subtotal';
  const hasSubtotal = Number.isFinite(Number(section.subtotalValue));

  const heading = document.createElement('h4');
  heading.className = 'generated-card-title pbs-stacked-title';
  heading.textContent = title;
  card.appendChild(heading);

  const table = document.createElement('table');
  table.className = 'generated-table pbs-bucket-table pbs-detail-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  columns.forEach((column, index) => {
    const th = document.createElement('th');
    th.textContent = String(column ?? '');
    if (index === 1) {
      th.classList.add('pbs-amount-col');
    }
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    const label = row[0];

    const labelCell = document.createElement('td');
    labelCell.textContent = label;
    tr.appendChild(labelCell);

    const amountCell = document.createElement('td');
    amountCell.className = 'pbs-amount-col';
    amountCell.textContent = formatBucketedAmount(row[1]);
    tr.appendChild(amountCell);

    if (highlightNetWorth && normalizeSectionToken(label) === 'networth') {
      tr.classList.add('pbs-net-worth-row');
    }

    tbody.appendChild(tr);
  });

  if (hasSubtotal) {
    const subtotalRow = document.createElement('tr');
    subtotalRow.className = 'pbs-subtotal-row';

    const subtotalLabelCell = document.createElement('td');
    subtotalLabelCell.textContent = subtotalLabel;
    subtotalRow.appendChild(subtotalLabelCell);

    const subtotalValueCell = document.createElement('td');
    subtotalValueCell.className = 'pbs-amount-col';
    subtotalValueCell.textContent = formatBucketedAmount(Number(section.subtotalValue));
    subtotalRow.appendChild(subtotalValueCell);

    tbody.appendChild(subtotalRow);
  }

  table.appendChild(tbody);
  card.appendChild(table);

  return card;
}

function buildOutputsBucketedMatrixContent(outputsBucketed) {
  const sections = outputsBucketed.sections;
  const assetSectionKeys = ['lifestyle', 'liquidity', 'longevity', 'legacy'];
  const assetSections = assetSectionKeys.map((key) => findOutputsBucketedSection(sections, key));

  if (assetSections.some((section) => !section)) {
    return null;
  }

  const outputStack = document.createElement('div');
  outputStack.className = 'pbs-outputs-stack';

  const matrixPanel = document.createElement('section');
  matrixPanel.className = 'pbs-matrix-panel';

  const matrixWrap = document.createElement('div');
  matrixWrap.className = 'pbs-matrix-wrap';

  const matrixTable = document.createElement('table');
  matrixTable.className = 'generated-table pbs-matrix';

  const rowsByBucket = assetSections.map((section) => sanitizeSectionRows(section.rows));
  const rowCount = Math.max(0, ...rowsByBucket.map((rows) => rows.length));

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.className = 'pbs-matrix-head';
  assetSections.forEach((section, index) => {
    const th = document.createElement('th');
    th.textContent = typeof section.title === 'string' && section.title.trim()
      ? section.title
      : assetSectionKeys[index].charAt(0).toUpperCase() + assetSectionKeys[index].slice(1);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  matrixTable.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const tr = document.createElement('tr');

    rowsByBucket.forEach((bucketRows) => {
      const cell = document.createElement('td');
      cell.className = 'pbs-cell';

      const item = bucketRows[rowIndex];
      if (item) {
        const name = document.createElement('div');
        name.className = 'pbs-cell-name';
        name.textContent = item[0];

        const amount = document.createElement('div');
        amount.className = 'pbs-cell-amt';
        amount.textContent = formatBucketedAmount(item[1]);

        cell.appendChild(name);
        cell.appendChild(amount);
      } else {
        cell.classList.add('pbs-cell-empty');
      }

      tr.appendChild(cell);
    });

    tbody.appendChild(tr);
  }
  matrixTable.appendChild(tbody);

  const tfoot = document.createElement('tfoot');
  const subtotalRow = document.createElement('tr');
  subtotalRow.className = 'pbs-subtotal-row';
  assetSections.forEach((section) => {
    const subtotalCell = document.createElement('td');
    const subtotalLabel = document.createElement('div');
    subtotalLabel.className = 'pbs-subtotal-label';
    subtotalLabel.textContent = typeof section.subtotalLabel === 'string' && section.subtotalLabel.trim()
      ? section.subtotalLabel
      : 'Subtotal';

    const subtotalAmount = document.createElement('div');
    subtotalAmount.className = 'pbs-cell-amt pbs-subtotal-amt';
    subtotalAmount.textContent = formatBucketedAmount(Number(section.subtotalValue));

    subtotalCell.appendChild(subtotalLabel);
    subtotalCell.appendChild(subtotalAmount);
    subtotalRow.appendChild(subtotalCell);
  });
  tfoot.appendChild(subtotalRow);
  matrixTable.appendChild(tfoot);

  matrixWrap.appendChild(matrixTable);
  matrixPanel.appendChild(matrixWrap);
  outputStack.appendChild(matrixPanel);

  const currencySymbol = typeof outputsBucketed.currencySymbol === 'string' && outputsBucketed.currencySymbol.trim()
    ? outputsBucketed.currencySymbol
    : '€';

  const liabilitiesSection = findOutputsBucketedSection(sections, 'liabilities');
  if (liabilitiesSection) {
    outputStack.appendChild(buildOutputsBucketedDetailCard(liabilitiesSection, {
      defaultTitle: 'Liabilities',
      defaultColumns: ['Liability', `Amount (${currencySymbol})`]
    }));
  }

  const summarySection = findOutputsBucketedSection(sections, 'summary');
  if (summarySection) {
    outputStack.appendChild(buildOutputsBucketedDetailCard(summarySection, {
      defaultTitle: 'Summary',
      defaultColumns: ['Metric', `Amount (${currencySymbol})`],
      highlightNetWorth: true
    }));
  }

  return outputStack;
}

function buildOutputsBucketedCard(outputsBucketed) {
  const card = document.createElement('section');
  card.className = 'generated-card generated-table-card generated-outputs-bucketed-card';
  card.dataset.generatedCard = 'outputs-bucketed';

  const { header } = buildGeneratedCardHeader('Outputs');
  card.appendChild(header);

  if (!hasOutputsBucketed(outputsBucketed)) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'No outputs provided.';
    card.appendChild(empty);
    return card;
  }

  const matrixContent = buildOutputsBucketedMatrixContent(outputsBucketed);
  if (matrixContent) {
    card.appendChild(matrixContent);
    return card;
  }

  card.appendChild(buildOutputsBucketedMiniTablesContent(outputsBucketed));
  return card;
}

function buildSummaryCard(summaryHtml) {
  const card = document.createElement('section');
  card.className = 'generated-card generated-summary-card';
  card.dataset.generatedCard = 'summary';

  const { header } = buildGeneratedCardHeader('Summary');
  card.appendChild(header);

  const content = document.createElement('div');
  content.className = 'generated-summary-content';

  const safeHtml = sanitizeSummaryHtml(summaryHtml || '');

  if (!safeHtml) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'No generated summary yet.';
    content.appendChild(empty);
  } else {
    content.innerHTML = safeHtml;
  }

  card.appendChild(content);

  return card;
}

function buildChartsCard(module, charts, { showPensionToggle = true, readOnly = false } = {}) {
  const card = document.createElement('section');
  card.className = 'generated-card generated-charts-card';
  card.dataset.generatedCard = 'charts';

  const { header } = buildGeneratedCardHeader('Charts');
  card.appendChild(header);

  if (showPensionToggle && isPensionModule(module)) {
    const showMax = typeof window.__getPensionShowMaxForModule === 'function'
      ? Boolean(window.__getPensionShowMaxForModule(module.id))
      : false;

    const toggle = document.createElement('label');
    toggle.className = 'pension-toggle';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'pension-toggle-input';
    checkbox.checked = showMax;

    const switchTrack = document.createElement('span');
    switchTrack.className = 'pension-toggle-switch';
    switchTrack.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'pension-toggle-text';
    text.textContent = 'Show max personal contributions';

    if (!readOnly) {
      checkbox.addEventListener('change', (event) => {
        if (typeof window.__setPensionShowMax === 'function') {
          window.__setPensionShowMax(module.id, Boolean(event.target.checked));
        }
      });
    } else {
      checkbox.disabled = true;
      toggle.style.opacity = '0.75';
    }

    toggle.appendChild(checkbox);
    toggle.appendChild(switchTrack);
    toggle.appendChild(text);
    card.appendChild(toggle);
  }

  const list = document.createElement('div');
  list.className = 'generated-charts-list';

  if (!Array.isArray(charts) || charts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'No charts generated yet.';
    list.appendChild(empty);
  } else {
    charts.forEach((chart, index) => {
      list.appendChild(buildChartMountCard({
        title: chart.title || `Chart ${index + 1}`,
        chartIndex: index,
        className: 'generated-chart-block'
      }));
    });
  }

  card.appendChild(list);

  return card;
}

function downloadSvgVisual(svgElement, filenameBase = 'diagram') {
  try {
    const serialized = serializeSvg(svgElement);
    const blob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${sanitizeFileToken(filenameBase, 'diagram')}.svg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (_error) {
    window.alert('Could not download SVG from this visual.');
  }
}

function copySvgVisual(svgElement, statusElement = null) {
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    if (statusElement) {
      statusElement.textContent = 'Clipboard unavailable';
    }
    return;
  }

  let serialized = '';
  try {
    serialized = serializeSvg(svgElement);
  } catch (_error) {
    if (statusElement) {
      statusElement.textContent = 'Could not serialize SVG';
    }
    return;
  }

  navigator.clipboard.writeText(serialized).then(() => {
    if (!statusElement) {
      return;
    }
    statusElement.textContent = 'Copied';
    window.setTimeout(() => {
      if (statusElement.textContent === 'Copied') {
        statusElement.textContent = '';
      }
    }, 1200);
  }).catch(() => {
    if (statusElement) {
      statusElement.textContent = 'Copy failed';
    }
  });
}

function buildEducationTopicCard(module, education) {
  const card = document.createElement('section');
  card.className = 'generated-card education-topic-card';

  const { header } = buildGeneratedCardHeader('Topic');
  card.appendChild(header);

  const topic = typeof education?.topic === 'string' && education.topic.trim()
    ? education.topic.trim()
    : (module?.title || 'Education');
  const audience = typeof education?.audience === 'string' && education.audience.trim()
    ? education.audience.trim()
    : '';

  const topicLine = document.createElement('p');
  topicLine.className = 'education-topic-line';
  topicLine.textContent = topic;
  card.appendChild(topicLine);

  if (audience) {
    const audienceLine = document.createElement('p');
    audienceLine.className = 'education-audience-line';
    audienceLine.textContent = `Audience: ${audience}`;
    card.appendChild(audienceLine);
  }

  return card;
}

function buildEducationSectionsCard(education) {
  const card = document.createElement('section');
  card.className = 'generated-card education-sections-card';

  const { header } = buildGeneratedCardHeader('Sections');
  card.appendChild(header);

  const sections = Array.isArray(education?.sections) ? education.sections : [];
  if (sections.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'No sections provided.';
    card.appendChild(empty);
    return card;
  }

  const list = document.createElement('div');
  list.className = 'education-sections-list';

  sections.forEach((section, index) => {
    const details = document.createElement('details');
    details.className = 'education-section-block';
    details.open = index === 0;

    const summary = document.createElement('summary');
    summary.className = 'education-section-summary';
    summary.textContent = section?.title || `Section ${index + 1}`;
    details.appendChild(summary);

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'education-section-body';

    const safeBodyHtml = sanitizeSummaryHtml(section?.bodyHtml || '');
    if (safeBodyHtml) {
      const bodyContent = document.createElement('div');
      bodyContent.className = 'education-section-body-content';
      bodyContent.innerHTML = safeBodyHtml;
      bodyWrap.appendChild(bodyContent);
    }

    const bullets = Array.isArray(section?.bullets)
      ? section.bullets.filter((bullet) => typeof bullet === 'string' && bullet.trim())
      : [];
    if (bullets.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'education-section-bullets';
      bullets.forEach((bullet) => {
        const li = document.createElement('li');
        li.textContent = bullet;
        ul.appendChild(li);
      });
      bodyWrap.appendChild(ul);
    }

    if (!safeBodyHtml && bullets.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'generated-empty';
      empty.textContent = 'No section details provided.';
      bodyWrap.appendChild(empty);
    }

    details.appendChild(bodyWrap);
    list.appendChild(details);
  });

  card.appendChild(list);
  return card;
}

function buildChartMountCard({
  title,
  subtitle = '',
  chartIndex = 0,
  className = 'generated-chart-block'
} = {}) {
  const card = document.createElement('article');
  card.className = className;
  card.dataset.chartIndex = String(chartIndex);

  const chartTop = document.createElement('div');
  chartTop.className = 'generated-chart-top';

  const titleEl = document.createElement('h4');
  titleEl.className = 'generated-chart-title';
  titleEl.textContent = title || `Chart ${chartIndex + 1}`;
  chartTop.appendChild(titleEl);

  const downloadButton = document.createElement('button');
  downloadButton.type = 'button';
  downloadButton.className = 'chart-download-btn';
  downloadButton.textContent = 'CSV';
  downloadButton.title = 'Download CSV';
  downloadButton.setAttribute('aria-label', `Download CSV for ${titleEl.textContent}`);
  downloadButton.setAttribute('data-chart-download', 'true');
  chartTop.appendChild(downloadButton);

  card.appendChild(chartTop);

  if (typeof subtitle === 'string' && subtitle.trim()) {
    const subtitleEl = document.createElement('p');
    subtitleEl.className = 'education-visual-subtitle';
    subtitleEl.textContent = subtitle.trim();
    card.appendChild(subtitleEl);
  }

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'generated-chart-canvas-wrap';

  const canvas = document.createElement('canvas');
  canvas.className = 'generated-chart-canvas';
  canvas.height = 220;
  canvasWrap.appendChild(canvas);

  card.appendChild(canvasWrap);
  return card;
}

function buildEducationChartVisualCard(visual, chart, chartIndex) {
  return buildChartMountCard({
    title: chart.title || visual?.title || `Chart ${chartIndex + 1}`,
    subtitle: typeof visual?.subtitle === 'string' ? visual.subtitle : '',
    chartIndex,
    className: 'education-visual-card education-chart-card generated-chart-block'
  });
}

function buildSvgVisualCard(module, visual, visualIndex, {
  className = 'education-visual-card education-svg-card',
  errorPrefix = 'Could not render SVG visual'
} = {}) {
  const titleText = typeof visual?.title === 'string' && visual.title.trim()
    ? visual.title.trim()
    : `Diagram ${visualIndex + 1}`;

  const card = document.createElement('article');
  card.className = className;
  card.dataset.svgTheme = 'dark';

  const top = document.createElement('div');
  top.className = 'education-visual-top';

  const title = document.createElement('h4');
  title.className = 'generated-chart-title';
  title.textContent = titleText;
  top.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'education-visual-actions';

  const downloadButton = document.createElement('button');
  downloadButton.type = 'button';
  downloadButton.className = 'chart-download-btn';
  downloadButton.textContent = 'Download SVG';
  downloadButton.disabled = true;
  actions.appendChild(downloadButton);

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'chart-download-btn';
  copyButton.textContent = 'Copy SVG';
  copyButton.disabled = true;
  actions.appendChild(copyButton);

  const copyStatus = document.createElement('span');
  copyStatus.className = 'education-copy-status';
  copyStatus.setAttribute('aria-live', 'polite');
  actions.appendChild(copyStatus);

  top.appendChild(actions);
  card.appendChild(top);

  if (typeof visual?.subtitle === 'string' && visual.subtitle.trim()) {
    const subtitle = document.createElement('p');
    subtitle.className = 'education-visual-subtitle';
    subtitle.textContent = visual.subtitle.trim();
    card.appendChild(subtitle);
  }

  const svgHost = document.createElement('div');
  svgHost.className = 'education-svg-host';
  card.appendChild(svgHost);

  try {
    const svg = renderSvgDiagram(visual?.svgSpec || {});
    if (!(svg instanceof SVGElement)) {
      throw new Error('Diagram renderer returned an invalid SVG element.');
    }

    const svgTheme = String(svg.getAttribute('data-theme') || visual?.svgSpec?.theme || 'dark')
      .trim()
      .toLowerCase() === 'light'
      ? 'light'
      : 'dark';
    card.dataset.svgTheme = svgTheme;
    svgHost.appendChild(svg);

    const baseName = `${module?.title || module?.id || 'module'}-${titleText}`;
    downloadButton.disabled = false;
    downloadButton.addEventListener('click', () => {
      downloadSvgVisual(svg, baseName);
    });

    copyButton.disabled = false;
    copyButton.addEventListener('click', () => {
      copySvgVisual(svg, copyStatus);
    });
  } catch (error) {
    const inlineError = document.createElement('p');
    inlineError.className = 'education-visual-error';
    inlineError.textContent = `${errorPrefix}: ${error?.message || 'Invalid svgSpec.'}`;
    svgHost.appendChild(inlineError);
  }

  return card;
}

function buildEducationSvgVisualCard(module, visual, visualIndex) {
  return buildSvgVisualCard(module, visual, visualIndex, {
    className: 'education-visual-card education-svg-card',
    errorPrefix: 'Could not render SVG visual'
  });
}

function buildEducationVisualsCard(module, education) {
  const card = document.createElement('section');
  card.className = 'generated-card education-visuals-card generated-charts-card';
  card.dataset.generatedCard = 'education-visuals';

  const { header } = buildGeneratedCardHeader('Visuals');
  card.appendChild(header);

  const visuals = Array.isArray(education?.visuals) ? education.visuals : [];
  if (visuals.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'No visuals generated yet.';
    card.appendChild(empty);
    return card;
  }

  const list = document.createElement('div');
  list.className = 'education-visuals-list generated-charts-list';

  let chartIndex = 0;
  visuals.forEach((visual, visualIndex) => {
    const type = String(visual?.type || '').trim().toLowerCase();
    if (type === 'chart') {
      const chart = sanitizeEducationChart(visual?.chart, chartIndex);
      if (!chart) {
        const errorCard = document.createElement('article');
        errorCard.className = 'education-visual-card education-visual-error-card';
        const error = document.createElement('p');
        error.className = 'education-visual-error';
        error.textContent = 'Could not render chart visual: invalid chart schema.';
        errorCard.appendChild(error);
        list.appendChild(errorCard);
        return;
      }

      list.appendChild(buildEducationChartVisualCard(visual, chart, chartIndex));
      chartIndex += 1;
      return;
    }

    if (type === 'svg') {
      list.appendChild(buildEducationSvgVisualCard(module, visual, visualIndex));
      return;
    }

    const unsupported = document.createElement('article');
    unsupported.className = 'education-visual-card education-visual-error-card';
    const error = document.createElement('p');
    error.className = 'education-visual-error';
    error.textContent = `Unsupported visual type \"${type || 'unknown'}\".`;
    unsupported.appendChild(error);
    list.appendChild(unsupported);
  });

  card.appendChild(list);
  return card;
}

function buildEducationReferencesCard(education) {
  const references = Array.isArray(education?.references) ? education.references : [];
  if (references.length === 0) {
    return null;
  }

  const card = document.createElement('section');
  card.className = 'generated-card education-references-card';

  const { header } = buildGeneratedCardHeader('References');
  card.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'education-references-list';

  references.forEach((reference, index) => {
    const item = document.createElement('li');
    item.className = 'education-reference-item';

    const label = typeof reference?.label === 'string' && reference.label.trim()
      ? reference.label.trim()
      : `Reference ${index + 1}`;
    const kind = typeof reference?.kind === 'string' && reference.kind.trim()
      ? ` (${reference.kind.trim()})`
      : '';
    const note = typeof reference?.note === 'string' && reference.note.trim()
      ? ` - ${reference.note.trim()}`
      : '';
    item.textContent = `${label}${kind}${note}`;
    list.appendChild(item);
  });

  card.appendChild(list);
  return card;
}

function buildReportBlockShell(block, className) {
  const card = document.createElement('article');
  card.className = className;
  card.dataset.reportBlockType = String(block?.type || 'unknown');
  if (typeof block?.id === 'string' && block.id.trim()) {
    card.dataset.reportBlockId = block.id.trim();
  }

  return card;
}

function appendReportBlockHeader(card, {
  title = '',
  subtitle = ''
} = {}) {
  if (!(title && title.trim()) && !(subtitle && subtitle.trim())) {
    return;
  }

  const header = document.createElement('div');
  header.className = 'report-block-header';

  if (title && title.trim()) {
    const heading = document.createElement('h3');
    heading.className = 'report-block-title';
    heading.textContent = title.trim();
    header.appendChild(heading);
  }

  if (subtitle && subtitle.trim()) {
    const subtitleEl = document.createElement('p');
    subtitleEl.className = 'report-block-subtitle';
    subtitleEl.textContent = subtitle.trim();
    header.appendChild(subtitleEl);
  }

  card.appendChild(header);
}

function buildReportBlockErrorCard(block, message) {
  const card = buildReportBlockShell(block, 'report-block report-error-block');
  appendReportBlockHeader(card, {
    title: block?.title || `${String(block?.type || 'block').replace(/([A-Z])/g, ' $1').trim() || 'Block'} error`
  });

  const error = document.createElement('p');
  error.className = 'report-inline-error';
  error.textContent = message || 'This block could not be rendered.';
  card.appendChild(error);
  return card;
}

function buildReportMarkdownBlockCard(block, markdown) {
  const card = buildReportBlockShell(block, 'report-block report-markdown-block');
  appendReportBlockHeader(card, {
    title: block?.title || '',
    subtitle: block?.subtitle || ''
  });

  const content = document.createElement('div');
  content.className = 'report-markdown-content';
  content.appendChild(renderMarkdownFragment(markdown));
  card.appendChild(content);
  return card;
}

function renderReportCalloutBlock(block) {
  const tone = String(block?.tone || 'info')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    || 'info';
  const card = buildReportBlockShell(block, 'report-block report-callout-block');
  card.dataset.reportTone = tone;
  appendReportBlockHeader(card, {
    title: block?.title || '',
    subtitle: block?.subtitle || ''
  });

  const content = document.createElement('div');
  content.className = 'report-callout-content';

  const safeBodyHtml = sanitizeSummaryHtml(block?.bodyHtml || '');
  if (safeBodyHtml && htmlToPlainText(safeBodyHtml)) {
    const body = document.createElement('div');
    body.className = 'report-markdown-content report-callout-body';
    body.innerHTML = safeBodyHtml;
    content.appendChild(body);
  } else if (typeof block?.markdown === 'string' && block.markdown.trim()) {
    const markdown = document.createElement('div');
    markdown.className = 'report-markdown-content report-callout-body';
    markdown.appendChild(renderMarkdownFragment(block.markdown));
    content.appendChild(markdown);
  }

  const bullets = Array.isArray(block?.bullets)
    ? block.bullets.filter((bullet) => typeof bullet === 'string' && bullet.trim())
    : [];
  if (bullets.length > 0) {
    const list = document.createElement('ul');
    list.className = 'report-callout-bullets';
    bullets.forEach((bullet) => {
      const item = document.createElement('li');
      item.textContent = bullet;
      list.appendChild(item);
    });
    content.appendChild(list);
  }

  if (content.childElementCount === 0) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'No callout details provided.';
    content.appendChild(empty);
  }

  card.appendChild(content);
  return card;
}

function renderReportMarkdownBlock(block) {
  return buildReportMarkdownBlockCard(block, block?.markdown || '');
}

function renderReportTableBlock(block) {
  const card = buildTableCard(block?.title || 'Table', block?.table || {});
  card.classList.add('report-block', 'report-table-block');
  card.dataset.reportBlockType = 'table';
  if (typeof block?.id === 'string' && block.id.trim()) {
    card.dataset.reportBlockId = block.id.trim();
  }

  if (typeof block?.subtitle === 'string' && block.subtitle.trim()) {
    const subtitle = document.createElement('p');
    subtitle.className = 'report-block-subtitle';
    subtitle.textContent = block.subtitle.trim();
    const header = card.querySelector('.generated-card-header');
    if (header) {
      header.insertAdjacentElement('afterend', subtitle);
    }
  }

  return card;
}

function renderReportChartBlock(block, chartIndex) {
  const card = buildChartMountCard({
    title: block?.title || block?.chart?.title || `Chart ${chartIndex + 1}`,
    subtitle: typeof block?.subtitle === 'string' ? block.subtitle : '',
    chartIndex,
    className: 'report-block report-chart-block generated-chart-block'
  });

  if (typeof block?.id === 'string' && block.id.trim()) {
    card.dataset.reportBlockId = block.id.trim();
  }

  return card;
}

function renderReportSvgBlock(module, block, blockIndex) {
  const card = buildSvgVisualCard(module, {
    title: block?.title || '',
    subtitle: block?.subtitle || '',
    svgSpec: block?.svgSpec || {}
  }, blockIndex, {
    className: 'report-block report-svg-block education-visual-card education-svg-card',
    errorPrefix: 'Could not render report SVG block'
  });

  card.dataset.reportBlockType = 'svg';
  if (typeof block?.id === 'string' && block.id.trim()) {
    card.dataset.reportBlockId = block.id.trim();
  }

  return card;
}

function renderReportTimelineBlock(module, block, blockIndex) {
  const title = block?.title || `Timeline ${blockIndex + 1}`;
  const card = buildSvgVisualCard(module, {
    title,
    subtitle: block?.subtitle || '',
    svgSpec: block?.svgSpec || {}
  }, blockIndex, {
    className: 'report-block report-timeline-block education-visual-card education-svg-card',
    errorPrefix: 'Could not render report timeline block'
  });

  card.dataset.reportBlockType = 'timeline';
  if (typeof block?.id === 'string' && block.id.trim()) {
    card.dataset.reportBlockId = block.id.trim();
  }

  return card;
}

function renderReportChecklistBlock(block) {
  const card = buildReportBlockShell(block, 'report-block report-checklist-block');
  appendReportBlockHeader(card, {
    title: block?.title || 'Checklist',
    subtitle: block?.subtitle || ''
  });

  const list = document.createElement('ul');
  list.className = 'report-checklist-list';

  (Array.isArray(block?.items) ? block.items : []).forEach((item) => {
    const entry = document.createElement('li');
    entry.className = 'report-checklist-item';
    entry.dataset.checked = item?.checked ? 'true' : 'false';

    const marker = document.createElement('span');
    marker.className = 'report-checklist-marker';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = item?.checked ? '✓' : '•';
    entry.appendChild(marker);

    const body = document.createElement('div');
    body.className = 'report-checklist-body';

    const label = document.createElement('div');
    label.className = 'report-checklist-label';
    label.textContent = item?.label || 'Checklist item';
    body.appendChild(label);

    if (typeof item?.note === 'string' && item.note.trim()) {
      const note = document.createElement('div');
      note.className = 'report-checklist-note';
      note.textContent = item.note.trim();
      body.appendChild(note);
    }

    entry.appendChild(body);
    list.appendChild(entry);
  });

  card.appendChild(list);
  return card;
}

function renderReportSourceListBlock(block) {
  const card = buildReportBlockShell(block, 'report-block report-source-list-block');
  appendReportBlockHeader(card, {
    title: block?.title || 'Sources',
    subtitle: block?.subtitle || ''
  });

  const list = document.createElement('ol');
  list.className = 'report-source-list';

  (Array.isArray(block?.items) ? block.items : []).forEach((item, index) => {
    const entry = document.createElement('li');
    entry.className = 'report-source-item';

    const safeHref = sanitizeExternalUrl(item?.url);
    const label = typeof item?.label === 'string' && item.label.trim()
      ? item.label.trim()
      : `Source ${index + 1}`;

    const titleLine = document.createElement(safeHref ? 'a' : 'span');
    titleLine.className = 'report-source-label';
    titleLine.textContent = label;
    if (safeHref) {
      titleLine.href = safeHref;
      titleLine.target = '_blank';
      titleLine.rel = 'noreferrer noopener';
    }
    entry.appendChild(titleLine);

    if (typeof item?.kind === 'string' && item.kind.trim()) {
      const kind = document.createElement('span');
      kind.className = 'report-source-kind';
      kind.textContent = item.kind.trim();
      entry.appendChild(kind);
    }

    if (typeof item?.note === 'string' && item.note.trim()) {
      const note = document.createElement('p');
      note.className = 'report-source-note';
      note.textContent = item.note.trim();
      entry.appendChild(note);
    }

    list.appendChild(entry);
  });

  card.appendChild(list);
  return card;
}

function renderReportKpiRowBlock(block) {
  const card = buildReportBlockShell(block, 'report-block report-kpi-row-block');
  appendReportBlockHeader(card, {
    title: block?.title || '',
    subtitle: block?.subtitle || ''
  });

  const row = document.createElement('div');
  row.className = 'report-kpi-row';

  (Array.isArray(block?.items) ? block.items : []).forEach((item) => {
    const metric = document.createElement('article');
    metric.className = 'report-kpi-item';
    if (typeof item?.tone === 'string' && item.tone.trim()) {
      metric.dataset.tone = item.tone.trim().toLowerCase();
    }

    const label = document.createElement('div');
    label.className = 'report-kpi-label';
    label.textContent = item?.label || 'Metric';
    metric.appendChild(label);

    const value = document.createElement('div');
    value.className = 'report-kpi-value';
    value.textContent = item?.value || '--';
    metric.appendChild(value);

    if (typeof item?.detail === 'string' && item.detail.trim()) {
      const detail = document.createElement('div');
      detail.className = 'report-kpi-detail';
      detail.textContent = item.detail.trim();
      metric.appendChild(detail);
    }

    row.appendChild(metric);
  });

  card.appendChild(row);
  return card;
}

function renderReportBlock(module, block, context) {
  if (block?.errorMessage) {
    return buildReportBlockErrorCard(block, block.errorMessage);
  }

  try {
    switch (block?.type) {
      case 'callout':
        return renderReportCalloutBlock(block);
      case 'markdown':
        return renderReportMarkdownBlock(block);
      case 'table':
        return renderReportTableBlock(block);
      case 'chart': {
        const chartIndex = context.chartIndexByBlockId.get(block.id);
        if (!Number.isFinite(chartIndex)) {
          return buildReportBlockErrorCard(block, 'Could not resolve chart hydration index for this report block.');
        }
        return renderReportChartBlock(block, chartIndex);
      }
      case 'svg':
        return renderReportSvgBlock(module, block, context.blockIndex);
      case 'timeline':
        return renderReportTimelineBlock(module, block, context.blockIndex);
      case 'checklist':
        return renderReportChecklistBlock(block);
      case 'sourceList':
        return renderReportSourceListBlock(block);
      case 'kpiRow':
        return renderReportKpiRowBlock(block);
      default:
        return buildReportBlockErrorCard(block, `Unsupported report block type \"${block?.type || 'unknown'}\".`);
    }
  } catch (error) {
    return buildReportBlockErrorCard(block, error?.message || 'This block could not be rendered.');
  }
}

function renderReportModule(module) {
  const report = module?.generated?.report || {};
  const section = document.createElement('section');
  section.className = 'generated-section report-generated-section';

  const heading = document.createElement('h2');
  heading.className = 'generated-section-title';
  heading.textContent = typeof report?.title === 'string' && report.title.trim()
    ? report.title.trim()
    : 'Report';
  section.appendChild(heading);

  const content = document.createElement('div');
  content.className = 'report-generated-flow';

  const blocks = Array.isArray(report?.blocks) ? report.blocks : [];
  const reportChartBlocks = getReportChartBlocks(report);
  const chartIndexByBlockId = new Map(
    reportChartBlocks.map((entry, index) => [entry.blockId, index])
  );

  if (blocks.length === 0) {
    if (typeof report?.rawMarkdown === 'string' && report.rawMarkdown.trim()) {
      content.appendChild(buildReportMarkdownBlockCard({
        id: 'report-raw-markdown-fallback',
        type: 'markdown',
        title: '',
        subtitle: ''
      }, report.rawMarkdown));
    } else {
      const empty = document.createElement('section');
      empty.className = 'generated-card report-empty-card';
      const text = document.createElement('p');
      text.className = 'generated-empty';
      text.textContent = 'No report blocks generated yet.';
      empty.appendChild(text);
      content.appendChild(empty);
    }

    section.appendChild(content);
    return section;
  }

  blocks.forEach((block, blockIndex) => {
    content.appendChild(renderReportBlock(module, block, {
      blockIndex,
      chartIndexByBlockId
    }));
  });

  section.appendChild(content);
  return section;
}

function renderEducationModule(module) {
  const education = module?.generated?.education || {};

  const section = document.createElement('section');
  section.className = 'generated-section education-generated-section';

  const heading = document.createElement('h2');
  heading.className = 'generated-section-title';
  heading.textContent = 'Education';

  const grid = document.createElement('div');
  grid.className = 'generated-grid education-generated-grid';

  grid.appendChild(buildEducationTopicCard(module, education));
  grid.appendChild(buildSummaryCard(module?.generated?.summaryHtml || ''));
  grid.appendChild(buildEducationSectionsCard(education));
  grid.appendChild(buildEducationVisualsCard(module, education));

  const referencesCard = buildEducationReferencesCard(education);
  if (referencesCard) {
    grid.appendChild(referencesCard);
  }

  section.appendChild(heading);
  section.appendChild(grid);
  return section;
}

function buildGeneratedSection(module, {
  showPensionToggle = true,
  readOnly = false,
  onPatchInputs = null,
  assumptionsEditorStatus = null
} = {}) {
  const generated = module.generated || {
    summaryHtml: '',
    assumptions: { columns: [], rows: [] },
    outputs: { columns: [], rows: [] },
    tables: [],
    outputsBucketed: null,
    education: null,
    report: null,
    charts: []
  };

  if (isReportModule(module)) {
    return renderReportModule(module);
  }

  if (isEducationModule(module)) {
    return renderEducationModule(module);
  }

  const section = document.createElement('section');
  section.className = 'generated-section';

  const heading = document.createElement('h2');
  heading.className = 'generated-section-title';
  heading.textContent = 'Generated Content';

  const grid = document.createElement('div');
  grid.className = 'generated-grid';

  grid.appendChild(buildSummaryCard(generated.summaryHtml));
  grid.appendChild(buildAssumptionsTableCard(module, {
    onPatchInputs,
    status: assumptionsEditorStatus,
    readOnly
  }));
  if (isOutputsBucketedPresent(generated.outputsBucketed)) {
    grid.appendChild(buildOutputsBucketedCard(generated.outputsBucketed));
  } else {
    const outputsForDisplay = filterOutputsRowsForPensionToggle(module, generated.outputs);
    grid.appendChild(buildTableCard('Outputs', outputsForDisplay, {
      dataGeneratedCard: 'outputs',
      module,
      tableKind: 'outputs'
    }));
  }
  if (Array.isArray(generated.tables) && generated.tables.length > 0) {
    generated.tables.forEach((table, tableIndex) => {
      const title = typeof table?.title === 'string' && table.title.trim()
        ? table.title
        : `Table ${tableIndex + 1}`;
      grid.appendChild(buildTableCard(title, table));
    });
  }
  grid.appendChild(buildChartsCard(module, generated.charts, { showPensionToggle, readOnly }));

  section.appendChild(heading);
  section.appendChild(grid);

  return section;
}

function replaceGeneratedCard({
  grid,
  selector,
  replacement
}) {
  const existing = grid.querySelector(selector);
  if (existing) {
    existing.replaceWith(replacement);
    return;
  }

  grid.appendChild(replacement);
}

export function patchFocusedGeneratedCards({
  focusedCard,
  module,
  onPatchInputs = null,
  assumptionsEditorStatus = null,
  readOnly = false,
  patchSummary = true,
  patchAssumptions = true,
  patchOutputs = true
}) {
  if (!focusedCard || !module) {
    return;
  }

  const generatedSection = focusedCard.querySelector('.generated-section');
  if (isReportModule(module) || isEducationModule(module)) {
    if (!generatedSection) {
      return;
    }

    generatedSection.replaceWith(buildGeneratedSection(module, {
      onPatchInputs,
      assumptionsEditorStatus,
      readOnly
    }));
    return;
  }

  const grid = generatedSection?.querySelector('.generated-grid');
  if (!generatedSection || !grid) {
    return;
  }

  if (patchSummary) {
    replaceGeneratedCard({
      grid,
      selector: '[data-generated-card="summary"]',
      replacement: buildSummaryCard(module.generated?.summaryHtml || '')
    });
  }

  if (patchAssumptions) {
    replaceGeneratedCard({
      grid,
      selector: '[data-generated-card="assumptions"]',
      replacement: buildAssumptionsTableCard(module, {
        onPatchInputs,
        status: assumptionsEditorStatus,
        readOnly
      })
    });
  }

  if (patchOutputs) {
    const generated = module.generated || {};
    const outputCard = isOutputsBucketedPresent(generated.outputsBucketed)
      ? buildOutputsBucketedCard(generated.outputsBucketed)
      : buildTableCard(
        'Outputs',
        filterOutputsRowsForPensionToggle(module, generated.outputs),
        {
          dataGeneratedCard: 'outputs',
          module,
          tableKind: 'outputs'
        }
      );
    replaceGeneratedCard({
      grid,
      selector: '[data-generated-card="outputs"], [data-generated-card="outputs-bucketed"]',
      replacement: outputCard
    });
  }
}

export function getUiElements() {
  return {
    app: document.getElementById('app'),
    animLayer: document.getElementById('animLayer'),
    toastHost: document.getElementById('toastHost'),
    loadSessionInput: document.getElementById('loadSessionInput'),
    devPanel: document.getElementById('devPanel'),
    devPayloadInput: document.getElementById('devPayloadInput'),
    devExampleSelect: document.getElementById('devExampleSelect'),
    devApplyBtn: document.getElementById('devApplyBtn'),
    devCreateApplyBtn: document.getElementById('devCreateApplyBtn'),
    devLoadExampleBtn: document.getElementById('devLoadExampleBtn'),
    devClearBtn: document.getElementById('devClearBtn'),
    devCloseBtn: document.getElementById('devCloseBtn'),
    clientNameInput: document.getElementById('clientNameInput'),
    greetingHeadline: document.getElementById('greetingHeadline'),
    greetingLayer: document.getElementById('greetingLayer'),
    focusLayer: document.getElementById('focusLayer'),
    overviewLayer: document.getElementById('overviewLayer'),
    swipeStage: document.getElementById('swipeStage'),
    overviewViewport: document.getElementById('overviewViewport'),
    overviewZoomWrap: document.getElementById('overviewZoomWrap'),
    overviewGrid: document.getElementById('overviewGrid'),
    playbookSelect: document.getElementById('playbookSelect'),
    mobilePlaybookSelect: document.getElementById('mobilePlaybookSelect'),
    mobilePlaybookLabel: document.getElementById('mobilePlaybookLabel'),
    mobileHeaderMoreButton: document.getElementById('mobileHeaderMoreBtn'),
    mobileActionBar: document.getElementById('mobileActionBar'),
    mobileActionNewCallButton: document.getElementById('mobileActionNewCallBtn'),
    mobileActionNewModuleButton: document.getElementById('mobileActionNewModuleBtn'),
    mobileActionZoomButton: document.getElementById('mobileActionZoomBtn'),
    mobileActionZoomLabel: document.getElementById('mobileActionZoomLabel'),
    mobileActionMoreButton: document.getElementById('mobileActionMoreBtn'),
    mobileOverflowSheet: document.getElementById('mobileOverflowSheet'),
    mobileOverflowBackdrop: document.getElementById('mobileOverflowBackdrop'),
    mobileOverflowPanel: document.getElementById('mobileOverflowPanel'),
    mobileOverflowPublishButton: document.getElementById('mobileOverflowPublishBtn'),
    mobileOverflowLoadButton: document.getElementById('mobileOverflowLoadBtn'),
    mobileOverflowResetButton: document.getElementById('mobileOverflowResetBtn'),
    publishSessionButton: document.getElementById('publishSessionBtn'),
    publishModal: document.getElementById('publishModal'),
    publishCloseButton: document.getElementById('publishCloseBtn'),
    publishGenerateButton: document.getElementById('publishGenerateBtn'),
    publishCopyPinButton: document.getElementById('publishCopyPinBtn'),
    publishCopyLinkButton: document.getElementById('publishCopyLinkBtn'),
    publishRevokeButton: document.getElementById('publishRevokeBtn'),
    publishError: document.getElementById('publishError'),
    publishPinInput: document.getElementById('publishPinInput'),
    publishPinHelp: document.getElementById('publishPinHelp'),
    publishPinValue: document.getElementById('publishPinValue'),
    publishLinkValue: document.getElementById('publishLinkValue'),
    publishResult: document.getElementById('publishResult'),
    newCallButton: document.getElementById('newCallBtn'),
    loadSessionButton: document.getElementById('loadSessionBtn'),
    sessionStatus: document.getElementById('sessionStatus'),
    zoomButton: document.getElementById('zoomToggleBtn'),
    newModuleButton: document.getElementById('newModuleBtn'),
    resetButton: document.getElementById('resetBtn'),
    prevArrowButton: document.getElementById('navPrevBtn'),
    nextArrowButton: document.getElementById('navNextBtn')
  };
}

export function renderGreeting(ui, clientName) {
  if (ui.greetingHeadline) {
    ui.greetingHeadline.textContent = `Hello ${clientName || 'Client'}!`;
  }

  if (ui.clientNameInput && ui.clientNameInput.value !== (clientName || '')) {
    ui.clientNameInput.value = clientName || '';
  }
}

export function buildFocusedPane({
  module,
  moduleNumber,
  onTitleInput,
  onNotesInput,
  onPatchInputs = null,
  assumptionsEditorStatus = null,
  readOnly = false,
  showPensionToggle = true,
  cardId = 'focusCard'
}) {
  const pane = document.createElement('div');
  pane.className = 'focused-pane swipe-pane-content';

  const card = document.createElement('article');
  if (typeof cardId === 'string' && cardId.trim()) {
    card.id = cardId.trim();
  }
  card.className = 'module-card focused-module-card';
  card.dataset.moduleId = module.id;

  const meta = document.createElement('div');
  meta.className = 'module-meta';
  meta.textContent = `Module ${moduleNumber}`;

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'module-title-input';
  titleInput.placeholder = 'Untitled Module';
  titleInput.value = module.title || '';
  titleInput.autocomplete = 'off';
  titleInput.readOnly = readOnly;

  const notesInput = document.createElement('textarea');
  notesInput.className = 'module-notes-input';
  notesInput.placeholder = 'Type notes for this module...';
  notesInput.value = module.notes || '';
  notesInput.readOnly = readOnly;

  if (!readOnly) {
    titleInput.addEventListener('input', (event) => {
      onTitleInput(module.id, event.target.value);
    });

    notesInput.addEventListener('input', (event) => {
      onNotesInput(module.id, event.target.value);
    });
  }

  card.appendChild(meta);
  card.appendChild(titleInput);
  card.appendChild(notesInput);
  card.appendChild(buildGeneratedSection(module, {
    showPensionToggle,
    readOnly,
    onPatchInputs,
    assumptionsEditorStatus
  }));
  pane.appendChild(card);

  return pane;
}

export function renderOverview({
  ui,
  modules,
  activeModuleId,
  layout,
  viewportWidth,
  viewportHeight,
  selectedModuleIds = [],
  onCardClick,
  onSelectionAction = null
}) {
  const selectedSet = new Set(
    Array.isArray(selectedModuleIds)
      ? selectedModuleIds.filter((value) => typeof value === 'string' && value)
      : []
  );
  const selectedOrderById = new Map();
  (Array.isArray(selectedModuleIds) ? selectedModuleIds : []).forEach((moduleId, index) => {
    if (!selectedOrderById.has(moduleId)) {
      selectedOrderById.set(moduleId, index + 1);
    }
  });

  let actionHost = ui.overviewLayer.querySelector('[data-overview-selection-host]');
  if (!actionHost) {
    actionHost = document.createElement('div');
    actionHost.className = 'overview-selection-host';
    actionHost.dataset.overviewSelectionHost = 'true';
    ui.overviewLayer.appendChild(actionHost);
  }
  actionHost.innerHTML = '';
  ui.overviewLayer.classList.toggle('has-selection-bar', selectedSet.size > 0);

  if (selectedSet.size > 0) {
    const bar = document.createElement('div');
    bar.className = 'overview-selection-bar';

    const meta = document.createElement('div');
    meta.className = 'overview-selection-meta';

    const label = document.createElement('span');
    label.className = 'overview-selection-label';
    label.textContent = 'Selected';
    meta.appendChild(label);

    const countPill = document.createElement('span');
    countPill.className = 'overview-selection-pill';
    countPill.textContent = String(selectedSet.size);
    meta.appendChild(countPill);

    bar.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'overview-selection-actions';

    const compareButton = document.createElement('button');
    compareButton.type = 'button';
    compareButton.className = 'ui-button overview-selection-btn is-primary';
    compareButton.textContent = 'Compare';
    const canCompare = selectedSet.size === 2;
    compareButton.disabled = !canCompare;
    compareButton.addEventListener('click', () => {
      if (!canCompare) {
        return;
      }
      if (typeof onSelectionAction === 'function') {
        onSelectionAction('compare-selected');
      }
    });
    actions.appendChild(compareButton);

    if (!canCompare) {
      const helper = document.createElement('span');
      helper.className = 'overview-selection-helper';
      helper.textContent = 'Select exactly 2 to compare';
      actions.appendChild(helper);
    }

    if (selectedSet.size > 2) {
      const keepRecentButton = document.createElement('button');
      keepRecentButton.type = 'button';
      keepRecentButton.className = 'ui-button overview-selection-btn';
      keepRecentButton.textContent = 'Keep last 2';
      keepRecentButton.addEventListener('click', () => {
        if (typeof onSelectionAction === 'function') {
          onSelectionAction('keep-last-two');
        }
      });
      actions.appendChild(keepRecentButton);
    }

    const deselectButton = document.createElement('button');
    deselectButton.type = 'button';
    deselectButton.className = 'ui-button overview-selection-btn';
    deselectButton.textContent = 'Deselect all';
    deselectButton.addEventListener('click', () => {
      if (typeof onSelectionAction === 'function') {
        onSelectionAction('deselect-all');
      }
    });
    actions.appendChild(deselectButton);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'ui-button overview-selection-btn is-destructive';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => {
      if (typeof onSelectionAction === 'function') {
        onSelectionAction('delete-selected');
      }
    });
    actions.appendChild(deleteButton);

    bar.appendChild(actions);
    actionHost.appendChild(bar);
  }

  ui.overviewGrid.innerHTML = '';

  modules.forEach((module, index) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'module-card overview-card';
    if (module.id === activeModuleId) {
      card.classList.add('is-active');
    }

    card.dataset.moduleId = module.id;

    if (selectedSet.has(module.id)) {
      card.classList.add('is-selected');
      const badge = document.createElement('span');
      badge.className = 'overview-selection-badge';
      badge.textContent = String(selectedOrderById.get(module.id) || 1);
      badge.setAttribute('aria-label', `Selection order ${badge.textContent}`);
      card.appendChild(badge);
    }

    const label = document.createElement('div');
    label.className = 'overview-meta';
    label.textContent = `#${index + 1} • ${formatLocalTime(module.createdAt)}`;

    const title = document.createElement('h3');
    title.className = 'overview-title';
    title.textContent = module.title?.trim() ? module.title : 'Untitled Module';

    const snippet = document.createElement('p');
    snippet.className = 'overview-snippet';
    snippet.textContent = makeOverviewSnippet(module);

    card.appendChild(label);
    card.appendChild(title);
    card.appendChild(snippet);

    const position = computeGridPosition(index, modules.length, layout.cols);
    card.style.gridColumnStart = String(position.columnStart);
    card.style.gridRowStart = String(position.rowStart);

    card.addEventListener('click', (event) => onCardClick(module.id, card, event));

    ui.overviewGrid.appendChild(card);
  });

  applyOverviewLayout(ui.overviewZoomWrap, ui.overviewGrid, layout, viewportWidth, viewportHeight);
}

export function setMode(ui, mode) {
  const greeting = ui.greetingLayer;
  const focus = ui.focusLayer;
  const overview = ui.overviewLayer;

  focus.classList.remove('is-transitioning-in', 'is-transitioning-out');
  overview.classList.remove('is-transitioning-in', 'is-transitioning-out');
  focus.style.opacity = '';
  focus.style.visibility = '';
  focus.style.pointerEvents = '';
  overview.style.opacity = '';
  overview.style.filter = '';
  overview.style.pointerEvents = '';

  focus.classList.remove('layer-active');
  overview.classList.remove('layer-active');

  if (mode === 'greeting') {
    showLayer(greeting);
    hideLayer(focus);
    hideLayer(overview);
    return;
  }

  hideLayer(greeting);

  if (mode === 'overview') {
    hideLayer(focus);
    showLayer(overview);
    overview.classList.add('layer-active');
    return;
  }

  showLayer(focus);
  hideLayer(overview);
  focus.classList.add('layer-active');
}

export function updateControls(ui, {
  mode,
  moduleCount,
  hasPrevious,
  hasNext = false,
  readOnly = false
}) {
  const hasModules = moduleCount > 0;

  if (ui.zoomButton) {
    ui.zoomButton.disabled = !hasModules;
    ui.zoomButton.textContent = mode === 'overview' ? 'Zoom In' : 'Zoom Out';
  }

  if (ui.newModuleButton) {
    ui.newModuleButton.disabled = readOnly || mode === 'compare';
  }

  if (ui.prevArrowButton) {
    ui.prevArrowButton.classList.toggle('is-hidden', mode !== 'focused');
    ui.prevArrowButton.disabled = !hasPrevious;
  }

  if (ui.nextArrowButton) {
    ui.nextArrowButton.classList.toggle('is-hidden', mode !== 'focused');
    ui.nextArrowButton.disabled = readOnly ? !hasNext : !hasModules;
    const nextLabel = (readOnly || hasNext) ? 'Next module' : 'Create new module';
    ui.nextArrowButton.title = nextLabel;
    ui.nextArrowButton.setAttribute('aria-label', nextLabel);
  }
}

export function updateSessionStatus(ui, isDirty) {
  if (!ui.sessionStatus) {
    return;
  }

  ui.sessionStatus.textContent = isDirty ? 'Unsaved changes' : 'Saved locally';
  ui.sessionStatus.classList.toggle('is-dirty', Boolean(isDirty));
}

export function getFocusedCardElement(ui) {
  return ui.swipeStage.querySelector('#focusCard') || ui.swipeStage.querySelector('.focused-module-card');
}

export function getOverviewCardElement(ui, moduleId) {
  return ui.overviewGrid.querySelector(`.overview-card[data-module-id="${moduleId}"]`);
}

export function ensureLayerVisibleForMeasure(layer) {
  layer.classList.remove('is-hidden');
  layer.setAttribute('aria-hidden', 'false');
}
