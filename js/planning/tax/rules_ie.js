/**
 * Irish personal tax rules, by tax year. Data only.
 *
 * Every figure here is transcribed from the Revenue guidance and legislation
 * listed in `IE_TAX_SOURCES`, as verified on the date each block records. None
 * comes from a third-party calculator. The engine reads these; nothing else in
 * the app should carry its own copy of a band, credit or rate.
 *
 * Two kinds of rule live here, and they project differently (brief, section 5):
 *
 * - `IE_TAX_RULES_BY_YEAR` holds what each Budget sets. A later year with no
 *   block of its own uses the latest block unchanged in euro terms. Nothing is
 *   indexed, because Budgets often leave these alone.
 * - `IE_LEGISLATED_SCHEDULES` holds changes the law has already fixed by date
 *   and amount. They are applied on their dates and held at their last value.
 *
 * Keeping it current (brief, section 14): add a new year's block on Budget day
 * with `status: 'announced'`, switch it to `'enacted'` when the Finance Act
 * passes, never edit a past year's block, and record each SFT Revenue publishes
 * as a fixed amount with its source. After any change, update `verifiedOn`,
 * bump `IE_TAX_RULES_VERSION` and rerun the golden cases.
 *
 * A rule a later year carries over unchanged is the SAME OBJECT as the earlier
 * year's, not an equal copy. That is how the block says "Budget 2027 left this
 * alone", and how the figures register lists it once, for the year it first took
 * effect. `check:figures` fails if a Budget is recorded anywhere with no block
 * for its year.
 */

export const IE_TAX_RULES_VERSION = 'ie-tax-2026.7';

/** The first tax year the catalogue covers. Earlier years are refused. */
export const IE_TAX_FIRST_YEAR = 2026;

