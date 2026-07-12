const CENTRAL_BANK_SOURCE = 'https://www.centralbank.ie/financial-system/financial-stability/macro-prudential-policy/mortgage-measures';
const REVENUE_HTB_SOURCE = 'https://www.revenue.ie/en/property/help-to-buy-incentive/index.aspx';
const REVENUE_HTB_BUYER_SOURCE = 'https://www.revenue.ie/en/property/help-to-buy-incentive/who-can-claim-htb.aspx';
const REVENUE_HTB_PROPERTY_SOURCE = 'https://www.revenue.ie/en/property/help-to-buy-incentive/what-type-of-property-qualifies.aspx';
const REVENUE_HTB_AMOUNT_SOURCE = 'https://www.revenue.ie/en/property/help-to-buy-incentive/how-much-can-you-claim.aspx';
const REVENUE_STAMP_DUTY_SOURCE = 'https://www.revenue.ie/en/property/stamp-duty/property/stamp-duty-property/rates.aspx';
const REVENUE_DIRT_SOURCE = 'https://www.revenue.ie/en/additional-incomes/dirt/what-dirt-rate-is-applicable.aspx';
const FHS_SOURCE = 'https://www.firsthomescheme.ie/';
const FHS_ELIGIBILITY_SOURCE = 'https://www.firsthomescheme.ie/about-the-scheme/eligibility/';
const FHS_RULES_SOURCE = 'https://www.firsthomescheme.ie/faqs/rules-and-eligibility/';
const FHS_CEILINGS_SOURCE = 'https://www.firsthomescheme.ie/about-the-scheme/property-price-ceilings/';
const FHS_CHARGES_SOURCE = 'https://www.firsthomescheme.ie/about-the-scheme/service-charges/';
const FHS_LENDERS_SOURCE = 'https://www.firsthomescheme.ie/about-the-scheme/switching-your-mortgage/';

export const HOUSE_PURCHASE_SOURCE_METADATA = Object.freeze({
  centralBankMortgageMeasures: Object.freeze({
    label: 'Central Bank of Ireland mortgage measures',
    url: CENTRAL_BANK_SOURCE,
    asOfDate: '2026-07-11'
  }),
  stampDuty: Object.freeze({
    label: 'Revenue residential Stamp Duty rates',
    url: REVENUE_STAMP_DUTY_SOURCE,
    asOfDate: '2026-07-11'
  }),
  helpToBuy: Object.freeze({
    label: 'Revenue Help to Buy',
    url: REVENUE_HTB_SOURCE,
    supportingUrls: Object.freeze([
      REVENUE_HTB_BUYER_SOURCE,
      REVENUE_HTB_PROPERTY_SOURCE,
      REVENUE_HTB_AMOUNT_SOURCE
    ]),
    asOfDate: '2026-07-11'
  }),
  firstHomeScheme: Object.freeze({
    label: 'First Home Scheme',
    url: FHS_SOURCE,
    supportingUrls: Object.freeze([
      FHS_ELIGIBILITY_SOURCE,
      FHS_RULES_SOURCE,
      FHS_CEILINGS_SOURCE,
      FHS_CHARGES_SOURCE,
      FHS_LENDERS_SOURCE
    ]),
    verifiedOn: '2026-07-11'
  }),
  depositGrowth: Object.freeze({
    label: 'Illustrative accessible-deposit return and DIRT',
    url: REVENUE_DIRT_SOURCE,
    supportingUrls: Object.freeze([
      'https://personalbanking.bankofireland.com/save-and-invest/savings/regular-savings-accounts/mortgagesaver/',
      'https://www.aib.ie/our-products/savings-and-deposits/Deposit-Rates',
      'https://www.ptsb.ie/saving-and-investing/savings-accounts/regular-saver/'
    ]),
    asOfDate: '2026-07-11'
  })
});

const ceiling = (code, localAuthority, amount, apartment = amount, selfBuild = amount, aliases = []) => Object.freeze({
  code,
  localAuthority,
  house: amount,
  apartment,
  selfBuild,
  effectiveDate: null,
  verifiedOn: '2026-07-11',
  sourceUrl: FHS_CEILINGS_SOURCE,
  aliases: Object.freeze(aliases)
});

/**
 * The complete 31-authority FHS ceiling table verified from the official page.
 * The source does not expose a reliable effective date, so effectiveDate is null
 * and verifiedOn records the date on which the live table was checked.
 */
