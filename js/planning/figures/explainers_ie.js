/**
 * Explainers: short, sourced, plain-language accounts of how the rules behind
 * the figures work. Data only.
 *
 * An explainer is for a person who wants to know why a figure is what it is: the
 * story screen shows one on hover or tap, and the analyst points to one instead
 * of explaining a rule in its own words. It is education only. It says how a rule
 * works, never what anyone should do, and it never types a figure: it names the
 * figures and rules it explains by id, and the screen fills the values in from
 * the register.
 *
 * Each explainer holds:
 * - `id`: short and snake_case; a story refers to it by this id.
 * - `title`: a few words.
 * - `sentences`: two to four plain sentences in the "you" voice, no digits, no
 *   provider names, no advice (`check:figures` enforces all of it).
 * - `figureIds` and `ruleIds`: what it explains. A figure id is one figure. A rule
 *   id is the id of a rule or series that the register's figures hang under, such
 *   as `ie.dirt` or `ie.pension_relief.limits`, and covers every figure beneath it.
 *   The register works out each figure's explainers from these two lists, so a
 *   figure never names one by hand and the two cannot disagree.
 * - `sources`: official pages only (the Department of Social Protection,
 *   Revenue, Citizens Information, MABS, the CCPC and the like), the pages the
 *   sentences were written from.
 * - `checkedOn`: the day those pages were read against the sentences.
 *
 * Change `EXPLAINERS_VERSION` whenever a sentence or a source changes, and set
 * `checkedOn` to the day the sources were read. A rule that changes under an
 * explainer (a payment renamed, an exemption removed) means rereading its
 * sources, not only its figures.
 */

export const EXPLAINERS_VERSION = 'ie-explainers-2026.1';

const READ_ON = '2026-10-28';

const source = (title, url) => Object.freeze({ title, url });

