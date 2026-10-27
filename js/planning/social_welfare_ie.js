/**
 * Irish social welfare payments: the weekly personal rate of each, by the date
 * it takes effect. Data only.
 *
 * Every rate here is read from a page of the Department of Social Protection on
 * gov.ie, as verified on the date each row records: the Budget rates table for
 * the year, and the scheme's own page where it prints the rate. None comes from
 * memory or from a third-party summary. The rates are the highest personal rate
 * of each scheme: a person with a shorter contribution record, or lower
 * earnings, gets less, and nothing here is an entitlement.
 *
 * Which rate applies to a date: the last row whose `effectiveFrom` is on or
 * before it. A date after the last row holds the last rate, which is how a
 * Budget not yet recorded is treated. `status` follows the tax catalogue:
 * `announced` from Budget day, switched to `in_force` when the rate is payable.
 *
 * Keeping it current: add a Budget's rates as new rows on Budget day with
 * `status: 'announced'`, never edit a past row, set `verifiedOn` to the day the
 * page was read, and bump `SOCIAL_WELFARE_RATES_VERSION`.
 *
 * What a person receives per year is the weekly rate times 52, which is how the
 * protection references express it. It is a comparison, not a forecast of a
 * first claim year.
 */

export const SOCIAL_WELFARE_RATES_VERSION = 'ie-social-welfare-2026.3';

const SOCIAL_WELFARE_SOURCES = Object.freeze({
  dspBudget2026: Object.freeze({
    title: 'Department of Social Protection, Budget 2026 (maximum weekly rates from January 2026)',
    url: 'https://www.gov.ie/en/department-of-social-protection/publications/budget-2026/',
    publishedOn: '2025-10-07'
  }),
  dspBudget2027: Object.freeze({
    title: 'Department of Social Protection, Budget 2027 (maximum weekly rates from January 2027)',
    url: 'https://www.gov.ie/en/department-of-social-protection/publications/budget-2027/',
    publishedOn: '2026-10-02'
  }),
  statePensionContributory: Object.freeze({
    title: 'Department of Social Protection, State Pension (Contributory)',
    url: 'https://www.gov.ie/en/department-of-social-protection/services/state-pension-contributory/'
  }),
  statePensionNonContributory: Object.freeze({
    title: 'Department of Social Protection, State Pension (Non-Contributory)',
    url: 'https://www.gov.ie/en/department-of-social-protection/services/state-pension-non-contributory/',
    publishedOn: '2026-10-07'
  }),
  bereavedPartnersContributory: Object.freeze({
    title: 'Department of Social Protection, Bereaved Partner’s (Contributory) Pension',
    url: 'https://www.gov.ie/en/department-of-social-protection/services/bereaved-partners-contributory-pension/'
  }),
  invalidityPension: Object.freeze({
    title: 'Department of Social Protection, Invalidity Pension',
    url: 'https://www.gov.ie/en/department-of-social-protection/services/invalidity-pension/'
  }),
  illnessBenefit: Object.freeze({
    title: 'Department of Social Protection, Illness Benefit',
    url: 'https://www.gov.ie/en/department-of-social-protection/services/illness-benefit/'
  })
});

const S = SOCIAL_WELFARE_SOURCES;

/** The Department prints "from January" without a day; the first of the month is used. */
const FROM_JANUARY_2026 = 'from January 2026; the Department does not print the day';

/**
 * Budget 2027, announced on 6 October 2026: "€10 weekly increase across most
 * social welfare payments from January 2027", with the new maximum rates in the
 * Department's Budget 2027 table. The scheme pages still print the 2026 rates, so
 * only the Budget table is cited. Switch `status` to `in_force` once the rates are
 * payable and the scheme pages show them.
 */
const rate2027 = (weeklyEur, verifiedOn = '2026-10-22') => Object.freeze({
  effectiveFrom: '2027-01-01',
  effectiveFromNote: 'from January 2027; the Department does not print the day',
  weeklyEur,
  status: 'announced',
  announcedBy: 'Budget 2027',
  announcedOn: '2026-10-06',
  verifiedOn,
  sources: Object.freeze([S.dspBudget2027])
});

const rate2026 = (weeklyEur, ...sources) => Object.freeze({
  effectiveFrom: '2026-01-01',
  effectiveFromNote: FROM_JANUARY_2026,
  weeklyEur,
  status: 'in_force',
  verifiedOn: '2026-10-22',
  sources: Object.freeze([S.dspBudget2026, ...sources])
});