export const IE_TAX_SOURCES = Object.freeze({
  revenueTaxReliefCharts: Object.freeze({
    title: 'Revenue, tax rates, bands and reliefs',
    url: 'https://www.revenue.ie/en/personal-tax-credits-reliefs-and-exemptions/tax-relief-charts/index.aspx'
  }),
  revenueEmployeeCredit: Object.freeze({
    title: 'Revenue, Employee Tax Credit',
    url: 'https://www.revenue.ie/en/personal-tax-credits-reliefs-and-exemptions/income-and-employment/employee-tax-credit/index.aspx'
  }),
  revenueAgeExemption: Object.freeze({
    title: 'Revenue, age exemption and marginal relief (TDM Part 07-01-18)',
    url: 'https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-07/07-01-18.pdf'
  }),
  revenueUsc: Object.freeze({
    title: 'Revenue, Universal Social Charge',
    url: 'https://www.revenue.ie/en/jobs-and-pensions/usc/index.aspx'
  }),
  revenueUscReducedRates: Object.freeze({
    title: 'Revenue, USC reduced rates',
    url: 'https://www.revenue.ie/en/jobs-and-pensions/usc/reduced-rates.aspx'
  }),
  uscBandsNoteForGuidance: Object.freeze({
    title: 'Note for Guidance on s.531AN TCA (2026 USC bands)',
    url: 'https://www.charteredaccountants.ie/taxsourcetotal/1997/en/act/pub/0039/nfg/sec0531AN-nfg.html'
  }),
  revenueOlderPersonsPrsiUsc: Object.freeze({
    title: 'Revenue, PRSI and USC for older persons',
    url: 'https://www.revenue.ie/en/life-events-and-personal-circumstances/older-persons/prsi-usc.aspx'
  }),
  revenueNursingHome: Object.freeze({
    title: 'Revenue, nursing home and additional nursing care expenses (published 8 September 2026)',
    url: 'https://www.revenue.ie/en/personal-tax-credits-reliefs-and-exemptions/health-and-age/health-expenses/nursing-home-and-additional-nursing-care-expenses.aspx'
  }),
  revenueTdmHealthExpenses: Object.freeze({
    title: 'Revenue, Tax and Duty Manual Part 15-01-12, Health Expenses, section 4 (nursing home care)',
    url: 'https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-15/15-01-12.pdf'
  }),
  govPrsiChanges: Object.freeze({
    title: 'gov.ie, changes to PRSI from 2024',
    url: 'https://www.gov.ie/en/publication/70400-changes-to-pay-related-social-insurance-prsi'
  }),
  prsiStatutoryInstrument: Object.freeze({
    title: 'S.I. No. 534 of 2024 (PRSI increases 2024 to 2028)',
    url: 'https://www.irishstatutebook.ie/eli/2024/si/534/made/en/pdf'
  }),
  oireachtasArfPrsi: Object.freeze({
    title: 'Oireachtas answer on Class S PRSI on ARF distributions',
    url: 'https://www.oireachtas.ie/en/debates/question/2018-11-21/241/'
  }),
  arfEmolumentsNoteForGuidance: Object.freeze({
    title: 'Note for Guidance on s.784A TCA (ARF distributions as emoluments)',
    url: 'https://www.charteredaccountants.ie/taxsource/1997/en/act/pub/0039/nfg/sec0784A-nfg.html'
  }),
  revenueLumpSums: Object.freeze({
    title: 'Revenue, taxation of retirement lump sums',
    url: 'https://www.revenue.ie/en/jobs-and-pensions/pension/private/retirement-lump-sums.aspx'
  }),
  pensionsManualChapter27: Object.freeze({
    title: 'Revenue Pensions Manual, Chapter 27 (lump sums and the CET credit)',
    url: 'https://www.revenue.ie/en/tax-professionals/tdm/pensions/chapter-27.pdf'
  }),
  revenueChargeableExcessTax: Object.freeze({
    title: 'Revenue, chargeable excess tax and the SFT schedule',
    url: 'https://www.revenue.ie/en/jobs-and-pensions/pension/private/chargeable-excess-tax.aspx'
  }),
  section787O: Object.freeze({
    title: 's.787O TCA, the SFT amounts to 2029 and the earnings indexation from 2030',
    url: 'https://www.charteredaccountants.ie/taxsourcetotal/1997/en/act/pub/0039/sec0787O.html'
  }),
  pensionsManualChapter25: Object.freeze({
    title: 'Revenue Pensions Manual, Chapter 25 (SFT and BCEs)',
    url: 'https://www.revenue.ie/en/tax-professionals/tdm/pensions/chapter-25.pdf'
  }),
  pensionsManualChapter28: Object.freeze({
    title: 'Revenue Pensions Manual, Chapter 28 (imputed distributions)',
    url: 'https://www.revenue.ie/en/tax-professionals/tdm/pensions/chapter-28.pdf'
  }),
  revenueCgtCalculate: Object.freeze({
    title: 'Revenue, how to calculate CGT (rates, the annual exemption and allowable costs)',
    url: 'https://www.revenue.ie/en/gains-gifts-and-inheritance/transfering-an-asset/how-to-calculate-cgt.aspx'
  }),
  revenueCgtLosses: Object.freeze({
    title: 'Revenue, CGT: if you make a loss',
    url: 'https://www.revenue.ie/en/gains-gifts-and-inheritance/transfering-an-asset/if-you-make-a-loss.aspx'
  }),
  revenueCgtIndexation: Object.freeze({
    title: 'Revenue, indexation relief',
    url: 'https://www.revenue.ie/en/gains-gifts-and-inheritance/cgt-reliefs/inflation-relief.aspx'
  }),
  revenueCgtIndexationManual: Object.freeze({
    title: 'Revenue, Tax and Duty Manual Part 19-02-13 (indexation, s.556)',
    url: 'https://www.revenue.ie/en/tax-professionals/tdm-wm/income-tax-capital-gains-tax-corporation-tax/part-19/19-02-13.pdf'
  }),
  revenueCgtMultipliers: Object.freeze({
    title: 'Revenue, CGT multiplier table',
    url: 'https://www.revenue.ie/en/gains-gifts-and-inheritance/documents/cgtmult.pdf'
  }),
  financeAct2003Section65: Object.freeze({
    title: 'Finance Act 2003, s.65 (the s.556 multiplier table for disposals from 2004)',
    url: 'https://www.irishstatutebook.ie/2003/en/act/pub/0003/sec0065.html'
  }),
  revenueCgt604A: Object.freeze({
    title: 'Revenue, property acquired between 7 December 2011 and 31 December 2014',
    url: 'https://www.revenue.ie/en/gains-gifts-and-inheritance/cgt-reliefs/property-acquired-between-7-December-2011-and-31-December-2014.aspx'
  }),
  revenueCgt604AManual: Object.freeze({
    title: 'Revenue, Tax and Duty Manual Part 19-07-03A (s.604A)',
    url: 'https://www.revenue.ie/en/tax-professionals/tdm-wm/income-tax-capital-gains-tax-corporation-tax/part-19/19-07-03a.pdf'
  }),
  revenuePpr: Object.freeze({
    title: 'Revenue, Principal Private Residence relief',
    url: 'https://www.revenue.ie/en/gains-gifts-and-inheritance/cgt-reliefs/principal-private-residence-ppr-relief.aspx'
  }),
  revenueDirt: Object.freeze({
    title: 'Revenue, Deposit Interest Retention Tax (DIRT)',
    url: 'https://www.revenue.ie/en/additional-incomes/dirt/who-is-charged-dirt.aspx'
  }),
  revenueInvestmentUndertakings: Object.freeze({
    title: 'Revenue, Tax and Duty Manual Part 27-01a-02 (investment undertakings: exit tax rates and the eight-year deemed disposal)',
    url: 'https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-27/27-01a-02.pdf'
  }),
  /**
   * The Department's publication page lists this file. The earlier link,
   * `.../c6792805/Budget_2027_Tax_Policy_Changes_v2.pdf`, no longer opens.
   */
  budget2027TaxPolicyChanges: Object.freeze({
    title: 'Department of Finance, Budget 2027: Tax Policy Changes',
    url: 'https://assets.gov.ie/static/documents/c6792805/20261012_Budget_2027_Tax_Policy_Changes_Book.pdf'
  }),
  budget2027Statement: Object.freeze({
    title: 'Department of Finance, Statement by the Minister for Finance on Budget 2027',
    url: 'https://www.gov.ie/en/department-of-finance/speeches/statement-by-minister-harris-on-budget-2027/'
  }),
  financeNo2Bill2026: Object.freeze({
    title: 'Finance (No. 2) Bill 2026 (Bill No. 98 of 2026), as initiated on 19 October 2026',
    url: 'https://data.oireachtas.ie/ie/oireachtas/bill/2026/98/eng/initiated/b9826d.pdf'
  }),
  financeNo2Bill2026Memo: Object.freeze({
    title: 'Explanatory Memorandum to the Finance (No. 2) Bill 2026',
    url: 'https://data.oireachtas.ie/ie/oireachtas/bill/2026/98/eng/memo/b9826d-memo.pdf'
  }),
  section461A: Object.freeze({
    title: 'TCA 1997 s.461A, additional tax credit for certain widowed persons (TaxSource Total)',
    url: 'https://www.charteredaccountants.ie/taxsourcetotal/1997/en/act/pub/0039/sec0461A.html'
  })
});