export const EXPLAINERS = Object.freeze([
  Object.freeze({
    id: 'state_pension_contributions',
    title: 'How your contributions set your State Pension',
    sentences: Object.freeze([
      'The State Pension (Contributory) is paid from pension age on your own social insurance record, and it is not means-tested, so other income does not reduce it.',
      'Under the Total Contributions Approach, your rate depends on the total contributions you have when you start it: paid and voluntary contributions, credited contributions and caring supports all count.',
      'A full record earns the maximum rate and a shorter one a reduced rate in proportion, and while the older Yearly Average method is phased out you get whichever calculation is higher.',
      'It is taxable, but you are unlikely to pay tax if it is your only income.'
    ]),
    figureIds: Object.freeze([]),
    ruleIds: Object.freeze(['ie.social_welfare.state_pension_contributory', 'ie.state_pension_contributory']),
    sources: Object.freeze([
      source('Department of Social Protection, State Pension (Contributory)', 'https://www.gov.ie/en/department-of-social-protection/services/state-pension-contributory/'),
      source('Citizens Information, applying for the State Pension (Contributory)', 'https://www.citizensinformation.ie/en/social-welfare/older-and-retired-people/state-pension-contributory/')
    ]),
    checkedOn: READ_ON
  }),

  Object.freeze({
    id: 'state_pension_not_passed_on',
    title: 'A State Pension is not passed to a partner',
    sentences: Object.freeze([
      'A State Pension (Contributory) is paid on the record of the person it is paid to, so it stops after a short run-on period when they die, and a partner does not inherit it.',
      'A partner who is left may instead qualify for the Bereaved Partner’s (Contributory) Pension, which is based on their own contribution record or their late partner’s record.',
      'Only one social welfare payment is paid at a time, with a few exceptions, so if you qualify for both a State Pension and a bereaved partner’s pension you are paid whichever is higher.'
    ]),
    figureIds: Object.freeze([]),
    ruleIds: Object.freeze(['ie.social_welfare.state_pension_contributory', 'ie.social_welfare.bereaved_partners_contributory']),
    sources: Object.freeze([
      source('Department of Social Protection, Operational Guidelines: State Pension (Contributory)', 'https://www.gov.ie/en/department-of-social-protection/publications/operational-guidelines-state-pension-contributory/'),
      source('Citizens Information, Bereaved Partner’s (Contributory) Pension', 'https://www.citizensinformation.ie/en/social-welfare/death-related-benefits/bereaved-partners-contributory-pension/')
    ]),
    checkedOn: READ_ON
  }),

  Object.freeze({
    id: 'bereaved_partners_pension',
    title: 'The Bereaved Partner’s (Contributory) Pension',
    sentences: Object.freeze([
      'This is a weekly payment to a husband, wife, civil partner or qualified cohabitant after their partner dies, and it replaced the widow’s, widower’s and surviving civil partner’s pension.',
      'It depends on social insurance contributions: your record or your late partner’s record has to meet the conditions, and the two records cannot be added together.',
      'It is paid whatever other income you have, and it is taxable, though you are unlikely to pay tax if it is your only income.',
      'It stops if you marry or start to live with someone else as a couple.'
    ]),
    figureIds: Object.freeze([]),
    ruleIds: Object.freeze(['ie.social_welfare.bereaved_partners_contributory']),
    sources: Object.freeze([
      source('Department of Social Protection, Bereaved Partner’s (Contributory) Pension', 'https://www.gov.ie/en/department-of-social-protection/services/bereaved-partners-contributory-pension/'),
      source('Citizens Information, Bereaved Partner’s (Contributory) Pension', 'https://www.citizensinformation.ie/en/social-welfare/death-related-benefits/bereaved-partners-contributory-pension/')
    ]),
    checkedOn: READ_ON
  }),

  Object.freeze({
    id: 'illness_benefit',
    title: 'Illness Benefit: who it covers',
    sentences: Object.freeze([
      'Illness Benefit is a weekly payment for people who cannot work because of illness and are certified unfit for work by a doctor, and it does not depend on your employer’s sick pay.',
      'Only contributions at certain classes count towards it, such as the employee class, and Class S, paid by the self-employed, is not one of them, so people who pay only Class S are not covered.',
      'It is taxable but paid without tax taken off, and Revenue adjusts your tax credits and rate band to collect any tax due.',
      'It is paid for a limited time that depends on the contributions you have paid, and a longer illness can move on to longer-term payments such as Invalidity Pension.'
    ]),
    figureIds: Object.freeze([]),
    ruleIds: Object.freeze(['ie.social_welfare.illness_benefit', 'ie.social_welfare.invalidity_pension']),
    sources: Object.freeze([
      source('Department of Social Protection, Illness Benefit', 'https://www.gov.ie/en/department-of-social-protection/services/illness-benefit/'),
      source('Citizens Information, Illness Benefit', 'https://www.citizensinformation.ie/en/social-welfare/disability-and-illness/illness-benefit/'),
      source('Citizens Information, Class S PRSI', 'https://www.citizensinformation.ie/en/social-welfare/irish-social-welfare-system/social-insurance-prsi/class-s-prsi/')
    ]),
    checkedOn: READ_ON
  }),

  Object.freeze({
    id: 'pension_tax_relief',
    title: 'Pension tax relief and the age limits',
    sentences: Object.freeze([
      'Contributions you pay into a pension can get income tax relief at your highest rate of tax, but not relief from the Universal Social Charge or PRSI.',
      'The relief is limited each year to a share of your earnings, and that share rises with your age in bands.',
      'There is also a ceiling on the earnings that count, so earnings above it add no further relief.'
    ]),
    figureIds: Object.freeze([]),
    ruleIds: Object.freeze(['ie.pension_relief.limits']),
    sources: Object.freeze([
      source('Revenue, tax relief on pension contributions', 'https://www.revenue.ie/en/jobs-and-pensions/pension/relief/index.aspx'),
      source('Revenue, tax relief limits on pension contributions', 'https://www.revenue.ie/en/jobs-and-pensions/pension/relief/tax-relief-limits.aspx')
    ]),
    checkedOn: READ_ON
  }),

  Object.freeze({
    id: 'dirt',
    title: 'DIRT on your deposit interest',
    sentences: Object.freeze([
      'Deposit Interest Retention Tax, or DIRT, is tax taken off the interest on your deposit accounts by the financial institution that holds them, before the interest is paid to you.',
      'It is a final tax on that interest, and Universal Social Charge does not apply to deposit interest, although PRSI can apply in some circumstances.',
      'Some people can receive interest without DIRT after making a declaration, such as people over a set age whose total income is below a limit and people who are permanently incapacitated.'
    ]),
    figureIds: Object.freeze(['ie.market.cash.instant_access_gross_rate', 'ie.market.cash.regular_saver_gross_rate']),
    ruleIds: Object.freeze(['ie.dirt']),
    sources: Object.freeze([
      source('Revenue, Deposit Interest Retention Tax (DIRT)', 'https://www.revenue.ie/en/additional-incomes/dirt/index.aspx'),
      source('Revenue, what DIRT rate is applicable', 'https://www.revenue.ie/en/additional-incomes/dirt/who-is-charged-dirt.aspx'),
      source('Revenue, who is exempt from DIRT', 'https://www.revenue.ie/en/additional-incomes/dirt/who-is-exempt-from-dirt.aspx')
    ]),
    checkedOn: READ_ON
  }),

  Object.freeze({
    id: 'cgt_and_your_home',
    title: 'Capital gains tax, and why your home is different',
    sentences: Object.freeze([
      'Capital gains tax is charged on the gain when you sell an asset such as shares or a second property, which is the sale price less what you paid and your allowable costs.',
      'Each person has a yearly exemption, so a gain below it carries no tax, you still report the sale, and a loss can be set against gains.',
      'Your home is treated differently: if it has been your only or main home for the whole time you owned it, selling it carries no capital gains tax.',
      'Some of that relief can be lost if you did not live in all of it or for the whole time, and it does not cover a second property, which is not your only or main home.'
    ]),
    figureIds: Object.freeze(['ie.cgt.2026.annual_exemption']),
    ruleIds: Object.freeze(['ie.cgt.rate']),
    sources: Object.freeze([
      source('Revenue, how to calculate CGT', 'https://www.revenue.ie/en/gains-gifts-and-inheritance/transfering-an-asset/how-to-calculate-cgt.aspx'),
      source('Revenue, CGT: if you make a loss', 'https://www.revenue.ie/en/gains-gifts-and-inheritance/transfering-an-asset/if-you-make-a-loss.aspx'),
      source('Revenue, Principal Private Residence (PPR) Relief', 'https://www.revenue.ie/en/gains-gifts-and-inheritance/cgt-reliefs/principal-private-residence-ppr-relief.aspx')
    ]),
    checkedOn: READ_ON
  }),

  Object.freeze({
    id: 'moving_home_costs',
    title: 'Stamp duty and selling costs when you move home',
    sentences: Object.freeze([
      'Stamp duty is paid by the buyer, on the price of the home being bought, at rates that rise in bands.',
      'Selling a home has its own costs, including the estate agent’s fee (a share of the sale price plus VAT), advertising, your solicitor’s fees and outlays, and the energy rating certificate that is required before you can list it.',
      'What is left once the mortgage is repaid and these costs are paid is what the sale releases towards your next home.'
    ]),
    figureIds: Object.freeze([]),
    ruleIds: Object.freeze(['ie.house_purchase.stamp_duty']),
    sources: Object.freeze([
      source('Revenue, Stamp Duty and property', 'https://www.revenue.ie/en/property/stamp-duty/property/stamp-duty-property/index.aspx'),
      source('Revenue, residential Stamp Duty rates', 'https://www.revenue.ie/en/property/stamp-duty/property/stamp-duty-property/rates.aspx'),
      source('CCPC, selling a home in Ireland', 'https://www.ccpc.ie/manage-your-money/buying-a-home/selling-a-home')
    ]),
    checkedOn: READ_ON
  }),

  Object.freeze({
    id: 'emergency_reserve',
    title: 'The emergency reserve',
    sentences: Object.freeze([
      'An emergency reserve is money kept easy to reach for urgent or unexpected costs, such as a car repair, a medical bill or a loss of income, so you do not have to borrow.',
      'It is usually sized in months of your essential spending rather than as a fixed amount, because what you would need to cover depends on your own costs.',
      'In your plan the reserve is set aside first, with a minimum and a target number of months, and it is kept apart from the cash counted towards a goal such as a deposit.'
    ]),
    figureIds: Object.freeze([]),
    ruleIds: Object.freeze(['planeir.assumption.reserve_months']),
    sources: Object.freeze([
      source('MABS, building up savings', 'https://www.mabs.ie/en/managing-money/building-up-savings/')
    ]),
    checkedOn: READ_ON
  }),

  Object.freeze({
    id: 'income_tax_bands_and_credits',
    title: 'Income tax bands and credits',
    sentences: Object.freeze([
      'Income tax works in two steps: income up to your standard-rate band is taxed at the standard rate, and income above it is taxed at the higher rate.',
      'The size of your band depends on your circumstances, such as being single, married or in a civil partnership, or widowed, and a couple who both have income can have their band increased up to a limit.',
      'Tax credits are then taken off the tax worked out, which lowers what you pay directly, and the Universal Social Charge is calculated separately.'
    ]),
    figureIds: Object.freeze([]),
    ruleIds: Object.freeze(['ie.income_tax.2026', 'ie.income_tax.2027', 'ie.income_tax.employee_credit']),
    sources: Object.freeze([
      source('Revenue, how your Income Tax is calculated', 'https://www.revenue.ie/en/jobs-and-pensions/calculating-your-income-tax/how-income-tax-is-calculated.aspx'),
      source('Revenue, what is a tax rate band', 'https://www.revenue.ie/en/jobs-and-pensions/calculating-your-income-tax/tax-rate-band.aspx'),
      source('Revenue, tax rates, bands and reliefs', 'https://www.revenue.ie/en/personal-tax-credits-reliefs-and-exemptions/tax-relief-charts/index.aspx')
    ]),
    checkedOn: READ_ON
  })
]);
