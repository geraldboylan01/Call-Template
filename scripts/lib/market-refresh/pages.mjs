// Reading a published rates page into the one shape the readers work on: a flat
// list of cells, in reading order. A cell is one visible piece of text (a table
// cell, a heading, a sentence), trimmed and with its spaces collapsed.
//
// Three kinds of page reach it:
// - HTML, fetched over the network. Every tag is a cell boundary.
// - Text saved from a real browser. Some bank sites refuse plain HTTP clients
//   (an "Access Denied" page), so a person or an agent with a browser saves the
//   page's visible text into a folder and the job reads that instead. A tab or a
//   line break is a cell boundary.
// - PDF, fetched over the network. Read with pdf.js, in the order a person reads
//   it: top to bottom, left to right.
//
// Nothing here knows about a bank. `readers.mjs` knows which cell is which rate.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const USER_AGENT = 'PlaneirFiguresJob/1.0 (+https://github.com/geraldboylan01/Call-Template; weekly read of published rates)';

/** What went wrong with a request, in plain words. */
function describeFailure(error) {
  return error?.name === 'TimeoutError' ? 'the request timed out' : `the request failed (${error?.cause?.code ?? error?.message ?? 'unknown error'})`;
}

/** A page that could not be read. The message is for the PR, so it says why in plain words. */
export class ReadError extends Error {}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', pound: '£',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', copy: '©'
};

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** One cell's text: no zero-width marks, non-breaking spaces as spaces, runs of space as one. */
function tidyCell(text) {
  return text.replace(/[​‌‍﻿]/g, '').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function toPage(url, cells, how, extra = {}) {
  const kept = cells.map(tidyCell).filter((cell) => cell !== '');
  return { url, how, cells: kept, text: kept.join(' '), ...extra };
}

/** A page's HTML as cells. Scripts, styles and the like are dropped, every other tag ends a cell. */
export function pageFromHtml(url, html, how = 'network') {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, '\n');
  const cells = decodeEntities(body.replace(/<[^>]*>/g, '\n')).split(/[\r\n]+/);
  return toPage(url, cells, how, { html });
}

/** Text saved from a browser as cells: a tab or a line break ends one. */
export function pageFromText(url, text, how = 'saved browser text') {
  return toPage(url, text.split(/[\t\r\n]+/), how);
}

/**
 * A PDF as cells, read with pdf.js (a dev dependency, loaded only when a PDF is
 * read). Text pieces on the same line, within two points, are one line.
 */
async function pageFromPdf(url, bytes, how = 'network PDF') {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (error) {
    // pdf.js needs DOMMatrix, which Node gets from its optional @napi-rs/canvas package.
    throw new ReadError(`the PDF reader (pdfjs-dist) could not be loaded (${error.message}); run \`npm ci\` without --omit=optional`);
  }
  let document;
  try {
    document = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0
    }).promise;
  } catch (error) {
    throw new ReadError(`the PDF could not be opened (${error.message})`);
  }
  const cells = [];
  try {
    for (let number = 1; number <= document.numPages; number += 1) {
      const content = await (await document.getPage(number)).getTextContent();
      const pieces = content.items
        .filter((item) => typeof item.str === 'string' && item.str.trim() !== '')
        .map((item) => ({ text: item.str, x: item.transform[4], y: item.transform[5] }))
        .sort((left, right) => right.y - left.y || left.x - right.x);
      const lines = [];
      for (const piece of pieces) {
        const line = lines.find((candidate) => Math.abs(candidate.y - piece.y) <= 2);
        if (line) line.pieces.push(piece);
        else lines.push({ y: piece.y, pieces: [piece] });
      }
      for (const line of lines) cells.push(...line.pieces.sort((left, right) => left.x - right.x).map((piece) => piece.text));
    }
  } catch (error) {
    throw new ReadError(`the PDF could not be read through (${error.message})`);
  }
  return toPage(url, cells, how);
}

/** The name a saved copy of a page must have: host and path, nothing else. */
export function savedPageName(url) {
  const { hostname, pathname } = new URL(url);
  const path = pathname.replace(/\/+$/, '').replace(/^\/+/, '');
  return `${hostname}--${path === '' ? 'index' : path}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{3,}/g, '--');
}

/** Month names to numbers, so "22nd October 2026" becomes 2026-10-22. Null for anything else. */
export function isoDate(day, monthName, year) {
  const month = MONTHS.indexOf(String(monthName).toLowerCase()) + 1;
  const d = Number(day);
  const y = Number(year);
  if (month < 1 || !Number.isInteger(d) || d < 1 || d > 31 || !Number.isInteger(y)) return null;
  const iso = `${String(y).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // 31 February is not a date.
  return new Date(`${iso}T00:00:00Z`).getUTCDate() === d ? iso : null;
}

/** Links in a page's HTML, as absolute URLs. */
export function linksIn(page) {
  if (!page.html) return [];
  const found = [];
  for (const match of page.html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    try {
      found.push(new URL(decodeEntities(match[1] ?? match[2]).trim(), page.url).href);
    } catch {
      // A link that is not a URL is not a link to follow.
    }
  }
  return [...new Set(found)];
}

/**
 * Where pages come from. Order of preference:
 * 1. A copy saved from a browser in `pagesDir` (`<name>.txt` or `<name>.html`,
 *    named by `savedPageName`), if it is recent: a copy from last week would
 *    stamp last week's rate with today's date, so an old one is refused.
 * 2. The network.
 *
 * Returns `load(url, { as })`, which gives a page or throws a `ReadError` saying
 * why not. Each page is fetched once per run.
 */
export function createPageLoader({
  fetchImpl = globalThis.fetch,
  pagesDir = null,
  now = () => Date.now(),
  maxSavedAgeHours = 36,
  timeoutMs = 30_000,
  readSaved = readFile,
  statSaved = stat
} = {}) {
  const cache = new Map();

  async function fromSaved(url, as) {
    const name = savedPageName(url);
    for (const extension of as === 'pdf' ? [] : ['html', 'txt']) {
      const path = join(pagesDir, `${name}.${extension}`);
      let info;
      try {
        info = await statSaved(path);
      } catch {
        continue;
      }
      const ageHours = (now() - info.mtimeMs) / 3_600_000;
      if (ageHours > maxSavedAgeHours) {
        throw new ReadError(`the saved copy ${name}.${extension} is ${Math.round(ageHours)} hours old; save the page again`);
      }
      const text = await readSaved(path, 'utf8');
      return extension === 'html' ? pageFromHtml(url, text, 'saved browser HTML') : pageFromText(url, text);
    }
    return null;
  }

  async function fromNetwork(url, as) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: as === 'pdf' ? 'application/pdf,*/*' : 'text/html,application/xhtml+xml,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new ReadError(describeFailure(error));
    }
    if (!response.ok) {
      const refused = response.status === 401 || response.status === 403;
      throw new ReadError(`HTTP ${response.status}${refused ? ' (the site refuses plain requests; a browser-saved copy is needed)' : ''}`);
    }
    // Headers can arrive and the body still time out or drop: that is an unread page too.
    let bytes;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new ReadError(describeFailure(error));
    }
    if (as === 'pdf') {
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ReadError('the address did not return a PDF');
      return pageFromPdf(url, bytes);
    }
    return pageFromHtml(url, bytes.toString('utf8'));
  }

  return async function load(url, { as = 'html' } = {}) {
    const key = `${as}:${url}`;
    if (!cache.has(key)) {
      cache.set(key, (async () => (pagesDir && (await fromSaved(url, as))) || fromNetwork(url, as))());
    }
    return cache.get(key);
  };
}
