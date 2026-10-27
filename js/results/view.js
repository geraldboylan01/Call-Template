// Read-only analysis presentation. No conversation, microphone or session transport.
import { WORKSPACE_COPY } from '../workspace/copy.js';
import { consumerLanguageForModule, containsInternalModuleTerminology } from '../planning/module_offers.js';
import { describePlanningCompletion, getDisplayableResultItems as getResultItems } from './completion.js';

export function createReadOnlyResultsView(currentState) {
  const section = element('section');
  const completion = describePlanningCompletion(currentState);
  if (!completion.ready) {
    section.append(element('p', 'empty-state-inline', 'Your results are not ready yet.'));
    return section;
  }
  const heading = element('header', 'workspace-heading');
  const copy = element('div');
  append(copy,
    element('p', 'section-kicker', 'Calculated from your confirmed information'),
    element('h1', '', 'Your financial picture'),
    element('p', '', `These results are generated automatically and are not routinely reviewed by Gerry. They are illustrations, not approvals or recommendations. ${WORKSPACE_COPY.assumptionsNotice}`));
  heading.append(copy);
  section.append(heading);
  const items = getResultItems(currentState.analysis);
  const stack = element('div', 'result-stack');
  append(stack, createOverallSummary(currentState.analysis), createAnalysisErrors(currentState.analysis), createAdviserReviewOutcome(currentState));
  items.forEach(item => stack.append(createResultCard(item)));
  append(stack, createAssumptionsSection(currentState.analysis, items), createUncertaintyPanel(currentState, items));
  section.append(stack);
  return section;
}

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null && text !== '') {
    node.textContent = String(text);
  }
  return node;
}

function append(parent, ...children) {
  children.flat().filter(Boolean).forEach((child) => parent.append(child));
  return parent;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function humanise(value) {
  const clean = String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'Detail';
}

function safeDate(value, options = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat('en-IE', options).format(date);
}

function formatPrimitive(value, { path = '', parent = null, format = '' } = {}) {
  if (value === null || value === undefined || value === '') {
    return 'Not provided';
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'number') {
    const key = path.split('/').pop()?.toLowerCase() || '';
    const currency = typeof parent?.currency === 'string' ? parent.currency : 'EUR';
    if (format === 'currency' || key === 'amount') {
      return new Intl.NumberFormat('en-IE', {
        style: 'currency',
        currency,
        maximumFractionDigits: 0
      }).format(value);
    }
    if (format === 'percent') {
      return new Intl.NumberFormat('en-IE', {
        style: 'percent',
        maximumFractionDigits: 1
      }).format(Math.abs(value) <= 1 ? value : value / 100);
    }
    if (format === 'months') {
      return `${new Intl.NumberFormat('en-IE', { maximumFractionDigits: 1 }).format(value)} months`;
    }
    // A year is a label, not a quantity: "2029", never "2,029".
    if (format === 'plain') return String(Math.round(value));
    return new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(value);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) {
    return safeDate(value, { day: 'numeric', month: 'short', year: 'numeric' }) || value;
  }
  if (typeof value === 'string' && /[_-]/.test(value)) {
    return humanise(value);
  }
  // A camelCase string is an internal enum that escaped -- "currentOnTrack"
  // reached a client's page. humanise() has always existed for exactly this and
  // was only ever applied to the key, never to the value.
  if (typeof value === 'string' && /^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(value)) {
    return humanise(value);
  }
  return String(value);
}


function moduleName(item) {
  const id = String(firstDefined(item?.moduleId, item?.id, item?.module?.id, '') || '');
  const consumerDescription = consumerLanguageForModule(id)?.shortDescription;
  return String(firstDefined(
    consumerDescription,
    'an analysis'
  ));
}

function consumerVisibleAnalysis(item) {
  const id = String(firstDefined(item?.moduleId, item?.id, item?.module?.id, '') || '');
  return Boolean(consumerLanguageForModule(id));
}

function safeConsumerCopy(value) {
  const text = String(value || '').trim();
  return text && !containsInternalModuleTerminology(text) ? text : '';
}

function normaliseReadiness(item) {
  const readiness = asObject(item?.readiness) || {};
  return String(firstDefined(readiness.status, item?.status, 'recommended'));
}


const METRIC_METADATA_KEYS = new Set(['currency', 'moduleid', 'moduleversion', 'calculationversion']);

function metricFormatFromKey(key, value) {
  const clean = String(key || '').toLowerCase();
  // "2029" is a year, not a quantity. Grouping it as "2,029" is the kind of
  // detail that makes a page look machine-made.
  if (/year$/.test(clean) && typeof value === 'number') {
    return 'plain';
  }
  if (/months?$/.test(clean) && typeof value === 'number') {
    return 'months';
  }
  if (/(?:rate|ratio|percent|percentage)$/.test(clean) && typeof value === 'number') {
    return 'percent';
  }
  if (/(?:amount|value|price|cost|deposit|income|payment|saving|savings|cash|capacity|required|balance|shortfall|gap|surplus|affordability|reserve|budget|monthly|annual)/.test(clean)
      && typeof value === 'number') {
    return 'currency';
  }
  return '';
}

function flattenMetrics(value, output, prefix = '', depth = 0) {
  if (output.length >= 10 || depth > 2 || value === null || value === undefined) {
    return;
  }
  if (['string', 'number', 'boolean'].includes(typeof value)) {
    output.push({ label: humanise(prefix), value, format: metricFormatFromKey(prefix, value) });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => ['string', 'number'].includes(typeof item))) {
      output.push({ label: humanise(prefix), value: value.join(', '), format: '' });
    }
    return;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => {
      if (['debug', 'tables', 'charts', 'assumptions', 'warnings', 'code'].includes(key)) {
        return;
      }
      // "Currency: EUR" is not a result. These describe the result and the
      // renderer already reads them; showing them as metrics is noise a client
      // has to look past.
      if (METRIC_METADATA_KEYS.has(String(key).toLowerCase())) return;
      flattenMetrics(child, output, prefix ? `${prefix} · ${key}` : key, depth + 1);
    });
  }
}