export const FHS_PRICE_CEILINGS = Object.freeze([
  ceiling('carlow_county', 'Carlow County', 375000, 375000, 375000, ['carlow', 'cw']),
  ceiling('cavan_county', 'Cavan County', 375000, 375000, 375000, ['cavan', 'cn']),
  ceiling('clare_county', 'Clare County', 400000, 400000, 400000, ['clare', 'ce']),
  ceiling('cork_city', 'Cork City', 500000, 500000, 500000, ['cork city council', 'cc']),
  ceiling('cork_county', 'Cork County', 450000, 450000, 450000, ['cork county council', 'co']),
  ceiling('donegal_county', 'Donegal County', 400000, 400000, 400000, ['donegal', 'dl']),
  ceiling('dublin_city', 'Dublin City', 500000, 500000, 500000, ['dublin city council', 'dcc']),
  ceiling('dun_laoghaire_rathdown', 'D\u00fan Laoghaire-Rathdown', 500000, 500000, 500000, ['d\u00fan laoghaire rathdown', 'dun laoghaire-rathdown', 'dlr']),
  ceiling('fingal', 'Fingal', 500000, 500000, 500000, ['fingal county', 'fingal county council', 'fcc']),
  ceiling('galway_city', 'Galway City', 475000, 475000, 475000, ['galway city council', 'gc']),
  ceiling('galway_county', 'Galway County', 450000, 450000, 450000, ['galway county council', 'g']),
  ceiling('kerry_county', 'Kerry County', 425000, 425000, 425000, ['kerry', 'ky']),
  ceiling('kildare_county', 'Kildare County', 475000, 475000, 475000, ['kildare', 'ke']),
  ceiling('kilkenny_county', 'Kilkenny County', 400000, 400000, 400000, ['kilkenny', 'kk']),
  ceiling('laois_county', 'Laois County', 400000, 400000, 400000, ['laois', 'ls']),
  ceiling('leitrim_county', 'Leitrim County', 400000, 400000, 400000, ['leitrim', 'lm']),
  ceiling('limerick_city_and_county', 'Limerick City and County', 450000, 450000, 450000, ['limerick', 'limerick city & county', 'lk']),
  ceiling('longford_county', 'Longford County', 375000, 375000, 375000, ['longford', 'ld']),
  ceiling('louth_county', 'Louth County', 425000, 425000, 425000, ['louth', 'lh']),
  ceiling('mayo_county', 'Mayo County', 425000, 425000, 425000, ['mayo', 'mo']),
  ceiling('meath_county', 'Meath County', 475000, 475000, 475000, ['meath', 'mh']),
  ceiling('monaghan_county', 'Monaghan County', 375000, 375000, 375000, ['monaghan', 'mn']),
  ceiling('offaly_county', 'Offaly County', 375000, 375000, 375000, ['offaly', 'oy']),
  ceiling('roscommon_county', 'Roscommon County', 400000, 400000, 400000, ['roscommon', 'rn']),
  ceiling('sligo_county', 'Sligo County', 400000, 400000, 400000, ['sligo', 'so']),
  ceiling('south_dublin', 'South Dublin', 500000, 500000, 500000, ['south dublin county', 'south dublin county council', 'sdcc']),
  ceiling('tipperary_county', 'Tipperary County', 375000, 375000, 375000, ['tipperary', 'ta']),
  ceiling('waterford_city_and_county', 'Waterford City and County', 400000, 450000, 400000, ['waterford', 'waterford city & county', 'wd']),
  ceiling('westmeath_county', 'Westmeath County', 400000, 400000, 400000, ['westmeath', 'wh']),
  ceiling('wexford_county', 'Wexford County', 400000, 400000, 400000, ['wexford', 'wx']),
  ceiling('wicklow_county', 'Wicklow County', 500000, 500000, 500000, ['wicklow', 'ww'])
]);

export const FHS_PRICE_CEILING_ROWS = Object.freeze(FHS_PRICE_CEILINGS.flatMap((entry) => [
  Object.freeze({
    localAuthorityCode: entry.code,
    localAuthority: entry.localAuthority,
    propertyType: 'house',
    ceiling: entry.house,
    effectiveDate: entry.effectiveDate,
    verifiedOn: entry.verifiedOn,
    sourceUrl: entry.sourceUrl
  }),
  Object.freeze({
    localAuthorityCode: entry.code,
    localAuthority: entry.localAuthority,
    propertyType: 'apartment',
    ceiling: entry.apartment,
    effectiveDate: entry.effectiveDate,
    verifiedOn: entry.verifiedOn,
    sourceUrl: entry.sourceUrl
  }),
  Object.freeze({
    localAuthorityCode: entry.code,
    localAuthority: entry.localAuthority,
    propertyType: 'self_build',
    ceiling: entry.selfBuild,
    effectiveDate: entry.effectiveDate,
    verifiedOn: entry.verifiedOn,
    sourceUrl: entry.sourceUrl
  })
]));

