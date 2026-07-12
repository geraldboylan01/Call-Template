import { computeGridPosition, applyOverviewLayout } from './layout.js';
import { renderSvgDiagram, serializeSvg } from './education_svg.js';
import { getReportChartBlocks, isReportModule } from './report.js';
import { HFCS_NET_WORTH_DATA } from './data/hfcs2023.js';
import {
  computePensionProjection,
  getDefaultPensionScenarioId,
  getPensionScenarioCases
} from './pension_math.js';
import { computeCollegeFundingProjection } from './college_funding_math.js';
import {
  computeNetRetirementProjection,
  getDefaultNetRetirementScenarioId,
  getNetRetirementScenarioCases
} from './net_retirement_math.js';
import { computeHousePurchaseProjection } from './house_purchase/engine.js';
import { computeWorkingLiquidityReserve } from './liquidity_reserve.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const OVERVIEW_CHART_COLORS = ['#74d6ff', '#7bffbf', '#ffd166', '#ff9fb3'];
const OVERVIEW_CHART_PREVIEW_MODE = {
  width: 272,
  height: 96,
  line: {
    insetX: 10,
    insetTop: 10,
    insetBottom: 10,
    maxDatasets: 2,
    maxPoints: 24,
    rangePaddingRatio: 0.14
  },
  bar: {
    insetX: 10,
    insetTop: 10,
    insetBottom: 8,
    maxDatasets: 1,
    maxPoints: 10,
    rangePaddingRatio: 0.06,
    minBarWidth: 6
  }
};
const HFCS_AGE_BAND_META = Object.freeze([
  {
    key: 'under35',
    maxAgeExclusive: 35,
    benchmarkLabel: 'Age under 35 median',
    householdLabel: 'households under 35'
  },
  {
    key: '35to44',
    maxAgeExclusive: 45,
    benchmarkLabel: 'Age 35-44 median',
    householdLabel: 'households aged 35-44'
  },
  {
    key: '45to54',
    maxAgeExclusive: 55,
    benchmarkLabel: 'Age 45-54 median',
    householdLabel: 'households aged 45-54'
  },
  {
    key: '55to64',
    maxAgeExclusive: 65,
    benchmarkLabel: 'Age 55-64 median',
    householdLabel: 'households aged 55-64'
  },
  {
    key: '65plus',
    maxAgeExclusive: Infinity,
    benchmarkLabel: 'Age 65+ median',
    householdLabel: 'households aged 65+'
  }
]);
const HFCS_DECILE_BANDS = Object.freeze([
  { upperKey: 'd1Upper', lowerBoundPercent: 0, upperBoundPercent: 10 },
  { upperKey: 'd2Upper', lowerBoundPercent: 10, upperBoundPercent: 20 },
  { upperKey: 'd3Upper', lowerBoundPercent: 20, upperBoundPercent: 30 },
  { upperKey: 'd4Upper', lowerBoundPercent: 30, upperBoundPercent: 40 },
  { upperKey: 'd5Upper', lowerBoundPercent: 40, upperBoundPercent: 50 },
  { upperKey: 'd6Upper', lowerBoundPercent: 50, upperBoundPercent: 60 },
  { upperKey: 'd7Upper', lowerBoundPercent: 60, upperBoundPercent: 70 },
  { upperKey: 'd8Upper', lowerBoundPercent: 70, upperBoundPercent: 80 },
  { upperKey: 'd9Upper', lowerBoundPercent: 80, upperBoundPercent: 90 }
]);
const PBS_ASSET_SECTION_KEYS = ['lifestyle', 'liquidity', 'longevity', 'legacy'];
const PBS_CURRENT_SCENARIO_ID = 'current';
const PBS_SCENARIO_CHARTS_UPDATED_EVENT = 'callcanvas:pbs-scenario-charts-updated';
const PBS_NET_WORTH_TOKENS = new Set(['networth', 'netassets', 'netwealth']);
const PBS_BALANCE_CHANGE_WORDS = /\b(change|difference|increase|decrease|movement|delta|gap|variance)\b/i;
const activePbsScenarioChartsByModuleId = new Map();
const PBS_BUCKET_DEFINITIONS = Object.freeze({
  lifestyle: 'Assets that support day-to-day living, usually not treated as spendable reserves.',
  liquidity: 'Cash or near-cash reserves for short-term spending needs and shocks.',
  longevity: 'Pensions and long-term investments intended to fund later-life income.',
  legacy: 'Illiquid, concentrated, optional, or higher-risk assets such as property, business interests, or single holdings.'
});
const CLIENT_GUIDE_COPY = Object.freeze({
  pbs: 'Start with net worth, then read the buckets as jobs for your money: spending reserves, retirement funding, concentrated assets, and debts.',
  liquidity: 'Start with current cash versus the target reserve, then decide whether the priority is building the emergency fund or assigning surplus cash to a job.',
  pension: 'Start with the required pension pot and chart, then use the assumptions table to see which facts drive the retirement projection.',
  netRetirement: 'Start with the annual net shortfall, then read the required net investment fund as an after-tax funding target.',
  collegeFunding: 'Start with the funding range, then compare today’s-money and future nominal costs before deciding what to ring-fence.',
  housePurchase: 'Start with the route-to-home summary, then check the four readiness gates before exploring what-if changes.',
  mortgage: 'Start with repayment, term, and interest; the chart and outputs show how overpayments change the path.',
  loan: 'Start with payoff timing and interest cost; the assumptions show the balance, rate, payment structure, and overpayment being tested.',
  education: 'Start with the plain-English frame and hero visual, then use the steps and references for detail.',
  report: 'Start with the executive picture, then read supporting visuals, scenarios, and verification points.',
  protection: 'Start with the support buffer and employer-check items; these figures are planning anchors, not insurer quotes.'
});
const RETIREMENT_EURO_FORMATTER = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});
const DISPLAY_EURO_FORMATTER = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});
const DISPLAY_EURO_DECIMAL_FORMATTER = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
let pbsInfoIdCounter = 0;
let activePbsInfoButton = null;
let pbsInfoDismissHandlersBound = false;
let activePbsExplanationModal = null;

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

const AUTO_PENSION_SUMMARY_PATTERNS = [
  /<span\b[^>]*\bdata-auto=(["'])readiness\1[^>]*>[\s\S]*?<\/span>/gi,
  /<span\b[^>]*\bdata-auto=(["'])sft\1[^>]*>[\s\S]*?<\/span>/gi,
  /<span\b[^>]*\bdata-auto=(["'])personal-cap\1[^>]*>[\s\S]*?<\/span>/gi
];

function escapeSummaryText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function removeAutoPensionSummarySpans(summaryHtml) {
  return AUTO_PENSION_SUMMARY_PATTERNS
    .reduce((html, pattern) => html.replace(pattern, ''), String(summaryHtml ?? ''))
    .replace(/\s+<\/p>/gi, '</p>')
    .trim();
}

function appendAutoPensionSummarySentence(summaryHtml, sentence, autoKey) {
  const cleaned = String(summaryHtml ?? '').trim();
  if (!sentence) {
    return cleaned;
  }
  const autoSpan = `<span data-auto="${escapeSummaryText(autoKey)}">${escapeSummaryText(sentence)}</span>`;
  const firstParagraphCloseMatch = /<\/p>/i.exec(cleaned);
  if (!cleaned) {
    return `<p>${autoSpan}</p>`;
  }
  if (!firstParagraphCloseMatch || typeof firstParagraphCloseMatch.index !== 'number') {
    return `${cleaned}<p>${autoSpan}</p>`;
  }
  const closeTagIndex = firstParagraphCloseMatch.index;
  return `${cleaned.slice(0, closeTagIndex)} ${autoSpan}${cleaned.slice(closeTagIndex)}`;
}

function injectAutoPensionSummaryDisplay(summaryHtml, {
  readinessSentence = '',
  sftSentence = '',
  personalCapSentence = ''
} = {}) {
  let next = removeAutoPensionSummarySpans(summaryHtml);
  next = appendAutoPensionSummarySentence(next, readinessSentence, 'readiness');
  next = appendAutoPensionSummarySentence(next, sftSentence, 'sft');
  next = appendAutoPensionSummarySentence(next, personalCapSentence, 'personal-cap');
  return next;
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMoneyToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9€£$]+/g, '');
}

function normalizeDisplayCurrencySymbol(value, fallback = '€') {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return fallback;
  }

  const upper = raw.toUpperCase();
  if (upper === 'EUR' || upper === 'EURO' || upper === 'EUROS') {
    return '€';
  }
  if (upper === 'GBP' || upper === 'POUND' || upper === 'POUNDS') {
    return '£';
  }
  if (upper === 'USD' || upper === 'DOLLAR' || upper === 'DOLLARS') {
    return '$';
  }

  return raw;
}

function normalizeCurrencyLabelText(value) {
  return String(value ?? '')
    .replace(/\bEUR\b|\bEUROS?\b/gi, '€')
    .replace(/\bGBP\b|\bPOUNDS?\b/gi, '£')
    .replace(/\bUSD\b|\bDOLLARS?\b/gi, '$');
}

function textHasCurrencyMarker(value) {
  return /[€£$]|\b(?:eur|euro|euros|gbp|usd)\b/i.test(String(value ?? ''));
}

function isNumericLikeText(value) {
  return /^-?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*[km]?$/i.test(String(value ?? '').trim());
}

function parseDisplayNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const match = String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .match(/^(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?([km])?$/i);
  if (!match) {
    return null;
  }

  const [, sign, whole, decimals = '', suffix = ''] = match;
  let parsed = Number(`${sign}${whole.replace(/,/g, '')}${decimals ? `.${decimals}` : ''}`);
  if (suffix.toLowerCase() === 'k') {
    parsed *= 1000;
  } else if (suffix.toLowerCase() === 'm') {
    parsed *= 1000000;
  }

  return Number.isFinite(parsed) ? parsed : null;
}

function formatDisplayCurrency(value, currencySymbol = '€') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return '';
  }

  const symbol = normalizeDisplayCurrencySymbol(currencySymbol);
  const formatted = Number.isInteger(amount)
    ? DISPLAY_EURO_FORMATTER.format(amount)
    : DISPLAY_EURO_DECIMAL_FORMATTER.format(amount);
  return symbol === '€' ? formatted : formatted.replace('€', symbol);
}

function formatCurrencyMarkedText(value) {
  const raw = String(value ?? '');
  const amountPattern = '(-?\\d{1,3}(?:,\\d{3})+|-?\\d+)(?:\\.\\d+)?(?:\\s*[km])?';
  const markerPattern = '(€|£|\\$|\\bEUR|\\bEUROS?\\b|\\bGBP\\b|\\bUSD\\b)';
  const regex = new RegExp(`${markerPattern}\\s*(${amountPattern})`, 'gi');

  return normalizeCurrencyLabelText(raw.replace(regex, (match, marker, amountText) => {
    const parsed = parseDisplayNumber(amountText);
    if (parsed === null) {
      return match;
    }

    return formatDisplayCurrency(parsed, normalizeDisplayCurrencySymbol(marker));
  }));
}

function isClearlyNonMoneyLabel(token) {
  if (!token) {
    return false;
  }

  const exactNonMoneyTokens = new Set([
    'child',
    'children',
    'dependant',
    'dependants',
    'dependent',
    'dependents',
    'people',
    'person',
    'count',
    'quantity',
    'scenario'
  ]);

  return exactNonMoneyTokens.has(token)
    || token.startsWith('numberof')
    || token.endsWith('count')
    || token.includes('age')
    || token.includes('year')
    || token.includes('duration')
    || token.includes('numberofchildren')
    || token.includes('childrenage')
    || token.includes('inflation')
    || token.includes('growth')
    || token.includes('rate')
    || token.includes('percent')
    || token.includes('percentage')
    || token.includes('term')
    || token.includes('mode')
    || token.includes('scenario');
}

function isGenericValueColumnToken(token) {
  return token === 'value'
    || token === 'input'
    || token === 'inputused'
    || token === 'used';
}

function hasMoneyKeyword(token) {
  return token.includes('€')
    || token.includes('eur')
    || token.includes('euro')
    || token.includes('amount')
    || token.includes('balance')
    || token.includes('value')
    || token.includes('salary')
    || token.includes('income')
    || token.includes('cost')
    || token.includes('fund')
    || token.includes('funding')
    || token.includes('support')
    || token.includes('asset')
    || token.includes('liability')
    || token.includes('worth')
    || token.includes('cash')
    || token.includes('savings')
    || token.includes('premium')
    || token.includes('cover')
    || token.includes('reserve')
    || token.includes('payment')
    || token.includes('repayment')
    || token.includes('overpayment')
    || token.includes('expenditure')
    || token.includes('withdrawal')
    || token.includes('pot')
    || token.includes('pension')
    || token.includes('debt')
    || token.includes('nominal')
    || token.includes('todaysterms');
}

function isMoneyLabelToken(token) {
  if (!token) {
    return false;
  }

  return hasMoneyKeyword(token);
}

function isYearLikeNumberText(value) {
  const normalized = String(value ?? '').trim().replace(/,/g, '');
  if (!/^\d{4}$/.test(normalized)) {
    return false;
  }

  const year = Number(normalized);
  return year >= 1900 && year <= 2099;
}

function isCurrencyTableContext({
  cardTitle = '',
  rowLabel = '',
  columnLabel = '',
  isRowLabelCell = false
} = {}) {
  const columnToken = normalizeMoneyToken(columnLabel);
  const rowToken = normalizeMoneyToken(rowLabel);
  const titleToken = normalizeMoneyToken(cardTitle);

  if (!isGenericValueColumnToken(columnToken) && isMoneyLabelToken(columnToken)) {
    return true;
  }

  if (isRowLabelCell) {
    return false;
  }

  if (isMoneyLabelToken(rowToken)) {
    return true;
  }

  if (titleToken.includes('annualfundingprofile')
    && !isRowLabelCell
    && !columnToken.includes('year')
    && !columnToken.includes('attending')) {
    return true;
  }

  return (titleToken.includes('outputs') || titleToken.includes('scenario'))
    && isMoneyLabelToken(rowToken);
}

function formatCurrencyInText(value) {
  const raw = String(value ?? '');
  if (!raw.trim()) {
    return raw;
  }

  if (textHasCurrencyMarker(raw)) {
    return formatCurrencyMarkedText(raw);
  }

  if (isNumericLikeText(raw)) {
    const parsed = parseDisplayNumber(raw);
    return parsed === null ? raw : formatDisplayCurrency(parsed);
  }

  return raw.replace(/(^|[^\w€£$])(-?\d{4,}(?:\.\d+)?(?:\s*[km])?|-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s*[km])?|-?\d+(?:\.\d+)?\s*[km])(?![\w%])/gi, (match, prefix, numericText) => {
    if (isYearLikeNumberText(numericText)) {
      return match;
    }

    const parsed = parseDisplayNumber(numericText);
    return parsed === null ? match : `${prefix}${formatDisplayCurrency(parsed)}`;
  });
}

function formatGeneratedTableCell(value, {
  cardTitle = '',
  rowLabel = '',
  columnLabel = '',
  isRowLabelCell = false
} = {}) {
  if (!isCurrencyTableContext({ cardTitle, rowLabel, columnLabel, isRowLabelCell })) {
    return String(value ?? '');
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatDisplayCurrency(value);
  }

  return formatCurrencyInText(value);
}

function formatMetricDisplayValue(label, value) {
  const raw = String(value ?? '');
  if (!raw.trim()) {
    return '--';
  }

  if (textHasCurrencyMarker(raw)) {
    return formatCurrencyMarkedText(raw) || raw;
  }

  const labelToken = normalizeMoneyToken(label);
  const isMoneyMetric = isMoneyLabelToken(labelToken);
  const isClearlyNonMoneyMetric = isClearlyNonMoneyLabel(labelToken);
  const parsed = parseDisplayNumber(raw);
  if (
    parsed !== null
    && (
      isMoneyMetric
      || (Math.abs(parsed) >= 10000 && !isClearlyNonMoneyMetric)
    )
  ) {
    return formatDisplayCurrency(parsed);
  }

  if (isMoneyMetric) {
    return formatCurrencyInText(raw);
  }

  return raw || '--';
}

function getTimelineSourceEvents(svgSpec) {
  if (Array.isArray(svgSpec?.events)) {
    return svgSpec.events;
  }

  return Array.isArray(svgSpec?.nodes) ? svgSpec.nodes : [];
}

function hasExplicitTimelineLanes(svgSpec) {
  if (!Array.isArray(svgSpec?.lanes)) {
    return false;
  }

  return svgSpec.lanes.some((lane) => {
    if (typeof lane === 'string') {
      return lane.trim();
    }

    if (isPlainObject(lane)) {
      return toTrimmedString(lane.id) || toTrimmedString(lane.title);
    }

    return false;
  });
}

function normalizeReportTimelineContent(svgSpec) {
  if (!isPlainObject(svgSpec) || toTrimmedString(svgSpec.kind).toLowerCase() !== 'timeline') {
    return {
      renderMode: 'svg',
      events: [],
      errorMessage: ''
    };
  }

  const hasEventArray = Array.isArray(svgSpec.events) || Array.isArray(svgSpec.nodes);
  if (!hasEventArray) {
    return {
      renderMode: 'svg',
      events: [],
      errorMessage: ''
    };
  }

  const rawEvents = getTimelineSourceEvents(svgSpec);
  const laneIds = new Set(
    rawEvents
      .map((event) => (isPlainObject(event) ? toTrimmedString(event.lane) : ''))
      .filter(Boolean)
  );

  if (hasExplicitTimelineLanes(svgSpec) || laneIds.size > 1) {
    return {
      renderMode: 'svg',
      events: [],
      errorMessage: ''
    };
  }

  if (rawEvents.length === 0) {
    return {
      renderMode: 'html',
      events: [],
      errorMessage: 'Timeline block requires a non-empty events array.'
    };
  }

  const events = [];
  for (let index = 0; index < rawEvents.length; index += 1) {
    const event = rawEvents[index];
    if (!isPlainObject(event)) {
      return {
        renderMode: 'html',
        events: [],
        errorMessage: `timeline.events[${index}] must be an object.`
      };
    }

    const title = toTrimmedString(event.title)
      || toTrimmedString(event.label)
      || toTrimmedString(event.name);
    if (!title) {
      return {
        renderMode: 'html',
        events: [],
        errorMessage: `timeline.events[${index}] requires a title or label.`
      };
    }

    const body = toTrimmedString(event.body)
      || toTrimmedString(event.description)
      || toTrimmedString(event.detail)
      || toTrimmedString(event.summary)
      || toTrimmedString(event.note);
    const dateLabel = toTrimmedString(event.dateLabel)
      || toTrimmedString(event.when)
      || toTrimmedString(event.date);
    const orderValue = Number(event.order);
    const parsedDate = Date.parse(dateLabel);

    let sortOrder = index;
    if (Number.isFinite(orderValue)) {
      sortOrder = orderValue;
    } else if (Number.isFinite(parsedDate)) {
      sortOrder = parsedDate;
    }

    events.push({
      id: toTrimmedString(event.id) || `timeline-event-${index + 1}`,
      title,
      body,
      dateLabel,
      sortOrder,
      _index: index
    });
  }

  events.sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) {
      return left.sortOrder - right.sortOrder;
    }

    return left._index - right._index;
  });

  return {
    renderMode: 'html',
    events,
    errorMessage: ''
  };
}

function computeReportTimelineLayout(events, availableWidth) {
  const safeEvents = Array.isArray(events) ? events : [];
  const eventCount = safeEvents.length;
  const count = Math.max(eventCount, 1);
  const averageTitleLength = eventCount > 0
    ? safeEvents.reduce((sum, event) => sum + event.title.length, 0) / eventCount
    : 0;
  const averageBodyLength = eventCount > 0
    ? safeEvents.reduce((sum, event) => sum + event.body.length, 0) / eventCount
    : 0;
  const longestBodyLength = eventCount > 0
    ? Math.max(...safeEvents.map((event) => event.body.length))
    : 0;
  const longestDateLength = eventCount > 0
    ? Math.max(...safeEvents.map((event) => event.dateLabel.length))
    : 0;
  const longestTitleLength = eventCount > 0
    ? Math.max(...safeEvents.map((event) => event.title.length))
    : 0;
  const gap = eventCount <= 3 ? 24 : (eventCount === 4 ? 20 : 16);
  const trackInset = eventCount <= 4 ? 18 : 14;
  const density = eventCount <= 3 ? 'spacious' : (eventCount >= 6 ? 'compact' : 'balanced');
  const padding = eventCount <= 3 ? 18 : (eventCount >= 6 ? 15 : 16);
  const minimumCardWidth = Math.max(
    220,
    Math.min(
      eventCount <= 4 ? 360 : 300,
      214
        + (eventCount <= 4 ? 18 : 0)
        + (averageTitleLength > 34 ? 12 : 0)
        + (longestTitleLength > 54 ? 16 : 0)
        + (averageBodyLength > 85 ? 18 : 0)
        + (averageBodyLength > 130 ? 18 : 0)
        + (longestBodyLength > 180 ? 18 : 0)
        + (longestDateLength > 18 ? 10 : 0)
    )
  );
  const measuredWidth = Number.isFinite(availableWidth) && availableWidth > 0
    ? availableWidth
    : 0;
  const usableWidth = Math.max(0, measuredWidth - (trackInset * 2));
  const slotWidth = eventCount > 0
    ? (usableWidth - (Math.max(0, count - 1) * gap)) / count
    : usableWidth;
  const shouldPreferVertical = eventCount >= 6 && (averageBodyLength > 65 || longestBodyLength > 120);
  const mode = eventCount === 1
    ? 'vertical'
    : ((!shouldPreferVertical && slotWidth >= minimumCardWidth) ? 'horizontal' : 'vertical');

  return {
    mode,
    density,
    gap,
    padding,
    trackInset,
    minimumCardWidth,
    slotWidth
  };
}

function applyReportTimelineLayout(shell, events) {
  const measuredWidth = Math.max(
    shell?.clientWidth || 0,
    typeof shell?.getBoundingClientRect === 'function'
      ? Math.round(shell.getBoundingClientRect().width)
      : 0,
    typeof window !== 'undefined'
      ? Math.max(0, Math.round(window.innerWidth * 0.72))
      : 0
  );
  const layout = computeReportTimelineLayout(events, measuredWidth);
  shell.dataset.layout = layout.mode;
  shell.dataset.density = layout.density;
  shell.style.setProperty('--report-timeline-event-count', String(Math.max(events.length, 1)));
  shell.style.setProperty('--report-timeline-gap', `${layout.gap}px`);
  shell.style.setProperty('--report-timeline-card-padding', `${layout.padding}px`);
  shell.style.setProperty('--report-timeline-track-inset', `${layout.trackInset}px`);
}

function observeReportTimelineLayout(shell, events) {
  const updateLayout = () => {
    if (!shell.isConnected) {
      return;
    }

    applyReportTimelineLayout(shell, events);
  };

  requestAnimationFrame(updateLayout);

  if (typeof ResizeObserver === 'undefined') {
    return;
  }

  const observer = new ResizeObserver(() => {
    if (!shell.isConnected) {
      observer.disconnect();
      return;
    }

    updateLayout();
  });

  observer.observe(shell);
}

function buildReportTimelineEvent(event) {
  const item = document.createElement('article');
  item.className = 'report-timeline-event';
  item.dataset.timelineEventId = event.id;

  const card = document.createElement('div');
  card.className = 'report-timeline-event-card';

  if (event.dateLabel) {
    const date = document.createElement('p');
    date.className = 'report-timeline-date';
    date.textContent = event.dateLabel;
    card.appendChild(date);
  }

  const title = document.createElement('h4');
  title.className = 'report-timeline-event-title';
  title.textContent = event.title;
  card.appendChild(title);

  if (event.body) {
    const body = document.createElement('p');
    body.className = 'report-timeline-event-body';
    body.textContent = event.body;
    card.appendChild(body);
  }

  item.appendChild(card);
  return item;
}

function buildReportTimelineContentBlock(block, timeline) {
  const card = buildReportBlockShell(block, 'report-block report-timeline-block');
  appendReportBlockHeader(card, {
    title: block?.title || 'Timeline',
    subtitle: block?.subtitle || ''
  });

  if (timeline.errorMessage) {
    const error = document.createElement('p');
    error.className = 'report-inline-error';
    error.textContent = timeline.errorMessage;
    card.appendChild(error);
    return card;
  }

  const shell = document.createElement('div');
  shell.className = 'report-timeline-shell';
  shell.dataset.layout = 'horizontal';
  shell.dataset.density = 'balanced';

  const items = document.createElement('div');
  items.className = 'report-timeline-items';
  timeline.events.forEach((event) => {
    items.appendChild(buildReportTimelineEvent(event));
  });

  shell.appendChild(items);
  applyReportTimelineLayout(shell, timeline.events);
  card.appendChild(shell);
  observeReportTimelineLayout(shell, timeline.events);
  return card;
}

export function debugResolveReportTimelineLayout(svgSpec, availableWidth) {
  const timeline = normalizeReportTimelineContent(svgSpec);
  return {
    renderMode: timeline.renderMode,
    errorMessage: timeline.errorMessage,
    eventCount: timeline.events.length,
    ...computeReportTimelineLayout(timeline.events, availableWidth)
  };
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

function normalizeOverviewText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateOverviewText(value, maxLength = 80) {
  const text = normalizeOverviewText(value);
  if (!text) {
    return '';
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function uniqueOverviewItems(items, maxItems = 3, maxLength = 88) {
  const seen = new Set();
  const unique = [];

  items.forEach((item) => {
    const normalized = normalizeOverviewText(item);
    if (!normalized) {
      return;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    unique.push(truncateOverviewText(normalized, maxLength));
  });

  return unique.slice(0, maxItems);
}

function splitOverviewSentences(text) {
  return normalizeOverviewText(text)
    .split(/(?:[.!?]\s+|[•·]\s+|\n+)/)
    .map((line) => normalizeOverviewText(line))
    .filter(Boolean);
}

function stripMarkdownSyntax(text) {
  return String(text ?? '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '');
}

function extractMarkdownPreviewLines(markdown, maxItems = 3) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return [];
  }

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const listLines = [];
  const paragraphLines = [];
  let inCodeFence = false;

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence;
      return;
    }

    if (inCodeFence || !trimmed) {
      return;
    }

    const listMatch = /^[-*+]\s+(.*)$/.exec(trimmed) || /^\d+\.\s+(.*)$/.exec(trimmed);
    if (listMatch) {
      listLines.push(listMatch[1]);
      return;
    }

    paragraphLines.push(trimmed);
  });

  if (listLines.length > 0) {
    return uniqueOverviewItems(listLines.map((line) => stripMarkdownSyntax(line)), maxItems);
  }

  return uniqueOverviewItems(
    splitOverviewSentences(stripMarkdownSyntax(paragraphLines.join(' '))),
    maxItems
  );
}

function extractHtmlPreviewLines(rawHtml, maxItems = 3) {
  const safeHtml = sanitizeSummaryHtml(rawHtml || '');
  if (!safeHtml) {
    return [];
  }

  const template = document.createElement('template');
  template.innerHTML = safeHtml;

  const listLines = [...template.content.querySelectorAll('li')]
    .map((item) => item.textContent || '');
  if (listLines.length > 0) {
    return uniqueOverviewItems(listLines, maxItems);
  }

  const blocks = [...template.content.querySelectorAll('p, h1, h2, h3, h4, h5, h6, blockquote')]
    .map((element) => element.textContent || '');
  if (blocks.length > 0) {
    return uniqueOverviewItems(
      blocks.flatMap((line) => splitOverviewSentences(line)),
      maxItems
    );
  }

  return uniqueOverviewItems(
    splitOverviewSentences(template.content.textContent || ''),
    maxItems
  );
}

function createOverviewSvgElement(tagName, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tagName);
  Object.entries(attributes).forEach(([key, value]) => {
    element.setAttribute(key, String(value));
  });
  return element;
}

function buildOverviewLinePath(points) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ');
}

function clampOverviewNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildOverviewSampleIndices(length, maxPoints) {
  const safeLength = Math.max(0, Math.floor(length));
  const safeMaxPoints = Math.max(1, Math.floor(maxPoints));
  if (safeLength <= safeMaxPoints) {
    return Array.from({ length: safeLength }, (_value, index) => index);
  }

  const indexSet = new Set();
  for (let sampleIndex = 0; sampleIndex < safeMaxPoints; sampleIndex += 1) {
    const ratio = safeMaxPoints === 1 ? 0 : sampleIndex / (safeMaxPoints - 1);
    indexSet.add(Math.round(ratio * (safeLength - 1)));
  }

  return [...indexSet].sort((left, right) => left - right);
}

function scoreOverviewPreviewDataset(values) {
  const safeValues = Array.isArray(values) ? values : [];
  if (safeValues.length === 0) {
    return -1;
  }

  const minimum = Math.min(...safeValues);
  const maximum = Math.max(...safeValues);
  const absoluteMax = Math.max(...safeValues.map((value) => Math.abs(value)), 0);
  const nonZeroCount = safeValues.filter((value) => Math.abs(value) > Number.EPSILON).length;

  return ((maximum - minimum) * 3) + absoluteMax + nonZeroCount;
}

function selectOverviewPreviewDatasets(chart) {
  const chartType = chart?.type === 'bar' ? 'bar' : 'line';
  const mode = OVERVIEW_CHART_PREVIEW_MODE[chartType];
  const sourceLabels = Array.isArray(chart?.labels) ? chart.labels.map((label) => String(label ?? '')) : [];
  const sourceDatasets = Array.isArray(chart?.datasets) ? chart.datasets : [];
  const pointCount = Math.max(
    sourceLabels.length,
    ...sourceDatasets.map((dataset) => (Array.isArray(dataset?.data) ? dataset.data.length : 0)),
    0
  );

  if (pointCount === 0) {
    return {
      chartType,
      labels: [],
      datasets: []
    };
  }

  const sampleIndices = buildOverviewSampleIndices(pointCount, mode.maxPoints);
  const candidateDatasets = sourceDatasets
    .map((dataset, datasetIndex) => {
      const values = Array.from({ length: pointCount }, (_value, valueIndex) => (
        clampOverviewNumber(Array.isArray(dataset?.data) ? dataset.data[valueIndex] : 0, 0)
      ));

      return {
        datasetIndex,
        label: typeof dataset?.label === 'string' ? dataset.label.trim() : '',
        score: scoreOverviewPreviewDataset(values),
        values
      };
    })
    .filter((dataset) => dataset.values.length > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.datasetIndex - right.datasetIndex;
    })
    .slice(0, mode.maxDatasets)
    .sort((left, right) => left.datasetIndex - right.datasetIndex)
    .map((dataset, previewIndex) => ({
      ...dataset,
      color: OVERVIEW_CHART_COLORS[previewIndex % OVERVIEW_CHART_COLORS.length],
      values: sampleIndices.map((sampleIndex) => dataset.values[sampleIndex] ?? 0)
    }));

  return {
    chartType,
    labels: sampleIndices.map((sampleIndex) => sourceLabels[sampleIndex] ?? ''),
    datasets: candidateDatasets
  };
}

function computeOverviewValueRange(values, {
  includeZero = false,
  paddingRatio = 0.1
} = {}) {
  const safeValues = Array.isArray(values)
    ? values.filter((value) => Number.isFinite(value))
    : [];

  if (safeValues.length === 0) {
    return {
      minValue: 0,
      maxValue: 1
    };
  }

  let minValue = Math.min(...safeValues);
  let maxValue = Math.max(...safeValues);

  if (includeZero) {
    minValue = Math.min(minValue, 0);
    maxValue = Math.max(maxValue, 0);
  }

  const span = maxValue - minValue;
  if (span < Number.EPSILON) {
    const base = Math.max(Math.abs(maxValue), 1);
    const pad = base * 0.18;
    return {
      minValue: minValue - pad,
      maxValue: maxValue + pad
    };
  }

  const pad = span * Math.max(0, paddingRatio);
  return {
    minValue: minValue - pad,
    maxValue: maxValue + pad
  };
}

function mapOverviewValueToY(value, minValue, maxValue, plotTop, plotBottom) {
  const span = Math.max(maxValue - minValue, Number.EPSILON);
  return plotBottom - (((value - minValue) / span) * (plotBottom - plotTop));
}

function appendOverviewChartGuide(svg, y, {
  width,
  insetX
} = {}) {
  const guide = createOverviewSvgElement('line', {
    x1: insetX,
    y1: y,
    x2: width - insetX,
    y2: y,
    class: 'overview-preview-chart-baseline'
  });
  guide.setAttribute('opacity', '0.34');
  svg.appendChild(guide);
}

function buildOverviewChartSvgShell() {
  return createOverviewSvgElement('svg', {
    class: 'overview-preview-chart-svg',
    viewBox: `0 0 ${OVERVIEW_CHART_PREVIEW_MODE.width} ${OVERVIEW_CHART_PREVIEW_MODE.height}`,
    preserveAspectRatio: 'xMidYMid meet',
    'aria-hidden': 'true'
  });
}

function buildOverviewLineChartPreview(previewData) {
  const mode = OVERVIEW_CHART_PREVIEW_MODE.line;
  const svg = buildOverviewChartSvgShell();
  const plotLeft = mode.insetX;
  const plotRight = OVERVIEW_CHART_PREVIEW_MODE.width - mode.insetX;
  const plotTop = mode.insetTop;
  const plotBottom = OVERVIEW_CHART_PREVIEW_MODE.height - mode.insetBottom;
  const values = previewData.datasets.flatMap((dataset) => dataset.values);
  const { minValue, maxValue } = computeOverviewValueRange(values, {
    includeZero: false,
    paddingRatio: mode.rangePaddingRatio
  });
  const crossesZero = minValue < 0 && maxValue > 0;

  if (crossesZero) {
    appendOverviewChartGuide(svg, mapOverviewValueToY(0, minValue, maxValue, plotTop, plotBottom), {
      width: OVERVIEW_CHART_PREVIEW_MODE.width,
      insetX: mode.insetX
    });
  }

  previewData.datasets.forEach((dataset, datasetIndex) => {
    const pointCount = Math.max(dataset.values.length, 1);
    const stepX = pointCount > 1 ? (plotRight - plotLeft) / (pointCount - 1) : 0;
    const singlePointX = (plotLeft + plotRight) / 2;
    const points = dataset.values.map((value, pointIndex) => ({
      x: pointCount > 1 ? plotLeft + (pointIndex * stepX) : singlePointX,
      y: mapOverviewValueToY(value, minValue, maxValue, plotTop, plotBottom)
    }));

    if (datasetIndex === 0 && points.length > 1) {
      const area = createOverviewSvgElement('path', {
        d: `${buildOverviewLinePath(points)} L ${points[points.length - 1].x} ${plotBottom} L ${points[0].x} ${plotBottom} Z`,
        class: 'overview-preview-chart-area',
        fill: dataset.color,
        opacity: '0.14'
      });
      svg.appendChild(area);
    }

    if (points.length > 1) {
      const path = createOverviewSvgElement('path', {
        d: buildOverviewLinePath(points),
        class: 'overview-preview-chart-line',
        fill: 'none',
        stroke: dataset.color,
        'stroke-width': datasetIndex === 0 ? 3.1 : 1.9,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        opacity: datasetIndex === 0 ? '1' : '0.54'
      });
      svg.appendChild(path);
    }

    const lastPoint = points[points.length - 1];
    if (lastPoint) {
      const dot = createOverviewSvgElement('circle', {
        cx: lastPoint.x,
        cy: lastPoint.y,
        r: datasetIndex === 0 ? 3.2 : 2.2,
        fill: dataset.color
      });
      dot.setAttribute('opacity', datasetIndex === 0 ? '1' : '0.72');
      svg.appendChild(dot);
    }
  });

  return svg;
}

function buildOverviewBarChartPreview(previewData) {
  const mode = OVERVIEW_CHART_PREVIEW_MODE.bar;
  const primaryDataset = previewData.datasets[0];
  const svg = buildOverviewChartSvgShell();
  if (!primaryDataset) {
    return svg;
  }

  const plotLeft = mode.insetX;
  const plotRight = OVERVIEW_CHART_PREVIEW_MODE.width - mode.insetX;
  const plotTop = mode.insetTop;
  const plotBottom = OVERVIEW_CHART_PREVIEW_MODE.height - mode.insetBottom;
  const values = primaryDataset.values;
  const { minValue, maxValue } = computeOverviewValueRange(values, {
    includeZero: true,
    paddingRatio: mode.rangePaddingRatio
  });
  const rawMinimum = Math.min(...values);
  const rawMaximum = Math.max(...values);
  const hasMixedSigns = rawMinimum < 0 && rawMaximum > 0;
  const baselineY = rawMaximum <= 0
    ? plotTop
    : (rawMinimum >= 0
      ? plotBottom
      : mapOverviewValueToY(0, minValue, maxValue, plotTop, plotBottom));

  if (hasMixedSigns) {
    appendOverviewChartGuide(svg, baselineY, {
      width: OVERVIEW_CHART_PREVIEW_MODE.width,
      insetX: mode.insetX
    });
  }

  const slotWidth = (plotRight - plotLeft) / Math.max(values.length, 1);
  const barWidth = Math.max(
    mode.minBarWidth,
    Math.min(slotWidth * 0.72, 18)
  );
  const emphasisIndex = values.reduce((bestIndex, value, index, source) => (
    Math.abs(value) > Math.abs(source[bestIndex] ?? 0) ? index : bestIndex
  ), 0);

  values.forEach((value, pointIndex) => {
    const barCenterX = plotLeft + (slotWidth * pointIndex) + (slotWidth / 2);
    const valueY = mapOverviewValueToY(value, minValue, maxValue, plotTop, plotBottom);
    const topY = Math.max(plotTop, Math.min(valueY, baselineY));
    const bottomY = Math.min(plotBottom, Math.max(valueY, baselineY));
    const rect = createOverviewSvgElement('rect', {
      x: barCenterX - (barWidth / 2),
      y: topY,
      width: barWidth,
      height: Math.max(3, bottomY - topY),
      rx: 3,
      fill: primaryDataset.color
    });
    rect.setAttribute('opacity', pointIndex === emphasisIndex ? '0.96' : '0.76');
    svg.appendChild(rect);
  });

  return svg;
}

function formatOverviewMetricValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2
    });
  }

  return truncateOverviewText(value, 18);
}

function pluralizeOverview(count, singular, plural = `${singular}s`) {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  const label = safeCount === 1 ? singular : plural;
  return `${safeCount} ${label}`;
}

function getOverviewTableValueIndex(columns, row) {
  let fallbackIndex = -1;
  for (let index = row.length - 1; index >= 1; index -= 1) {
    const value = normalizeOverviewText(row[index]);
    if (!value) {
      continue;
    }

    if (fallbackIndex === -1) {
      fallbackIndex = index;
    }

    const columnToken = normalizeSectionToken(columns[index]);
    const isDescriptorColumn = columnToken.includes('note')
      || columnToken.includes('detail')
      || columnToken.includes('description')
      || columnToken.includes('context')
      || columnToken.includes('comment');

    if (!isDescriptorColumn) {
      return index;
    }
  }

  return fallbackIndex;
}

function extractTablePreviewItems(tableData, maxItems = 4) {
  const columns = Array.isArray(tableData?.columns) ? tableData.columns : [];
  const rows = Array.isArray(tableData?.rows) ? tableData.rows : [];
  if (columns.length < 2 || rows.length === 0) {
    return [];
  }

  const items = [];
  rows.forEach((row, rowIndex) => {
    if (items.length >= maxItems) {
      return;
    }

    const safeRow = Array.isArray(row) ? row : [];
    const label = normalizeOverviewText(safeRow[0]) || `Metric ${rowIndex + 1}`;
    const valueIndex = getOverviewTableValueIndex(columns, safeRow);
    if (valueIndex === -1) {
      return;
    }

    const value = safeRow[valueIndex];
    const detailCellIndex = columns.findIndex((column, columnIndex) => (
      columnIndex > 0
      && columnIndex !== valueIndex
      && normalizeOverviewText(safeRow[columnIndex])
      && (
        normalizeSectionToken(column).includes('note')
        || normalizeSectionToken(column).includes('detail')
        || normalizeSectionToken(column).includes('description')
      )
    ));

    const detail = detailCellIndex > -1
      ? normalizeOverviewText(safeRow[detailCellIndex])
      : normalizeOverviewText(columns[valueIndex]);

    items.push({
      label: truncateOverviewText(label, 30),
      value: formatOverviewMetricValue(value),
      detail: truncateOverviewText(detail, 20),
      tone: ''
    });
  });

  return items;
}

function formatOverviewBucketedValue(outputsBucketed, value) {
  const currencySymbol = getOutputsBucketedCurrencySymbol(outputsBucketed);
  return formatBucketedCurrency(Number(value), currencySymbol);
}

function extractOutputsBucketedPreviewItems(outputsBucketed, maxItems = 4) {
  if (!hasOutputsBucketed(outputsBucketed)) {
    return [];
  }

  const items = [];
  const sections = outputsBucketed.sections;
  const summarySection = findOutputsBucketedSummarySection(sections);

  if (summarySection) {
    sanitizeSectionRows(summarySection.rows).forEach((row) => {
      if (items.length >= maxItems) {
        return;
      }

      items.push({
        label: truncateOverviewText(row[0], 30),
        value: formatOverviewBucketedValue(outputsBucketed, row[1]),
        detail: 'Summary',
        tone: isPbsNetWorthSummaryLabel(row[0]) ? 'positive' : ''
      });
    });
  }

  if (items.length === 0) {
    sections.forEach((section, index) => {
      if (items.length >= maxItems) {
        return;
      }

      if (Number.isFinite(Number(section?.subtotalValue))) {
        items.push({
          label: truncateOverviewText(section?.title || `Section ${index + 1}`, 30),
          value: formatOverviewBucketedValue(outputsBucketed, Number(section.subtotalValue)),
          detail: truncateOverviewText(section?.subtotalLabel || 'Subtotal', 18),
          tone: ''
        });
      }
    });
  }

  if (items.length === 0) {
    sections.forEach((section, index) => {
      if (items.length >= maxItems) {
        return;
      }

      const firstRow = sanitizeSectionRows(section?.rows)[0];
      if (!firstRow) {
        return;
      }

      items.push({
        label: truncateOverviewText(firstRow[0], 30),
        value: formatOverviewBucketedValue(outputsBucketed, firstRow[1]),
        detail: truncateOverviewText(section?.title || `Section ${index + 1}`, 18),
        tone: ''
      });
    });
  }

  return items.slice(0, maxItems);
}

function extractReportKpiPreviewItems(report, maxItems = 4) {
  const blocks = Array.isArray(report?.blocks) ? report.blocks : [];
  const items = [];

  for (const block of blocks) {
    if (block?.type !== 'kpiRow' || block?.errorMessage || !Array.isArray(block?.items)) {
      continue;
    }

    for (const item of block.items) {
      if (items.length >= maxItems) {
        return items;
      }

      items.push({
        label: truncateOverviewText(item?.label || 'KPI', 28),
        value: truncateOverviewText(item?.value || '--', 18),
        detail: truncateOverviewText(item?.detail || '', 18),
        tone: typeof item?.tone === 'string' ? item.tone.trim().toLowerCase() : ''
      });
    }
  }

  return items;
}

function collectOverviewKpiItems(module, maxItems = 4) {
  if (isReportModule(module)) {
    const report = module?.generated?.report || {};
    const reportKpis = extractReportKpiPreviewItems(report, maxItems);
    if (reportKpis.length > 0) {
      return reportKpis;
    }

    const reportTableBlock = (Array.isArray(report?.blocks) ? report.blocks : [])
      .find((block) => block?.type === 'table' && !block?.errorMessage && block?.table);
    if (reportTableBlock) {
      return extractTablePreviewItems(reportTableBlock.table, maxItems);
    }

    return [];
  }

  if (hasOutputsBucketed(module?.generated?.outputsBucketed)) {
    const bucketedItems = extractOutputsBucketedPreviewItems(module.generated.outputsBucketed, maxItems);
    if (bucketedItems.length > 0) {
      return bucketedItems;
    }
  }

  const outputsTable = filterOutputsRowsForPensionToggle(module, module?.generated?.outputs || {});
  const outputItems = extractTablePreviewItems(outputsTable, maxItems);
  if (outputItems.length > 0) {
    return outputItems;
  }

  return extractTablePreviewItems(module?.generated?.assumptions || {}, maxItems);
}

function collectReportInsightLines(report, maxItems = 3) {
  const lines = [];
  const blocks = Array.isArray(report?.blocks) ? report.blocks : [];

  for (const block of blocks) {
    if (lines.length >= maxItems * 2) {
      break;
    }

    if (block?.errorMessage) {
      continue;
    }

    if (block?.type === 'callout') {
      lines.push(...uniqueOverviewItems(Array.isArray(block?.bullets) ? block.bullets : [], maxItems));
      lines.push(...extractHtmlPreviewLines(block?.bodyHtml || '', maxItems));
      lines.push(...extractMarkdownPreviewLines(block?.markdown || '', maxItems));
      continue;
    }

    if (block?.type === 'markdown') {
      lines.push(...extractMarkdownPreviewLines(block?.markdown || '', maxItems));
      continue;
    }

    if (block?.type === 'checklist') {
      lines.push(...uniqueOverviewItems(
        (Array.isArray(block?.items) ? block.items : []).map((item) => item?.label || ''),
        maxItems
      ));
      continue;
    }

    if (block?.type === 'insightGrid' || block?.type === 'kpiRow') {
      lines.push(...uniqueOverviewItems(
        (Array.isArray(block?.items) ? block.items : [])
          .map((item) => item?.detail || item?.value || item?.label || ''),
        maxItems
      ));
      continue;
    }

    if (block?.type === 'scenarioCompare') {
      lines.push(...uniqueOverviewItems(
        (Array.isArray(block?.scenarios) ? block.scenarios : [])
          .flatMap((scenario) => [
            scenario?.summary || '',
            ...(Array.isArray(scenario?.metrics)
              ? scenario.metrics.map((metric) => metric?.detail || metric?.value || metric?.label || '')
              : [])
          ]),
        maxItems
      ));
      continue;
    }

    if (block?.type === 'accordion') {
      (Array.isArray(block?.items) ? block.items : []).forEach((item) => {
        lines.push(item?.title || '');
        lines.push(...extractHtmlPreviewLines(item?.bodyHtml || '', maxItems));
        lines.push(...extractMarkdownPreviewLines(item?.markdown || '', maxItems));
      });
      continue;
    }

    if (block?.type === 'timeline') {
      const timeline = normalizeReportTimelineContent(block?.svgSpec || {});
      if (timeline.events.length > 0) {
        lines.push(...uniqueOverviewItems(
          timeline.events.map((event) => event?.title || ''),
          maxItems
        ));
      }
    }
  }

  if (lines.length === 0 && typeof report?.rawMarkdown === 'string') {
    lines.push(...extractMarkdownPreviewLines(report.rawMarkdown, maxItems));
  }

  return uniqueOverviewItems(lines, maxItems);
}

function collectEducationInsightLines(module, maxItems = 3) {
  const lines = [];
  const education = module?.generated?.education || {};
  const sections = Array.isArray(education?.sections) ? education.sections : [];
  const metrics = Array.isArray(education?.metrics) ? education.metrics : [];
  const steps = Array.isArray(education?.steps) ? education.steps : [];

  lines.push(...uniqueOverviewItems(
    metrics.map((metric) => metric?.detail || metric?.value || metric?.label || ''),
    maxItems
  ));

  steps.forEach((step) => {
    lines.push(step?.focus || '');
    lines.push(...extractHtmlPreviewLines(step?.bodyHtml || '', maxItems));
    lines.push(...uniqueOverviewItems(Array.isArray(step?.bullets) ? step.bullets : [], maxItems));
  });

  sections.forEach((section) => {
    lines.push(...uniqueOverviewItems(Array.isArray(section?.bullets) ? section.bullets : [], maxItems));
    lines.push(...extractHtmlPreviewLines(section?.bodyHtml || '', maxItems));
    lines.push(section?.whyItMatters || '');
  });

  lines.push(...extractHtmlPreviewLines(module?.generated?.summaryHtml || '', maxItems));
  return uniqueOverviewItems(lines, maxItems);
}

function collectOverviewInsightLines(module, maxItems = 3) {
  const lines = [];

  if (isReportModule(module)) {
    lines.push(...collectReportInsightLines(module.generated.report, maxItems));
  } else if (isEducationModule(module)) {
    lines.push(...collectEducationInsightLines(module, maxItems));
  } else {
    lines.push(...extractHtmlPreviewLines(module?.generated?.summaryHtml || '', maxItems));
  }

  lines.push(...extractHtmlPreviewLines(module?.generated?.summaryHtml || '', maxItems));

  const noteLines = splitOverviewSentences(module?.notes || '');
  if (noteLines.length > 0) {
    lines.push(...noteLines);
  }

  if (lines.length === 0) {
    lines.push(makeOverviewSnippet(module));
  }

  return uniqueOverviewItems(lines, maxItems);
}

function getOverviewSvgPreviewKind(svgSpec) {
  return toTrimmedString(svgSpec?.kind).toLowerCase() === 'timeline' ? 'timeline' : 'svg';
}

function collectOverviewVisualCandidates(module) {
  const candidates = [];

  if (isReportModule(module)) {
    const blocks = Array.isArray(module?.generated?.report?.blocks) ? module.generated.report.blocks : [];
    blocks.forEach((block, index) => {
      if (block?.errorMessage) {
        return;
      }

      if (block?.type === 'chart') {
        const chart = sanitizeEducationChart(block?.chart, index);
        if (chart) {
          candidates.push({
            kind: 'chart',
            title: block?.title || chart.title,
            chart
          });
        }
        return;
      }

      if (block?.type === 'svg' || block?.type === 'timeline') {
        const kind = block?.type === 'timeline' ? 'timeline' : getOverviewSvgPreviewKind(block?.svgSpec || {});
        candidates.push({
          kind,
          title: block?.title || (kind === 'timeline' ? `Timeline ${index + 1}` : `Diagram ${index + 1}`),
          svgSpec: block?.svgSpec || {}
        });
      }
    });

    return candidates;
  }

  if (isEducationModule(module)) {
    getEducationVisuals(module).forEach((visual, visualIndex) => {
      const type = String(visual?.type || '').trim().toLowerCase();
      if (type === 'chart') {
        const chart = sanitizeEducationChart(visual?.chart, visualIndex);
        if (chart) {
          candidates.push({
            kind: 'chart',
            title: visual?.title || chart.title,
            chart
          });
        }
        return;
      }

      if (type === 'svg') {
        const kind = getOverviewSvgPreviewKind(visual?.svgSpec || {});
        candidates.push({
          kind,
          title: visual?.title || (kind === 'timeline' ? `Timeline ${visualIndex + 1}` : `Diagram ${visualIndex + 1}`),
          svgSpec: visual?.svgSpec || {}
        });
      }
    });

    return candidates;
  }

  (Array.isArray(module?.generated?.charts) ? module.generated.charts : []).forEach((chartData, chartIndex) => {
    const chart = sanitizeEducationChart(chartData, chartIndex);
    if (!chart) {
      return;
    }

    candidates.push({
      kind: 'chart',
      title: chart.title,
      chart
    });
  });

  return candidates;
}

function collectOverviewSignalCounts(module) {
  const counts = {
    charts: 0,
    diagrams: 0,
    timelines: 0,
    visuals: 0,
    kpis: 0,
    sections: 0,
    references: 0,
    blocks: 0,
    tables: 0,
    outputs: 0
  };

  if (isReportModule(module)) {
    const blocks = Array.isArray(module?.generated?.report?.blocks) ? module.generated.report.blocks : [];
    counts.blocks = blocks.length;

    blocks.forEach((block) => {
      if (block?.errorMessage) {
        return;
      }

      if (block?.type === 'chart') {
        counts.charts += 1;
        return;
      }

      if (block?.type === 'timeline') {
        counts.timelines += 1;
        return;
      }

      if (block?.type === 'svg') {
        counts[getOverviewSvgPreviewKind(block?.svgSpec || {}) === 'timeline' ? 'timelines' : 'diagrams'] += 1;
        return;
      }

      if (block?.type === 'kpiRow') {
        counts.kpis += Array.isArray(block?.items) ? block.items.length : 0;
        return;
      }

      if (block?.type === 'table') {
        counts.tables += 1;
      }
    });

    counts.visuals = counts.charts + counts.diagrams + counts.timelines;
    return counts;
  }

  if (isEducationModule(module)) {
    const education = module?.generated?.education || {};
    counts.sections = Array.isArray(education?.sections) ? education.sections.length : 0;
    counts.references = Array.isArray(education?.references) ? education.references.length : 0;

    getEducationVisuals(module).forEach((visual) => {
      const type = String(visual?.type || '').trim().toLowerCase();
      if (type === 'chart') {
        counts.charts += 1;
        return;
      }

      if (type === 'svg') {
        counts[getOverviewSvgPreviewKind(visual?.svgSpec || {}) === 'timeline' ? 'timelines' : 'diagrams'] += 1;
      }
    });

    counts.visuals = counts.charts + counts.diagrams + counts.timelines;
    return counts;
  }

  counts.charts = Array.isArray(module?.generated?.charts) ? module.generated.charts.length : 0;
  counts.visuals = counts.charts;
  counts.tables = Array.isArray(module?.generated?.tables) ? module.generated.tables.length : 0;

  if (hasOutputsBucketed(module?.generated?.outputsBucketed)) {
    counts.outputs = Array.isArray(module.generated.outputsBucketed.sections)
      ? module.generated.outputsBucketed.sections.length
      : 0;
  } else {
    const outputsTable = filterOutputsRowsForPensionToggle(module, module?.generated?.outputs || {});
    counts.outputs = Array.isArray(outputsTable?.rows) ? outputsTable.rows.length : 0;
  }

  return counts;
}

function inferOverviewModuleKind(module) {
  if (isVideoSummaryModule(module)) {
    return {
      label: 'Video Summary',
      token: 'video-summary'
    };
  }

  if (isEducationModule(module)) {
    return {
      label: 'Education',
      token: 'education'
    };
  }

  if (isReportModule(module)) {
    return {
      label: 'Report',
      token: 'report'
    };
  }

  if (isLiquidityPlanModule(module)) {
    return {
      label: 'Liquidity',
      token: 'liquidity'
    };
  }

  if (isHousePurchaseModule(module)) {
    return {
      label: 'House Purchase',
      token: 'house-purchase'
    };
  }

  if (isPensionModule(module)) {
    return {
      label: 'Pension',
      token: 'pension'
    };
  }

  if (isNetRetirementModule(module)) {
    return {
      label: 'Net Cash Flow',
      token: 'net-retirement'
    };
  }

  if (isCollegeFundingModule(module)) {
    return {
      label: 'College Funding',
      token: 'college-funding'
    };
  }

  if (module?.generated?.loanInputs?.loanKind === 'loan' || module?.generated?.loanInputs) {
    return {
      label: 'Loan',
      token: 'loan'
    };
  }

  if (module?.generated?.mortgageInputs) {
    return {
      label: 'Mortgage',
      token: 'mortgage'
    };
  }

  if (hasOutputsBucketed(module?.generated?.outputsBucketed)) {
    return {
      label: 'Balance Sheet',
      token: 'balance-sheet'
    };
  }

  if (Array.isArray(module?.generated?.charts) && module.generated.charts.length > 0) {
    return {
      label: 'Analysis',
      token: 'analysis'
    };
  }

  return {
    label: 'Module',
    token: 'generic'
  };
}

function buildOverviewMetaItems(module, signalCounts) {
  const items = [];
  const moduleKind = inferOverviewModuleKind(module);

  if (moduleKind.token === 'video-summary') {
    items.push('YouTube', 'Summary');
    return uniqueOverviewItems(items, 3, 22);
  }

  if (moduleKind.token === 'education') {
    const audience = toTrimmedString(module?.generated?.education?.audience);
    if (audience) {
      items.push(audience);
    }
    if (signalCounts.visuals > 0) {
      items.push(pluralizeOverview(signalCounts.visuals, 'visual'));
    }
    if (signalCounts.sections > 0) {
      items.push(pluralizeOverview(signalCounts.sections, 'section'));
    }
    if (signalCounts.references > 0) {
      items.push(pluralizeOverview(signalCounts.references, 'reference'));
    }
    return uniqueOverviewItems(items, 3, 24);
  }

  if (moduleKind.token === 'report') {
    if (signalCounts.charts > 0) {
      items.push(pluralizeOverview(signalCounts.charts, 'chart'));
    }
    if (signalCounts.timelines > 0) {
      items.push(pluralizeOverview(signalCounts.timelines, 'timeline'));
    }
    if (signalCounts.diagrams > 0) {
      items.push(pluralizeOverview(signalCounts.diagrams, 'diagram'));
    }
    if (signalCounts.kpis > 0) {
      items.push(pluralizeOverview(signalCounts.kpis, 'KPI', 'KPIs'));
    }
    if (signalCounts.blocks > 0) {
      items.push(pluralizeOverview(signalCounts.blocks, 'block'));
    }
    return uniqueOverviewItems(items, 3, 22);
  }

  if (moduleKind.token === 'liquidity') {
    const plan = module?.generated?.liquidityPlan || {};
    const assessment = computeLiquidityAssessment(plan);
    if (assessment?.clientLabel) {
      items.push(assessment.clientLabel);
    }
    if (assessment?.monthsLabel) {
      items.push(assessment.monthsLabel);
    }
    if (assessment?.actionMode === 'deploy' && assessment.surplusCash > 0) {
      items.push('Surplus cash');
    } else if ((assessment?.actionMode === 'build' || assessment?.actionMode === 'top-up') && assessment.shortfallCash > 0) {
      items.push('Build reserve');
    }
    return uniqueOverviewItems(items, 3, 22);
  }

  if (moduleKind.token === 'house-purchase') {
    const projection = getHousePurchaseProjection(module);
    const result = projection?.result || {};
    const targetFunding = result.targetFunding || {};
    const applicationType = module?.generated?.housePurchaseInputs?.applicationType;
    if (applicationType === 'joint') {
      items.push('Joint plan');
    } else if (applicationType === 'single') {
      items.push('Single buyer');
    }
    if (finiteHousePurchaseNumber(targetFunding.monthsToReady) !== null) {
      items.push(Number(targetFunding.monthsToReady) <= 0
        ? 'Cash ready'
        : `${Math.ceil(Number(targetFunding.monthsToReady))}m route`);
    }
    const status = result.bottlenecks?.primary?.label || targetFunding.status;
    if (status) {
      items.push(status);
    }
    return uniqueOverviewItems(items, 3, 22);
  }

  if (moduleKind.token === 'pension') {
    items.push(isAffordablePensionMode(module) ? 'Affordable mode' : 'Target mode');
    if (signalCounts.charts > 0) {
      items.push(pluralizeOverview(signalCounts.charts, 'chart'));
    }
    if (signalCounts.outputs > 0) {
      items.push(pluralizeOverview(signalCounts.outputs, 'output'));
    }
    return uniqueOverviewItems(items, 3, 22);
  }

  if (moduleKind.token === 'net-retirement') {
    const inputs = module?.generated?.netRetirementInputs || {};
    const scenarioCount = Array.isArray(inputs.scenarios) ? inputs.scenarios.length : 0;
    if (scenarioCount > 1) {
      items.push(pluralizeOverview(scenarioCount, 'scenario'));
    }
    if (Number.isFinite(Number(inputs.currentAge)) && Number.isFinite(Number(inputs.horizonEndAge))) {
      items.push(`Age ${inputs.currentAge}-${inputs.horizonEndAge}`);
    }
    if (signalCounts.charts > 0) {
      items.push(pluralizeOverview(signalCounts.charts, 'chart'));
    }
    return uniqueOverviewItems(items, 3, 22);
  }

  if (moduleKind.token === 'college-funding') {
    const inputs = module?.generated?.collegeFundingInputs || {};
    const childCount = Array.isArray(inputs.children) && inputs.children.length > 0
      ? inputs.children.length
      : Number(inputs.childrenCount || inputs.numberOfChildren);
    if (Number.isFinite(childCount) && childCount > 0) {
      items.push(pluralizeOverview(childCount, 'child', 'children'));
    }
    if (Array.isArray(inputs.scenarios) && inputs.scenarios.length > 0) {
      items.push(pluralizeOverview(inputs.scenarios.length, 'scenario'));
    }
    if (signalCounts.charts > 0) {
      items.push(pluralizeOverview(signalCounts.charts, 'chart'));
    }
    return uniqueOverviewItems(items, 3, 22);
  }

  if (moduleKind.token === 'mortgage' || moduleKind.token === 'loan') {
    const loanInputs = getLoanEngineInputs(module);
    if (loanInputs?.repaymentType === 'interestOnly') {
      items.push('Interest only');
    } else if (loanInputs?.repaymentType === 'repayment') {
      items.push('Repayment');
    }

    const termYears = deriveRemainingTermYears(loanInputs);
    if (Number.isFinite(termYears) && termYears > 0) {
      items.push(`${Math.round(termYears)}y term`);
    }

    if (signalCounts.outputs > 0) {
      items.push(pluralizeOverview(signalCounts.outputs, 'output'));
    }
    if (signalCounts.charts > 0) {
      items.push(pluralizeOverview(signalCounts.charts, 'chart'));
    }
    return uniqueOverviewItems(items, 3, 22);
  }

  if (signalCounts.charts > 0) {
    items.push(pluralizeOverview(signalCounts.charts, 'chart'));
  }
  if (signalCounts.outputs > 0) {
    items.push(pluralizeOverview(signalCounts.outputs, 'output'));
  }
  if (signalCounts.tables > 0) {
    items.push(pluralizeOverview(signalCounts.tables, 'table'));
  }

  return uniqueOverviewItems(items, 3, 22);
}

export function buildOverviewPreviewDescriptor(module) {
  const moduleKind = inferOverviewModuleKind(module);
  const signalCounts = collectOverviewSignalCounts(module);

  if (moduleKind.token === 'video-summary') {
    const videoSummary = module?.generated?.videoSummary || {};
    return {
      moduleKind,
      signalCounts,
      previewKind: 'video-summary',
      previewLabel: 'Video summary',
      videoSummary,
      metaItems: buildOverviewMetaItems(module, signalCounts)
    };
  }

  if (moduleKind.token === 'house-purchase') {
    const projection = getHousePurchaseProjection(module);
    const result = projection?.result || {};
    const targetFunding = result.targetFunding || {};
    const capacities = result.capacities || {};
    const bottleneck = result.bottlenecks?.primary || {};
    return {
      moduleKind,
      signalCounts,
      previewKind: 'kpi',
      previewLabel: 'Route to home',
      kpiItems: [
        {
          label: 'Target home',
          value: finiteHousePurchaseNumber(targetFunding.targetPropertyPrice) !== null
            ? DISPLAY_EURO_FORMATTER.format(Number(targetFunding.targetPropertyPrice))
            : 'Set target'
        },
        {
          label: 'Capacity now',
          value: finiteHousePurchaseNumber(capacities.currentSupportablePrice) !== null
            ? DISPLAY_EURO_FORMATTER.format(Number(capacities.currentSupportablePrice))
            : 'Needs inputs'
        },
        {
          label: 'Route status',
          value: bottleneck.label || 'Build plan',
          tone: bottleneck.status || 'neutral'
        }
      ],
      metaItems: buildOverviewMetaItems(module, signalCounts)
    };
  }

  const visualCandidates = collectOverviewVisualCandidates(module);
  const kpiItems = collectOverviewKpiItems(module, 4);
  const insightLines = collectOverviewInsightLines(module, 3);
  const preview = visualCandidates[0] || null;
  const moduleTitle = normalizeOverviewText(module?.title || 'Untitled Module');

  if (preview) {
    const previewLabel = normalizeOverviewText(preview.title).toLowerCase() === moduleTitle.toLowerCase()
      ? (preview.kind === 'chart'
        ? 'Chart preview'
        : (preview.kind === 'timeline' ? 'Timeline preview' : 'Diagram preview'))
      : truncateOverviewText(preview.title, 48);

    return {
      moduleKind,
      signalCounts,
      previewKind: preview.kind,
      previewLabel,
      visualPreview: preview,
      metaItems: buildOverviewMetaItems(module, signalCounts)
    };
  }

  if (kpiItems.length > 0) {
    return {
      moduleKind,
      signalCounts,
      previewKind: 'kpi',
      previewLabel: 'Key outputs',
      kpiItems,
      metaItems: buildOverviewMetaItems(module, signalCounts)
    };
  }

  return {
    moduleKind,
    signalCounts,
    previewKind: 'insight',
    previewLabel: 'Key takeaways',
    insightLines: insightLines.length > 0 ? insightLines : [makeOverviewSnippet(module)],
    metaItems: buildOverviewMetaItems(module, signalCounts)
  };
}

function buildOverviewChartPreview(chart) {
  const previewData = selectOverviewPreviewDatasets(chart);

  if (previewData.datasets.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'overview-preview-empty';
    empty.textContent = 'No chart data';
    return empty;
  }

  return previewData.chartType === 'bar'
    ? buildOverviewBarChartPreview(previewData)
    : buildOverviewLineChartPreview(previewData);
}

function buildOverviewSvgPreview(preview) {
  const host = document.createElement('div');
  host.className = 'overview-preview-svg-host';

  try {
    const svg = renderSvgDiagram(preview?.svgSpec || {});
    if (!(svg instanceof SVGElement)) {
      throw new Error('Invalid SVG');
    }

    const svgTheme = String(svg.getAttribute('data-theme') || preview?.svgSpec?.theme || 'dark')
      .trim()
      .toLowerCase() === 'light'
      ? 'light'
      : 'dark';

    host.dataset.svgTheme = svgTheme;
    svg.setAttribute('aria-hidden', 'true');
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    host.appendChild(svg);
  } catch (_error) {
    const empty = document.createElement('div');
    empty.className = 'overview-preview-empty';
    empty.textContent = preview?.kind === 'timeline' ? 'Timeline preview unavailable' : 'Diagram preview unavailable';
    host.appendChild(empty);
  }

  return host;
}

function buildOverviewKpiPreview(items) {
  const grid = document.createElement('div');
  grid.className = 'overview-kpi-grid';

  items.slice(0, 4).forEach((item) => {
    const metric = document.createElement('article');
    metric.className = 'overview-kpi-item';
    if (typeof item?.tone === 'string' && item.tone.trim()) {
      metric.dataset.tone = item.tone.trim().toLowerCase();
    }

    const label = document.createElement('div');
    label.className = 'overview-kpi-label';
    label.textContent = item?.label || 'Metric';
    metric.appendChild(label);

    const value = document.createElement('div');
    value.className = 'overview-kpi-value';
    value.textContent = formatMetricDisplayValue(item?.label || 'Metric', item?.value || '--');
    metric.appendChild(value);

    if (item?.detail) {
      const detail = document.createElement('div');
      detail.className = 'overview-kpi-detail';
      detail.textContent = item.detail;
      metric.appendChild(detail);
    }

    grid.appendChild(metric);
  });

  return grid;
}

function buildOverviewInsightPreview(lines) {
  const list = document.createElement('ul');
  list.className = 'overview-insight-list';

  lines.slice(0, 3).forEach((line) => {
    const item = document.createElement('li');
    item.className = 'overview-insight-item';
    item.textContent = line;
    list.appendChild(item);
  });

  return list;
}

function buildOverviewVideoSummaryPreview(videoSummary) {
  const host = document.createElement('div');
  host.className = 'overview-video-summary-preview';

  if (videoSummary?.thumbnailUrl) {
    const image = document.createElement('img');
    image.className = 'overview-video-summary-thumbnail';
    image.src = videoSummary.thumbnailUrl;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    host.appendChild(image);
  } else {
    const empty = document.createElement('div');
    empty.className = 'overview-preview-empty';
    empty.textContent = 'Video thumbnail';
    host.appendChild(empty);
  }

  const play = document.createElement('span');
  play.className = 'overview-video-summary-play';
  play.textContent = '▶';
  play.setAttribute('aria-hidden', 'true');
  host.appendChild(play);

  return host;
}

function buildOverviewPreviewSurface(descriptor) {
  const surface = document.createElement('div');
  surface.className = 'overview-preview';
  surface.dataset.previewKind = descriptor.previewKind;

  if (descriptor?.previewLabel) {
    const label = document.createElement('div');
    label.className = 'overview-preview-label';
    label.textContent = descriptor.previewLabel;
    surface.appendChild(label);
  }

  const body = document.createElement('div');
  body.className = 'overview-preview-body';

  if (descriptor.previewKind === 'chart') {
    body.classList.add('is-chart');
    body.appendChild(buildOverviewChartPreview(descriptor.visualPreview?.chart || {}));
  } else if (descriptor.previewKind === 'svg' || descriptor.previewKind === 'timeline') {
    body.classList.add('is-svg');
    body.appendChild(buildOverviewSvgPreview(descriptor.visualPreview || {}));
  } else if (descriptor.previewKind === 'kpi') {
    body.classList.add('is-kpi');
    body.appendChild(buildOverviewKpiPreview(descriptor.kpiItems || []));
  } else if (descriptor.previewKind === 'video-summary') {
    body.classList.add('is-video-summary');
    body.appendChild(buildOverviewVideoSummaryPreview(descriptor.videoSummary || {}));
  } else {
    body.classList.add('is-insight');
    body.appendChild(buildOverviewInsightPreview(descriptor.insightLines || []));
  }

  surface.appendChild(body);
  return surface;
}

function buildOverviewMetaStrip(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  const strip = document.createElement('div');
  strip.className = 'overview-meta-strip';

  items.forEach((item) => {
    const chip = document.createElement('span');
    chip.className = 'overview-meta-chip';
    chip.textContent = item;
    strip.appendChild(chip);
  });

  return strip;
}

function isPensionModule(module) {
  return Boolean(module?.generated?.pensionInputs);
}

function isCollegeFundingModule(module) {
  return Boolean(module?.generated?.collegeFundingInputs);
}

function isHousePurchaseModule(module) {
  return Boolean(module?.generated?.housePurchaseInputs);
}

function getHousePurchaseProjection(module, scenarioOverrides = {}) {
  if (!isHousePurchaseModule(module)) {
    return null;
  }

  try {
    return computeHousePurchaseProjection(module.generated.housePurchaseInputs, {
      scenarioOverrides: scenarioOverrides && typeof scenarioOverrides === 'object'
        ? scenarioOverrides
        : {}
    });
  } catch (_error) {
    return null;
  }
}

function getHousePurchaseScenarioOverrides(moduleId) {
  if (!moduleId || typeof window === 'undefined' || typeof window.__getHousePurchaseScenarioOverrides !== 'function') {
    return {};
  }

  const overrides = window.__getHousePurchaseScenarioOverrides(moduleId);
  return overrides && typeof overrides === 'object' && !Array.isArray(overrides)
    ? overrides
    : {};
}

function isLiquidityPlanModule(module) {
  return Boolean(module?.generated?.liquidityPlan);
}

function isNetRetirementModule(module) {
  return Boolean(module?.generated?.netRetirementInputs);
}

function isLoanProjectionModule(module) {
  return Boolean(module?.generated?.loanInputs);
}

function isMortgageProjectionModule(module) {
  return Boolean(module?.generated?.mortgageInputs && !isLoanProjectionModule(module));
}

function isProtectionReportModule(module) {
  if (!isReportModule(module)) {
    return false;
  }

  const text = [
    module?.title,
    module?.generated?.report?.title,
    module?.generated?.summaryHtml
  ]
    .map((value) => (typeof value === 'string' ? htmlToPlainText(value) : ''))
    .join(' ')
    .toLowerCase();

  return text.includes('protection')
    || text.includes('income protection')
    || text.includes('serious illness')
    || text.includes('illness cover');
}

function getPlaybookDisplayContext(module) {
  if (isHousePurchaseModule(module)) {
    return {
      key: 'housePurchase',
      heading: 'House Purchase Planner',
      guide: CLIENT_GUIDE_COPY.housePurchase
    };
  }

  if (isLiquidityPlanModule(module)) {
    return {
      key: 'liquidity',
      heading: 'Liquidity Plan',
      guide: CLIENT_GUIDE_COPY.liquidity
    };
  }

  if (isPersonalBalanceSheetModule(module)) {
    return {
      key: 'pbs',
      heading: 'Personal Balance Sheet',
      guide: CLIENT_GUIDE_COPY.pbs
    };
  }

  if (isPensionModule(module)) {
    return {
      key: 'pension',
      heading: 'Retirement Projection',
      guide: CLIENT_GUIDE_COPY.pension
    };
  }

  if (isNetRetirementModule(module)) {
    return {
      key: 'netRetirement',
      heading: 'Net Retirement Cash Flow',
      guide: CLIENT_GUIDE_COPY.netRetirement
    };
  }

  if (isCollegeFundingModule(module)) {
    return {
      key: 'collegeFunding',
      heading: 'College Funding',
      guide: CLIENT_GUIDE_COPY.collegeFunding
    };
  }

  if (isLoanProjectionModule(module)) {
    return {
      key: 'loan',
      heading: 'Loan Projection',
      guide: CLIENT_GUIDE_COPY.loan
    };
  }

  if (isMortgageProjectionModule(module)) {
    return {
      key: 'mortgage',
      heading: 'Mortgage Projection',
      guide: CLIENT_GUIDE_COPY.mortgage
    };
  }

  if (isEducationModule(module)) {
    return {
      key: 'education',
      heading: 'Education Guide',
      guide: CLIENT_GUIDE_COPY.education
    };
  }

  if (isProtectionReportModule(module)) {
    return {
      key: 'protection',
      heading: 'Protection Planning',
      guide: CLIENT_GUIDE_COPY.protection
    };
  }

  if (isReportModule(module)) {
    return {
      key: 'report',
      heading: 'Client Report',
      guide: CLIENT_GUIDE_COPY.report
    };
  }

  return {
    key: 'generated',
    heading: 'Generated Content',
    guide: ''
  };
}

function normalizeGuideComparisonText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function shouldRenderClientGuide(summaryHtml, guideText) {
  const guide = normalizeGuideComparisonText(guideText);
  if (!guide) {
    return false;
  }

  const summary = normalizeGuideComparisonText(htmlToPlainText(summaryHtml || ''));
  return !summary.includes(guide);
}

function buildClientGuideLine(summaryHtml, guideText) {
  if (!shouldRenderClientGuide(summaryHtml, guideText)) {
    return null;
  }

  const guide = document.createElement('p');
  guide.className = 'client-guide-line';
  guide.textContent = guideText;
  return guide;
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

function getPensionScenarioCasesForModule(module) {
  if (!isPensionModule(module)) {
    return [];
  }

  try {
    return getPensionScenarioCases(module.generated.pensionInputs);
  } catch (_error) {
    return [];
  }
}

function getDefaultPensionScenarioForModule(module) {
  if (!isPensionModule(module)) {
    return '';
  }

  try {
    return getDefaultPensionScenarioId(module.generated.pensionInputs);
  } catch (_error) {
    return '';
  }
}

function getPensionScenarioForModule(module) {
  const cases = getPensionScenarioCasesForModule(module);
  if (cases.length === 0) {
    return '';
  }

  const selectedId = typeof window.__getPensionScenarioForModule === 'function'
    ? window.__getPensionScenarioForModule(module.id)
    : '';

  if (cases.some((pensionCase) => pensionCase.id === selectedId)) {
    return selectedId;
  }

  return getDefaultPensionScenarioForModule(module) || cases[0].id;
}

function getPensionDisplayModule(module) {
  if (!isPensionModule(module)) {
    return module;
  }

  try {
    const scenarioId = getPensionScenarioForModule(module);
    const projection = computePensionProjection(module.generated.pensionInputs, { scenarioId });
    const existingCharts = Array.isArray(module.generated?.charts) ? module.generated.charts : [];

    const summaryHtml = injectAutoPensionSummaryDisplay(module.generated?.summaryHtml || '', {
      readinessSentence: projection.debug?.readinessSentence || '',
      sftSentence: projection.debug?.sftSentence || '',
      personalCapSentence: projection.debug?.currentPersonalCapSentence || ''
    });

    return {
      ...module,
      _retirementProjection: {
        scenarioId,
        debug: projection.debug
      },
      generated: {
        ...(module.generated || {}),
        summaryHtml,
        pensionInputs: {
          ...(module.generated?.pensionInputs || {}),
          rentalIncomeToday: projection.debug.rentalIncomeToday
        },
        assumptions: projection.assumptionsTable,
        outputs: projection.outputsTable,
        charts: projection.charts.map((chart, index) => ({
          ...chart,
          id: chart.id || existingCharts[index]?.id || ''
        }))
      }
    };
  } catch (_error) {
    return module;
  }
}

function getNetRetirementScenarioCasesForModule(module) {
  if (!isNetRetirementModule(module)) {
    return [];
  }

  try {
    return getNetRetirementScenarioCases(module.generated.netRetirementInputs);
  } catch (_error) {
    return [];
  }
}

function getDefaultNetRetirementScenarioForModule(module) {
  if (!isNetRetirementModule(module)) {
    return '';
  }

  try {
    return getDefaultNetRetirementScenarioId(module.generated.netRetirementInputs);
  } catch (_error) {
    return '';
  }
}

function getNetRetirementScenarioForModule(module) {
  const cases = getNetRetirementScenarioCasesForModule(module);
  if (cases.length === 0) {
    return '';
  }

  const selectedId = typeof window.__getNetRetirementScenarioForModule === 'function'
    ? window.__getNetRetirementScenarioForModule(module.id)
    : '';

  if (cases.some((netCase) => netCase.id === selectedId)) {
    return selectedId;
  }

  return getDefaultNetRetirementScenarioForModule(module) || cases[0].id;
}

function getNetRetirementDisplayModule(module) {
  if (!isNetRetirementModule(module)) {
    return module;
  }

  try {
    const scenarioId = getNetRetirementScenarioForModule(module);
    const projection = computeNetRetirementProjection(module.generated.netRetirementInputs, { scenarioId });
    const existingCharts = Array.isArray(module.generated?.charts) ? module.generated.charts : [];

    return {
      ...module,
      _netRetirementProjection: {
        scenarioId,
        debug: projection.debug
      },
      generated: {
        ...(module.generated || {}),
        assumptions: projection.assumptionsTable,
        outputs: projection.outputsTable,
        tables: projection.tables,
        charts: projection.charts.map((chart, index) => ({
          ...chart,
          id: chart.id || existingCharts[index]?.id || ''
        }))
      }
    };
  } catch (_error) {
    return module;
  }
}

function getCalculatedDisplayModule(module) {
  if (isNetRetirementModule(module)) {
    return getNetRetirementDisplayModule(module);
  }

  return getPensionDisplayModule(module);
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
    const isCurrentAffordable = label.startsWith('affordable income (current')
      || label.startsWith('pension-funded affordable income (current');
    const isMaxAffordable = label.startsWith('affordable income (max')
      || label.startsWith('pension-funded affordable income (max');

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

function blocksGeneratedTableEditing(module) {
  return Boolean(
    isPensionModule(module)
    || isNetRetirementModule(module)
    || isCollegeFundingModule(module)
    || isHousePurchaseModule(module)
    || isMortgageModule(module)
  );
}

function isVideoSummaryModule(module) {
  const videoSummary = module?.generated?.videoSummary;
  return Boolean(
    videoSummary
    && typeof videoSummary === 'object'
    && !Array.isArray(videoSummary)
    && videoSummary.provider === 'youtube'
    && typeof videoSummary.videoId === 'string'
    && videoSummary.videoId.trim()
  );
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

function normalizeRenderTone(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function normalizeChartDisplay(display) {
  if (!isPlainObject(display)) {
    return null;
  }

  const normalized = {};
  const variant = normalizeRenderTone(display.variant);
  if (variant === 'hero' || variant === 'compact' || variant === 'wide' || variant === 'pension-drawdown-composite') {
    normalized.variant = variant;
  }

  const valueFormat = normalizeRenderTone(display.valueFormat);
  if (valueFormat === 'currency' || valueFormat === 'percent' || valueFormat === 'number') {
    normalized.valueFormat = valueFormat;
  }

  ['xAxisTitle', 'yAxisTitle', 'highlightDataset'].forEach((key) => {
    if (typeof display[key] === 'string' && display[key].trim()) {
      normalized[key] = display[key].trim();
    }
  });

  if (typeof display.showLegend === 'boolean') {
    normalized.showLegend = display.showLegend;
  }

  if (typeof display.stacked === 'boolean') {
    normalized.stacked = display.stacked;
  }

  ['yMin', 'yMax', 'suggestedMin', 'suggestedMax'].forEach((key) => {
    const value = Number(display[key]);
    if (Number.isFinite(value)) {
      normalized[key] = value;
    }
  });

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeChartAnnotations(annotations) {
  if (!Array.isArray(annotations)) {
    return [];
  }

  return annotations
    .filter((annotation) => isPlainObject(annotation))
    .map((annotation, index) => {
      const normalized = {
        id: typeof annotation.id === 'string' && annotation.id.trim()
          ? annotation.id.trim()
          : `annotation-${index + 1}`,
        label: typeof annotation.label === 'string' && annotation.label.trim()
          ? annotation.label.trim()
          : `Annotation ${index + 1}`
      };

      if (typeof annotation.body === 'string' && annotation.body.trim()) {
        normalized.body = annotation.body.trim();
      }

      if (typeof annotation.xLabel === 'string' && annotation.xLabel.trim()) {
        normalized.xLabel = annotation.xLabel.trim();
      }

      const yValue = Number(annotation.yValue);
      if (Number.isFinite(yValue)) {
        normalized.yValue = yValue;
      }

      const tone = normalizeRenderTone(annotation.tone);
      if (tone) {
        normalized.tone = tone;
      }

      return normalized;
    });
}

function normalizeInsightItems(items, fallbackPrefix = 'insight') {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter((item) => isPlainObject(item))
    .map((item, index) => {
      const normalized = {
        id: typeof item.id === 'string' && item.id.trim()
          ? item.id.trim()
          : `${fallbackPrefix}-${index + 1}`,
        label: typeof item.label === 'string' && item.label.trim()
          ? item.label.trim()
          : (typeof item.title === 'string' && item.title.trim()
            ? item.title.trim()
            : `Insight ${index + 1}`)
      };

      if (typeof item.value === 'number' && Number.isFinite(item.value)) {
        normalized.value = String(item.value);
      } else if (typeof item.value === 'string' && item.value.trim()) {
        normalized.value = item.value.trim();
      }

      const detail = typeof item.detail === 'string' && item.detail.trim()
        ? item.detail.trim()
        : (typeof item.body === 'string' && item.body.trim()
          ? item.body.trim()
          : (typeof item.note === 'string' && item.note.trim() ? item.note.trim() : ''));
      if (detail) {
        normalized.detail = detail;
      }

      const tone = normalizeRenderTone(item.tone);
      if (tone) {
        normalized.tone = tone;
      }

      if (item.featured === true) {
        normalized.featured = true;
      }

      return normalized;
    });
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
      .map((dataset, datasetIndex) => {
        const normalizedDataset = {
          label: typeof dataset.label === 'string' && dataset.label.trim()
            ? dataset.label
            : `Series ${datasetIndex + 1}`,
          data: Array.isArray(dataset.data)
            ? dataset.data.map((value) => {
              const parsed = Number(value);
              return Number.isFinite(parsed) ? parsed : 0;
            })
            : []
        };

        if (dataset.type === 'line' || dataset.type === 'bar') {
          normalizedDataset.type = dataset.type;
        }
        if (typeof dataset.stack === 'string' && dataset.stack.trim()) {
          normalizedDataset.stack = dataset.stack.trim();
        }

        [
          'backgroundColor',
          'borderColor',
          'pointBackgroundColor',
          'pointBorderColor'
        ].forEach((key) => {
          if (typeof dataset[key] === 'string' && dataset[key].trim()) {
            normalizedDataset[key] = dataset[key].trim();
          }
        });

        return normalizedDataset;
      })
    : [];

  if (datasets.length === 0) {
    return null;
  }

  const normalizedChart = {
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

  if (typeof chart.subtitle === 'string' && chart.subtitle.trim()) {
    normalizedChart.subtitle = chart.subtitle.trim();
  }

  const display = normalizeChartDisplay(chart.display);
  if (display) {
    normalizedChart.display = display;
  }

  const annotations = normalizeChartAnnotations(chart.annotations);
  if (annotations.length > 0) {
    normalizedChart.annotations = annotations;
  }

  const insights = normalizeInsightItems(chart.insights, 'chart-insight');
  if (insights.length > 0) {
    normalizedChart.insights = insights;
  }

  return normalizedChart;
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

  const pbsScenarioCharts = getActivePbsScenarioCharts(module);
  if (pbsScenarioCharts) {
    return {
      ...module,
      generated: {
        ...(module.generated || {}),
        charts: pbsScenarioCharts
      }
    };
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

  if (isCollegeFundingModule(module)) {
    const generatedCharts = Array.isArray(module.generated?.charts) ? module.generated.charts : [];
    if (generatedCharts.length > 0) {
      return module;
    }

    const projection = getCollegeProjection(module);
    if (!projection) {
      return module;
    }

    return {
      ...module,
      generated: {
        ...(module.generated || {}),
        charts: projection.charts
      }
    };
  }

  if (!isEducationModule(module)) {
    return getCalculatedDisplayModule(module);
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
  return isPensionModule(module) || isNetRetirementModule(module) || isMortgageModule(module);
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

function canEditGeneratedText(editContext) {
  return Boolean(
    editContext
    && !editContext.readOnly
    && editContext.module?.id
    && typeof editContext.onEditGeneratedText === 'function'
  );
}

function normalizeEditableTextValue(value, { html = false } = {}) {
  const text = html ? sanitizeSummaryHtml(String(value ?? '')) : String(value ?? '');
  return html ? text : text.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

function setEditableElementValue(element, value, { html = false } = {}) {
  if (html) {
    element.innerHTML = sanitizeSummaryHtml(value);
    return;
  }
  element.textContent = value;
}

function decorateInlineGeneratedEdit(element, editContext, path, {
  html = false,
  multiline = false,
  valueType = 'string',
  label = 'Edit text'
} = {}) {
  if (!(element instanceof HTMLElement) || !Array.isArray(path) || !canEditGeneratedText(editContext)) {
    return element;
  }

  element.classList.add('generated-inline-editable');
  element.contentEditable = 'true';
  element.spellcheck = true;
  element.dataset.generatedEditPath = path.join('.');
  element.dataset.generatedEditMode = html ? 'html' : 'text';
  element.dataset.generatedEditLabel = label;
  element.setAttribute('role', 'textbox');
  element.setAttribute('aria-label', label);
  if (multiline) {
    element.setAttribute('aria-multiline', 'true');
  }
  if (element.tabIndex < 0) {
    element.tabIndex = 0;
  }

  let originalValue = '';
  let canceled = false;
  const getCurrentValue = () => normalizeEditableTextValue(html ? element.innerHTML : element.textContent, { html });

  element.addEventListener('focus', () => {
    canceled = false;
    originalValue = getCurrentValue();
  });

  element.addEventListener('paste', (event) => {
    if (html) {
      return;
    }
    const text = event.clipboardData?.getData('text/plain') || '';
    if (!text) {
      return;
    }
    event.preventDefault();
    document.execCommand('insertText', false, text);
  });

  element.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      canceled = true;
      setEditableElementValue(element, originalValue, { html });
      element.blur();
      return;
    }

    const shouldCommit = event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey);
    if (shouldCommit) {
      event.preventDefault();
      element.blur();
    }
  });

  element.addEventListener('blur', () => {
    if (canceled) {
      return;
    }

    const value = getCurrentValue();
    if (value === originalValue) {
      return;
    }

    Promise.resolve(editContext.onEditGeneratedText({
      moduleId: editContext.module.id,
      path,
      value,
      valueType,
      html
    })).catch(() => {
      setEditableElementValue(element, originalValue, { html });
    });
  });

  return element;
}

function getTopLevelGeneratedCards(section) {
  if (!section) {
    return [];
  }

  return [...section.querySelectorAll('.generated-card, .report-block')]
    .filter((card) => !card.parentElement?.closest('.generated-card, .report-block'));
}

function orderGeneratedCards(section, module) {
  const order = Array.isArray(module?.ui?.cardOrder) ? module.ui.cardOrder : [];
  if (order.length === 0) {
    return;
  }

  const ranks = new Map(order.map((cardId, index) => [cardId, index]));
  const grouped = new Map();
  getTopLevelGeneratedCards(section).forEach((card, index) => {
    const parent = card.parentElement;
    if (!parent) {
      return;
    }
    if (!grouped.has(parent)) {
      grouped.set(parent, []);
    }
    grouped.get(parent).push({ card, index });
  });

  grouped.forEach((items, parent) => {
    const sorted = [...items].sort((left, right) => {
      const leftRank = ranks.has(left.card.dataset.moduleCardId)
        ? ranks.get(left.card.dataset.moduleCardId)
        : Number.POSITIVE_INFINITY;
      const rightRank = ranks.has(right.card.dataset.moduleCardId)
        ? ranks.get(right.card.dataset.moduleCardId)
        : Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.index - right.index;
    });
    sorted.forEach(({ card }) => parent.appendChild(card));
  });
}

function getVisibleGeneratedCardOrder(section) {
  return getTopLevelGeneratedCards(section)
    .map((card) => card.dataset.moduleCardId || '')
    .filter(Boolean);
}

function addGeneratedCardDragHandle(card, label = 'section') {
  const actions = card.querySelector(':scope > .generated-card-header .generated-card-header-actions, :scope > .report-block-header .generated-card-header-actions');
  const controlHost = actions || card;
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'generated-card-drag-handle';
  handle.textContent = '::';
  handle.title = `Move ${label}`;
  handle.setAttribute('aria-label', `Move ${label}`);
  controlHost.prepend(handle);
}

function enableGeneratedCardSorting(section, {
  onReorderCards = null
} = {}) {
  if (!section || typeof onReorderCards !== 'function' || typeof window.Sortable === 'undefined') {
    return;
  }

  const parents = new Set(getTopLevelGeneratedCards(section).map((card) => card.parentElement).filter(Boolean));
  parents.forEach((parent) => {
    if (parent.dataset.generatedSortableReady === 'true') {
      return;
    }
    parent.dataset.generatedSortableReady = 'true';
    window.Sortable.create(parent, {
      animation: 160,
      draggable: '.is-reorderable-generated-card',
      handle: '.generated-card-drag-handle',
      ghostClass: 'generated-card-drag-ghost',
      chosenClass: 'generated-card-drag-chosen',
      dragClass: 'generated-card-dragging',
      onEnd: () => {
        onReorderCards(getVisibleGeneratedCardOrder(section));
      }
    });
  });
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
        placeholder: '2%',
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
      },
      grossrentalincometoday: {
        field: 'rentalIncomeToday',
        value: draftValues.rentalIncomeToday ?? formatNumberForInput(pensionInputs.rentalIncomeToday, 2),
        placeholder: '18000',
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

  if (isNetRetirementModule(module)) {
    const netInputs = module.generated.netRetirementInputs;
    const netFieldMap = {
      currentage: {
        field: 'currentAge',
        value: draftValues.currentAge ?? formatNumberForInput(netInputs.currentAge, 0),
        placeholder: '60',
        inputMode: 'numeric'
      },
      projectionendage: {
        field: 'horizonEndAge',
        value: draftValues.horizonEndAge ?? formatNumberForInput(netInputs.horizonEndAge, 0),
        placeholder: '100',
        inputMode: 'numeric'
      },
      annualnetexpendituretoday: {
        field: 'annualExpenditureToday',
        value: draftValues.annualExpenditureToday ?? formatNumberForInput(netInputs.annualExpenditureToday, 2),
        placeholder: '90000',
        inputMode: 'decimal'
      },
      expenditureinflation: {
        field: 'expenditureInflationRate',
        value: draftValues.expenditureInflationRate ?? formatRateForInput(netInputs.expenditureInflationRate),
        placeholder: '2%',
        inputMode: 'decimal'
      },
      presentvaluenetgrowthrate: {
        field: 'presentValueRate',
        value: draftValues.presentValueRate ?? formatRateForInput(netInputs.presentValueRate),
        placeholder: '4%',
        inputMode: 'decimal'
      },
      availableinvestmentfundtoday: {
        field: 'availableInvestmentFundToday',
        value: draftValues.availableInvestmentFundToday ?? formatNumberForInput(netInputs.availableInvestmentFundToday, 2),
        placeholder: '1027000',
        inputMode: 'decimal'
      }
    };

    const descriptor = netFieldMap[labelToken];
    if (!descriptor) {
      return null;
    }

    return buildInlineAssumptionInputCell({
      module,
      calculator: 'netRetirement',
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
  readOnly = false,
  onEditGeneratedText = null
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
  const allowGenericTableEdit = !hasInlineEditor && !blocksGeneratedTableEditing(module);

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
        calculator: isPensionModule(module)
          ? 'pension'
          : (isNetRetirementModule(module) ? 'netRetirement' : 'mortgage')
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
  columns.forEach((column, columnIndex) => {
    const th = document.createElement('th');
    th.textContent = normalizeCurrencyLabelText(column);
    if (allowGenericTableEdit) {
      decorateInlineGeneratedEdit(th, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'assumptions', 'columns', columnIndex], {
        valueType: 'string',
        label: 'Edit assumption column'
      });
    }
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
      const isRowLabelCell = index === 0 && columns.length > 1;
      const cellText = formatGeneratedTableCell(safeRow[index], {
        cardTitle: 'Assumptions',
        rowLabel,
        columnLabel: columns[index],
        isRowLabelCell
      });

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
        if (allowGenericTableEdit) {
          decorateInlineGeneratedEdit(td, {
            module,
            readOnly,
            onEditGeneratedText
          }, ['generated', 'assumptions', 'rows', rowIndex, index], {
            valueType: typeof safeRow[index] === 'number' ? 'number' : 'string',
            label: 'Edit assumption cell'
          });
        }
      }

      if (isCurrencyTableContext({
        cardTitle: 'Assumptions',
        rowLabel,
        columnLabel: columns[index],
        isRowLabelCell
      })) {
        td.classList.add('generated-money-cell');
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
  tableKind = '',
  editBasePath = null,
  editTitlePath = null,
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const card = document.createElement('section');
  card.className = 'generated-card generated-table-card';
  if (dataGeneratedCard) {
    card.dataset.generatedCard = dataGeneratedCard;
  }

  const { header } = buildGeneratedCardHeader(cardTitle);
  const titleEl = header.querySelector('.generated-card-title');
  decorateInlineGeneratedEdit(titleEl, {
    module,
    readOnly,
    onEditGeneratedText
  }, editTitlePath, {
    valueType: 'string',
    label: `Edit ${cardTitle} title`
  });
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

  columns.forEach((column, columnIndex) => {
    const th = document.createElement('th');
    th.textContent = normalizeCurrencyLabelText(column);
    decorateInlineGeneratedEdit(th, {
      module,
      readOnly,
      onEditGeneratedText
    }, Array.isArray(editBasePath) ? [...editBasePath, 'columns', columnIndex] : null, {
      valueType: 'string',
      label: `Edit ${cardTitle} column`
    });
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
      const isRowLabelCell = index === 0 && columns.length > 1;
      td.textContent = formatGeneratedTableCell(safeRow[index], {
        cardTitle,
        rowLabel: safeRow[0],
        columnLabel: column,
        isRowLabelCell
      });
      decorateInlineGeneratedEdit(td, {
        module,
        readOnly,
        onEditGeneratedText
      }, Array.isArray(editBasePath) ? [...editBasePath, 'rows', rowIndex, index] : null, {
        valueType: typeof safeRow[index] === 'number' ? 'number' : 'string',
        label: `Edit ${cardTitle} cell`
      });

      if (isCurrencyTableContext({
        cardTitle,
        rowLabel: safeRow[0],
        columnLabel: column,
        isRowLabelCell
      })) {
        td.classList.add('generated-money-cell');
      }

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

function normalizeReadableLabelText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPbsNetWorthSummaryLabel(value) {
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

function findOutputsBucketedSection(sections, targetKey) {
  const targetToken = normalizeSectionToken(targetKey);
  return sections.find((section) => (
    normalizeSectionToken(section?.key) === targetToken
    || normalizeSectionToken(section?.title) === targetToken
  )) || null;
}

function findOutputsBucketedSectionByKey(sections, targetKey) {
  const targetToken = normalizeSectionToken(targetKey);
  return (Array.isArray(sections) ? sections : []).find((section) => (
    normalizeSectionToken(section?.key) === targetToken
  )) || null;
}

function isOutputsBucketedSummarySection(section) {
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

function findOutputsBucketedSummarySection(sections) {
  const list = Array.isArray(sections) ? sections : [];
  return findOutputsBucketedSectionByKey(list, 'summary')
    || findOutputsBucketedSection(list, 'summary')
    || list.find((section) => isOutputsBucketedSummarySection(section))
    || null;
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

function hasPersonalBalanceSheetBucketShape(outputsBucketed) {
  if (!hasOutputsBucketed(outputsBucketed)) {
    return false;
  }

  return ['lifestyle', 'liquidity', 'longevity', 'legacy']
    .every((key) => Boolean(
      findOutputsBucketedSectionByKey(outputsBucketed.sections, key)
      || findOutputsBucketedSection(outputsBucketed.sections, key)
    ));
}

function isPersonalBalanceSheetModule(module) {
  if (module?.generated?.pbsInputs) {
    return true;
  }

  if (hasPersonalBalanceSheetBucketShape(module?.generated?.outputsBucketed)) {
    return true;
  }

  const title = typeof module?.title === 'string' ? module.title.toLowerCase() : '';
  return title.includes('personal balance sheet');
}

function getPositiveFiniteNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
}

function getFiniteNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function getOptionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  return getFiniteNumber(value);
}

function formatBucketedCurrency(value, currencySymbol = '€') {
  const numericValue = getFiniteNumber(value);
  if (numericValue === null) {
    return '';
  }

  const symbol = normalizeDisplayCurrencySymbol(currencySymbol);
  return `${numericValue < 0 ? '-' : ''}${symbol}${formatBucketedAmount(Math.abs(numericValue))}`;
}

function getOutputsBucketedSubtotal(section) {
  const subtotalValue = getOptionalFiniteNumber(section?.subtotalValue);
  if (subtotalValue !== null) {
    return subtotalValue;
  }

  return sanitizeSectionRows(section?.rows)
    .reduce((sum, row) => sum + row[1], 0);
}

function computeReserveMonthsAssessment(reserveValue, annualExpenditure, {
  warningThreshold = 3,
  healthyThreshold = 6,
  thresholdContext = ''
} = {}) {
  const normalizedAnnualExpenditure = getPositiveFiniteNumber(annualExpenditure);
  const normalizedReserveValue = Number(reserveValue);
  if (normalizedAnnualExpenditure === null || !Number.isFinite(normalizedReserveValue)) {
    return null;
  }

  const monthlyExpenditure = normalizedAnnualExpenditure / 12;
  if (!Number.isFinite(monthlyExpenditure) || monthlyExpenditure <= 0) {
    return null;
  }

  const months = normalizedReserveValue / monthlyExpenditure;
  let tone = 'negative';
  if (months >= healthyThreshold) {
    tone = 'positive';
  } else if (months >= warningThreshold) {
    tone = 'warning';
  }

  const monthsText = formatReserveMonths(months);
  const warningThresholdText = formatReserveMonths(warningThreshold);
  const healthyThresholdText = formatReserveMonths(healthyThreshold);
  const thresholdContextText = thresholdContext
    ? ` ${thresholdContext}`
    : '';
  return {
    annualExpenditure: normalizedAnnualExpenditure,
    explainerLabel: 'What the liquidity buffer means',
    explainerText: `${monthsText} months of spending buffer, based on liquid assets divided by stated monthly spending. It shows the near-term breathing room before touching longer-term assets. Click to view threshold table.`,
    explanation: {
      currentLabel: `${monthsText} months`,
      description: `Liquidity compares cash or near-cash reserves with stated monthly spending to show how much short-term breathing room is visible before touching longer-term assets.${thresholdContextText}`,
      formula: 'Liquidity subtotal / (annual expenditure / 12)',
      rows: [
        {
          tone: 'negative',
          status: 'Red',
          classification: 'Pressure warning',
          range: `Under ${warningThresholdText} months`
        },
        {
          tone: 'warning',
          status: 'Yellow',
          classification: 'Watch zone',
          range: `${warningThresholdText} to under ${healthyThresholdText} months`
        },
        {
          tone: 'positive',
          status: 'Green',
          classification: 'Healthier buffer',
          range: `${healthyThresholdText}+ months`
        }
      ],
      title: 'Liquidity buffer'
    },
    monthlyExpenditure,
    months,
    label: `${monthsText} mo buffer`,
    ariaLabel: `Liquidity buffer ${monthsText} months`,
    reserveValue: normalizedReserveValue,
    tone
  };
}

function isRetiredPbsCase(pbsInputs = {}) {
  const retirementStatus = typeof pbsInputs.retirementStatus === 'string'
    ? pbsInputs.retirementStatus.trim().toLowerCase()
    : '';
  const currentAge = getPositiveFiniteNumber(pbsInputs.currentAge);

  return retirementStatus === 'retired' || (currentAge !== null && currentAge >= 65);
}

function formatReserveMonths(value) {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });
}

function formatReserveMultiple(value) {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });
}

function computeLongevityPressureAssessment(reserveValue, annualExpenditure, currentAge) {
  const normalizedAnnualExpenditure = getPositiveFiniteNumber(annualExpenditure);
  const normalizedCurrentAge = getPositiveFiniteNumber(currentAge);
  const normalizedReserveValue = getFiniteNumber(reserveValue);
  if (
    normalizedAnnualExpenditure === null
    || normalizedCurrentAge === null
    || normalizedReserveValue === null
  ) {
    return null;
  }

  const reserveMultiple = normalizedReserveValue / normalizedAnnualExpenditure;
  if (!Number.isFinite(reserveMultiple)) {
    return null;
  }

  let warningThreshold = 4;
  let healthyThreshold = 8;
  if (normalizedCurrentAge < 40) {
    warningThreshold = 2;
    healthyThreshold = 5;
  } else if (normalizedCurrentAge >= 55) {
    warningThreshold = 6;
    healthyThreshold = 12;
  }

  let tone = 'negative';
  let label = 'Higher pressure';
  if (reserveMultiple >= healthyThreshold) {
    tone = 'positive';
    label = 'Lower pressure';
  } else if (reserveMultiple >= warningThreshold) {
    tone = 'warning';
    label = 'Moderate pressure';
  }

  const multipleText = formatReserveMultiple(reserveMultiple);
  const warningThresholdText = formatReserveMultiple(warningThreshold);
  const healthyThresholdText = formatReserveMultiple(healthyThreshold);
  let ageBandText = 'Age 40 to 54';
  if (normalizedCurrentAge < 40) {
    ageBandText = 'Under age 40';
  } else if (normalizedCurrentAge >= 55) {
    ageBandText = 'Age 55+';
  }

  return {
    annualExpenditure: normalizedAnnualExpenditure,
    currentAge: normalizedCurrentAge,
    explainerLabel: 'What the longevity pressure means',
    explainerText: `Longevity assets are ${multipleText} times stated annual spending. This is a quick pressure check for how much future-income funding is already visible in the long-term bucket. Click to view threshold table.`,
    explanation: {
      currentLabel: `${multipleText}x annual spending`,
      description: `Longevity compares pensions and long-term investment assets with stated annual spending. The thresholds adjust by age band because the time left to fund later-life income changes the pressure reading. Current age band: ${ageBandText}.`,
      formula: 'Longevity subtotal / annual expenditure',
      rows: [
        {
          tone: 'negative',
          status: 'Red',
          classification: 'Higher pressure',
          range: `Under ${warningThresholdText}x`
        },
        {
          tone: 'warning',
          status: 'Yellow',
          classification: 'Moderate pressure',
          range: `${warningThresholdText}x to under ${healthyThresholdText}x`
        },
        {
          tone: 'positive',
          status: 'Green',
          classification: 'Lower pressure',
          range: `${healthyThresholdText}x+`
        }
      ],
      title: 'Longevity pressure'
    },
    label,
    ariaLabel: `Longevity pressure ${label.toLowerCase()}, longevity assets ${multipleText} times annual spending`,
    reserveMultiple,
    reserveValue: normalizedReserveValue,
    supportText: `${multipleText}x annual spending`,
    tone
  };
}

function getHfcsNetWorthDataset() {
  const dataset = HFCS_NET_WORTH_DATA?.hfcs2023;
  if (!isPlainObject(dataset)) {
    return null;
  }

  return dataset;
}

function getHfcsAgeBandMeta(currentAge) {
  const normalizedCurrentAge = getPositiveFiniteNumber(currentAge);
  if (normalizedCurrentAge === null) {
    return null;
  }

  return HFCS_AGE_BAND_META.find((band) => normalizedCurrentAge < band.maxAgeExclusive) || null;
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

function getPbsSummaryNetWorthValue(summarySection) {
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

function getOutputsBucketedCurrencySymbol(outputsBucketed) {
  return normalizeDisplayCurrencySymbol(outputsBucketed?.currencySymbol, '€');
}

function getPbsScenarioTitle(rawTitle, fallbackTitle) {
  const title = typeof rawTitle === 'string' && rawTitle.trim()
    ? rawTitle.trim()
    : fallbackTitle;
  const withoutTrailingScenario = title.replace(/\s+scenario$/i, '').trim();
  return withoutTrailingScenario || fallbackTitle;
}

function getPbsScenarioCases(outputsBucketed, summaryHtml = '') {
  const scenarios = Array.isArray(outputsBucketed?.scenarios)
    ? outputsBucketed.scenarios
    : [];
  const cases = [
    {
      id: PBS_CURRENT_SCENARIO_ID,
      title: 'Current position',
      summaryHtml,
      sections: outputsBucketed.sections,
      movements: []
    }
  ];

  scenarios.forEach((scenario, index) => {
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
      return;
    }

    if (!Array.isArray(scenario.sections) || scenario.sections.length === 0) {
      return;
    }

    const fallbackTitle = `Alternative ${index + 1}`;
    const rawId = typeof scenario.id === 'string' && scenario.id.trim()
      ? scenario.id.trim()
      : `scenario-${index + 1}`;

    cases.push({
      id: rawId,
      title: getPbsScenarioTitle(scenario.title, fallbackTitle),
      summaryHtml: typeof scenario.summaryHtml === 'string' && scenario.summaryHtml.trim()
        ? scenario.summaryHtml
        : summaryHtml,
      sections: scenario.sections,
      movements: Array.isArray(scenario.movements) ? scenario.movements : []
    });
  });

  return cases;
}

function getOutputsBucketedForPbsCase(outputsBucketed, pbsCase) {
  return {
    currencySymbol: getOutputsBucketedCurrencySymbol(outputsBucketed),
    sections: Array.isArray(pbsCase?.sections) ? pbsCase.sections : []
  };
}

function getPbsScenarioChartSubtitle(pbsCase, fallback = '') {
  if (pbsCase?.id === PBS_CURRENT_SCENARIO_ID) {
    return fallback || 'Current position';
  }

  return pbsCase?.title ? `${pbsCase.title} position` : (fallback || 'Selected case');
}

function copyChartDatasetStyle(dataset, fallbackLabel) {
  const normalized = {
    label: typeof dataset?.label === 'string' && dataset.label.trim()
      ? dataset.label
      : fallbackLabel
  };

  [
    'backgroundColor',
    'borderColor',
    'pointBackgroundColor',
    'pointBorderColor'
  ].forEach((key) => {
    if (typeof dataset?.[key] === 'string' && dataset[key].trim()) {
      normalized[key] = dataset[key];
    }
  });

  return normalized;
}

function getPbsScenarioAssetChart(template, outputsBucketed, pbsCase) {
  const sections = Array.isArray(outputsBucketed?.sections) ? outputsBucketed.sections : [];
  const labels = ['Lifestyle', 'Liquidity', 'Longevity', 'Legacy'];
  const data = PBS_ASSET_SECTION_KEYS.map((key) => {
    const section = findOutputsBucketedSectionByKey(sections, key)
      || findOutputsBucketedSection(sections, key);
    return section ? getOutputsBucketedSubtotal(section) : 0;
  });
  const templateDataset = Array.isArray(template?.datasets) ? template.datasets[0] : null;

  return {
    ...(template || {}),
    title: template?.title || 'Assets by bucket',
    subtitle: getPbsScenarioChartSubtitle(pbsCase, template?.subtitle),
    type: 'bar',
    labels,
    datasets: [
      {
        ...copyChartDatasetStyle(templateDataset, 'Assets'),
        data
      }
    ],
    display: {
      ...(isPlainObject(template?.display) ? template.display : {}),
      valueFormat: 'currency'
    },
    insights: Array.isArray(template?.insights) ? template.insights : []
  };
}

function getPbsScenarioBalanceChart(template, outputsBucketed, pbsCase) {
  const metrics = getPbsBalanceMetrics(outputsBucketed);
  const templateDataset = Array.isArray(template?.datasets) ? template.datasets[0] : null;

  return {
    ...(template || {}),
    title: template?.title || 'Gross assets vs liabilities vs net worth',
    subtitle: getPbsScenarioChartSubtitle(pbsCase, template?.subtitle),
    type: 'bar',
    labels: ['Gross assets', 'Total liabilities', 'Net worth'],
    datasets: [
      {
        ...copyChartDatasetStyle(templateDataset, 'Amount'),
        data: [
          metrics.grossAssets ?? 0,
          metrics.grossLiabilities ?? 0,
          metrics.netAssets ?? 0
        ]
      }
    ],
    display: {
      ...(isPlainObject(template?.display) ? template.display : {}),
      valueFormat: 'currency'
    },
    insights: Array.isArray(template?.insights) ? template.insights : []
  };
}

function getPbsScenarioCharts(module, outputsBucketed, pbsCase) {
  const charts = Array.isArray(module?.generated?.charts) ? module.generated.charts : [];
  if (!hasPersonalBalanceSheetBucketShape(outputsBucketed) || charts.length === 0) {
    return [];
  }

  return charts.map((chart) => {
    const titleToken = normalizeSectionToken(chart?.title || '');
    if (titleToken === 'assetsbybucket') {
      return getPbsScenarioAssetChart(chart, outputsBucketed, pbsCase);
    }

    if (
      titleToken === 'grossassetsvsliabilitiesvsnetworth'
      || titleToken === 'grossassetsliabilitiesnetworth'
    ) {
      return getPbsScenarioBalanceChart(chart, outputsBucketed, pbsCase);
    }

    return chart;
  });
}

function setActivePbsScenarioCharts(module, outputsBucketed, pbsCase) {
  if (!module?.id) {
    return [];
  }

  const charts = getPbsScenarioCharts(module, outputsBucketed, pbsCase);
  if (charts.length > 0) {
    activePbsScenarioChartsByModuleId.set(module.id, {
      charts,
      scenarioId: pbsCase?.id || PBS_CURRENT_SCENARIO_ID
    });
  } else {
    activePbsScenarioChartsByModuleId.delete(module.id);
  }

  return charts;
}

function getActivePbsScenarioCharts(module) {
  if (!isPersonalBalanceSheetModule(module) || !module?.id) {
    return null;
  }

  const active = activePbsScenarioChartsByModuleId.get(module.id);
  return Array.isArray(active?.charts) && active.charts.length > 0 ? active.charts : null;
}

function getPbsChartsForDisplay(module, generated = module?.generated || {}) {
  const activeCharts = getActivePbsScenarioCharts(module);
  if (activeCharts) {
    return activeCharts;
  }

  return Array.isArray(generated?.charts) ? generated.charts : [];
}

function notifyPbsScenarioChartsUpdated(module, pbsCase) {
  if (typeof window === 'undefined' || typeof window.CustomEvent !== 'function') {
    return;
  }

  window.dispatchEvent(new CustomEvent(PBS_SCENARIO_CHARTS_UPDATED_EVENT, {
    detail: {
      moduleId: module?.id || '',
      scenarioId: pbsCase?.id || PBS_CURRENT_SCENARIO_ID
    }
  }));
}

function updatePbsScenarioChartsCard(module, outputsBucketed, pbsCase, contentHost) {
  const charts = setActivePbsScenarioCharts(module, outputsBucketed, pbsCase);
  const generatedSection = contentHost?.closest('.generated-section');
  const grid = generatedSection?.querySelector('.generated-grid');
  const existingChartCard = grid?.querySelector('[data-generated-card="charts"]');
  if (!grid || !existingChartCard) {
    return;
  }

  const chartModule = {
    ...module,
    generated: {
      ...(module.generated || {}),
      charts
    }
  };
  existingChartCard.replaceWith(buildChartsCard(chartModule, charts, {
    showPensionToggle: false
  }));

  requestAnimationFrame(() => notifyPbsScenarioChartsUpdated(module, pbsCase));
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

function closeActivePbsInfoPopover({ restoreFocus = false } = {}) {
  if (!activePbsInfoButton) {
    return;
  }

  const button = activePbsInfoButton;
  const wrap = button.closest('.pbs-bucket-info');
  if (wrap) {
    wrap.classList.remove('is-open');
  }
  button.setAttribute('aria-expanded', 'false');
  activePbsInfoButton = null;

  if (restoreFocus) {
    button.focus();
  }
}

function setPbsInfoPopoverOpen(button, shouldOpen) {
  if (!button) {
    return;
  }

  if (!shouldOpen) {
    closeActivePbsInfoPopover();
    return;
  }

  if (activePbsInfoButton && activePbsInfoButton !== button) {
    closeActivePbsInfoPopover();
  }

  const wrap = button.closest('.pbs-bucket-info');
  if (!wrap) {
    return;
  }

  wrap.classList.add('is-open');
  button.setAttribute('aria-expanded', 'true');
  activePbsInfoButton = button;
}

function ensurePbsInfoDismissHandlers() {
  if (pbsInfoDismissHandlersBound || typeof document === 'undefined') {
    return;
  }

  document.addEventListener('click', (event) => {
    if (!activePbsInfoButton) {
      return;
    }

    const wrap = activePbsInfoButton.closest('.pbs-bucket-info');
    if (wrap && event.target instanceof Node && wrap.contains(event.target)) {
      return;
    }

    closeActivePbsInfoPopover();
  });

  const handleDismissKeydown = (event) => {
    if (event.key === 'Escape') {
      if (activePbsExplanationModal) {
        closeActivePbsExplanationModal();
        return;
      }

      closeActivePbsInfoPopover({ restoreFocus: true });
    }
  };

  document.addEventListener('keydown', handleDismissKeydown);
  window.addEventListener('keydown', handleDismissKeydown);

  pbsInfoDismissHandlersBound = true;
}

function getPbsExplanationFocusableElements(container) {
  if (!container) {
    return [];
  }

  return Array.from(container.querySelectorAll([
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(','))).filter((element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    return element.offsetParent !== null || element === document.activeElement;
  });
}

function closeActivePbsExplanationModal({ restoreFocus = true } = {}) {
  if (!activePbsExplanationModal) {
    return;
  }

  const { overlay, triggerButton } = activePbsExplanationModal;
  activePbsExplanationModal = null;
  document.body.classList.remove('pbs-explanation-modal-open');
  overlay.classList.remove('is-open');
  window.setTimeout(() => {
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
  }, 160);

  if (restoreFocus && triggerButton) {
    triggerButton.focus();
  }
}

function buildPbsExplanationStatusPill({ tone, label }) {
  const pill = document.createElement('span');
  pill.className = 'pbs-health-badge pbs-explanation-current-pill';
  pill.dataset.tone = tone || 'neutral';
  pill.textContent = label || 'Current reading';
  return pill;
}

function openPbsExplanationModal(indicator, triggerButton) {
  const explanation = indicator?.explanation;
  if (!explanation || typeof document === 'undefined') {
    return false;
  }

  closeActivePbsInfoPopover();
  closeActivePbsExplanationModal({ restoreFocus: false });
  pbsInfoIdCounter += 1;
  const titleId = `pbs-explanation-title-${pbsInfoIdCounter}`;
  const descriptionId = `pbs-explanation-description-${pbsInfoIdCounter}`;

  const overlay = document.createElement('div');
  overlay.className = 'pbs-explanation-modal';

  const dialog = document.createElement('section');
  dialog.className = 'pbs-explanation-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.setAttribute('aria-describedby', descriptionId);

  const header = document.createElement('div');
  header.className = 'pbs-explanation-header';

  const headingCopy = document.createElement('div');
  headingCopy.className = 'pbs-explanation-heading-copy';

  const title = document.createElement('h3');
  title.id = titleId;
  title.className = 'pbs-explanation-title';
  title.textContent = explanation.title || indicator.explainerLabel || 'Buffer explanation';
  headingCopy.appendChild(title);

  const subtitle = document.createElement('p');
  subtitle.className = 'pbs-explanation-subtitle';
  subtitle.textContent = 'How the app reads this red, yellow, or green signal.';
  headingCopy.appendChild(subtitle);

  header.appendChild(headingCopy);
  header.appendChild(buildPbsExplanationStatusPill({
    tone: indicator.tone,
    label: indicator.label
  }));

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'pbs-explanation-close';
  closeButton.setAttribute('aria-label', 'Close explanation');
  closeButton.textContent = 'x';
  closeButton.addEventListener('click', () => {
    closeActivePbsExplanationModal();
  });
  header.appendChild(closeButton);
  dialog.appendChild(header);

  const body = document.createElement('div');
  body.className = 'pbs-explanation-body';

  const current = document.createElement('div');
  current.className = 'pbs-explanation-current';

  const currentLabel = document.createElement('span');
  currentLabel.className = 'pbs-explanation-kicker';
  currentLabel.textContent = 'Current reading';
  current.appendChild(currentLabel);

  const currentValue = document.createElement('strong');
  currentValue.className = 'pbs-explanation-current-value';
  currentValue.textContent = explanation.currentLabel || indicator.label;
  current.appendChild(currentValue);
  body.appendChild(current);

  const calc = document.createElement('section');
  calc.className = 'pbs-explanation-calc';

  const calcTitle = document.createElement('h4');
  calcTitle.textContent = 'How this is calculated';
  calc.appendChild(calcTitle);

  const description = document.createElement('p');
  description.id = descriptionId;
  description.textContent = explanation.description || indicator.explainerText || '';
  calc.appendChild(description);

  const formula = document.createElement('div');
  formula.className = 'pbs-explanation-formula';
  formula.textContent = explanation.formula || '';
  calc.appendChild(formula);
  body.appendChild(calc);

  const table = document.createElement('table');
  table.className = 'pbs-explanation-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Status', 'Classification', 'Range'].forEach((columnLabel) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = columnLabel;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  (Array.isArray(explanation.rows) ? explanation.rows : []).forEach((row) => {
    const tr = document.createElement('tr');
    tr.dataset.tone = row.tone || 'neutral';
    if (row.tone === indicator.tone) {
      tr.classList.add('is-current');
    }

    const statusCell = document.createElement('td');
    const status = document.createElement('span');
    status.className = 'pbs-explanation-status';
    status.dataset.tone = row.tone || 'neutral';
    status.textContent = row.status || '';
    statusCell.appendChild(status);
    tr.appendChild(statusCell);

    const classificationCell = document.createElement('td');
    classificationCell.textContent = row.classification || '';
    if (row.tone === indicator.tone) {
      const currentMarker = document.createElement('span');
      currentMarker.className = 'pbs-explanation-current-marker';
      currentMarker.textContent = 'Current';
      classificationCell.appendChild(currentMarker);
    }
    tr.appendChild(classificationCell);

    const rangeCell = document.createElement('td');
    rangeCell.textContent = row.range || '';
    tr.appendChild(rangeCell);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  body.appendChild(table);

  dialog.appendChild(body);
  overlay.appendChild(dialog);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closeActivePbsExplanationModal();
    }
  });

  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeActivePbsExplanationModal();
      return;
    }

    if (event.key !== 'Tab') {
      return;
    }

    const focusableElements = getPbsExplanationFocusableElements(dialog);
    if (focusableElements.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  });

  document.body.appendChild(overlay);
  document.body.classList.add('pbs-explanation-modal-open');
  activePbsExplanationModal = { overlay, triggerButton };

  window.requestAnimationFrame(() => {
    overlay.classList.add('is-open');
    closeButton.focus({ preventScroll: true });
  });

  return true;
}

function buildPbsInfoPopoverControl({
  className = '',
  text,
  ariaLabel,
  label,
  popoverKey,
  buttonClassName,
  buttonDataset = {},
  iconClassName = '',
  iconText = '',
  visibleText = '',
  onClick = null,
  opensDialog = false
}) {
  if (!text) {
    return null;
  }

  ensurePbsInfoDismissHandlers();
  pbsInfoIdCounter += 1;
  const popoverId = `pbs-info-${popoverKey}-${pbsInfoIdCounter}`;

  const wrap = document.createElement('span');
  wrap.className = ['pbs-bucket-info', className].filter(Boolean).join(' ');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = buttonClassName;
  button.setAttribute('aria-label', ariaLabel || label || 'More information');
  button.setAttribute('aria-describedby', popoverId);
  button.setAttribute('aria-expanded', 'false');
  if (opensDialog) {
    button.setAttribute('aria-haspopup', 'dialog');
  }
  Object.entries(buttonDataset).forEach(([key, value]) => {
    button.dataset[key] = value;
  });

  if (visibleText) {
    button.textContent = visibleText;
  }

  if (iconClassName) {
    const icon = document.createElement('span');
    icon.className = iconClassName;
    icon.setAttribute('aria-hidden', 'true');
    if (iconText) {
      icon.textContent = iconText;
    }
    button.appendChild(icon);
  }

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof onClick === 'function' && onClick(button) === true) {
      return;
    }
    setPbsInfoPopoverOpen(button, button.getAttribute('aria-expanded') !== 'true');
  });
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    button.click();
  });

  const popover = document.createElement('span');
  popover.id = popoverId;
  popover.className = 'pbs-bucket-info-popover';
  popover.setAttribute('role', 'tooltip');
  popover.textContent = text;

  wrap.appendChild(button);
  wrap.appendChild(popover);
  return wrap;
}

function buildPbsBucketInfoControl(sectionToken, title) {
  const definition = PBS_BUCKET_DEFINITIONS[sectionToken];
  if (!definition) {
    return null;
  }

  return buildPbsInfoPopoverControl({
    text: definition,
    ariaLabel: `What ${title} means`,
    popoverKey: sectionToken,
    buttonClassName: 'pbs-bucket-info-button',
    iconClassName: 'pbs-bucket-info-icon'
  });
}

function buildPbsBucketTitleLine(title, sectionToken) {
  const titleLine = document.createElement('div');
  titleLine.className = 'pbs-bucket-title-line';

  const heading = document.createElement('h4');
  heading.className = 'pbs-bucket-card-title';
  heading.textContent = title;
  titleLine.appendChild(heading);

  const infoControl = buildPbsBucketInfoControl(sectionToken, title);
  if (infoControl) {
    titleLine.appendChild(infoControl);
  }

  return titleLine;
}

function buildPbsLeadCopy(summaryHtml, guideText = '') {
  const safeHtml = sanitizeSummaryHtml(summaryHtml || '');
  const guideLine = buildClientGuideLine(safeHtml, guideText);
  if (!safeHtml && !guideLine) {
    return null;
  }

  const lead = document.createElement('div');
  lead.className = 'pbs-main-summary generated-summary-content';
  if (guideLine) {
    lead.appendChild(guideLine);
  }
  if (safeHtml) {
    const summary = document.createElement('div');
    summary.className = 'generated-summary-copy';
    summary.innerHTML = safeHtml;
    lead.appendChild(summary);
  }
  return lead;
}

function getPbsBalanceMetrics(outputsBucketed) {
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

function setPbsValueDataset(element, {
  key,
  value,
  format = 'currency',
  currencySymbol = '€'
} = {}) {
  const normalizedValue = getOptionalFiniteNumber(value);
  if (!key || normalizedValue === null) {
    return;
  }

  element.dataset.pbsValueKey = key;
  element.dataset.pbsValue = String(normalizedValue);
  element.dataset.pbsValueFormat = format;
  element.dataset.pbsCurrency = currencySymbol;
}

function getPbsSectionAnchorKey(sectionKey) {
  return `section:${normalizeSectionToken(sectionKey)}`;
}

function getPbsRowAnchorKey(sectionKey, rowLabel) {
  return `${getPbsSectionAnchorKey(sectionKey)}:row:${normalizeSectionToken(rowLabel)}`;
}

function buildPbsBalanceHeader(outputsBucketed, currencySymbol) {
  const metrics = getPbsBalanceMetrics(outputsBucketed);
  const metricItems = [
    { key: 'net-assets', label: 'Net assets', value: metrics.netAssets, isPrimary: true },
    { key: 'gross-assets', label: 'Gross assets', value: metrics.grossAssets },
    { key: 'gross-liabilities', label: 'Gross liabilities', value: metrics.grossLiabilities }
  ];
  const presentItems = metricItems.filter((item) => item.value !== null);

  if (presentItems.length === 0) {
    return null;
  }

  const header = document.createElement('section');
  header.className = 'pbs-balance-header';
  header.setAttribute('aria-label', 'Personal balance sheet totals');

  const netMetric = metricItems[0];
  if (netMetric.value !== null) {
    const netSlab = document.createElement('article');
    netSlab.className = 'pbs-balance-slab pbs-balance-slab-primary';
    netSlab.dataset.balanceMetric = netMetric.key;
    netSlab.dataset.pbsAnchorKey = `balance:${netMetric.key}`;

    const label = document.createElement('span');
    label.className = 'pbs-balance-label';
    label.textContent = netMetric.label;
    netSlab.appendChild(label);

    const value = document.createElement('span');
    value.className = 'pbs-balance-value';
    value.textContent = formatBucketedCurrency(netMetric.value, currencySymbol);
    setPbsValueDataset(value, {
      key: `balance:${netMetric.key}`,
      value: netMetric.value,
      format: 'currency',
      currencySymbol
    });
    netSlab.appendChild(value);

    const formula = document.createElement('span');
    formula.className = 'pbs-balance-formula';
    formula.textContent = 'Gross assets - gross liabilities';
    netSlab.appendChild(formula);

    header.appendChild(netSlab);
  }

  const stack = document.createElement('div');
  stack.className = 'pbs-balance-stack';
  metricItems.slice(1).forEach((item) => {
    if (item.value === null) {
      return;
    }

    const slab = document.createElement('article');
    slab.className = 'pbs-balance-slab';
    slab.dataset.balanceMetric = item.key;
    slab.dataset.pbsAnchorKey = `balance:${item.key}`;

    const label = document.createElement('span');
    label.className = 'pbs-balance-label';
    label.textContent = item.label;
    slab.appendChild(label);

    const value = document.createElement('span');
    value.className = 'pbs-balance-value pbs-balance-value-secondary';
    value.textContent = formatBucketedCurrency(item.value, currencySymbol);
    setPbsValueDataset(value, {
      key: `balance:${item.key}`,
      value: item.value,
      format: 'currency',
      currencySymbol
    });
    slab.appendChild(value);

    stack.appendChild(slab);
  });

  if (stack.childNodes.length > 0) {
    header.appendChild(stack);
  }

  return header;
}

function buildPbsBucketCard(section, {
  fallbackKey,
  sectionEnhancements = {},
  currencySymbol = '€',
  module = null,
  sectionIndex = -1,
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const sectionToken = normalizeSectionToken(section?.key || section?.title || fallbackKey);
  const indicator = sectionEnhancements[sectionToken]?.indicator || null;
  const sectionKey = normalizeSectionToken(fallbackKey || section?.key || section?.title);
  const title = typeof section.title === 'string' && section.title.trim()
    ? section.title
    : fallbackKey.charAt(0).toUpperCase() + fallbackKey.slice(1);
  const rows = sanitizeSectionRows(section.rows);
  const subtotalLabel = typeof section.subtotalLabel === 'string' && section.subtotalLabel.trim()
    ? section.subtotalLabel
    : 'Subtotal';
  const subtotalValue = getOptionalFiniteNumber(section.subtotalValue) ?? getOutputsBucketedSubtotal(section);

  const card = document.createElement('article');
  card.className = 'pbs-bucket-card';
  card.dataset.bucket = fallbackKey;
  card.dataset.pbsSectionKey = sectionKey;
  card.dataset.pbsAnchorKey = getPbsSectionAnchorKey(sectionKey);
  if (indicator) {
    card.dataset.healthTone = indicator.tone;
  }

  const header = document.createElement('div');
  header.className = 'pbs-bucket-card-header';

  const headingCopy = document.createElement('div');
  headingCopy.className = 'pbs-bucket-heading-copy';
  const titleLine = buildPbsBucketTitleLine(title, sectionToken);
  const titleElement = titleLine.querySelector('.pbs-bucket-card-title');
  decorateInlineGeneratedEdit(titleElement, {
    module,
    readOnly,
    onEditGeneratedText
  }, sectionIndex >= 0 ? ['generated', 'outputsBucketed', 'sections', sectionIndex, 'title'] : null, {
    valueType: 'string',
    label: 'Edit bucket title'
  });
  headingCopy.appendChild(titleLine);

  if (indicator?.supportText) {
    const supportText = document.createElement('span');
    supportText.className = 'pbs-section-support-text';
    supportText.textContent = indicator.supportText;
    headingCopy.appendChild(supportText);
  }

  header.appendChild(headingCopy);
  if (indicator) {
    header.appendChild(buildOutputsBucketedHealthBadge(indicator));
  }
  card.appendChild(header);

  const rowList = document.createElement('div');
  rowList.className = 'pbs-bucket-row-list';
  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'pbs-bucket-empty-state';
    empty.textContent = 'No assets listed.';
    rowList.appendChild(empty);
  } else {
    rows.forEach(([label, amount], rowIndex) => {
      const row = document.createElement('div');
      row.className = 'pbs-bucket-row';
      row.dataset.pbsSectionKey = sectionKey;
      row.dataset.pbsRowLabel = normalizeSectionToken(label);
      row.dataset.pbsAnchorKey = getPbsRowAnchorKey(sectionKey, label);

      const labelEl = document.createElement('span');
      labelEl.className = 'pbs-bucket-row-label';
      labelEl.textContent = label;
      decorateInlineGeneratedEdit(labelEl, {
        module,
        readOnly,
        onEditGeneratedText
      }, sectionIndex >= 0 ? ['generated', 'outputsBucketed', 'sections', sectionIndex, 'rows', rowIndex, 0] : null, {
        valueType: 'string',
        label: 'Edit bucket row label'
      });
      row.appendChild(labelEl);

      const amountEl = document.createElement('span');
      amountEl.className = 'pbs-bucket-row-amount';
      amountEl.textContent = formatBucketedCurrency(amount, currencySymbol);
      decorateInlineGeneratedEdit(amountEl, {
        module,
        readOnly,
        onEditGeneratedText
      }, sectionIndex >= 0 ? ['generated', 'outputsBucketed', 'sections', sectionIndex, 'rows', rowIndex, 1] : null, {
        valueType: 'number',
        label: 'Edit bucket amount'
      });
      setPbsValueDataset(amountEl, {
        key: `bucket:${sectionKey}:row:${normalizeSectionToken(label)}`,
        value: amount,
        currencySymbol
      });
      row.appendChild(amountEl);

      rowList.appendChild(row);
    });
  }
  card.appendChild(rowList);

  const total = document.createElement('div');
  total.className = 'pbs-bucket-total';

  const totalLabel = document.createElement('span');
  totalLabel.className = 'pbs-bucket-total-label';
  totalLabel.textContent = subtotalLabel;
  total.appendChild(totalLabel);

  const totalValue = document.createElement('span');
  totalValue.className = 'pbs-bucket-total-value';
  totalValue.textContent = formatBucketedCurrency(subtotalValue, currencySymbol);
  setPbsValueDataset(totalValue, {
    key: `bucket:${sectionKey}:subtotal`,
    value: subtotalValue,
    currencySymbol
  });
  total.appendChild(totalValue);

  card.appendChild(total);
  return card;
}

function buildHfcsBenchmarkDifferenceText(netWorth, benchmarkValue, benchmarkLabel, currencySymbol) {
  const difference = netWorth - benchmarkValue;
  if (difference > 0) {
    return `${formatBucketedCurrency(difference, currencySymbol)} above ${benchmarkLabel}`;
  }

  if (difference < 0) {
    return `${formatBucketedCurrency(Math.abs(difference), currencySymbol)} below ${benchmarkLabel}`;
  }

  return `In line with ${benchmarkLabel}`;
}

function buildHfcsWealthPositionText(netWorth, nationalMedianNetWorth, nationalNetWorthDeciles) {
  if (!isPlainObject(nationalNetWorthDeciles)) {
    return '';
  }

  if (netWorth === nationalMedianNetWorth) {
    return 'Around the national median for Irish households';
  }

  const matchingBand = HFCS_DECILE_BANDS.find((band) => {
    const upperBound = getFiniteNumber(nationalNetWorthDeciles[band.upperKey]);
    return upperBound !== null && netWorth <= upperBound;
  });

  if (!matchingBand) {
    return 'Richer than roughly 90% of Irish households';
  }

  if (matchingBand.lowerBoundPercent === 0) {
    return 'Within roughly the lower 10% of Irish households by net worth';
  }

  return `Richer than roughly ${matchingBand.lowerBoundPercent}% of Irish households`;
}

function computeNetWorthContext(netWorth, currentAge, currencySymbol = '€') {
  const dataset = getHfcsNetWorthDataset();
  const normalizedNetWorth = getFiniteNumber(netWorth);
  if (!dataset || normalizedNetWorth === null) {
    return null;
  }

  const nationalMedianNetWorth = getFiniteNumber(dataset.nationalMedianNetWorth);
  if (nationalMedianNetWorth === null) {
    return null;
  }

  const ageBand = getHfcsAgeBandMeta(currentAge);
  const ageBandMedian = ageBand
    ? getFiniteNumber(dataset.ageBandMedianNetWorth?.[ageBand.key])
    : null;
  const benchmarks = [
    {
      label: 'National median',
      valueText: formatBucketedCurrency(nationalMedianNetWorth, currencySymbol)
    }
  ];
  const supportingLines = [
    buildHfcsBenchmarkDifferenceText(
      normalizedNetWorth,
      nationalMedianNetWorth,
      'the national median',
      currencySymbol
    )
  ];

  if (ageBand && ageBandMedian !== null) {
    benchmarks.push({
      label: ageBand.benchmarkLabel,
      valueText: formatBucketedCurrency(ageBandMedian, currencySymbol)
    });
    supportingLines.push(
      buildHfcsBenchmarkDifferenceText(
        normalizedNetWorth,
        ageBandMedian,
        `the median for ${ageBand.householdLabel}`,
        currencySymbol
      )
    );
  }

  return {
    benchmarks,
    heroText: buildHfcsWealthPositionText(
      normalizedNetWorth,
      nationalMedianNetWorth,
      dataset.nationalNetWorthDeciles
    ),
    sourceLabel: typeof dataset.sourceLabel === 'string' && dataset.sourceLabel.trim()
      ? dataset.sourceLabel.trim()
      : 'CSO HFCS 2023',
    supportingLines
  };
}

function buildOutputsBucketedHealthBadge(indicator) {
  if (indicator.explainerText) {
    return buildPbsInfoPopoverControl({
      className: 'pbs-indicator-info',
      text: indicator.explainerText,
      ariaLabel: indicator.explainerLabel || indicator.ariaLabel,
      popoverKey: `indicator-${indicator.tone || 'neutral'}`,
      buttonClassName: 'pbs-health-badge',
      buttonDataset: {
        tone: indicator.tone
      },
      iconClassName: 'pbs-health-badge-info-icon',
      iconText: 'i',
      visibleText: indicator.label,
      onClick: indicator.explanation
        ? (button) => openPbsExplanationModal(indicator, button)
        : null,
      opensDialog: Boolean(indicator.explanation)
    });
  }

  const badge = document.createElement('span');
  badge.className = 'pbs-health-badge';
  badge.dataset.tone = indicator.tone;
  badge.textContent = indicator.label;
  if (indicator.ariaLabel) {
    badge.setAttribute('aria-label', indicator.ariaLabel);
  }
  return badge;
}

function buildOutputsBucketedSectionHeading(title, indicator) {
  if (!indicator) {
    return document.createTextNode(title);
  }

  const heading = document.createElement('div');
  heading.className = 'pbs-section-heading';

  const headingCopy = document.createElement('div');
  headingCopy.className = 'pbs-section-heading-copy';

  const titleText = document.createElement('span');
  titleText.className = 'pbs-section-heading-text';
  titleText.textContent = title;
  headingCopy.appendChild(titleText);

  if (indicator.supportText) {
    const supportText = document.createElement('span');
    supportText.className = 'pbs-section-support-text';
    supportText.textContent = indicator.supportText;
    headingCopy.appendChild(supportText);
  }

  heading.appendChild(headingCopy);
  heading.appendChild(buildOutputsBucketedHealthBadge(indicator));
  return heading;
}

function getOutputsBucketedSectionEnhancements(module, outputsBucketed) {
  const enhancements = {};
  if (!isPersonalBalanceSheetModule(module) || !hasOutputsBucketed(outputsBucketed)) {
    return enhancements;
  }

  const pbsInputs = module?.generated?.pbsInputs || {};
  const annualExpenditure = getPositiveFiniteNumber(pbsInputs.annualExpenditure);
  const currentAge = getPositiveFiniteNumber(pbsInputs.currentAge);
  const useRetiredLiquidityThresholds = isRetiredPbsCase(pbsInputs);

  if (annualExpenditure !== null) {
    const liquiditySection = findOutputsBucketedSectionByKey(outputsBucketed.sections, 'liquidity')
      || findOutputsBucketedSection(outputsBucketed.sections, 'liquidity');
    if (liquiditySection) {
      const indicator = computeReserveMonthsAssessment(
        getOutputsBucketedSubtotal(liquiditySection),
        annualExpenditure,
        useRetiredLiquidityThresholds
          ? {
            warningThreshold: 12,
            healthyThreshold: 24,
            thresholdContext: 'Because the client is retired or age 65+, the guide uses a one-to-two-year reserve range rather than the standard three-to-six-month working-age range.'
          }
          : {}
      );

      if (indicator) {
        enhancements.liquidity = { indicator };
      }
    }

    if (currentAge !== null) {
      const longevitySection = findOutputsBucketedSectionByKey(outputsBucketed.sections, 'longevity')
        || findOutputsBucketedSection(outputsBucketed.sections, 'longevity');
      if (longevitySection) {
        const indicator = computeLongevityPressureAssessment(
          getOutputsBucketedSubtotal(longevitySection),
          annualExpenditure,
          currentAge
        );

        if (indicator) {
          enhancements.longevity = { indicator };
        }
      }
    }
  }

  const summarySection = findOutputsBucketedSummarySection(outputsBucketed.sections);
  const netWorth = getPbsSummaryNetWorthValue(summarySection)
    ?? getPbsBalanceMetrics(outputsBucketed).netAssets;
  const netWorthContext = computeNetWorthContext(
    netWorth,
    currentAge,
    getOutputsBucketedCurrencySymbol(outputsBucketed)
  );

  if (netWorthContext) {
    enhancements.summary = {
      ...(enhancements.summary || {}),
      netWorthContext
    };
  }

  return enhancements;
}

function buildOutputsBucketedNetWorthContext(context) {
  const wrap = document.createElement('section');
  wrap.className = 'pbs-net-worth-context';

  const header = document.createElement('div');
  header.className = 'pbs-net-worth-context-header';

  const kicker = document.createElement('span');
  kicker.className = 'pbs-net-worth-context-kicker';
  kicker.textContent = 'IRISH HOUSEHOLD CONTEXT';
  header.appendChild(kicker);

  const source = document.createElement('span');
  source.className = 'pbs-net-worth-context-source';
  source.textContent = context.sourceLabel;
  header.appendChild(source);
  wrap.appendChild(header);

  if (typeof context.heroText === 'string' && context.heroText.trim()) {
    const hero = document.createElement('p');
    hero.className = 'pbs-net-worth-context-hero';
    hero.textContent = context.heroText.trim();
    wrap.appendChild(hero);
  }

  const benchmarks = document.createElement('div');
  benchmarks.className = 'pbs-net-worth-context-benchmarks';

  (Array.isArray(context.benchmarks) ? context.benchmarks : []).forEach(({ label, valueText }) => {
    if (!label || !valueText) {
      return;
    }

    const benchmark = document.createElement('div');
    benchmark.className = 'pbs-net-worth-benchmark';

    const benchmarkLabel = document.createElement('span');
    benchmarkLabel.className = 'pbs-net-worth-benchmark-label';
    benchmarkLabel.textContent = label;
    benchmark.appendChild(benchmarkLabel);

    const benchmarkValue = document.createElement('span');
    benchmarkValue.className = 'pbs-net-worth-benchmark-value';
    benchmarkValue.textContent = valueText;
    benchmark.appendChild(benchmarkValue);

    benchmarks.appendChild(benchmark);
  });
  if (benchmarks.childNodes.length > 0) {
    wrap.appendChild(benchmarks);
  }

  const supportingLines = Array.isArray(context.supportingLines)
    ? context.supportingLines.filter((line) => typeof line === 'string' && line.trim())
    : [];
  if (supportingLines.length > 0) {
    const support = document.createElement('div');
    support.className = 'pbs-net-worth-context-support';

    supportingLines.forEach((line) => {
      const supportLine = document.createElement('p');
      supportLine.className = 'pbs-net-worth-context-support-line';
      supportLine.textContent = line;
      support.appendChild(supportLine);
    });

    wrap.appendChild(support);
  }

  return wrap;
}

function shouldHideSummarySubtotal(section, rows, isSummary) {
  if (!isSummary) {
    return false;
  }

  const subtotalValue = getFiniteNumber(section?.subtotalValue);
  if (subtotalValue === null || !isPbsNetWorthSummaryLabel(section?.subtotalLabel)) {
    return false;
  }

  return rows.some(([label, value]) => (
    isPbsNetWorthSummaryLabel(label)
    && value === subtotalValue
  ));
}

function buildOutputsBucketedMiniTablesContent(outputsBucketed, sectionEnhancements = {}, {
  module = null,
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'pbs-bucket-tables';

  const currencySymbol = getOutputsBucketedCurrencySymbol(outputsBucketed);

  outputsBucketed.sections.forEach((section, sectionIndex) => {
    const sectionWrap = document.createElement('article');
    sectionWrap.className = 'pbs-bucket-section';

    const columns = Array.isArray(section.columns) && section.columns.length === 2
      ? section.columns
      : ['Asset', `Amount (${currencySymbol})`];
    const rows = sanitizeSectionRows(section.rows);
    const key = typeof section.key === 'string' ? section.key.toLowerCase() : '';
    const sectionToken = normalizeSectionToken(key || section.title || '');
    const isSummary = isOutputsBucketedSummarySection(section);
    const sectionEnhancement = sectionEnhancements[sectionToken]
      || (isSummary ? sectionEnhancements.summary : {})
      || {};
    const indicator = sectionEnhancement.indicator || null;
    const title = typeof section.title === 'string' && section.title.trim()
      ? section.title
      : `Section ${sectionIndex + 1}`;
    const subtotalLabel = typeof section.subtotalLabel === 'string' && section.subtotalLabel.trim()
      ? section.subtotalLabel
      : 'Subtotal';
    const hasSubtotal = Number.isFinite(Number(section.subtotalValue))
      && !shouldHideSummarySubtotal(section, rows, isSummary);

    const table = document.createElement('table');
    table.className = 'generated-table pbs-bucket-table';

    if (indicator) {
      sectionWrap.dataset.healthTone = indicator.tone;
    }

    const thead = document.createElement('thead');

    const titleRow = document.createElement('tr');
    titleRow.className = 'pbs-bucket-title-row';
    const titleCell = document.createElement('th');
    titleCell.colSpan = 2;
    const headingContent = buildOutputsBucketedSectionHeading(title, indicator);
    titleCell.appendChild(headingContent);
    const editableHeading = headingContent instanceof HTMLElement
      ? (headingContent.querySelector('.pbs-section-heading-text') || headingContent)
      : titleCell;
    decorateInlineGeneratedEdit(editableHeading, {
      module,
      readOnly,
      onEditGeneratedText
    }, ['generated', 'outputsBucketed', 'sections', sectionIndex, 'title'], {
      valueType: 'string',
      label: 'Edit output section title'
    });
    titleRow.appendChild(titleCell);
    thead.appendChild(titleRow);

    const headerRow = document.createElement('tr');
    columns.forEach((column, columnIndex) => {
      const th = document.createElement('th');
      th.textContent = normalizeCurrencyLabelText(column);
      decorateInlineGeneratedEdit(th, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'outputsBucketed', 'sections', sectionIndex, 'columns', columnIndex], {
        valueType: 'string',
        label: 'Edit output column'
      });
      if (columnIndex === 1) {
        th.classList.add('pbs-amount-col');
      }
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      const label = row[0];
      const amount = row[1];

      const labelCell = document.createElement('td');
      labelCell.textContent = label;
      decorateInlineGeneratedEdit(labelCell, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'outputsBucketed', 'sections', sectionIndex, 'rows', rowIndex, 0], {
        valueType: 'string',
        label: 'Edit output row label'
      });
      tr.appendChild(labelCell);

      const amountCell = document.createElement('td');
      amountCell.className = 'pbs-amount-col';
      amountCell.textContent = formatBucketedCurrency(amount, currencySymbol);
      decorateInlineGeneratedEdit(amountCell, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'outputsBucketed', 'sections', sectionIndex, 'rows', rowIndex, 1], {
        valueType: 'number',
        label: 'Edit output amount'
      });
      tr.appendChild(amountCell);

      const isNetWorthRow = isSummary && isPbsNetWorthSummaryLabel(label);
      if (isNetWorthRow) {
        tr.classList.add('pbs-net-worth-row');
      }

      tbody.appendChild(tr);
    });

    if (hasSubtotal) {
      const subtotalRow = document.createElement('tr');
      subtotalRow.className = 'pbs-subtotal-row';
      if (indicator) {
        subtotalRow.dataset.healthTone = indicator.tone;
      }

      const subtotalLabelCell = document.createElement('td');
      subtotalLabelCell.textContent = subtotalLabel;
      subtotalRow.appendChild(subtotalLabelCell);

      const subtotalValueCell = document.createElement('td');
      subtotalValueCell.className = 'pbs-amount-col';
      subtotalValueCell.textContent = formatBucketedCurrency(Number(section.subtotalValue), currencySymbol);
      subtotalRow.appendChild(subtotalValueCell);

      tbody.appendChild(subtotalRow);
    }

    table.appendChild(tbody);
    sectionWrap.appendChild(table);

    if (isSummary && sectionEnhancement.netWorthContext) {
      sectionWrap.appendChild(buildOutputsBucketedNetWorthContext(sectionEnhancement.netWorthContext));
    }

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
  highlightNetWorth = false,
  netWorthContext = null,
  sectionKey = '',
  currencySymbol = '€',
  module = null,
  sectionIndex = -1,
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const card = document.createElement('section');
  card.className = 'pbs-stacked-card';
  const normalizedSectionKey = normalizeSectionToken(sectionKey || section?.key || section?.title || defaultTitle);
  if (normalizedSectionKey) {
    card.dataset.pbsSectionKey = normalizedSectionKey;
    card.dataset.pbsAnchorKey = getPbsSectionAnchorKey(normalizedSectionKey);
  }

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
  const hasSubtotal = Number.isFinite(Number(section.subtotalValue))
    && !shouldHideSummarySubtotal(section, rows, highlightNetWorth);

  const heading = document.createElement('h4');
  heading.className = 'generated-card-title pbs-stacked-title';
  heading.textContent = title;
  decorateInlineGeneratedEdit(heading, {
    module,
    readOnly,
    onEditGeneratedText
  }, sectionIndex >= 0 ? ['generated', 'outputsBucketed', 'sections', sectionIndex, 'title'] : null, {
    valueType: 'string',
    label: 'Edit output section title'
  });
  card.appendChild(heading);

  const table = document.createElement('table');
  table.className = 'generated-table pbs-bucket-table pbs-detail-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  columns.forEach((column, index) => {
    const th = document.createElement('th');
    th.textContent = normalizeCurrencyLabelText(column);
    decorateInlineGeneratedEdit(th, {
      module,
      readOnly,
      onEditGeneratedText
    }, sectionIndex >= 0 ? ['generated', 'outputsBucketed', 'sections', sectionIndex, 'columns', index] : null, {
      valueType: 'string',
      label: 'Edit output column'
    });
    if (index === 1) {
      th.classList.add('pbs-amount-col');
    }
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    const label = row[0];
    if (normalizedSectionKey) {
      tr.dataset.pbsSectionKey = normalizedSectionKey;
      tr.dataset.pbsRowLabel = normalizeSectionToken(label);
      tr.dataset.pbsAnchorKey = getPbsRowAnchorKey(normalizedSectionKey, label);
    }

    const labelCell = document.createElement('td');
    labelCell.textContent = label;
    decorateInlineGeneratedEdit(labelCell, {
      module,
      readOnly,
      onEditGeneratedText
    }, sectionIndex >= 0 ? ['generated', 'outputsBucketed', 'sections', sectionIndex, 'rows', rowIndex, 0] : null, {
      valueType: 'string',
      label: 'Edit output row label'
    });
    tr.appendChild(labelCell);

    const amountCell = document.createElement('td');
    amountCell.className = 'pbs-amount-col';
    amountCell.textContent = formatBucketedCurrency(row[1], currencySymbol);
    decorateInlineGeneratedEdit(amountCell, {
      module,
      readOnly,
      onEditGeneratedText
    }, sectionIndex >= 0 ? ['generated', 'outputsBucketed', 'sections', sectionIndex, 'rows', rowIndex, 1] : null, {
      valueType: 'number',
      label: 'Edit output amount'
    });
    if (normalizedSectionKey) {
      setPbsValueDataset(amountCell, {
        key: `detail:${normalizedSectionKey}:row:${normalizeSectionToken(label)}`,
        value: row[1],
        currencySymbol
      });
    }
    tr.appendChild(amountCell);

    const isNetWorthRow = highlightNetWorth && isPbsNetWorthSummaryLabel(label);
    if (isNetWorthRow) {
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
    subtotalValueCell.textContent = formatBucketedCurrency(Number(section.subtotalValue), currencySymbol);
    if (normalizedSectionKey) {
      setPbsValueDataset(subtotalValueCell, {
        key: `detail:${normalizedSectionKey}:subtotal`,
        value: Number(section.subtotalValue),
        currencySymbol
      });
    }
    subtotalRow.appendChild(subtotalValueCell);

    tbody.appendChild(subtotalRow);
  }

  table.appendChild(tbody);
  card.appendChild(table);

  if (netWorthContext) {
    card.appendChild(buildOutputsBucketedNetWorthContext(netWorthContext));
  }

  return card;
}

function buildOutputsBucketedMatrixContent(outputsBucketed, sectionEnhancements = {}, {
  summaryHtml = '',
  guideText = '',
  module = null,
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const sections = outputsBucketed.sections;
  const assetSections = PBS_ASSET_SECTION_KEYS.map((key) => (
    findOutputsBucketedSectionByKey(sections, key) || findOutputsBucketedSection(sections, key)
  ));

  if (assetSections.some((section) => !section)) {
    return null;
  }

  const outputStack = document.createElement('div');
  outputStack.className = 'pbs-outputs-stack';

  const leadCopy = buildPbsLeadCopy(summaryHtml, guideText);
  if (leadCopy) {
    outputStack.appendChild(leadCopy);
  }

  const currencySymbol = getOutputsBucketedCurrencySymbol(outputsBucketed);
  const tableFrame = document.createElement('section');
  tableFrame.className = 'pbs-table-frame';

  const balanceHeader = buildPbsBalanceHeader(outputsBucketed, currencySymbol);
  if (balanceHeader) {
    tableFrame.appendChild(balanceHeader);
  }

  const bucketSurface = document.createElement('section');
  bucketSurface.className = 'pbs-bucket-surface';

  const bucketGrid = document.createElement('div');
  bucketGrid.className = 'pbs-bucket-grid';
  assetSections.forEach((section, index) => {
    bucketGrid.appendChild(buildPbsBucketCard(section, {
      fallbackKey: PBS_ASSET_SECTION_KEYS[index],
      sectionEnhancements,
      currencySymbol,
      module,
      sectionIndex: sections.indexOf(section),
      readOnly,
      onEditGeneratedText
    }));
  });

  bucketSurface.appendChild(bucketGrid);
  tableFrame.appendChild(bucketSurface);
  outputStack.appendChild(tableFrame);

  const liabilitiesSection = findOutputsBucketedSectionByKey(sections, 'liabilities')
    || findOutputsBucketedSection(sections, 'liabilities');
  if (liabilitiesSection) {
    outputStack.appendChild(buildOutputsBucketedDetailCard(liabilitiesSection, {
      defaultTitle: 'Liabilities',
      defaultColumns: ['Liability', `Amount (${currencySymbol})`],
      sectionKey: 'liabilities',
      currencySymbol,
      module,
      sectionIndex: sections.indexOf(liabilitiesSection),
      readOnly,
      onEditGeneratedText
    }));
  }

  const summarySection = findOutputsBucketedSummarySection(sections);
  if (summarySection) {
    const summaryToken = normalizeSectionToken(summarySection?.key || summarySection?.title || 'summary');
    const netWorthContext = sectionEnhancements[summaryToken]?.netWorthContext
      || sectionEnhancements.summary?.netWorthContext
      || null;
    if (netWorthContext) {
      outputStack.appendChild(buildOutputsBucketedNetWorthContext(netWorthContext));
    } else if (!balanceHeader) {
      outputStack.appendChild(buildOutputsBucketedDetailCard(summarySection, {
        defaultTitle: 'Summary',
        defaultColumns: ['Metric', `Amount (${currencySymbol})`],
        highlightNetWorth: true,
        sectionKey: 'summary',
        currencySymbol,
        module,
        sectionIndex: sections.indexOf(summarySection),
        readOnly,
        onEditGeneratedText
      }));
    }
  }

  return outputStack;
}

function isPbsReducedMotionPreferred() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function collectPbsValueMap(root) {
  const values = new Map();
  if (!root) {
    return values;
  }

  root.querySelectorAll('[data-pbs-value-key][data-pbs-value]').forEach((element) => {
    const value = getOptionalFiniteNumber(element.dataset.pbsValue);
    if (element.dataset.pbsValueKey && value !== null) {
      values.set(element.dataset.pbsValueKey, value);
    }
  });
  return values;
}

function formatPbsValueForElement(element, value) {
  if (element?.dataset?.pbsValueFormat === 'currency') {
    return formatBucketedCurrency(value, element.dataset.pbsCurrency || '€');
  }

  return formatBucketedAmount(value);
}

function animatePbsNumericValues(root, previousValues) {
  if (!root || isPbsReducedMotionPreferred()) {
    return;
  }

  const animatedElements = Array.from(root.querySelectorAll('[data-pbs-value-key][data-pbs-value]'))
    .map((element) => {
      const key = element.dataset.pbsValueKey;
      const start = previousValues.get(key);
      const end = getOptionalFiniteNumber(element.dataset.pbsValue);
      if (start === undefined || end === null || start === end) {
        return null;
      }

      return { element, start, end };
    })
    .filter(Boolean);

  if (animatedElements.length === 0) {
    return;
  }

  const duration = 460;
  const startTime = performance.now();
  const tick = (now) => {
    const elapsed = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - elapsed, 3);
    animatedElements.forEach(({ element, start, end }) => {
      element.textContent = formatPbsValueForElement(element, start + ((end - start) * eased));
    });

    if (elapsed < 1) {
      requestAnimationFrame(tick);
      return;
    }

    animatedElements.forEach(({ element, end }) => {
      element.textContent = formatPbsValueForElement(element, end);
    });
  };

  requestAnimationFrame(tick);
}

function capturePbsAnchorRects(root) {
  const rects = new Map();
  if (!root) {
    return rects;
  }

  root.querySelectorAll('[data-pbs-anchor-key]').forEach((element) => {
    const key = element.dataset.pbsAnchorKey;
    if (!key || rects.has(key)) {
      return;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      rects.set(key, rect);
    }
  });

  return rects;
}

function findFirstPbsRect(rects, keys) {
  for (const key of keys) {
    if (rects.has(key)) {
      return rects.get(key);
    }
  }

  return null;
}

function getPbsEndpointAnchorKeys(endpoint, { preferLiabilityBalance = false } = {}) {
  const sectionKey = normalizeSectionToken(endpoint?.sectionKey);
  const rowLabel = endpoint?.rowLabel || endpoint?.label || '';
  const keys = [];

  if (preferLiabilityBalance) {
    keys.push('balance:gross-liabilities');
  }

  if (sectionKey && rowLabel) {
    keys.push(getPbsRowAnchorKey(sectionKey, rowLabel));
  }

  if (sectionKey) {
    keys.push(getPbsSectionAnchorKey(sectionKey));
  }

  return keys;
}

function normalizePbsMovementAction(action) {
  const token = String(action ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (!token) {
    return '';
  }

  const aliases = {
    add: 'add',
    added: 'add',
    contribute: 'add',
    contributed: 'add',
    contribution: 'add',
    fund: 'add',
    funded: 'add',
    redirect: 'add',
    redirected: 'add',
    reinvest: 'add',
    reinvested: 'add',
    transfer: 'add',
    transferred: 'add',
    transferin: 'add',
    increase: 'increase',
    increased: 'increase',
    reduce: 'reduce',
    reduced: 'reduce',
    decrease: 'reduce',
    decreased: 'reduce',
    lower: 'reduce',
    lowered: 'reduce',
    paydown: 'reduce',
    payoff: 'reduce',
    repay: 'reduce',
    repaid: 'reduce',
    repayment: 'reduce',
    clear: 'reduce',
    cleared: 'reduce',
    settle: 'reduce',
    settled: 'reduce',
    remove: 'remove',
    removed: 'remove',
    sell: 'remove',
    sold: 'remove',
    dispose: 'remove',
    disposed: 'remove',
    disposal: 'remove'
  };

  return aliases[token] || '';
}

function getPbsMovementPlans(movements, { reverse = false } = {}) {
  return (Array.isArray(movements) ? movements : []).flatMap((movement) => {
    const from = movement?.from;
    const destinations = Array.isArray(movement?.to) ? movement.to : [];
    if (!from || destinations.length === 0) {
      return [];
    }

    return destinations.map((destination) => {
      const action = normalizePbsMovementAction(destination?.action);
      const destinationSection = normalizeSectionToken(destination?.sectionKey);
      const usesLiabilityMetric = destinationSection === 'liabilities' && action === 'reduce';
      const amount = getOptionalFiniteNumber(destination?.amount)
        ?? getOptionalFiniteNumber(movement?.amount)
        ?? getOptionalFiniteNumber(from?.amount)
        ?? 0;

      if (reverse) {
        return {
          amount,
          action,
          endKeys: getPbsEndpointAnchorKeys(from),
          pulseKeys: getPbsEndpointAnchorKeys(from),
          startKeys: getPbsEndpointAnchorKeys(destination, { preferLiabilityBalance: usesLiabilityMetric })
        };
      }

      return {
        amount,
        action,
        endKeys: getPbsEndpointAnchorKeys(destination, { preferLiabilityBalance: usesLiabilityMetric }),
        pulseKeys: getPbsEndpointAnchorKeys(destination, { preferLiabilityBalance: usesLiabilityMetric }),
        startKeys: getPbsEndpointAnchorKeys(from)
      };
    });
  });
}

function getPbsTransitionMovementConfig(previousCase, nextCase) {
  if (!previousCase || !nextCase) {
    return { movements: [], reverse: false };
  }

  if (previousCase.id === PBS_CURRENT_SCENARIO_ID && nextCase.id !== PBS_CURRENT_SCENARIO_ID) {
    return { movements: nextCase.movements, reverse: false };
  }

  if (previousCase.id !== PBS_CURRENT_SCENARIO_ID && nextCase.id === PBS_CURRENT_SCENARIO_ID) {
    return { movements: previousCase.movements, reverse: true };
  }

  return { movements: [], reverse: false };
}

function escapePbsSelectorValue(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, '\\$&');
}

function pulsePbsAnchors(root, keys) {
  if (!root) {
    return;
  }

  keys.forEach((key) => {
    const target = root.querySelector(`[data-pbs-anchor-key="${escapePbsSelectorValue(key)}"]`);
    if (!target) {
      return;
    }

    target.classList.add('pbs-flow-pulse');
    window.setTimeout(() => target.classList.remove('pbs-flow-pulse'), 820);
  });
}

function markPbsScenarioContentUpdated(content) {
  if (!content) {
    return;
  }

  content.classList.add('pbs-scenario-content-highlight');
  window.setTimeout(() => content.classList.remove('pbs-scenario-content-highlight'), 700);
}

function animatePbsFlowChips({
  previousRects,
  nextRects,
  previousCase,
  nextCase,
  nextContent,
  currencySymbol
}) {
  const { movements, reverse } = getPbsTransitionMovementConfig(previousCase, nextCase);
  const plans = getPbsMovementPlans(movements, { reverse });
  if (plans.length === 0 || isPbsReducedMotionPreferred()) {
    markPbsScenarioContentUpdated(nextContent);
    return;
  }

  let animatedCount = 0;
  plans.forEach((plan) => {
    const startRect = findFirstPbsRect(previousRects, plan.startKeys);
    const endRect = findFirstPbsRect(nextRects, plan.endKeys);
    if (!startRect || !endRect) {
      return;
    }

    animatedCount += 1;
    const chip = document.createElement('span');
    chip.className = 'pbs-flow-chip';
    if (plan.action) {
      chip.dataset.action = plan.action;
    }
    chip.textContent = formatBucketedCurrency(plan.amount, currencySymbol);

    const startX = startRect.left + (startRect.width / 2);
    const startY = startRect.top + (startRect.height / 2);
    const endX = endRect.left + (endRect.width / 2);
    const endY = endRect.top + (endRect.height / 2);

    chip.style.transform = `translate3d(${startX}px, ${startY}px, 0) translate(-50%, -50%) scale(0.96)`;
    document.body.appendChild(chip);

    requestAnimationFrame(() => {
      chip.classList.add('is-moving');
      chip.style.transform = `translate3d(${endX}px, ${endY}px, 0) translate(-50%, -50%) scale(1)`;
    });

    window.setTimeout(() => {
      chip.remove();
    }, 820);

    pulsePbsAnchors(nextContent, plan.pulseKeys);
  });

  if (animatedCount === 0) {
    markPbsScenarioContentUpdated(nextContent);
  }
}

function buildPbsScenarioSwitcher(cases, onSelect) {
  const wrap = document.createElement('section');
  wrap.className = 'pbs-scenario-switcher';
  wrap.setAttribute('aria-label', 'Personal balance sheet case');

  const label = document.createElement('span');
  label.className = 'pbs-scenario-switcher-label';
  label.textContent = 'Case';
  wrap.appendChild(label);

  const options = document.createElement('div');
  options.className = 'pbs-scenario-options';
  options.setAttribute('role', 'group');
  options.setAttribute('aria-label', 'Choose balance sheet case');

  const buttons = cases.map((pbsCase, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pbs-scenario-option';
    button.textContent = pbsCase.title;
    button.dataset.scenarioIndex = String(index);
    button.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
    if (index === 0) {
      button.classList.add('is-active');
    }

    button.addEventListener('click', () => onSelect(index));
    options.appendChild(button);
    return button;
  });

  wrap.appendChild(options);

  return {
    element: wrap,
    setActive(index) {
      buttons.forEach((button, buttonIndex) => {
        const isActive = buttonIndex === index;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    }
  };
}

function buildPbsScenarioMatrixContent(module, outputsBucketed, {
  summaryHtml = '',
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const displayContext = getPlaybookDisplayContext(module);
  const cases = getPbsScenarioCases(outputsBucketed, summaryHtml)
    .filter((pbsCase, index) => (
      index === 0
      || hasPersonalBalanceSheetBucketShape(getOutputsBucketedForPbsCase(outputsBucketed, pbsCase))
    ));

  if (!hasPersonalBalanceSheetBucketShape(getOutputsBucketedForPbsCase(outputsBucketed, cases[0]))) {
    return null;
  }

  const shell = document.createElement('div');
  shell.className = 'pbs-scenario-shell';

  const contentHost = document.createElement('div');
  contentHost.className = 'pbs-scenario-content-host';

  const selectedScenarioId = typeof window.__getPbsScenarioForModule === 'function'
    ? window.__getPbsScenarioForModule(module.id)
    : PBS_CURRENT_SCENARIO_ID;
  let selectedIndex = Math.max(0, cases.findIndex((pbsCase) => pbsCase.id === selectedScenarioId));
  let switcher = null;

  const renderCase = (nextIndex, { animate = false } = {}) => {
    const previousIndex = selectedIndex;
    const previousCase = cases[previousIndex];
    const nextCase = cases[nextIndex];
    const previousContent = contentHost.firstElementChild;
    const previousValues = collectPbsValueMap(previousContent);
    const previousRects = capturePbsAnchorRects(previousContent);
    const selectedOutputsBucketed = getOutputsBucketedForPbsCase(outputsBucketed, nextCase);
    updatePbsScenarioChartsCard(module, selectedOutputsBucketed, nextCase, contentHost);
    const sectionEnhancements = getOutputsBucketedSectionEnhancements(module, selectedOutputsBucketed);
    const nextContent = buildOutputsBucketedMatrixContent(selectedOutputsBucketed, sectionEnhancements, {
      summaryHtml: nextCase.summaryHtml,
      guideText: displayContext.guide,
      module,
      readOnly,
      onEditGeneratedText: nextCase.id === PBS_CURRENT_SCENARIO_ID ? onEditGeneratedText : null
    });

    if (!nextContent) {
      return;
    }

    nextContent.classList.add('pbs-scenario-content');
    nextContent.dataset.scenarioId = nextCase.id;
    nextContent.classList.toggle('is-entering', animate);
    contentHost.replaceChildren(nextContent);
    selectedIndex = nextIndex;
    switcher?.setActive(nextIndex);

    if (!animate) {
      return;
    }

    requestAnimationFrame(() => {
      nextContent.classList.remove('is-entering');
      const nextRects = capturePbsAnchorRects(nextContent);
      animatePbsNumericValues(nextContent, previousValues);
      animatePbsFlowChips({
        previousRects,
        nextRects,
        previousCase,
        nextCase,
        nextContent,
        currencySymbol: getOutputsBucketedCurrencySymbol(selectedOutputsBucketed)
      });
    });
  };

  if (cases.length > 1) {
    switcher = buildPbsScenarioSwitcher(cases, (index) => {
      if (index === selectedIndex) {
        return;
      }

      closeActivePbsInfoPopover();
      if (typeof window.__setPbsScenario === 'function') {
        window.__setPbsScenario(module.id, cases[index].id);
      }
      renderCase(index, { animate: true });
    });
    shell.appendChild(switcher.element);
  }

  renderCase(selectedIndex);
  shell.appendChild(contentHost);
  return shell;
}

function buildOutputsBucketedCard(module, outputsBucketed, {
  summaryHtml = '',
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const card = document.createElement('section');
  card.className = 'generated-card generated-table-card generated-outputs-bucketed-card';
  card.dataset.generatedCard = 'outputs-bucketed';

  const isPbsModule = isPersonalBalanceSheetModule(module);
  if (isPbsModule) {
    card.classList.add('pbs-main-event-card');
  }

  const { header } = buildGeneratedCardHeader(isPbsModule ? 'Personal Balance Sheet' : 'Outputs');
  card.appendChild(header);

  if (!hasOutputsBucketed(outputsBucketed)) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = isPbsModule ? 'No balance sheet provided.' : 'No outputs provided.';
    card.appendChild(empty);
    return card;
  }

  const sectionEnhancements = getOutputsBucketedSectionEnhancements(module, outputsBucketed);
  const matrixContent = isPbsModule
    ? buildPbsScenarioMatrixContent(module, outputsBucketed, { summaryHtml, readOnly, onEditGeneratedText })
    : buildOutputsBucketedMatrixContent(outputsBucketed, sectionEnhancements, {
      summaryHtml: '',
      module,
      readOnly,
      onEditGeneratedText
    });
  if (matrixContent) {
    card.appendChild(matrixContent);
    return card;
  }

  if (isPbsModule) {
    const leadCopy = buildPbsLeadCopy(summaryHtml);
    if (leadCopy) {
      card.appendChild(leadCopy);
    }
  }
  card.appendChild(buildOutputsBucketedMiniTablesContent(outputsBucketed, sectionEnhancements, {
    module,
    readOnly,
    onEditGeneratedText
  }));
  return card;
}

function buildSummaryCard(summaryHtml, {
  guideText = '',
  module = null,
  readOnly = false,
  onEditGeneratedText = null,
  path = ['generated', 'summaryHtml']
} = {}) {
  const card = document.createElement('section');
  card.className = 'generated-card generated-summary-card';
  card.dataset.generatedCard = 'summary';

  const { header } = buildGeneratedCardHeader('Client guide');
  card.appendChild(header);

  const content = document.createElement('div');
  content.className = 'generated-summary-content';

  const safeHtml = sanitizeSummaryHtml(summaryHtml || '');
  const guideLine = buildClientGuideLine(safeHtml, guideText);
  if (guideLine) {
    content.appendChild(guideLine);
  }

  if (!safeHtml) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'No generated summary yet.';
    content.appendChild(empty);
  } else {
    const summary = document.createElement('div');
    summary.className = 'generated-summary-copy';
    summary.innerHTML = safeHtml;
    decorateInlineGeneratedEdit(summary, {
      module,
      readOnly,
      onEditGeneratedText
    }, path, {
      html: true,
      multiline: true,
      valueType: 'html',
      label: 'Edit client guide'
    });
    content.appendChild(summary);
  }

  card.appendChild(content);

  return card;
}

function buildModuleMediaCards(module, {
  readOnly = false,
  onRemoveImage = null
} = {}) {
  const images = Array.isArray(module?.media?.images) ? module.media.images : [];
  if (images.length === 0) {
    return [];
  }

  return images.map((image, imageIndex) => {
    const card = document.createElement('section');
    card.className = 'generated-card module-media-card';
    card.dataset.generatedCard = `image:${image.id || `image-${imageIndex + 1}`}`;

    const title = image.alt && image.alt !== 'Module image'
      ? image.alt
      : `Image ${imageIndex + 1}`;
    const { header } = buildGeneratedCardHeader(title);
    card.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'module-media-grid module-media-single-grid';

    const figure = document.createElement('figure');
    figure.className = 'module-media-item';
    figure.dataset.moduleImageId = image.id;

    const imageElement = document.createElement('img');
    imageElement.className = 'module-media-image is-loading';
    imageElement.dataset.moduleAssetId = image.assetId;
    imageElement.alt = image.alt || 'Module image';
    imageElement.loading = 'lazy';
    imageElement.decoding = 'async';
    if (Number.isInteger(image.width) && image.width > 0) {
      imageElement.width = image.width;
    }
    if (Number.isInteger(image.height) && image.height > 0) {
      imageElement.height = image.height;
    }
    figure.appendChild(imageElement);

    const status = document.createElement('span');
    status.className = 'module-media-status';
    status.textContent = 'Loading image…';
    figure.appendChild(status);

    if (!readOnly && typeof onRemoveImage === 'function') {
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'module-media-remove-btn';
      removeButton.textContent = '×';
      removeButton.setAttribute('aria-label', `Remove ${image.alt || 'module image'}`);
      removeButton.title = 'Remove image';
      removeButton.addEventListener('click', () => onRemoveImage(image.id));
      figure.appendChild(removeButton);
    }

    grid.appendChild(figure);
    card.appendChild(grid);
    return card;
  });
}

function appendModuleMediaCards(host, module, options = {}) {
  buildModuleMediaCards(module, options).forEach((card) => host.appendChild(card));
}

function getGeneratedCardId(card, index) {
  const reportBlockId = typeof card?.dataset?.reportBlockId === 'string' ? card.dataset.reportBlockId.trim() : '';
  if (reportBlockId) {
    return `report:${reportBlockId}`;
  }

  const generatedCard = typeof card?.dataset?.generatedCard === 'string' ? card.dataset.generatedCard.trim() : '';
  if (generatedCard) {
    return generatedCard;
  }

  return `card:${index + 1}`;
}

function getGeneratedCardLabel(card) {
  const heading = card.querySelector('.generated-card-title, .report-block-title, h3, h4');
  return heading?.textContent?.trim() || 'section';
}

function applyGeneratedCardControls(section, module, {
  readOnly = false,
  onRemoveCard = null,
  onReorderCards = null
} = {}) {
  if (!section || !module) {
    return section;
  }

  const hiddenCardIds = new Set(Array.isArray(module?.ui?.hiddenCardIds) ? module.ui.hiddenCardIds : []);
  section.querySelectorAll('.generated-card-remove-btn, .generated-card-drag-handle').forEach((control) => control.remove());
  let cards = getTopLevelGeneratedCards(section);

  cards.forEach((card, index) => {
    const cardId = getGeneratedCardId(card, index);
    card.dataset.moduleCardId = cardId;
    if (hiddenCardIds.has(cardId)) {
      card.remove();
      return;
    }
  });

  orderGeneratedCards(section, module);
  cards = getTopLevelGeneratedCards(section);
  const canReorder = !readOnly && typeof onReorderCards === 'function' && cards.length > 1;

  cards.forEach((card) => {
    card.classList.toggle('is-reorderable-generated-card', canReorder);
    if (canReorder) {
      addGeneratedCardDragHandle(card, getGeneratedCardLabel(card));
    }

    if (readOnly || typeof onRemoveCard !== 'function') {
      return;
    }

    const actions = card.querySelector(':scope > .generated-card-header .generated-card-header-actions, :scope > .report-block-header .generated-card-header-actions');
    const controlHost = actions || card;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'generated-card-remove-btn';
    button.textContent = '×';
    button.title = `Remove ${getGeneratedCardLabel(card)}`;
    button.setAttribute('aria-label', `Remove ${getGeneratedCardLabel(card)}`);
    button.addEventListener('click', () => onRemoveCard(card.dataset.moduleCardId));
    controlHost.appendChild(button);
  });

  if (canReorder) {
    enableGeneratedCardSorting(section, { onReorderCards });
  }

  return section;
}

function formatRetirementCurrency(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return 'N/A';
  }

  return RETIREMENT_EURO_FORMATTER.format(amount);
}

function getRetirementProjectionDebug(module) {
  if (module?._retirementProjection?.debug) {
    return module._retirementProjection.debug;
  }

  if (!isPensionModule(module)) {
    return null;
  }

  try {
    const scenarioId = getPensionScenarioForModule(module);
    return computePensionProjection(module.generated.pensionInputs, { scenarioId }).debug;
  } catch (_error) {
    return null;
  }
}

function getRetirementRequiredPotMeta(module) {
  const debug = getRetirementProjectionDebug(module);
  if (!debug) {
    return {
      valueText: 'N/A',
      label: 'Required pension pot',
      detail: 'The required pension pot could not be calculated from the current assumptions.',
      applicable: false
    };
  }

  if (debug.requiredPotIsApplicable === false) {
    return {
      valueText: 'Not needed',
      label: 'Required pension pot',
      detail: 'On this case, other retirement income sources cover the target spending need, so a separate required pension pot is not shown.',
      applicable: false
    };
  }

  if (!Number.isFinite(Number(debug.requiredPot))) {
    return {
      valueText: 'N/A',
      label: 'Required pension pot',
      detail: 'This retirement mode estimates affordable income rather than a target required pension pot.',
      applicable: false
    };
  }

  const referenceYear = Number.isFinite(Number(debug.requiredPotReferenceYear))
    ? ` in ${Math.round(Number(debug.requiredPotReferenceYear))}`
    : '';

  return {
    valueText: formatRetirementCurrency(debug.requiredPot),
    label: 'Required pension pot',
    detail: `Estimated pension balance needed${referenceYear} after other retirement income sources are allowed for.`,
    applicable: true
  };
}

function buildRetirementExplainerCard() {
  const card = document.createElement('section');
  card.className = 'generated-card retirement-explainer-card';
  card.dataset.generatedCard = 'retirement-explainer';

  const { header } = buildGeneratedCardHeader('How to read this retirement playbook');
  card.appendChild(header);

  const content = document.createElement('div');
  content.className = 'retirement-explainer-content generated-summary-content';

  [
    'This playbook tests whether projected pension savings, other retirement income, and desired spending line up over time.',
    'Irish pensions matter because contributions can receive tax relief, and growth inside the pension is generally tax-free, subject to Revenue rules and limits.',
    'Start with the required pension pot, then compare cases to see how losing or gaining an income source changes the pension balance needed.'
  ].forEach((text) => {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    content.appendChild(paragraph);
  });

  card.appendChild(content);
  return card;
}

function buildRetirementPositionChips(debug) {
  const chips = document.createElement('div');
  chips.className = 'retirement-position-chips';

  const items = [];
  if (Number(debug?.currentGapVsRequired) > 0) {
    items.push({
      label: 'Current gap',
      value: formatRetirementCurrency(debug.currentGapVsRequired),
      tone: 'risk'
    });
  } else if (Number(debug?.currentSurplusVsRequired) > 0) {
    items.push({
      label: 'Current surplus',
      value: formatRetirementCurrency(debug.currentSurplusVsRequired),
      tone: 'positive'
    });
  }

  if (Number(debug?.maxGapVsRequired) > 0) {
    items.push({
      label: 'Max gap',
      value: formatRetirementCurrency(debug.maxGapVsRequired),
      tone: 'risk'
    });
  } else if (Number(debug?.maxSurplusVsRequired) > 0) {
    items.push({
      label: 'Max surplus',
      value: formatRetirementCurrency(debug.maxSurplusVsRequired),
      tone: 'positive'
    });
  }

  if (items.length === 0) {
    items.push({
      label: 'Current path',
      value: 'On track',
      tone: 'neutral'
    });
  }

  items.forEach((item) => {
    const chip = document.createElement('span');
    chip.className = 'retirement-position-chip';
    chip.dataset.tone = item.tone;

    const label = document.createElement('span');
    label.className = 'retirement-position-chip-label';
    label.textContent = item.label;
    chip.appendChild(label);

    const value = document.createElement('strong');
    value.className = 'retirement-position-chip-value';
    value.textContent = item.value;
    chip.appendChild(value);

    chips.appendChild(chip);
  });

  return chips;
}

function getRetirementCaseProjection(module, scenarioId) {
  if (!isPensionModule(module)) {
    return null;
  }

  try {
    return computePensionProjection(module.generated.pensionInputs, { scenarioId });
  } catch (_error) {
    return null;
  }
}

function buildRetirementCaseDetail(projection) {
  const debug = projection?.debug || {};
  const details = [];
  const rent = Number(debug.rentalIncomeToday);

  if (Number.isFinite(rent)) {
    details.push(rent > 0
      ? `${formatRetirementCurrency(rent)} gross rent today`
      : 'Rental income removed');
  }

  if (debug.requiredPotIsApplicable === false) {
    details.push('No separate required pension pot');
  } else if (Number.isFinite(Number(debug.requiredPot))) {
    details.push(`${formatRetirementCurrency(debug.requiredPot)} required pension pot`);
  }

  return details.join(' - ');
}

function buildRetirementScenarioOptions(module, cases, selectedId) {
  const options = document.createElement('div');
  options.className = 'retirement-scenario-options';
  options.setAttribute('role', 'radiogroup');
  options.setAttribute('aria-label', 'Choose retirement income case');

  cases.forEach((pensionCase) => {
    const projection = getRetirementCaseProjection(module, pensionCase.id);
    const isActive = pensionCase.id === selectedId;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'retirement-scenario-card';
    button.dataset.pensionScenarioId = pensionCase.id;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', isActive ? 'true' : 'false');

    const title = document.createElement('span');
    title.className = 'retirement-scenario-title';
    title.textContent = pensionCase.title;
    button.appendChild(title);

    const detail = document.createElement('span');
    detail.className = 'retirement-scenario-detail';
    detail.textContent = buildRetirementCaseDetail(projection) || 'Scenario assumptions';
    button.appendChild(detail);

    button.addEventListener('click', () => {
      if (typeof window.__setPensionScenario === 'function') {
        window.__setPensionScenario(module.id, pensionCase.id);
      }
    });

    options.appendChild(button);
  });

  return options;
}

function buildRetirementDecisionPanel(module) {
  if (!isPensionModule(module)) {
    return null;
  }

  const debug = getRetirementProjectionDebug(module);
  const requiredPot = getRetirementRequiredPotMeta(module);
  const cases = getPensionScenarioCasesForModule(module);
  const selectedId = getPensionScenarioForModule(module);
  const panel = document.createElement('section');
  panel.className = 'generated-card retirement-decision-panel';
  panel.dataset.generatedCard = 'retirement-decision';

  const required = document.createElement('div');
  required.className = 'retirement-required-pot-card';
  required.dataset.requiredPotValue = requiredPot.valueText;

  const eyebrow = document.createElement('p');
  eyebrow.className = 'retirement-required-eyebrow';
  eyebrow.textContent = requiredPot.label;
  required.appendChild(eyebrow);

  const value = document.createElement('div');
  value.className = 'retirement-required-value';
  value.textContent = requiredPot.valueText;
  required.appendChild(value);

  const detail = document.createElement('p');
  detail.className = 'retirement-required-detail';
  detail.textContent = requiredPot.detail;
  required.appendChild(detail);

  required.appendChild(buildRetirementPositionChips(debug));
  panel.appendChild(required);

  if (cases.length > 1) {
    const scenarioArea = document.createElement('div');
    scenarioArea.className = 'retirement-scenario-area';

    const scenarioLabel = document.createElement('p');
    scenarioLabel.className = 'retirement-scenario-label';
    scenarioLabel.textContent = 'Retirement income case';
    scenarioArea.appendChild(scenarioLabel);
    scenarioArea.appendChild(buildRetirementScenarioOptions(module, cases, selectedId));
    panel.appendChild(scenarioArea);
  }

  return panel;
}

function getNetRetirementProjectionDebug(module) {
  if (module?._netRetirementProjection?.debug) {
    return module._netRetirementProjection.debug;
  }

  if (!isNetRetirementModule(module)) {
    return null;
  }

  try {
    const scenarioId = getNetRetirementScenarioForModule(module);
    return computeNetRetirementProjection(module.generated.netRetirementInputs, { scenarioId }).debug;
  } catch (_error) {
    return null;
  }
}

function getNetRetirementRequiredFundMeta(module) {
  const debug = getNetRetirementProjectionDebug(module);
  if (!debug) {
    return {
      valueText: 'N/A',
      label: 'Required net investment fund',
      detail: 'The required fund could not be calculated from the current assumptions.'
    };
  }

  const scenario = debug.scenario || {};
  return {
    valueText: formatRetirementCurrency(debug.requiredFundToday),
    label: 'Required net investment fund',
    detail: `After-tax fund needed today for ${scenario.title || 'this case'}, using the selected net growth rate.`
  };
}

function buildNetRetirementPositionChips(debug) {
  const chips = document.createElement('div');
  chips.className = 'retirement-position-chips';
  const items = [
    {
      label: 'First-year shortfall',
      value: formatRetirementCurrency(debug?.firstYearShortfall || 0),
      tone: Number(debug?.firstYearShortfall) > 0 ? 'risk' : 'positive'
    }
  ];

  if (Number.isFinite(Number(debug?.surplusVsRequired))) {
    const surplus = Number(debug.surplusVsRequired);
    items.push({
      label: surplus >= 0 ? 'Fund surplus' : 'Fund gap',
      value: formatRetirementCurrency(Math.abs(surplus)),
      tone: surplus >= 0 ? 'positive' : 'risk'
    });
  }

  items.forEach((item) => {
    const chip = document.createElement('span');
    chip.className = 'retirement-position-chip';
    chip.dataset.tone = item.tone;

    const label = document.createElement('span');
    label.className = 'retirement-position-chip-label';
    label.textContent = item.label;
    chip.appendChild(label);

    const value = document.createElement('strong');
    value.className = 'retirement-position-chip-value';
    value.textContent = item.value;
    chip.appendChild(value);

    chips.appendChild(chip);
  });

  return chips;
}

function buildNetRetirementScenarioOptions(module, cases, selectedId) {
  const options = document.createElement('div');
  options.className = 'retirement-scenario-options';
  options.setAttribute('role', 'radiogroup');
  options.setAttribute('aria-label', 'Choose net retirement cash-flow case');

  cases.forEach((netCase) => {
    const isActive = netCase.id === selectedId;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'retirement-scenario-card';
    button.dataset.netRetirementScenarioId = netCase.id;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', isActive ? 'true' : 'false');

    const title = document.createElement('span');
    title.className = 'retirement-scenario-title';
    title.textContent = netCase.title;
    button.appendChild(title);

    const detail = document.createElement('span');
    detail.className = 'retirement-scenario-detail';
    detail.textContent = netCase.detail || 'Scenario assumptions';
    button.appendChild(detail);

    button.addEventListener('click', () => {
      if (typeof window.__setNetRetirementScenario === 'function') {
        window.__setNetRetirementScenario(module.id, netCase.id);
      }
    });

    options.appendChild(button);
  });

  return options;
}

function buildNetRetirementDecisionPanel(module) {
  if (!isNetRetirementModule(module)) {
    return null;
  }

  const debug = getNetRetirementProjectionDebug(module);
  const requiredFund = getNetRetirementRequiredFundMeta(module);
  const cases = getNetRetirementScenarioCasesForModule(module);
  const selectedId = getNetRetirementScenarioForModule(module);
  const panel = document.createElement('section');
  panel.className = 'generated-card retirement-decision-panel net-retirement-decision-panel';
  panel.dataset.generatedCard = 'net-retirement-decision';

  const required = document.createElement('div');
  required.className = 'retirement-required-pot-card';
  required.dataset.requiredFundValue = requiredFund.valueText;

  const eyebrow = document.createElement('p');
  eyebrow.className = 'retirement-required-eyebrow';
  eyebrow.textContent = requiredFund.label;
  required.appendChild(eyebrow);

  const value = document.createElement('div');
  value.className = 'retirement-required-value';
  value.textContent = requiredFund.valueText;
  required.appendChild(value);

  const detail = document.createElement('p');
  detail.className = 'retirement-required-detail';
  detail.textContent = requiredFund.detail;
  required.appendChild(detail);

  if (debug) {
    required.appendChild(buildNetRetirementPositionChips(debug));
  }
  panel.appendChild(required);

  if (cases.length > 1) {
    const scenarioArea = document.createElement('div');
    scenarioArea.className = 'retirement-scenario-area';

    const scenarioLabel = document.createElement('p');
    scenarioLabel.className = 'retirement-scenario-label';
    scenarioLabel.textContent = 'Net cash-flow case';
    scenarioArea.appendChild(scenarioLabel);
    scenarioArea.appendChild(buildNetRetirementScenarioOptions(module, cases, selectedId));
    panel.appendChild(scenarioArea);
  }

  return panel;
}

function buildPensionScenarioSwitcher(module, cases) {
  if (!isPensionModule(module) || !Array.isArray(cases) || cases.length <= 1) {
    return null;
  }

  const selectedId = getPensionScenarioForModule(module);
  const wrap = document.createElement('section');
  wrap.className = 'pension-scenario-switcher';
  wrap.setAttribute('aria-label', 'Retirement income case');

  const label = document.createElement('span');
  label.className = 'pension-scenario-switcher-label';
  label.textContent = 'Case';
  wrap.appendChild(label);

  const options = document.createElement('div');
  options.className = 'pension-scenario-options';
  options.setAttribute('role', 'group');
  options.setAttribute('aria-label', 'Choose retirement income case');

  cases.forEach((pensionCase) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pension-scenario-option';
    button.textContent = pensionCase.title;
    button.dataset.pensionScenarioId = pensionCase.id;
    const isActive = pensionCase.id === selectedId;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');

    button.addEventListener('click', () => {
      if (typeof window.__setPensionScenario === 'function') {
        window.__setPensionScenario(module.id, pensionCase.id);
      }
    });

    options.appendChild(button);
  });

  wrap.appendChild(options);
  return wrap;
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
        className: 'generated-chart-block',
        chart
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

function buildEducationTopicCard(module, education, {
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const card = document.createElement('section');
  card.className = 'generated-card education-topic-card';
  card.dataset.generatedCard = 'education-topic';

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
  decorateInlineGeneratedEdit(topicLine, {
    module,
    readOnly,
    onEditGeneratedText
  }, ['generated', 'education', 'topic'], {
    valueType: 'string',
    label: 'Edit education topic'
  });
  card.appendChild(topicLine);

  if (audience) {
    const audienceLine = document.createElement('p');
    audienceLine.className = 'education-audience-line';
    audienceLine.append('Audience: ');
    const audienceText = document.createElement('span');
    audienceText.textContent = audience;
    decorateInlineGeneratedEdit(audienceText, {
      module,
      readOnly,
      onEditGeneratedText
    }, ['generated', 'education', 'audience'], {
      valueType: 'string',
      label: 'Edit education audience'
    });
    audienceLine.appendChild(audienceText);
    card.appendChild(audienceLine);
  }

  return card;
}

function buildEducationMetricsCard(education) {
  const metrics = Array.isArray(education?.metrics) ? education.metrics : [];
  if (metrics.length === 0) {
    return null;
  }

  const card = document.createElement('section');
  card.className = 'generated-card education-metrics-card';
  card.dataset.generatedCard = 'education-metrics';

  const { header } = buildGeneratedCardHeader('Key ideas');
  card.appendChild(header);
  appendArtifactMetricItems(card, metrics, {
    className: 'education-metric-grid',
    itemClassName: 'education-metric-card'
  });

  return card;
}

function buildEducationStepsCard(module, education, {
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const steps = Array.isArray(education?.steps) ? education.steps : [];
  if (steps.length === 0) {
    return null;
  }

  const card = document.createElement('section');
  card.className = 'generated-card education-steps-card';
  card.dataset.generatedCard = 'education-steps';

  const { header } = buildGeneratedCardHeader('Walkthrough');
  card.appendChild(header);

  const shell = document.createElement('div');
  shell.className = 'education-stepper';

  const tabList = document.createElement('div');
  tabList.className = 'education-step-tabs';
  tabList.setAttribute('role', 'tablist');

  const panelWrap = document.createElement('div');
  panelWrap.className = 'education-step-panels';

  const buttons = [];
  const panels = [];
  const setActiveStep = (targetIndex) => {
    buttons.forEach((button, index) => {
      const isActive = index === targetIndex;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      button.tabIndex = isActive ? 0 : -1;
    });

    panels.forEach((panel, index) => {
      const isActive = index === targetIndex;
      panel.classList.toggle('is-active', isActive);
      panel.hidden = !isActive;
    });
  };

  steps.forEach((step, index) => {
    const panelId = `education-step-${sanitizeFileToken(step?.id || String(index + 1), `step-${index + 1}`)}`;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'education-step-tab';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', panelId);
    button.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
    button.tabIndex = index === 0 ? 0 : -1;

    const number = document.createElement('span');
    number.className = 'education-step-number';
    number.textContent = String(index + 1).padStart(2, '0');
    button.appendChild(number);

    const label = document.createElement('span');
    label.className = 'education-step-tab-label';
    label.textContent = step?.title || `Step ${index + 1}`;
    button.appendChild(label);

    button.addEventListener('click', () => setActiveStep(index));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
        return;
      }
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const nextIndex = (index + direction + steps.length) % steps.length;
      setActiveStep(nextIndex);
      buttons[nextIndex]?.focus();
    });

    buttons.push(button);
    tabList.appendChild(button);

    const panel = document.createElement('section');
    panel.className = 'education-step-panel';
    panel.id = panelId;
    panel.setAttribute('role', 'tabpanel');
    panel.hidden = index !== 0;
    panel.classList.toggle('is-active', index === 0);

    if (typeof step?.kicker === 'string' && step.kicker.trim()) {
      const kicker = document.createElement('p');
      kicker.className = 'education-step-kicker';
      kicker.textContent = step.kicker.trim();
      decorateInlineGeneratedEdit(kicker, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'education', 'steps', index, 'kicker'], {
        valueType: 'string',
        label: 'Edit step kicker'
      });
      panel.appendChild(kicker);
    }

    const title = document.createElement('h4');
    title.className = 'education-step-title';
    title.textContent = step?.title || `Step ${index + 1}`;
    decorateInlineGeneratedEdit(title, {
      module,
      readOnly,
      onEditGeneratedText
    }, ['generated', 'education', 'steps', index, 'title'], {
      valueType: 'string',
      label: 'Edit step title'
    });
    panel.appendChild(title);

    const safeBodyHtml = sanitizeSummaryHtml(step?.bodyHtml || '');
    if (safeBodyHtml) {
      const body = document.createElement('div');
      body.className = 'education-section-body-content';
      body.innerHTML = safeBodyHtml;
      decorateInlineGeneratedEdit(body, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'education', 'steps', index, 'bodyHtml'], {
        html: true,
        multiline: true,
        valueType: 'html',
        label: 'Edit step body'
      });
      panel.appendChild(body);
    }

    const bullets = Array.isArray(step?.bullets)
      ? step.bullets.filter((bullet) => typeof bullet === 'string' && bullet.trim())
      : [];
    if (bullets.length > 0) {
      const list = document.createElement('ul');
      list.className = 'education-section-bullets';
      bullets.forEach((bullet) => {
        const item = document.createElement('li');
        item.textContent = bullet;
        decorateInlineGeneratedEdit(item, {
          module,
          readOnly,
          onEditGeneratedText
        }, ['generated', 'education', 'steps', index, 'bullets', [...list.children].length], {
          valueType: 'string',
          label: 'Edit step bullet'
        });
        list.appendChild(item);
      });
      panel.appendChild(list);
    }

    if (typeof step?.focus === 'string' && step.focus.trim()) {
      const focus = document.createElement('p');
      focus.className = 'education-step-focus';
      focus.textContent = step.focus.trim();
      decorateInlineGeneratedEdit(focus, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'education', 'steps', index, 'focus'], {
        valueType: 'string',
        label: 'Edit step focus'
      });
      panel.appendChild(focus);
    }

    if (!safeBodyHtml && bullets.length === 0 && !(typeof step?.focus === 'string' && step.focus.trim())) {
      const empty = document.createElement('p');
      empty.className = 'generated-empty';
      empty.textContent = 'No step details provided.';
      panel.appendChild(empty);
    }

    panels.push(panel);
    panelWrap.appendChild(panel);
  });

  shell.appendChild(tabList);
  shell.appendChild(panelWrap);
  card.appendChild(shell);
  return card;
}

function buildEducationSectionsCard(module, education, {
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const card = document.createElement('section');
  card.className = 'generated-card education-sections-card';
  card.dataset.generatedCard = 'education-sections';

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
    details.open = typeof section?.defaultOpen === 'boolean' ? section.defaultOpen : index === 0;

    const summary = document.createElement('summary');
    summary.className = 'education-section-summary';
    const summaryTitle = document.createElement('span');
    summaryTitle.textContent = section?.title || `Section ${index + 1}`;
    decorateInlineGeneratedEdit(summaryTitle, {
      module,
      readOnly,
      onEditGeneratedText
    }, ['generated', 'education', 'sections', index, 'title'], {
      valueType: 'string',
      label: 'Edit section title'
    });
    summary.appendChild(summaryTitle);
    details.appendChild(summary);

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'education-section-body';

    const safeBodyHtml = sanitizeSummaryHtml(section?.bodyHtml || '');
    if (safeBodyHtml) {
      const bodyContent = document.createElement('div');
      bodyContent.className = 'education-section-body-content';
      bodyContent.innerHTML = safeBodyHtml;
      decorateInlineGeneratedEdit(bodyContent, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'education', 'sections', index, 'bodyHtml'], {
        html: true,
        multiline: true,
        valueType: 'html',
        label: 'Edit section body'
      });
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
        decorateInlineGeneratedEdit(li, {
          module,
          readOnly,
          onEditGeneratedText
        }, ['generated', 'education', 'sections', index, 'bullets', [...ul.children].length], {
          valueType: 'string',
          label: 'Edit section bullet'
        });
        ul.appendChild(li);
      });
      bodyWrap.appendChild(ul);
    }

    if (typeof section?.whyItMatters === 'string' && section.whyItMatters.trim()) {
      const why = document.createElement('aside');
      why.className = 'education-why-card';

      const label = document.createElement('span');
      label.className = 'education-why-label';
      label.textContent = 'Why this matters';
      why.appendChild(label);

      const body = document.createElement('p');
      body.className = 'education-why-body';
      body.textContent = section.whyItMatters.trim();
      decorateInlineGeneratedEdit(body, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'education', 'sections', index, 'whyItMatters'], {
        valueType: 'string',
        label: 'Edit why this matters'
      });
      why.appendChild(body);

      bodyWrap.appendChild(why);
    }

    const hasWhyItMatters = typeof section?.whyItMatters === 'string' && section.whyItMatters.trim();
    if (!safeBodyHtml && bullets.length === 0 && !hasWhyItMatters) {
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

function appendArtifactMetricItems(parent, items, {
  className = 'artifact-metric-grid',
  itemClassName = 'artifact-metric-card'
} = {}) {
  const metrics = normalizeInsightItems(items, 'metric');
  if (metrics.length === 0) {
    return false;
  }

  const grid = document.createElement('div');
  grid.className = className;

  metrics.forEach((metric) => {
    const item = document.createElement('article');
    item.className = itemClassName;
    if (metric.tone) {
      item.dataset.tone = metric.tone;
    }
    if (metric.featured) {
      item.dataset.featured = 'true';
    }

    const label = document.createElement('div');
    label.className = 'artifact-metric-label';
    label.textContent = metric.label;
    item.appendChild(label);

    if (metric.value) {
      const value = document.createElement('div');
      value.className = 'artifact-metric-value';
      value.textContent = formatMetricDisplayValue(metric.label, metric.value);
      item.appendChild(value);
    }

    if (metric.detail) {
      const detail = document.createElement('div');
      detail.className = 'artifact-metric-detail';
      detail.textContent = metric.detail;
      item.appendChild(detail);
    }

    grid.appendChild(item);
  });

  parent.appendChild(grid);
  return true;
}

function appendChartInsightContent(card, chart) {
  const insights = normalizeInsightItems(chart?.insights, 'chart-insight');
  if (insights.length > 0) {
    appendArtifactMetricItems(card, insights, {
      className: 'chart-insight-grid',
      itemClassName: 'chart-insight-card'
    });
  }

  const annotations = normalizeChartAnnotations(chart?.annotations);
  if (annotations.length === 0) {
    return;
  }

  const list = document.createElement('div');
  list.className = 'chart-annotation-list';

  annotations.forEach((annotation) => {
    const item = document.createElement('article');
    item.className = 'chart-annotation-item';
    if (annotation.tone) {
      item.dataset.tone = annotation.tone;
    }

    const label = document.createElement('span');
    label.className = 'chart-annotation-label';
    label.textContent = annotation.label;
    item.appendChild(label);

    const details = [];
    if (typeof annotation.xLabel === 'string' && annotation.xLabel.trim()) {
      details.push(annotation.xLabel.trim());
    }
    if (Number.isFinite(annotation.yValue)) {
      details.push(String(annotation.yValue));
    }
    if (details.length > 0) {
      const anchor = document.createElement('span');
      anchor.className = 'chart-annotation-anchor';
      anchor.textContent = details.join(' / ');
      item.appendChild(anchor);
    }

    if (annotation.body) {
      const body = document.createElement('p');
      body.className = 'chart-annotation-body';
      body.textContent = annotation.body;
      item.appendChild(body);
    }

    list.appendChild(item);
  });

  card.appendChild(list);
}

function buildChartMountCard({
  title,
  subtitle = '',
  chartIndex = 0,
  className = 'generated-chart-block',
  chart = null
} = {}) {
  const card = document.createElement('article');
  card.className = className;
  card.dataset.chartIndex = String(chartIndex);

  const displayVariant = normalizeChartDisplay(chart?.display)?.variant || '';
  if (displayVariant) {
    card.dataset.chartVariant = displayVariant;
  }

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

  const subtitleText = typeof subtitle === 'string' && subtitle.trim()
    ? subtitle.trim()
    : (typeof chart?.subtitle === 'string' && chart.subtitle.trim() ? chart.subtitle.trim() : '');
  if (subtitleText) {
    const subtitleEl = document.createElement('p');
    subtitleEl.className = 'education-visual-subtitle';
    subtitleEl.textContent = subtitleText;
    card.appendChild(subtitleEl);
  }

  if (displayVariant === 'pension-drawdown-composite') {
    const legend = document.createElement('div');
    legend.className = 'pension-drawdown-legend';
    legend.setAttribute('data-pension-drawdown-legend', 'true');
    card.appendChild(legend);

    const panels = [
      ['balance', chart?.panels?.balance?.title || 'Pension balance'],
      ['income', chart?.panels?.income?.title || 'Income sources']
    ];
    const panelGrid = document.createElement('div');
    panelGrid.className = 'pension-drawdown-panels';
    panels.forEach(([panelKey, panelTitle]) => {
      const panel = document.createElement('section');
      panel.className = 'pension-drawdown-panel';
      panel.dataset.chartPanel = panelKey;

      const panelHeading = document.createElement('div');
      panelHeading.className = 'pension-drawdown-panel-title';
      panelHeading.textContent = panelTitle;
      panel.appendChild(panelHeading);

      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'generated-chart-canvas-wrap pension-drawdown-canvas-wrap';

      const canvas = document.createElement('canvas');
      canvas.className = 'generated-chart-canvas';
      canvas.dataset.chartPanelCanvas = panelKey;
      canvas.height = panelKey === 'balance' ? 150 : 210;
      canvasWrap.appendChild(canvas);
      panel.appendChild(canvasWrap);
      panelGrid.appendChild(panel);
    });
    card.appendChild(panelGrid);
  } else {
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'generated-chart-canvas-wrap';

    const canvas = document.createElement('canvas');
    canvas.className = 'generated-chart-canvas';
    canvas.height = 220;
    canvasWrap.appendChild(canvas);

    card.appendChild(canvasWrap);
  }
  appendChartInsightContent(card, chart);
  return card;
}

function buildEducationChartVisualCard(visual, chart, chartIndex) {
  const card = buildChartMountCard({
    title: chart.title || visual?.title || `Chart ${chartIndex + 1}`,
    subtitle: typeof visual?.subtitle === 'string' ? visual.subtitle : '',
    chartIndex,
    className: 'education-visual-card education-chart-card generated-chart-block',
    chart
  });
  card.dataset.sceneKind = 'chart';
  return card;
}

function parseSvgViewBoxSize(svg) {
  const rawViewBox = String(svg?.getAttribute?.('viewBox') || '').trim();
  if (!rawViewBox) {
    return null;
  }

  const parts = rawViewBox.split(/\s+/).map((value) => Number(value));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    return null;
  }

  const width = Math.max(0, parts[2]);
  const height = Math.max(0, parts[3]);
  if (!width || !height) {
    return null;
  }

  return { width, height, aspectRatio: width / height };
}

function getResponsiveFlowchartColumns(nodeCount, viewportWidth) {
  if (nodeCount <= 4) {
    return Math.max(2, nodeCount);
  }

  if (nodeCount >= 6 && viewportWidth >= 1200) {
    return 4;
  }

  return 3;
}

function getResponsiveSvgSpec(svgSpec) {
  if (!isPlainObject(svgSpec)) {
    return svgSpec;
  }

  const kind = toTrimmedString(svgSpec.kind).toLowerCase();
  const nodes = Array.isArray(svgSpec.nodes) ? svgSpec.nodes : [];
  if (kind !== 'flowchart' || nodes.length < 4) {
    return svgSpec;
  }

  const layout = isPlainObject(svgSpec.layout) ? svgSpec.layout : {};
  const direction = toTrimmedString(layout.direction).toUpperCase();
  if (direction === 'LR' || direction === 'SNAKE' || direction === 'SERPENTINE' || layout.responsive === false) {
    return svgSpec;
  }

  const viewportWidth = typeof window !== 'undefined' ? Number(window.innerWidth) : 0;
  const hasDesktopSpace = viewportWidth >= 900
    && typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(min-width: 900px)').matches;
  if (!hasDesktopSpace) {
    return svgSpec;
  }

  return {
    ...svgSpec,
    layout: {
      ...layout,
      direction: 'SNAKE',
      snakeColumns: Number.isFinite(Number(layout.snakeColumns || layout.columns))
        ? Number(layout.snakeColumns || layout.columns)
        : getResponsiveFlowchartColumns(nodes.length, viewportWidth)
    }
  };
}

function applyResponsiveSvgFit(card, svgHost, svg, svgKind = '') {
  const viewBoxSize = parseSvgViewBoxSize(svg);
  if (!viewBoxSize) {
    card.dataset.svgFit = 'natural';
    return;
  }

  const { width, height, aspectRatio } = viewBoxSize;
  const kind = String(svgKind || '').trim().toLowerCase();
  const isBranchingGraph = kind === 'flowchart' || kind === 'decisiontree';
  const shouldFitPortrait = isBranchingGraph && aspectRatio < 1.15 && height >= 260;
  const shouldContain = isBranchingGraph && aspectRatio >= 1 && (height >= 920 || (height >= 780 && aspectRatio >= 1.25));
  const fitMode = shouldFitPortrait ? 'portrait' : (shouldContain ? 'contain' : 'natural');

  card.dataset.svgFit = fitMode;
  svgHost.dataset.svgFit = card.dataset.svgFit;

  svg.style.maxWidth = '100%';
  svg.style.maxHeight = fitMode === 'natural' ? 'none' : 'min(72vh, 760px)';

  if (fitMode === 'portrait') {
    const targetHeight = 720;
    const targetWidth = Math.min(width, Math.max(160, Math.round(targetHeight * aspectRatio)));
    svg.style.width = `min(100%, ${targetWidth}px)`;
    svg.style.height = 'auto';
    return;
  }

  svg.style.width = '100%';
  svg.style.height = fitMode === 'contain' ? 'min(72vh, 760px)' : 'auto';
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
  card.dataset.sceneKind = 'svg';

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
    const responsiveSvgSpec = getResponsiveSvgSpec(visual?.svgSpec || {});
    const svg = renderSvgDiagram(responsiveSvgSpec);
    if (!(svg instanceof SVGElement)) {
      throw new Error('Diagram renderer returned an invalid SVG element.');
    }

    const svgTheme = String(svg.getAttribute('data-theme') || responsiveSvgSpec?.theme || 'dark')
      .trim()
      .toLowerCase() === 'light'
      ? 'light'
      : 'dark';
    card.dataset.svgTheme = svgTheme;
    applyResponsiveSvgFit(card, svgHost, svg, responsiveSvgSpec?.kind || '');
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

function decorateEducationSceneCard(card, sceneRole = 'support') {
  if (!(card instanceof HTMLElement)) {
    return card;
  }

  card.dataset.sceneRole = sceneRole === 'hero' ? 'hero' : 'support';
  if (sceneRole === 'hero') {
    card.classList.add('education-hero-scene-card');
  } else {
    card.classList.add('education-support-scene-card');
  }

  return card;
}

function buildEducationSceneCard(module, visual, visualIndex, { chartIndex = 0, sceneRole = 'support' } = {}) {
  const type = String(visual?.type || '').trim().toLowerCase();
  if (type === 'chart') {
    const chart = sanitizeEducationChart(visual?.chart, chartIndex);
    if (!chart) {
      const errorCard = document.createElement('article');
      errorCard.className = 'education-visual-card education-visual-error-card';
      errorCard.dataset.sceneRole = sceneRole === 'hero' ? 'hero' : 'support';

      const error = document.createElement('p');
      error.className = 'education-visual-error';
      error.textContent = 'Could not render chart visual: invalid chart schema.';
      errorCard.appendChild(error);
      return {
        card: errorCard,
        nextChartIndex: chartIndex
      };
    }

    return {
      card: decorateEducationSceneCard(
        buildEducationChartVisualCard(visual, chart, chartIndex),
        sceneRole
      ),
      nextChartIndex: chartIndex + 1
    };
  }

  if (type === 'svg') {
    return {
      card: decorateEducationSceneCard(
        buildEducationSvgVisualCard(module, visual, visualIndex),
        sceneRole
      ),
      nextChartIndex: chartIndex
    };
  }

  const unsupported = document.createElement('article');
  unsupported.className = 'education-visual-card education-visual-error-card';
  unsupported.dataset.sceneRole = sceneRole === 'hero' ? 'hero' : 'support';
  const error = document.createElement('p');
  error.className = 'education-visual-error';
  error.textContent = `Unsupported visual type "${type || 'unknown'}".`;
  unsupported.appendChild(error);
  return {
    card: unsupported,
    nextChartIndex: chartIndex
  };
}

function buildEducationVisualsCard(module, education) {
  const card = document.createElement('section');
  card.className = 'generated-card education-visuals-card generated-charts-card';
  card.dataset.generatedCard = 'education-visuals';

  const visuals = Array.isArray(education?.visuals) ? education.visuals : [];
  const { header } = buildGeneratedCardHeader(visuals.length > 1 ? 'Scenes' : 'Scene');
  card.appendChild(header);

  if (visuals.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'No visuals generated yet.';
    card.appendChild(empty);
    return card;
  }

  const list = document.createElement('div');
  list.className = 'education-visuals-list';

  let chartIndex = 0;
  const heroVisual = visuals[0] || null;
  const supportVisuals = visuals.slice(1);

  if (heroVisual) {
    const heroGroup = document.createElement('section');
    heroGroup.className = 'education-scene-group education-hero-scene-group';

    const heroLabel = document.createElement('p');
    heroLabel.className = 'education-scene-group-label';
    heroLabel.textContent = 'Hero scene';
    heroGroup.appendChild(heroLabel);

    const heroResult = buildEducationSceneCard(module, heroVisual, 0, {
      chartIndex,
      sceneRole: 'hero'
    });
    chartIndex = heroResult.nextChartIndex;
    heroGroup.appendChild(heroResult.card);
    list.appendChild(heroGroup);
  }

  if (supportVisuals.length > 0) {
    const supportGroup = document.createElement('section');
    supportGroup.className = 'education-scene-group education-support-scenes-group';

    const supportLabel = document.createElement('p');
    supportLabel.className = 'education-scene-group-label';
    supportLabel.textContent = supportVisuals.length === 1 ? 'Support scene' : 'Support scenes';
    supportGroup.appendChild(supportLabel);

    const supportGrid = document.createElement('div');
    supportGrid.className = 'education-support-scenes-grid';

    supportVisuals.forEach((visual, visualIndex) => {
      const result = buildEducationSceneCard(module, visual, visualIndex + 1, {
        chartIndex,
        sceneRole: 'support'
      });
      chartIndex = result.nextChartIndex;
      supportGrid.appendChild(result.card);
    });

    supportGroup.appendChild(supportGrid);
    list.appendChild(supportGroup);
  }

  card.appendChild(list);
  return card;
}

function buildEducationReferencesCard(module, education, {
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const references = Array.isArray(education?.references) ? education.references : [];
  if (references.length === 0) {
    return null;
  }

  const card = document.createElement('section');
  card.className = 'generated-card education-references-card';
  card.dataset.generatedCard = 'education-references';

  const { header } = buildGeneratedCardHeader('Sources / where to verify');
  card.appendChild(header);

  const list = document.createElement('ol');
  list.className = 'report-source-list education-references-list';

  references.forEach((reference, index) => {
    const item = document.createElement('li');
    item.className = 'report-source-item education-reference-item';

    const label = typeof reference?.label === 'string' && reference.label.trim()
      ? reference.label.trim()
      : `Reference ${index + 1}`;
    const safeHref = sanitizeExternalUrl(reference?.url);
    const canEditReference = canEditGeneratedText({ module, readOnly, onEditGeneratedText });
    const titleLine = document.createElement(safeHref && !canEditReference ? 'a' : 'span');
    titleLine.className = 'report-source-label';
    titleLine.textContent = label;
    if (safeHref && titleLine.tagName === 'A') {
      titleLine.href = safeHref;
      titleLine.target = '_blank';
      titleLine.rel = 'noreferrer noopener';
      titleLine.title = 'Open source';
    }
    decorateInlineGeneratedEdit(titleLine, {
      module,
      readOnly,
      onEditGeneratedText
    }, ['generated', 'education', 'references', index, 'label'], {
      valueType: 'string',
      label: 'Edit reference label'
    });
    item.appendChild(titleLine);

    if (typeof reference?.kind === 'string' && reference.kind.trim()) {
      const kind = document.createElement('span');
      kind.className = 'report-source-kind';
      kind.textContent = reference.kind.trim();
      decorateInlineGeneratedEdit(kind, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'education', 'references', index, 'kind'], {
        valueType: 'string',
        label: 'Edit reference kind'
      });
      item.appendChild(kind);
    }

    if (typeof reference?.note === 'string' && reference.note.trim()) {
      const note = document.createElement('p');
      note.className = 'report-source-note';
      note.textContent = reference.note.trim();
      decorateInlineGeneratedEdit(note, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'education', 'references', index, 'note'], {
        valueType: 'string',
        label: 'Edit reference note'
      });
      item.appendChild(note);
    }

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
    subtitle: typeof block?.subtitle === 'string' && block.subtitle.trim()
      ? block.subtitle
      : (typeof block?.chart?.subtitle === 'string' ? block.chart.subtitle : ''),
    chartIndex,
    className: 'report-block report-chart-block generated-chart-block',
    chart: block?.chart || null
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
  const timeline = normalizeReportTimelineContent(block?.svgSpec || {});
  if (timeline.renderMode === 'html') {
    return buildReportTimelineContentBlock(block, timeline);
  }

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
      titleLine.title = 'Open source';
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

function renderReportSummaryCard(summaryHtml, module, {
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const card = buildSummaryCard(summaryHtml || '', {
    guideText: getPlaybookDisplayContext(module).guide,
    module,
    readOnly,
    onEditGeneratedText
  });
  card.classList.add('report-block', 'report-summary-block');
  card.dataset.reportBlockType = 'summary';
  return card;
}

function renderReportKpiRowBlock(block) {
  const card = buildReportBlockShell(block, 'report-block report-kpi-row-block');
  appendReportBlockHeader(card, {
    title: block?.title || '',
    subtitle: block?.subtitle || ''
  });

  const layout = typeof block?.layout === 'string' && block.layout.trim().toLowerCase() === 'hero'
    ? 'hero'
    : 'default';
  const row = document.createElement('div');
  row.className = 'report-kpi-row';
  row.dataset.layout = layout;

  const items = Array.isArray(block?.items) ? block.items : [];
  const featuredIndex = layout === 'hero'
    ? Math.max(0, items.findIndex((item) => item?.featured === true))
    : -1;

  items.forEach((item, index) => {
    const metric = document.createElement('article');
    metric.className = 'report-kpi-item';
    if (typeof item?.tone === 'string' && item.tone.trim()) {
      metric.dataset.tone = item.tone.trim().toLowerCase();
    }
    if (layout === 'hero' && (item?.featured === true || index === featuredIndex)) {
      metric.dataset.featured = 'true';
    }

    const label = document.createElement('div');
    label.className = 'report-kpi-label';
    label.textContent = item?.label || 'Metric';
    metric.appendChild(label);

    const value = document.createElement('div');
    value.className = 'report-kpi-value';
    value.textContent = formatMetricDisplayValue(item?.label || 'Metric', item?.value || '--');
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

function renderReportInsightGridBlock(block) {
  const card = buildReportBlockShell(block, 'report-block report-insight-grid-block');
  appendReportBlockHeader(card, {
    title: block?.title || '',
    subtitle: block?.subtitle || ''
  });

  const layout = typeof block?.layout === 'string' && block.layout.trim().toLowerCase() === 'featured'
    ? 'featured'
    : 'default';
  const grid = document.createElement('div');
  grid.className = 'report-insight-grid';
  grid.dataset.layout = layout;

  (Array.isArray(block?.items) ? block.items : []).forEach((item) => {
    const insight = document.createElement('article');
    insight.className = 'report-insight-card';
    if (item?.tone) {
      insight.dataset.tone = item.tone;
    }
    if (item?.featured) {
      insight.dataset.featured = 'true';
    }

    const label = document.createElement('div');
    label.className = 'report-insight-label';
    label.textContent = item?.label || 'Insight';
    insight.appendChild(label);

    if (item?.value) {
      const value = document.createElement('div');
      value.className = 'report-insight-value';
      value.textContent = formatMetricDisplayValue(item?.label || 'Insight', item.value);
      insight.appendChild(value);
    }

    if (item?.detail) {
      const detail = document.createElement('p');
      detail.className = 'report-insight-detail';
      detail.textContent = item.detail;
      insight.appendChild(detail);
    }

    grid.appendChild(insight);
  });

  card.appendChild(grid);
  return card;
}

function renderReportScenarioCompareBlock(block) {
  const card = buildReportBlockShell(block, 'report-block report-scenario-compare-block');
  appendReportBlockHeader(card, {
    title: block?.title || '',
    subtitle: block?.subtitle || ''
  });

  const grid = document.createElement('div');
  grid.className = 'report-scenario-grid';

  (Array.isArray(block?.scenarios) ? block.scenarios : []).forEach((scenario) => {
    const scenarioCard = document.createElement('article');
    scenarioCard.className = 'report-scenario-card';
    if (scenario?.tone) {
      scenarioCard.dataset.tone = scenario.tone;
    }

    const label = document.createElement('h4');
    label.className = 'report-scenario-title';
    label.textContent = scenario?.label || 'Scenario';
    scenarioCard.appendChild(label);

    if (scenario?.summary) {
      const summary = document.createElement('p');
      summary.className = 'report-scenario-summary';
      summary.textContent = scenario.summary;
      scenarioCard.appendChild(summary);
    }

    appendArtifactMetricItems(scenarioCard, scenario?.metrics, {
      className: 'report-scenario-metrics',
      itemClassName: 'report-scenario-metric'
    });

    if (scenario?.callout) {
      const callout = document.createElement('p');
      callout.className = 'report-scenario-callout';
      callout.textContent = scenario.callout;
      scenarioCard.appendChild(callout);
    }

    grid.appendChild(scenarioCard);
  });

  card.appendChild(grid);
  return card;
}

function renderReportAccordionBlock(block) {
  const card = buildReportBlockShell(block, 'report-block report-accordion-block');
  appendReportBlockHeader(card, {
    title: block?.title || '',
    subtitle: block?.subtitle || ''
  });

  const list = document.createElement('div');
  list.className = 'report-accordion-list';

  (Array.isArray(block?.items) ? block.items : []).forEach((item, index) => {
    const details = document.createElement('details');
    details.className = 'report-accordion-item';
    details.open = item?.defaultOpen === true || index === 0;

    const summary = document.createElement('summary');
    summary.className = 'report-accordion-summary';
    summary.textContent = item?.title || `Detail ${index + 1}`;
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'report-accordion-body';

    const safeBodyHtml = sanitizeSummaryHtml(item?.bodyHtml || '');
    if (safeBodyHtml && htmlToPlainText(safeBodyHtml)) {
      const content = document.createElement('div');
      content.className = 'report-markdown-content';
      content.innerHTML = safeBodyHtml;
      body.appendChild(content);
    } else if (typeof item?.markdown === 'string' && item.markdown.trim()) {
      const content = document.createElement('div');
      content.className = 'report-markdown-content';
      content.appendChild(renderMarkdownFragment(item.markdown));
      body.appendChild(content);
    }

    const bullets = Array.isArray(item?.bullets)
      ? item.bullets.filter((bullet) => typeof bullet === 'string' && bullet.trim())
      : [];
    if (bullets.length > 0) {
      const listEl = document.createElement('ul');
      listEl.className = 'report-callout-bullets';
      bullets.forEach((bullet) => {
        const bulletEl = document.createElement('li');
        bulletEl.textContent = bullet;
        listEl.appendChild(bulletEl);
      });
      body.appendChild(listEl);
    }

    if (body.childElementCount === 0) {
      const empty = document.createElement('p');
      empty.className = 'generated-empty';
      empty.textContent = 'No detail provided.';
      body.appendChild(empty);
    }

    details.appendChild(body);
    list.appendChild(details);
  });

  card.appendChild(list);
  return card;
}

function decorateReportBlockTextEdits(card, module, block, context = {}) {
  if (!(card instanceof HTMLElement) || !Number.isInteger(context.blockIndex)) {
    return card;
  }

  const editContext = {
    module,
    readOnly: context.readOnly,
    onEditGeneratedText: context.onEditGeneratedText
  };
  const basePath = ['generated', 'report', 'blocks', context.blockIndex];
  const decorate = (element, path, options = {}) => decorateInlineGeneratedEdit(element, editContext, path, options);

  decorate(card.querySelector(':scope > .report-block-header .report-block-title'), [...basePath, 'title'], {
    valueType: 'string',
    label: 'Edit report block title'
  });
  decorate(card.querySelector(':scope > .report-block-header .report-block-subtitle'), [...basePath, 'subtitle'], {
    valueType: 'string',
    label: 'Edit report block subtitle'
  });

  switch (block?.type) {
    case 'callout': {
      const body = card.querySelector(':scope .report-callout-body');
      if (body) {
        decorate(body, [...basePath, block.bodyHtml ? 'bodyHtml' : 'markdown'], {
          html: Boolean(block.bodyHtml),
          multiline: true,
          valueType: block.bodyHtml ? 'html' : 'string',
          label: 'Edit callout body'
        });
      }
      card.querySelectorAll(':scope > .report-callout-content > .report-callout-bullets > li').forEach((item, index) => {
        decorate(item, [...basePath, 'bullets', index], {
          valueType: 'string',
          label: 'Edit callout bullet'
        });
      });
      break;
    }
    case 'markdown': {
      decorate(card.querySelector(':scope > .report-markdown-content'), [...basePath, 'markdown'], {
        multiline: true,
        valueType: 'string',
        label: 'Edit markdown copy'
      });
      break;
    }
    case 'table': {
      card.querySelectorAll(':scope .generated-table thead th').forEach((cell, index) => {
        decorate(cell, [...basePath, 'table', 'columns', index], {
          valueType: 'string',
          label: 'Edit table column'
        });
      });
      card.querySelectorAll(':scope .generated-table tbody tr').forEach((row, rowIndex) => {
        row.querySelectorAll('td').forEach((cell, colIndex) => {
          const current = block?.table?.rows?.[rowIndex]?.[colIndex];
          decorate(cell, [...basePath, 'table', 'rows', rowIndex, colIndex], {
            valueType: typeof current === 'number' ? 'number' : 'string',
            label: 'Edit table cell'
          });
        });
      });
      break;
    }
    case 'checklist': {
      card.querySelectorAll(':scope .report-checklist-item').forEach((item, index) => {
        decorate(item.querySelector('.report-checklist-label'), [...basePath, 'items', index, 'label'], {
          valueType: 'string',
          label: 'Edit checklist label'
        });
        decorate(item.querySelector('.report-checklist-note'), [...basePath, 'items', index, 'note'], {
          valueType: 'string',
          label: 'Edit checklist note'
        });
      });
      break;
    }
    case 'sourceList': {
      card.querySelectorAll(':scope .report-source-item').forEach((item, index) => {
        decorate(item.querySelector('.report-source-label'), [...basePath, 'items', index, 'label'], {
          valueType: 'string',
          label: 'Edit source label'
        });
        decorate(item.querySelector('.report-source-kind'), [...basePath, 'items', index, 'kind'], {
          valueType: 'string',
          label: 'Edit source kind'
        });
        decorate(item.querySelector('.report-source-note'), [...basePath, 'items', index, 'note'], {
          valueType: 'string',
          label: 'Edit source note'
        });
      });
      break;
    }
    case 'kpiRow': {
      card.querySelectorAll(':scope .report-kpi-item').forEach((item, index) => {
        decorate(item.querySelector('.report-kpi-label'), [...basePath, 'items', index, 'label'], {
          valueType: 'string',
          label: 'Edit KPI label'
        });
        decorate(item.querySelector('.report-kpi-value'), [...basePath, 'items', index, 'value'], {
          valueType: 'string',
          label: 'Edit KPI value'
        });
        decorate(item.querySelector('.report-kpi-detail'), [...basePath, 'items', index, 'detail'], {
          valueType: 'string',
          label: 'Edit KPI detail'
        });
      });
      break;
    }
    case 'insightGrid': {
      card.querySelectorAll(':scope .report-insight-card').forEach((item, index) => {
        decorate(item.querySelector('.report-insight-label'), [...basePath, 'items', index, 'label'], {
          valueType: 'string',
          label: 'Edit insight label'
        });
        decorate(item.querySelector('.report-insight-value'), [...basePath, 'items', index, 'value'], {
          valueType: 'string',
          label: 'Edit insight value'
        });
        decorate(item.querySelector('.report-insight-detail'), [...basePath, 'items', index, 'detail'], {
          valueType: 'string',
          label: 'Edit insight detail'
        });
      });
      break;
    }
    case 'scenarioCompare': {
      card.querySelectorAll(':scope .report-scenario-card').forEach((item, index) => {
        decorate(item.querySelector('.report-scenario-title'), [...basePath, 'scenarios', index, 'label'], {
          valueType: 'string',
          label: 'Edit scenario label'
        });
        decorate(item.querySelector('.report-scenario-summary'), [...basePath, 'scenarios', index, 'summary'], {
          valueType: 'string',
          label: 'Edit scenario summary'
        });
        decorate(item.querySelector('.report-scenario-callout'), [...basePath, 'scenarios', index, 'callout'], {
          valueType: 'string',
          label: 'Edit scenario callout'
        });
      });
      break;
    }
    case 'accordion': {
      card.querySelectorAll(':scope .report-accordion-item').forEach((item, index) => {
        decorate(item.querySelector('.report-accordion-summary'), [...basePath, 'items', index, 'title'], {
          valueType: 'string',
          label: 'Edit accordion title'
        });
        const body = item.querySelector('.report-accordion-body > .report-markdown-content');
        if (body) {
          const source = block?.items?.[index] || {};
          decorate(body, [...basePath, 'items', index, source.bodyHtml ? 'bodyHtml' : 'markdown'], {
            html: Boolean(source.bodyHtml),
            multiline: true,
            valueType: source.bodyHtml ? 'html' : 'string',
            label: 'Edit accordion body'
          });
        }
        item.querySelectorAll('.report-accordion-body > .report-callout-bullets > li').forEach((bullet, bulletIndex) => {
          decorate(bullet, [...basePath, 'items', index, 'bullets', bulletIndex], {
            valueType: 'string',
            label: 'Edit accordion bullet'
          });
        });
      });
      break;
    }
    default:
      break;
  }

  return card;
}

function renderReportBlock(module, block, context) {
  if (block?.errorMessage) {
    return decorateReportBlockTextEdits(buildReportBlockErrorCard(block, block.errorMessage), module, block, context);
  }

  try {
    let card;
    switch (block?.type) {
      case 'callout':
        card = renderReportCalloutBlock(block);
        break;
      case 'markdown':
        card = renderReportMarkdownBlock(block);
        break;
      case 'table':
        card = renderReportTableBlock(block);
        break;
      case 'chart': {
        const chartIndex = context.chartIndexByBlockId.get(block.id);
        if (!Number.isFinite(chartIndex)) {
          card = buildReportBlockErrorCard(block, 'Could not resolve chart hydration index for this report block.');
          break;
        }
        card = renderReportChartBlock(block, chartIndex);
        break;
      }
      case 'svg':
        card = renderReportSvgBlock(module, block, context.blockIndex);
        break;
      case 'timeline':
        card = renderReportTimelineBlock(module, block, context.blockIndex);
        break;
      case 'checklist':
        card = renderReportChecklistBlock(block);
        break;
      case 'sourceList':
        card = renderReportSourceListBlock(block);
        break;
      case 'kpiRow':
        card = renderReportKpiRowBlock(block);
        break;
      case 'insightGrid':
        card = renderReportInsightGridBlock(block);
        break;
      case 'scenarioCompare':
        card = renderReportScenarioCompareBlock(block);
        break;
      case 'accordion':
        card = renderReportAccordionBlock(block);
        break;
      default:
        card = buildReportBlockErrorCard(block, `Unsupported report block type \"${block?.type || 'unknown'}\".`);
        break;
    }
    return decorateReportBlockTextEdits(card, module, block, context);
  } catch (error) {
    return decorateReportBlockTextEdits(
      buildReportBlockErrorCard(block, error?.message || 'This block could not be rendered.'),
      module,
      block,
      context
    );
  }
}

function getLiquidityCashItems(plan = {}) {
  return Array.isArray(plan.cashItems)
    ? plan.cashItems.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function getLiquidityClientStatus(plan = {}) {
  const status = typeof plan.clientStatus === 'string'
    ? plan.clientStatus.trim().toLowerCase()
    : '';
  if (status === 'retired') {
    return 'retired';
  }
  return 'not-retired';
}

function formatLiquidityMonths(value, { suffix = 'months' } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '';
  }
  const formatted = Number.isInteger(parsed)
    ? String(parsed)
    : parsed.toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    });
  return suffix ? `${formatted} ${suffix}` : formatted;
}

function formatLiquidityCurrency(value, currencySymbol = '€') {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '';
  }
  return formatDisplayCurrency(parsed, currencySymbol);
}

function clampLiquidityRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.min(1, Math.max(0, parsed));
}

function getLiquidityMonthlyExpenditure(plan = {}) {
  const monthlyExpenditure = getPositiveFiniteNumber(plan.monthlyExpenditure);
  if (monthlyExpenditure !== null) {
    return monthlyExpenditure;
  }

  const annualExpenditure = getPositiveFiniteNumber(plan.annualExpenditure);
  return annualExpenditure !== null ? annualExpenditure / 12 : null;
}

function computeLiquidityAssessment(plan = {}) {
  const currencySymbol = normalizeDisplayCurrencySymbol(plan.currencySymbol, '€');
  const clientStatus = getLiquidityClientStatus(plan);
  const retired = clientStatus === 'retired';
  const minimumBufferMonths = getPositiveFiniteNumber(plan.minimumBufferMonths) ?? (retired ? 12 : 3);
  const rawTargetMonths = getPositiveFiniteNumber(plan.targetBufferMonths) ?? (retired ? 24 : 6);
  const targetBufferMonths = Math.max(rawTargetMonths, minimumBufferMonths);
  const currentCash = getFiniteNumber(plan.currentCash);
  const monthlyExpenditure = getLiquidityMonthlyExpenditure(plan);
  const reserve = computeWorkingLiquidityReserve({
    currentCash,
    monthlyExpenditure,
    minimumBufferMonths,
    targetBufferMonths
  });
  const annualExpenditure = reserve.annualExpenditure;
  const targetCash = reserve.targetCash;
  const minimumCash = reserve.minimumCash;
  const months = reserve.monthsCovered;
  const surplusCash = reserve.surplusCash;
  const shortfallCash = reserve.shortfallCash;
  const surplusMonths = monthlyExpenditure !== null && surplusCash > 0
    ? surplusCash / monthlyExpenditure
    : 0;

  let tone = 'neutral';
  let actionMode = 'unknown';
  let statusLabel = 'Needs cash data';
  if (months !== null) {
    if (months < minimumBufferMonths) {
      tone = 'negative';
      actionMode = 'build';
      statusLabel = 'Below safety floor';
    } else if (months < targetBufferMonths) {
      tone = 'warning';
      actionMode = 'top-up';
      statusLabel = 'Building reserve';
    } else if (surplusCash > 0) {
      tone = 'positive';
      actionMode = 'deploy';
      statusLabel = 'Surplus cash ready';
    } else {
      tone = 'positive';
      actionMode = 'hold';
      statusLabel = 'Target covered';
    }
  }

  const defaultHeadline = {
    build: 'Build the emergency fund before anything else.',
    'top-up': 'The reserve is started, but not yet at the gold-standard buffer.',
    deploy: 'The safety buffer is protected. The extra cash needs a job.',
    hold: 'The cash reserve is on target.',
    unknown: 'Add cash and spending figures to size the reserve.'
  }[actionMode];

  const defaultActionLabel = {
    build: 'Cash still to build',
    'top-up': 'Cash still to build',
    deploy: 'Cash to put to work',
    hold: 'Protected reserve',
    unknown: 'Target reserve'
  }[actionMode];

  const actionAmount = actionMode === 'deploy'
    ? surplusCash
    : (actionMode === 'build' || actionMode === 'top-up'
      ? shortfallCash
      : targetCash);

  const targetLabel = plan.targetLabel
    || (retired
      ? `${formatLiquidityMonths(targetBufferMonths)} retired reserve`
      : `${formatLiquidityMonths(targetBufferMonths)} emergency fund`);
  const primaryActionDetail = plan.primaryActionDetail || ({
    build: 'Direct free cash flow here first. Return-seeking investments can wait until the household has breathing room.',
    'top-up': 'Keep topping up until the full target reserve is visible, then future cash can be assigned elsewhere.',
    deploy: 'Keep the target reserve accessible, then discuss where surplus cash belongs: debt, pension, investments, or planned spending.',
    hold: 'Maintain the reserve and route new surplus cash toward the next highest-value objective.',
    unknown: 'The module needs current cash and spending to calculate the buffer.'
  }[actionMode]);

  const progressRatio = months !== null ? clampLiquidityRatio(months / targetBufferMonths) : 0;
  const floorRatio = clampLiquidityRatio(minimumBufferMonths / targetBufferMonths);

  return {
    actionAmount,
    actionMode,
    annualExpenditure,
    clientLabel: retired ? 'Retired reserve' : 'Working reserve',
    clientStatus,
    currencySymbol,
    currentCash,
    floorRatio,
    headline: plan.headline || defaultHeadline,
    minimumBufferMonths,
    minimumCash,
    monthlyExpenditure,
    months,
    monthsLabel: months !== null ? `${formatLiquidityMonths(months)} cash` : '',
    primaryActionDetail,
    primaryActionLabel: plan.primaryActionLabel || defaultActionLabel,
    progressRatio,
    shortfallCash,
    statusLabel,
    surplusCash,
    surplusMonths,
    targetBufferMonths,
    targetCash,
    targetLabel,
    tone
  };
}

function buildLiquidityStat(label, value, detail = '', tone = '') {
  const item = document.createElement('div');
  item.className = 'liquidity-stat';
  if (tone) {
    item.dataset.tone = tone;
  }

  const labelEl = document.createElement('span');
  labelEl.className = 'liquidity-stat-label';
  labelEl.textContent = label;
  item.appendChild(labelEl);

  const valueEl = document.createElement('strong');
  valueEl.className = 'liquidity-stat-value';
  valueEl.textContent = value || '--';
  item.appendChild(valueEl);

  if (detail) {
    const detailEl = document.createElement('span');
    detailEl.className = 'liquidity-stat-detail';
    detailEl.textContent = detail;
    item.appendChild(detailEl);
  }

  return item;
}

function buildLiquidityMeter(assessment) {
  const meter = document.createElement('div');
  meter.className = 'liquidity-meter';
  meter.dataset.tone = assessment.tone;
  meter.style.setProperty('--liquidity-progress', `${Math.round(assessment.progressRatio * 1000) / 10}%`);
  meter.style.setProperty('--liquidity-floor', `${Math.round(assessment.floorRatio * 1000) / 10}%`);

  const track = document.createElement('div');
  track.className = 'liquidity-meter-track';

  const fill = document.createElement('div');
  fill.className = 'liquidity-meter-fill';
  track.appendChild(fill);

  const floorMarker = document.createElement('span');
  floorMarker.className = 'liquidity-meter-marker liquidity-meter-marker-floor';
  floorMarker.textContent = formatLiquidityMonths(assessment.minimumBufferMonths, { suffix: 'mo' });
  track.appendChild(floorMarker);

  const targetMarker = document.createElement('span');
  targetMarker.className = 'liquidity-meter-marker liquidity-meter-marker-target';
  targetMarker.textContent = formatLiquidityMonths(assessment.targetBufferMonths, { suffix: 'mo' });
  track.appendChild(targetMarker);

  meter.appendChild(track);

  const labels = document.createElement('div');
  labels.className = 'liquidity-meter-labels';
  [
    { label: 'Safety floor', value: formatLiquidityMonths(assessment.minimumBufferMonths) },
    { label: 'Target buffer', value: assessment.targetLabel }
  ].forEach((item) => {
    const label = document.createElement('span');
    label.textContent = `${item.label}: ${item.value}`;
    labels.appendChild(label);
  });
  meter.appendChild(labels);

  if (assessment.surplusMonths > 0) {
    const surplus = document.createElement('div');
    surplus.className = 'liquidity-surplus-ribbon';
    surplus.textContent = `+${formatLiquidityMonths(assessment.surplusMonths)} above target`;
    meter.appendChild(surplus);
  }

  return meter;
}

function buildLiquidityHeroCard(module, assessment, {
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const card = document.createElement('section');
  card.className = 'generated-card liquidity-hero-card';
  card.dataset.generatedCard = 'liquidity-hero';
  card.dataset.tone = assessment.tone;

  const { header } = buildGeneratedCardHeader('Cash Control Panel');
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'liquidity-hero-body';

  const command = document.createElement('div');
  command.className = 'liquidity-command';

  const status = document.createElement('span');
  status.className = 'liquidity-status-pill';
  status.dataset.tone = assessment.tone;
  status.textContent = assessment.statusLabel;
  command.appendChild(status);

  const title = document.createElement('h3');
  title.className = 'liquidity-hero-title';
  title.textContent = assessment.headline;
  decorateInlineGeneratedEdit(title, {
    module,
    readOnly,
    onEditGeneratedText
  }, ['generated', 'liquidityPlan', 'headline'], {
    valueType: 'string',
    label: 'Edit liquidity headline'
  });
  command.appendChild(title);

  const safeHtml = sanitizeSummaryHtml(module?.generated?.summaryHtml || '');
  if (safeHtml) {
    const summary = document.createElement('div');
    summary.className = 'liquidity-hero-summary generated-summary-copy';
    summary.innerHTML = safeHtml;
    decorateInlineGeneratedEdit(summary, {
      module,
      readOnly,
      onEditGeneratedText
    }, ['generated', 'summaryHtml'], {
      html: true,
      multiline: true,
      valueType: 'html',
      label: 'Edit liquidity summary'
    });
    command.appendChild(summary);
  } else {
    const detail = document.createElement('p');
    detail.className = 'liquidity-hero-summary';
    detail.textContent = assessment.primaryActionDetail;
    decorateInlineGeneratedEdit(detail, {
      module,
      readOnly,
      onEditGeneratedText
    }, ['generated', 'liquidityPlan', 'primaryActionDetail'], {
      valueType: 'string',
      label: 'Edit liquidity detail'
    });
    command.appendChild(detail);
  }

  const readout = document.createElement('div');
  readout.className = 'liquidity-readout';

  const readoutLabel = document.createElement('span');
  readoutLabel.className = 'liquidity-readout-label';
  readoutLabel.textContent = assessment.clientLabel;
  readout.appendChild(readoutLabel);

  const readoutValue = document.createElement('strong');
  readoutValue.className = 'liquidity-readout-value';
  readoutValue.textContent = assessment.months !== null
    ? formatLiquidityMonths(assessment.months, { suffix: '' })
    : '--';
  readout.appendChild(readoutValue);

  const readoutUnit = document.createElement('span');
  readoutUnit.className = 'liquidity-readout-unit';
  readoutUnit.textContent = 'months cash';
  readout.appendChild(readoutUnit);

  command.appendChild(readout);
  body.appendChild(command);

  const cockpit = document.createElement('div');
  cockpit.className = 'liquidity-cockpit';
  cockpit.appendChild(buildLiquidityMeter(assessment));

  const stats = document.createElement('div');
  stats.className = 'liquidity-stat-grid';
  stats.appendChild(buildLiquidityStat(
    'Current cash',
    formatLiquidityCurrency(assessment.currentCash, assessment.currencySymbol),
    assessment.monthsLabel
  ));
  stats.appendChild(buildLiquidityStat(
    'Target reserve',
    formatLiquidityCurrency(assessment.targetCash, assessment.currencySymbol),
    assessment.targetLabel
  ));
  stats.appendChild(buildLiquidityStat(
    assessment.primaryActionLabel,
    formatLiquidityCurrency(assessment.actionAmount, assessment.currencySymbol),
    assessment.primaryActionDetail,
    assessment.tone
  ));
  cockpit.appendChild(stats);
  body.appendChild(cockpit);

  card.appendChild(body);
  return card;
}

function getDefaultLiquiditySteps(assessment) {
  if (assessment.actionMode === 'build') {
    return [
      {
        label: 'Build the safety floor',
        detail: `Get to ${formatLiquidityMonths(assessment.minimumBufferMonths)} first so an emergency does not force borrowing or asset sales.`
      },
      {
        label: 'Then reach gold standard',
        detail: `Keep going until the reserve reaches ${formatLiquidityMonths(assessment.targetBufferMonths)} of spending.`
      },
      {
        label: 'Invest only after protection',
        detail: 'Once the reserve is funded, future surplus can be put to work with more confidence.'
      }
    ];
  }

  if (assessment.actionMode === 'top-up') {
    return [
      {
        label: 'Finish the reserve',
        detail: `The next milestone is ${formatLiquidityCurrency(assessment.shortfallCash, assessment.currencySymbol)} more cash.`
      },
      {
        label: 'Keep access simple',
        detail: 'Use accessible cash or deposits for the emergency fund, not volatile long-term assets.'
      },
      {
        label: 'Pre-commit future surplus',
        detail: 'Once the target is hit, route extra cash away from idle deposits.'
      }
    ];
  }

  if (assessment.actionMode === 'deploy') {
    return [
      {
        label: 'Keep the reserve intact',
        detail: `Hold about ${formatLiquidityCurrency(assessment.targetCash, assessment.currencySymbol)} as the accessible buffer.`
      },
      {
        label: 'Give surplus cash a job',
        detail: `The visible surplus is about ${formatLiquidityCurrency(assessment.surplusCash, assessment.currencySymbol)}. Discuss debt, pension, investments, or known spending.`
      },
      {
        label: 'Stage the move if needed',
        detail: 'If the client is nervous, phase implementation instead of letting all excess cash sit idle indefinitely.'
      }
    ];
  }

  return [
    {
      label: 'Maintain the buffer',
      detail: 'Keep the target reserve accessible and review it when spending changes.'
    },
    {
      label: 'Assign future surplus',
      detail: 'New cash above the target should have a planned destination.'
    }
  ];
}

function buildLiquidityActionCard(plan, assessment, module, {
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const card = document.createElement('section');
  card.className = 'generated-card liquidity-action-card';
  card.dataset.generatedCard = 'liquidity-action';
  card.dataset.tone = assessment.tone;

  const { header } = buildGeneratedCardHeader('Priority Move');
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'liquidity-action-body';

  const actionTop = document.createElement('div');
  actionTop.className = 'liquidity-action-top';

  const label = document.createElement('span');
  label.className = 'liquidity-action-label';
  label.textContent = assessment.primaryActionLabel;
  decorateInlineGeneratedEdit(label, {
    module,
    readOnly,
    onEditGeneratedText
  }, ['generated', 'liquidityPlan', 'primaryActionLabel'], {
    valueType: 'string',
    label: 'Edit liquidity action label'
  });
  actionTop.appendChild(label);

  const amount = document.createElement('strong');
  amount.className = 'liquidity-action-amount';
  amount.textContent = formatLiquidityCurrency(assessment.actionAmount, assessment.currencySymbol) || '--';
  actionTop.appendChild(amount);

  const detail = document.createElement('p');
  detail.className = 'liquidity-action-detail';
  detail.textContent = assessment.primaryActionDetail;
  decorateInlineGeneratedEdit(detail, {
    module,
    readOnly,
    onEditGeneratedText
  }, ['generated', 'liquidityPlan', 'primaryActionDetail'], {
    valueType: 'string',
    label: 'Edit liquidity action detail'
  });
  actionTop.appendChild(detail);
  body.appendChild(actionTop);

  const hasCustomSteps = Array.isArray(plan.nextSteps) && plan.nextSteps.length > 0;
  const steps = hasCustomSteps
    ? plan.nextSteps
    : getDefaultLiquiditySteps(assessment);
  const list = document.createElement('ol');
  list.className = 'liquidity-step-list';
  steps.slice(0, 4).forEach((step, stepIndex) => {
    const item = document.createElement('li');
    item.className = 'liquidity-step-item';
    const title = document.createElement('strong');
    title.textContent = step.label || 'Next step';
    if (hasCustomSteps) {
      decorateInlineGeneratedEdit(title, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'liquidityPlan', 'nextSteps', stepIndex, 'label'], {
        valueType: 'string',
        label: 'Edit liquidity step label'
      });
    }
    item.appendChild(title);
    if (step.detail || step.body) {
      const stepDetail = document.createElement('span');
      stepDetail.textContent = step.detail || step.body;
      if (hasCustomSteps) {
        decorateInlineGeneratedEdit(stepDetail, {
          module,
          readOnly,
          onEditGeneratedText
        }, ['generated', 'liquidityPlan', 'nextSteps', stepIndex, step.detail ? 'detail' : 'body'], {
          valueType: 'string',
          label: 'Edit liquidity step detail'
        });
      }
      item.appendChild(stepDetail);
    }
    list.appendChild(item);
  });
  body.appendChild(list);

  card.appendChild(body);
  return card;
}

function buildLiquidityCashCard(plan, assessment, module, {
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const card = document.createElement('section');
  card.className = 'generated-card liquidity-cash-card';
  card.dataset.generatedCard = 'liquidity-cash';

  const { header } = buildGeneratedCardHeader('Cash Position');
  card.appendChild(header);

  const cashItems = getLiquidityCashItems(plan);
  if (cashItems.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = assessment.currentCash !== null
      ? 'Total cash was supplied without an account breakdown.'
      : 'No cash position supplied yet.';
    card.appendChild(empty);
    return card;
  }

  const list = document.createElement('div');
  list.className = 'liquidity-cash-list';
  cashItems.forEach((cashItem, cashIndex) => {
    const row = document.createElement('div');
    row.className = 'liquidity-cash-row';

    const label = document.createElement('span');
    label.textContent = cashItem.label || 'Cash';
    decorateInlineGeneratedEdit(label, {
      module,
      readOnly,
      onEditGeneratedText
    }, ['generated', 'liquidityPlan', 'cashItems', cashIndex, 'label'], {
      valueType: 'string',
      label: 'Edit cash label'
    });
    row.appendChild(label);

    const amount = document.createElement('strong');
    amount.textContent = formatLiquidityCurrency(cashItem.amount, assessment.currencySymbol) || '--';
    decorateInlineGeneratedEdit(amount, {
      module,
      readOnly,
      onEditGeneratedText
    }, ['generated', 'liquidityPlan', 'cashItems', cashIndex, 'amount'], {
      valueType: 'number',
      label: 'Edit cash amount'
    });
    row.appendChild(amount);

    list.appendChild(row);
  });
  card.appendChild(list);
  return card;
}

function buildLiquidityEvidenceCard(plan, module, {
  readOnly = false,
  onEditGeneratedText = null
} = {}) {
  const evidenceCards = Array.isArray(plan.evidenceCards) ? plan.evidenceCards : [];
  if (evidenceCards.length === 0) {
    return null;
  }

  const card = document.createElement('section');
  card.className = 'generated-card liquidity-evidence-card';
  card.dataset.generatedCard = 'liquidity-evidence';

  const { header } = buildGeneratedCardHeader('Irish Cash Context');
  card.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'liquidity-evidence-grid';
  evidenceCards.slice(0, 4).forEach((item, evidenceIndex) => {
    const evidence = document.createElement('article');
    evidence.className = 'liquidity-evidence-item';
    if (item.tone) {
      evidence.dataset.tone = item.tone;
    }

    const label = document.createElement('span');
    label.className = 'liquidity-evidence-label';
    label.textContent = item.label || 'Evidence';
    decorateInlineGeneratedEdit(label, {
      module,
      readOnly,
      onEditGeneratedText
    }, ['generated', 'liquidityPlan', 'evidenceCards', evidenceIndex, 'label'], {
      valueType: 'string',
      label: 'Edit evidence label'
    });
    evidence.appendChild(label);

    if (item.value) {
      const value = document.createElement('strong');
      value.className = 'liquidity-evidence-value';
      value.textContent = item.value;
      decorateInlineGeneratedEdit(value, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'liquidityPlan', 'evidenceCards', evidenceIndex, 'value'], {
        valueType: 'string',
        label: 'Edit evidence value'
      });
      evidence.appendChild(value);
    }

    if (item.detail || item.body) {
      const detail = document.createElement('p');
      detail.className = 'liquidity-evidence-detail';
      detail.textContent = item.detail || item.body;
      decorateInlineGeneratedEdit(detail, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'liquidityPlan', 'evidenceCards', evidenceIndex, item.detail ? 'detail' : 'body'], {
        valueType: 'string',
        label: 'Edit evidence detail'
      });
      evidence.appendChild(detail);
    }

    const safeHref = sanitizeExternalUrl(item.sourceUrl);
    if (safeHref || item.sourceLabel) {
      const source = safeHref ? document.createElement('a') : document.createElement('span');
      source.className = 'liquidity-evidence-source';
      source.textContent = item.sourceLabel || 'Source';
      if (safeHref) {
        source.href = safeHref;
        source.target = '_blank';
        source.rel = 'noreferrer noopener';
      }
      decorateInlineGeneratedEdit(source, {
        module,
        readOnly,
        onEditGeneratedText
      }, ['generated', 'liquidityPlan', 'evidenceCards', evidenceIndex, 'sourceLabel'], {
        valueType: 'string',
        label: 'Edit evidence source'
      });
      evidence.appendChild(source);
    }

    grid.appendChild(evidence);
  });
  card.appendChild(grid);
  return card;
}

const HOUSE_PURCHASE_WIZARD_STEPS = Object.freeze([
  { title: 'Your goal', detail: 'Set the destination and the planning rule to illustrate.' },
  { title: 'Who is buying', detail: 'Tell us whether this is a single or joint application.' },
  { title: 'Income', detail: 'Separate dependable income from variable income.' },
  { title: 'Savings and assets', detail: 'Protect cash that should not be used for the purchase.' },
  { title: 'Debts and commitments', detail: 'Capture repayments and household responsibilities.' },
  { title: 'Monthly household position', detail: 'Test the purchase against real monthly cash flow.' },
  { title: 'Target property', detail: 'Describe the home, lender position and buying costs.' },
  { title: 'Buyer supports', detail: 'Screen Help to Buy and the First Home Scheme.' },
  { title: 'Results', detail: 'Review the facts that will power the plan.' }
]);

const HOUSE_PURCHASE_LOCAL_AUTHORITIES = Object.freeze([
  ['carlow', 'Carlow County Council'],
  ['cavan', 'Cavan County Council'],
  ['clare', 'Clare County Council'],
  ['cork_city', 'Cork City Council'],
  ['cork_county', 'Cork County Council'],
  ['donegal', 'Donegal County Council'],
  ['dublin_city', 'Dublin City Council'],
  ['dun_laoghaire_rathdown', 'Dún Laoghaire–Rathdown County Council'],
  ['fingal', 'Fingal County Council'],
  ['galway_city', 'Galway City Council'],
  ['galway_county', 'Galway County Council'],
  ['kerry', 'Kerry County Council'],
  ['kildare', 'Kildare County Council'],
  ['kilkenny', 'Kilkenny County Council'],
  ['laois', 'Laois County Council'],
  ['leitrim', 'Leitrim County Council'],
  ['limerick', 'Limerick City and County Council'],
  ['longford', 'Longford County Council'],
  ['louth', 'Louth County Council'],
  ['mayo', 'Mayo County Council'],
  ['meath', 'Meath County Council'],
  ['monaghan', 'Monaghan County Council'],
  ['offaly', 'Offaly County Council'],
  ['roscommon', 'Roscommon County Council'],
  ['sligo', 'Sligo County Council'],
  ['south_dublin', 'South Dublin County Council'],
  ['tipperary', 'Tipperary County Council'],
  ['waterford', 'Waterford City and County Council'],
  ['westmeath', 'Westmeath County Council'],
  ['wexford', 'Wexford County Council'],
  ['wicklow', 'Wicklow County Council']
]);

function cloneHousePurchaseDraft(draft) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(draft || {});
    } catch (_error) {
      // Fall through to the plain-data clone used by legacy browsers.
    }
  }
  return JSON.parse(JSON.stringify(draft || {}));
}

function setHousePurchaseDraftValue(draft, path, value) {
  const next = cloneHousePurchaseDraft(draft);
  let cursor = next;
  path.forEach((segment, index) => {
    if (index === path.length - 1) {
      cursor[segment] = value;
      return;
    }
    const nextSegment = path[index + 1];
    if (!cursor[segment] || typeof cursor[segment] !== 'object') {
      cursor[segment] = Number.isInteger(nextSegment) ? [] : {};
    }
    cursor = cursor[segment];
  });
  return next;
}

function makeHousePurchaseApplicant(index) {
  return {
    id: `applicant-${index + 1}`,
    label: index === 0 ? 'Applicant 1' : 'Applicant 2',
    age: null,
    employmentStatus: 'employee',
    grossAnnualIncome: null,
    variableAnnualIncome: 0,
    lenderRecognisedVariableAnnualIncome: 0,
    incomeReliability: 'stable',
    existingMonthlyDebtPayments: 0,
    schemeBuyerStatus: 'unknown',
    freshStartReason: '',
    previouslyOwnedPropertyAnywhere: null,
    retainedInterestInPreviousProperty: null,
    rightToResideInIreland: null
  };
}

function getHousePurchaseEditor(module) {
  const editor = module?.ui?.housePurchaseEditor;
  if (!editor || typeof editor !== 'object' || Array.isArray(editor) || editor.active === false) {
    return null;
  }
  const draft = editor.draft && typeof editor.draft === 'object'
    ? editor.draft
    : (editor.inputs && typeof editor.inputs === 'object' ? editor.inputs : null);
  if (!draft) {
    return null;
  }
  return {
    draft,
    stepIndex: Math.max(0, Math.min(
      HOUSE_PURCHASE_WIZARD_STEPS.length - 1,
      Math.round(Number(editor.stepIndex) || 0)
    ))
  };
}

function parseHousePurchaseNumber(value, { nullable = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text) {
    return nullable ? null : 0;
  }
  const parsed = Number(text.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : (nullable ? null : 0);
}

function parseHousePurchaseScenarioNumber(value, { divisor = 1 } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = Number(text.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed / divisor : null;
}

function formatHousePurchaseInputNumber(value, multiplier = 1) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(Number((parsed * multiplier).toFixed(4))) : '';
}

function makeHousePurchaseField({
  label,
  value = '',
  type = 'text',
  options = null,
  help = '',
  prefix = '',
  suffix = '',
  min = null,
  max = null,
  step = null,
  inputMode = null,
  required = false,
  wide = false,
  onChange
}) {
  const field = document.createElement('label');
  field.className = 'house-purchase-field';
  if (wide) {
    field.classList.add('is-wide');
  }

  const labelText = document.createElement('span');
  labelText.className = 'house-purchase-field-label';
  labelText.textContent = label;
  if (required) {
    const requiredText = document.createElement('span');
    requiredText.className = 'house-purchase-required';
    requiredText.textContent = ' Required';
    labelText.appendChild(requiredText);
  }
  field.appendChild(labelText);

  const controlWrap = document.createElement('span');
  controlWrap.className = 'house-purchase-control-wrap';
  if (prefix) {
    const prefixNode = document.createElement('span');
    prefixNode.className = 'house-purchase-control-affix';
    prefixNode.textContent = prefix;
    controlWrap.appendChild(prefixNode);
  }

  let control;
  if (Array.isArray(options)) {
    control = document.createElement('select');
    options.forEach(([optionValue, optionLabel]) => {
      const option = document.createElement('option');
      option.value = String(optionValue);
      option.textContent = optionLabel;
      control.appendChild(option);
    });
  } else {
    control = document.createElement('input');
    control.type = type;
  }
  control.className = 'house-purchase-control';
  control.value = value ?? '';
  if (min !== null) control.min = String(min);
  if (max !== null) control.max = String(max);
  if (step !== null) control.step = String(step);
  if (inputMode) control.inputMode = inputMode;
  control.required = Boolean(required);
  control.addEventListener('change', () => onChange?.(control.value));
  controlWrap.appendChild(control);

  if (suffix) {
    const suffixNode = document.createElement('span');
    suffixNode.className = 'house-purchase-control-affix';
    suffixNode.textContent = suffix;
    controlWrap.appendChild(suffixNode);
  }
  field.appendChild(controlWrap);

  if (help) {
    const helpText = document.createElement('span');
    helpText.className = 'house-purchase-field-help';
    helpText.textContent = help;
    field.appendChild(helpText);
  }
  return field;
}

function makeHousePurchaseBooleanField({ label, value, help = '', onChange, wide = false }) {
  return makeHousePurchaseField({
    label,
    value: value === true ? 'yes' : (value === false ? 'no' : ''),
    options: [['', 'Select…'], ['yes', 'Yes'], ['no', 'No']],
    help,
    wide,
    onChange: (next) => onChange(next === '' ? null : next === 'yes')
  });
}

function makeHousePurchaseGroup(title, detail = '') {
  const group = document.createElement('div');
  group.className = 'house-purchase-form-group';
  const heading = document.createElement('h4');
  heading.textContent = title;
  group.appendChild(heading);
  if (detail) {
    const copy = document.createElement('p');
    copy.textContent = detail;
    group.appendChild(copy);
  }
  return group;
}

function renderHousePurchaseWizardStep(stepIndex, draft, updateDraft) {
  const content = document.createElement('div');
  content.className = 'house-purchase-step-content';
  const grid = document.createElement('div');
  grid.className = 'house-purchase-form-grid';
  const applicants = Array.isArray(draft.applicants) && draft.applicants.length > 0
    ? draft.applicants
    : [makeHousePurchaseApplicant(0)];
  const activeApplicants = draft.applicationType === 'joint'
    ? [applicants[0] || makeHousePurchaseApplicant(0), applicants[1] || makeHousePurchaseApplicant(1)]
    : [applicants[0] || makeHousePurchaseApplicant(0)];

  const addCurrency = (label, path, value, help = '', options = {}) => grid.appendChild(makeHousePurchaseField({
    label,
    value: formatHousePurchaseInputNumber(value),
    type: 'number',
    min: 0,
    step: 100,
    inputMode: 'decimal',
    prefix: '€',
    help,
    onChange: (next) => updateDraft(path, parseHousePurchaseNumber(next, { nullable: options.nullable })),
    ...options
  }));

  if (stepIndex === 0) {
    grid.appendChild(makeHousePurchaseField({
      label: 'Target property price',
      value: formatHousePurchaseInputNumber(draft.targetPropertyPrice),
      type: 'number', min: 1, step: 5000, inputMode: 'decimal', prefix: '€', required: true,
      help: 'Use the price you would like the plan to test.',
      onChange: (next) => updateDraft(['targetPropertyPrice'], parseHousePurchaseNumber(next, { nullable: true }))
    }));
    grid.appendChild(makeHousePurchaseField({
      label: 'Target purchase date',
      value: draft.targetPurchaseDate || '',
      type: 'date', required: true,
      help: 'The planner treats this as the end of the selected month.',
      onChange: (next) => updateDraft(['targetPurchaseDate'], next || null)
    }));
    grid.appendChild(makeHousePurchaseField({
      label: 'Central Bank buyer category',
      value: draft.lendingCategory || 'unknown',
      options: [
        ['unknown', 'Not confirmed'],
        ['first_time_buyer', 'First-time buyer'],
        ['second_or_subsequent', 'Second or subsequent buyer']
      ],
      required: true,
      help: 'This sets the regulatory income-limit illustration only; it does not determine scheme status.',
      wide: true,
      onChange: (next) => updateDraft(['lendingCategory'], next)
    }));
  } else if (stepIndex === 1) {
    grid.appendChild(makeHousePurchaseField({
      label: 'Application type',
      value: draft.applicationType || 'single',
      options: [['single', 'Buying alone'], ['joint', 'Buying together']],
      required: true,
      wide: true,
      onChange: (nextType) => {
        updateDraft([], (current) => {
          current.applicationType = nextType;
          const nextApplicants = Array.isArray(current.applicants) ? [...current.applicants] : [];
          if (!nextApplicants[0]) nextApplicants[0] = makeHousePurchaseApplicant(0);
          if (nextType === 'joint' && !nextApplicants[1]) nextApplicants[1] = makeHousePurchaseApplicant(1);
          current.applicants = nextType === 'joint' ? nextApplicants.slice(0, 2) : nextApplicants.slice(0, 1);
          if (nextType === 'single') {
            current.cashSavingsContributions = [{
              ownerId: current.applicants[0].id,
              amount: Number(current.currentCashSavings) || 0
            }];
          }
          return current;
        }, { replace: true, requestRender: true });
      }
    }));
    content.appendChild(grid);
    activeApplicants.forEach((applicant, applicantIndex) => {
      const group = makeHousePurchaseGroup(applicant.label || `Applicant ${applicantIndex + 1}`);
      const applicantGrid = document.createElement('div');
      applicantGrid.className = 'house-purchase-form-grid';
      applicantGrid.appendChild(makeHousePurchaseField({
        label: 'Display label', value: applicant.label || '',
        onChange: (next) => updateDraft(['applicants', applicantIndex, 'label'], next)
      }));
      applicantGrid.appendChild(makeHousePurchaseField({
        label: 'Age', value: formatHousePurchaseInputNumber(applicant.age), type: 'number', min: 19, max: 100,
        step: 1, inputMode: 'numeric', required: true,
        onChange: (next) => updateDraft(['applicants', applicantIndex, 'age'], parseHousePurchaseNumber(next, { nullable: true }))
      }));
      applicantGrid.appendChild(makeHousePurchaseField({
        label: 'Employment', value: applicant.employmentStatus || 'employee',
        options: [['employee', 'Employee'], ['self_employed', 'Self-employed'], ['contractor', 'Contractor'], ['student', 'Student'], ['other', 'Other']],
        onChange: (next) => updateDraft(['applicants', applicantIndex, 'employmentStatus'], next)
      }));
      applicantGrid.appendChild(makeHousePurchaseField({
        label: 'Buyer status for supports', value: applicant.schemeBuyerStatus || 'unknown',
        options: [['unknown', 'Not confirmed'], ['first_time_buyer', 'First-time buyer'], ['fresh_start', 'Fresh-start applicant'], ['previous_owner', 'Previous owner']],
        help: 'This remains separate from the Central Bank lending category.',
        onChange: (next) => updateDraft(['applicants', applicantIndex, 'schemeBuyerStatus'], next, { requestRender: true })
      }));
      if (applicant.schemeBuyerStatus === 'fresh_start') {
        applicantGrid.appendChild(makeHousePurchaseField({
          label: 'Fresh-start context', value: applicant.freshStartReason || '', wide: true,
          help: 'Use a short planning note only; do not include sensitive identifiers.',
          onChange: (next) => updateDraft(['applicants', applicantIndex, 'freshStartReason'], next)
        }));
      }
      group.appendChild(applicantGrid);
      content.appendChild(group);
    });
  } else if (stepIndex === 2) {
    activeApplicants.forEach((applicant, applicantIndex) => {
      const group = makeHousePurchaseGroup(applicant.label || `Applicant ${applicantIndex + 1}`, 'Only lender-recognised variable income enters the base calculation.');
      const applicantGrid = document.createElement('div');
      applicantGrid.className = 'house-purchase-form-grid';
      const incomeField = (label, key, help = '') => makeHousePurchaseField({
        label, value: formatHousePurchaseInputNumber(applicant[key]), type: 'number', min: 0, step: 1000,
        inputMode: 'decimal', prefix: '€', help,
        onChange: (next) => updateDraft(['applicants', applicantIndex, key], parseHousePurchaseNumber(next, { nullable: key === 'grossAnnualIncome' }))
      });
      applicantGrid.appendChild(incomeField('Gross annual base income', 'grossAnnualIncome'));
      applicantGrid.appendChild(incomeField('Variable annual income', 'variableAnnualIncome', 'Shown for context; excluded unless a lender-recognised amount is entered.'));
      applicantGrid.appendChild(incomeField('Lender-recognised variable income', 'lenderRecognisedVariableAnnualIncome'));
      applicantGrid.appendChild(makeHousePurchaseField({
        label: 'Income reliability', value: applicant.incomeReliability || 'unknown',
        options: [['stable', 'Stable'], ['variable', 'Variable'], ['unknown', 'Not assessed']],
        onChange: (next) => updateDraft(['applicants', applicantIndex, 'incomeReliability'], next)
      }));
      group.appendChild(applicantGrid);
      content.appendChild(group);
    });
  } else if (stepIndex === 3) {
    grid.appendChild(makeHousePurchaseField({
      label: 'Current cash savings',
      value: formatHousePurchaseInputNumber(draft.currentCashSavings),
      type: 'number', min: 0, step: 100, inputMode: 'decimal', prefix: '€', required: true,
      help: 'Include only cash explicitly available to this plan.',
      onChange: (nextValue) => {
        const amount = parseHousePurchaseNumber(nextValue);
        updateDraft([], (current) => {
          current.currentCashSavings = amount;
          if (current.applicationType !== 'joint') {
            const owner = Array.isArray(current.applicants) && current.applicants[0]
              ? current.applicants[0]
              : makeHousePurchaseApplicant(0);
            current.cashSavingsContributions = [{ ownerId: owner.id, amount }];
          }
          return current;
        }, { replace: true, requestRender: true });
      }
    }));
    addCurrency('Ringfenced for other goals', ['amountRingfencedForOtherGoals'], draft.amountRingfencedForOtherGoals);
    grid.appendChild(makeHousePurchaseField({
      label: 'Emergency reserve', value: draft.emergencyReserveMode || 'suggested',
      options: [['suggested', 'Use Planéir suggested reserve'], ['custom', 'Set a custom reserve']],
      help: 'The suggested reserve uses household essentials and retains the existing Liquidity safety floor.',
      onChange: (next) => updateDraft(['emergencyReserveMode'], next, { requestRender: true })
    }));
    if (draft.emergencyReserveMode === 'custom') {
      addCurrency('Custom emergency reserve', ['emergencyReserveTarget'], draft.emergencyReserveTarget, 'This remains protected after purchase.', { required: true });
    }
    addCurrency('Current monthly saving', ['currentMonthlySavings'], draft.currentMonthlySavings);
    addCurrency('Planned monthly saving', ['plannedMonthlySavings'], draft.plannedMonthlySavings, 'Used for the base deposit journey.', { nullable: true });
    if (draft.applicationType === 'joint') activeApplicants.forEach((applicant, applicantIndex) => {
      const current = Array.isArray(draft.cashSavingsContributions)
        ? draft.cashSavingsContributions.find((item) => item?.ownerId === applicant.id)?.amount
        : null;
      grid.appendChild(makeHousePurchaseField({
        label: `${applicant.label || `Applicant ${applicantIndex + 1}`} contribution`,
        value: formatHousePurchaseInputNumber(current), type: 'number', min: 0, step: 100, inputMode: 'decimal', prefix: '€',
        help: 'Contribution display only; the total must equal current cash savings.',
        onChange: (nextValue) => {
          updateDraft([], (currentDraft) => {
            const rows = Array.isArray(currentDraft.cashSavingsContributions)
              ? [...currentDraft.cashSavingsContributions]
              : [];
            const rowIndex = rows.findIndex((item) => item?.ownerId === applicant.id);
            const row = { ownerId: applicant.id, amount: parseHousePurchaseNumber(nextValue) };
            if (rowIndex >= 0) rows[rowIndex] = row;
            else rows.push(row);
            currentDraft.cashSavingsContributions = rows;
            return currentDraft;
          }, { replace: true, requestRender: true });
        }
      }));
    });
    const contributionTotal = draft.applicationType === 'joint' && Array.isArray(draft.cashSavingsContributions)
      ? draft.cashSavingsContributions.reduce((sum, item) => sum + (Number(item?.amount) || 0), 0)
      : (Number(draft.currentCashSavings) || 0);
    const splitSummary = document.createElement('div');
    splitSummary.className = 'house-purchase-split-summary';
    splitSummary.dataset.tone = Math.abs(contributionTotal - (Number(draft.currentCashSavings) || 0)) <= 0.01 ? 'positive' : 'negative';
    splitSummary.innerHTML = draft.applicationType === 'joint'
      ? `<strong>Contribution split: ${formatHousePurchaseCurrency(contributionTotal)} of ${formatHousePurchaseCurrency(draft.currentCashSavings)}</strong><span>${Math.abs(contributionTotal - (Number(draft.currentCashSavings) || 0)) <= 0.01 ? 'Split is balanced.' : 'Adjust the two contributions so they total current cash savings.'}</span>`
      : `<strong>${formatHousePurchaseCurrency(draft.currentCashSavings)} assigned to ${escapeSummaryText(activeApplicants[0]?.label || 'Applicant 1')}</strong><span>The single-buyer contribution stays in sync automatically.</span>`;
    grid.appendChild(splitSummary);
    const lumpSum = Array.isArray(draft.lumpSums) && draft.lumpSums.length > 0 ? draft.lumpSums[0] : {};
    addCurrency('Expected lump sum', ['lumpSums', 0, 'amount'], lumpSum.amount, 'Only confirmed lump sums enter the base route.', { nullable: true });
    grid.appendChild(makeHousePurchaseField({
      label: 'Lump-sum date', value: lumpSum.expectedDate || '', type: 'date',
      onChange: (next) => updateDraft(['lumpSums', 0, 'expectedDate'], next || null)
    }));
    grid.appendChild(makeHousePurchaseField({
      label: 'Lump-sum confidence', value: lumpSum.confidence || 'estimated',
      options: [['estimated', 'Estimated'], ['confirmed', 'Confirmed']],
      onChange: (next) => updateDraft(['lumpSums', 0, 'confidence'], next)
    }));
  } else if (stepIndex === 4) {
    activeApplicants.forEach((applicant, applicantIndex) => {
      addCurrency(`${applicant.label || `Applicant ${applicantIndex + 1}`} monthly debt repayments`, ['applicants', applicantIndex, 'existingMonthlyDebtPayments'], applicant.existingMonthlyDebtPayments);
    });
    grid.appendChild(makeHousePurchaseField({
      label: 'Dependants', value: formatHousePurchaseInputNumber(draft.dependants), type: 'number', min: 0, step: 1, inputMode: 'numeric',
      onChange: (next) => updateDraft(['dependants'], parseHousePurchaseNumber(next))
    }));
    addCurrency('Other known monthly commitments', ['otherKnownMonthlyCommitments'], draft.otherKnownMonthlyCommitments, 'Exclude mortgage/rent and the debt payments already entered.');
  } else if (stepIndex === 5) {
    addCurrency('Monthly net household income', ['monthlyNetHouseholdIncome'], draft.monthlyNetHouseholdIncome, 'Use the household total after tax.', { nullable: true, required: true });
    addCurrency('Essential expenses excluding housing and debt', ['monthlyEssentialExpensesExcludingHousingDebtAndRent'], draft.monthlyEssentialExpensesExcludingHousingDebtAndRent, '', { nullable: true, required: true });
    addCurrency('Current monthly rent', ['currentMonthlyRent'], draft.currentMonthlyRent, '', { nullable: true });
    addCurrency('Estimated monthly ownership costs', ['estimatedMonthlyOwnershipCosts'], draft.estimatedMonthlyOwnershipCosts, 'Insurance, maintenance, management fees and similar costs; exclude the mortgage.', { nullable: true });
  } else if (stepIndex === 6) {
    grid.appendChild(makeHousePurchaseField({
      label: 'Acquisition type', value: draft.acquisitionType || 'unknown',
      options: [['unknown', 'Not chosen'], ['new_build', 'New build'], ['second_hand', 'Second-hand home'], ['self_build', 'Self-build'], ['tenant_purchase', 'Tenant purchase']],
      required: true,
      onChange: (next) => updateDraft([], (current) => {
        current.acquisitionType = next;
        const defaultsByType = { new_build: 400, second_hand: 600, self_build: 800, tenant_purchase: 600, unknown: 600 };
        const currentSurvey = finiteHousePurchaseNumber(current.purchaseCosts?.surveyOrEngineer);
        if (currentSurvey === null || [400, 600, 800].includes(currentSurvey)) {
          current.purchaseCosts = {
            ...(current.purchaseCosts || {}),
            surveyOrEngineer: defaultsByType[next] ?? 600
          };
        }
        return current;
      }, { replace: true, requestRender: true })
    }));
    grid.appendChild(makeHousePurchaseField({
      label: 'Dwelling type', value: draft.dwellingType || 'unknown',
      options: [['unknown', 'Not chosen'], ['house', 'House'], ['apartment', 'Apartment'], ['self_build', 'Self-build']],
      required: true,
      onChange: (next) => updateDraft(['dwellingType'], next)
    }));
    grid.appendChild(makeHousePurchaseField({
      label: 'Intended use', value: draft.intendedUse || 'principal_private_residence',
      options: [['principal_private_residence', 'My/our principal home']],
      onChange: (next) => updateDraft(['intendedUse'], next)
    }));
    grid.appendChild(makeHousePurchaseField({
      label: 'Local authority', value: draft.localAuthorityCode || '',
      options: [['', 'Select area…'], ...HOUSE_PURCHASE_LOCAL_AUTHORITIES],
      help: 'Needed to screen the First Home Scheme price ceiling.',
      onChange: (next) => updateDraft(['localAuthorityCode'], next || null)
    }));
    if (draft.acquisitionType === 'tenant_purchase') {
      grid.appendChild(makeHousePurchaseBooleanField({
        label: 'Landlord notice of termination received?', value: draft.tenantNoticeReceived,
        onChange: (next) => updateDraft(['tenantNoticeReceived'], next)
      }));
    }
    const lender = draft.lenderCapacity || {};
    grid.appendChild(makeHousePurchaseField({
      label: 'Lender position', value: lender.status || 'unknown',
      options: [['unknown', 'Not confirmed'], ['not_obtained', 'Not obtained'], ['estimated', 'Planning estimate'], ['confirmed', 'Confirmed / AIP input']],
      onChange: (next) => updateDraft(['lenderCapacity', 'status'], next)
    }));
    addCurrency('Lender / AIP capacity', ['lenderCapacity', 'amount'], lender.amount, 'Shown separately from the Central Bank illustration.', { nullable: true });
    grid.appendChild(makeHousePurchaseField({
      label: 'Lender', value: lender.lenderId || '',
      options: [['', 'Not selected'], ['aib', 'AIB'], ['ebs', 'EBS'], ['haven', 'Haven'], ['bank_of_ireland', 'Bank of Ireland'], ['ptsb', 'PTSB'], ['other', 'Other lender']],
      onChange: (next) => updateDraft(['lenderCapacity', 'lenderId'], next || null)
    }));
    grid.appendChild(makeHousePurchaseBooleanField({
      label: 'Is this the maximum available?', value: lender.isMaximumAvailable,
      onChange: (next) => updateDraft(['lenderCapacity', 'isMaximumAvailable'], next)
    }));
    grid.appendChild(makeHousePurchaseBooleanField({
      label: 'Macro-prudential exception?', value: lender.macroPrudentialException,
      help: 'Required before a lender amount above the standard ceiling can be used.',
      onChange: (next) => updateDraft(['lenderCapacity', 'macroPrudentialException'], next)
    }));
    if (draft.acquisitionType === 'new_build' || draft.acquisitionType === 'self_build') {
      grid.appendChild(makeHousePurchaseBooleanField({
        label: 'HTB qualifying lender?', value: lender.htbQualifyingLender,
        help: 'Use the lender / Revenue position if known; leave unanswered if it still needs confirmation.',
        onChange: (next) => updateDraft(['lenderCapacity', 'htbQualifyingLender'], next)
      }));
    }
    const costs = draft.purchaseCosts || {};
    grid.appendChild(makeHousePurchaseField({
      label: 'Stamp duty', value: costs.stampDutyMode || 'rules',
      options: [['rules', 'Calculate from dated bands'], ['custom', 'Use a custom amount']],
      onChange: (next) => updateDraft(['purchaseCosts', 'stampDutyMode'], next, { requestRender: true })
    }));
    if (costs.stampDutyMode === 'custom') addCurrency('Custom stamp duty', ['purchaseCosts', 'customStampDuty'], costs.customStampDuty);
    addCurrency('Legal and conveyancing estimate', ['purchaseCosts', 'legalAndConveyancing'], costs.legalAndConveyancing);
    addCurrency('Valuation estimate', ['purchaseCosts', 'valuation'], costs.valuation);
    addCurrency('Survey / engineer estimate', ['purchaseCosts', 'surveyOrEngineer'], costs.surveyOrEngineer);
    addCurrency('Moving and furnishing allowance', ['purchaseCosts', 'movingAndFurnishing'], costs.movingAndFurnishing);
    addCurrency('Contingency', ['purchaseCosts', 'contingency'], costs.contingency);
  } else if (stepIndex === 7) {
    activeApplicants.forEach((applicant, applicantIndex) => {
      const group = makeHousePurchaseGroup(`${applicant.label || `Applicant ${applicantIndex + 1}`} scheme checks`);
      const applicantGrid = document.createElement('div');
      applicantGrid.className = 'house-purchase-form-grid';
      applicantGrid.appendChild(makeHousePurchaseBooleanField({
        label: 'Previously owned property anywhere?', value: applicant.previouslyOwnedPropertyAnywhere,
        onChange: (next) => updateDraft(['applicants', applicantIndex, 'previouslyOwnedPropertyAnywhere'], next)
      }));
      applicantGrid.appendChild(makeHousePurchaseBooleanField({
        label: 'Retains an interest in a previous property?', value: applicant.retainedInterestInPreviousProperty,
        onChange: (next) => updateDraft(['applicants', applicantIndex, 'retainedInterestInPreviousProperty'], next)
      }));
      applicantGrid.appendChild(makeHousePurchaseBooleanField({
        label: 'Right to reside in Ireland?', value: applicant.rightToResideInIreland,
        onChange: (next) => updateDraft(['applicants', applicantIndex, 'rightToResideInIreland'], next)
      }));
      group.appendChild(applicantGrid);
      content.appendChild(group);
    });
    const htb = draft.helpToBuy || {};
    const htbRelevant = draft.acquisitionType === 'new_build' || draft.acquisitionType === 'self_build';
    if (htbRelevant) {
      grid.appendChild(makeHousePurchaseBooleanField({
        label: 'Tax compliant for Help to Buy?', value: htb.taxCompliant,
        onChange: (next) => updateDraft(['helpToBuy', 'taxCompliant'], next)
      }));
      grid.appendChild(makeHousePurchaseBooleanField({
        label: 'Revenue-approved developer / approver?', value: htb.revenueApprovedDeveloperOrApprover,
        help: 'Relevant for a new home or self-build.',
        onChange: (next) => updateDraft(['helpToBuy', 'revenueApprovedDeveloperOrApprover'], next)
      }));
      addCurrency('Income Tax and DIRT paid in prior four years', ['helpToBuy', 'expectedIncomeTaxAndDirtPaidPriorFourYears'], htb.expectedIncomeTaxAndDirtPaidPriorFourYears, 'Leave blank to show a maximum before tax-paid verification.', { nullable: true });
      addCurrency('Confirmed Help to Buy claim', ['helpToBuy', 'confirmedClaimAmount'], htb.confirmedClaimAmount, 'Use only an amount already confirmed through Revenue.', { nullable: true });
    } else {
      const notApplicable = document.createElement('div');
      notApplicable.className = 'house-purchase-split-summary';
      notApplicable.innerHTML = '<strong>Help to Buy is not shown for this property type</strong><span>HTB screens new homes and qualifying self-builds; the result will explain the property mismatch.</span>';
      grid.appendChild(notApplicable);
    }
    const fhs = draft.firstHomeScheme || {};
    grid.appendChild(makeHousePurchaseField({
      label: 'First Home Scheme application', value: fhs.applicationStatus || 'unknown',
      options: [['unknown', 'Not confirmed'], ['not_applied', 'Not applied'], ['potential', 'Worth screening'], ['confirmed', 'Confirmed'], ['declined', 'Declined']],
      onChange: (next) => updateDraft(['firstHomeScheme', 'applicationStatus'], next, { requestRender: true })
    }));
    if (fhs.applicationStatus === 'confirmed') {
      addCurrency('Confirmed FHS equity amount', ['firstHomeScheme', 'confirmedEquityAmount'], fhs.confirmedEquityAmount, '', { nullable: true });
    }
    if (draft.acquisitionType === 'self_build') {
      addCurrency('Self-build site equity', ['firstHomeScheme', 'siteEquity'], fhs.siteEquity, '', { nullable: true });
    }
    grid.appendChild(makeHousePurchaseField({
      label: 'Deposit savings gross AER', value: formatHousePurchaseInputNumber(draft.depositSavingsGrossAer, 100),
      type: 'number', min: 0, max: 20, step: 0.1, inputMode: 'decimal', suffix: '%',
      help: 'Default base illustration: 2.0% gross.',
      onChange: (next) => updateDraft(['depositSavingsGrossAer'], parseHousePurchaseNumber(next) / 100)
    }));
    grid.appendChild(makeHousePurchaseField({
      label: 'DIRT rate', value: formatHousePurchaseInputNumber(draft.dirtRate, 100),
      type: 'number', min: 0, max: 100, step: 0.1, inputMode: 'decimal', suffix: '%',
      onChange: (next) => updateDraft(['dirtRate'], parseHousePurchaseNumber(next) / 100)
    }));
    grid.appendChild(makeHousePurchaseField({
      label: 'Mortgage illustration rate', value: formatHousePurchaseInputNumber(draft.mortgageIllustrationRate, 100),
      type: 'number', min: 0, max: 30, step: 0.1, inputMode: 'decimal', suffix: '%',
      onChange: (next) => updateDraft(['mortgageIllustrationRate'], parseHousePurchaseNumber(next) / 100)
    }));
    grid.appendChild(makeHousePurchaseField({
      label: 'Mortgage term', value: formatHousePurchaseInputNumber(draft.mortgageTermYears),
      type: 'number', min: 1, max: 35, step: 1, inputMode: 'numeric', suffix: 'years',
      onChange: (next) => updateDraft(['mortgageTermYears'], parseHousePurchaseNumber(next))
    }));
  } else {
    const reviewItems = [
      ['Target home', formatHousePurchaseCurrency(draft.targetPropertyPrice)],
      ['Application', draft.applicationType === 'joint' ? 'Joint applicants' : 'Single applicant'],
      ['Cash savings', formatHousePurchaseCurrency(draft.currentCashSavings)],
      ['Planned monthly saving', formatHousePurchaseCurrency(draft.plannedMonthlySavings ?? draft.currentMonthlySavings)],
      ['Mortgage illustration', `${formatHousePurchasePercent(draft.mortgageIllustrationRate)} over ${draft.mortgageTermYears || '—'} years`],
      ['Property', `${formatHousePurchaseChoice(draft.acquisitionType)} · ${formatHousePurchaseChoice(draft.dwellingType)}`]
    ];
    const review = document.createElement('div');
    review.className = 'house-purchase-review-grid';
    reviewItems.forEach(([label, value]) => review.appendChild(buildHousePurchaseMetric(label, value)));
    content.appendChild(review);
    const note = document.createElement('div');
    note.className = 'house-purchase-review-note';
    note.innerHTML = '<strong>Ready to calculate.</strong><span>The runtime—not the questionnaire—will compute capacity, dates, scheme screens and next actions.</span>';
    content.appendChild(note);
  }

  if (grid.childElementCount > 0 && !grid.parentNode) {
    content.appendChild(grid);
  }
  return content;
}

function validateHousePurchaseWizardStep(stepIndex, draft) {
  const errors = [];
  const applicants = Array.isArray(draft?.applicants) ? draft.applicants : [];
  const activeApplicants = draft?.applicationType === 'joint' ? applicants.slice(0, 2) : applicants.slice(0, 1);
  if (stepIndex === 0 || stepIndex === 8) {
    if (!(Number(draft?.targetPropertyPrice) > 0)) errors.push('Enter a target property price.');
    if (!draft?.targetPurchaseDate) errors.push('Choose a target purchase date.');
    if (!['first_time_buyer', 'second_or_subsequent'].includes(draft?.lendingCategory)) errors.push('Confirm the Central Bank buyer category.');
  }
  if (stepIndex === 1 || stepIndex === 8) {
    if (!['single', 'joint'].includes(draft?.applicationType)) errors.push('Choose who is buying.');
    if (activeApplicants.length !== (draft?.applicationType === 'joint' ? 2 : 1)) errors.push('Complete the applicant details.');
    activeApplicants.forEach((applicant, index) => {
      if (!(Number(applicant?.age) >= 19)) errors.push(`Enter an age of 19 or older for applicant ${index + 1}.`);
    });
  }
  if (stepIndex === 2 || stepIndex === 8) {
    activeApplicants.forEach((applicant, index) => {
      const income = finiteHousePurchaseNumber(applicant?.grossAnnualIncome);
      if (income === null || income < 0) errors.push(`Enter gross income for applicant ${index + 1}.`);
    });
  }
  if (stepIndex === 3 || stepIndex === 8) {
    const currentCash = finiteHousePurchaseNumber(draft?.currentCashSavings);
    if (currentCash === null || currentCash < 0) errors.push('Enter current cash savings.');
    const split = Array.isArray(draft?.cashSavingsContributions)
      ? draft.cashSavingsContributions.reduce((total, item) => total + (Number(item?.amount) || 0), 0)
      : 0;
    if (activeApplicants.length > 0 && Math.abs(split - (Number(draft?.currentCashSavings) || 0)) > 0.01) {
      errors.push('Applicant contribution amounts must total current cash savings.');
    }
    const customReserve = finiteHousePurchaseNumber(draft?.emergencyReserveTarget);
    if (draft?.emergencyReserveMode === 'custom' && (customReserve === null || customReserve < 0)) {
      errors.push('Enter the custom emergency reserve.');
    }
  }
  if (stepIndex === 5 || stepIndex === 8) {
    if (!((finiteHousePurchaseNumber(draft?.monthlyNetHouseholdIncome) || 0) > 0)) errors.push('Enter monthly net household income.');
    const essentials = finiteHousePurchaseNumber(draft?.monthlyEssentialExpensesExcludingHousingDebtAndRent);
    if (essentials === null || essentials < 0) errors.push('Enter essential monthly expenses.');
  }
  if (stepIndex === 6 || stepIndex === 8) {
    if (!draft?.acquisitionType || draft.acquisitionType === 'unknown') errors.push('Choose an acquisition type.');
    if (!draft?.dwellingType || draft.dwellingType === 'unknown') errors.push('Choose a dwelling type.');
  }
  if (stepIndex === 7 || stepIndex === 8) {
    if (!(Number(draft?.mortgageTermYears) > 0 && Number(draft?.mortgageTermYears) <= 35)) errors.push('Enter a mortgage term between 1 and 35 years.');
    const mortgageRate = finiteHousePurchaseNumber(draft?.mortgageIllustrationRate);
    if (mortgageRate === null || mortgageRate < 0) errors.push('Enter a mortgage illustration rate.');
  }
  return [...new Set(errors)];
}

function renderHousePurchaseWizard(module, editor, { onEditHousePurchase }) {
  const section = document.createElement('section');
  section.className = 'generated-section house-purchase-generated-section is-editing';
  const heading = document.createElement('h2');
  heading.className = 'generated-section-title';
  heading.textContent = 'House Purchase Planner';
  section.appendChild(heading);

  const card = document.createElement('section');
  card.className = 'generated-card house-purchase-wizard-card';
  card.dataset.generatedCard = 'house-purchase-wizard';
  const stepIndex = editor.stepIndex;
  const step = HOUSE_PURCHASE_WIZARD_STEPS[stepIndex];

  const progress = document.createElement('div');
  progress.className = 'house-purchase-wizard-progress';
  progress.setAttribute('aria-label', `Step ${stepIndex + 1} of ${HOUSE_PURCHASE_WIZARD_STEPS.length}: ${step.title}`);
  const progressMeta = document.createElement('div');
  progressMeta.className = 'house-purchase-progress-meta';
  progressMeta.innerHTML = `<span>Step ${stepIndex + 1} of ${HOUSE_PURCHASE_WIZARD_STEPS.length}</span><strong>${step.title}</strong>`;
  progress.appendChild(progressMeta);
  const track = document.createElement('div');
  track.className = 'house-purchase-progress-track';
  const fill = document.createElement('span');
  fill.style.width = `${((stepIndex + 1) / HOUSE_PURCHASE_WIZARD_STEPS.length) * 100}%`;
  track.appendChild(fill);
  progress.appendChild(track);
  card.appendChild(progress);

  const intro = document.createElement('div');
  intro.className = 'house-purchase-step-intro';
  const stepTitle = document.createElement('h3');
  stepTitle.textContent = step.title;
  intro.appendChild(stepTitle);
  const stepDetail = document.createElement('p');
  stepDetail.textContent = step.detail;
  intro.appendChild(stepDetail);
  card.appendChild(intro);

  let workingDraft = cloneHousePurchaseDraft(editor.draft);
  const dispatch = (nextDraft, nextStepIndex = stepIndex, { requestRender = false } = {}) => {
    workingDraft = cloneHousePurchaseDraft(nextDraft);
    onEditHousePurchase?.(module.id, {
      action: 'draft',
      stepIndex: nextStepIndex,
      draft: workingDraft,
      requestRender
    });
  };
  const updateDraft = (path, value, { replace = false, requestRender = false } = {}) => {
    const nextDraft = replace
      ? (typeof value === 'function' ? value(cloneHousePurchaseDraft(workingDraft)) : value)
      : setHousePurchaseDraftValue(workingDraft, path, value);
    dispatch(nextDraft, stepIndex, { requestRender });
  };
  card.appendChild(renderHousePurchaseWizardStep(stepIndex, editor.draft, updateDraft));

  const status = document.createElement('div');
  status.className = 'house-purchase-wizard-status';
  status.setAttribute('role', 'alert');
  status.setAttribute('aria-live', 'polite');
  status.tabIndex = -1;
  card.appendChild(status);

  const navigation = document.createElement('div');
  navigation.className = 'house-purchase-wizard-navigation';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'house-purchase-secondary-btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => onEditHousePurchase?.(module.id, {
    action: 'cancel', stepIndex, draft: workingDraft
  }));
  navigation.appendChild(cancel);

  const stepActions = document.createElement('div');
  stepActions.className = 'house-purchase-step-actions';
  if (stepIndex > 0) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'house-purchase-secondary-btn';
    back.textContent = 'Back';
    back.addEventListener('click', () => dispatch(workingDraft, stepIndex - 1, { requestRender: true }));
    stepActions.appendChild(back);
  }
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'house-purchase-primary-btn';
  next.textContent = stepIndex === HOUSE_PURCHASE_WIZARD_STEPS.length - 1 ? 'Build results' : 'Continue';
  next.addEventListener('click', () => {
    const errors = validateHousePurchaseWizardStep(stepIndex, workingDraft);
    if (errors.length > 0) {
      status.innerHTML = '';
      const list = document.createElement('ul');
      errors.forEach((message) => {
        const item = document.createElement('li');
        item.textContent = message;
        list.appendChild(item);
      });
      status.appendChild(list);
      status.focus?.();
      return;
    }
    if (stepIndex === HOUSE_PURCHASE_WIZARD_STEPS.length - 1) {
      onEditHousePurchase?.(module.id, { action: 'commit', stepIndex, draft: workingDraft });
      return;
    }
    dispatch(workingDraft, stepIndex + 1, { requestRender: true });
  });
  stepActions.appendChild(next);
  navigation.appendChild(stepActions);
  card.appendChild(navigation);
  section.appendChild(card);
  return section;
}

function renderHousePurchaseStartCard(module, { onStartHousePurchase }) {
  const section = document.createElement('section');
  section.className = 'generated-section house-purchase-generated-section house-purchase-start-section';
  const heading = document.createElement('h2');
  heading.className = 'generated-section-title';
  heading.textContent = 'Build a client module';
  section.appendChild(heading);
  const card = document.createElement('section');
  card.className = 'generated-card house-purchase-start-card';
  card.dataset.generatedCard = 'house-purchase-start';
  const visual = document.createElement('div');
  visual.className = 'house-purchase-start-visual';
  visual.setAttribute('aria-hidden', 'true');
  visual.innerHTML = '<span class="house-purchase-start-pin">●</span><span class="house-purchase-start-route"></span><span class="house-purchase-start-home"><i></i></span>';
  card.appendChild(visual);
  const copy = document.createElement('div');
  copy.className = 'house-purchase-start-copy';
  const eyebrow = document.createElement('span');
  eyebrow.className = 'house-purchase-eyebrow';
  eyebrow.textContent = 'Advisor template · Irish planning rules';
  copy.appendChild(eyebrow);
  const title = document.createElement('h3');
  title.textContent = 'Plan your route to buying a home';
  copy.appendChild(title);
  const detail = document.createElement('p');
  detail.textContent = 'See what the client may be able to afford, how much cash they may need, how long it could take, and which Irish buyer supports may be worth checking.';
  copy.appendChild(detail);
  const cta = document.createElement('button');
  cta.type = 'button';
  cta.className = 'house-purchase-primary-btn house-purchase-start-btn';
  cta.textContent = 'Build house-purchase plan';
  cta.addEventListener('click', () => onStartHousePurchase?.(module.id));
  copy.appendChild(cta);
  const note = document.createElement('p');
  note.className = 'house-purchase-start-note';
  note.textContent = 'Takes approximately 5–8 minutes. No mortgage approval is provided.';
  copy.appendChild(note);
  const existingFlow = document.createElement('p');
  existingFlow.className = 'house-purchase-codex-note';
  existingFlow.textContent = 'Prefer the existing Codex payload workflow? It remains available through the advisor Dev Panel.';
  copy.appendChild(existingFlow);
  card.appendChild(copy);
  section.appendChild(card);
  return section;
}

function finiteHousePurchaseNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatHousePurchaseCurrency(value, fallback = '—') {
  const parsed = finiteHousePurchaseNumber(value);
  return parsed === null ? fallback : DISPLAY_EURO_FORMATTER.format(parsed);
}

function formatHousePurchasePercent(value, fallback = '—') {
  const parsed = finiteHousePurchaseNumber(value);
  if (parsed === null) return fallback;
  const percent = Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
  return `${percent.toFixed(percent % 1 === 0 ? 0 : 2)}%`;
}

function formatHousePurchaseChoice(value, fallback = 'Not provided') {
  const text = String(value || '').trim();
  if (!text || text === 'unknown') return fallback;
  return text
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatHousePurchaseDate(value, fallback = 'Not yet estimated') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat('en-IE', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function normalizeHousePurchaseTone(value) {
  const token = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (/fail|unlikely|stretched|shortfall|gap|blocked|error|mismatch/.test(token)) return 'negative';
  if (/potential|tighter|warning|pending|more_information|unknown|unconfirmed|review/.test(token)) return 'warning';
  if (/ready|aligned|pass|eligible|confirmed|complete|success|met/.test(token)) return 'positive';
  return 'neutral';
}

function buildHousePurchaseStatus(label, toneSource = '') {
  const tone = normalizeHousePurchaseTone(toneSource || label);
  const status = document.createElement('span');
  status.className = 'house-purchase-status';
  status.dataset.tone = tone;
  const icon = document.createElement('span');
  icon.className = 'house-purchase-status-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = tone === 'positive' ? '✓' : (tone === 'negative' ? '×' : (tone === 'warning' ? '!' : '•'));
  status.appendChild(icon);
  const text = document.createElement('span');
  text.textContent = label || 'Needs review';
  status.appendChild(text);
  return status;
}

function createHousePurchaseCard(id, title, className = '') {
  const card = document.createElement('section');
  card.className = `generated-card house-purchase-card ${className}`.trim();
  card.dataset.generatedCard = id;
  const headerParts = buildGeneratedCardHeader(title);
  card.appendChild(headerParts.header);
  return { card, ...headerParts };
}

function buildHousePurchaseMetric(label, value, detail = '', tone = '') {
  const metric = document.createElement('article');
  metric.className = 'house-purchase-metric';
  if (tone) metric.dataset.tone = normalizeHousePurchaseTone(tone);
  const labelNode = document.createElement('span');
  labelNode.className = 'house-purchase-metric-label';
  labelNode.textContent = label;
  metric.appendChild(labelNode);
  const valueNode = document.createElement('strong');
  valueNode.className = 'house-purchase-metric-value';
  valueNode.textContent = value;
  metric.appendChild(valueNode);
  if (detail) {
    const detailNode = document.createElement('span');
    detailNode.className = 'house-purchase-metric-detail';
    detailNode.textContent = detail;
    metric.appendChild(detailNode);
  }
  return metric;
}

function getHousePurchasePrimaryBottleneck(result) {
  const primary = result?.bottlenecks?.primary;
  if (primary && typeof primary === 'object') return primary;
  if (typeof primary === 'string') {
    return { code: primary, label: formatHousePurchaseChoice(primary), detail: '' };
  }
  return {
    code: 'insufficient_information',
    label: 'More information required',
    detail: 'Complete the plan inputs to identify the main constraint.'
  };
}

function inferHousePurchaseSupportCase(inputs) {
  const hasHtb = (finiteHousePurchaseNumber(inputs?.helpToBuy?.confirmedClaimAmount) || 0) > 0;
  const hasFhs = inputs?.firstHomeScheme?.applicationStatus === 'confirmed'
    && (finiteHousePurchaseNumber(inputs?.firstHomeScheme?.confirmedEquityAmount) || 0) > 0;
  if (hasHtb && hasFhs) return 'htb_and_fhs';
  if (hasHtb) return 'htb_only';
  if (hasFhs) return 'fhs_only';
  return 'none';
}

function buildHousePurchaseHeroCard(module, projection, { readOnly, onEditHousePurchase }) {
  const result = projection?.result || {};
  const capacities = result.capacities || {};
  const target = result.targetFunding || {};
  const bottleneck = getHousePurchasePrimaryBottleneck(result);
  const { card, actions } = createHousePurchaseCard('house-purchase-hero', 'Route to home', 'house-purchase-hero-card');

  if (!readOnly && typeof onEditHousePurchase === 'function') {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'house-purchase-edit-btn';
    edit.textContent = 'Edit plan';
    edit.addEventListener('click', () => onEditHousePurchase(module.id, {
      action: 'draft',
      stepIndex: 0,
      draft: cloneHousePurchaseDraft(module.generated.housePurchaseInputs)
    }));
    actions.appendChild(edit);
  }

  const body = document.createElement('div');
  body.className = 'house-purchase-hero-layout';
  const story = document.createElement('div');
  story.className = 'house-purchase-hero-story';
  const routeIsReady = bottleneck.code === 'ready_for_next_step';
  story.appendChild(buildHousePurchaseStatus(routeIsReady ? 'Broadly aligned' : 'Main constraint', bottleneck.status || bottleneck.code));
  const headline = document.createElement('h4');
  headline.textContent = bottleneck.label || (routeIsReady
    ? 'The route looks broadly aligned'
    : 'The route still needs review');
  story.appendChild(headline);
  const detail = document.createElement('p');
  detail.textContent = bottleneck.detail || 'The plan compares cash, regulatory capacity, household resilience and support screens.';
  story.appendChild(detail);

  const safeSummary = sanitizeSummaryHtml(module?.generated?.summaryHtml || '');
  const guide = buildClientGuideLine(safeSummary, CLIENT_GUIDE_COPY.housePurchase);
  if (guide) story.appendChild(guide);
  if (safeSummary) {
    const summary = document.createElement('div');
    summary.className = 'house-purchase-hero-summary generated-summary-copy';
    summary.innerHTML = safeSummary;
    story.appendChild(summary);
  }

  const usableCash = finiteHousePurchaseNumber(target.usableCash) || 0;
  const cashRequired = finiteHousePurchaseNumber(target.cashRequired) || 0;
  const progressRatio = cashRequired > 0 ? Math.max(0, Math.min(1, usableCash / cashRequired)) : 0;
  const route = document.createElement('div');
  route.className = 'house-purchase-route-visual';
  route.setAttribute('role', 'img');
  route.setAttribute('aria-label', `${formatHousePurchasePercent(progressRatio)} of the current cash target is available`);
  const routeLabels = document.createElement('div');
  routeLabels.className = 'house-purchase-route-labels';
  routeLabels.innerHTML = `<span>Today<br><strong>${formatHousePurchaseCurrency(usableCash)}</strong></span><span>Cash target<br><strong>${formatHousePurchaseCurrency(cashRequired)}</strong></span>`;
  route.appendChild(routeLabels);
  const routeTrack = document.createElement('div');
  routeTrack.className = 'house-purchase-route-track';
  const routeFill = document.createElement('span');
  routeFill.style.width = `${progressRatio * 100}%`;
  routeTrack.appendChild(routeFill);
  const home = document.createElement('span');
  home.className = 'house-purchase-route-home';
  home.setAttribute('aria-hidden', 'true');
  home.innerHTML = '<i></i>';
  routeTrack.appendChild(home);
  route.appendChild(routeTrack);
  story.appendChild(route);
  body.appendChild(story);

  const metrics = document.createElement('div');
  metrics.className = 'house-purchase-hero-metrics';
  const routeOutOfHorizon = target.status === 'out_of_horizon'
    || (!target.readyDateIso && finiteHousePurchaseNumber(target.monthsToReady) === null);
  const usesPotentialSupport = projection?.result?.schemes?.usesPotentialSupport === true;
  metrics.appendChild(buildHousePurchaseMetric('Target home', formatHousePurchaseCurrency(target.targetPropertyPrice)));
  metrics.appendChild(buildHousePurchaseMetric('Capacity now', formatHousePurchaseCurrency(capacities.activeSupportablePrice ?? capacities.currentSupportablePrice), capacities.activeSupportablePrice !== undefined && capacities.activeSupportablePrice !== capacities.currentSupportablePrice ? 'Active what-if route; compare with the base case below' : 'Standard-rule and protected-cash illustration'));
  metrics.appendChild(buildHousePurchaseMetric('Cash-flow-aligned capacity', formatHousePurchaseCurrency(capacities.cashFlowAlignedPropertyCapacity), 'Shown beside—not instead of—the standard-rule capacity'));
  metrics.appendChild(buildHousePurchaseMetric(
    'Funding-ready date',
    routeOutOfHorizon ? 'Beyond the projection horizon' : formatHousePurchaseDate(target.readyDateIso),
    usesPotentialSupport
      ? 'Contingent on unconfirmed support; not a ready result'
      : (finiteHousePurchaseNumber(target.monthsToReady) !== null ? `${Math.max(0, Math.ceil(Number(target.monthsToReady)))} months from the calculation date` : 'Projection horizon applies'),
    routeOutOfHorizon || usesPotentialSupport ? 'warning' : ''
  ));
  metrics.appendChild(buildHousePurchaseMetric('Saving needed', finiteHousePurchaseNumber(target.monthlySavingNeeded) !== null ? `${formatHousePurchaseCurrency(target.monthlySavingNeeded)} / month` : 'Not yet solvable', 'To the selected target date'));
  body.appendChild(metrics);
  card.appendChild(body);
  return card;
}

function buildHousePurchaseReadinessCard(module, projection, overrides) {
  const result = projection?.result || {};
  const capacities = result.capacities || {};
  const target = result.targetFunding || {};
  const mortgage = result.mortgage || {};
  const affordability = result.householdAffordability || {};
  const schemes = result.schemes || {};
  const { card } = createHousePurchaseCard('house-purchase-readiness', 'Four readiness gates', 'house-purchase-readiness-card');
  const grid = document.createElement('div');
  grid.className = 'house-purchase-gates';
  const requiredMortgage = finiteHousePurchaseNumber(target.mortgageRequired ?? mortgage.principal);
  const standardCapacity = finiteHousePurchaseNumber(capacities.standardMortgageCapacity);
  const regulatoryPass = requiredMortgage !== null && standardCapacity !== null && requiredMortgage <= standardCapacity;
  const cashGap = finiteHousePurchaseNumber(target.currentCashGap);
  const supportCase = result.schemes?.activeSupportCase
    || overrides.supportCase
    || inferHousePurchaseSupportCase(module?.generated?.housePurchaseInputs);
  const supportStatuses = [schemes.helpToBuy?.status, schemes.firstHomeScheme?.status].filter(Boolean);
  const gateRows = [
    {
      title: 'Regulatory capacity',
      status: requiredMortgage === null || standardCapacity === null ? 'More information required' : (regulatoryPass ? 'Within illustration' : 'Above standard limit'),
      tone: requiredMortgage === null || standardCapacity === null ? 'unknown' : (regulatoryPass ? 'passed' : 'failed'),
      detail: standardCapacity === null ? 'Qualifying income or buyer category is incomplete.' : `${formatHousePurchaseCurrency(requiredMortgage)} required vs ${formatHousePurchaseCurrency(standardCapacity)} standard capacity.`
    },
    {
      title: 'Protected cash',
      status: cashGap === null ? 'More information required' : (cashGap <= 0 ? 'Cash gate met' : 'Cash gap remains'),
      tone: cashGap === null ? 'unknown' : (cashGap <= 0 ? 'passed' : 'gap'),
      detail: cashGap === null ? 'Complete savings, reserve and cost inputs.' : (cashGap <= 0 ? 'Ringfenced cash and reserve remain protected.' : `${formatHousePurchaseCurrency(cashGap)} additional usable cash is needed.`)
    },
    {
      title: 'Household resilience',
      status: formatHousePurchaseChoice(affordability.status, 'More information required'),
      tone: affordability.status,
      detail: affordability.baseHeadroom === null || affordability.baseHeadroom === undefined
        ? 'Monthly household inputs are incomplete.'
        : `${formatHousePurchaseCurrency(affordability.baseHeadroom)} estimated base monthly headroom.`
    },
    {
      title: 'Support screening',
      status: supportCase === 'none' ? 'Not relied on' : formatHousePurchaseChoice(supportStatuses.find((item) => normalizeHousePurchaseTone(item) !== 'positive') || supportStatuses[0], 'Requires confirmation'),
      tone: supportCase === 'none' ? 'neutral' : (supportStatuses.find((item) => normalizeHousePurchaseTone(item) !== 'positive') || 'warning'),
      detail: supportCase === 'none' ? 'The active route does not depend on HTB or FHS.' : 'Any support remains subject to Revenue, lender and/or FHS confirmation.'
    }
  ];
  gateRows.forEach((gate, index) => {
    const item = document.createElement('article');
    item.className = 'house-purchase-gate';
    item.dataset.tone = normalizeHousePurchaseTone(gate.tone);
    const number = document.createElement('span');
    number.className = 'house-purchase-gate-number';
    number.textContent = String(index + 1);
    item.appendChild(number);
    const copy = document.createElement('div');
    const title = document.createElement('h4');
    title.textContent = gate.title;
    copy.appendChild(title);
    copy.appendChild(buildHousePurchaseStatus(gate.status, gate.tone));
    const detail = document.createElement('p');
    detail.textContent = gate.detail;
    copy.appendChild(detail);
    item.appendChild(copy);
    grid.appendChild(item);
  });
  card.appendChild(grid);
  return card;
}

function buildHousePurchaseFundingCard(projection) {
  const stack = projection?.result?.fundingStack || {};
  const target = finiteHousePurchaseNumber(stack.total ?? projection?.result?.targetFunding?.targetPropertyPrice) || 0;
  const confirmedItems = [
    ['Own cash', stack.ownCash, 'confirmed', 'Confirmed input'],
    ['Estimated mortgage', stack.estimatedMortgage, 'estimated', 'Estimated'],
    ['Help to Buy', stack.confirmedHtb, 'confirmed-support', 'Confirmed support'],
    ['First Home Scheme', stack.confirmedFhs, 'confirmed-support', 'Confirmed support'],
    ['Remaining gap', stack.remainingGap, 'gap', 'Funding gap']
  ].filter(([, value, key]) => (finiteHousePurchaseNumber(value) || 0) > 0 || key === 'gap');
  const potentialItems = [
    ['Potential Help to Buy', stack.potentialHtb],
    ['Potential First Home Scheme', stack.potentialFhs]
  ].filter(([, value]) => (finiteHousePurchaseNumber(value) || 0) > 0);
  const { card } = createHousePurchaseCard('house-purchase-funding-stack', 'How the target is funded', 'house-purchase-funding-card');
  const header = document.createElement('div');
  header.className = 'house-purchase-funding-total';
  header.innerHTML = `<span>Target property</span><strong>${formatHousePurchaseCurrency(target)}</strong>`;
  card.appendChild(header);
  const rail = document.createElement('div');
  rail.className = 'house-purchase-funding-rail';
  rail.setAttribute('role', 'img');
  rail.setAttribute('aria-label', confirmedItems.map(([label, value]) => `${label} ${formatHousePurchaseCurrency(value)}`).join(', '));
  confirmedItems.forEach(([label, value, key]) => {
    const amount = Math.max(0, finiteHousePurchaseNumber(value) || 0);
    const segment = document.createElement('span');
    segment.className = 'house-purchase-funding-segment';
    segment.dataset.kind = key;
    segment.style.width = `${target > 0 ? Math.max(amount > 0 ? 2 : 0, (amount / target) * 100) : 0}%`;
    segment.title = `${label}: ${formatHousePurchaseCurrency(amount)}`;
    rail.appendChild(segment);
  });
  card.appendChild(rail);
  const legend = document.createElement('div');
  legend.className = 'house-purchase-funding-legend';
  confirmedItems.forEach(([label, value, key, status]) => {
    const item = document.createElement('article');
    item.dataset.kind = key;
    item.innerHTML = `<i aria-hidden="true"></i><span>${label}<small>${status}</small></span><strong>${formatHousePurchaseCurrency(value)}</strong>`;
    legend.appendChild(item);
  });
  card.appendChild(legend);
  if ((finiteHousePurchaseNumber(stack.buyingCosts) || 0) > 0) {
    const costs = document.createElement('p');
    costs.className = 'house-purchase-inline-disclosure';
    costs.textContent = `${formatHousePurchaseCurrency(stack.buyingCosts)} of estimated buying costs sit alongside the property funding stack and must also be covered in cash.`;
    card.appendChild(costs);
  }
  if (potentialItems.length > 0) {
    const potential = document.createElement('div');
    potential.className = 'house-purchase-potential-support';
    const title = document.createElement('span');
    title.textContent = 'Unconfirmed possibilities — not included in the confirmed stack';
    potential.appendChild(title);
    const values = document.createElement('div');
    potentialItems.forEach(([label, value]) => {
      const chip = document.createElement('span');
      chip.innerHTML = `${label} <strong>${formatHousePurchaseCurrency(value)}</strong>`;
      values.appendChild(chip);
    });
    potential.appendChild(values);
    card.appendChild(potential);
  }
  return card;
}

function buildHousePurchaseDepositChart(projection) {
  const timeline = projection?.result?.depositTimeline || {};
  const fullSeries = Array.isArray(timeline.series) ? timeline.series : [];
  const { card } = createHousePurchaseCard('house-purchase-deposit-journey', 'Deposit journey', 'house-purchase-deposit-card');
  if (fullSeries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'Complete the savings and target inputs to draw the deposit journey.';
    card.appendChild(empty);
    return card;
  }
  const selectedTargetDate = projection?.result?.targetFunding?.targetDateIso;
  const selectedTargetIndex = selectedTargetDate
    ? fullSeries.findIndex((item) => typeof item?.dateIso === 'string' && item.dateIso >= selectedTargetDate)
    : -1;
  const readyIndex = Number.isInteger(timeline.readyMonthIndex) ? timeline.readyMonthIndex : -1;
  const routeEndIndex = Math.min(
    fullSeries.length - 1,
    Math.max(1, selectedTargetIndex, readyIndex)
  );
  const series = fullSeries.slice(0, routeEndIndex + 1);
  const targetCash = Math.max(0, finiteHousePurchaseNumber(timeline.targetCash) || 0);
  const sampleIndices = buildOverviewSampleIndices(series.length, 54);
  const samples = sampleIndices.map((index) => ({
    ...series[index],
    index,
    value: Math.max(0, finiteHousePurchaseNumber(series[index]?.closingBalance) || 0)
  }));
  const maxValue = Math.max(targetCash, ...samples.map((item) => item.value), 1);
  const width = 760;
  const height = 250;
  const inset = { left: 18, right: 18, top: 22, bottom: 24 };
  const plotWidth = width - inset.left - inset.right;
  const plotHeight = height - inset.top - inset.bottom;
  const xFor = (index) => inset.left + ((series.length <= 1 ? 0 : index / (series.length - 1)) * plotWidth);
  const yFor = (value) => inset.top + plotHeight - ((Math.max(0, value) / maxValue) * plotHeight);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('house-purchase-deposit-svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  const svgTitle = document.createElementNS(SVG_NS, 'title');
  svgTitle.textContent = `Projected usable cash grows from ${formatHousePurchaseCurrency(series[0]?.openingBalance)} to ${formatHousePurchaseCurrency(series.at(-1)?.closingBalance)} against a ${formatHousePurchaseCurrency(targetCash)} target.`;
  svg.appendChild(svgTitle);
  const grid = document.createElementNS(SVG_NS, 'g');
  grid.classList.add('house-purchase-chart-grid');
  [0, 0.5, 1].forEach((ratio) => {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', inset.left);
    line.setAttribute('x2', width - inset.right);
    line.setAttribute('y1', yFor(maxValue * ratio));
    line.setAttribute('y2', yFor(maxValue * ratio));
    grid.appendChild(line);
  });
  svg.appendChild(grid);
  if (targetCash > 0) {
    const targetLine = document.createElementNS(SVG_NS, 'line');
    targetLine.classList.add('house-purchase-chart-target');
    targetLine.setAttribute('x1', inset.left);
    targetLine.setAttribute('x2', width - inset.right);
    targetLine.setAttribute('y1', yFor(targetCash));
    targetLine.setAttribute('y2', yFor(targetCash));
    svg.appendChild(targetLine);
  }
  if (selectedTargetDate) {
    const targetIndex = series.findIndex((item) => typeof item?.dateIso === 'string' && item.dateIso >= selectedTargetDate);
    if (targetIndex >= 0) {
      const dateLine = document.createElementNS(SVG_NS, 'line');
      dateLine.classList.add('house-purchase-chart-date');
      dateLine.setAttribute('x1', xFor(targetIndex));
      dateLine.setAttribute('x2', xFor(targetIndex));
      dateLine.setAttribute('y1', inset.top);
      dateLine.setAttribute('y2', height - inset.bottom);
      svg.appendChild(dateLine);
    }
  }
  const points = samples.map((item) => ({ x: xFor(item.index), y: yFor(item.value) }));
  const linePath = buildOverviewLinePath(points);
  const area = document.createElementNS(SVG_NS, 'path');
  area.classList.add('house-purchase-chart-area');
  area.setAttribute('d', `${linePath} L${points.at(-1).x} ${height - inset.bottom} L${points[0].x} ${height - inset.bottom} Z`);
  svg.appendChild(area);
  const line = document.createElementNS(SVG_NS, 'path');
  line.classList.add('house-purchase-chart-line');
  line.setAttribute('d', linePath);
  svg.appendChild(line);
  series.forEach((item, index) => {
    if (!(finiteHousePurchaseNumber(item?.lumpSums) > 0)) return;
    const marker = document.createElementNS(SVG_NS, 'circle');
    marker.classList.add('house-purchase-chart-lump');
    marker.setAttribute('cx', xFor(index));
    marker.setAttribute('cy', yFor(finiteHousePurchaseNumber(item.closingBalance) || 0));
    marker.setAttribute('r', 4);
    svg.appendChild(marker);
  });
  const chartWrap = document.createElement('div');
  chartWrap.className = 'house-purchase-chart-wrap';
  chartWrap.appendChild(svg);
  const chartLabels = document.createElement('div');
  chartLabels.className = 'house-purchase-chart-labels';
  chartLabels.innerHTML = `<span>${formatHousePurchaseDate(series[0]?.dateIso, 'Today')}</span><strong>Cash target ${formatHousePurchaseCurrency(targetCash)}${selectedTargetDate ? ` · selected ${formatHousePurchaseDate(selectedTargetDate)}` : ''}</strong><span>${formatHousePurchaseDate(series.at(-1)?.dateIso)}</span>`;
  chartWrap.appendChild(chartLabels);
  card.appendChild(chartWrap);
  const interestTotal = series.reduce((sum, item) => sum + (finiteHousePurchaseNumber(item?.interest) || 0), 0);
  const contributionTotal = series.reduce((sum, item) => sum + (finiteHousePurchaseNumber(item?.contribution) || 0), 0);
  const lumpTotal = series.reduce((sum, item) => sum + (finiteHousePurchaseNumber(item?.lumpSums) || 0), 0);
  const breakdown = document.createElement('div');
  breakdown.className = 'house-purchase-journey-breakdown';
  breakdown.appendChild(buildHousePurchaseMetric('Monthly additions', formatHousePurchaseCurrency(contributionTotal), 'Across the displayed route'));
  breakdown.appendChild(buildHousePurchaseMetric('Net interest', formatHousePurchaseCurrency(interestTotal), `${formatHousePurchasePercent(timeline.grossAer)} gross; DIRT applied`));
  breakdown.appendChild(buildHousePurchaseMetric('Confirmed lump sums', formatHousePurchaseCurrency(lumpTotal)));
  breakdown.appendChild(buildHousePurchaseMetric('Projected cash', formatHousePurchaseCurrency(series.at(-1)?.closingBalance)));
  card.appendChild(breakdown);
  return card;
}

function formatHousePurchaseDelta(value, formatter = formatHousePurchaseCurrency) {
  const parsed = finiteHousePurchaseNumber(value);
  if (parsed === null || Math.abs(parsed) < 0.005) return 'No change';
  return `${parsed > 0 ? '+' : '−'}${formatter(Math.abs(parsed))}`;
}

function addMonthsToHousePurchaseDate(dateIso, months) {
  if (!dateIso) return '';
  const date = new Date(`${dateIso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function buildHousePurchaseScenarioCard(module, baseProjection, activeProjection, overrides, { onHousePurchaseScenarioChange }) {
  const inputs = module?.generated?.housePurchaseInputs || {};
  const baseResult = baseProjection?.result || {};
  const activeResult = activeProjection?.result || {};
  const { card, actions } = createHousePurchaseCard('house-purchase-scenario-lab', 'Scenario lab', 'house-purchase-scenario-card');
  const activeKeys = Object.keys(overrides || {}).filter((key) => key !== 'reset');
  actions.appendChild(buildHousePurchaseStatus(activeKeys.length > 0 ? 'What-if active' : 'Base case', activeKeys.length > 0 ? 'potential' : 'neutral'));
  const intro = document.createElement('p');
  intro.className = 'house-purchase-scenario-intro';
  intro.textContent = 'What-if illustration — these controls do not change the published plan. Reloading restores the base case.';
  card.appendChild(intro);
  const liveStatus = document.createElement('p');
  liveStatus.className = 'visually-hidden';
  liveStatus.dataset.housePurchaseScenarioStatus = 'true';
  liveStatus.setAttribute('role', 'status');
  liveStatus.setAttribute('aria-live', 'polite');
  liveStatus.setAttribute('aria-atomic', 'true');
  card.appendChild(liveStatus);
  const dispatch = (patch) => onHousePurchaseScenarioChange?.(module.id, patch);
  const controls = document.createElement('fieldset');
  controls.className = 'house-purchase-scenario-controls';
  const controlsLegend = document.createElement('legend');
  controlsLegend.textContent = 'What-if illustration controls';
  controls.appendChild(controlsLegend);
  const scenarioField = ({ scenarioKey, ...config }) => {
    const field = makeHousePurchaseField(config);
    field.classList.add('house-purchase-scenario-field');
    const control = field.querySelector('.house-purchase-control');
    if (control && scenarioKey) {
      control.dataset.housePurchaseScenarioFocus = scenarioKey;
    }
    controls.appendChild(field);
  };
  scenarioField({
    scenarioKey: 'target-property-price',
    label: 'Property price', value: formatHousePurchaseInputNumber(overrides.targetPropertyPrice ?? inputs.targetPropertyPrice), type: 'number', min: 1, step: 5000, prefix: '€', inputMode: 'decimal',
    onChange: (value) => dispatch({ targetPropertyPrice: parseHousePurchaseScenarioNumber(value) })
  });
  scenarioField({
    scenarioKey: 'target-purchase-date',
    label: 'Purchase date', value: overrides.targetPurchaseDate ?? inputs.targetPurchaseDate ?? '', type: 'date',
    onChange: (value) => dispatch({ targetPurchaseDate: value || null })
  });
  scenarioField({
    scenarioKey: 'planned-monthly-savings',
    label: 'Monthly saving', value: formatHousePurchaseInputNumber(overrides.plannedMonthlySavings ?? inputs.plannedMonthlySavings ?? inputs.currentMonthlySavings), type: 'number', min: 0, step: 50, prefix: '€', inputMode: 'decimal',
    onChange: (value) => dispatch({ plannedMonthlySavings: parseHousePurchaseScenarioNumber(value) })
  });
  const applicants = Array.isArray(inputs.applicants) ? inputs.applicants : [];
  const hasUnrecognisedVariableIncome = applicants.some((applicant) => (
    (finiteHousePurchaseNumber(applicant?.variableAnnualIncome) || 0)
      > (finiteHousePurchaseNumber(applicant?.lenderRecognisedVariableAnnualIncome) || 0)
  ));
  applicants.forEach((applicant) => {
    const applicantId = applicant.id || `applicant-${applicants.indexOf(applicant) + 1}`;
    scenarioField({
      scenarioKey: `applicant-income:${applicantId}`,
      label: `${applicant.label || 'Applicant'} base income`,
      value: formatHousePurchaseInputNumber(overrides.applicantIncomeById?.[applicantId] ?? applicant.grossAnnualIncome),
      type: 'number', min: 0, step: 1000, prefix: '€', inputMode: 'decimal',
      onChange: (value) => {
        const incomeMap = Object.fromEntries(applicants.map((item, index) => [
          item.id || `applicant-${index + 1}`,
          finiteHousePurchaseNumber(overrides.applicantIncomeById?.[item.id || `applicant-${index + 1}`] ?? item.grossAnnualIncome) || 0
        ]));
        const nextIncome = parseHousePurchaseScenarioNumber(value);
        if (nextIncome === null) {
          delete incomeMap[applicantId];
        } else {
          incomeMap[applicantId] = nextIncome;
        }
        dispatch({ applicantIncomeById: Object.keys(incomeMap).length > 0 ? incomeMap : null });
      }
    });
  });
  scenarioField({
    scenarioKey: 'deposit-savings-gross-aer',
    label: 'Deposit gross AER', value: formatHousePurchaseInputNumber(overrides.depositSavingsGrossAer ?? inputs.depositSavingsGrossAer, 100), type: 'number', min: 0, max: 20, step: 0.1, suffix: '%', inputMode: 'decimal',
    onChange: (value) => dispatch({ depositSavingsGrossAer: parseHousePurchaseScenarioNumber(value, { divisor: 100 }) })
  });
  scenarioField({
    scenarioKey: 'mortgage-illustration-rate',
    label: 'Mortgage rate', value: formatHousePurchaseInputNumber(overrides.mortgageIllustrationRate ?? inputs.mortgageIllustrationRate, 100), type: 'number', min: 0, max: 30, step: 0.1, suffix: '%', inputMode: 'decimal',
    onChange: (value) => dispatch({ mortgageIllustrationRate: parseHousePurchaseScenarioNumber(value, { divisor: 100 }) })
  });
  scenarioField({
    scenarioKey: 'mortgage-term-years',
    label: 'Mortgage term', value: formatHousePurchaseInputNumber(overrides.mortgageTermYears ?? inputs.mortgageTermYears), type: 'number', min: 1, max: 35, step: 1, suffix: 'years', inputMode: 'numeric',
    onChange: (value) => dispatch({ mortgageTermYears: parseHousePurchaseScenarioNumber(value) })
  });
  scenarioField({
    scenarioKey: 'emergency-reserve-target',
    label: 'Protected reserve', value: formatHousePurchaseInputNumber(overrides.emergencyReserveTarget ?? inputs.emergencyReserveTarget), type: 'number', min: 0, step: 500, prefix: '€', inputMode: 'decimal',
    onChange: (value) => dispatch({ emergencyReserveTarget: parseHousePurchaseScenarioNumber(value) })
  });
  scenarioField({
    scenarioKey: 'support-case',
    label: 'Support case', value: overrides.supportCase || activeResult.schemes?.activeSupportCase || inferHousePurchaseSupportCase(inputs),
    options: [['none', 'No scheme support'], ['htb_only', 'Help to Buy only'], ['fhs_only', 'First Home Scheme only'], ['htb_and_fhs', 'Help to Buy + FHS']],
    onChange: (value) => dispatch({ supportCase: value })
  });
  if (hasUnrecognisedVariableIncome) {
    scenarioField({
      scenarioKey: 'include-variable-income',
      label: 'Variable-income what-if', value: overrides.includeVariableIncome === true ? 'include' : 'exclude',
      options: [['exclude', 'Base: exclude unrecognised income'], ['include', 'Illustrate all variable income']],
      help: 'This scenario is uncertain and does not change the base qualifying-income result.',
      onChange: (value) => dispatch({ includeVariableIncome: value === 'include' })
    });
  }
  card.appendChild(controls);

  const presets = document.createElement('div');
  presets.className = 'house-purchase-scenario-presets';
  const presetData = [
    ['€25,000 cheaper home', { targetPropertyPrice: Math.max(0, (finiteHousePurchaseNumber(overrides.targetPropertyPrice ?? inputs.targetPropertyPrice) || 0) - 25000) }],
    ['Save €250 more', { plannedMonthlySavings: (finiteHousePurchaseNumber(overrides.plannedMonthlySavings ?? inputs.plannedMonthlySavings ?? inputs.currentMonthlySavings) || 0) + 250 }],
    ['Wait one extra year', { targetPurchaseDate: addMonthsToHousePurchaseDate(overrides.targetPurchaseDate ?? inputs.targetPurchaseDate, 12) }],
    ['Rates 1% higher', { mortgageIllustrationRate: (finiteHousePurchaseNumber(overrides.mortgageIllustrationRate ?? inputs.mortgageIllustrationRate) || 0) + 0.01 }]
  ];
  if (hasUnrecognisedVariableIncome) {
    presetData.push(['Include all variable income', { includeVariableIncome: true }]);
  }
  presetData.forEach(([label, patch], index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'house-purchase-preset-btn';
    button.dataset.housePurchaseScenarioFocus = `preset:${index}`;
    button.textContent = label;
    button.addEventListener('click', () => dispatch(patch));
    presets.appendChild(button);
  });
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'house-purchase-preset-btn is-reset';
  reset.dataset.housePurchaseScenarioFocus = 'restore-base';
  reset.textContent = 'Restore base';
  reset.disabled = activeKeys.length === 0;
  reset.addEventListener('click', () => dispatch({ reset: true }));
  presets.appendChild(reset);
  card.appendChild(presets);

  const baseCapacity = finiteHousePurchaseNumber(baseResult.capacities?.currentSupportablePrice);
  const activeCapacity = finiteHousePurchaseNumber(activeResult.capacities?.activeSupportablePrice ?? activeResult.capacities?.currentSupportablePrice);
  const baseGap = finiteHousePurchaseNumber(baseResult.targetFunding?.currentCashGap);
  const activeGap = finiteHousePurchaseNumber(activeResult.targetFunding?.currentCashGap);
  const basePayment = finiteHousePurchaseNumber(baseResult.mortgage?.monthlyPayment);
  const activePayment = finiteHousePurchaseNumber(activeResult.mortgage?.monthlyPayment);
  const baseMonths = finiteHousePurchaseNumber(baseResult.targetFunding?.monthsToReady);
  const activeMonths = finiteHousePurchaseNumber(activeResult.targetFunding?.monthsToReady);
  const deltas = document.createElement('div');
  deltas.className = 'house-purchase-scenario-deltas';
  deltas.appendChild(buildHousePurchaseMetric('Capacity delta', formatHousePurchaseDelta(activeCapacity !== null && baseCapacity !== null ? activeCapacity - baseCapacity : null)));
  deltas.appendChild(buildHousePurchaseMetric('Cash-gap delta', formatHousePurchaseDelta(activeGap !== null && baseGap !== null ? activeGap - baseGap : null), 'Lower is better'));
  deltas.appendChild(buildHousePurchaseMetric('Repayment delta', formatHousePurchaseDelta(activePayment !== null && basePayment !== null ? activePayment - basePayment : null), 'Per month'));
  deltas.appendChild(buildHousePurchaseMetric('Timeline delta', formatHousePurchaseDelta(activeMonths !== null && baseMonths !== null ? activeMonths - baseMonths : null, (value) => `${Math.round(value)} months`), 'Lower is sooner'));
  card.appendChild(deltas);
  return card;
}

function buildHousePurchaseMortgageCard(module, projection) {
  const mortgage = projection?.result?.mortgage || {};
  const affordability = projection?.result?.householdAffordability || {};
  const inputs = module?.generated?.housePurchaseInputs || {};
  const { card, actions } = createHousePurchaseCard('house-purchase-mortgage', 'Mortgage and monthly fit', 'house-purchase-mortgage-card');
  actions.appendChild(buildHousePurchaseStatus(formatHousePurchaseChoice(affordability.status, 'Needs household inputs'), affordability.status));
  const metrics = document.createElement('div');
  metrics.className = 'house-purchase-mortgage-metrics';
  metrics.appendChild(buildHousePurchaseMetric('Mortgage illustrated', formatHousePurchaseCurrency(mortgage.principal)));
  metrics.appendChild(buildHousePurchaseMetric('Monthly repayment', formatHousePurchaseCurrency(mortgage.monthlyPayment), `${formatHousePurchasePercent(mortgage.rate)} · ${mortgage.termYears || '—'} years`));
  metrics.appendChild(buildHousePurchaseMetric('Total interest', formatHousePurchaseCurrency(mortgage.totalInterest), 'If the rate stayed unchanged'));
  metrics.appendChild(buildHousePurchaseMetric('Ownership costs', `${formatHousePurchaseCurrency(inputs.estimatedMonthlyOwnershipCosts)} / month`, 'Planning estimate excluding mortgage'));
  metrics.appendChild(buildHousePurchaseMetric('Base headroom', `${formatHousePurchaseCurrency(affordability.baseHeadroom)} / month`));
  metrics.appendChild(buildHousePurchaseMetric('+1% stressed headroom', `${formatHousePurchaseCurrency(affordability.stressedHeadroom)} / month`));
  card.appendChild(metrics);
  const sensitivity = Array.isArray(mortgage.sensitivity) ? mortgage.sensitivity : [];
  if (sensitivity.length > 0) {
    const tableWrap = document.createElement('div');
    tableWrap.className = 'house-purchase-table-wrap';
    const table = document.createElement('table');
    table.className = 'house-purchase-table';
    table.innerHTML = '<thead><tr><th scope="col">Rate</th><th scope="col">Term</th><th scope="col">Monthly</th><th scope="col">Total interest</th></tr></thead>';
    const tbody = document.createElement('tbody');
    sensitivity.forEach((row) => {
      const tr = document.createElement('tr');
      [formatHousePurchasePercent(row.rate), `${row.termYears || '—'} years`, formatHousePurchaseCurrency(row.monthlyPayment), formatHousePurchaseCurrency(row.totalInterest)].forEach((value) => {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    card.appendChild(tableWrap);
  }
  const disclosure = document.createElement('p');
  disclosure.className = 'house-purchase-inline-disclosure';
  disclosure.textContent = 'This is a repayment illustration, not a quoted mortgage rate or lender affordability assessment.';
  card.appendChild(disclosure);
  return card;
}

function normalizeHousePurchaseCriteria(scheme) {
  if (Array.isArray(scheme?.criteria)) {
    return scheme.criteria.map((item) => ({
      label: item?.label || item?.criterion || item?.title || 'Criterion',
      detail: item?.detail || item?.reason || '',
      status: item?.status || (item?.passed === true ? 'passed' : (item?.passed === false ? 'failed' : 'unanswered'))
    }));
  }
  return [
    ...(Array.isArray(scheme?.passedCriteria) ? scheme.passedCriteria.map((label) => ({ label, status: 'passed' })) : []),
    ...(Array.isArray(scheme?.failedCriteria) ? scheme.failedCriteria.map((label) => ({ label, status: 'failed' })) : []),
    ...(Array.isArray(scheme?.unansweredCriteria) ? scheme.unansweredCriteria.map((label) => ({ label, status: 'unanswered' })) : [])
  ];
}

function buildHousePurchaseSchemePanel(title, scheme, kind) {
  const panel = document.createElement('article');
  panel.className = 'house-purchase-scheme-panel';
  panel.dataset.scheme = kind;
  const header = document.createElement('div');
  header.className = 'house-purchase-scheme-header';
  const heading = document.createElement('h4');
  heading.textContent = title;
  header.appendChild(heading);
  header.appendChild(buildHousePurchaseStatus(formatHousePurchaseChoice(scheme?.status, 'More information required'), scheme?.status));
  panel.appendChild(header);
  const confirmedAmount = finiteHousePurchaseNumber(scheme?.confirmedAmount);
  const potentialAmount = finiteHousePurchaseNumber(scheme?.potentialAmount);
  const maximumAmount = finiteHousePurchaseNumber(scheme?.maximumAmount);
  const hasConfirmedAmount = confirmedAmount !== null && confirmedAmount > 0;
  const amount = hasConfirmedAmount
    ? confirmedAmount
    : (potentialAmount !== null && potentialAmount > 0 ? potentialAmount : maximumAmount);
  if (amount !== null && amount > 0) {
    const amountNode = document.createElement('div');
    amountNode.className = 'house-purchase-scheme-amount';
    amountNode.dataset.kind = hasConfirmedAmount ? 'confirmed' : 'potential';
    amountNode.innerHTML = `<span>${hasConfirmedAmount ? 'Confirmed input' : 'Potential support — requires confirmation'}</span><strong>${formatHousePurchaseCurrency(amount)}</strong>`;
    panel.appendChild(amountNode);
  }
  if (kind === 'htb' && scheme?.amountRange) {
    const range = document.createElement('p');
    range.className = 'house-purchase-scheme-range';
    range.textContent = `${formatHousePurchaseCurrency(scheme.amountRange.minimum)}–${formatHousePurchaseCurrency(scheme.amountRange.maximum)} maximum before prior-four-year tax-paid verification.`;
    panel.appendChild(range);
  }
  if (kind === 'fhs') {
    const facts = document.createElement('div');
    facts.className = 'house-purchase-scheme-facts';
    if (finiteHousePurchaseNumber(scheme?.equityPercentage) !== null) {
      facts.appendChild(buildHousePurchaseMetric('Illustrated equity share', formatHousePurchasePercent(scheme.equityPercentage)));
    }
    if (finiteHousePurchaseNumber(scheme?.maximumShare) !== null) {
      facts.appendChild(buildHousePurchaseMetric('Encoded maximum share', formatHousePurchasePercent(scheme.maximumShare), scheme.usingHtb ? 'With Help to Buy' : 'Without Help to Buy'));
    }
    if (finiteHousePurchaseNumber(scheme?.priceCeiling) !== null) {
      facts.appendChild(buildHousePurchaseMetric('Local price ceiling', formatHousePurchaseCurrency(scheme.priceCeiling), scheme.priceCeilingEntry?.localAuthority || 'Selected area'));
    }
    if (facts.childElementCount > 0) panel.appendChild(facts);
  }
  const criteria = normalizeHousePurchaseCriteria(scheme);
  if (criteria.length > 0) {
    const list = document.createElement('ul');
    list.className = 'house-purchase-criteria-list';
    criteria.forEach((criterion) => {
      const tone = normalizeHousePurchaseTone(criterion.status);
      const item = document.createElement('li');
      item.dataset.tone = tone;
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = tone === 'positive' ? '✓' : (tone === 'negative' ? '×' : '?');
      item.appendChild(icon);
      const copy = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = criterion.label;
      copy.appendChild(label);
      const status = document.createElement('span');
      status.className = 'house-purchase-criterion-status';
      status.textContent = tone === 'positive'
        ? 'Criterion met'
        : (tone === 'negative' ? 'Criterion not met' : 'More information required');
      copy.appendChild(status);
      if (criterion.detail) {
        const detail = document.createElement('small');
        detail.textContent = criterion.detail;
        copy.appendChild(detail);
      }
      item.appendChild(copy);
      list.appendChild(item);
    });
    panel.appendChild(list);
  } else {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'Complete the relevant property, lender and buyer-status questions to screen this support.';
    panel.appendChild(empty);
  }
  if (kind === 'fhs') {
    const serviceTimeline = Array.isArray(scheme?.serviceChargeTimeline) ? scheme.serviceChargeTimeline : [];
    if (serviceTimeline.length > 0) {
      const service = document.createElement('div');
      service.className = 'house-purchase-service-timeline';
      const serviceTitle = document.createElement('strong');
      serviceTitle.textContent = 'Illustrated FHS service-charge bands';
      service.appendChild(serviceTitle);
      const rows = document.createElement('div');
      serviceTimeline.forEach((band) => {
        const row = document.createElement('span');
        const years = band.toYear === null || band.toYear === undefined
          ? `Year ${band.fromYear}+`
          : `Years ${band.fromYear}–${band.toYear}`;
        row.innerHTML = `<small>${years}</small><b>${formatHousePurchasePercent(band.rate)}</b><em>${formatHousePurchaseCurrency(band.annualAmount)} / year</em>`;
        rows.appendChild(row);
      });
      service.appendChild(rows);
      panel.appendChild(service);
    }
    const warning = document.createElement('p');
    warning.className = 'house-purchase-equity-warning';
    warning.textContent = 'FHS is an equity share, not a conventional loan. The euro redemption amount generally moves with the home’s value, and service charges can apply from year six.';
    panel.appendChild(warning);
  }
  return panel;
}

function buildHousePurchaseSupportsCard(projection) {
  const schemes = projection?.result?.schemes || {};
  const { card } = createHousePurchaseCard('house-purchase-supports', 'Irish buyer-support screens', 'house-purchase-supports-card');
  const intro = document.createElement('p');
  intro.className = 'house-purchase-supports-intro';
  intro.textContent = 'These are criterion-by-criterion educational screens. They are not approval or confirmation of eligibility.';
  card.appendChild(intro);
  const grid = document.createElement('div');
  grid.className = 'house-purchase-schemes-grid';
  grid.appendChild(buildHousePurchaseSchemePanel('Help to Buy', schemes.helpToBuy || {}, 'htb'));
  grid.appendChild(buildHousePurchaseSchemePanel('First Home Scheme', schemes.firstHomeScheme || {}, 'fhs'));
  card.appendChild(grid);
  return card;
}

function buildHousePurchaseActionsCard(projection) {
  const result = projection?.result || {};
  const primary = getHousePurchasePrimaryBottleneck(result);
  const sourceActions = Array.isArray(result.actions) ? result.actions.slice(0, 3) : [];
  const actions = sourceActions.length > 0 ? sourceActions : [
    { title: primary.label, detail: primary.detail || 'Complete the outstanding planning input.' },
    { title: 'Protect the cash reserve', detail: 'Keep the selected emergency reserve and ringfenced goals outside the purchase fund.' },
    { title: 'Confirm live rules', detail: 'Check lender, Revenue and First Home Scheme requirements before acting.' }
  ];
  const { card } = createHousePurchaseCard('house-purchase-actions', 'Your next three actions', 'house-purchase-actions-card');
  const list = document.createElement('ol');
  list.className = 'house-purchase-actions-list';
  actions.forEach((action, index) => {
    const item = document.createElement('li');
    const number = document.createElement('span');
    number.textContent = String(index + 1).padStart(2, '0');
    item.appendChild(number);
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = action?.title || 'Next step';
    copy.appendChild(title);
    const detail = document.createElement('p');
    detail.textContent = action?.detail || '';
    copy.appendChild(detail);
    item.appendChild(copy);
    list.appendChild(item);
  });
  card.appendChild(list);
  return card;
}

const HOUSE_PURCHASE_OFFICIAL_SOURCES = Object.freeze([
  ['Central Bank mortgage measures', 'https://www.centralbank.ie/financial-system/financial-stability/macro-prudential-policy/mortgage-measures'],
  ['Revenue Help to Buy', 'https://www.revenue.ie/en/property/help-to-buy-incentive/index.aspx'],
  ['Revenue residential Stamp Duty', 'https://www.revenue.ie/en/property/stamp-duty/property/stamp-duty-property/rates.aspx'],
  ['First Home Scheme eligibility', 'https://www.firsthomescheme.ie/about-the-scheme/eligibility/'],
  ['First Home Scheme rules', 'https://www.firsthomescheme.ie/faqs/rules-and-eligibility/'],
  ['First Home Scheme price ceilings', 'https://www.firsthomescheme.ie/about-the-scheme/property-price-ceilings/'],
  ['First Home Scheme service charges', 'https://www.firsthomescheme.ie/about-the-scheme/service-charges/'],
  ['First Home Scheme participating lenders', 'https://www.firsthomescheme.ie/about-the-scheme/switching-your-mortgage/'],
  ['Revenue DIRT', 'https://www.revenue.ie/en/additional-incomes/dirt/what-dirt-rate-is-applicable.aspx'],
  ['Bank of Ireland MortgageSaver', 'https://personalbanking.bankofireland.com/save-and-invest/savings/regular-savings-accounts/mortgagesaver/'],
  ['AIB deposit rates', 'https://www.aib.ie/our-products/savings-and-deposits/Deposit-Rates'],
  ['PTSB Regular Saver', 'https://www.ptsb.ie/saving-and-investing/savings-accounts/regular-saver/']
]);

function buildHousePurchaseAssumptionsCard(projection) {
  const { card } = createHousePurchaseCard('house-purchase-assumptions', 'Assumptions, rule dates and disclosures', 'house-purchase-assumptions-card');
  const details = document.createElement('details');
  details.className = 'house-purchase-assumptions-details';
  const summary = document.createElement('summary');
  summary.textContent = 'Open the calculation basis and official sources';
  details.appendChild(summary);
  const assumptions = projection?.assumptionsTable || {};
  if (Array.isArray(assumptions.rows) && assumptions.rows.length > 0) {
    const tableWrap = document.createElement('div');
    tableWrap.className = 'house-purchase-table-wrap';
    const table = document.createElement('table');
    table.className = 'house-purchase-table';
    if (Array.isArray(assumptions.columns) && assumptions.columns.length > 0) {
      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      assumptions.columns.forEach((column) => {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = String(column ?? '');
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);
    }
    const tbody = document.createElement('tbody');
    assumptions.rows.forEach((row) => {
      const tr = document.createElement('tr');
      (Array.isArray(row) ? row : Object.values(row || {})).forEach((value) => {
        const td = document.createElement('td');
        td.textContent = String(value ?? '');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    details.appendChild(tableWrap);
  }
  const versions = projection?.result?.ruleVersions;
  const versionSources = [];
  let requiresReleaseCheck = Boolean(versions?.requiresReleaseSourceCheck);
  if (versions && typeof versions === 'object') {
    const versionGrid = document.createElement('div');
    versionGrid.className = 'house-purchase-rule-versions';
    const versionEntries = (Array.isArray(versions)
      ? versions.map((value, index) => [String(index + 1), value])
      : Object.entries(versions))
      .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value) && (
        value.asOfDate || value.verifiedOn || value.effectiveDate || value.sourceUrl
          || (Array.isArray(value.sources) && value.sources.length > 0)
      ));
    versionEntries.forEach(([key, value]) => {
      const item = document.createElement('article');
      const label = document.createElement('strong');
      label.textContent = value?.label || formatHousePurchaseChoice(key);
      item.appendChild(label);
      const date = value?.asOfDate || value?.verifiedOn || value?.effectiveDate || (typeof value === 'string' ? value : '');
      const detail = document.createElement('span');
      detail.textContent = date ? `As of / verified ${date}` : 'Release-time source check required';
      item.appendChild(detail);
      const stale = Boolean(value?.isStale || value?.stale || value?.requiresReleaseCheck || value?.releaseCheckRequired || value?.status === 'stale' || !date);
      if (stale) {
        requiresReleaseCheck = true;
        item.dataset.tone = 'warning';
        const warning = document.createElement('em');
        warning.textContent = 'Refresh against the live source before release.';
        item.appendChild(warning);
      }
      const sources = [
        ...(Array.isArray(value?.sources) ? value.sources : []),
        ...(Array.isArray(value?.sourceUrls) ? value.sourceUrls : []),
        value?.sourceUrl
      ].filter((source) => typeof source === 'string' && source.trim());
      sources.forEach((source) => versionSources.push([`${value?.label || formatHousePurchaseChoice(key)} source`, source]));
      versionGrid.appendChild(item);
    });
    details.appendChild(versionGrid);
  }
  if (requiresReleaseCheck) {
    const staleWarning = document.createElement('p');
    staleWarning.className = 'house-purchase-rule-warning';
    staleWarning.textContent = 'One or more dated rules need a live source check before this module is released or relied upon.';
    details.appendChild(staleWarning);
  }
  const sourcesTitle = document.createElement('h4');
  sourcesTitle.textContent = 'Official sources';
  details.appendChild(sourcesTitle);
  const links = document.createElement('div');
  links.className = 'house-purchase-source-links';
  const seenUrls = new Set();
  [...versionSources, ...HOUSE_PURCHASE_OFFICIAL_SOURCES].forEach(([label, url]) => {
    const safeUrl = sanitizeExternalUrl(url);
    if (!safeUrl || seenUrls.has(safeUrl)) return;
    seenUrls.add(safeUrl);
    const link = document.createElement('a');
    link.href = safeUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    links.appendChild(link);
  });
  details.appendChild(links);
  const disclosures = document.createElement('div');
  disclosures.className = 'house-purchase-disclosures';
  [
    'Planéir provides educational financial-planning illustrations only. It does not provide mortgage approval, regulated financial advice, tax advice or legal advice.',
    'Mortgage lending is subject to each lender’s underwriting, affordability assessment, lending criteria and approval.',
    'Government-scheme rules, price ceilings, participating lenders, tax rules and interest rates can change. Confirm current eligibility with the relevant official body before acting.',
    'Savings and mortgage rates shown are assumptions unless explicitly marked as live data.'
  ].forEach((copy) => {
    const paragraph = document.createElement('p');
    paragraph.textContent = copy;
    disclosures.appendChild(paragraph);
  });
  details.appendChild(disclosures);
  card.appendChild(details);
  return card;
}

function renderHousePurchaseModule(module, {
  readOnly = false,
  onRemoveCard = null,
  onRemoveImage = null,
  onReorderCards = null,
  onEditHousePurchase = null,
  onHousePurchaseScenarioChange = null
} = {}) {
  const overrides = getHousePurchaseScenarioOverrides(module.id);
  const baseProjection = getHousePurchaseProjection(module, {});
  const projection = getHousePurchaseProjection(module, overrides);
  const section = document.createElement('section');
  section.className = 'generated-section house-purchase-generated-section';
  const heading = document.createElement('h2');
  heading.className = 'generated-section-title';
  heading.textContent = 'House Purchase Planner';
  section.appendChild(heading);
  const grid = document.createElement('div');
  grid.className = 'generated-grid house-purchase-generated-grid';
  if (!projection) {
    const { card, actions } = createHousePurchaseCard('house-purchase-error', 'Plan needs review', 'house-purchase-error-card');
    const copy = document.createElement('p');
    copy.textContent = 'The house-purchase inputs could not be calculated. Reopen the plan and check the required fields.';
    card.appendChild(copy);
    if (!readOnly && typeof onEditHousePurchase === 'function') {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'house-purchase-primary-btn';
      edit.textContent = 'Review plan';
      edit.addEventListener('click', () => onEditHousePurchase(module.id, {
        action: 'draft', stepIndex: 0, draft: cloneHousePurchaseDraft(module.generated.housePurchaseInputs)
      }));
      actions.appendChild(edit);
    }
    grid.appendChild(card);
  } else {
    grid.appendChild(buildHousePurchaseHeroCard(module, projection, { readOnly, onEditHousePurchase }));
    grid.appendChild(buildHousePurchaseReadinessCard(module, projection, overrides));
    grid.appendChild(buildHousePurchaseFundingCard(projection));
    grid.appendChild(buildHousePurchaseDepositChart(projection));
    grid.appendChild(buildHousePurchaseScenarioCard(module, baseProjection || projection, projection, overrides, { onHousePurchaseScenarioChange }));
    grid.appendChild(buildHousePurchaseMortgageCard(module, projection));
    grid.appendChild(buildHousePurchaseSupportsCard(projection));
    grid.appendChild(buildHousePurchaseActionsCard(projection));
    grid.appendChild(buildHousePurchaseAssumptionsCard(projection));
  }
  appendModuleMediaCards(grid, module, { readOnly, onRemoveImage });
  section.appendChild(grid);
  return applyGeneratedCardControls(section, module, { readOnly, onRemoveCard, onReorderCards });
}

function renderLiquidityPlanModule(module, {
  readOnly = false,
  onRemoveCard = null,
  onRemoveImage = null,
  onReorderCards = null,
  onEditGeneratedText = null
} = {}) {
  const plan = module?.generated?.liquidityPlan || {};
  const assessment = computeLiquidityAssessment(plan);
  const displayContext = getPlaybookDisplayContext(module);
  const section = document.createElement('section');
  section.className = 'generated-section liquidity-generated-section';

  const heading = document.createElement('h2');
  heading.className = 'generated-section-title';
  heading.textContent = displayContext.heading;

  const grid = document.createElement('div');
  grid.className = 'generated-grid liquidity-generated-grid';
  grid.appendChild(buildLiquidityHeroCard(module, assessment, { readOnly, onEditGeneratedText }));
  grid.appendChild(buildLiquidityActionCard(plan, assessment, module, { readOnly, onEditGeneratedText }));
  grid.appendChild(buildLiquidityCashCard(plan, assessment, module, { readOnly, onEditGeneratedText }));

  const evidenceCard = buildLiquidityEvidenceCard(plan, module, { readOnly, onEditGeneratedText });
  if (evidenceCard) {
    grid.appendChild(evidenceCard);
  }

  appendModuleMediaCards(grid, module, { readOnly, onRemoveImage });

  section.appendChild(heading);
  section.appendChild(grid);
  return applyGeneratedCardControls(section, module, { readOnly, onRemoveCard, onReorderCards });
}

function renderVideoSummaryModule(module, options = {}) {
  const videoSummary = module?.generated?.videoSummary || {};
  const section = document.createElement('section');
  section.className = 'generated-section video-summary-generated-section';

  const heading = document.createElement('h2');
  heading.className = 'generated-section-title';
  heading.textContent = 'Video Summary';
  section.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'generated-grid video-summary-generated-grid';

  const card = document.createElement('section');
  card.className = 'generated-card video-summary-card';
  card.dataset.generatedCard = 'video-summary';

  const { header } = buildGeneratedCardHeader(videoSummary.title || module?.title || 'Call video summary');
  card.appendChild(header);

  const content = document.createElement('div');
  content.className = 'video-summary-content';

  const embedWrap = document.createElement('div');
  embedWrap.className = 'video-summary-embed-wrap';

  if (videoSummary.embedUrl) {
    const iframe = document.createElement('iframe');
    iframe.className = 'video-summary-embed';
    iframe.src = videoSummary.embedUrl;
    iframe.title = videoSummary.title || 'YouTube video summary';
    iframe.loading = 'lazy';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    embedWrap.appendChild(iframe);
  } else {
    const empty = document.createElement('div');
    empty.className = 'video-summary-empty';
    empty.textContent = 'Video embed unavailable.';
    embedWrap.appendChild(empty);
  }
  content.appendChild(embedWrap);

  if (videoSummary.description) {
    const description = document.createElement('p');
    description.className = 'video-summary-description';
    description.textContent = videoSummary.description;
    content.appendChild(description);
  }

  if (videoSummary.url) {
    const link = document.createElement('a');
    link.className = 'video-summary-link';
    link.href = videoSummary.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open on YouTube';
    content.appendChild(link);
  }

  card.appendChild(content);
  grid.appendChild(card);
  section.appendChild(grid);

  return applyGeneratedCardControls(section, module, options);
}

function renderReportModule(module, options = {}) {
  const report = module?.generated?.report || {};
  const displayContext = getPlaybookDisplayContext(module);
  const { readOnly = false, onEditGeneratedText = null } = options;
  const section = document.createElement('section');
  section.className = 'generated-section report-generated-section';

  const heading = document.createElement('h2');
  heading.className = 'generated-section-title';
  heading.textContent = displayContext.heading;
  section.appendChild(heading);

  const content = document.createElement('div');
  content.className = 'report-generated-flow';
  const safeSummaryHtml = sanitizeSummaryHtml(module?.generated?.summaryHtml || '');

  if (safeSummaryHtml && htmlToPlainText(safeSummaryHtml)) {
    content.appendChild(renderReportSummaryCard(safeSummaryHtml, module, { readOnly, onEditGeneratedText }));
  }

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

    appendModuleMediaCards(content, module, options);
    section.appendChild(content);
    return applyGeneratedCardControls(section, module, options);
  }

  blocks.forEach((block, blockIndex) => {
    content.appendChild(renderReportBlock(module, block, {
      blockIndex,
      chartIndexByBlockId,
      readOnly,
      onEditGeneratedText
    }));
  });

  appendModuleMediaCards(content, module, options);
  section.appendChild(content);
  return applyGeneratedCardControls(section, module, options);
}

function renderEducationModule(module, options = {}) {
  const education = module?.generated?.education || {};
  const displayContext = getPlaybookDisplayContext(module);
  const { readOnly = false, onEditGeneratedText = null } = options;

  const section = document.createElement('section');
  section.className = 'generated-section education-generated-section';

  const heading = document.createElement('h2');
  heading.className = 'generated-section-title';
  heading.textContent = displayContext.heading;

  const grid = document.createElement('div');
  grid.className = 'generated-grid education-generated-grid';

  grid.appendChild(buildEducationTopicCard(module, education, { readOnly, onEditGeneratedText }));
  grid.appendChild(buildSummaryCard(module?.generated?.summaryHtml || '', {
    guideText: displayContext.guide,
    module,
    readOnly,
    onEditGeneratedText
  }));
  grid.appendChild(buildEducationVisualsCard(module, education));
  const metricsCard = buildEducationMetricsCard(education);
  if (metricsCard) {
    grid.appendChild(metricsCard);
  }
  const stepsCard = buildEducationStepsCard(module, education, { readOnly, onEditGeneratedText });
  if (stepsCard) {
    grid.appendChild(stepsCard);
  }
  grid.appendChild(buildEducationSectionsCard(module, education, { readOnly, onEditGeneratedText }));

  const referencesCard = buildEducationReferencesCard(module, education, { readOnly, onEditGeneratedText });
  if (referencesCard) {
    grid.appendChild(referencesCard);
  }

  appendModuleMediaCards(grid, module, options);

  section.appendChild(heading);
  section.appendChild(grid);
  return applyGeneratedCardControls(section, module, options);
}

function getCollegeProjection(module) {
  try {
    return computeCollegeFundingProjection(module?.generated?.collegeFundingInputs || {});
  } catch (error) {
    console.warn('[CallCanvas] college funding projection unavailable for render', error);
    return null;
  }
}

function buildCollegeHeroMetric(label, value, detail, tone = '') {
  const item = document.createElement('div');
  item.className = 'college-hero-metric';
  if (tone) {
    item.dataset.tone = tone;
  }

  const labelEl = document.createElement('span');
  labelEl.className = 'college-hero-metric-label';
  labelEl.textContent = label;
  item.appendChild(labelEl);

  const valueEl = document.createElement('strong');
  valueEl.className = 'college-hero-metric-value';
  valueEl.textContent = value;
  item.appendChild(valueEl);

  if (detail) {
    const detailEl = document.createElement('span');
    detailEl.className = 'college-hero-metric-detail';
    detailEl.textContent = detail;
    item.appendChild(detailEl);
  }

  return item;
}

function buildCollegeFundingHeroCard(projection) {
  const debug = projection?.debug || {};
  const inputs = debug.inputs || {};
  const card = document.createElement('section');
  card.className = 'generated-card college-hero-card';
  card.dataset.generatedCard = 'college-hero';

  const copy = document.createElement('div');
  copy.className = 'college-hero-copy';

  const kicker = document.createElement('p');
  kicker.className = 'college-hero-kicker';
  kicker.textContent = 'Funding range';
  copy.appendChild(kicker);

  const title = document.createElement('h3');
  title.className = 'college-hero-title';
  title.textContent = `${formatDisplayCurrency(debug.todayRange?.low || 0)} to ${formatDisplayCurrency(debug.todayRange?.high || 0)}`;
  copy.appendChild(title);

  const subtitle = document.createElement('p');
  subtitle.className = 'college-hero-subtitle';
  subtitle.textContent = `Today’s-money targets for ${inputs.childrenCount || 0} ${inputs.childrenCount === 1 ? 'child' : 'children'}, with future nominal costs shown separately for planning cashflow.`;
  copy.appendChild(subtitle);

  card.appendChild(copy);

  const metrics = document.createElement('div');
  metrics.className = 'college-hero-metrics';
  metrics.appendChild(buildCollegeHeroMetric(
    'College starts',
    String(debug.collegeStartYear || ''),
    `${debug.yearsUntilCollege || 0} years from now`
  ));
  metrics.appendChild(buildCollegeHeroMetric(
    'Stress test',
    formatDisplayCurrency(debug.stressScenario?.costToday || 0),
    debug.stressScenario?.title || '',
    'warning'
  ));
  metrics.appendChild(buildCollegeHeroMetric(
    'Future nominal high',
    formatDisplayCurrency(debug.nominalRange?.high || 0),
    `To ${debug.collegeEndYear || ''}`
  ));
  card.appendChild(metrics);

  return card;
}

function buildCollegeFundingScenarioCard(projection) {
  const scenarios = Array.isArray(projection?.debug?.scenarios) ? projection.debug.scenarios : [];
  const card = document.createElement('section');
  card.className = 'generated-card college-scenarios-card';
  card.dataset.generatedCard = 'college-scenarios';

  const { header } = buildGeneratedCardHeader('Scenario Comparison');
  card.appendChild(header);

  const list = document.createElement('div');
  list.className = 'college-scenario-grid';

  scenarios.forEach((scenario) => {
    const item = document.createElement('article');
    item.className = 'college-scenario-card';
    if (scenario.tone) {
      item.dataset.tone = scenario.tone;
    }

    const top = document.createElement('div');
    top.className = 'college-scenario-top';

    const title = document.createElement('h4');
    title.className = 'college-scenario-title';
    title.textContent = scenario.title;
    top.appendChild(title);

    const badge = document.createElement('span');
    badge.className = 'college-scenario-badge';
    badge.textContent = scenario.category || 'Scenario';
    top.appendChild(badge);
    item.appendChild(top);

    const values = document.createElement('div');
    values.className = 'college-scenario-values';
    values.appendChild(buildCollegeHeroMetric(
      'Today’s terms',
      formatDisplayCurrency(scenario.costToday),
      `${scenario.fundingPeriodYears || 0} family funding ${scenario.fundingPeriodYears === 1 ? 'year' : 'years'}`
    ));
    values.appendChild(buildCollegeHeroMetric(
      'Future nominal',
      formatDisplayCurrency(scenario.nominalCost),
      `${formatDisplayCurrency(scenario.peakAnnualCost || 0)} peak annual cost`
    ));
    item.appendChild(values);

    if (scenario.interpretation) {
      const interpretation = document.createElement('p');
      interpretation.className = 'college-scenario-interpretation';
      interpretation.textContent = scenario.interpretation;
      item.appendChild(interpretation);
    }

    list.appendChild(item);
  });

  card.appendChild(list);
  return card;
}

function renderCollegeFundingModule(module, {
  showPensionToggle = true,
  readOnly = false,
  onPatchInputs = null,
  assumptionsEditorStatus = null,
  onRemoveCard = null,
  onRemoveImage = null,
  onReorderCards = null,
  onEditGeneratedText = null
} = {}) {
  const projection = getCollegeProjection(module);
  const generatedOutputs = module?.generated?.outputs;
  const generatedAssumptions = module?.generated?.assumptions;
  const generatedTables = Array.isArray(module?.generated?.tables) ? module.generated.tables : [];
  const generatedCharts = Array.isArray(module?.generated?.charts) ? module.generated.charts : [];
  const hasGeneratedOutputs = Array.isArray(generatedOutputs?.rows) && generatedOutputs.rows.length > 0;
  const hasGeneratedAssumptions = Array.isArray(generatedAssumptions?.rows) && generatedAssumptions.rows.length > 0;
  const displayModule = projection
    ? {
      ...module,
      generated: {
        ...(module.generated || {}),
        assumptions: hasGeneratedAssumptions ? generatedAssumptions : projection.assumptionsTable,
        outputs: hasGeneratedOutputs ? generatedOutputs : projection.outputsTable,
        tables: generatedTables.length > 0 ? generatedTables : projection.tables,
        charts: generatedCharts.length > 0 ? generatedCharts : projection.charts
      }
    }
    : module;
  const displayContext = getPlaybookDisplayContext(module);
  const section = document.createElement('section');
  section.className = 'generated-section college-generated-section';

  const heading = document.createElement('h2');
  heading.className = 'generated-section-title';
  heading.textContent = displayContext.heading;

  const grid = document.createElement('div');
  grid.className = 'generated-grid college-generated-grid';

  if (projection) {
    grid.appendChild(buildCollegeFundingHeroCard(projection));
  }

  grid.appendChild(buildSummaryCard(module?.generated?.summaryHtml || '', {
    guideText: displayContext.guide,
    module,
    readOnly,
    onEditGeneratedText
  }));

  if (projection) {
    grid.appendChild(buildCollegeFundingScenarioCard(projection));
  }

  const chartsForDisplay = Array.isArray(displayModule?.generated?.charts) ? displayModule.generated.charts : [];

  grid.appendChild(buildChartsCard(displayModule, chartsForDisplay, {
    showPensionToggle,
    readOnly
  }));

  grid.appendChild(buildTableCard('Scenario Outputs', displayModule?.generated?.outputs || {}, {
    dataGeneratedCard: 'outputs',
    module: displayModule,
    tableKind: 'outputs',
    readOnly,
    onEditGeneratedText
  }));

  const annualTables = Array.isArray(displayModule?.generated?.tables) ? displayModule.generated.tables : [];
  annualTables.forEach((table, tableIndex) => {
    const title = typeof table?.title === 'string' && table.title.trim()
      ? table.title
      : `Annual Funding Profile ${tableIndex + 1}`;
    grid.appendChild(buildTableCard(title, table, {
      dataGeneratedCard: `table:${tableIndex}`
    }));
  });

  grid.appendChild(buildAssumptionsTableCard(displayModule, {
    onPatchInputs,
    status: assumptionsEditorStatus,
    readOnly,
    onEditGeneratedText
  }));

  appendModuleMediaCards(grid, module, { readOnly, onRemoveImage });

  section.appendChild(heading);
  section.appendChild(grid);
  return applyGeneratedCardControls(section, module, { readOnly, onRemoveCard, onReorderCards });
}

function isBlankGeneratedModule(module) {
  const generated = module?.generated;
  if (!generated || typeof generated !== 'object') {
    return true;
  }
  if (typeof generated.summaryHtml === 'string' && htmlToPlainText(generated.summaryHtml)) return false;
  if (Array.isArray(generated.charts) && generated.charts.length > 0) return false;
  if (Array.isArray(generated.tables) && generated.tables.length > 0) return false;
  if (Array.isArray(generated.assumptions?.rows) && generated.assumptions.rows.length > 0) return false;
  if (Array.isArray(generated.outputs?.rows) && generated.outputs.rows.length > 0) return false;
  return ![
    'pensionInputs',
    'netRetirementInputs',
    'collegeFundingInputs',
    'liquidityPlan',
    'housePurchaseInputs',
    'loanInputs',
    'mortgageInputs',
    'pbsInputs',
    'outputsBucketed',
    'education',
    'report',
    'videoSummary'
  ].some((key) => generated[key] && typeof generated[key] === 'object');
}

function buildGeneratedSection(module, {
  showPensionToggle = true,
  readOnly = false,
  onPatchInputs = null,
  assumptionsEditorStatus = null,
  onRemoveCard = null,
  onRemoveImage = null,
  onReorderCards = null,
  onEditGeneratedText = null,
  onStartHousePurchase = null,
  onEditHousePurchase = null,
  onHousePurchaseScenarioChange = null
} = {}) {
  const housePurchaseEditor = !readOnly ? getHousePurchaseEditor(module) : null;
  if (housePurchaseEditor && typeof onEditHousePurchase === 'function') {
    return renderHousePurchaseWizard(module, housePurchaseEditor, { onEditHousePurchase });
  }

  if (!readOnly && isBlankGeneratedModule(module) && typeof onStartHousePurchase === 'function') {
    return renderHousePurchaseStartCard(module, { onStartHousePurchase });
  }

  const displayModule = getCalculatedDisplayModule(module);
  const generated = displayModule.generated || {
    summaryHtml: '',
    assumptions: { columns: [], rows: [] },
    outputs: { columns: [], rows: [] },
    tables: [],
    pbsInputs: null,
    liquidityPlan: null,
    collegeFundingInputs: null,
    netRetirementInputs: null,
    outputsBucketed: null,
    education: null,
    report: null,
    videoSummary: null,
    charts: []
  };

  if (isVideoSummaryModule(displayModule)) {
    return renderVideoSummaryModule(displayModule, { readOnly, onRemoveCard, onReorderCards });
  }

  if (isLiquidityPlanModule(displayModule)) {
    return renderLiquidityPlanModule(displayModule, { readOnly, onRemoveCard, onRemoveImage, onReorderCards, onEditGeneratedText });
  }

  if (isHousePurchaseModule(displayModule)) {
    return renderHousePurchaseModule(displayModule, {
      readOnly,
      onRemoveCard,
      onRemoveImage,
      onReorderCards,
      onEditHousePurchase,
      onHousePurchaseScenarioChange
    });
  }

  if (isReportModule(displayModule)) {
    return renderReportModule(displayModule, { readOnly, onRemoveCard, onRemoveImage, onReorderCards, onEditGeneratedText });
  }

  if (isEducationModule(displayModule)) {
    return renderEducationModule(displayModule, { readOnly, onRemoveCard, onRemoveImage, onReorderCards, onEditGeneratedText });
  }

  if (isCollegeFundingModule(displayModule)) {
    return renderCollegeFundingModule(displayModule, {
      showPensionToggle,
      readOnly,
      onPatchInputs,
      assumptionsEditorStatus,
      onRemoveCard,
      onRemoveImage,
      onReorderCards,
      onEditGeneratedText
    });
  }

  const section = document.createElement('section');
  section.className = 'generated-section';
  const displayContext = getPlaybookDisplayContext(displayModule);

  const heading = document.createElement('h2');
  heading.className = 'generated-section-title';
  heading.textContent = displayContext.heading;

  const grid = document.createElement('div');
  grid.className = 'generated-grid';
  if (isPensionModule(displayModule)) {
    grid.classList.add('retirement-generated-grid');
  }
  if (isNetRetirementModule(displayModule)) {
    grid.classList.add('retirement-generated-grid', 'net-retirement-generated-grid');
  }

  const hasBucketedOutputs = isOutputsBucketedPresent(generated.outputsBucketed);
  const isPbsBucketedModule = hasBucketedOutputs && isPersonalBalanceSheetModule(displayModule);

  if (isPbsBucketedModule) {
    grid.appendChild(buildOutputsBucketedCard(displayModule, generated.outputsBucketed, {
      summaryHtml: generated.summaryHtml || '',
      readOnly,
      onEditGeneratedText
    }));
  } else {
    grid.appendChild(buildSummaryCard(generated.summaryHtml, {
      guideText: displayContext.guide,
      module,
      readOnly,
      onEditGeneratedText
    }));
  }

  if (isPensionModule(displayModule)) {
    grid.appendChild(buildRetirementExplainerCard());
    const retirementDecisionPanel = buildRetirementDecisionPanel(displayModule);
    if (retirementDecisionPanel) {
      grid.appendChild(retirementDecisionPanel);
    }
  }

  if (isNetRetirementModule(displayModule)) {
    const netRetirementDecisionPanel = buildNetRetirementDecisionPanel(displayModule);
    if (netRetirementDecisionPanel) {
      grid.appendChild(netRetirementDecisionPanel);
    }
  }

  if (isPensionModule(displayModule) || isNetRetirementModule(displayModule)) {
    grid.appendChild(buildChartsCard(displayModule, generated.charts, { showPensionToggle, readOnly }));
  }

  grid.appendChild(buildAssumptionsTableCard(displayModule, {
    onPatchInputs,
    status: assumptionsEditorStatus,
    readOnly,
    onEditGeneratedText
  }));

  if (!isPbsBucketedModule && hasBucketedOutputs) {
    grid.appendChild(buildOutputsBucketedCard(displayModule, generated.outputsBucketed, {
      summaryHtml: generated.summaryHtml || '',
      readOnly,
      onEditGeneratedText
    }));
  } else if (!isPbsBucketedModule) {
    const outputsForDisplay = filterOutputsRowsForPensionToggle(displayModule, generated.outputs);
    grid.appendChild(buildTableCard('Outputs', outputsForDisplay, {
      dataGeneratedCard: 'outputs',
      module: displayModule,
      tableKind: 'outputs',
      editBasePath: blocksGeneratedTableEditing(displayModule)
        ? null
        : ['generated', 'outputs'],
      readOnly,
      onEditGeneratedText
    }));
  }
  if (Array.isArray(generated.tables) && generated.tables.length > 0) {
    generated.tables.forEach((table, tableIndex) => {
      const title = typeof table?.title === 'string' && table.title.trim()
        ? table.title
        : `Table ${tableIndex + 1}`;
      grid.appendChild(buildTableCard(title, table, {
        dataGeneratedCard: `table:${tableIndex}`,
        module,
        editBasePath: blocksGeneratedTableEditing(displayModule)
          ? null
          : ['generated', 'tables', tableIndex],
        editTitlePath: blocksGeneratedTableEditing(displayModule)
          ? null
          : ['generated', 'tables', tableIndex, 'title'],
        readOnly,
        onEditGeneratedText
      }));
    });
  }
  if (!isPensionModule(displayModule) && !isNetRetirementModule(displayModule)) {
    const chartsForDisplay = isPbsBucketedModule
      ? getPbsChartsForDisplay(displayModule, generated)
      : generated.charts;
    grid.appendChild(buildChartsCard(displayModule, chartsForDisplay, { showPensionToggle, readOnly }));
  }

  appendModuleMediaCards(grid, module, { readOnly, onRemoveImage });

  section.appendChild(heading);
  section.appendChild(grid);

  return applyGeneratedCardControls(section, module, { readOnly, onRemoveCard, onReorderCards });
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
  onRemoveCard = null,
  onRemoveImage = null,
  onReorderCards = null,
  onEditGeneratedText = null,
  onStartHousePurchase = null,
  onEditHousePurchase = null,
  onHousePurchaseScenarioChange = null,
  assumptionsEditorStatus = null,
  readOnly = false,
  patchSummary = true,
  patchAssumptions = true,
  patchOutputs = true,
  patchCharts = false
}) {
  if (!focusedCard || !module) {
    return;
  }

  const generatedSection = focusedCard.querySelector('.generated-section');
  if (isVideoSummaryModule(module) || isLiquidityPlanModule(module) || isHousePurchaseModule(module) || getHousePurchaseEditor(module) || isReportModule(module) || isEducationModule(module) || isCollegeFundingModule(module) || isNetRetirementModule(module)) {
    if (!generatedSection) {
      return;
    }

    generatedSection.replaceWith(buildGeneratedSection(module, {
      onPatchInputs,
      onRemoveCard,
      onRemoveImage,
      onReorderCards,
      onEditGeneratedText,
      onStartHousePurchase,
      onEditHousePurchase,
      onHousePurchaseScenarioChange,
      assumptionsEditorStatus,
      readOnly
    }));
    return;
  }

  const generated = module.generated || {};
  if (
    generatedSection
    && isPersonalBalanceSheetModule(module)
    && isOutputsBucketedPresent(generated.outputsBucketed)
    && (patchSummary || patchOutputs)
  ) {
    generatedSection.replaceWith(buildGeneratedSection(module, {
      onPatchInputs,
      onRemoveCard,
      onRemoveImage,
      onReorderCards,
      onEditGeneratedText,
      assumptionsEditorStatus,
      readOnly
    }));
    return;
  }

  const grid = generatedSection?.querySelector('.generated-grid');
  if (!generatedSection || !grid) {
    return;
  }
  const displayModule = getCalculatedDisplayModule(module);
  const cardModule = isPensionModule(displayModule) ? displayModule : module;

  if (patchSummary) {
    replaceGeneratedCard({
      grid,
      selector: '[data-generated-card="summary"]',
      replacement: buildSummaryCard(cardModule.generated?.summaryHtml || '', {
        guideText: getPlaybookDisplayContext(cardModule).guide,
        module: cardModule,
        readOnly,
        onEditGeneratedText
      })
    });

    if (isPensionModule(cardModule)) {
      replaceGeneratedCard({
        grid,
        selector: '[data-generated-card="retirement-explainer"]',
        replacement: buildRetirementExplainerCard()
      });
    }
  }

  if (isPensionModule(cardModule) && (patchSummary || patchOutputs)) {
    const retirementDecisionPanel = buildRetirementDecisionPanel(cardModule);
    if (retirementDecisionPanel) {
      replaceGeneratedCard({
        grid,
        selector: '[data-generated-card="retirement-decision"]',
        replacement: retirementDecisionPanel
      });
    }
  }

  if (patchAssumptions) {
    replaceGeneratedCard({
      grid,
      selector: '[data-generated-card="assumptions"]',
      replacement: buildAssumptionsTableCard(cardModule, {
        onPatchInputs,
        status: assumptionsEditorStatus,
        readOnly,
        onEditGeneratedText
      })
    });
  }

  if (patchOutputs) {
    const displayGenerated = cardModule.generated || generated;
    const outputCard = isOutputsBucketedPresent(displayGenerated.outputsBucketed)
      ? buildOutputsBucketedCard(cardModule, displayGenerated.outputsBucketed, {
        summaryHtml: displayGenerated.summaryHtml || '',
        readOnly,
        onEditGeneratedText
      })
      : buildTableCard(
        'Outputs',
        filterOutputsRowsForPensionToggle(cardModule, displayGenerated.outputs),
        {
          dataGeneratedCard: 'outputs',
          module: cardModule,
          tableKind: 'outputs',
          editBasePath: blocksGeneratedTableEditing(cardModule)
            ? null
            : ['generated', 'outputs'],
          readOnly,
          onEditGeneratedText
        }
      );
    replaceGeneratedCard({
      grid,
      selector: '[data-generated-card="outputs"], [data-generated-card="outputs-bucketed"]',
      replacement: outputCard
    });
  }

  if (patchCharts) {
    const chartsForDisplay = isPersonalBalanceSheetModule(displayModule)
      ? getPbsChartsForDisplay(displayModule, displayModule.generated || {})
      : (Array.isArray(displayModule.generated?.charts) ? displayModule.generated.charts : []);
    replaceGeneratedCard({
      grid,
      selector: '[data-generated-card="charts"]',
      replacement: buildChartsCard(
        displayModule,
        chartsForDisplay,
        { showPensionToggle: true, readOnly }
      )
    });
  }

  applyGeneratedCardControls(generatedSection, module, { readOnly, onRemoveCard, onReorderCards });
}

export function getUiElements() {
  return {
    app: document.getElementById('app'),
    animLayer: document.getElementById('animLayer'),
    toastHost: document.getElementById('toastHost'),
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
    mobileHeaderMoreButton: document.getElementById('mobileHeaderMoreBtn'),
    mobileActionBar: document.getElementById('mobileActionBar'),
    mobileActionNewCallButton: document.getElementById('mobileActionNewCallBtn'),
    mobileActionNewModuleButton: document.getElementById('mobileActionNewModuleBtn'),
    mobileActionZoomButton: document.getElementById('mobileActionZoomBtn'),
    mobileActionZoomLabel: document.getElementById('mobileActionZoomLabel'),
    mobileActionMoreButton: document.getElementById('mobileActionMoreBtn'),
    mobileFocusNav: document.getElementById('mobileFocusNav'),
    mobileFocusModulesButton: document.getElementById('mobileFocusModulesBtn'),
    mobileFocusPrevButton: document.getElementById('mobileFocusPrevBtn'),
    mobileFocusNextButton: document.getElementById('mobileFocusNextBtn'),
    mobileModuleSheet: document.getElementById('mobileModuleSheet'),
    mobileModuleBackdrop: document.getElementById('mobileModuleBackdrop'),
    mobileModulePanel: document.getElementById('mobileModulePanel'),
    mobileModuleCloseButton: document.getElementById('mobileModuleCloseBtn'),
    mobileModuleList: document.getElementById('mobileModuleList'),
    mobileOverflowSheet: document.getElementById('mobileOverflowSheet'),
    mobileOverflowBackdrop: document.getElementById('mobileOverflowBackdrop'),
    mobileOverflowPanel: document.getElementById('mobileOverflowPanel'),
    mobileOverflowNewModuleButton: document.getElementById('mobileOverflowNewModuleBtn'),
    mobileOverflowCodexVideoBriefButton: document.getElementById('mobileOverflowCodexVideoBriefBtn'),
    mobileOverflowVideoSummaryButton: document.getElementById('mobileOverflowVideoSummaryBtn'),
    mobileOverflowPublishButton: document.getElementById('mobileOverflowPublishBtn'),
    mobileOverflowClientAccessButton: document.getElementById('mobileOverflowClientAccessBtn'),
    mobileOverflowResetButton: document.getElementById('mobileOverflowResetBtn'),
    publishSessionButton: document.getElementById('publishSessionBtn'),
    videoSummaryButton: document.getElementById('videoSummaryBtn'),
    videoSummaryModal: document.getElementById('videoSummaryModal'),
    videoSummaryTitle: document.getElementById('videoSummaryTitle'),
    videoSummaryCloseButton: document.getElementById('videoSummaryCloseBtn'),
    videoSummaryCancelButton: document.getElementById('videoSummaryCancelBtn'),
    videoSummaryForm: document.getElementById('videoSummaryForm'),
    videoSummaryUrlInput: document.getElementById('videoSummaryUrlInput'),
    videoSummaryTitleInput: document.getElementById('videoSummaryTitleInput'),
    videoSummaryDescriptionInput: document.getElementById('videoSummaryDescriptionInput'),
    videoSummaryError: document.getElementById('videoSummaryError'),
    videoSummarySaveButton: document.getElementById('videoSummarySaveBtn'),
    videoSummaryPreview: document.getElementById('videoSummaryPreview'),
    videoSummaryPreviewTitle: document.getElementById('videoSummaryPreviewTitle'),
    videoSummaryPreviewMeta: document.getElementById('videoSummaryPreviewMeta'),
    codexVideoBriefButton: document.getElementById('codexVideoBriefBtn'),
    codexVideoBriefModal: document.getElementById('codexVideoBriefModal'),
    codexVideoBriefCloseButton: document.getElementById('codexVideoBriefCloseBtn'),
    codexVideoBriefCancelButton: document.getElementById('codexVideoBriefCancelBtn'),
    codexVideoBriefCopyButton: document.getElementById('codexVideoBriefCopyBtn'),
    codexVideoBriefDownloadButton: document.getElementById('codexVideoBriefDownloadBtn'),
    codexVideoBriefError: document.getElementById('codexVideoBriefError'),
    codexVideoBriefClient: document.getElementById('codexVideoBriefClient'),
    codexVideoBriefModules: document.getElementById('codexVideoBriefModules'),
    codexVideoBriefAssets: document.getElementById('codexVideoBriefAssets'),
    openClientAccessButton: document.getElementById('openClientAccessBtn'),
    publishModal: document.getElementById('publishModal'),
    publishCloseButton: document.getElementById('publishCloseBtn'),
    publishGenerateButton: document.getElementById('publishGenerateBtn'),
    publishOpenClientAccessButton: document.getElementById('publishOpenClientAccessBtn'),
    publishModeShareInput: document.getElementById('publishModeShare'),
    publishModeEmailInput: document.getElementById('publishModeEmail'),
    publishEmailField: document.getElementById('publishEmailField'),
    publishClientEmailInput: document.getElementById('publishClientEmailInput'),
    publishExpirySelect: document.getElementById('publishExpirySelect'),
    publishClientPinInfo: document.getElementById('publishClientPinInfo'),
    publishClientPinStateRow: document.getElementById('publishClientPinStateRow'),
    publishClientPinStateValue: document.getElementById('publishClientPinStateValue'),
    publishPinToggle: document.getElementById('publishPinToggle'),
    publishPinGroup: document.getElementById('publishPinGroup'),
    publishIncludePinEmailToggle: document.getElementById('publishIncludePinEmailToggle'),
    publishCopyPinButton: document.getElementById('publishCopyPinBtn'),
    publishCopyLinkButton: document.getElementById('publishCopyLinkBtn'),
    publishCopyAdvisorLinkButton: document.getElementById('publishCopyAdvisorLinkBtn'),
    publishCopyEmailButton: document.getElementById('publishCopyEmailBtn'),
    publishSendEmailButton: document.getElementById('publishSendEmailBtn'),
    publishUpdateExpiryButton: document.getElementById('publishUpdateExpiryBtn'),
    publishResetClientAccessButton: document.getElementById('publishResetClientAccessBtn'),
    publishRevokeButton: document.getElementById('publishRevokeBtn'),
    publishError: document.getElementById('publishError'),
    publishPinInput: document.getElementById('publishPinInput'),
    publishPinHelp: document.getElementById('publishPinHelp'),
    publishPinWrap: document.getElementById('publishPinWrap'),
    publishPinValue: document.getElementById('publishPinValue'),
    publishLinkValue: document.getElementById('publishLinkValue'),
    publishAdvisorLinkValue: document.getElementById('publishAdvisorLinkValue'),
    publishExpiryValue: document.getElementById('publishExpiryValue'),
    publishEmailStatus: document.getElementById('publishEmailStatus'),
    publishResult: document.getElementById('publishResult'),
    newCallButton: document.getElementById('newCallBtn'),
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
  moduleCount = null,
  onTitleInput,
  onNotesInput,
  onPatchInputs = null,
  onAddImage = null,
  onRemoveImage = null,
  onRemoveCard = null,
  onReorderCards = null,
  onEditGeneratedText = null,
  onRestoreRemovedCards = null,
  onCreateVideoScene = null,
  onStartHousePurchase = null,
  onEditHousePurchase = null,
  onHousePurchaseScenarioChange = null,
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
  meta.textContent = Number.isFinite(moduleCount) && moduleCount > 0
    ? `Module ${moduleNumber} of ${moduleCount}`
    : `Module ${moduleNumber}`;

  const header = document.createElement('div');
  header.className = 'module-header-band';
  header.appendChild(meta);

  const titleShell = document.createElement('div');
  titleShell.className = 'module-title-shell';

  const titleInput = document.createElement('textarea');
  titleInput.className = 'module-title-input';
  titleInput.placeholder = 'Untitled Module';
  titleInput.value = module.title || '';
  titleInput.autocomplete = 'off';
  titleInput.rows = 1;
  titleInput.spellcheck = false;
  titleInput.readOnly = readOnly;
  titleInput.setAttribute('aria-label', 'Module title');

  const resizeTitleInput = () => {
    titleInput.style.height = 'auto';
    titleInput.style.height = `${Math.max(titleInput.scrollHeight, 42)}px`;
  };
  window.requestAnimationFrame(resizeTitleInput);

  titleShell.appendChild(titleInput);

  if (!readOnly) {
    const titleEditButton = document.createElement('button');
    titleEditButton.type = 'button';
    titleEditButton.className = 'module-title-edit-btn';
    titleEditButton.textContent = 'Edit';
    titleEditButton.setAttribute('aria-label', 'Edit module title');
    titleEditButton.addEventListener('click', () => {
      titleInput.focus();
      titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);
    });
    titleShell.appendChild(titleEditButton);
  }

  header.appendChild(titleShell);

  if (!readOnly && (
    typeof onAddImage === 'function'
    || typeof onRestoreRemovedCards === 'function'
    || typeof onCreateVideoScene === 'function'
  )) {
    const moduleActions = document.createElement('div');
    moduleActions.className = 'module-advisor-actions';

    if (typeof onAddImage === 'function') {
      const addImageButton = document.createElement('button');
      addImageButton.type = 'button';
      addImageButton.className = 'module-media-add-btn';
      addImageButton.textContent = 'Add image';
      addImageButton.addEventListener('click', () => onAddImage(module.id));
      moduleActions.appendChild(addImageButton);
    }

    if (typeof onCreateVideoScene === 'function') {
      const videoButton = document.createElement('button');
      videoButton.type = 'button';
      videoButton.className = 'module-media-add-btn module-video-scene-btn';
      videoButton.textContent = 'Create video scene';
      videoButton.setAttribute('aria-label', 'Create a video-safe scene from this module');
      videoButton.addEventListener('click', () => onCreateVideoScene(module.id));
      moduleActions.appendChild(videoButton);
    }

    const hiddenCount = Array.isArray(module?.ui?.hiddenCardIds) ? module.ui.hiddenCardIds.length : 0;
    if (hiddenCount > 0 && typeof onRestoreRemovedCards === 'function') {
      const restoreButton = document.createElement('button');
      restoreButton.type = 'button';
      restoreButton.className = 'module-media-add-btn module-restore-cards-btn';
      restoreButton.textContent = `Restore removed (${hiddenCount})`;
      restoreButton.addEventListener('click', () => onRestoreRemovedCards(module.id));
      moduleActions.appendChild(restoreButton);
    }

    header.appendChild(moduleActions);
  }

  const notesInput = document.createElement('textarea');
  notesInput.className = 'module-notes-input';
  notesInput.placeholder = 'Type notes for this module...';
  notesInput.value = module.notes || '';
  notesInput.readOnly = readOnly;

  if (!readOnly) {
    titleInput.addEventListener('input', (event) => {
      onTitleInput(module.id, event.target.value);
      resizeTitleInput();
    });

    titleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        titleInput.blur();
      }
    });

    notesInput.addEventListener('input', (event) => {
      onNotesInput(module.id, event.target.value);
    });
  }

  card.appendChild(header);

  const notesText = typeof module.notes === 'string' ? module.notes.trim() : '';
  const shouldRenderNotes = !readOnly || Boolean(notesText);
  if (shouldRenderNotes) {
    const notesPanel = document.createElement('details');
    notesPanel.className = 'module-notes-panel';
    const isCompactViewport = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 1024px)').matches;
    notesPanel.open = readOnly ? Boolean(notesText) : (Boolean(notesText) || !isCompactViewport);

    const notesSummary = document.createElement('summary');
    notesSummary.className = 'module-notes-summary';
    notesSummary.textContent = notesText ? 'Notes' : 'Add notes';
    notesPanel.appendChild(notesSummary);
    notesPanel.appendChild(notesInput);
    card.appendChild(notesPanel);
  }

  card.appendChild(buildGeneratedSection(module, {
    showPensionToggle,
    readOnly,
    onPatchInputs,
    assumptionsEditorStatus,
    onRemoveCard,
    onRemoveImage,
    onReorderCards,
    onEditGeneratedText,
    onStartHousePurchase,
    onEditHousePurchase,
    onHousePurchaseScenarioChange
  }));
  pane.appendChild(card);

  return pane;
}

export function renderMobileModuleSheet(ui, {
  modules = [],
  activeModuleId = null,
  onModuleSelect = null
} = {}) {
  if (!ui.mobileModuleList) {
    return;
  }

  ui.mobileModuleList.innerHTML = '';

  if (!Array.isArray(modules) || modules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mobile-module-empty';
    empty.textContent = 'No modules yet.';
    ui.mobileModuleList.appendChild(empty);
    return;
  }

  modules.forEach((module, index) => {
    const descriptor = buildOverviewPreviewDescriptor(module);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mobile-module-item';
    item.dataset.moduleId = module.id;
    item.dataset.moduleKind = descriptor.moduleKind.token;

    if (module.id === activeModuleId) {
      item.classList.add('is-active');
      item.setAttribute('aria-current', 'step');
    }

    const header = document.createElement('div');
    header.className = 'mobile-module-item-header';

    const headerMeta = document.createElement('div');
    headerMeta.className = 'mobile-module-item-meta';

    const position = document.createElement('span');
    position.className = 'mobile-module-item-position';
    position.textContent = `Module ${index + 1} of ${modules.length}`;
    headerMeta.appendChild(position);

    const typeChip = document.createElement('span');
    typeChip.className = 'mobile-module-item-kind';
    typeChip.textContent = descriptor.moduleKind.label;
    headerMeta.appendChild(typeChip);

    header.appendChild(headerMeta);

    if (module.id === activeModuleId) {
      const currentBadge = document.createElement('span');
      currentBadge.className = 'mobile-module-item-badge';
      currentBadge.textContent = 'Current';
      header.appendChild(currentBadge);
    }

    item.appendChild(header);

    const title = document.createElement('div');
    title.className = 'mobile-module-item-title';
    title.textContent = module.title?.trim() ? module.title.trim() : 'Untitled Module';
    item.appendChild(title);

    const preview = buildOverviewPreviewSurface(descriptor);
    preview.classList.add('mobile-module-item-preview');
    item.appendChild(preview);

    const metaStrip = buildOverviewMetaStrip(descriptor.metaItems);
    if (metaStrip) {
      metaStrip.classList.add('mobile-module-item-strip');
      item.appendChild(metaStrip);
    }

    item.addEventListener('click', () => {
      if (typeof onModuleSelect === 'function') {
        onModuleSelect(module.id);
      }
    });

    ui.mobileModuleList.appendChild(item);
  });
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
    const overviewDescriptor = buildOverviewPreviewDescriptor(module);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'module-card overview-card';
    card.dataset.moduleKind = overviewDescriptor.moduleKind.token;
    card.dataset.previewKind = overviewDescriptor.previewKind;
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

    const createdLabel = formatLocalTime(module.createdAt);

    const header = document.createElement('div');
    header.className = 'overview-card-header';

    const chipRow = document.createElement('div');
    chipRow.className = 'overview-chip-row';

    const typeChip = document.createElement('span');
    typeChip.className = 'overview-type-chip';
    typeChip.textContent = overviewDescriptor.moduleKind.label;
    chipRow.appendChild(typeChip);

    const label = document.createElement('div');
    label.className = 'overview-meta';
    label.textContent = `#${index + 1}${createdLabel ? ` • ${createdLabel}` : ''}`;
    chipRow.appendChild(label);
    header.appendChild(chipRow);

    const title = document.createElement('h3');
    title.className = 'overview-title';
    title.textContent = module.title?.trim() ? module.title : 'Untitled Module';

    header.appendChild(title);
    card.appendChild(header);
    card.appendChild(buildOverviewPreviewSurface(overviewDescriptor));

    const metaStrip = buildOverviewMetaStrip(overviewDescriptor.metaItems);
    if (metaStrip) {
      card.appendChild(metaStrip);
    }

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

  if (ui.videoSummaryButton) {
    ui.videoSummaryButton.disabled = readOnly || mode === 'compare';
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

  if (ui.mobileFocusNav) {
    ui.mobileFocusNav.classList.toggle('is-hidden', mode !== 'focused' || !hasModules);
  }

  if (ui.mobileFocusModulesButton) {
    ui.mobileFocusModulesButton.disabled = !hasModules;
  }

  if (ui.mobileFocusPrevButton) {
    ui.mobileFocusPrevButton.disabled = !hasPrevious;
    ui.mobileFocusPrevButton.title = 'Previous module';
    ui.mobileFocusPrevButton.setAttribute('aria-label', 'Previous module');
  }

  if (ui.mobileFocusNextButton) {
    ui.mobileFocusNextButton.disabled = !hasNext;
    ui.mobileFocusNextButton.title = 'Next module';
    ui.mobileFocusNextButton.setAttribute('aria-label', 'Next module');
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
