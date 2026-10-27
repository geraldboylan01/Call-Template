#!/usr/bin/env node
// Keeps the market figures in the figures register current.
//
//   npm run refresh:market-figures                 dry run: print what would change
//   npm run refresh:market-figures -- --apply      write the changes into the working tree
//   npm run refresh:market-figures -- --open-pr    write them on a new branch and open a PR
//
// Read docs/figures-market-refresh.md before scheduling it.

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { collectFigures } from '../js/planning/figures/collect.js';
import { MARKET_FIGURES, MARKET_FIGURES_VERSION } from '../js/planning/figures/market_ie.js';
import { createPageLoader, savedPageName } from './lib/market-refresh/pages.mjs';
import { QUOTE_SOURCES } from './lib/market-refresh/readers.mjs';
import { MARKET_FILE, refreshMarketFigures } from './lib/market-refresh/run.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const USAGE = `Usage: node scripts/refresh-market-figures.mjs [options]

Reads every published rate behind a market figure, records it as printed, and
reports what moved. With no option it is a dry run and writes nothing.

  --apply               Write the changes into the working tree, rebuild the
                        register and run check:figures.
  --open-pr             --apply on a new branch from a clean checkout of main,
                        then commit, push and open a pull request. Does nothing
                        when nothing moved (see --freshness-days).
  --pages-dir DIR       Folder of pages saved from a browser, for sites that refuse
                        plain requests. A saved page is used in preference to the
                        network, and must be less than --max-saved-age-hours old.
  --list-pages          Print every page the job reads, and the file name a
                        browser-saved copy of it needs, then stop.
  --report FILE         Also write the report (Markdown) to FILE.
  --json                Print the plan as JSON instead of the report.
  --diff                Show how market_ie.js would change.
  --today YYYY-MM-DD    The date to record. Default: today in Dublin.
  --base REF            What the pull request is made against. Default: origin/main.
  --freshness-days N    With --open-pr and nothing moved, still open a PR to record
                        the check when the last recorded one is N days old or more.
                        Default 21 (the register warns at 35).
  --max-saved-age-hours N   Oldest browser-saved page that is accepted. Default 36.
  --help
`;

const { values: flags } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    'open-pr': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'pages-dir': { type: 'string' },
    'list-pages': { type: 'boolean', default: false },
    report: { type: 'string' },
    json: { type: 'boolean', default: false },
    diff: { type: 'boolean', default: false },
    today: { type: 'string' },
    base: { type: 'string', default: 'origin/main' },
    'freshness-days': { type: 'string', default: '21' },
    'max-saved-age-hours': { type: 'string', default: '36' },
    help: { type: 'boolean', default: false }
  }
});

if (flags.help) {
  console.info(USAGE);
  process.exit(0);
}
if (flags['dry-run'] && (flags.apply || flags['open-pr'])) {
  console.error('--dry-run cannot be combined with --apply or --open-pr.');
  process.exit(1);
}

const dublinToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const today = flags.today ?? dublinToday();
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  console.error('--today must be a date like 2026-10-27.');
  process.exit(1);
}
const pagesDir = flags['pages-dir'] ? resolve(flags['pages-dir']) : null;

if (flags['list-pages']) {
  const urls = new Set();
  for (const figure of MARKET_FIGURES) {
    for (const observation of figure.observations) {
      const source = QUOTE_SOURCES.find((entry) => entry.figure === figure.id && entry.sourceLabel === observation.sourceLabel);
      if (!source) continue;
      (source.page.kind === 'page' ? [observation.url] : source.page.indexPages).forEach((url) => urls.add(url));
    }
  }
  for (const url of urls) console.info(`${url}\n    saved copy: ${savedPageName(url)}.txt (or .html)`);
  process.exit(0);
}

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? (result.error?.message ?? '') };
};

const marketPath = resolve(root, MARKET_FILE);

try {
  const result = await refreshMarketFigures({
    options: {
      apply: flags.apply,
      openPr: flags['open-pr'],
      base: flags.base,
      freshnessDays: Number(flags['freshness-days']),
      pagesDir,
      today
    },
    figures: MARKET_FIGURES,
    catalogueVersion: MARKET_FIGURES_VERSION,
    registerFigures: collectFigures(),
    load: createPageLoader({ pagesDir, maxSavedAgeHours: Number(flags['max-saved-age-hours']) }),
    marketFile: { read: () => readFile(marketPath, 'utf8'), write: (text) => writeFile(marketPath, text) },
    run
  });

  if (result.blocked) process.exit(0);

  if (flags.json) {
    const plan = { ...result.plan, figures: result.plan.figures.map(({ afterFigure, ...rest }) => rest) };
    console.info(JSON.stringify({ plan, decision: result.decision, wrote: result.wrote, pullRequestUrl: result.pullRequestUrl, checks: result.checks }, null, 2));
  } else {
    console.info(result.report);
  }
  if (flags.report) await writeFile(resolve(flags.report), result.report);

  if (flags.diff) {
    if (result.wrote) {
      console.info(run('git', ['diff', '--no-color', '--', MARKET_FILE]).stdout.trim() || 'See git for the change to market_ie.js.');
    } else {
      const directory = await mkdtemp(join(tmpdir(), 'market-diff-'));
      const before = join(directory, 'market_ie.before.js');
      const after = join(directory, 'market_ie.after.js');
      await writeFile(before, await readFile(marketPath, 'utf8'));
      await writeFile(after, result.edited);
      console.info(run('git', ['diff', '--no-index', '--no-color', before, after]).stdout.replaceAll(before.slice(1), MARKET_FILE).replaceAll(after.slice(1), MARKET_FILE).trim() || 'No change to market_ie.js.');
    }
  }

  if (result.pullRequestUrl) console.info(`\nPull request: ${result.pullRequestUrl}`);
} catch (error) {
  console.error(`[Market refresh] ${error.message}`);
  process.exit(1);
}
