// The weekly market-figures job, tested on saved pages (CI has no network).
//
// What is checked:
// - every quote in the register is read correctly from the page it comes from, and
//   a page whose wording or layout has moved is never read through;
// - the plan: which quotes moved, which dates and versions follow, what is left
//   alone (an unread quote, a reviewed value, anything of Planeir's own);
// - the edit of `market_ie.js` reads back as planned, and only touches what moved;
// - the run end to end on a fake git and gh: dry run writes nothing, a pull request
//   is opened only when something moved, an earlier open one blocks, a failing
//   rules check stops it, and the PR body says what Gerry needs to know.

import assert from 'node:assert/strict';
import { readFileSync, utimesSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MARKET_FIGURES, MARKET_FIGURES_VERSION } from '../js/planning/figures/market_ie.js';
import { createPageLoader, decodeEntities, isoDate, pageFromHtml, pageFromText, savedPageName, ReadError } from './lib/market-refresh/pages.mjs';
import { QUOTE_SOURCES, findRow, parseRate, printedEffectiveDate, readQuote, sourceFor } from './lib/market-refresh/readers.mjs';
import {
  LARGE_MOVE, applyPlanToSource, bumpCatalogueVersion, bumpFigureVersion, decideOnPullRequest, planRefresh, summarisePlan, verifyEditedSource
} from './lib/market-refresh/plan.mjs';
import { CASH_RATE_GOLDENS, CASH_RATE_ID, registerWarningsAfter, renderReport, staleQuotes } from './lib/market-refresh/report.mjs';
import { BRANCH_PREFIX, GENERATED_FILES, GOLDEN_CHECKS, MARKET_FILE, readAll, refreshMarketFigures } from './lib/market-refresh/run.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURES = join(root, 'scripts/fixtures/market-pages');
const snapshot = await import(pathToFileURL(join(FIXTURES, 'market_ie.before.js')).href);
const snapshotText = readFileSync(join(FIXTURES, 'market_ie.before.js'), 'utf8');
const FIGURES = snapshot.MARKET_FIGURES;
const TODAY = '2026-10-27';

// What the saved pages say. These change only when the fixtures are saved again.
const EXPECTED = {
  'Bank of Ireland, Instant Access Demand (balances up to €5,000)': { value: 0.001, effective: '2026-10-22', url: 'https://personalbanking.bankofireland.com/app/uploads/Deposit-Interest-Rates-Table-22nd-October-2026-A.pdf' },
  'AIB, Personal Demand Deposit Account': { value: 0.0025, effective: '2025-05-13' },
  'Bank of Ireland, SuperSaver Standard Regular Saver (balances up to €29,999)': { value: 0.02, effective: '2026-10-22', url: 'https://personalbanking.bankofireland.com/app/uploads/Deposit-Interest-Rates-Table-22nd-October-2026-A.pdf' },
  'AIB, Online Regular Saver (up to €1,000 a month)': { value: 0.03, effective: '2025-05-13', quotedAs: 'AER, variable, before DIRT; 0.25% above the monthly limit' },
  'PTSB, 21 Day Notice Regular Saver (balances up to €75,000)': { value: 0.02, effective: null },
  'Bank of Ireland, 3 Year Fixed, first-time buyer, BER C': { value: 0.04, effective: '2025-11-26' },
  'AIB, 3 Year LTV Fixed, over 50% and up to 80%': { value: 0.036, effective: null },
  'PTSB, 3 Year Fixed Rate New Business, over 60% and up to 80%': { value: 0.0405, effective: '2026-10-22' }
};

const NETWORK = {
  'https://personalbanking.bankofireland.com/borrow/mortgages/mortgage-interest-rates/': 'network/boi-mortgage-interest-rates.html',
  'https://personalbanking.bankofireland.com/save-and-invest/savings/instant-access-and-notice-accounts/demand-deposit-account/features-and-benefits/': 'network/boi-demand-deposit-account-features-and-benefits.html',
  'https://personalbanking.bankofireland.com/app/uploads/Deposit-Interest-Rates-Table-22nd-October-2026-A.pdf': 'network/boi-deposit-interest-rates-table-22nd-october-2026.pdf'
};

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** The network as the fixtures saw it: BOI answers, AIB and PTSB refuse. `extra` overrides, and may be a status, an Error or a file. */
function fakeFetch(extra = {}, calls = []) {
  return async (url) => {
    calls.push(url);
    const entry = url in extra ? extra[url] : NETWORK[url];
    if (entry instanceof Error) throw entry;
    if (entry === undefined) return new Response('<HTML><TITLE>Access Denied</TITLE></HTML>', { status: 403 });
    if (typeof entry === 'number') return new Response('', { status: entry });
    if (entry && typeof entry === 'object') return new Response(entry.body, { status: 200 });
    return new Response(readFileSync(join(FIXTURES, entry)), { status: 200 });
  };
}

const loader = (options = {}) => createPageLoader({ fetchImpl: fakeFetch(), pagesDir: join(FIXTURES, 'browser'), maxSavedAgeHours: Infinity, ...options });

const sourceOf = (figure, observation) => sourceFor(figure.id, observation.sourceLabel);
const observationNamed = (label) => FIGURES.flatMap((figure) => figure.observations.map((observation) => ({ figure, observation }))).find((entry) => entry.observation.sourceLabel === label);

/** A read that agrees with the register, for plans that test bookkeeping rather than pages. */
function okRead(observation, patch = {}) {
  return { ok: true, value: observation.value, effective: observation.effective, url: observation.url, quotedAs: observation.quotedAs, printed: `${observation.value}`, pages: [{ url: observation.url, how: 'test', role: 'rates page' }], notes: [], ...patch };
}

/** Reads for every quote of `figures`: as they are, except where `patches` (by source label) says otherwise. `null` is a quote that could not be read. */
function readsWith(patches = {}, figures = FIGURES) {
  return figures.flatMap((figure) => figure.observations.map((observation) => {
    const patch = patches[observation.sourceLabel];
    const result = patch === null ? { ok: false, reason: 'HTTP 403', urls: [observation.url], pages: [] } : okRead(observation, patch);
    return { figureId: figure.id, sourceLabel: observation.sourceLabel, result };
  }));
}

const plan = (patches, options = {}) => planRefresh({ figures: FIGURES, catalogueVersion: snapshot.MARKET_FIGURES_VERSION, today: TODAY, reads: readsWith(patches), ...options });
const quoteOf = (planned, figureId, label) => planned.figures.find((figure) => figure.id === figureId).quotes.find((quote) => quote.sourceLabel === label);

/** A fake git, gh and npm. Replies are matched by the start of the command line. */
function fakeRun(replies = {}) {
  const calls = [];
  const defaults = {
    'gh pr list': { code: 0, stdout: '[]', stderr: '' },
    'git rev-parse --verify': { code: 1, stdout: '', stderr: '' },
    'git ls-remote': { code: 2, stdout: '', stderr: '' },
    'gh pr create': { code: 0, stdout: 'https://github.com/geraldboylan01/Call-Template/pull/999\n', stderr: '' }
  };
  const table = { ...replies, ...Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in replies))) };
  const run = (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    const match = Object.keys(table).find((key) => line === key || line.startsWith(`${key} `));
    const reply = match === undefined ? { code: 0, stdout: '', stderr: '' } : table[match];
    return typeof reply === 'function' ? reply(line) : reply;
  };
  return { run, calls };
}

