/**
 * What a client is told alongside every tax figure (brief, section 8).
 *
 * One dictionary from disclosure code to client-facing text. Every figure in
 * the text comes from the rules catalogue, the ARF rule or the result that
 * raised it, through placeholders: none is typed in here, so the sentence
 * moves when the rule does.
 *
 * Wording rules (8.4): plain English, second person, at most two sentences,
 * "estimated" and never "you will pay", no advice, no em dashes.
 */

import {
  IRISH_ARF_MINIMUM_DRAWDOWN,
  irishArfFirstAttainedAge
} from '../ireland_rules.js';
import { IE_LEGISLATED_SCHEDULES } from './rules_ie.js';

/** Whole euro, or "€2.8 million" style for round millions. */
export function formatTaxEuro(amount) {
  const value = Number(amount) || 0;
  if (Math.abs(value) >= 1_000_000 && Math.round(value) % 10_000 === 0) {
    const millions = value / 1_000_000;
    const text = Number.isInteger(millions)
      ? String(millions)
      : millions.toFixed(2).replace(/0$/, '');
    return `€${text} million`;
  }
  return `€${Math.round(value).toLocaleString('en-IE')}`;
}

/** "4%", "4.2375%": as many decimals as the rate has, no trailing zeros. */
function formatTaxRate(rate) {
  const percent = Number((rate * 100).toFixed(6));
  return `${percent}%`;
}

/** "2026", "2026 and 2028", "2031 to 2033 and 2035". */
function formatTaxYears(years) {
  const sorted = [...new Set((years || []).filter(Number.isInteger))].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return '';
  }
  const ranges = [];
  sorted.forEach((year) => {
    const last = ranges[ranges.length - 1];
    if (last && year === last[1] + 1) {
      last[1] = year;
    } else {
      ranges.push([year, year]);
    }
  });
  const parts = ranges.map(([from, to]) => (from === to ? String(from) : `${from} to ${to}`));
  if (parts.length === 1) {
    return parts[0];
  }
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function capitalise(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]);