export const HOUSE_PURCHASE_RULES = Object.freeze({
  schemaVersion: 1,
  asOfDate: '2026-07-11',
  verifiedOn: '2026-07-11',

  // Flat aliases are intentionally retained for prompt-pack and dev-panel use.
  firstTimeBuyerIncomeMultiple: 4,
  secondSubsequentBuyerIncomeMultiple: 3.5,
  principalHomeMaxLtv: 0.9,
  minimumDepositRate: 0.1,
  dirtRate: 0.33,
  depositSavingsGrossAerDefault: 0.02,
  depositSavingsNetAerDefault: 0.0134,
  mortgageRateIllustrationDefault: 0.035,
  maximumMortgageTermYearsDefault: 35,

  mortgage: Object.freeze({
    firstTimeBuyerIncomeMultiple: 4,
    secondSubsequentBuyerIncomeMultiple: 3.5,
    principalHomeMaxLtv: 0.9,
    minimumDepositRate: 0.1,
    illustrationRateDefault: 0.035,
    termYearsDefault: 35,
    sensitivityTermsYears: Object.freeze([25, 30, 35]),
    sensitivityRateDelta: 0.01,
    asOfDate: '2026-07-11',
    sources: Object.freeze([CENTRAL_BANK_SOURCE])
  }),
  reserve: Object.freeze({
    recommendedMonths: 6,
    liquiditySafetyFloorMonths: 3
  }),
  depositSavings: Object.freeze({
    grossAerDefault: 0.02,
    dirtRateDefault: 0.33,
    netAerDefault: 0.0134,
    projectionHorizonMonths: 600,
    asOfDate: '2026-07-11',
    sources: Object.freeze([
      REVENUE_DIRT_SOURCE,
      'https://personalbanking.bankofireland.com/save-and-invest/savings/regular-savings-accounts/mortgagesaver/',
      'https://www.aib.ie/our-products/savings-and-deposits/Deposit-Rates',
      'https://www.ptsb.ie/saving-and-investing/savings-accounts/regular-saver/'
    ])
  }),
  stampDuty: Object.freeze({
    bands: Object.freeze([
      Object.freeze({ upTo: 1000000, rate: 0.01 }),
      Object.freeze({ upTo: 1500000, rate: 0.02 }),
      Object.freeze({ upTo: null, rate: 0.06 })
    ]),
    asOfDate: '2026-07-11',
    sources: Object.freeze([REVENUE_STAMP_DUTY_SOURCE])
  }),
  purchaseCosts: Object.freeze({
    legalAndConveyancing: 3200,
    valuation: 200,
    surveyOrEngineerByAcquisition: Object.freeze({
      new_build: 400,
      second_hand: 600,
      self_build: 800,
      tenant_purchase: 600,
      unknown: 600
    }),
    movingAndFurnishing: 5000,
    contingency: 2500
  }),
  helpToBuy: Object.freeze({
    maximumRelief: 30000,
    maximumPrice: 500000,
    priceShare: 0.1,
    minimumQualifyingMortgageShare: 0.7,
    schemeEndDateIso: '2029-12-31',
    asOfDate: '2026-07-11',
    sources: Object.freeze([
      REVENUE_HTB_SOURCE,
      REVENUE_HTB_BUYER_SOURCE,
      REVENUE_HTB_PROPERTY_SOURCE,
      REVENUE_HTB_AMOUNT_SOURCE
    ])
  }),
  firstHomeScheme: Object.freeze({
    minimumApplicantAge: 18,
    minimumDepositRate: 0.1,
    minimumEquityShare: 0.025,
    minimumEquityAmount: 10000,
    maximumShareWithoutHtb: 0.3,
    maximumShareWithHtb: 0.2,
    participatingLenderIds: Object.freeze(['aib', 'ebs', 'haven', 'bank_of_ireland', 'ptsb']),
    serviceChargeBands: Object.freeze([
      Object.freeze({ fromYear: 0, toYear: 5, rate: 0 }),
      Object.freeze({ fromYear: 6, toYear: 15, rate: 0.0175 }),
      Object.freeze({ fromYear: 16, toYear: 29, rate: 0.0215 }),
      Object.freeze({ fromYear: 30, toYear: null, rate: 0.0285 })
    ]),
    priceCeilings: FHS_PRICE_CEILINGS,
    effectiveDate: null,
    verifiedOn: '2026-07-11',
    sources: Object.freeze([
      FHS_SOURCE,
      FHS_ELIGIBILITY_SOURCE,
      FHS_RULES_SOURCE,
      FHS_CEILINGS_SOURCE,
      FHS_CHARGES_SOURCE,
      FHS_LENDERS_SOURCE
    ])
  }),
  disclosures: Object.freeze([
    'Plan\u00e9ir provides educational financial-planning illustrations only. It does not provide mortgage approval, regulated financial advice, tax advice or legal advice.',
    'Mortgage lending is subject to each lender\u2019s underwriting, affordability assessment, lending criteria and approval.',
    'Government-scheme rules, price ceilings, participating lenders, tax rules and interest rates can change. Confirm current eligibility with the relevant official body before acting.',
    'Savings and mortgage rates shown are assumptions unless explicitly marked as live data.'
  ]),
  sources: HOUSE_PURCHASE_SOURCE_METADATA
});

export const DEFAULT_HOUSE_PURCHASE_RULES = HOUSE_PURCHASE_RULES;

