/**
 * Market figures: prices and rates that move on their own. Data only.
 *
 * Each figure holds the quotes it was worked out from, never the answer. A
 * scheduled job collects fresh quotes and adds them to `observations`; the pure
 * function in `market_math.js` does the arithmetic, so a value is always
 * traceable to what was published and when. Nothing here is typed in from
 * memory: every observation names the page it was read from and the day it was
 * read.
 *
 * Provider names appear in `observations` only, as internal provenance for the
 * audit trail. A label, a plain-language basis or anything else a client could
 * see or hear never names one (`check:figures` enforces it).
 *
 * Keeping it current (the weekly job is described in docs/figures-market-refresh.md):
 * - A job adds or replaces observations, sets `checkedOn` to the day it read
 *   them, and sets `changedOn` when the worked-out value changed.
 * - Change `version` whenever a value changes. The register records it.
 * - `reviewed` figures hold a value a person chose. Their observations are the
 *   evidence for that choice, and the check warns when the evidence moves away
 *   from it. A job proposes a new value; it never rewrites one.
 *
 * Planeir's own assumptions (growth, inflation and so on) are not market
 * figures and do not belong here: a job never changes them.
 */

export const MARKET_FIGURES_VERSION = 'ie-market-2026.2';

export const MARKET_FIGURES = Object.freeze([
  Object.freeze({
    id: 'ie.market.cash.instant_access_gross_rate',
    label: 'Interest on money kept in an instant-access cash account, before DIRT',
    unit: 'rate_a_year',
    /** Two quotes, so the median and the mean agree; the basis says "average". */
    method: Object.freeze({ kind: 'mean', roundTo: 0.001 }),
    observations: Object.freeze([
      Object.freeze({
        sourceLabel: 'Bank of Ireland, Instant Access Demand (balances up to €5,000)',
        url: 'https://personalbanking.bankofireland.com/app/uploads/Deposits-Interest-Rate-Table-14th-September-2026-A.pdf',
        value: 0.001,
        quotedAs: 'AER, variable, before DIRT',
        effective: '2026-09-14',
        retrievedOn: '2026-10-22'
      }),
      Object.freeze({
        sourceLabel: 'AIB, Personal Demand Deposit Account',
        url: 'https://aib.ie/our-products/savings-and-deposits/Deposit-Rates',
        value: 0.0025,
        quotedAs: 'AER and gross annual interest rate, variable',
        effective: '2025-05-13',
        retrievedOn: '2026-10-22'
      })
    ]),
    checkedOn: '2026-10-22',
    changedOn: '2026-10-13',
    reviewEveryDays: 35,
    usedBy: Object.freeze(['future_cost_fund', 'goals_and_resources']),
    version: '1.0.0'
  }),

  Object.freeze({
    id: 'ie.market.cash.regular_saver_gross_rate',
    label: 'Interest on money put into a regular savings account each month, before DIRT',
    unit: 'rate_a_year',
    /**
     * The median, not the mean: one lender's top rate is capped by a monthly
     * limit and sits well above the others, and the median ignores it.
     */
    method: Object.freeze({ kind: 'median', roundTo: 0.001 }),
    observations: Object.freeze([
      Object.freeze({
        sourceLabel: 'Bank of Ireland, SuperSaver Standard Regular Saver (balances up to €29,999)',
        url: 'https://personalbanking.bankofireland.com/app/uploads/Deposits-Interest-Rate-Table-14th-September-2026-A.pdf',
        value: 0.02,
        quotedAs: 'AER, variable, before DIRT',
        effective: '2026-09-14',
        retrievedOn: '2026-10-22'
      }),
      Object.freeze({
        sourceLabel: 'AIB, Online Regular Saver (up to €1,000 a month)',
        url: 'https://aib.ie/our-products/savings-and-deposits/Deposit-Rates',
        value: 0.03,
        quotedAs: 'AER, variable, before DIRT; 0.25% above the monthly limit',
        effective: '2025-05-13',
        retrievedOn: '2026-10-22'
      }),
      Object.freeze({
        sourceLabel: 'PTSB, 21 Day Notice Regular Saver (balances up to €75,000)',
        url: 'https://www.ptsb.ie/saving-and-investing/savings-accounts/regular-saver/',
        value: 0.02,
        quotedAs: 'AER, variable, before DIRT',
        effective: null,
        retrievedOn: '2026-10-22'
      })
    ]),
    checkedOn: '2026-10-22',
    changedOn: '2026-07-12',
    reviewEveryDays: 35,
    usedBy: Object.freeze(['house_purchase']),
    version: '1.0.0'
  }),

  Object.freeze({
    id: 'ie.market.mortgage.illustration_rate',
    label: 'Interest rate used to illustrate mortgage repayments',
    unit: 'rate_a_year',
    /**
     * An illustration, not a quote. A person chose 3.75% on 27 October 2026, the
     * median of the published three-year fixed rates up to 80% of the home's value
     * that the observations below record. Before that it was 3.5%, the House
     * Purchase standard planning assumption in place since the module was built
     * (as of 11 July 2026). The weekly job records the quotes and reports where
     * they now point; it never changes this value.
     */
    method: Object.freeze({
      kind: 'reviewed',
      value: 0.0375,
      reviewedOn: '2026-10-27',
      driftWarnAt: 0.002
    }),
    observations: Object.freeze([
      Object.freeze({
        sourceLabel: 'Bank of Ireland, 3 Year Fixed, first-time buyer, BER C',
        url: 'https://personalbanking.bankofireland.com/borrow/mortgages/mortgage-interest-rates/',
        value: 0.04,
        quotedAs: 'interest rate, fixed for three years',
        effective: null,
        retrievedOn: '2026-10-22'
      }),
      Object.freeze({
        sourceLabel: 'AIB, 3 Year LTV Fixed, over 50% and up to 80%',
        url: 'https://aib.ie/our-products/mortgages/mortgage-interest-rates',
        value: 0.036,
        quotedAs: 'interest rate, fixed for three years',
        effective: null,
        retrievedOn: '2026-10-22'
      }),
      Object.freeze({
        sourceLabel: 'PTSB, 3 Year Fixed Rate New Business, over 60% and up to 80%',
        url: 'https://www.ptsb.ie/mortgages/mortgage-interest-rates/',
        value: 0.0375,
        quotedAs: 'borrowing rate, fixed for three years',
        effective: '2026-01-20',
        retrievedOn: '2026-10-22'
      })
    ]),
    checkedOn: '2026-10-22',
    changedOn: '2026-10-27',
    reviewEveryDays: 35,
    usedBy: Object.freeze(['house_purchase']),
    version: '1.1.0'
  })
]);
