# Market figures: the weekly refresh

The figures register holds three market figures: the interest on instant-access cash, the interest on a regular saver, and the illustrative mortgage rate. Each is worked out by code from the quotes it came from (`js/planning/figures/market_ie.js`, `market_math.js`). This job keeps those quotes current. It reads every page behind them, records what the page printed, and opens a pull request for Gerry when something moved.

Nothing is typed in or taken from memory. A person decides anything a client will see.

## What it does, and never does

For each quote in `market_ie.js` it:

1. reads the page (following a link where the rate sits in a dated PDF), and finds the row for that product;
2. records the rate **as printed**, the **effective date the page prints** (or none, if it prints none), and today as `retrievedOn`;
3. sets the figure's `checkedOn` to today;
4. if the worked-out value changed, sets `changedOn` to today and raises the figure's `version` and `MARKET_FIGURES_VERSION`;
5. runs `npm run build:figures` and `npm run check:figures`, and opens a PR that lists each figure's old and new value, each quote as printed, and the pages read.

It never:

- rewrites a `reviewed` value (the mortgage illustration). It records the quotes as evidence and reports where they now point;
- touches Planeir's own assumptions, `docs/prompt-pack/`, or any golden check. When the central cash rate moves, the three checks that pin 0.002 (`scripts/check-future-cost-fund.mjs`, `scripts/check-goals-and-resources.mjs`, `js/tests_future_cost_fund_math.js`) fail on the PR branch until a person reviews them, and the PR body says so;
- fills a quote it could not read. The quote stays exactly as it was and the PR says why;
- merges anything, or force-pushes.

It also reports, without changing them: any market figure past its `reviewEveryDays`, any quote it has failed to read for longer than that, and any announced-law figure not checked for 90 days (which may have been enacted since). It does not check law.

## Running it

```bash
npm run refresh:market-figures                    # dry run: prints the report, writes nothing
npm run refresh:market-figures -- --diff          # ...and how market_ie.js would change
npm run refresh:market-figures -- --apply         # writes the change, rebuilds the register, runs check:figures
npm run refresh:market-figures -- --open-pr       # --apply on a new branch, then commit, push and open the PR
```

Other options: `--pages-dir DIR` (below), `--report FILE`, `--json`, `--today YYYY-MM-DD`, `--base REF` (default `origin/main`), `--freshness-days N`, `--max-saved-age-hours N`, `--list-pages`, `--help`.

`--open-pr` must be run from a clean checkout that includes `origin/main`. A fresh worktree of `main` is best. It stops, before reading anything, if the tree is dirty or an earlier `figures/market-refresh-*` PR is still open (merge or close it first). If `check:figures` fails after the refresh it stops with the changes left in the working tree and opens nothing.

### When a PR is opened

When a quote's rate, printed date or page changed, or a worked-out value changed. If nothing moved, nothing is opened, with one exception: once the last recorded check is 21 days old or more (`--freshness-days`), a PR is opened to record the check, so the register's "checked N days ago" warning (at 35) does not say the job has stopped when it has not.

`checkedOn` is set for a figure when at least one of its quotes was read. A quote that could not be read keeps its old `retrievedOn`, and the report names any quote not read for longer than the figure's review interval.

### Versions

A changed value raises the figure's `version` by a minor step (`1.0.0` to `1.1.0`) and the catalogue's `MARKET_FIGURES_VERSION` by one (`ie-market-2026.1` to `ie-market-2026.2`; the first change of a new year starts again at `.1`). A quote that moves without changing the worked-out value (rounding absorbs it) is recorded and raises nothing.

## Where each rate is read

| Quote | Page | How |
|---|---|---|
| Bank of Ireland instant access, SuperSaver Standard Regular Saver | The dated "Deposit Interest Rates Table" PDF, linked from Bank of Ireland's demand-deposit and SuperSaver product pages | Reads the product page, follows the newest matching link (the file name carries the date, so the address changes), reads the PDF with pdf.js, records the new address as the quote's `url` |
| Bank of Ireland 3-year fixed, first-time buyer, BER C | Bank of Ireland mortgage interest rates (HTML) | Plain request |
| AIB personal demand deposit, Online Regular Saver | AIB deposit rates | Browser-saved copy (below) |
| AIB 3-year LTV fixed, over 50% and up to 80% | AIB mortgage interest rates | Browser-saved copy |
| PTSB 21 Day Notice Regular Saver | PTSB regular saver page | Browser-saved copy |
| PTSB 3-year fixed, over 60% and up to 80% LTV | PTSB mortgage interest rates | Browser-saved copy |