const S = IE_TAX_SOURCES;

const TAX_YEAR_2026 = Object.freeze({
    status: 'enacted',
    enactedBy: 'Finance Act 2025',
    verifiedOn: '2026-10-22',

    incomeTax: Object.freeze({
      ruleId: 'ie.income_tax.2026',
      standardRate: 0.20,
      higherRate: 0.40,
      standardRateBand: Object.freeze({
        single: 44_000,
        /** Widowed or surviving civil partner without qualifying children. */
        widowed: 44_000,
        /** Married or civil partners, one income. */
        marriedOneIncome: 53_000,
        /** The most a second income can add, capped at that income. */
        secondIncomeIncreaseMax: 35_000
      }),
      personalCredit: Object.freeze({
        single: 2_000,
        married: 4_000,
        /** Widowed without dependent children. */
        widowed: 2_540
      }),
      employeeCredit: Object.freeze({
        ruleId: 'ie.income_tax.employee_credit.2026',
        amount: 2_000,
        /** The credit cannot exceed this share of the person's qualifying income. */
        maxShareOfQualifyingIncome: 0.20
      }),
      ageCredit: Object.freeze({
        ruleId: 'ie.income_tax.age_credit.2026',
        fromAge: 65,
        single: 245,
        widowed: 245,
        married: 490
      }),
      /**
       * Nursing home fees the person pays themselves, in a home with 24-hour
       * on-site nursing care, are a deduction from total income: worth the
       * payer's marginal rate. Income tax only. The HSE's share gets no relief.
       */
      nursingHomeExpenses: Object.freeze({
        ruleId: 'ie.income_tax.nursing_home_expenses.2026',
        sources: Object.freeze([S.revenueNursingHome, S.revenueTdmHealthExpenses])
      }),
      sources: Object.freeze([S.revenueTaxReliefCharts, S.revenueEmployeeCredit, S.arfEmolumentsNoteForGuidance])
    }),

    ageExemption: Object.freeze({
      ruleId: 'ie.income_tax.age_exemption.2026',
      fromAge: 65,
      limit: Object.freeze({
        single: 18_000,
        widowed: 18_000,
        married: 36_000
      }),
      /** Above the limit, tax is capped at this share of the income above it... */
      marginalReliefRate: 0.40,
      /** ...while total income is no more than this multiple of the limit. */
      marginalReliefCeilingMultiple: 2,
      sources: Object.freeze([S.revenueAgeExemption])
    }),

    usc: Object.freeze({
      ruleId: 'ie.usc.2026',
      /** Aggregate income at or below this pays no USC at all. */
      exemptionThreshold: 13_000,
      bands: Object.freeze([
        Object.freeze({ upTo: 12_012, rate: 0.005 }),
        Object.freeze({ upTo: 28_700, rate: 0.02 }),
        Object.freeze({ upTo: 70_044, rate: 0.03 }),
        Object.freeze({ upTo: null, rate: 0.08 })
      ]),
      reduced: Object.freeze({
        ruleId: 'ie.usc.reduced_70.2026',
        fromAge: 70,
        /** Reduced rates apply while aggregate income is no more than this. */
        aggregateIncomeCeiling: 60_000,
        bands: Object.freeze([
          Object.freeze({ upTo: 12_012, rate: 0.005 }),
          Object.freeze({ upTo: null, rate: 0.02 })
        ])
      }),
      surcharge: Object.freeze({
        ruleId: 'ie.usc.surcharge.2026',
        rate: 0.03,
        /** Applies to non-PAYE income above this. */
        nonPayeThreshold: 100_000
      }),
      sources: Object.freeze([S.revenueUsc, S.revenueUscReducedRates, S.uscBandsNoteForGuidance])
    }),

    prsi: Object.freeze({
      ruleId: 'ie.prsi.liability.2026',
      /** Liable below this attained age. */
      liableUnderAge: 66,
      /** Not liable from this attained age. */
      exemptFromAge: 70,
      /** From 66 to 69, not liable if the person reached 66 before 1 January of this year. */
      reached66BeforeYear: 2024,
      sources: Object.freeze([S.revenueOlderPersonsPrsiUsc, S.govPrsiChanges, S.oireachtasArfPrsi])
    }),

    lumpSum: Object.freeze({
      ruleId: 'ie.lump_sum.2026',
      /** Counted from this date across every retirement lump sum. */
      countedSince: '2005-12-07',
      lifetimeTaxFree: 200_000,
      /** Up to this cumulative total the slice above the tax-free amount is taxed at the standard rate. */
      standardRateCeiling: 500_000,
      standardRate: 0.20,
      /**
       * The usual most a retirement lump sum can be, as a share of the fund
       * (the retirement module's "max" option, brief 7.1). An occupational
       * scheme's salary and service route can allow more.
       */
      maxShareOfFund: 0.25,
      /** Lump sum tax paid on or after this date can be credited against CET. */
      creditableSince: '2011-01-01',
      sources: Object.freeze([S.revenueLumpSums, S.pensionsManualChapter27])
    }),

    chargeableExcessTax: Object.freeze({
      ruleId: 'ie.chargeable_excess_tax.2026',
      /** CET is charged at the higher rate of income tax for the year. */
      rate: 'incomeTax.higherRate',
      sources: Object.freeze([S.revenueChargeableExcessTax, S.pensionsManualChapter25, S.pensionsManualChapter27])
    }),

    /**
     * Capital gains tax on property. Added on 11 October 2026 as a new head;
     * the values above were not touched. The rate itself changes by date, so
     * it lives in `IE_LEGISLATED_SCHEDULES.capitalGainsTaxRate`.
     */
    capitalGainsTax: Object.freeze({
      ruleId: 'ie.cgt.2026',
      verifiedOn: '2026-10-11',
      /** Per person, per year, after losses. Not transferable between spouses. */
      annualExemption: 1_270,
      sources: Object.freeze([S.revenueCgtCalculate, S.revenueCgtLosses])
    }),

    /**
     * Deposit Interest Retention Tax on interest a deposit account pays an
     * Irish resident. Added on 13 October 2026 as a new head; nothing above was
     * touched. The tax engine does not compute DIRT. The catalogue holds the
     * rate so that every module that grows cash reads one number.
     *
     * Revenue's DIRT page (published 24 April 2026) gives 33%, deducted by the
     * deposit taker when interest is credited. Budget 2027 (6 October 2026)
     * coverage did not mention it. Exemptions (over 65, incapacity) and
     * special savings accounts are not modelled.
     */
    dirt: Object.freeze({
      ruleId: 'ie.dirt.2026',
      verifiedOn: '2026-10-13',
      rate: 0.33,
      sources: Object.freeze([S.revenueDirt])
    })
  });