function getMetrics(item) {
  const semantic = asObject(item?.semanticResult);
  const currency = String(semantic?.currency || 'EUR');
  if (item?.moduleId === 'liquidity_analysis' && semantic) {
    return [
      { label: 'Current cash', value: semantic.currentCash, format: 'currency', currency },
      { label: 'Spending covered', value: semantic.monthsCovered, format: 'months' },
      { label: 'Target reserve', value: semantic.targetCash, format: 'currency', currency },
      // Both figures are null when the reserve could not be compared, and the
      // filter below then drops the row entirely rather than captioning an
      // absent number as cash above target.
      semantic.shortfallCash > 0
        ? { label: 'Cash gap to target', value: semantic.shortfallCash, format: 'currency', currency }
        : { label: 'Cash above target', value: semantic.surplusCash, format: 'currency', currency }
    ].filter((metric) => metric.value !== null && metric.value !== undefined);
  }
  if (item?.moduleId === 'house_purchase' && semantic) {
    return [
      { label: 'Target property price', value: semantic.targetPropertyPrice, format: 'currency', currency },
      { label: 'Current supportable price', value: semantic.currentSupportablePrice, format: 'currency', currency },
      { label: 'Protected-cash gap', value: semantic.currentCashGap, format: 'currency', currency },
      semantic.monthsToReady !== null && semantic.monthsToReady !== undefined
        ? { label: 'Illustrated time to cash-ready', value: semantic.monthsToReady, format: 'months' }
        : { label: 'Illustrated cash-ready date', value: semantic.readyDateIso, format: '' }
    ].filter((metric) => metric.value !== null && metric.value !== undefined && metric.value !== '');
  }
  const rawHighlights = asArray(firstDefined(item?.highlights, item?.summaryMetrics));
  if (rawHighlights.length > 0) {
    return rawHighlights.slice(0, 10).map((metric) => {
      if (typeof metric !== 'object' || metric === null) {
        return { label: 'Result', value: metric, format: '' };
      }
      return {
        label: String(firstDefined(metric.label, metric.name, metric.title, metric.key, 'Result')),
        value: firstDefined(metric.value, metric.amount, metric.text, ''),
        format: String(firstDefined(metric.format, metric.type, '')),
        currency: metric.currency
      };
    });
  }

  // A MODULE PUBLISHES ITS OWN CLIENT-FACING TABLE. `outputs` carries the
  // labels it wrote, in the order it chose, with the values it formatted.
  // `semanticResult` is the INTERNAL representation -- what feeds other modules
  // and the summary engine -- and it was being preferred over `outputs`, so the
  // card was built by reflecting over internals and guessing presentation from
  // how each key happened to be spelled.
  //
  // That is where four client-facing faults came from at once: a pot shown as
  // "2,195,539.05" beside one shown as "€1,017,100" (the second key contained
  // the letters "income", which the currency heuristic matches on), a raw
  // "currentOnTrack" enum, a year grouped as "2,029", and a "Currency: EUR" row
  // that is renderer metadata rather than a result.
  //
  // Only liquidity_analysis and house_purchase had hand-written metric lists
  // above, which is why nobody saw it: the two modules anyone looked at never
  // took this path.
  const authored = authoredOutputMetrics(item);
  if (authored) return authored;

  const metrics = asObject(item?.metrics);
  const output = [];
  flattenMetrics(firstDefined(metrics, item?.semanticResult, item?.result), output);
  return output;
}

