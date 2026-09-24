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
 */

export const IE_TAX_RULES_VERSION = 'ie-tax-2026.1';

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
  })
});

const S = IE_TAX_SOURCES;

export const IE_TAX_RULES_BY_YEAR = Object.freeze({
  2026: Object.freeze({
    status: 'enacted',
    enactedBy: 'Finance Act 2025',
    verifiedOn: '2026-09-22',

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
    })
  })
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
  })
});
