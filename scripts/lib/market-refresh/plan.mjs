// Working out what a refresh changes, and writing it into `market_ie.js`.
//
// The arithmetic is not here. `market_math.js` works a figure's value out of its
// quotes, and this file asks it before and after, so the job and the app can never
// disagree about a value. What is here is bookkeeping: which quotes moved, which
// dates and versions follow, and a careful text edit of the data file that keeps
// its comments and layout.
//
// Rules, from the register's own:
// - A quote that was read replaces the old one, with today as `retrievedOn`. A quote
//   that was not read is left exactly as it was.
// - `checkedOn` becomes today for a figure when at least one of its quotes was read.
// - If the worked-out value changed, `changedOn` becomes today and the figure's
//   `version` and the catalogue's `MARKET_FIGURES_VERSION` go up.
// - A `reviewed` figure's value is a person's choice. The job never changes it, so it
//   never bumps a version for one; it reports where the quotes now point.

import assert from 'node:assert/strict';

import { daysBetween } from '../../../js/planning/figures/checks.js';
import { marketFigureEvidence, resolveMarketFigureValue } from '../../../js/planning/figures/market_math.js';

/** A quote that moved by this much or more is applied, and also called out: it may be a misread. */
export const LARGE_MOVE = 0.01;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 1.0.0 -> 1.1.0. A change of value is a change to the data, so the middle number goes up. */
export function bumpFigureVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Figure version ${JSON.stringify(version)} is not major.minor.patch.`);
  return `${match[1]}.${Number(match[2]) + 1}.0`;
}

/** ie-market-2026.1 -> ie-market-2026.2; the first change of a new year starts again at .1. */
export function bumpCatalogueVersion(version, today) {
  const match = /^(ie-market-)(\d{4})\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Catalogue version ${JSON.stringify(version)} is not ie-market-YYYY.N.`);
  const year = today.slice(0, 4);
  return `${match[1]}${year}.${year === match[2] ? Number(match[3]) + 1 : 1}`;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * What a refresh would do.
 *
 * `figures` are the market figures as they stand. `reads` are the results of
 * reading each quote: `{ figureId, sourceLabel, result }`, where `result` is what
 * `readQuote` returned (or `{ ok: false, reason }` for a quote with no reader).
 */
export function planRefresh({ figures, catalogueVersion, today, reads }) {
  assert.match(today, ISO_DATE, 'today must be a date');
  const planned = figures.map((figure) => {
    const quotes = figure.observations.map((observation) => {
      const read = reads.find((entry) => entry.figureId === figure.id && entry.sourceLabel === observation.sourceLabel)?.result
        ?? { ok: false, reason: 'no reader is defined for this quote' };
      const before = { value: observation.value, effective: observation.effective, url: observation.url, quotedAs: observation.quotedAs, retrievedOn: observation.retrievedOn };
      if (!read.ok) {
        return { sourceLabel: observation.sourceLabel, status: 'unread', reason: read.reason, urls: read.urls ?? [], before, after: before, changedFields: [], largeMove: false, pages: [], notes: [] };
      }
      const after = { value: read.value, effective: read.effective, url: read.url, quotedAs: read.quotedAs, retrievedOn: today };
      const changedFields = ['value', 'effective', 'url', 'quotedAs'].filter((field) => before[field] !== after[field]);
      return {
        sourceLabel: observation.sourceLabel,
        status: changedFields.length > 0 ? 'moved' : 'unchanged',
        before,
        after,
        changedFields,
        largeMove: Math.abs(after.value - before.value) >= LARGE_MOVE - 1e-12,
        printed: read.printed,
        pages: read.pages,
        notes: read.notes
      };
    });

    const anyRead = quotes.some((quote) => quote.status !== 'unread');
    const afterObservations = figure.observations.map((observation, index) => ({
      ...plain(observation),
      ...(quotes[index].status === 'unread' ? {} : quotes[index].after)
    }));
    const afterFigure = { ...plain(figure), observations: afterObservations };
    const valueBefore = resolveMarketFigureValue(figure);
    const valueAfter = resolveMarketFigureValue(afterFigure);
    const valueChanged = valueAfter !== valueBefore;
    if (anyRead) afterFigure.checkedOn = today;
    if (valueChanged) {
      afterFigure.changedOn = today;
      afterFigure.version = bumpFigureVersion(figure.version);
    }

    const reviewed = figure.method.kind === 'reviewed'
      ? { held: valueAfter, evidenceBefore: marketFigureEvidence(figure), evidenceAfter: marketFigureEvidence(afterFigure), driftWarnAt: figure.method.driftWarnAt ?? null }
      : null;

    return {
      id: figure.id,
      label: figure.label,
      unit: figure.unit,
      methodKind: figure.method.kind,
      reviewEveryDays: figure.reviewEveryDays,
      valueBefore,
      valueAfter,
      valueChanged,
      checkedOn: { before: figure.checkedOn, after: afterFigure.checkedOn },
      changedOn: { before: figure.changedOn, after: afterFigure.changedOn },
      version: { before: figure.version, after: afterFigure.version },
      quotes,
      reviewed,
      afterFigure
    };
  });

  const anyValueChanged = planned.some((figure) => figure.valueChanged);
  return {
    today,
    catalogueVersion: { before: catalogueVersion, after: anyValueChanged ? bumpCatalogueVersion(catalogueVersion, today) : catalogueVersion },
    figures: planned
  };
}