/**
 * A module's own `outputs` table, used verbatim.
 *
 * The label is NOT humanised: it is already the wording the module chose, and
 * running it through a camelCase splitter turns "Max-contribution gap" into
 * "Max contribution gap". The value is not reformatted either, because the
 * module knows which of its own numbers are money, months or years, and every
 * attempt to re-derive that from the label's spelling has produced a fault.
 */
function authoredOutputMetrics(item) {
  const rows = asArray(asObject(item?.outputs)?.rows);
  if (rows.length === 0) return null;
  const metrics = rows.slice(0, 10).flatMap((row) => {
    const [label, value] = asArray(row);
    if (typeof label !== 'string' || !label.trim()) return [];
    if (value === null || value === undefined || value === '') return [];
    return [{ label: label.trim(), value, format: '' }];
  });
  return metrics.length > 0 ? metrics : null;
}

function createResultCard(item) {
  const result = asObject(item?.result) && !item?.outputs ? { ...item, ...item.result } : item;
  const card = element('article', 'result-card');
  const head = element('div', 'result-head');
  const rawStatus = String(firstDefined(result?.status, 'complete'));
  const status = safeConsumerCopy(humanise(rawStatus)) || 'Complete';
  append(
    head,
    element('h2', '', moduleName(result)),
    element('span', `result-status${['complete', 'completed', 'success'].includes(rawStatus) ? ' is-complete' : ''}`, status)
  );
  card.append(head);

  const summary = safeConsumerCopy(firstDefined(
    result?.summary,
    result?.resultSummary,
    result?.headline,
    result?.description
  ));
  if (summary) {
    card.append(element('p', 'result-summary', summary));
  }

  const metrics = getMetrics(result).map((metric) => ({
    ...metric,
    label: safeConsumerCopy(metric.label) || 'Result',
    value: typeof metric.value === 'string'
      ? safeConsumerCopy(metric.value)
      : metric.value
  })).filter((metric) => metric.value !== '');
  if (metrics.length > 0) {
    const list = element('dl', 'metric-grid');
    metrics.forEach((metric) => {
      const itemNode = element('div', 'metric-item');
      const formatted = formatPrimitive(metric.value, {
        path: metric.label,
        parent: metric.currency ? { currency: metric.currency } : null,
        format: metric.format
      });
      append(itemNode, element('dt', '', metric.label), element('dd', '', formatted));
      list.append(itemNode);
    });
    card.append(list);
  }

  const warnings = asArray(result?.warnings)
    .map((warning) => typeof warning === 'string'
      ? warning
      : String(firstDefined(warning?.message, warning?.text, warning?.reason, '') || ''))
    .map(safeConsumerCopy)
    .filter(Boolean);
  if (warnings.length > 0) {
    const list = element('ul', 'warning-list');
    warnings.forEach((warning) => list.append(element('li', '', warning)));
    card.append(list);
  }

  const provenance = element('div', 'result-provenance');
  const calculatedAt = firstDefined(result?.calculatedAt, result?.completedAt);
  const calculationVersion = firstDefined(result?.calculationVersion, result?.engineVersion);
  const moduleVersion = result?.moduleVersion;
  if (calculatedAt) {
    provenance.append(element('span', '', `Calculated ${safeDate(calculatedAt, { dateStyle: 'medium', timeStyle: 'short' }) || calculatedAt}`));
  }
  if (calculationVersion) {
    const safeCalculationVersion = safeConsumerCopy(calculationVersion);
    if (safeCalculationVersion) {
      provenance.append(element('span', '', `Calculation version ${safeCalculationVersion}`));
    }
  }
  if (moduleVersion) {
    const safeAnalysisVersion = safeConsumerCopy(moduleVersion);
    if (safeAnalysisVersion) {
      provenance.append(element('span', '', `Analysis version ${safeAnalysisVersion}`));
    }
  }
  if (provenance.childElementCount > 0) {
    card.append(provenance);
  }
  return card;
}