/**
 * Budget 2027, announced on 6 October 2026 and published as the Finance (No. 2)
 * Bill 2026 on 19 October 2026. Not yet law: switch `status` to `'enacted'` and
 * add `enactedBy` when the Bill passes, correcting any figure the Oireachtas
 * changes. Every figure below is read from the Department of Finance's Tax
 * Policy Changes book (chapter 2) and checked against the Bill as initiated
 * (ss.2, 3, 29 and 36) and its Explanatory Memorandum. The book's worked
 * tables for single PAYE earners and the self-employed (Tables 2 and 4) are
 * reproduced by the engine from this block, to the euro.
 *
 * Changed for 2027: the standard-rate band, the personal, employee and earned
 * income credits, the home carer credit, and the USC 2% band's ceiling. Nothing
 * else in the book or the Bill touches a figure this catalogue holds, so every
 * other rule is the 2026 object itself.
 */
const TAX_YEAR_2027 = Object.freeze({
  status: 'announced',
  announcedBy: 'Budget 2027',
  announcedOn: '2026-10-06',
  legislation: 'Finance (No. 2) Bill 2026 (Bill No. 98 of 2026), published 19 October 2026',
  verifiedOn: '2026-10-22',

  incomeTax: Object.freeze({
    ruleId: 'ie.income_tax.2027',
    standardRate: 0.20,
    higherRate: 0.40,
    standardRateBand: Object.freeze({
      /** Up 2,500 from 44,000 (book 2.1.1; Bill s.3(a), s.15 TCA). */
      single: 46_500,
      widowed: 46_500,
      /** Up 2,500 from 53,000. */
      marriedOneIncome: 55_500,
      /** Up from 35,000: the most a second income can add, capped at that income. */
      secondIncomeIncreaseMax: 37_500
    }),
    personalCredit: Object.freeze({
      /** Up 125 from 2,000 (s.461(c), as the Bill amends it). */
      single: 2_125,
      /** Up 250 from 4,000 (s.461(a) and (b)). */
      married: 4_250,
      /**
       * Widowed without dependent children. Neither the book nor the Bill states
       * this total. It is the basic personal credit in s.461(c), 2,125, plus the
       * separate widowed person tax credit of 540 in s.461A, which the Bill does
       * not amend: 2,125 + 540. Revenue's 2022 to 2026 table has the widowed
       * credit exactly 540 above the single credit in every year.
       */
      widowed: 2_665
    }),
    employeeCredit: Object.freeze({
      ruleId: 'ie.income_tax.employee_credit.2027',
      /** Up 125 from 2,000 (s.472). The earned income credit (s.472AB) rises the same; together they cannot exceed this. */
      amount: 2_125,
      /** Not changed by the Budget. */
      maxShareOfQualifyingIncome: 0.20
    }),
    ageCredit: TAX_YEAR_2026.incomeTax.ageCredit,
    /** Not touched by the Budget, so it is the 2026 rule itself. */
    nursingHomeExpenses: TAX_YEAR_2026.incomeTax.nursingHomeExpenses,
    /** Said alongside the figure wherever it is shown, so a derived amount is never presented as printed. */
    notes: Object.freeze({
      widowedCredit: 'Derived, not printed in the sources: the 2,125 personal credit (s.461(c)) plus the separate 540 widowed person tax credit (s.461A), which the Bill does not amend.'
    }),
    sources: Object.freeze([S.budget2027TaxPolicyChanges, S.financeNo2Bill2026, S.financeNo2Bill2026Memo, S.section461A])
  }),

  ageExemption: TAX_YEAR_2026.ageExemption,

  usc: Object.freeze({
    ruleId: 'ie.usc.2027',
    exemptionThreshold: 13_000,
    bands: Object.freeze([
      Object.freeze({ upTo: 12_012, rate: 0.005 }),
      /** The 2% ceiling is up 1,600 from 28,700 (book 2.1.2; Bill s.2, s.531AN). */
      Object.freeze({ upTo: 30_300, rate: 0.02 }),
      Object.freeze({ upTo: 70_044, rate: 0.03 }),
      Object.freeze({ upTo: null, rate: 0.08 })
    ]),
    reduced: TAX_YEAR_2026.usc.reduced,
    surcharge: TAX_YEAR_2026.usc.surcharge,
    sources: Object.freeze([S.budget2027TaxPolicyChanges, S.financeNo2Bill2026, S.financeNo2Bill2026Memo])
  }),

  prsi: TAX_YEAR_2026.prsi,
  lumpSum: TAX_YEAR_2026.lumpSum,
  chargeableExcessTax: TAX_YEAR_2026.chargeableExcessTax,
  capitalGainsTax: TAX_YEAR_2026.capitalGainsTax,
  dirt: TAX_YEAR_2026.dirt
});