function memoryFile(text = snapshotText) {
  const state = { text, writes: 0 };
  return { state, read: async () => state.text, write: async (next) => { state.text = next; state.writes += 1; } };
}

async function runRefresh({ options = {}, replies = {}, registerFigures = [], load, file = memoryFile(), data = snapshot } = {}) {
  const fake = fakeRun(replies);
  const fetched = [];
  const result = await refreshMarketFigures({
    options: { today: TODAY, ...options },
    figures: data.MARKET_FIGURES,
    catalogueVersion: data.MARKET_FIGURES_VERSION,
    registerFigures,
    load: load ?? loader({ fetchImpl: fakeFetch({}, fetched) }),
    marketFile: file,
    run: fake.run,
    log: () => {},
    tmp: mkdtempSync(join(tmpdir(), 'market-refresh-test-'))
  });
  return { result, calls: fake.calls, file, fetched };
}

// ---------------------------------------------------------------------------
// Reading pages
// ---------------------------------------------------------------------------

test('every quote in the register is read from its saved page, as printed, with the date the page prints', async () => {
  const reads = await readAll(FIGURES, loader());
  assert.equal(reads.length, Object.keys(EXPECTED).length);
  for (const { sourceLabel, result } of reads) {
    const expected = EXPECTED[sourceLabel];
    assert.ok(expected, `unexpected quote ${sourceLabel}`);
    assert.equal(result.ok, true, `${sourceLabel}: ${result.reason}`);
    assert.equal(result.value, expected.value, sourceLabel);
    assert.equal(result.effective, expected.effective, `${sourceLabel} effective`);
    if (expected.url) assert.equal(result.url, expected.url, `${sourceLabel} url`);
    if (expected.quotedAs) assert.equal(result.quotedAs, expected.quotedAs);
    assert.match(result.printed, /\d/, `${sourceLabel} keeps the printed row`);
  }
});

test('every quote in the register has exactly one reader, and every reader has a quote', () => {
  for (const figure of MARKET_FIGURES) {
    for (const observation of figure.observations) {
      const matches = QUOTE_SOURCES.filter((source) => source.figure === figure.id && source.sourceLabel === observation.sourceLabel);
      assert.equal(matches.length, 1, `${figure.id} / ${observation.sourceLabel} needs one entry in QUOTE_SOURCES`);
    }
  }
  for (const source of QUOTE_SOURCES) {
    const figure = MARKET_FIGURES.find((candidate) => candidate.id === source.figure);
    assert.ok(figure?.observations.some((observation) => observation.sourceLabel === source.sourceLabel), `${source.sourceLabel} has a reader but no quote`);
  }
});

test('the dated BOI rates PDF is found by following the link on the product page, and its new address is recorded', async () => {
  const { figure, observation } = observationNamed('Bank of Ireland, Instant Access Demand (balances up to €5,000)');
  assert.match(observation.url, /Deposits-Interest-Rate-Table-14th-September-2026-A\.pdf$/, 'the snapshot holds last month\'s PDF');
  const fetched = [];
  const result = await readQuote(observation, sourceOf(figure, observation), createPageLoader({ fetchImpl: fakeFetch({}, fetched), pagesDir: null }));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.url, EXPECTED[observation.sourceLabel].url);
  assert.deepEqual(result.pages.map((page) => page.role), ['rates page', 'linked PDF']);
  assert.ok(!fetched.includes(observation.url), 'the old PDF address was not needed');
});

test('when the product page cannot be read the other one is tried, then the PDF last used, and a 404 there leaves the quote unread', async () => {
  const { figure, observation } = observationNamed('Bank of Ireland, SuperSaver Standard Regular Saver (balances up to €29,999)');
  const source = sourceOf(figure, observation);
  const [first, second] = source.page.indexPages;
  const viaSecond = await readQuote(observation, source, createPageLoader({ fetchImpl: fakeFetch({ [first]: 500, [second]: 'network/boi-demand-deposit-account-features-and-benefits.html' }), pagesDir: null }));
  assert.equal(viaSecond.ok, true, viaSecond.reason);
  const stillCurrent = await readQuote({ ...observation, url: EXPECTED[observation.sourceLabel].url }, source, createPageLoader({ fetchImpl: fakeFetch({ [first]: 500, [second]: 500 }), pagesDir: null }));
  assert.equal(stillCurrent.ok, true, 'the PDF last used is read as it stands');
  const gone = await readQuote(observation, source, createPageLoader({ fetchImpl: fakeFetch({ [first]: 500, [second]: 500, [observation.url]: 404 }), pagesDir: null }));
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /HTTP 500/);
  assert.match(gone.reason, /HTTP 404/);
  assert.deepEqual(gone.urls, [first, second, observation.url]);
});

test('a link to a different PDF is not followed, and two dated PDFs are told apart by their dates', async () => {
  const { figure, observation } = observationNamed('Bank of Ireland, Instant Access Demand (balances up to €5,000)');
  const source = sourceOf(figure, observation);
  const page = (links) => ({ body: `<html><body>${links.map((href) => `<a href="${href}">x</a>`).join('')}</body></html>` });
  const base = 'https://personalbanking.bankofireland.com/app/uploads/';
  const index = source.page.indexPages[0];
  const none = await readQuote(observation, source, createPageLoader({ fetchImpl: fakeFetch({ [index]: page([`${base}SuperSaver-TCs-A.pdf`]), [source.page.indexPages[1]]: page([]), [observation.url]: 404 }), pagesDir: null }));
  assert.equal(none.ok, false);
  assert.match(none.reason, /no link to the rates PDF/);
  const twoDated = await readQuote(observation, source, createPageLoader({ fetchImpl: fakeFetch({ [index]: page([`${base}Deposit-Interest-Rates-Table-15th-September-2026-A.pdf`, `${base}Deposit-Interest-Rates-Table-22nd-October-2026-A.pdf`]) }), pagesDir: null }));
  assert.equal(twoDated.ok, true, twoDated.reason);
  assert.match(twoDated.url, /22nd-October-2026/);
  const undated = await readQuote(observation, source, createPageLoader({ fetchImpl: fakeFetch({ [index]: page([`${base}Deposit-Interest-Rates-Table-A.pdf`, `${base}Deposit-Interest-Rates-Table-B.pdf`]), [source.page.indexPages[1]]: 500, [observation.url]: 404 }), pagesDir: null }));
  assert.equal(undated.ok, false);
  assert.match(undated.reason, /cannot be told apart by date/);
});