function collectAssumptions(analysis, resultItems) {
  const entries = [];
  const seen = new Set();
  const addEntry = (label, value, path = '') => {
    if (entries.length >= 24 || value === undefined || value === null || typeof value === 'object') {
      return;
    }
    const cleanLabel = safeConsumerCopy(humanise(label)) || 'Planning assumption';
    const cleanValue = typeof value === 'string' ? safeConsumerCopy(value) : value;
    if (cleanValue === '') return;
    const signature = `${cleanLabel}:${String(cleanValue)}`;
    if (!seen.has(signature)) {
      seen.add(signature);
      entries.push({ label: cleanLabel, value: cleanValue, path: path || label });
    }
  };
  const addObject = (value, prefix = '') => {
    if (!asObject(value)) {
      return;
    }
    Object.entries(value).forEach(([key, child]) => {
      if (entries.length >= 24) {
        return;
      }
      if (Array.isArray(child) && key === 'rows') {
        child.slice(0, 12).forEach((row) => {
          if (Array.isArray(row) && row.length >= 2) {
            addEntry(prefix ? `${prefix} · ${row[0]}` : row[0], row[1], String(row[0] || key));
          }
        });
        return;
      }
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        addObject(child, prefix ? `${prefix} · ${key}` : key);
        return;
      }
      if (child === undefined || child === null || typeof child === 'object') {
        return;
      }
      addEntry(prefix ? `${prefix} · ${key}` : key, child, key);
    });
  };
  const analysisRoot = asObject(analysis) || {};
  const plan = asObject(firstDefined(analysisRoot.analysisPlan, analysisRoot.plan)) || {};
  addObject(firstDefined(analysisRoot.assumptions, plan.assumptions), 'Plan');
  asArray(plan.selectedModules).forEach((selected) => {
    asArray(selected?.readiness?.assumptionsUsed).forEach((assumption) => {
      addEntry(
        `${moduleName(selected)} · ${firstDefined(assumption?.key, 'Assumption')}`,
        firstDefined(assumption?.value, ''),
        String(firstDefined(assumption?.key, '') || '')
      );
    });
  });
  resultItems.forEach((result) => addObject(asObject(result)?.assumptions, moduleName(result)));
  return entries;
}

function createAssumptionsSection(analysis, resultItems) {
  const assumptions = collectAssumptions(analysis, resultItems);
  if (assumptions.length === 0) {
    return null;
  }
  const section = element('section', 'assumptions-section');
  append(section, element('h2', '', 'Assumptions used'));
  const grid = element('div', 'assumption-grid');
  assumptions.forEach((assumption) => {
    const card = element('article', 'assumption-card');
    append(
      card,
      element('h3', '', assumption.label),
      element('p', '', formatPrimitive(assumption.value, {
        path: assumption.path,
        format: metricFormatFromKey(assumption.path, assumption.value)
      }))
    );
    grid.append(card);
  });
  section.append(grid);
  return section;
}

function createUncertaintyPanel(currentState, resultItems) {
  const messages = [];
  asArray(currentState.profile?.missingInformation).forEach((item) => {
    const text = safeConsumerCopy(typeof item === 'string'
      ? item
      : String(firstDefined(item?.reason, humanise(String(item?.fieldPath || '').split('/').pop()), 'A profile detail is missing.')));
    if (text) messages.push(text);
  });
  resultItems.forEach((item) => {
    asArray(item?.warnings).forEach((warning) => {
      const text = typeof warning === 'string'
        ? warning
        : String(firstDefined(warning?.message, warning?.text, warning?.reason, '') || '');
      const safeText = safeConsumerCopy(text);
      if (safeText) messages.push(safeText);
    });
  });
  const unique = [...new Set(messages.filter(Boolean))];
  if (unique.length === 0) {
    return null;
  }
  const panel = element('section', 'uncertainty-panel');
  append(panel, element('h2', '', 'Notes and missing information'));
  const list = element('ul', 'plain-list');
  unique.forEach((message) => list.append(element('li', '', message)));
  panel.append(list);
  return panel;
}