export const IE_TAX_RULES_BY_YEAR = Object.freeze({
  2026: TAX_YEAR_2026,
  2027: TAX_YEAR_2027
});

export const IE_LEGISLATED_SCHEDULES = Object.freeze({
  /**
   * The PRSI rate for Class A, S and similar contributions, by the date each
   * rise takes effect. A year with a change in it uses one blended rate
   * weighted by months in force (brief, 4.1).
   */
  prsiRate: Object.freeze([
    Object.freeze({ ruleId: 'ie.prsi.rate.2025-10', effectiveFrom: '2025-10-01', rate: 0.042, source: S.prsiStatutoryInstrument }),
    Object.freeze({ ruleId: 'ie.prsi.rate.2026-10', effectiveFrom: '2026-10-01', rate: 0.0435, source: S.prsiStatutoryInstrument }),
    Object.freeze({ ruleId: 'ie.prsi.rate.2027-10', effectiveFrom: '2027-10-01', rate: 0.045, source: S.prsiStatutoryInstrument }),
    Object.freeze({ ruleId: 'ie.prsi.rate.2028-10', effectiveFrom: '2028-10-01', rate: 0.047, source: S.prsiStatutoryInstrument })
  ]),

  standardFundThreshold: Object.freeze({
    /**
     * Each amount fixed in law or published by Revenue, for its own year only.
     * A later year holds the last of these until the next is recorded. Record
     * a published figure with `basis: 'published'` and its source; the law
     * does not let the threshold fall, so a lower figure is refused.
     */
    fixed: Object.freeze([
      Object.freeze({ year: 2026, amount: 2_200_000, basis: 'legislated', source: S.section787O }),
      Object.freeze({ year: 2027, amount: 2_400_000, basis: 'legislated', source: S.section787O }),
      Object.freeze({ year: 2028, amount: 2_600_000, basis: 'legislated', source: S.section787O }),
      Object.freeze({ year: 2029, amount: 2_800_000, basis: 'legislated', source: S.section787O })
    ]),
    /** Never projected past the last known figure (brief, 4.8). */
    afterLastKnown: 'hold',
    /** The first year the law indexes the threshold rather than fixing it. */
    indexedFromYear: 2030,
    indexationNote: 's.787O TCA: indexed to CSO average weekly earnings from 2030; cannot fall'
  }),

  /**
   * The standard CGT rate, by the date of disposal. Development land keeps
   * 33% and is not modelled. `status` follows the rules blocks: `announced`
   * from Budget day, switched to `enacted` when the Finance Act passes.
   *
   * Revenue's history table prints the start of the 33% period as
   * "6 December 2021"; the row before it ends on 5 December 2012, so 2012 is
   * meant. Only disposals from 2026 are calculated, so this changes nothing.
   */
  capitalGainsTaxRate: Object.freeze([
    Object.freeze({
      ruleId: 'ie.cgt.rate.2012-12',
      effectiveFrom: '2012-12-06',
      rate: 0.33,
      status: 'enacted',
      source: S.revenueCgtCalculate
    }),
    Object.freeze({
      ruleId: 'ie.cgt.rate.2026-10',
      effectiveFrom: '2026-10-07',
      rate: 0.31,
      status: 'announced',
      announcedBy: 'Budget 2027',
      announcedOn: '2026-10-06',
      /** Read against the Department's book (4.1) and the Bill (s.36(2): disposals on or after 7 October 2026). */
      verifiedOn: '2026-10-22',
      source: S.budget2027TaxPolicyChanges
    })
  ]),

  /**
   * Exit tax on gains in investment funds and ETFs (investment undertaking tax
   * on Irish funds, the same rate on equivalent EU funds) and on investment
   * life policies (life assurance exit tax), by the date of the chargeable
   * event: a sale, a payment, or the end of each eight-year period. The rate
   * for a personal portfolio investment undertaking (60%) is not modelled.
   *
   * 41% and 38% are transcribed from Revenue's Tax and Duty Manual Part
   * 27-01a-02 (updated January 2026). 35% was announced in Budget 2027 on
   * 6 October 2026, from 1 January 2027, for funds and life policies; checked
   * on 22 October 2026 against the Department's tax policy book (2.2) and the
   * Finance (No. 2) Bill 2026 (s.29: chargeable events, payments and disposals
   * on or after 1 January 2027). Switch it to `enacted` when the Bill passes.
   */
  investmentFundExitTaxRate: Object.freeze([
    Object.freeze({
      ruleId: 'ie.exit_tax.rate.2015',
      effectiveFrom: '2015-01-01',
      rate: 0.41,
      status: 'enacted',
      source: S.revenueInvestmentUndertakings
    }),
    Object.freeze({
      ruleId: 'ie.exit_tax.rate.2026',
      effectiveFrom: '2026-01-01',
      rate: 0.38,
      status: 'enacted',
      enactedBy: 'Finance Act 2025',
      source: S.revenueInvestmentUndertakings
    }),
    Object.freeze({
      ruleId: 'ie.exit_tax.rate.2027',
      effectiveFrom: '2027-01-01',
      rate: 0.35,
      status: 'announced',
      announcedBy: 'Budget 2027',
      announcedOn: '2026-10-06',
      verifiedOn: '2026-10-22',
      source: S.budget2027TaxPolicyChanges
    })
  ])
});