export const SOCIAL_WELFARE_SERIES = Object.freeze([
  Object.freeze({
    id: 'ie.social_welfare.state_pension_contributory.personal_under_80',
    schemeId: 'state_pension_contributory',
    scheme: 'State Pension (Contributory)',
    label: 'State Pension (Contributory), highest weekly personal rate, under 80',
    appliesTo: 'A person under 80 with a full social insurance record. Gross: it is taxable.',
    rates: Object.freeze([rate2026(299.30, S.statePensionContributory), rate2027(309.30)])
  }),
  Object.freeze({
    id: 'ie.social_welfare.state_pension_contributory.personal_80_and_over',
    schemeId: 'state_pension_contributory',
    scheme: 'State Pension (Contributory)',
    label: 'State Pension (Contributory), highest weekly personal rate, aged 80 and over',
    appliesTo: 'A person aged 80 or over with a full social insurance record. Gross: it is taxable.',
    rates: Object.freeze([rate2026(309.30), rate2027(319.30)])
  }),
  Object.freeze({
    id: 'ie.social_welfare.bereaved_partners_contributory.personal_under_66',
    schemeId: 'bereaved_partners_contributory',
    scheme: 'Bereaved Partner’s (Contributory) Pension',
    /** The pension for a widow, widower, surviving civil partner or surviving qualified cohabitant. */
    aliases: Object.freeze(['Widow’s, Widower’s or Surviving Civil Partner’s (Contributory) Pension']),
    label: 'Bereaved Partner’s (Contributory) Pension, highest weekly personal rate, under 66',
    appliesTo: 'A bereaved partner under 66 with 48 or more contributions. Taxable; not means tested.',
    rates: Object.freeze([rate2026(259.50, S.bereavedPartnersContributory), rate2027(269.50)])
  }),
  Object.freeze({
    id: 'ie.social_welfare.bereaved_partners_contributory.personal_66_to_79',
    schemeId: 'bereaved_partners_contributory',
    scheme: 'Bereaved Partner’s (Contributory) Pension',
    aliases: Object.freeze(['Widow’s, Widower’s or Surviving Civil Partner’s (Contributory) Pension']),
    label: 'Bereaved Partner’s (Contributory) Pension, highest weekly personal rate, aged 66 to 79',
    appliesTo: 'A bereaved partner aged 66 to 79 with 48 or more contributions. Taxable; not means tested.',
    rates: Object.freeze([rate2026(299.30, S.bereavedPartnersContributory), rate2027(309.30)])
  }),
  Object.freeze({
    id: 'ie.social_welfare.bereaved_partners_contributory.personal_80_and_over',
    schemeId: 'bereaved_partners_contributory',
    scheme: 'Bereaved Partner’s (Contributory) Pension',
    aliases: Object.freeze(['Widow’s, Widower’s or Surviving Civil Partner’s (Contributory) Pension']),
    label: 'Bereaved Partner’s (Contributory) Pension, highest weekly personal rate, aged 80 and over',
    appliesTo: 'A bereaved partner aged 80 or over with 48 or more contributions. Taxable; not means tested.',
    rates: Object.freeze([rate2026(309.30), rate2027(319.30)])
  }),
  Object.freeze({
    id: 'ie.social_welfare.invalidity_pension.personal',
    schemeId: 'invalidity_pension',
    scheme: 'Invalidity Pension',
    label: 'Invalidity Pension, weekly personal rate',
    appliesTo: 'A person with a long-term incapacity and enough contributions. Taxable, without USC or PRSI.',
    rates: Object.freeze([rate2026(259.50, S.invalidityPension), rate2027(269.50)])
  }),
  Object.freeze({
    id: 'ie.social_welfare.state_pension_non_contributory.personal_66_to_79',
    schemeId: 'state_pension_non_contributory',
    scheme: 'State Pension (Non-Contributory)',
    label: 'State Pension (Non-Contributory), maximum weekly personal rate, aged 66 to 79',
    appliesTo: 'A person aged 66 to 79 who passes the means test and has no income from any source. The Nursing Homes Support Scheme measures what a person keeps against it. Gross: it is taxable.',
    rates: Object.freeze([
      Object.freeze({
        effectiveFrom: '2026-01-02',
        effectiveFromNote: 'from 2 January 2026, as the Department prints it',
        weeklyEur: 288,
        status: 'in_force',
        verifiedOn: '2026-10-27',
        sources: Object.freeze([S.statePensionNonContributory])
      }),
      rate2027(298, '2026-10-27')
    ])
  }),
  Object.freeze({
    id: 'ie.social_welfare.illness_benefit.personal_highest',
    schemeId: 'illness_benefit',
    scheme: 'Illness Benefit',
    label: 'Illness Benefit, highest weekly personal rate',
    appliesTo: 'A person whose average weekly earnings are €300 or more; lower earnings bands get a lower rate. Taxable, without USC or PRSI.',
    rates: Object.freeze([rate2026(254.00, S.illnessBenefit), rate2027(264.00)])
  })
]);