/** "2026-10-07" as "7 October 2026". */
function formatTaxDate(iso) {
  const [year, month, day] = String(iso || '').split('-').map(Number);
  if (!year || !month || !day) {
    return String(iso || '');
  }
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

const NUMBER_WORDS = Object.freeze([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'
]);

/** 8 as "eight": words for one to ten, digits above. */
function numberWord(value) {
  return Number.isInteger(value) && value >= 0 && value <= 10 ? NUMBER_WORDS[value] : String(value);
}

/** A share of a gain as a whole percentage, for example "52%". */
function formatShare(share) {
  return `${Math.round((Number(share) || 0) * 100)}%`;
}

/** The s.604A purchase dates from the rules, as dates in words. */
function section604ADates(rules) {
  const reliefDates = rules?.capitalGainsTax?.section604A;
  return {
    from: formatTaxDate(reliefDates?.acquiredFrom),
    to: formatTaxDate(reliefDates?.acquiredTo),
    years: reliefDates?.exemptYears
  };
}

/**
 * Every code, in the order it is shown. `kind` says when it appears:
 * `standing` always with a tax figure, `status` as the one status line, and
 * `applied` only when the rule it describes was used.
 */
export const TAX_DISCLOSURE_CATALOGUE = Object.freeze({
  TAX_ESTIMATE: {
    kind: 'standing',
    label: 'Tax estimates',
    render: () => 'Tax figures are estimates to help you understand your position, not a tax calculation or tax advice. They are rounded to the nearest euro.'
  },
  TAX_RULES_HELD: {
    kind: 'standing',
    label: 'Tax rules used',
    render: ({ params, rules }) => {
      // A year's rules are law once an Act has passed. Before that they are the Budget's, and the text says so.
      const enactedBy = params?.enactedBy ?? rules.enactedBy;
      const basis = enactedBy ?? `announced in ${params?.announcedBy ?? rules.announcedBy}, not yet law`;
      return `They use Irish tax rules for ${params?.rulesYear ?? rules.rulesYear} (${basis}). `
        + 'Later years keep the same bands, credits and thresholds in euro terms, so if future Budgets raise them your tax would be lower than shown.';
    }
  },
  TAX_LEGISLATED_CHANGES: {
    kind: 'standing',
    label: 'Changes already in law',
    render: ({ rules }) => {
      const changes = rules.legislatedChanges;
      return 'Changes the law has already fixed by date and amount are included: '
        + `PRSI rises each ${changes.prsiChangeMonth} to ${changes.prsiFinalChangeYear}, `
        + `and the Standard Fund Threshold rises to ${formatTaxEuro(changes.sftLastFixedAmount)} in ${changes.sftLastFixedYear}.`;
    }
  },
  TAX_RESIDENCE: {
    kind: 'standing',
    label: 'Residence',
    render: () => 'This assumes you are resident and domiciled in Ireland for the whole year and that all your income comes from Ireland.'
  },
  TAX_CREDITS_INCLUDED: {
    kind: 'standing',
    label: 'Tax credits',
    render: () => 'Only the personal, employee (PAYE) and age tax credits are included.'
  },
  TAX_AGE_RULE: {
    kind: 'standing',
    label: 'Age rules',
    render: () => 'Age-related rules apply for the whole of the year in which you reach that age.'
  },
  STATUS_JOINT: {
    kind: 'status',
    label: 'Tax status',
    render: () => 'You are assessed jointly as a married couple or civil partners.'
  },
  STATUS_SINGLE: {
    kind: 'status',
    label: 'Tax status',
    render: () => 'You are assessed as a single person.'
  },
  STATUS_WIDOWED: {
    kind: 'status',
    label: 'Tax status',
    render: () => 'You are assessed as a widowed person or surviving civil partner without dependent children.'
  },
  STATUS_DEFAULT_SINGLE: {
    kind: 'status',
    label: 'Tax status',
    render: () => "Your tax status wasn't given, so each of you is assessed as a single person. If you are married or in a civil partnership, your tax would usually be lower."
  },
  STATUS_SPOUSE_NO_INCOME: {
    kind: 'applied',
    label: 'Spouse or civil partner',
    render: () => 'Your spouse or civil partner is assumed to have no income.'
  },
  WITHDRAWAL_SPLIT: {
    kind: 'applied',
    label: 'Pension withdrawals',
    render: () => "Withdrawals come from each person's pension in proportion to its size, not arranged to reduce tax."
  },
  USC_STATE_PENSION_EXEMPT: {
    kind: 'applied',
    label: 'USC on the State Pension',
    render: () => 'The State Pension is not subject to USC.'
  },
  USC_REDUCED_70: {
    kind: 'applied',
    label: 'Reduced USC',
    render: ({ rules }) => (
      `Reduced USC rates apply from age ${rules.usc.reduced.fromAge} while your income, not counting the State Pension, `
      + `is ${formatTaxEuro(rules.usc.reduced.aggregateIncomeCeiling)} or less.`
    )
  },
  USC_SURCHARGE: {
    kind: 'applied',
    label: 'USC surcharge',
    render: ({ rules }) => (
      `Rental profit above ${formatTaxEuro(rules.usc.surcharge.nonPayeThreshold)} a year pays an extra `
      + `${formatTaxRate(rules.usc.surcharge.rate)} USC.`
    )
  },
  IT_AGE_EXEMPTION: {
    kind: 'applied',
    label: 'Age exemption',
    render: ({ params, rules }) => (
      `In ${formatTaxYears(params?.years)}, income is within the over-${rules.ageExemption.fromAge} exemption limit, so no income tax is due.`
    )
  },
  IT_MARGINAL_RELIEF: {
    kind: 'applied',
    label: 'Age marginal relief',
    render: ({ params, rules }) => (
      `In ${formatTaxYears(params?.years)}, marginal relief for people over ${rules.ageExemption.fromAge} lowers the income tax due.`
    )
  },
  PRSI_UNTIL_SPC: {
    kind: 'applied',
    label: 'PRSI',
    render: ({ rules }) => (
      'PRSI is charged on pension withdrawals, rent and earnings until the State Pension (Contributory) starts '
      + `or you reach ${rules.prsi.exemptFromAge}.`
    )
  },
  PRSI_PRE_2024_COHORT: {
    kind: 'applied',
    label: 'PRSI and your age',
    render: ({ rules }) => (
      `You reached ${rules.prsi.liableUnderAge} before ${rules.prsi.reached66BeforeYear}, so PRSI stops at ${rules.prsi.liableUnderAge}.`
    )
  },
  PRSI_BLENDED: {
    kind: 'applied',
    label: 'PRSI rate changes',
    render: () => 'Where the PRSI rate changes during a year, one blended rate is used, assuming income is spread evenly across the year.'
  },
  PRSI_NONE_ON_PENSIONS: {
    kind: 'applied',
    label: 'PRSI on pensions',
    render: () => 'No PRSI is charged on the State Pension or occupational pensions.'
  },
  RENT_AS_ENTERED: {
    kind: 'applied',
    label: 'Rent',
    render: () => 'Rent is taxed on the amount entered, treated as profit after expenses.'
  },
  RENT_SPLIT_JOINT: {
    kind: 'applied',
    label: 'Shared rent',
    render: () => 'Rent is split equally between you.'
  },
  OTHER_INCOME_AS_PENSION: {
    kind: 'applied',
    label: 'Other income',
    render: ({ params }) => `${capitalise(params?.title || 'Other income')} is taxed like an Irish occupational pension.`
  },
  LUMP_SUM_RULES: {
    kind: 'applied',
    label: 'Retirement lump sums',
    render: ({ rules }) => {
      const lumpSum = rules.lumpSum;
      return `Retirement lump sums: the first ${formatTaxEuro(lumpSum.lifetimeTaxFree)} over your lifetime is tax-free, `
        + `the next ${formatTaxEuro(lumpSum.standardRateCeiling - lumpSum.lifetimeTaxFree)} is taxed at ${formatTaxRate(lumpSum.standardRate)}, `
        + 'and anything above that is taxed as income at your top rate.';
    }
  },
  LUMP_SUM_PRIOR: {
    kind: 'applied',
    label: 'Earlier lump sums',
    render: ({ params }) => `Earlier lump sums of ${formatTaxEuro(params?.amount)} already count towards those limits.`
  },
  LUMP_SUM_AS_CASH: {
    kind: 'applied',
    label: 'Lump sum as cash',
    render: () => 'The lump sum is shown as cash at retirement. It is not used to fund your income in this projection.'
  },
  LUMP_SUM_ABOVE_25: {
    kind: 'applied',
    label: 'Lump sum size',
    render: ({ rules }) => `A lump sum above ${formatTaxRate(rules.lumpSum.maxShareOfFund)} of the fund is assumed to be allowed by your scheme's rules.`
  },
  SFT_THRESHOLD: {
    kind: 'applied',
    label: 'Standard Fund Threshold',
    render: ({ params }) => `The Standard Fund Threshold used for ${formatTaxYears(params?.years)} is ${formatTaxEuro(params?.amount)}.`
  },
  SFT_HELD: {
    kind: 'applied',
    label: 'Standard Fund Threshold held',
    render: ({ params }) => (
      `From ${IE_LEGISLATED_SCHEDULES.standardFundThreshold.indexedFromYear} the law raises the threshold in line with average weekly earnings `
      + 'and it can never fall, but future earnings growth cannot be predicted, '
      + `so it is held here at ${formatTaxEuro(params?.heldAmount)}, its lowest possible level. `
      + `Any chargeable excess tax shown for ${formatTaxYears(params?.years)} may therefore be overstated.`
    )
  },
  SFT_CET: {
    kind: 'applied',
    label: 'Chargeable excess tax',
    render: ({ params }) => (
      `The amount above the threshold is taxed at ${formatTaxRate(params?.rate)} and paid from the fund before the rest moves to drawdown.`
    )
  },
  SFT_CREDIT: {
    kind: 'applied',
    label: 'Lump sum tax credit',
    render: ({ params, rules }) => {
      const first = `The ${formatTaxRate(rules.lumpSum.standardRate)} tax on your lump sum is set against that charge.`;
      return params?.amount > 0
        ? `${first} ${formatTaxEuro(params.amount)} of unused credit carries forward.`
        : first;
    }
  },
  SFT_ALREADY_USED: {
    kind: 'applied',
    label: 'Threshold already used',
    render: ({ params }) => `${formatTaxEuro(params?.amount)} of your threshold is treated as already used by earlier benefits.`
  },
  ARF_MINIMUM: {
    kind: 'applied',
    label: 'Minimum ARF withdrawals',
    render: () => {
      const rule = IRISH_ARF_MINIMUM_DRAWDOWN;
      return `Minimum ARF withdrawals are modelled as taken: ${formatTaxRate(rule.baseRate)} a year from the year you turn ${irishArfFirstAttainedAge('base')}, `
        + `${formatTaxRate(rule.higherRate)} from the year you turn ${irishArfFirstAttainedAge('higher')}, `
        + `and ${formatTaxRate(rule.highValueRate)} while the fund is above ${formatTaxEuro(rule.highValueThresholdEur)}. `
        + "They are based on the fund's value at the start of each year.";
    }
  },
  NET_TARGET: {
    kind: 'applied',
    label: 'After-tax target',
    render: () => 'Your target is after tax. Withdrawals are set each year so that your income after income tax, USC and PRSI meets it.'
  },
  NET_COST_CONTRIBUTIONS: {
    kind: 'applied',
    label: 'Net cost of contributions',
    render: () => 'Net cost is after income tax relief at your top rate. USC and PRSI are still paid on pension contributions.'
  },
  CGT_RATE: {
    kind: 'applied',
    label: 'Capital gains tax',
    render: ({ params, rules }) => (
      `Capital gains tax on the sale is estimated at ${formatTaxRate(params?.rate)} of the gain above each owner's `
      + `annual exemption of ${formatTaxEuro(params?.exemption ?? rules?.capitalGainsTax?.annualExemption)}.`
    )
  },
  CGT_RATE_ANNOUNCED: {
    kind: 'applied',
    label: 'New capital gains tax rate',
    render: ({ params }) => (
      `The ${formatTaxRate(params?.rate)} rate was announced in ${params?.announcedBy} for sales from ${formatTaxDate(params?.effectiveFrom)}. `
      + 'It could change before the Finance Act is passed.'
    )
  },
  CGT_HOME_EXEMPT: {
    kind: 'applied',
    label: 'Your home',
    render: () => 'No tax on the gain is included, because the property is taken to have been your only or main home for the whole time you owned it.'
  },
  CGT_HOME_PART: {
    kind: 'applied',
    label: 'Your former home',
    render: () => 'As the property was your home for part of the time you owned it, part of the gain may be exempt. Your tax could be lower than the estimate shown.'
  },
  CGT_HOME_UNKNOWN: {
    kind: 'applied',
    label: 'If it was your home',
    render: () => 'If this property was your home for part of the time you owned it, part of the gain may be exempt. Your tax could be lower than the estimate shown.'
  },
  CGT_INDEXATION: {
    kind: 'applied',
    label: 'Inflation relief',
    render: ({ params }) => (
      `What you paid in ${params?.period} is increased by Revenue's inflation multiplier of ${params?.multiplier} before the gain is worked out.`
    )
  },
  CGT_INDEXATION_NO_GAIN: {
    kind: 'applied',
    label: 'Inflation relief',
    render: ({ params }) => (
      `After Revenue's inflation multiplier of ${params?.multiplier} for ${params?.period}, the sale makes neither a gain nor a loss for tax purposes.`
    )
  },
  CGT_2011_2014: {
    kind: 'applied',
    label: 'Bought from 2011 to 2014',
    render: ({ params, rules }) => {
      const reliefDates = section604ADates(rules);
      const share = Number(params?.share) || 0;
      const lead = `Because you bought the property between ${reliefDates.from} and ${reliefDates.to}`;
      const sentence = share >= 1
        ? `${lead}, the whole gain is exempt.`
        : `${lead} and have owned it for more than ${reliefDates.years} years, ${formatShare(share)} of the gain is exempt.`;
      return `${sentence} This assumes you paid its full market value.`;
    }
  },
  CGT_2011_2014_NOT_BOUGHT: {
    kind: 'applied',
    label: 'Bought from 2011 to 2014',
    render: ({ rules }) => {
      const reliefDates = section604ADates(rules);
      return `The relief for property bought between ${reliefDates.from} and ${reliefDates.to} is not applied, because it covers only property bought at market value.`;
    }
  },
  CGT_COSTS_ENTERED: {
    kind: 'applied',
    label: 'Costs deducted',
    render: () => 'Only the price paid and the selling costs entered are deducted from the sale price. Buying costs such as stamp duty and legal fees, and money spent improving the property, would lower the tax.'
  },
  CGT_BASE_COST_ASSUMED_ZERO: {
    kind: 'applied',
    label: 'Base cost assumed to be zero',
    render: () => 'Base cost not supplied. This illustration assumes a €0 base cost, so the full sale value is treated as a gain before applicable costs and allowances.'
  },
  CGT_ACQUISITION_DATE_UNKNOWN: {
    kind: 'applied',
    label: 'Acquisition date not supplied',
    render: () => 'No indexation relief is included because the acquisition date was not supplied.'
  },
  CGT_INVESTMENT_SCOPE: {
    kind: 'applied',
    label: 'Investment sale estimate',
    render: () => 'This is an ordinary CGT investment sale, using the stated or disclosed assumed tax base cost and selling costs. Funds and ETFs, special share schemes, connected-party transactions and share-lot identification are outside this estimate.'
  },
  CGT_SCOPE: {
    kind: 'applied',
    label: 'What is assumed',
    render: () => 'This assumes the property is not development land and is not sold to a family member or other connected person.'
  },
  CGT_JOINT_SPLIT: {
    kind: 'applied',
    label: 'Owned together',
    render: () => 'The gain is split equally between you, and each of you has your own annual exemption.'
  },
  CGT_OTHER_GAINS: {
    kind: 'applied',
    label: 'Other gains and losses',
    render: () => 'This assumes you have no gains or losses this year beyond those shown, and no unused losses from earlier years.'
  },
  CGT_LOSSES_USED: {
    kind: 'applied',
    label: 'Earlier losses',
    render: ({ params }) => `Unused losses of ${formatTaxEuro(params?.amount)} from earlier years are set against the gain.`
  },
  CGT_LOSS_SPOUSE: {
    kind: 'applied',
    label: 'Losses between you',
    render: ({ params }) => (
      `A loss of ${formatTaxEuro(params?.amount)} made by one of you is set against the other's gains, as happens automatically when you are assessed jointly.`
    )
  },
  CGT_LOSS_CARRIED: {
    kind: 'applied',
    label: 'Loss carried forward',
    render: ({ params }) => `The loss of ${formatTaxEuro(params?.amount)} that is not used this year can be set against gains in later years.`
  },
  PENSION_AT_RELIEF_LIMIT: {
    kind: 'applied',
    label: 'Pension at the relief limit',
    render: ({ params }) => {
      const limit = params && Number.isFinite(params.share) && Number.isFinite(params.earningsCap)
        ? `, ${formatTaxRate(params.share)} of earnings up to ${formatTaxEuro(params.earningsCap)}`
        : '';
      return `Your pension contributions are at the most income tax relief allows at your age${limit}. `
        + 'Money you invest beyond that gets no income tax relief.';
    }
  },
  INVESTMENT_FUND_TAX: {
    kind: 'applied',
    label: 'Tax on investment funds',
    render: ({ params, rules }) => {
      const years = rules?.investmentFunds?.deemedDisposal?.everyYears;
      return `Gains on investment funds, ETFs and investment life policies are taxed at ${formatTaxRate(params?.rate)} when you sell, `
        + `and every ${numberWord(years)} years as if you had sold, even if you have not. `
        + `Tax paid at each ${numberWord(years)}-year point is set against the tax due when you finally sell.`;
    }
  },
  INVESTMENT_FUND_TAX_ANNOUNCED: {
    kind: 'applied',
    label: 'New exit tax rate',
    render: ({ params }) => {
      const lead = params?.inForce
        ? `The ${formatTaxRate(params?.rate)} rate was announced in ${params?.announcedBy} for gains from ${formatTaxDate(params?.effectiveFrom)}.`
        : `A cut to ${formatTaxRate(params?.rate)} from ${formatTaxDate(params?.effectiveFrom)} was announced in ${params?.announcedBy}.`;
      return `${lead} It could change before the Finance Act is passed.`;
    }
  },
  INVESTMENT_ACCOUNT: {
    kind: 'applied',
    label: 'The Investment Account',
    render: ({ params, rules }) => {
      const account = rules?.investmentFunds?.investmentAccount || {};
      const years = rules?.investmentFunds?.deemedDisposal?.everyYears;
      const terms = `up to ${formatTaxEuro(account.annualContributionCap)} a year with no exit tax and no ${numberWord(years)}-year charge, `
        + `and ${formatTaxRate(account.annualChargeRate)} a year on its value above ${formatTaxEuro(account.taxFreeValue)}`;
      if (account.status === 'announced') {
        return `A new Investment Account was announced in ${account.announcedBy} to open on ${formatTaxDate(account.opensOn)}, taking ${terms}. `
          + 'The details could change before they become law.';
      }
      if (params?.asOf && params.asOf < account.opensOn) {
        return `A new Investment Account opens on ${formatTaxDate(account.opensOn)}, taking ${terms}.`;
      }
      return `The Investment Account takes ${terms}.`;
    }
  }
});

export const DISCLOSURE_ORDER = Object.freeze(Object.keys(TAX_DISCLOSURE_CATALOGUE));

/** The standing "not included" list (8.3), with a short form for the compact line. */
export const TAX_NOT_INCLUDED = Object.freeze([
  Object.freeze({
    id: 'other_credits',
    short: 'other tax credits and reliefs',
    text: 'Other tax credits and reliefs, including medical expenses, rent, mortgage interest, home carer, dependent relative, blind person and single person child carer credits, and higher exemption limits for dependent children.'
  }),
  Object.freeze({
    id: 'medical_card_usc',
    short: 'the medical card USC rate',
    text: 'The reduced USC rate for medical card holders.'
  }),
  Object.freeze({
    id: 'state_pension_extras',
    short: 'deferred State Pension increases and the Qualified Adult Increase',
    text: 'The higher State Pension for claiming after 66, and the Qualified Adult Increase.'
  }),
  Object.freeze({
    id: 'investment_tax',
    short: 'tax on savings and investments outside pensions, other than capital gains tax on property',
    text: 'Tax on savings and investments outside pensions: DIRT, exit tax, dividends, and capital gains tax on anything other than property.'
  }),
  Object.freeze({
    id: 'foreign',
    short: 'foreign pensions and non-residence',
    text: 'Foreign pensions, non-residence and double taxation agreements.'
  }),
  Object.freeze({
    id: 'annuity',
    short: 'buying an annuity',
    text: 'Buying an annuity at retirement. All drawdown is modelled through an ARF.'
  }),
  Object.freeze({
    id: 'personal_fund_threshold',
    short: 'the Personal Fund Threshold and valuing defined benefit pensions',
    text: 'The Personal Fund Threshold, and valuing defined benefit pensions against the SFT (enter any threshold already used instead).'
  }),
  Object.freeze({
    id: 'prsi_extras',
    short: 'PRSI Class K and the PRSI credit',
    text: 'PRSI Class K, minimum PRSI contributions and the PRSI credit for low earners.'
  }),
  Object.freeze({
    id: 'auto_enrolment',
    short: 'auto-enrolment',
    text: 'Auto-enrolment (MyFutureFund) contributions, which get a State top-up rather than tax relief.'
  }),
  Object.freeze({
    id: 'death',
    short: 'tax on death',
    text: 'Tax on death, including inherited ARFs and capital acquisitions tax.'
  }),
  Object.freeze({
    id: 'life_events',
    short: 'pension adjustment orders and part years',
    text: 'Pension adjustment orders, the years of marriage, separation or bereavement, and part-year residence.'
  })
]);

/** The compact "Not included" line. */
export function taxNotIncludedLine() {
  const parts = TAX_NOT_INCLUDED.map((entry) => entry.short);
  return `${capitalise(parts.slice(0, -1).join('; '))}; ${parts[parts.length - 1]}.`;
}

/** One disclosure as client text. `rules` is a resolved rules object (resolveTaxRules). */
export function renderTaxDisclosure(disclosure, { rules }) {
  const entry = TAX_DISCLOSURE_CATALOGUE[disclosure?.code];
  if (!entry) {
    throw new Error(`Unknown tax disclosure code: ${disclosure?.code}.`);
  }
  return {
    code: disclosure.code,
    kind: entry.kind,
    label: entry.label,
    text: entry.render({ params: disclosure.params || null, rules })
  };
}

/** Every disclosure in a result, as client text, in catalogue order. */
export function renderTaxDisclosures(disclosures, { rules }) {
  return (disclosures || []).map((disclosure) => renderTaxDisclosure(disclosure, { rules }));
}