/**
 * Multipliers for indexation relief on disposals in 2004 and later, by the
 * tax year the expenditure was incurred (s.556(6A), inserted by s.65 Finance
 * Act 2003). The table is closed: expenditure from 2003 has no indexation.
 * Transcribed from the statute and checked against Revenue's multiplier table
 * and the worked examples in Tax and Duty Manual Part 19-02-13 (1986/87 is
 * 1.637, 2000/01 is 1.144, 1974/75 is 7.528).
 *
 * Tax years ran from 6 April to 5 April until 2001, which was a short year
 * from 6 April to 31 December. Calendar years apply from 2002.
 */
const INDEXATION_MULTIPLIERS_BY_TAX_YEAR = Object.freeze([
  [1974, 7.528], [1975, 6.080], [1976, 5.238], [1977, 4.490], [1978, 4.148],
  [1979, 3.742], [1980, 3.240], [1981, 2.678], [1982, 2.253], [1983, 2.003],
  [1984, 1.819], [1985, 1.713], [1986, 1.637], [1987, 1.583], [1988, 1.553],
  [1989, 1.503], [1990, 1.442], [1991, 1.406], [1992, 1.356], [1993, 1.331],
  [1994, 1.309], [1995, 1.277], [1996, 1.251], [1997, 1.232], [1998, 1.212],
  [1999, 1.193], [2000, 1.144]
]);

