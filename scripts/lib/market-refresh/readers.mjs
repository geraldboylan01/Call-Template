// Which cell of which page is which quote.
//
// `QUOTE_SOURCES` says, for every observation in `market_ie.js`, where its
// rate is printed and how to find it: the page, the row label, the table header
// the row must sit under, the column the rate is in. The job reads nothing it is
// not told to read, and a quote with no entry here is reported rather than guessed.
//
// A reader fails safe. If a page's wording or layout has moved (a row is gone, a
// header is different, a rate cell is not a percentage, two rows disagree), the
// quote is reported as unread and left as it was. It never reads the nearest
// number and carries on.

import { isoDate, linksIn, ReadError } from './pages.mjs';

const RATE_CELL = /^(\d{1,3}(?:\.\d{1,4})?)\s*(%)?(?:\s+(?:variable|fixed))?$/i;

/** A rate as printed ("3.60%", "2.00% Variable", "4") as a fraction (0.036). Null if the cell is not a rate. */
export function parseRate(cell, { percentOptional = false } = {}) {
  const match = RATE_CELL.exec(String(cell ?? '').trim());
  if (!match || (!match[2] && !percentOptional)) return null;
  return Number((Number(match[1]) / 100).toPrecision(12));
}

function cellMatches(cell, pattern) {
  return pattern instanceof RegExp ? pattern.test(cell) : cell.toLowerCase() === String(pattern).toLowerCase();
}

function sequenceAt(cells, index, sequence) {
  return sequence.every((pattern, offset) => index + offset < cells.length && cellMatches(cells[index + offset], pattern));
}

function precedingIndex(cells, before, sequence) {
  for (let index = before - sequence.length; index >= 0; index -= 1) {
    if (sequenceAt(cells, index, sequence)) return index;
  }
  return -1;
}

const asList = (value) => (Array.isArray(value) ? value : [value]);

/**
 * One printed row of a table.
 *
 * - `label`: the cell (or the run of cells) that starts the row. A string matches
 *   a whole cell, ignoring case; a pattern is tested against the whole cell.
 * - `within`: a heading the row must sit under (the nearest one above, within
 *   `maxGap` cells).
 * - `header`: the column headings the row must sit under. They must appear above
 *   the row, so a table that has been reordered or renamed is not read.
 * - `valueAt`: how many cells after the start of the row the rate is.
 * - `equalTo`: another column that must print the same rate (AER and gross).
 * - `lastColumn`: the rate must be the row's last: the next cell is not a rate.
 * - `expect`: cells that must read a given way, by offset ({ 3: 'fixed' }).
 *
 * Returns `{ value, printed, rateCell }`, or throws a `ReadError` saying what was
 * not as expected.
 */
export function findRow(cells, spec) {
  const { label, within = null, header = null, valueAt, equalTo = null, lastColumn = false, expect = {}, percentOptional = false, maxGap = 40 } = spec;
  const sequence = asList(label);
  const where = sequence.map((part) => String(part instanceof RegExp ? part.source : part)).join(' / ');
  const starts = [];
  for (let index = 0; index < cells.length; index += 1) {
    if (sequenceAt(cells, index, sequence)) starts.push(index);
  }
  if (starts.length === 0) throw new ReadError(`the row "${where}" is not on the page`);

  const reasons = [];
  const readings = [];
  for (const start of starts) {
    if (within) {
      const heading = precedingIndex(cells, start, [within]);
      if (heading < 0 || start - heading > maxGap) {
        reasons.push(`the row "${where}" is not under the heading "${within}"`);
        continue;
      }
    }
    if (header && precedingIndex(cells, start, asList(header)) < 0) {
      reasons.push(`the column headings (${asList(header).join(', ')}) are not above the row "${where}"`);
      continue;
    }
    const mismatched = Object.entries(expect).find(([offset, pattern]) => !cellMatches(cells[start + Number(offset)] ?? '', pattern));
    if (mismatched) {
      reasons.push(`the row "${where}" has "${cells[start + Number(mismatched[0])] ?? ''}" where "${mismatched[1]}" was expected`);
      continue;
    }
    const rateCell = cells[start + valueAt];
    const value = parseRate(rateCell, { percentOptional });
    if (value === null) {
      reasons.push(`the row "${where}" has "${rateCell ?? ''}" where a rate was expected`);
      continue;
    }
    if (equalTo !== null && parseRate(cells[start + equalTo], { percentOptional }) !== value) {
      reasons.push(`the row "${where}" prints different rates in columns that should agree ("${rateCell}" and "${cells[start + equalTo] ?? ''}")`);
      continue;
    }
    if (lastColumn && parseRate(cells[start + valueAt + 1], { percentOptional: false }) !== null) {
      reasons.push(`the row "${where}" has another rate column after the one read`);
      continue;
    }
    readings.push({ value, rateCell, printed: cells.slice(start, start + Math.max(valueAt, equalTo ?? 0) + 1).join(' | ') });
  }
  if (readings.length === 0) throw new ReadError(reasons[0]);
  if (readings.some((reading) => reading.value !== readings[0].value)) {
    throw new ReadError(`the row "${where}" appears more than once with different rates`);
  }
  return readings[0];
}