`npm run refresh:market-figures -- --list-pages` prints the pages and the file name a saved copy needs.

### Pages that refuse plain requests

AIB and PTSB answer a plain request with an "Access Denied" page (a 403). The job does not try to get round that. A person, or an agent with a browser, opens each page, saves **the page's visible text unchanged** into a folder, and the job reads that instead:

1. Run the dry run with `--pages-dir DIR`. Under "Could not be read" it lists each page and the file name to use, for example `aib.ie--our-products-savings-and-deposits-Deposit-Rates.txt`.
2. Open each page in a browser and save its visible text to `DIR/<that name>`. In the Claude desktop app's built-in browser: `navigate`, then `get_page_text`, and write the text out as it came. Do not retype, trim, summarise or correct a number.
3. Run again with the same `--pages-dir`.

A saved page is used in preference to the network and must be less than 36 hours old (`--max-saved-age-hours`), so an old copy can never stamp last week's rate with today's date. A site that needs its HTML (for links) can be saved as `<name>.html` instead.

The job trusts a saved page as the page. What stops a bad copy doing harm is that every reader checks the shape of what it reads (below), the PR shows each row as printed next to the old value, and a move of a point or more is called out.

## When a page changes

A reader (`scripts/lib/market-refresh/readers.mjs`, `QUOTE_SOURCES`) names the row it wants, the heading and column headings it must sit under, and which column holds the rate. If any of that is not as expected, the quote is reported as unread and left alone, with the reason. It never reads the nearest number.

To fix one: save the page again, update the entry in `QUOTE_SOURCES`, replace the fixture in `scripts/fixtures/market-pages/` and the expected value at the top of `scripts/check-market-refresh.mjs` (the fixture README says how), and run `npm run check:market-refresh`.

To add a quote to a figure: add the observation to `market_ie.js` with a value taken from the page, add its entry to `QUOTE_SOURCES` (the tests fail until both exist, in step), and add its saved page.

To add a figure: the same, plus the figure itself in `market_ie.js` and its catalogue entry. The tests and `check:figures` will say what is missing.

## Tests

`npm run check:market-refresh` runs on saved pages (`scripts/fixtures/market-pages/`), so CI needs no network. It covers the readers and the cases they must refuse, the plan and its bookkeeping, the edit of `market_ie.js`, the report, and the whole run against a fake `git` and `gh`. PDF text is read with `pdfjs-dist` (a pinned dev dependency, loaded only when a PDF is read). It needs its optional `@napi-rs/canvas` package, which `npm ci` installs unless told to omit optional dependencies.

## Scheduling it (not set up: needs Gerry's approval)

Where it runs and how often are decisions, so nothing is scheduled yet.

**Recommended: a local scheduled task on Gerry's Mac, weekly, Monday morning.** AIB and PTSB refuse plain requests and need a real browser, which the desktop app has. A remote agent has not been tried against these sites; unless it has a browser they accept, it would leave five of the eight quotes unread every week. The cost of the local task is that it only runs when the Mac is awake and the app is open; a missed run is made up at the next.

The task's instruction:

> In `geraldboylan01/Call-Template`, make a fresh worktree of `origin/main` and run `npm ci`. Run `npm run refresh:market-figures -- --pages-dir <folder>`. For each page under "Could not be read" that lists a saved-copy name, open it in the built-in browser, read its visible text with `get_page_text`, and save it unchanged to `<folder>/<name>`. Then run `npm run refresh:market-figures -- --pages-dir <folder> --open-pr`. Report the PR link, or why none was opened, and copy the "Needs a person" section. Never merge, never edit a golden check, never change a `reviewed` value, never retype a number.

**Alternative: a scheduled remote agent.** It reads Bank of Ireland (three quotes) and, without a browser, reports the other five as unread each week; the stale-quote warning appears after 35 days. Reasonable only if someone else does the browser-saved step, or the remote environment turns out to be able to read those pages.

Cadence: weekly is enough; banks change rates a few times a year, and the register's review interval is 35 days. Daily would add nothing but PRs.

The agent needs `git` push rights and `gh` signed in. The job opens the PR; it never enables auto-merge.
