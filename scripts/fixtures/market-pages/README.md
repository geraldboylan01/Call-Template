# Saved pages for `check:market-refresh`

CI has no network, so the market-figures job is tested on pages saved from the
real sites on **27 October 2026**. Nothing here is generated or edited by hand
except as stated below.

## `network/`: what a plain HTTP request returns

| File | Page |
|---|---|
| `boi-mortgage-interest-rates.html` | Bank of Ireland mortgage interest rates |
| `boi-demand-deposit-account-features-and-benefits.html` | Bank of Ireland demand deposit account page, which links the dated rates PDF |
| `boi-deposit-interest-rates-table-22nd-october-2026.pdf` | The PDF that page links, unchanged |

The two HTML files have their `<script>`, `<style>`, `<svg>`, `<noscript>` blocks and comments removed
(about 40% of the size), and nothing else.

## `browser/`: what a person sees, saved from a browser

AIB and PTSB answer a plain request with an "Access Denied" page, so these are the
visible text of each page as the built-in browser returned it, named the way the job
looks for them (`savedPageName`). The site navigation and footer are cut, and the PTSB
mortgage page is cut after its first fixed-rate tables, its variable-rate table and a few
existing-customer rows; every table the job reads is whole, including the near-identical
rows it must not confuse (Green, High Value, other terms and loan-to-value bands).

## `market_ie.before.js`

A copy of `js/planning/figures/market_ie.js` as it stood when these pages were saved
(quotes retrieved 22 October 2026). The tests refresh this copy against the pages above,
so they do not change when the real register does.

## Refreshing the fixtures

Save the pages again as described in `docs/figures-market-refresh.md`, replace the
files here, copy the register's current `market_ie.js` over `market_ie.before.js`, and
update the expected values at the top of `scripts/check-market-refresh.mjs`.