/** The date a page prints for when its rates take effect, as an ISO date, or null. */
export function printedEffectiveDate(text, pattern) {
  if (!pattern) return null;
  const match = pattern.exec(text);
  return match ? isoDate(match[1], match[2], match[3]) : null;
}

const DATED_NAME = /(\d{1,2})(?:st|nd|rd|th)?[-_ ]([A-Za-z]+)[-_ ](\d{4})/;

function dateInName(url) {
  const match = DATED_NAME.exec(decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''));
  return match ? isoDate(match[1], match[2], match[3]) : null;
}

/** The newest of several rates-PDF links, by the date in its file name. */
function newestLink(links) {
  if (links.length === 1) return links[0];
  const dated = links.map((href) => ({ href, date: dateInName(href) }));
  if (dated.some((entry) => entry.date === null)) {
    throw new ReadError(`${links.length} different rates PDFs are linked and they cannot be told apart by date`);
  }
  return dated.sort((left, right) => right.date.localeCompare(left.date))[0].href;
}

/**
 * The page a quote is printed on, with the pages that led to it. A plain page is
 * the observation's own url. A linked PDF is found by reading a page that links to
 * it (the file name carries the date, so the address changes), and following the
 * newest link; if that page cannot be read, the PDF last used is tried as it stands.
 */
async function loadSourcePage(source, observation, load) {
  if (source.page.kind === 'page') {
    return { page: await load(observation.url), url: observation.url, trail: [] };
  }
  const { indexPages, link } = source.page;
  const problems = [];
  const trail = [];
  for (const indexUrl of indexPages) {
    try {
      const index = await load(indexUrl);
      trail.push({ url: index.url, how: index.how, role: 'rates page' });
      const links = linksIn(index).filter((href) => link.test(href));
      if (links.length === 0) throw new ReadError('it has no link to the rates PDF');
      const url = newestLink(links);
      return { page: await load(url, { as: 'pdf' }), url, trail };
    } catch (error) {
      if (!(error instanceof ReadError)) throw error;
      problems.push(`${indexUrl}: ${error.message}`);
    }
  }
  try {
    return { page: await load(observation.url, { as: 'pdf' }), url: observation.url, trail };
  } catch (error) {
    if (!(error instanceof ReadError)) throw error;
    problems.push(`${observation.url}: ${error.message}`);
  }
  throw new ReadError(problems.join('; '));
}

/**
 * Reads one observation. Returns `{ ok: true, value, effective, url, quotedAs,
 * printed, pages, notes }` or `{ ok: false, reason, pages }`. Never throws for a
 * page that cannot be read or understood.
 */
export async function readQuote(observation, source, load) {
  try {
    const { page, url, trail } = await loadSourcePage(source, observation, load);
    const pages = [...trail, { url: page.url, how: page.how, role: source.page.kind === 'page' ? 'rates page' : 'linked PDF' }];
    const row = findRow(page.cells, source.row);
    if (!(row.value >= 0 && row.value <= 0.2)) throw new ReadError(`the rate read, "${row.rateCell}", is outside 0% to 20%`);
    const notes = [];
    const effective = printedEffectiveDate(page.text, source.effective);
    if (source.effective && effective === null) notes.push('the page no longer prints an effective date, so none is recorded');
    let quotedAs = observation.quotedAs;
    if (source.quotedAs) {
      const values = {};
      for (const [name, extra] of Object.entries(source.quotedAs.read)) values[name] = findRow(page.cells, extra).rateCell.replace(/\s+(variable|fixed)$/i, '');
      quotedAs = source.quotedAs.template.replace(/\{(\w+)\}/g, (_, name) => values[name]);
    }
    return { ok: true, value: row.value, effective, url, quotedAs, printed: row.printed, pages, notes };
  } catch (error) {
    if (!(error instanceof ReadError)) throw error;
    const urls = source.page.kind === 'page' ? [observation.url] : [...source.page.indexPages, observation.url];
    return { ok: false, reason: error.message, urls, pages: [] };
  }
}

// ---------------------------------------------------------------------------
// Where each quote in market_ie.js is printed
// ---------------------------------------------------------------------------

/** Bank of Ireland's deposit rates table is a dated PDF, linked from its product pages. */
const BOI_DEPOSIT_PDF = Object.freeze({
  kind: 'linked_pdf',
  indexPages: Object.freeze([
    'https://personalbanking.bankofireland.com/save-and-invest/savings/instant-access-and-notice-accounts/demand-deposit-account/features-and-benefits/',
    'https://personalbanking.bankofireland.com/save-and-invest/savings/regular-savings-accounts/supersaver-account/features-and-benefits/'
  ]),
  link: /\/Deposit[A-Za-z-]*Interest[A-Za-z-]*Rates?[A-Za-z-]*Table[A-Za-z0-9-]*\.pdf$/i
});