test('a site that refuses plain requests is reported, and its saved copy is used when there is one', async () => {
  const { figure, observation } = observationNamed('AIB, Personal Demand Deposit Account');
  const source = sourceOf(figure, observation);
  const refused = await readQuote(observation, source, createPageLoader({ fetchImpl: fakeFetch(), pagesDir: null }));
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /HTTP 403.*browser-saved copy/);
  assert.deepEqual(refused.urls, [observation.url]);
  const saved = await readQuote(observation, source, loader());
  assert.equal(saved.ok, true);
  assert.equal(saved.pages[0].how, 'saved browser text');
});

test('a saved page older than the limit is refused, so last week\'s rate is never stamped with today\'s date', async () => {
  const { figure, observation } = observationNamed('PTSB, 21 Day Notice Regular Saver (balances up to €75,000)');
  const source = sourceOf(figure, observation);
  const directory = mkdtempSync(join(tmpdir(), 'saved-pages-'));
  try {
    const file = join(directory, `${savedPageName(observation.url)}.txt`);
    writeFileSync(file, readFileSync(join(FIXTURES, 'browser', `${savedPageName(observation.url)}.txt`)));
    const fresh = await readQuote(observation, source, createPageLoader({ fetchImpl: fakeFetch(), pagesDir: directory }));
    assert.equal(fresh.ok, true, fresh.reason);
    const threeDaysAgo = new Date(Date.now() - 72 * 3_600_000);
    utimesSync(file, threeDaysAgo, threeDaysAgo);
    const old = await readQuote(observation, source, createPageLoader({ fetchImpl: fakeFetch(), pagesDir: directory }));
    assert.equal(old.ok, false);
    assert.match(old.reason, /72 hours old; save the page again/);
    const lenient = await readQuote(observation, source, createPageLoader({ fetchImpl: fakeFetch(), pagesDir: directory, maxSavedAgeHours: 100 }));
    assert.equal(lenient.ok, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('network failures and the wrong kind of answer are reported in plain words', async () => {
  const { figure, observation } = observationNamed('Bank of Ireland, 3 Year Fixed, first-time buyer, BER C');
  const source = sourceOf(figure, observation);
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const dns = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  assert.match((await readQuote(observation, source, createPageLoader({ fetchImpl: fakeFetch({ [observation.url]: timeout }), pagesDir: null }))).reason, /timed out/);
  assert.match((await readQuote(observation, source, createPageLoader({ fetchImpl: fakeFetch({ [observation.url]: dns }), pagesDir: null }))).reason, /ENOTFOUND/);
  const { figure: cashFigure, observation: pdfObservation } = observationNamed('Bank of Ireland, Instant Access Demand (balances up to €5,000)');
  const notPdf = await readQuote(pdfObservation, sourceOf(cashFigure, pdfObservation), createPageLoader({
    fetchImpl: fakeFetch({ 'https://personalbanking.bankofireland.com/app/uploads/Deposit-Interest-Rates-Table-22nd-October-2026-A.pdf': { body: '<html>not a pdf</html>' } }),
    pagesDir: null
  }));
  assert.equal(notPdf.ok, false);
  assert.match(notPdf.reason, /did not return a PDF/);
});

test('a page whose wording or layout has moved is never read through', async () => {
  const text = (label) => readFileSync(join(FIXTURES, 'browser', `${savedPageName(observationNamed(label).observation.url)}.txt`), 'utf8');
  const readWith = async (label, edit) => {
    const { figure, observation } = observationNamed(label);
    return readQuote(observation, sourceOf(figure, observation), async () => pageFromText(observation.url, edit(text(label))));
  };
  const ptsb = 'PTSB, 21 Day Notice Regular Saver (balances up to €75,000)';
  assert.match((await readWith(ptsb, (page) => page.replace('AER (variable) interest rate', 'Total rate'))).reason, /column headings/);
  assert.match((await readWith(ptsb, (page) => page.replace('€0.00 - €75,000.00', '€0.00 - €50,000.00'))).reason, /is not on the page/);
  assert.match((await readWith(ptsb, (page) => page.replace('2.00% Variable\t2.00% Variable\t2.00% Variable', '2.00% Variable\t2.00% Variable\tcall us'))).reason, /where a rate was expected/);
  const aib = 'AIB, Personal Demand Deposit Account';
  assert.match((await readWith(aib, (page) => page.replace(/(Personal Demand Deposit Account\s+€0\s+No Maximum\s+0\.25%\s+)0\.25%/, '$10.20%'))).reason, /columns that should agree/);
  const mortgage = 'PTSB, 3 Year Fixed Rate New Business, over 60% and up to 80%';
  const reworded = await readWith(mortgage, (page) => page.replace('3 Year Fixed Rate New Business - greater than 60% and less than or equal to 80% LTV', '3 Year Fixed Rate - greater than 60% and less than or equal to 80% LTV'));
  assert.match(reworded.reason, /is not on the page/);
});

test('the Green and High Value rows that look like the ones read are never mistaken for them', async () => {
  const reads = await readAll(FIGURES, loader());
  const ptsb = reads.find((entry) => entry.sourceLabel.startsWith('PTSB, 3 Year Fixed Rate')).result;
  assert.equal(ptsb.value, 0.0405, 'not 3.85% (Green), 3.80% (High Value) or 4.25% (over 80%)');
  assert.match(ptsb.printed, /^3 Year Fixed Rate New Business - greater than 60% and less than or equal to 80% LTV \| 4\.05%$/);
  const aib = reads.find((entry) => entry.sourceLabel.startsWith('AIB, 3 Year LTV')).result;
  assert.equal(aib.value, 0.036, 'not the GreenA 3 Yr row at 3.10%');
});

test('findRow insists on the heading, the headers, the row shape and one answer', () => {
  const cells = ['Name', 'Notice', 'Min', 'Max', 'AER Variable', 'Standard Demand', 'Instant Access', 'N/a', '€1', 'No limit', '0.10%', '0.10%', 'Other', 'x'];
  const spec = { within: 'Standard Demand', header: ['Name', 'Notice', 'Min', 'Max', 'AER Variable'], label: 'Instant Access', valueAt: 5, lastColumn: true };
  assert.equal(findRow(cells, spec).value, 0.001);
  assert.throws(() => findRow(cells, { ...spec, within: 'Premium Demand' }), /not under the heading/);
  assert.throws(() => findRow(cells, { ...spec, header: ['Name', 'Notice', 'Min', 'Max', 'Gross'] }), /column headings/);
  assert.throws(() => findRow([...cells.slice(0, 11), '0.10%', '0.12%'], spec), /another rate column/);
  assert.throws(() => findRow(cells, { ...spec, valueAt: 4 }).value === 0.001 && assert.fail('read the wrong column'), /another rate column/);
  const twice = [...cells, 'Instant Access', 'N/a', '€1', 'No limit', '0.20%', '0.20%'];
  assert.throws(() => findRow(twice, { ...spec, within: undefined, header: undefined }), /more than once with different rates/);
  const sameTwice = [...cells, 'Instant Access', 'N/a', '€1', 'No limit', '0.10%', '0.10%'];
  assert.equal(findRow(sameTwice, { ...spec, within: undefined, header: undefined }).value, 0.001, 'the same row twice is one answer');
});

test('parseRate reads a printed rate exactly and nothing else', () => {
  assert.equal(parseRate('3.60%'), 0.036);
  assert.equal(parseRate('0.10%'), 0.001);
  assert.equal(parseRate('4.05%'), 0.0405);
  assert.equal(parseRate('2.00% Variable'), 0.02);
  assert.equal(parseRate('4'), null, 'a bare number is not a rate unless the column is known to be one');
  assert.equal(parseRate('4', { percentOptional: true }), 0.04);
  assert.equal(parseRate('4.2', { percentOptional: true }), 0.042);
  for (const text of ['€1', 'No limit', 'N/a', '--', '', '3.6 to 4.1%', '3,60%', undefined]) assert.equal(parseRate(text), null, String(text));
});

test('the date a page prints is read as printed, in any of its wordings, and a date that does not exist is not one', () => {
  const effective = /effective from (?:the start of business )?(?:on )?(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+) (\d{4})/i;
  assert.equal(printedEffectiveDate('These rates are effective from the start of business on 22nd October 2026.', effective), '2026-10-22');
  assert.equal(printedEffectiveDate('effective from 1 January 2027', effective), '2027-01-01');
  assert.equal(printedEffectiveDate('effective from 31 February 2027', effective), null);
  assert.equal(printedEffectiveDate('effective from 5 Octobre 2026', effective), null);
  assert.equal(printedEffectiveDate('no date here', effective), null);
  assert.equal(printedEffectiveDate('anything', null), null);
  assert.equal(isoDate('29', 'February', '2028'), '2028-02-29');
  assert.equal(isoDate('29', 'February', '2027'), null);
});

test('HTML becomes cells: scripts and styles are gone, entities are decoded, spaces are tidy', () => {
  const page = pageFromHtml('https://example.ie/', '<html><head><style>.a{}</style><script>var rate = "9.99%";</script></head><body><table><tr><td>3 Year&nbsp;LTV Fixed &gt;50%&lt;=80%</td><td><span>3.60</span>%</td></tr></table><!-- 8.88% --></body></html>');
  assert.deepEqual(page.cells, ['3 Year LTV Fixed >50%<=80%', '3.60', '%']);
  assert.ok(!page.text.includes('9.99') && !page.text.includes('8.88'));
  assert.equal(decodeEntities('&euro;5,000 &#8364;5 &#x20AC;5 &amp;amp; &unknown;'), '€5,000 €5 €5 &amp; &unknown;');
  assert.deepEqual(pageFromText('https://example.ie/', 'Rate type\tInterest Rates\n\n 3 Year \t3.60%\t\n').cells, ['Rate type', 'Interest Rates', '3 Year', '3.60%']);
  assert.equal(savedPageName('https://www.ptsb.ie/mortgages/mortgage-interest-rates/?x=1#top'), 'www.ptsb.ie--mortgages-mortgage-interest-rates');
  assert.equal(savedPageName('https://aib.ie/'), 'aib.ie--index');
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

test('when nothing has moved only the check dates change: no new version, no change date, and no PR', () => {
  const planned = plan({});
  const summary = summarisePlan(planned);
  assert.equal(summary.quotesMoved, 0);
  assert.equal(summary.valuesChanged, 0);
  assert.equal(planned.catalogueVersion.after, snapshot.MARKET_FIGURES_VERSION);
  for (const figure of planned.figures) {
    assert.equal(figure.checkedOn.after, TODAY);
    assert.equal(figure.changedOn.after, figure.changedOn.before);
    assert.equal(figure.version.after, figure.version.before);
    assert.ok(figure.quotes.every((quote) => quote.after.retrievedOn === TODAY));
  }
  assert.equal(decideOnPullRequest(planned).openPullRequest, false);
});

test('a PR is still opened to record the check once the last one is 21 days old, so the register does not warn that the job stopped', () => {
  const planned = plan({});
  assert.equal(decideOnPullRequest(planned, { freshnessDays: 5 }).openPullRequest, true);
  assert.match(decideOnPullRequest(planned, { freshnessDays: 5 }).reasons[0], /recorded check is 5 days old or more for 3 figures/);
  assert.equal(decideOnPullRequest(planned, { freshnessDays: 6 }).openPullRequest, false, 'the snapshot was checked 5 days before TODAY');
  assert.equal(decideOnPullRequest(plan({ ...Object.fromEntries(FIGURES.flatMap((figure) => figure.observations.map((observation) => [observation.sourceLabel, null]))) }), { freshnessDays: 1 }).openPullRequest, false, 'nothing read means nothing to record');
});

test('a changed rate that changes the worked-out value sets changedOn, bumps the figure and the catalogue, and is applied as printed', () => {
  const label = 'AIB, Personal Demand Deposit Account';
  const planned = plan({ [label]: { value: 0.0045, effective: '2026-10-26' } });
  const figure = planned.figures.find((entry) => entry.id === CASH_RATE_ID);
  assert.equal(figure.valueBefore, 0.002);
  assert.equal(figure.valueAfter, 0.003, 'mean of 0.1% and 0.45% is 0.275%, rounded to 0.3%');
  assert.equal(figure.valueChanged, true);
  assert.deepEqual(figure.changedOn, { before: '2026-10-13', after: TODAY });
  assert.deepEqual(figure.version, { before: '1.0.0', after: '1.1.0' });
  assert.deepEqual(planned.catalogueVersion, { before: 'ie-market-2026.1', after: 'ie-market-2026.2' });
  const quote = quoteOf(planned, CASH_RATE_ID, label);
  assert.deepEqual(quote.changedFields, ['value', 'effective']);
  assert.equal(quote.after.value, 0.0045);
  assert.equal(planned.figures.filter((entry) => entry.valueChanged).length, 1, 'the other figures are untouched');
  assert.equal(decideOnPullRequest(planned).openPullRequest, true);
});

test('a quote can move without the figure moving: rounding absorbs it, so the quote is recorded and no version changes', () => {
  const planned = plan({ 'AIB, Personal Demand Deposit Account': { value: 0.0026 } });
  const figure = planned.figures.find((entry) => entry.id === CASH_RATE_ID);
  assert.equal(figure.valueAfter, 0.002, '(0.1% + 0.26%) / 2 = 0.18%, rounds to 0.2%');
  assert.equal(figure.valueChanged, false);
  assert.equal(figure.version.after, '1.0.0');
  assert.equal(figure.changedOn.after, '2026-10-13');
  assert.equal(planned.catalogueVersion.after, planned.catalogueVersion.before);
  assert.equal(summarisePlan(planned).quotesMoved, 1);
  assert.equal(decideOnPullRequest(planned).openPullRequest, true);
});

test('a reviewed figure keeps the value a person chose: the quotes move, the evidence is reported, nothing is bumped', () => {
  const id = 'ie.market.mortgage.illustration_rate';
  const planned = plan({ 'PTSB, 3 Year Fixed Rate New Business, over 60% and up to 80%': { value: 0.0405, effective: '2026-10-22' } });
  const figure = planned.figures.find((entry) => entry.id === id);
  assert.equal(figure.methodKind, 'reviewed');
  assert.equal(figure.valueBefore, 0.035);
  assert.equal(figure.valueAfter, 0.035);
  assert.equal(figure.valueChanged, false);
  assert.equal(figure.afterFigure.method.value, 0.035);
  assert.deepEqual(figure.version, { before: '1.0.0', after: '1.0.0' });
  assert.equal(figure.reviewed.evidenceBefore.median, 0.0375);
  assert.equal(figure.reviewed.evidenceAfter.median, 0.04);
  assert.equal(figure.reviewed.evidenceAfter.drifted, true);
  const text = applyPlanToSource(snapshotText, planned);
  assert.ok(text.includes("kind: 'reviewed',\n      value: 0.035,\n      reviewedOn: '2026-07-11',"), 'the chosen value, and when it was chosen, are as they were');
});

test('a quote that could not be read is left exactly as it was, and says so; a figure with nothing read is not marked checked', () => {
  const label = 'AIB, Online Regular Saver (up to €1,000 a month)';
  const partly = plan({ [label]: null });
  const saver = partly.figures.find((entry) => entry.id === 'ie.market.cash.regular_saver_gross_rate');
  const unread = quoteOf(partly, saver.id, label);
  assert.equal(unread.status, 'unread');
  assert.deepEqual(unread.after, unread.before);
  assert.equal(unread.after.retrievedOn, '2026-10-22');
  assert.equal(saver.checkedOn.after, TODAY, 'the other two quotes were read');
  const none = plan(Object.fromEntries(FIGURES.find((figure) => figure.id === saver.id).observations.map((observation) => [observation.sourceLabel, null])));
  assert.equal(none.figures.find((entry) => entry.id === saver.id).checkedOn.after, '2026-10-22');
  assert.equal(none.figures.find((entry) => entry.id === CASH_RATE_ID).checkedOn.after, TODAY, 'other figures are not held back');
});

test('a move of a point or more is applied as printed and called out, in case it is a misread', () => {
  const planned = plan({ 'PTSB, 3 Year Fixed Rate New Business, over 60% and up to 80%': { value: 0.0275 } });
  const quote = quoteOf(planned, 'ie.market.mortgage.illustration_rate', 'PTSB, 3 Year Fixed Rate New Business, over 60% and up to 80%');
  assert.equal(quote.largeMove, true);
  assert.equal(LARGE_MOVE, 0.01);
  assert.equal(quoteOf(plan({ 'PTSB, 3 Year Fixed Rate New Business, over 60% and up to 80%': { value: 0.0474 } }), 'ie.market.mortgage.illustration_rate', 'PTSB, 3 Year Fixed Rate New Business, over 60% and up to 80%').largeMove, false);
  const report = renderReport({ plan: planned, decision: decideOnPullRequest(planned), registerFigures: [] });
  assert.match(report, /Large move, check it by eye:\*\* PTSB, 3 Year Fixed Rate New Business[^\n]*3\.75% to 2\.75%/);
});

test('versions go up the way the register expects, and the catalogue starts again each year', () => {
  assert.equal(bumpFigureVersion('1.0.0'), '1.1.0');
  assert.equal(bumpFigureVersion('1.9.3'), '1.10.0');
  assert.throws(() => bumpFigureVersion('v2'), /not major\.minor\.patch/);
  assert.equal(bumpCatalogueVersion('ie-market-2026.1', '2026-11-03'), 'ie-market-2026.2');
  assert.equal(bumpCatalogueVersion('ie-market-2026.9', '2026-12-29'), 'ie-market-2026.10');
  assert.equal(bumpCatalogueVersion('ie-market-2026.4', '2027-01-05'), 'ie-market-2027.1');
  assert.throws(() => bumpCatalogueVersion('market-1', TODAY), /not ie-market-YYYY\.N/);
});

// ---------------------------------------------------------------------------
// Writing the data file
// ---------------------------------------------------------------------------

test('the edit changes only what moved, keeps every comment, and reads back exactly as planned', async () => {
  const planned = plan({
    'AIB, Personal Demand Deposit Account': { value: 0.0045, effective: '2026-10-26' },
    'PTSB, 3 Year Fixed Rate New Business, over 60% and up to 80%': { value: 0.0405, effective: '2026-10-22' },
    'AIB, Online Regular Saver (up to €1,000 a month)': null
  });
  const edited = applyPlanToSource(snapshotText, planned);
  await verifyEditedSource(edited, planned);
  const before = snapshotText.split('\n');
  const after = edited.split('\n');
  assert.equal(after.length, before.length, 'no line added or removed');
  const changed = before.map((line, index) => [line, after[index]]).filter(([left, right]) => left !== right);
  const comments = (text) => text.split('\n').filter((line) => /^\s*(\/\*\*|\*|\/\/)/.test(line));
  assert.deepEqual(comments(edited), comments(snapshotText));
  assert.ok(changed.some(([, line]) => line.includes("MARKET_FIGURES_VERSION = 'ie-market-2026.2'")));
  assert.ok(changed.some(([, line]) => line.includes('value: 0.0045,')));
  assert.ok(changed.some(([, line]) => line.includes('value: 0.0405,')));
  const touched = new Set(changed.map(([line]) => line.trim().split(':')[0].replace(/^export const /, '')));
  assert.deepEqual([...touched].sort(), ['MARKET_FIGURES_VERSION = \'ie-market-2026.1\';', 'changedOn', 'checkedOn', 'effective', 'retrievedOn', 'value', 'version'].sort(), 'no other field is touched');
  const written = await import(`data:text/javascript;base64,${Buffer.from(edited).toString('base64')}`);
  const unread = written.MARKET_FIGURES[1].observations.find((observation) => observation.sourceLabel.startsWith('AIB, Online'));
  assert.equal(unread.retrievedOn, '2026-10-22', 'the unread quote still says when it was last read');
  assert.equal(written.MARKET_FIGURES[2].method.value, 0.035);
});

test('a plan that changes nothing leaves the file byte for byte as it was', async () => {
  const planned = plan({}, { today: '2026-10-22' });
  assert.equal(applyPlanToSource(snapshotText, planned), snapshotText);
});

test('the edit copes with quotes and backslashes in text, and refuses a file that is not laid out as expected', async () => {
  const label = "Bank's \"best\" rate";
  const source = `export const MARKET_FIGURES_VERSION = 'ie-market-2026.1';\nexport const MARKET_FIGURES = [\n  Object.freeze({\n    id: 'ie.market.x.y',\n    observations: Object.freeze([\n      Object.freeze({\n        sourceLabel: 'Bank\\'s "best" rate',\n        url: 'https://example.ie/a',\n        value: 0.01,\n        quotedAs: 'AER, variable',\n        effective: null,\n        retrievedOn: '2026-10-22'\n      })\n    ]),\n    checkedOn: '2026-10-22',\n    changedOn: '2026-10-01',\n    version: '1.0.0'\n  })\n];\n`;
  const figure = { id: 'ie.market.x.y', label: 'x', unit: 'rate_a_year', method: { kind: 'single', roundTo: 0.001 }, observations: [{ sourceLabel: label, url: 'https://example.ie/a', value: 0.01, quotedAs: 'AER, variable', effective: null, retrievedOn: '2026-10-22' }], checkedOn: '2026-10-22', changedOn: '2026-10-01', reviewEveryDays: 35, usedBy: ['house_purchase'], version: '1.0.0' };
  const planned = planRefresh({
    figures: [figure], catalogueVersion: 'ie-market-2026.1', today: TODAY,
    reads: [{ figureId: figure.id, sourceLabel: label, result: { ok: true, value: 0.0125, effective: '2026-10-25', url: 'https://example.ie/b?x=1&y=\\2', quotedAs: "AER, variable; it's 0.25% above", printed: 'x', pages: [], notes: [] } }]
  });
  const edited = applyPlanToSource(source, planned);
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(edited).toString('base64')}`);
  assert.equal(loaded.MARKET_FIGURES[0].observations[0].quotedAs, "AER, variable; it's 0.25% above");
  assert.equal(loaded.MARKET_FIGURES[0].observations[0].url, 'https://example.ie/b?x=1&y=\\2');
  assert.throws(() => applyPlanToSource(source.replace("id: 'ie.market.x.y',", "id: 'ie.market.other',"), planned), /no figure ie\.market\.x\.y/);
  assert.throws(() => applyPlanToSource(source.replace('        value: 0.01,\n', ''), planned), /could not find "value"/);
  assert.throws(() => applyPlanToSource(source.replace('    ]),\n', '    ]);\n'), planned), /no closing of its observations/);
  assert.throws(() => applyPlanToSource(source.replace('  })\n];', "  }),\n  Object.freeze({\n    id: 'ie.market.x.y',\n  })\n];"), planned), /more than once/);
});

test('an edit that does not say what the plan meant is caught before anything is written', async () => {
  const planned = plan({ 'AIB, Personal Demand Deposit Account': { value: 0.0045 } });
  const edited = applyPlanToSource(snapshotText, planned);
  await assert.rejects(() => verifyEditedSource(edited.replace('value: 0.0045,', 'value: 0.0046,'), planned), /does not read back as planned/);
  await assert.rejects(() => verifyEditedSource(edited.replace("version: '1.1.0'", "version: '1.0.0'"), planned), /does not read back as planned/);
  await assert.rejects(() => verifyEditedSource(`${edited}\nthis is not javascript(`, planned), /does not load/);
});

test('the real register data is laid out the way the editor needs, and every quote in it can be rewritten', async () => {
  const live = readFileSync(join(root, MARKET_FILE), 'utf8');
  const planned = planRefresh({ figures: MARKET_FIGURES, catalogueVersion: MARKET_FIGURES_VERSION, today: '2099-01-01', reads: readsWith({}, MARKET_FIGURES) });
  const edited = applyPlanToSource(live, planned);
  await verifyEditedSource(edited, planned);
  assert.notEqual(edited, live, 'the dates moved');
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const REGISTER = [
  { id: 'ie.income_tax.2027.standard_rate', kind: 'announced_law', checkedOn: '2026-07-01' },
  { id: 'ie.usc.2027.exemption_threshold', kind: 'announced_law', checkedOn: '2026-10-20' },
  { id: 'ie.market.cash.instant_access_gross_rate', kind: 'market', checkedOn: '2026-10-22', reviewEveryDays: 35, valueShown: '0.2% a year' },
  { id: 'ie.market.cash.regular_saver_gross_rate', kind: 'market', checkedOn: '2026-10-22', reviewEveryDays: 35, valueShown: '2% a year' },
  { id: 'ie.market.mortgage.illustration_rate', kind: 'market', checkedOn: '2026-10-22', reviewEveryDays: 35, valueShown: '3.5% a year' }
];

test('the report lists each figure\'s old and new value, every quote as printed, the pages read and the pages not read', async () => {
  const reads = await readAll(FIGURES, loader({ fetchImpl: fakeFetch(), pagesDir: null }));
  const planned = planRefresh({ figures: FIGURES, catalogueVersion: snapshot.MARKET_FIGURES_VERSION, today: TODAY, reads });
  const report = renderReport({ plan: planned, decision: decideOnPullRequest(planned), registerFigures: REGISTER, pagesDir: '/tmp/pages' });
  assert.match(report, /Quotes read 3 of 8\. 5 could not be read and were left as they were/);
  assert.match(report, /\| Interest on money kept in an instant-access cash account, before DIRT<br>`ie\.market\.cash\.instant_access_gross_rate` \| 0\.2% a year \| 0\.2% a year \(unchanged\) \| 1\.0\.0 \|/);
  assert.match(report, /Instant Access Demand\/Demand Deposit \\\| N\/a \\\| €1 \\\| No limit \\\| 0\.10% \\\| 0\.10%/);
  assert.match(report, /### Could not be read \(left as they were\)[\s\S]*AIB, Personal Demand Deposit Account\*\* \(ie\.market\.cash\.instant_access_gross_rate\): HTTP 403/);
  assert.match(report, /save its visible text into `\/tmp\/pages`[\s\S]*aib\.ie--our-products-savings-and-deposits-Deposit-Rates\.txt/);
  assert.match(report, /### Pages read[\s\S]*Deposit-Interest-Rates-Table-22nd-October-2026-A\.pdf \(linked PDF, network PDF\)/);
  assert.ok(!/aib\.ie.*\(rates page/.test(report.split('### Pages read')[1]), 'a page that was not read is not listed as read');
});

test('a move of the cash rate says which golden checks pin it and that the job does not edit them', () => {
  const planned = plan({ 'AIB, Personal Demand Deposit Account': { value: 0.0045 } });
  const report = renderReport({ plan: planned, decision: decideOnPullRequest(planned), registerFigures: REGISTER });
  assert.match(report, /The central cash rate moves from 0\.2% a year to 0\.3% a year/);
  for (const file of CASH_RATE_GOLDENS) assert.ok(report.includes(`\`${file}\``), file);
  assert.match(report, /will fail on this branch until a person reviews them/);
  assert.match(report, /does not edit them/);
  assert.deepEqual([...CASH_RATE_GOLDENS], ['scripts/check-future-cost-fund.mjs', 'scripts/check-goals-and-resources.mjs', 'js/tests_future_cost_fund_math.js']);
  const quiet = renderReport({ plan: plan({}), decision: decideOnPullRequest(plan({})), registerFigures: REGISTER });
  assert.ok(!quiet.includes('central cash rate moves'));
});

test('the report says where a reviewed figure\'s evidence now points, and that moving the held value is a decision', () => {
  const planned = plan({ 'PTSB, 3 Year Fixed Rate New Business, over 60% and up to 80%': { value: 0.0405 } });
  const report = renderReport({ plan: planned, decision: decideOnPullRequest(planned), registerFigures: REGISTER });
  assert.match(report, /held at 3\.5% a year by a person and the job does not change it\. The quotes now point to 4% \(was 3\.75%\), 0\.50 percentage points above the held value\. That is past the 0\.20 percentage points warning point/);
  assert.match(report, /Moving the held value is a decision/);
});

test('the report names market figures past their review interval, quotes the job keeps failing to read, and announced law unchecked for 90 days', () => {
  const unread = Object.fromEntries(FIGURES.flatMap((figure) => figure.observations.map((observation) => [observation.sourceLabel, null])));
  const planned = plan(unread, { today: '2026-12-10' });
  assert.equal(staleQuotes(planned).length, 8);
  const warnings = registerWarningsAfter(planned, REGISTER);
  assert.equal(warnings.filter((warning) => warning.startsWith('ie.market.') && /last checked/.test(warning)).length, 3);
  assert.ok(warnings.some((warning) => warning.startsWith('ie.income_tax.2027.standard_rate is still announced')));
  assert.ok(!warnings.some((warning) => warning.startsWith('ie.usc.2027')), 'checked 51 days earlier: not yet');
  const github = renderReport({ plan: planned, decision: decideOnPullRequest(planned), registerFigures: REGISTER, format: 'github' });
  assert.match(github, /\*\*Overdue:\*\* ie\.market\.cash\.instant_access_gross_rate was last checked 49 days ago; it is reviewed every 35/);
  assert.match(github, /\*\*Stale quote:\*\* AIB, Personal Demand Deposit Account was last read 49 days ago/);
  assert.match(github, /Announced law not checked for 90 days or more \(1\)[\s\S]*<details>[\s\S]*ie\.income_tax\.2027\.standard_rate \(162 days\)/);
  assert.ok(!renderReport({ plan: planned, decision: decideOnPullRequest(planned), registerFigures: REGISTER, format: 'terminal' }).includes('<details>'));
  const fresh = registerWarningsAfter(plan({}), REGISTER.filter((figure) => figure.kind === 'market'));
  assert.deepEqual(fresh.filter((warning) => /last checked/.test(warning)), [], 'a figure read today is not overdue');
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

test('a dry run reads, reports and verifies the edit, but writes nothing and runs no command', async () => {
  const { result, calls, file } = await runRefresh({});
  assert.equal(result.wrote, false);
  assert.equal(file.state.writes, 0);
  assert.deepEqual(calls, []);
  assert.match(result.report, /This is a dry run\. Nothing has been written\./);
  assert.equal(result.plan.figures.flatMap((figure) => figure.quotes).filter((quote) => quote.status === 'unread').length, 0, 'the saved pages were all readable');
  assert.equal(summarisePlan(result.plan).quotesMoved, 4);
  assert.equal(result.changesFile, true);
});

test('--apply writes only the data file, rebuilds the register and runs the rules check, and no golden unless a value moved', async () => {
  const { result, calls, file } = await runRefresh({ options: { apply: true } });
  assert.equal(result.wrote, true);
  assert.equal(file.state.writes, 1);
  assert.deepEqual(calls, ['npm run --silent build:figures', 'npm run --silent check:figures']);
  assert.match(result.report, /### Checks run on this branch\n\n- `npm run check:figures`: passed/);
  assert.equal(result.pullRequestUrl, null);
  assert.ok(calls.every((call) => !call.startsWith('git ')), 'no branch, commit or push');
});

test('--apply that moves a value runs the golden checks, reports which fail, and does not fail the run', async () => {
  const { result, calls } = await runRefresh({
    options: { apply: true },
    load: async (url, options) => {
      const page = await loader()(url, options);
      return url === 'https://aib.ie/our-products/savings-and-deposits/Deposit-Rates'
        ? pageFromText(url, page.cells.map((cell, index) => (page.cells[index - 3] === 'Personal Demand Deposit Account' || page.cells[index - 4] === 'Personal Demand Deposit Account' ? '0.45%' : cell)).join('\n'))
        : page;
    },
    replies: { 'npm run --silent check:future-cost-fund': { code: 1, stdout: 'AssertionError: 0.003 !== 0.002', stderr: '' } }
  });
  assert.equal(result.plan.figures.find((figure) => figure.id === CASH_RATE_ID).valueAfter, 0.003);
  assert.deepEqual(calls.filter((call) => call.startsWith('npm run --silent check')), ['check:figures', ...GOLDEN_CHECKS].map((script) => `npm run --silent ${script}`));
  assert.match(result.report, /`npm run check:future-cost-fund`: \*\*failed\*\*[\s\S]*AssertionError: 0\.003 !== 0\.002/);
  assert.match(result.report, /`npm run check:goals-and-resources`: passed/);
});

test('--open-pr with nothing moved changes nothing and opens nothing', async () => {
  // Refresh once, then again the next day: the register already says what the pages say.
  const first = await runRefresh({ options: { apply: true } });
  const updated = await import(`data:text/javascript;base64,${Buffer.from(first.file.state.text).toString('base64')}`);
  const { result, calls } = await runRefresh({ options: { openPr: true, today: '2026-10-28' }, file: memoryFile(first.file.state.text), data: updated });
  assert.equal(summarisePlan(result.plan).quotesMoved, 0, result.report);
  assert.equal(result.decision.openPullRequest, false);
  assert.equal(result.wrote, false);
  assert.equal(result.pullRequestUrl, null);
  assert.match(result.report, /Nothing was written: no pull request is warranted yet\./);
  assert.match(result.report, /Nothing moved, so no pull request is warranted\./);
  assert.ok(!calls.some((call) => /^(git (switch|add|commit|push)|gh pr create|npm)/.test(call)), calls.join('\n'));
});

test('--open-pr when something moved: branch from a clean checkout, write, check, commit the data and the generated files only, push, open the PR with the report as its body', async () => {
  const { result, calls } = await runRefresh({ options: { openPr: true } });
  assert.equal(result.pullRequestUrl, 'https://github.com/geraldboylan01/Call-Template/pull/999');
  assert.equal(result.branch, `${BRANCH_PREFIX}${TODAY}`);
  const order = [
    'git status --porcelain',
    'git fetch origin main',
    'git merge-base --is-ancestor origin/main HEAD',
    'gh pr list --state open',
    `git rev-parse --verify --quiet refs/heads/${BRANCH_PREFIX}${TODAY}`,
    `git ls-remote --exit-code --heads origin ${BRANCH_PREFIX}${TODAY}`,
    'npm run --silent build:figures',
    'npm run --silent check:figures',
    `git switch -c ${BRANCH_PREFIX}${TODAY}`,
    `git add ${MARKET_FILE} ${GENERATED_FILES.join(' ')}`,
    'git commit -m Refresh market figures (2026-10-27): 4 quotes moved',
    `git push -u origin ${BRANCH_PREFIX}${TODAY}`,
    'gh pr create --base main'
  ];
  let position = -1;
  for (const expected of order) {
    const found = calls.findIndex((call, index) => index > position && call.startsWith(expected));
    assert.ok(found > position, `${expected} did not happen in order:\n${calls.join('\n')}`);
    position = found;
  }
  const create = calls.find((call) => call.startsWith('gh pr create'));
  assert.match(create, /--head figures\/market-refresh-2026-10-27 --title Refresh market figures \(2026-10-27\): 4 quotes moved --body-file /);
  assert.ok(!calls.some((call) => /merge( |$)/.test(call) && call.startsWith('gh pr')), 'the PR is never merged');
  assert.ok(!calls.some((call) => /--force|-f /.test(call)), 'nothing is force-pushed');
  assert.match(result.report, /Opened by the weekly market-figures job/);
  assert.match(result.report, /Merge it to accept the quotes, or close it/);
});

test('an earlier refresh PR still open blocks the next one, before any page is read', async () => {
  const fetched = [];
  const { result, calls } = await runRefresh({
    options: { openPr: true },
    replies: { 'gh pr list': { code: 0, stdout: JSON.stringify([{ number: 7, headRefName: 'figures/market-refresh-2026-10-20', url: 'https://github.com/o/r/pull/7' }, { number: 8, headRefName: 'feature/x', url: 'u' }]), stderr: '' } },
    load: async (url) => { fetched.push(url); throw new ReadError('should not be read'); }
  });
  assert.match(result.blocked, /An earlier market refresh is still open \(https:\/\/github\.com\/o\/r\/pull\/7\)\. Merge or close it/);
  assert.deepEqual(fetched, []);
  assert.ok(!calls.some((call) => /^(git (switch|add|commit|push)|gh pr create|npm)/.test(call)));
});

test('--open-pr refuses a dirty working tree and a checkout that is behind main', async () => {
  await assert.rejects(() => runRefresh({ options: { openPr: true }, replies: { 'git status --porcelain': { code: 0, stdout: ' M js/x.js\n', stderr: '' } } }), /working tree has changes/);
  await assert.rejects(() => runRefresh({ options: { openPr: true }, replies: { 'git merge-base': { code: 1, stdout: '', stderr: '' } } }), /does not include origin\/main/);
});

test('--open-pr stops, with the changes left to inspect, when the rules check fails after the refresh', async () => {
  const { run, calls } = fakeRun({ 'npm run --silent check:figures': { code: 1, stdout: '[Figures] FAIL: something', stderr: '' } });
  const file = memoryFile();
  await assert.rejects(() => refreshMarketFigures({
    options: { today: TODAY, openPr: true }, figures: FIGURES, catalogueVersion: snapshot.MARKET_FIGURES_VERSION, registerFigures: [],
    load: loader(), marketFile: file, run, log: () => {}
  }), /check:figures fails after the refresh, so no pull request was opened[\s\S]*something/);
  assert.equal(file.state.writes, 1, 'the changes are in the working tree to look at');
  assert.ok(!calls.some((call) => /^(git (switch|commit|push)|gh pr create)/.test(call)));
});

test('the branch name steps aside from one that exists, and the PR is not opened if it cannot be named', async () => {
  const taken = (name) => ({ code: 0, stdout: 'x', stderr: '' });
  const { result } = await runRefresh({
    options: { openPr: true },
    replies: {
      [`git rev-parse --verify --quiet refs/heads/${BRANCH_PREFIX}${TODAY}`]: taken(),
      [`git ls-remote --exit-code --heads origin ${BRANCH_PREFIX}${TODAY}-2`]: taken()
    }
  });
  assert.equal(result.branch, `${BRANCH_PREFIX}${TODAY}-3`);
  await assert.rejects(() => runRefresh({ options: { openPr: true }, replies: { 'git rev-parse --verify': taken() } }), /are all taken/);
});

test('the run reads nothing it is not told to: a quote without a reader is reported, never guessed', async () => {
  const reads = await readAll(FIGURES, loader(), QUOTE_SOURCES.slice(1));
  const missing = reads.find((entry) => entry.sourceLabel.startsWith('Bank of Ireland, Instant Access'));
  assert.equal(missing.result.ok, false);
  assert.match(missing.result.reason, /no reader is defined/);
  const planned = planRefresh({ figures: FIGURES, catalogueVersion: snapshot.MARKET_FIGURES_VERSION, today: TODAY, reads });
  assert.equal(quoteOf(planned, CASH_RATE_ID, missing.sourceLabel).status, 'unread');
});

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

test('the command explains itself, lists the pages it reads with the names for saved copies, and refuses a contradiction', () => {
  const cli = (...args) => spawnSync(process.execPath, ['scripts/refresh-market-figures.mjs', ...args], { cwd: root, encoding: 'utf8' });
  const help = cli('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /With no option it is a dry run and writes nothing/);
  const pages = cli('--list-pages');
  assert.equal(pages.status, 0, pages.stderr);
  assert.match(pages.stdout, /https:\/\/aib\.ie\/our-products\/savings-and-deposits\/Deposit-Rates\n\s+saved copy: aib\.ie--our-products-savings-and-deposits-Deposit-Rates\.txt/);
  assert.match(pages.stdout, /demand-deposit-account\/features-and-benefits\//, 'the pages that link the dated PDF');
  assert.ok(!/\.pdf\n/.test(pages.stdout), 'the dated PDF itself is followed, not listed');
  const both = cli('--dry-run', '--apply');
  assert.equal(both.status, 1);
  assert.match(both.stderr, /cannot be combined/);
  assert.equal(cli('--today', 'yesterday').status, 1);
});

test('the job writes to the data file and the two generated files, and nowhere else', () => {
  assert.equal(MARKET_FILE, 'js/planning/figures/market_ie.js');
  assert.deepEqual([...GENERATED_FILES], ['js/planning/figures/figures_index.generated.js', 'docs/figures-register.md']);
  const sources = ['scripts/refresh-market-figures.mjs', ...['pages', 'readers', 'plan', 'report', 'run'].map((name) => `scripts/lib/market-refresh/${name}.mjs`)]
    .map((file) => readFileSync(join(root, file), 'utf8')).join('\n');
  assert.ok(!/planeir_assumptions|docs\/prompt-pack|check-future-cost-fund|check-goals-and-resources/.test(sources.replace(/CASH_RATE_GOLDENS[\s\S]*?\]\);/, '')), 'nothing here names Planeir\'s own assumptions, the prompt pack or a golden file to edit');
  assert.ok(!/writeFile\([^)]*(check-|tests_)/.test(sources));
});

// ---------------------------------------------------------------------------

for (const [name, fn] of tests) {
  try {
    await fn();
    console.info(`[Market refresh] PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[Market refresh] FAIL: ${name}\n    ${error.stack?.split('\n').slice(0, 6).join('\n    ') ?? error.message}`);
  }
}

if (failures > 0) {
  console.error(`[Market refresh] ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.info('[Market refresh] All market refresh checks passed.');
