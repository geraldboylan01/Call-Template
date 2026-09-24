/**
 * HOW A CASE READS.
 *
 * One deterministic formatter turns an application into the kind of write-up an
 * Ask About Money post gives: grouped, plain, one fact per line. The same
 * output is the live preview on /apply/, Gerry's admin view, the case.md that
 * replaces forum.md in the video workflow, and (rounded) the published case.
 *
 * It only reads. It never infers a figure the person did not give, apart from
 * the totals under "Worked out", which are labelled as such.
 */

import {
  SECTIONS,
  TOPICS,
  createContext,
  getPath,
  isFieldVisible,
  isSectionNone,
  isSectionVisible,
  optionLabel
} from './schema.js';
import {
  formatMoney,
  formatMonth,
  formatPercent,
  formatYears,
  roundPublicMoney
} from './format.js';

const NOT_SURE = 'not sure';

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

function money(value, field, publicMode) {
  const monthly = field.unit === 'month';
  const amount = publicMode ? roundPublicMoney(value, { monthly }) : value;
  const suffix = field.unit === 'month' ? ' a month' : (field.unit === 'year' ? ' a year' : '');
  // The label already says "a month" for most monthly fields; saying it twice
  // reads badly, so the suffix is only added where the label is silent.
  const labelSaysPeriod = /a (month|year)/.test(field.short || field.label);
  return `${formatMoney(amount)}${labelSaysPeriod ? '' : suffix}`;
}

/** Format one answer for reading. Returns '' when there is nothing to show. */
export function formatAnswer(field, value, { publicMode = false, unit } = {}) {
  if (!hasValue(value)) return '';
  switch (field.type) {
    case 'money':
      return money(value, field, publicMode);
    case 'percent':
      return formatPercent(value);
    case 'age':
      return String(value);
    case 'years':
      return formatYears(value);
    case 'month':
      return formatMonth(value);
    case 'contribution': {
      if (unit === 'eur') {
        const amount = publicMode ? roundPublicMoney(value, { monthly: true }) : value;
        return `${formatMoney(amount)} a month`;
      }
      return `${formatPercent(value)} of salary`;
    }
    case 'choice':
      return optionLabel(field, value, { publicMode });
    case 'text':
    case 'longtext':
      return String(value);
    default:
      return '';
  }
}

function shouldShowField(field, publicMode) {
  return !(publicMode && field.private);
}

function repeaterItemLines(section, app, ctx, { publicMode }) {
  const items = getPath(app, section.repeater.path);
  if (!Array.isArray(items)) return [];
  const unsure = new Set(Array.isArray(app.unsure) ? app.unsure : []);
  const lines = [];
  items.slice(0, section.repeater.max).forEach((item, index) => {
    const parts = [];
    section.repeater.fields.forEach((field) => {
      if (!shouldShowField(field, publicMode) || !isFieldVisible(field, app, ctx, item)) return;
      const path = `${section.repeater.path}.${index}.${field.key}`;
      const unit = field.unitKey ? item?.[field.unitKey] : undefined;
      const text = formatAnswer(field, item?.[field.key], { publicMode, unit });
      if (text) parts.push({ label: field.short || field.label, value: text });
      else if (unsure.has(path)) parts.push({ label: field.short || field.label, value: NOT_SURE });
    });
    if (parts.length > 0) {
      lines.push({ label: `${section.repeater.itemTitle} ${index + 1}`, value: '', items: parts });
    }
  });
  return lines;
}

function sumKnown(values) {
  const known = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) : null;
}

function itemsOf(app, path) {
  const items = getPath(app, path);
  return Array.isArray(items) ? items : [];
}

/**
 * The totals a reader would otherwise add up by hand. Each needs at least two
 * figures, because a "total" of one number tells nobody anything.
 */
function workedOut(app, ctx, { publicMode }) {
  const lines = [];
  const round = (value) => (publicMode ? roundPublicMoney(value) : value);
  const visible = (id) => SECTIONS.some((section) => section.id === id && isSectionVisible(section, app, ctx));
  const hasMortgage = visible('mortgage') && app.home?.status === 'mortgage';

  if (hasMortgage && typeof app.home?.value === 'number' && typeof app.mortgage?.balance === 'number') {
    lines.push({ label: 'Equity in the home', value: formatMoney(round(app.home.value - app.mortgage.balance)) });
  }

  const savingsParts = [app.savings?.cash, app.savings?.investments, app.savings?.employerShares]
    .filter((value) => typeof value === 'number');
  if (savingsParts.length >= 2) {
    lines.push({ label: 'Savings and investments in total', value: formatMoney(round(sumKnown(savingsParts))) });
  }

  const pensionsVisible = visible('pensions') && !isSectionNone(SECTIONS.find((section) => section.id === 'pensions'), app);
  const propertiesVisible = visible('properties') && !isSectionNone(SECTIONS.find((section) => section.id === 'properties'), app);
  const loansVisible = visible('loans') && !isSectionNone(SECTIONS.find((section) => section.id === 'loans'), app);

  const assets = [
    ['mortgage', 'owned'].includes(app.home?.status) ? app.home?.value : null,
    app.savings?.cash,
    app.savings?.investments,
    app.savings?.employerShares,
    ...(propertiesVisible ? itemsOf(app, 'properties').map((item) => item?.value) : []),
    ...(pensionsVisible ? itemsOf(app, 'pensions').map((item) => (item?.type === 'public' ? null : item?.value)) : [])
  ].filter((value) => typeof value === 'number');
  const debts = [
    hasMortgage ? app.mortgage?.balance : null,
    ...(propertiesVisible ? itemsOf(app, 'properties').map((item) => item?.mortgage) : []),
    ...(loansVisible ? itemsOf(app, 'loans').map((item) => item?.balance) : []),
    visible('loans') && app.creditCard?.clears === 'no' ? app.creditCard?.balance : null
  ].filter((value) => typeof value === 'number');

  if (assets.length + debts.length >= 2 && assets.length > 0) {
    const totalAssets = sumKnown(assets) || 0;
    const totalDebts = sumKnown(debts) || 0;
    lines.push({ label: 'Everything owned', value: formatMoney(round(totalAssets)) });
    if (debts.length > 0) lines.push({ label: 'Everything owed', value: formatMoney(round(totalDebts)) });
    lines.push({ label: 'Net worth, including pensions', value: formatMoney(round(totalAssets - totalDebts)) });
  }

  return lines;
}