function summaryStrings(value) {
  if (typeof value === 'string') {
    const text = safeConsumerCopy(value);
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      return String(firstDefined(item?.text, item?.message, item?.title, item?.label, '') || '');
    }).map(safeConsumerCopy).filter(Boolean);
  }
  return [];
}

function createOverallSummary(analysis) {
  const summary = firstDefined(analysis?.summary, analysis?.resultSummary);
  if (!summary) {
    return null;
  }
  const card = element('section', 'result-card is-wide');
  const summaryObject = asObject(summary);
  const title = safeConsumerCopy(firstDefined(summaryObject?.headline, summaryObject?.title))
    || 'What your analyses show';
  card.append(element('h2', '', title));
  const narrative = safeConsumerCopy(typeof summary === 'string'
    ? summary
    : firstDefined(summaryObject?.summary, summaryObject?.overview, summaryObject?.description));
  if (narrative && narrative !== title) {
    card.append(element('p', 'result-summary', narrative));
  }
  const findings = [
    ...summaryStrings(firstDefined(
      summaryObject?.priorityActions,
      summaryObject?.actions,
      summaryObject?.keyFindings,
      summaryObject?.findings,
      summaryObject?.points,
      summaryObject?.highlights
    )),
    ...summaryStrings(summaryObject?.nextSteps)
  ].filter((item, index, values) => values.indexOf(item) === index);
  if (findings.length > 0) {
    const list = element('ul', 'action-list');
    findings.forEach((finding) => list.append(element('li', '', finding)));
    card.append(list);
  }
  return card;
}

function createAnalysisErrors(analysis) {
  const errors = asArray(analysis?.errors).map((error) => {
    if (typeof error === 'string') {
      return safeConsumerCopy(error) || 'An analysis could not be completed.';
    }
    const module = consumerLanguageForModule(error?.moduleId)?.shortDescription;
    const message = safeConsumerCopy(firstDefined(
      error?.message,
      error?.reason,
      error?.error
    )) || 'This analysis could not be completed.';
    return module
      ? `${module}: ${message}`
      : message;
  }).filter(Boolean);
  if (errors.length === 0) {
    return null;
  }
  const panel = element('section', 'error-panel');
  append(
    panel,
    element('h2', '', 'Some analyses could not be completed'),
    element('p', '', 'Completed results are still shown. No missing figure has been guessed or filled by AI.')
  );
  const list = element('ul', 'warning-list');
  errors.forEach((message) => list.append(element('li', '', message)));
  panel.append(list);
  return panel;
}

function adviserReviewModuleSlots(currentState) {
  const persisted = asArray(currentState.analysisPlan?.moduleSlots)
    .filter((slot) => (
      slot?.availability === 'adviser_review_required' && consumerVisibleAnalysis(slot)
    ));
  if (persisted.length > 0) return persisted.slice(0, 3);
  return asArray(currentState.recommendations)
    .filter((item) => (
      normaliseReadiness(item) === 'adviser_review_required' && consumerVisibleAnalysis(item)
    ))
    .map((item, index) => ({
      slot: Number(item?.slot || index + 1),
      moduleId: String(firstDefined(item?.moduleId, item?.id, item?.module?.id, '') || ''),
      availability: 'adviser_review_required'
    }))
    .filter((slot) => slot.moduleId)
    .slice(0, 3);
}

function createAdviserReviewOutcome(currentState) {
  const slots = adviserReviewModuleSlots(currentState);
  if (slots.length === 0) return null;
  const panel = element('section', 'uncertainty-panel adviser-review-outcome');
  append(
    panel,
    element('h2', '', getResultItems(currentState.analysis).length === 0 ? 'Analysis plan saved for review' : 'Part of this plan requires Gerry’s review'),
    element(
      'p',
      '',
      getResultItems(currentState.analysis).length === 0
        ? 'No automated financial result was produced for these analyses. They remain in your confirmed plan and can be shared with Gerry only if you separately choose and consent.'
        : 'The released analyses were calculated above. The analyses below remain in the same confirmed analysis plan, but no automated result was produced for them.'
    )
  );
  const list = element('ul', 'plain-list');
  slots.forEach((slot) => {
    const definition = { moduleId: slot.moduleId };
    list.append(element('li', '', `${moduleName(definition)} — Gerry review required`));
  });
  panel.append(list);
  return panel;
}