/** Counts for a headline. */
export function summarisePlan(plan) {
  const quotes = plan.figures.flatMap((figure) => figure.quotes);
  return {
    quotesRead: quotes.filter((quote) => quote.status !== 'unread').length,
    quotesUnread: quotes.filter((quote) => quote.status === 'unread').length,
    quotesMoved: quotes.filter((quote) => quote.status === 'moved').length,
    valuesChanged: plan.figures.filter((figure) => figure.valueChanged).length,
    largeMoves: quotes.filter((quote) => quote.largeMove).length
  };
}

/**
 * Whether the refresh is worth a PR. Something moved (a quote's rate, its printed
 * date, its page, or a worked-out value) or the register is about to go stale
 * because the last recorded check is `freshnessDays` old or more, which the
 * "checked N days ago" warning would otherwise report as the job having stopped.
 */
export function decideOnPullRequest(plan, { freshnessDays = 21 } = {}) {
  const reasons = [];
  const summary = summarisePlan(plan);
  if (summary.quotesMoved > 0) reasons.push(`${summary.quotesMoved} quote${summary.quotesMoved === 1 ? '' : 's'} moved`);
  if (summary.valuesChanged > 0) reasons.push(`${summary.valuesChanged} figure value${summary.valuesChanged === 1 ? '' : 's'} changed`);
  if (reasons.length === 0) {
    const aging = plan.figures.filter((figure) => figure.checkedOn.after !== figure.checkedOn.before && daysBetween(figure.checkedOn.before, plan.today) >= freshnessDays);
    if (aging.length > 0) reasons.push(`the recorded check is ${freshnessDays} days old or more for ${aging.length} figure${aging.length === 1 ? '' : 's'}`);
  }
  return { openPullRequest: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Writing the data file
// ---------------------------------------------------------------------------

const jsString = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function numberLiteral(value) {
  const text = String(value);
  if (/e/i.test(text)) return Number(value).toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return text;
}

function once(text, needle, what) {
  const first = text.indexOf(needle);
  if (first < 0) throw new Error(`market_ie.js has no ${what}.`);
  if (text.indexOf(needle, first + 1) >= 0) throw new Error(`market_ie.js has ${what} more than once.`);
  return first;
}

function setField(block, name, literal) {
  const pattern = new RegExp(`(\\n[ \\t]*${name}: )[^\\n]*?(,?)(?=\\n|$)`);
  if (!pattern.test(block)) throw new Error(`market_ie.js: could not find "${name}" where it was expected.`);
  return block.replace(pattern, (_, head, comma) => `${head}${literal}${comma}`);
}

/**
 * `market_ie.js` with the plan written into it. Only the fields that change are
 * touched, so comments, order and layout stay as they are. Throws if the file is
 * not laid out as expected, rather than guess.
 */
export function applyPlanToSource(sourceText, plan) {
  let text = sourceText;
  if (plan.catalogueVersion.after !== plan.catalogueVersion.before) {
    once(text, `export const MARKET_FIGURES_VERSION = ${jsString(plan.catalogueVersion.before)};`, 'MARKET_FIGURES_VERSION');
    text = text.replace(`export const MARKET_FIGURES_VERSION = ${jsString(plan.catalogueVersion.before)};`, `export const MARKET_FIGURES_VERSION = ${jsString(plan.catalogueVersion.after)};`);
  }

  for (const figure of plan.figures) {
    const start = once(text, `id: ${jsString(figure.id)},`, `figure ${figure.id}`);
    const nextFigure = text.indexOf('\n  Object.freeze({\n    id:', start);
    const end = nextFigure < 0 ? text.length : nextFigure;
    let block = text.slice(start, end);

    for (const quote of figure.quotes) {
      if (quote.status === 'unread') continue;
      const labelAt = once(block, `sourceLabel: ${jsString(quote.sourceLabel)},`, `quote "${quote.sourceLabel}" of ${figure.id}`);
      const closeAt = block.indexOf('\n      })', labelAt);
      if (closeAt < 0) throw new Error(`market_ie.js: the quote "${quote.sourceLabel}" is not laid out as expected.`);
      let observation = block.slice(labelAt, closeAt);
      observation = setField(observation, 'url', jsString(quote.after.url));
      observation = setField(observation, 'value', numberLiteral(quote.after.value));
      observation = setField(observation, 'quotedAs', jsString(quote.after.quotedAs));
      observation = setField(observation, 'effective', quote.after.effective === null ? 'null' : jsString(quote.after.effective));
      observation = setField(observation, 'retrievedOn', jsString(quote.after.retrievedOn));
      block = block.slice(0, labelAt) + observation + block.slice(closeAt);
    }

    // The figure's own dates and version are at the figure's indentation, after its quotes.
    const tail = block.lastIndexOf('\n    ]),');
    if (tail < 0) throw new Error(`market_ie.js: ${figure.id} has no closing of its observations where expected.`);
    let after = block.slice(tail);
    after = setField(after, 'checkedOn', jsString(figure.checkedOn.after));
    after = setField(after, 'changedOn', jsString(figure.changedOn.after));
    after = setField(after, 'version', jsString(figure.version.after));
    block = block.slice(0, tail) + after;

    text = text.slice(0, start) + block + text.slice(end);
  }
  return text;
}

/**
 * Proof that the edited file says what the plan meant: import it and compare,
 * figure by figure. A mis-edit fails here, before anything is written.
 */
export async function verifyEditedSource(editedText, plan) {
  let imported;
  try {
    imported = await import(`data:text/javascript;base64,${Buffer.from(editedText).toString('base64')}`);
  } catch (error) {
    throw new Error(`The edited market_ie.js does not load (${error.message}).`);
  }
  assert.equal(imported.MARKET_FIGURES_VERSION, plan.catalogueVersion.after, 'MARKET_FIGURES_VERSION');
  assert.equal(imported.MARKET_FIGURES.length, plan.figures.length, 'number of figures');
  for (const figure of plan.figures) {
    const written = imported.MARKET_FIGURES.find((candidate) => candidate.id === figure.id);
    assert.ok(written, `${figure.id} is missing from the edited file`);
    assert.deepStrictEqual(plain(written), plain(figure.afterFigure), `${figure.id} does not read back as planned`);
    assert.equal(resolveMarketFigureValue(written), figure.valueAfter, `${figure.id} works out to a different value`);
  }
}