function aprilToAprilPeriod([startYear, multiplier]) {
  const endYear = startYear + 1;
  return Object.freeze({
    period: `${startYear}/${String(endYear).slice(2)}`,
    from: `${startYear}-04-06`,
    to: `${endYear}-04-05`,
    multiplier
  });
}

/**
 * CGT rules fixed by statute for past dates. Budgets do not change these, so
 * they sit outside the yearly blocks and are never projected.
 */
export const IE_CGT_FIXED_RULES = Object.freeze({
  indexation: Object.freeze({
    ruleId: 'ie.cgt.indexation.s556',
    /** Costs from this date need the asset's market value on it, which is not modelled. */
    earliestSupportedAcquisition: '1974-04-06',
    /** Expenditure after this date is not indexed. */
    lastIndexedExpenditure: '2002-12-31',
    periods: Object.freeze([
      ...INDEXATION_MULTIPLIERS_BY_TAX_YEAR.map(aprilToAprilPeriod),
      Object.freeze({ period: '2001', from: '2001-04-06', to: '2001-12-31', multiplier: 1.087 }),
      Object.freeze({ period: '2002', from: '2002-01-01', to: '2002-12-31', multiplier: 1.049 })
    ]),
    sources: Object.freeze([
      S.financeAct2003Section65,
      S.revenueCgtMultipliers,
      S.revenueCgtIndexation,
      S.revenueCgtIndexationManual
    ])
  }),

  /**
   * s.604A: land or buildings in the EEA bought between these dates, at
   * market value (or for at least 75% of it from a relative). Held 4 to 7
   * years and sold from 2018, the whole gain is exempt. Held longer, the
   * exempt share is 7 years over the period of ownership.
   */
  section604A: Object.freeze({
    ruleId: 'ie.cgt.s604a',
    acquiredFrom: '2011-12-07',
    acquiredTo: '2014-12-31',
    exemptYears: 7,
    minimumYears: 4,
    /** Before this date the whole gain was exempt only after 7 years. */
    minimumYearsFromDisposal: '2018-01-01',
    sources: Object.freeze([S.revenueCgt604A, S.revenueCgt604AManual])
  }),

  principalPrivateResidence: Object.freeze({
    ruleId: 'ie.cgt.ppr.s604',
    sources: Object.freeze([S.revenuePpr])
  })
});