/**
 * The write-up as data: sections of { label, value } lines, in page order.
 * `publicMode` rounds money and leaves out anything marked private (the
 * question and other free text, the lender, the name for the video).
 */
export function applicationToSections(app, { publicMode = false } = {}) {
  const source = app && typeof app === 'object' ? app : {};
  const ctx = createContext(source);
  const unsure = new Set(Array.isArray(source.unsure) ? source.unsure : []);
  const sections = [];

  SECTIONS.forEach((section) => {
    if (!isSectionVisible(section, source, ctx)) return;
    const lines = [];

    // A repeater comes before the section's own questions, as it does on the
    // page: the loans, then the credit card.
    if (section.repeater) {
      if (isSectionNone(section, source)) {
        lines.push({ label: section.none.short || section.title, value: 'None' });
      } else {
        lines.push(...repeaterItemLines(section, source, ctx, { publicMode }));
      }
    }

    (section.fields || []).forEach((field) => {
      if (!shouldShowField(field, publicMode) || !isFieldVisible(field, source, ctx)) return;
      const text = formatAnswer(field, getPath(source, field.path), { publicMode });
      if (text) lines.push({ label: field.short || field.label, value: text });
      else if (unsure.has(field.path)) lines.push({ label: field.short || field.label, value: NOT_SURE });
    });

    if (lines.length > 0) {
      sections.push({ id: section.id, title: section.summaryTitle || section.title, lines });
    }
  });

  const derived = workedOut(source, ctx, { publicMode });
  if (derived.length > 0) {
    sections.push({ id: 'worked-out', title: 'Worked out from the figures above', lines: derived });
  }

  return sections;
}

export function topicLabels(app) {
  const chosen = Array.isArray(app?.topics) ? app.topics : [];
  return TOPICS.filter((topic) => chosen.includes(topic.id)).map((topic) => topic.label);
}

function multilineValue(value) {
  return String(value).includes('\n') ? `\n${value}` : ` ${value}`;
}

/** Flatten a line to one string, for places that cannot nest. */
export function lineToString(line) {
  if (Array.isArray(line.items)) {
    return `${line.label}: ${line.items.map((item) => `${item.label} ${item.value}`).join(', ')}`;
  }
  return `${line.label}: ${line.value}`;
}

/** Plain text, for the preview and for pasting into a chat. */
export function applicationToText(app, { publicMode = false } = {}) {
  const blocks = [];
  const topics = topicLabels(app);
  if (topics.length > 0) blocks.push(`Help wanted with: ${topics.join(', ')}`);
  applicationToSections(app, { publicMode }).forEach((section) => {
    const lines = [];
    section.lines.forEach((line) => {
      if (section.id === 'question' && line.label === 'Question') {
        lines.push(line.value);
      } else if (Array.isArray(line.items)) {
        lines.push(line.label, ...line.items.map((item) => `  ${item.label}: ${item.value}`));
      } else {
        lines.push(`${line.label}:${multilineValue(line.value)}`);
      }
    });
    blocks.push([section.title.toUpperCase(), ...lines].join('\n'));
  });
  return blocks.join('\n\n');
}

/**
 * Markdown, for case.md. It takes the place of the forum.md an AAM post used
 * to supply in the presenter workflow, so it keeps the same shape: a title,
 * the question, then the facts.
 */
export function applicationToMarkdown(app, { heading = 'Planeir application', submittedAt = '', publicMode = false } = {}) {
  const out = [`# ${heading}`, ''];
  if (submittedAt) out.push(`Submitted: ${submittedAt}`, '');
  const topics = topicLabels(app);
  if (topics.length > 0) out.push(`**Help wanted with:** ${topics.join(', ')}`, '');
  applicationToSections(app, { publicMode }).forEach((section) => {
    out.push(`## ${section.title}`, '');
    section.lines.forEach((line) => {
      if (section.id === 'question' && line.label === 'Question') {
        out.push(line.value, '');
      } else if (Array.isArray(line.items)) {
        out.push(`- **${line.label}**`, ...line.items.map((item) => `  - ${item.label}: ${item.value}`));
      } else if (String(line.value).includes('\n')) {
        out.push(`**${line.label}:**`, '', line.value, '');
      } else {
        out.push(`- ${line.label}: ${line.value}`);
      }
    });
    out.push('');
  });
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