const BOI_DEPOSIT_EFFECTIVE = /effective from (?:the start of business )?(?:on )?(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+) (\d{4})/i;
const BOI_DEPOSIT_HEADER = Object.freeze(['Name', 'Notice', 'Min', 'Max', 'AER Variable']);
const AIB_DEPOSIT_HEADER = Object.freeze(['Minimum', 'Maximum', 'A.E.R. %', 'Gross Annual Interest Rate %']);

export const QUOTE_SOURCES = Object.freeze([
  {
    figure: 'ie.market.cash.instant_access_gross_rate',
    sourceLabel: 'Bank of Ireland, Instant Access Demand (balances up to €5,000)',
    page: BOI_DEPOSIT_PDF,
    effective: BOI_DEPOSIT_EFFECTIVE,
    row: { within: 'Standard Demand', header: BOI_DEPOSIT_HEADER, label: /^Instant Access Demand(\/Demand Deposit)?$/, valueAt: 5, lastColumn: true }
  },
  {
    figure: 'ie.market.cash.instant_access_gross_rate',
    sourceLabel: 'AIB, Personal Demand Deposit Account',
    page: { kind: 'page' },
    effective: /Rates applicable from (\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+) (\d{4})/i,
    row: { header: AIB_DEPOSIT_HEADER, label: 'Personal Demand Deposit Account', valueAt: 3, equalTo: 4 }
  },
  {
    figure: 'ie.market.cash.regular_saver_gross_rate',
    sourceLabel: 'Bank of Ireland, SuperSaver Standard Regular Saver (balances up to €29,999)',
    page: BOI_DEPOSIT_PDF,
    effective: BOI_DEPOSIT_EFFECTIVE,
    row: { within: 'SuperSaver Standard Regular Saver', header: BOI_DEPOSIT_HEADER, label: 'For balances up to €29,999', valueAt: 5, lastColumn: true }
  },
  {
    figure: 'ie.market.cash.regular_saver_gross_rate',
    sourceLabel: 'AIB, Online Regular Saver (up to €1,000 a month)',
    page: { kind: 'page' },
    effective: /Rates applicable from (\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+) (\d{4})/i,
    row: { header: AIB_DEPOSIT_HEADER, label: 'Online Regular Saver Rate', valueAt: 3, equalTo: 4 },
    // The second rate AIB applies to what is above the monthly limit is part of the quote's description.
    quotedAs: {
      template: 'AER, variable, before DIRT; {aboveLimit} above the monthly limit',
      read: { aboveLimit: { header: AIB_DEPOSIT_HEADER, label: 'Online Standard Saver Rate', valueAt: 3, equalTo: 4 } }
    }
  },
  {
    figure: 'ie.market.cash.regular_saver_gross_rate',
    sourceLabel: 'PTSB, 21 Day Notice Regular Saver (balances up to €75,000)',
    page: { kind: 'page' },
    effective: null,
    row: { header: ['Balance', 'Gross interest rate', 'Gross return', 'AER (variable) interest rate'], label: /^€0\.00 [-–] €75,000\.00$/, valueAt: 3 }
  },
  {
    figure: 'ie.market.mortgage.illustration_rate',
    sourceLabel: 'Bank of Ireland, 3 Year Fixed, first-time buyer, BER C',
    page: { kind: 'page' },
    effective: /Owner occupier rates are effective from (\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+) (\d{4})/i,
    row: {
      header: ['mortgage type name', 'BER', 'Product Description', 'fixed or variable', 'Interest Rate', '*APR'],
      label: ['First Time Buyer', 'C', '3 Year Fixed BER C'],
      valueAt: 4,
      expect: { 3: 'fixed' },
      percentOptional: true
    }
  },
  {
    figure: 'ie.market.mortgage.illustration_rate',
    sourceLabel: 'AIB, 3 Year LTV Fixed, over 50% and up to 80%',
    page: { kind: 'page' },
    effective: null,
    row: { header: ['Rate type', 'Interest Rates', 'APRC'], label: '3 Year LTV Fixed >50%<=80%', valueAt: 1 }
  },
  {
    figure: 'ie.market.mortgage.illustration_rate',
    sourceLabel: 'PTSB, 3 Year Fixed Rate New Business, over 60% and up to 80%',
    page: { kind: 'page' },
    effective: /Mortgage Interest Rates effective from (?:the start of business )?(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+) (\d{4})/i,
    row: {
      header: ['Fixed rates (Available for all loan amounts)', 'Borrowing rate', 'APRC'],
      label: /^3 Year Fixed Rate New Business [-–] greater than 60% and less than or equal to 80% LTV$/,
      valueAt: 1
    }
  }
]);

/** The entry for an observation, or undefined. */
export function sourceFor(figureId, sourceLabel, sources = QUOTE_SOURCES) {
  return sources.find((source) => source.figure === figureId && source.sourceLabel === sourceLabel);
}