/**
 * Investing outside a pension. Neither changes year by year, so neither sits in
 * a Budget block: the eight-year rule is fixed by statute, and the Investment
 * Account is a scheme with its own start date. The tax engine computes none of
 * this. Modules read it to say what an after-tax investment is subject to.
 */
export const IE_INVESTMENT_RULES = Object.freeze({
  /**
   * Units in a fund are treated as sold at the end of each eight-year period
   * after they were bought, and the gain to then is taxed at the exit tax rate.
   * Tax paid this way is set against the tax due when they are finally sold.
   * Budget 2027 left the rule unchanged.
   */
  deemedDisposal: Object.freeze({
    ruleId: 'ie.exit_tax.deemed_disposal',
    status: 'enacted',
    everyYears: 8,
    creditedOnFinalDisposal: true,
    sources: Object.freeze([S.revenueInvestmentUndertakings])
  }),

  /**
   * Announced in Budget 2027 and not yet law, so every figure can change.
   * Providers open it on 1 July 2027: up to €12,000 paid in a year, no exit
   * tax and no deemed disposal, and 1% a year on the value above €50,000.
   * Its name varies in the coverage, so the wording calls it "a new
   * Investment Account". Switch `status` to `enacted` when the Finance Act
   * passes, and correct any figure that changed.
   */
  investmentAccount: Object.freeze({
    ruleId: 'ie.investment_account.2027',
    status: 'announced',
    announcedBy: 'Budget 2027',
    announcedOn: '2026-10-06',
    /** Read against the Department's book (2.3) and the Minister's statement: the terms below, and no CGT, exit tax or deemed disposal. */
    verifiedOn: '2026-10-22',
    opensOn: '2027-07-01',
    annualContributionCap: 12_000,
    taxFreeValue: 50_000,
    annualChargeRate: 0.01,
    exitTax: false,
    deemedDisposal: false,
    sources: Object.freeze([S.budget2027TaxPolicyChanges, S.budget2027Statement])
  })
});
