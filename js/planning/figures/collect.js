/**
 * Every figure that can change, collected from the catalogues that own them.
 *
 * Nothing here is typed in. Each value is read from its catalogue, so the
 * register cannot disagree with the engines that import the same objects. A
 * figure is a quantity the engines or the in-app AI rely on: a rate, a band, a
 * limit, an age, an amount, a date. Wording and notices are not figures.
 *
 * The catalogues collected:
 * - the Irish tax rules and their dated schedules (`tax/rules_ie.js`)
 * - the Irish planning rules: pension relief limits, imputed distributions
 *   (`ireland_rules.js`)
 * - social welfare rates by effective date (`social_welfare_ie.js`)
 * - the House Purchase rules (`house_purchase/config.js`)
 * - the central Planeir assumptions (`planeir_assumptions.js`)
 * - the market figures (`figures/market_ie.js`)
 *
 * A catalogue that lands later (care costs: the Fair Deal rules and the HSE
 * price list) adds a function here and its entries appear in the register.
 *
 * Two things the collector does so a quantity is listed once:
 * - A rule a later tax year carries over unchanged is the same object as the
 *   earlier year's, and is listed once, for the year it first took effect.
 * - A module's own reading of a figure (House Purchase's DIRT rate, the State
 *   Pension view in the Irish rules) is not a second definition and is not listed.
 */

import { formatFigureValue } from './format.js';
import { FIGURE_MODULES, figureKindForStatus } from './kinds.js';
import { MARKET_FIGURES, MARKET_FIGURES_VERSION } from './market_ie.js';
import { marketFigureEvidence, marketFigureValue } from './market_math.js';
import {
  IE_CGT_FIXED_RULES,
  IE_INVESTMENT_RULES,
  IE_LEGISLATED_SCHEDULES,
  IE_TAX_RULES_BY_YEAR,
  IE_TAX_RULES_VERSION
} from '../tax/rules_ie.js';
import {
  IRELAND_RULES_CATALOGUE_VERSION,
  IRISH_ARF_MINIMUM_DRAWDOWN,
  IRISH_PENSION_RELIEF_LIMITS,
  IRISH_STATE_PENSION_CONTRIBUTORY
} from '../ireland_rules.js';
import { SOCIAL_WELFARE_RATES_VERSION, SOCIAL_WELFARE_SERIES, SOCIAL_WELFARE_THRESHOLDS } from '../social_welfare_ie.js';
import {
  FHS_PRICE_CEILINGS,
  HOUSE_PURCHASE_RULES,
  HOUSE_PURCHASE_RULES_VERSION,
  HOUSE_PURCHASE_SOURCE_METADATA
} from '../../house_purchase/config.js';
import { PLANEIR_ASSUMPTIONS, PLANEIR_ASSUMPTIONS_VERSION } from '../planeir_assumptions.js';

const eur = (value) => formatFigureValue(value, 'eur');
const dateShown = (iso) => formatFigureValue(iso, 'date');

/**
 * The day the State Pension start age and yearly rise were set. They are Planeir
 * choices with no review date recorded, so the register shows when they were set
 * (`checkedOnFrom: 'history'`) rather than a date they were never checked on.
 */
const STATE_PENSION_DEFAULTS_SET_ON = '2026-07-20';

const PLANEIR_SOURCE = (title) => Object.freeze({ title, url: null });

function sourceList(sources) {
  return sources.map((source) => ({ title: source.title, url: source.url ?? null }));
}

/**
 * A builder that stamps every entry from one catalogue with that catalogue's
 * identity and version, and works out the kind from the status.
 */
function entryBuilder(catalogue, out) {
  return (fields) => {
    const {
      id, quantity, label, value, unit, status, effectiveFrom = null, sources, checkedOn,
      checkedOnFrom = 'own', usedBy, kind = figureKindForStatus(status), extra = {}
    } = fields;
    const list = sourceList(sources);
    out.push(Object.freeze({
      id,
      quantity,
      label,
      value,
      valueShown: formatFigureValue(value, unit),
      unit,
      kind,
      status,
      effectiveFrom,
      source: list[0],
      sources: list,
      checkedOn,
      checkedOnFrom,
      catalogue: Object.freeze({ id: catalogue.id, version: catalogue.version }),
      usedBy: Object.freeze([...usedBy]),
      ...extra
    }));
  };
}

// ---------------------------------------------------------------------------
// Irish tax rules: dated blocks and schedules
// ---------------------------------------------------------------------------

const TAX_YEAR_MODULES = ['household_cash_flow', 'pension_projection', 'plan_pack'];

function collectTaxRules(out) {
  const add = entryBuilder({ id: 'ie_tax_rules', version: IE_TAX_RULES_VERSION }, out);
  const years = Object.keys(IE_TAX_RULES_BY_YEAR).map(Number).sort((left, right) => left - right);
  const latestBlockCheck = IE_TAX_RULES_BY_YEAR[years[years.length - 1]].verifiedOn;
  const seen = new Set();
  const isNew = (rule) => {
    if (!rule || seen.has(rule)) return false;
    seen.add(rule);
    return true;
  };

  for (const year of years) {
    const block = IE_TAX_RULES_BY_YEAR[year];
    const effectiveFrom = `${year}-01-01`;
    const base = (rule, extra) => ({ status: block.status, effectiveFrom, checkedOn: rule.verifiedOn ?? block.verifiedOn, ...extra });

    const income = block.incomeTax;
    if (isNew(income)) {
      const row = (field, label, value, unit, extra = {}) => add({
        id: `${income.ruleId}.${field}`,
        quantity: `ie.income_tax.${field}`,
        label,
        value,
        unit,
        sources: income.sources,
        usedBy: TAX_YEAR_MODULES,
        ...base(income),
        ...extra
      });
      row('standard_rate', 'Income tax standard rate', income.standardRate, 'rate');
      row('higher_rate', 'Income tax higher rate', income.higherRate, 'rate');
      row('standard_rate_band.single', 'Income tax standard-rate band, single or widowed person without qualifying children', income.standardRateBand.single, 'eur');
      row('standard_rate_band.widowed', 'Income tax standard-rate band, widowed person or surviving civil partner without qualifying children', income.standardRateBand.widowed, 'eur');
      row('standard_rate_band.married_one_income', 'Income tax standard-rate band, married couple or civil partners with one income', income.standardRateBand.marriedOneIncome, 'eur');
      row('standard_rate_band.second_income_increase_max', 'Most a second income can add to the standard-rate band of a married couple or civil partners', income.standardRateBand.secondIncomeIncreaseMax, 'eur');
      row('personal_credit.single', 'Personal tax credit, single person', income.personalCredit.single, 'eur');
      row('personal_credit.married', 'Personal tax credit, married couple or civil partners', income.personalCredit.married, 'eur');
      row('personal_credit.widowed', 'Personal tax credit, widowed person without dependent children', income.personalCredit.widowed, 'eur',
        income.notes?.widowedCredit ? { extra: { note: income.notes.widowedCredit } } : {});
    }
    const employee = income.employeeCredit;
    if (isNew(employee)) {
      add({
        id: `${employee.ruleId}.amount`,
        quantity: 'ie.income_tax.employee_credit.amount',
        label: 'Employee tax credit',
        value: employee.amount,
        unit: 'eur',
        sources: income.sources,
        usedBy: TAX_YEAR_MODULES,
        ...base(employee)
      });
      add({
        id: `${employee.ruleId}.max_share_of_qualifying_income`,
        quantity: 'ie.income_tax.employee_credit.max_share_of_qualifying_income',
        label: 'Most the employee tax credit can be, as a share of the person’s qualifying income',
        value: employee.maxShareOfQualifyingIncome,
        unit: 'rate',
        sources: income.sources,
        usedBy: TAX_YEAR_MODULES,
        ...base(employee)
      });
    }
    const ageCredit = income.ageCredit;
    if (isNew(ageCredit)) {
      const row = (field, label, value, unit) => add({
        id: `${ageCredit.ruleId}.${field}`,
        quantity: `ie.income_tax.age_credit.${field}`,
        label,
        value,
        unit,
        sources: income.sources,
        usedBy: TAX_YEAR_MODULES,
        ...base(ageCredit)
      });
      row('from_age', 'Age from which the age tax credit applies', ageCredit.fromAge, 'age');
      row('single', 'Age tax credit, single person', ageCredit.single, 'eur');
      row('widowed', 'Age tax credit, widowed person or surviving civil partner', ageCredit.widowed, 'eur');
      row('married', 'Age tax credit, married couple or civil partners', ageCredit.married, 'eur');
    }

    const exemption = block.ageExemption;
    if (isNew(exemption)) {
      const row = (field, label, value, unit) => add({
        id: `${exemption.ruleId}.${field}`,
        quantity: `ie.income_tax.age_exemption.${field}`,
        label,
        value,
        unit,
        sources: exemption.sources,
        usedBy: TAX_YEAR_MODULES,
        ...base(exemption)
      });
      row('from_age', 'Age from which the income tax age exemption applies', exemption.fromAge, 'age');
      row('limit.single', 'Income tax age exemption limit, single person', exemption.limit.single, 'eur');
      row('limit.widowed', 'Income tax age exemption limit, widowed person or surviving civil partner', exemption.limit.widowed, 'eur');
      row('limit.married', 'Income tax age exemption limit, married couple or civil partners', exemption.limit.married, 'eur');
      row('marginal_relief_rate', 'Share of income above the age exemption limit that marginal relief caps tax at', exemption.marginalReliefRate, 'rate');
      row('marginal_relief_ceiling_multiple', 'Marginal relief applies while income is no more than this multiple of the age exemption limit', exemption.marginalReliefCeilingMultiple, 'multiple');
    }

    const usc = block.usc;
    if (isNew(usc)) {
      const row = (field, label, value, unit) => add({
        id: `${usc.ruleId}.${field}`,
        quantity: `ie.usc.${field}`,
        label,
        value,
        unit,
        sources: usc.sources,
        usedBy: TAX_YEAR_MODULES,
        ...base(usc)
      });
      row('exemption_threshold', 'Income at or below which no USC is paid', usc.exemptionThreshold, 'eur');
      const bandRows = (rule, prefix, kindLabel) => rule.bands.forEach((band, index) => {
        const lower = index === 0 ? null : rule.bands[index - 1].upTo;
        const where = lower === null
          ? `the first ${eur(band.upTo)} of income`
          : (band.upTo === null ? `income above ${eur(lower)}` : `income between ${eur(lower)} and ${eur(band.upTo)}`);
        row(`${prefix}.band_${index + 1}.rate`, `${kindLabel} rate on ${where}`, band.rate, 'rate');
        if (band.upTo !== null) {
          row(`${prefix}.band_${index + 1}.upper_limit`, `${kindLabel}, upper limit of band ${index + 1}`, band.upTo, 'eur');
        }
      });
      bandRows(usc, 'standard', 'USC');
      if (isNew(usc.reduced)) {
        const reduced = usc.reduced;
        row('reduced.from_age', 'Age from which the reduced USC rates can apply', reduced.fromAge, 'age');
        row('reduced.aggregate_income_ceiling', 'Reduced USC rates apply while income is no more than', reduced.aggregateIncomeCeiling, 'eur');
        bandRows(reduced, 'reduced', 'Reduced USC');
      }
      if (isNew(usc.surcharge)) {
        row('surcharge.rate', 'USC surcharge rate on income that is not taxed through PAYE', usc.surcharge.rate, 'rate');
        row('surcharge.non_paye_threshold', 'USC surcharge applies to income that is not taxed through PAYE above', usc.surcharge.nonPayeThreshold, 'eur');
      }
    }

    const prsi = block.prsi;
    if (isNew(prsi)) {
      const row = (field, label, value, unit) => add({
        id: `${prsi.ruleId}.${field}`,
        quantity: `ie.prsi.${field}`,
        label,
        value,
        unit,
        sources: prsi.sources,
        usedBy: TAX_YEAR_MODULES,
        ...base(prsi)
      });
      row('liable_under_age', 'PRSI is paid below this age', prsi.liableUnderAge, 'age');
      row('exempt_from_age', 'PRSI is not paid from this age', prsi.exemptFromAge, 'age');
      row('reached_66_before_year', 'From age 66 to 69, PRSI is not paid by someone who reached 66 before 1 January of this year', prsi.reached66BeforeYear, 'year');
    }

    const lump = block.lumpSum;
    if (isNew(lump)) {
      const row = (field, label, value, unit) => add({
        id: `${lump.ruleId}.${field}`,
        quantity: `ie.lump_sum.${field}`,
        label,
        value,
        unit,
        sources: lump.sources,
        usedBy: ['pension_projection'],
        ...base(lump)
      });
      row('lifetime_tax_free', 'Retirement lump sums that are tax free over a lifetime', lump.lifetimeTaxFree, 'eur');
      row('standard_rate_ceiling', 'Retirement lump sums above the tax-free amount, up to this total, are taxed at the standard rate', lump.standardRateCeiling, 'eur');
      row('standard_rate', 'Tax rate on a retirement lump sum between the tax-free amount and the ceiling', lump.standardRate, 'rate');
      row('max_share_of_fund', 'Usual most a retirement lump sum can be, as a share of the fund', lump.maxShareOfFund, 'rate');
    }

    const cgt = block.capitalGainsTax;
    if (isNew(cgt)) {
      add({
        id: `${cgt.ruleId}.annual_exemption`,
        quantity: 'ie.cgt.annual_exemption',
        label: 'Capital gains tax annual exemption, for each person',
        value: cgt.annualExemption,
        unit: 'eur',
        sources: cgt.sources,
        usedBy: ['plan_pack'],
        ...base(cgt)
      });
    }

    const dirt = block.dirt;
    if (isNew(dirt)) {
      add({
        id: `${dirt.ruleId}.rate`,
        quantity: 'ie.dirt.rate',
        label: 'Deposit interest retention tax (DIRT) rate',
        value: dirt.rate,
        unit: 'rate',
        sources: dirt.sources,
        usedBy: ['future_cost_fund', 'goals_and_resources', 'house_purchase'],
        ...base(dirt)
      });
    }
  }

  const schedules = IE_LEGISLATED_SCHEDULES;
  const scheduleRow = (row, fields) => add({
    status: row.status ?? 'enacted',
    effectiveFrom: row.effectiveFrom,
    checkedOn: row.verifiedOn ?? latestBlockCheck,
    checkedOnFrom: row.verifiedOn ? 'own' : 'catalogue',
    sources: [row.source],
    ...fields
  });

  schedules.prsiRate.forEach((row) => scheduleRow(row, {
    id: row.ruleId,
    quantity: 'ie.prsi.rate',
    label: `PRSI rate for most employees and the self-employed from ${dateShown(row.effectiveFrom)}`,
    value: row.rate,
    unit: 'rate',
    usedBy: TAX_YEAR_MODULES
  }));

  schedules.standardFundThreshold.fixed.forEach((row) => scheduleRow({
    effectiveFrom: `${row.year}-01-01`,
    status: 'enacted',
    source: row.source
  }, {
    id: `ie.sft.${row.year}`,
    quantity: 'ie.sft.amount',
    label: `Standard Fund Threshold for ${row.year}`,
    value: row.amount,
    unit: 'eur',
    usedBy: ['pension_projection']
  }));

  schedules.capitalGainsTaxRate.forEach((row) => scheduleRow(row, {
    id: row.ruleId,
    quantity: 'ie.cgt.rate',
    label: `Capital gains tax standard rate on disposals from ${dateShown(row.effectiveFrom)}`,
    value: row.rate,
    unit: 'rate',
    usedBy: ['plan_pack']
  }));

  schedules.investmentFundExitTaxRate.forEach((row) => scheduleRow(row, {
    id: row.ruleId,
    quantity: 'ie.exit_tax.rate',
    label: `Exit tax on investment funds, ETFs and investment life policies from ${dateShown(row.effectiveFrom)}`,
    value: row.rate,
    unit: 'rate',
    usedBy: ['goals_and_resources', 'plan_pack']
  }));

  const deemed = IE_INVESTMENT_RULES.deemedDisposal;
  add({
    id: `${deemed.ruleId}.every_years`,
    quantity: 'ie.exit_tax.deemed_disposal.every_years',
    label: 'Units in a fund are treated as sold, and the gain taxed, at the end of each period of this length',
    value: deemed.everyYears,
    unit: 'years',
    status: deemed.status,
    effectiveFrom: null,
    sources: deemed.sources,
    checkedOn: latestBlockCheck,
    checkedOnFrom: 'catalogue',
    usedBy: ['goals_and_resources', 'plan_pack']
  });

  const account = IE_INVESTMENT_RULES.investmentAccount;
  const accountRow = (field, label, value, unit) => add({
    id: `${account.ruleId}.${field}`,
    quantity: `ie.investment_account.${field}`,
    label,
    value,
    unit,
    status: account.status,
    effectiveFrom: account.opensOn,
    sources: account.sources,
    checkedOn: account.verifiedOn,
    usedBy: ['goals_and_resources', 'plan_pack']
  });
  accountRow('opens_on', 'Date providers can open the new Investment Account', account.opensOn, 'date');
  accountRow('annual_contribution_cap', 'Most that can be paid into the new Investment Account in a year', account.annualContributionCap, 'eur');
  accountRow('tax_free_value', 'Value of the new Investment Account below which no annual charge applies', account.taxFreeValue, 'eur');
  accountRow('annual_charge_rate', 'Annual charge on the value of the new Investment Account above the tax-free amount', account.annualChargeRate, 'rate');

  const s604a = IE_CGT_FIXED_RULES.section604A;
  const fixedCgt = (id, quantity, label, value, unit, sources) => add({
    id,
    quantity,
    label,
    value,
    unit,
    status: 'enacted',
    effectiveFrom: null,
    sources,
    checkedOn: latestBlockCheck,
    checkedOnFrom: 'catalogue',
    usedBy: ['plan_pack']
  });
  fixedCgt(`${s604a.ruleId}.exempt_years`, 'ie.cgt.s604a.exempt_years', 'Years of ownership that are exempt from capital gains tax on property bought between 7 December 2011 and 31 December 2014', s604a.exemptYears, 'years', s604a.sources);
  fixedCgt(`${s604a.ruleId}.minimum_years`, 'ie.cgt.s604a.minimum_years', 'Years the property must be held for the whole gain to be exempt, on disposals from 2018', s604a.minimumYears, 'years', s604a.sources);
  const indexation = IE_CGT_FIXED_RULES.indexation;
  indexation.periods.forEach((period) => {
    const slug = period.period.replace('/', '_');
    fixedCgt(
      `${indexation.ruleId}.${slug}`,
      `ie.cgt.indexation.${slug}`,
      `Capital gains tax indexation multiplier for expenditure in ${period.period}`,
      period.multiplier,
      'multiple',
      indexation.sources
    );
  });
}

// ---------------------------------------------------------------------------
// Irish planning rules: pension relief, State Pension assumptions, ARF
// ---------------------------------------------------------------------------

function collectIrelandRules(out) {
  const add = entryBuilder({ id: 'ie_planning_rules', version: IRELAND_RULES_CATALOGUE_VERSION }, out);

  const relief = IRISH_PENSION_RELIEF_LIMITS;
  relief.ageBands.forEach((band, index) => {
    const next = relief.ageBands[index + 1];
    const who = index === 0 ? 'under 30' : (next ? `aged ${band.fromAge} to ${next.fromAge - 1}` : `aged ${band.fromAge} or over`);
    add({
      id: `${relief.ruleId}.age_band_${band.fromAge}`,
      quantity: `ie.pension_relief.age_band_${band.fromAge}`,
      label: `Share of earnings that pension contributions can be relieved against, ${who}`,
      value: band.rate,
      unit: 'rate',
      status: relief.status,
      effectiveFrom: null,
      sources: relief.sources,
      checkedOn: relief.verifiedOn,
      usedBy: ['pension_projection', 'household_cash_flow', 'goals_and_resources']
    });
  });
  add({
    id: `${relief.ruleId}.earnings_cap`,
    quantity: 'ie.pension_relief.earnings_cap',
    label: 'Most earnings that count towards pension tax relief in a year',
    value: relief.earningsCap.amountEur,
    unit: 'eur',
    status: relief.status,
    effectiveFrom: relief.earningsCap.effectiveFrom,
    sources: relief.sources,
    checkedOn: relief.verifiedOn,
    usedBy: ['pension_projection', 'household_cash_flow', 'goals_and_resources']
  });

  const arf = IRISH_ARF_MINIMUM_DRAWDOWN;
  const arfRow = (field, label, value, unit) => add({
    id: `${arf.ruleId}.${field}`,
    quantity: `ie.arf.${field}`,
    label,
    value,
    unit,
    status: arf.status,
    effectiveFrom: arf.effectiveFrom,
    sources: [arf.source],
    checkedOn: arf.verifiedOn,
    usedBy: ['pension_projection']
  });
  arfRow('minimum_whole_year_age', 'Age a retirement fund holder must have been for the whole year before the minimum yearly withdrawal is treated as taken', arf.minimumWholeYearAge, 'age');
  arfRow('base_rate', 'Minimum yearly withdrawal from a retirement fund (ARF), as a share of its value, before age 70', arf.baseRate, 'rate');
  arfRow('higher_rate_whole_year_age', 'Age a retirement fund holder must have been for the whole year for the higher minimum withdrawal rate', arf.higherRateWholeYearAge, 'age');
  arfRow('higher_rate', 'Minimum yearly withdrawal from a retirement fund (ARF), as a share of its value, from age 70', arf.higherRate, 'rate');
  arfRow('high_value_threshold', 'Retirement fund value above which the highest minimum withdrawal rate applies', arf.highValueThresholdEur, 'eur');
  arfRow('high_value_rate', 'Minimum yearly withdrawal from a retirement fund (ARF) worth more than the threshold, as a share of its value', arf.highValueRate, 'rate');

  const pension = IRISH_STATE_PENSION_CONTRIBUTORY;
  const assumption = (field, label, value, unit) => add({
    id: `ie.state_pension_contributory.${field}`,
    quantity: `ie.state_pension_contributory.${field}`,
    label,
    value,
    unit,
    status: 'approved',
    kind: 'planeir_assumption',
    effectiveFrom: null,
    sources: [PLANEIR_SOURCE('Planeir planning assumption, held with the Irish planning rules')],
    checkedOn: STATE_PENSION_DEFAULTS_SET_ON,
    checkedOnFrom: 'history',
    usedBy: ['pension_projection', 'net_retirement_cashflow']
  });
  assumption('default_start_age', 'Age the State Pension (Contributory) is assumed to start when none is given', pension.defaultStartAge, 'age');
  assumption('default_escalation_rate', 'Yearly rise assumed in the State Pension (Contributory)', pension.defaultEscalationRate, 'rate_a_year');
}

// ---------------------------------------------------------------------------
// Social welfare rates
// ---------------------------------------------------------------------------

function collectSocialWelfare(out) {
  const add = entryBuilder({ id: 'ie_social_welfare', version: SOCIAL_WELFARE_RATES_VERSION }, out);
  const usedBy = {
    state_pension_contributory: ['pension_projection', 'net_retirement_cashflow'],
    bereaved_partners_contributory: ['protection_gap'],
    invalidity_pension: ['protection_gap'],
    illness_benefit: ['protection_gap']
  };
  for (const series of SOCIAL_WELFARE_SERIES) {
    for (const row of series.rates) {
      add({
        id: `${series.id}.from_${row.effectiveFrom.replace(/-/g, '_')}`,
        quantity: series.id,
        label: series.label,
        value: row.weeklyEur,
        unit: 'eur_a_week',
        status: row.status,
        effectiveFrom: row.effectiveFrom,
        sources: row.sources,
        checkedOn: row.verifiedOn,
        usedBy: usedBy[series.schemeId],
        extra: { appliesTo: series.appliesTo, ...(series.aliases ? { aliases: series.aliases } : {}) }
      });
    }
  }
  for (const rule of SOCIAL_WELFARE_THRESHOLDS) {
    add({
      id: rule.id,
      quantity: rule.id,
      label: rule.label,
      value: rule.value,
      unit: rule.unit,
      status: rule.status,
      effectiveFrom: null,
      sources: rule.sources,
      checkedOn: rule.verifiedOn,
      usedBy: ['pension_projection', 'net_retirement_cashflow'],
      extra: rule.note ? { appliesTo: rule.note } : {}
    });
  }
}

// ---------------------------------------------------------------------------
// House Purchase rules
// ---------------------------------------------------------------------------

function collectHousePurchase(out) {
  const add = entryBuilder({ id: 'house_purchase_rules', version: HOUSE_PURCHASE_RULES_VERSION }, out);
  const meta = HOUSE_PURCHASE_SOURCE_METADATA;
  const rules = HOUSE_PURCHASE_RULES;
  const law = (group, field, label, value, unit, source, checkedOn, extra = {}) => add({
    id: `ie.house_purchase.${group}.${field}`,
    quantity: extra.quantity ?? `ie.house_purchase.${group}.${field}`,
    label,
    value,
    unit,
    status: 'in_force',
    effectiveFrom: extra.effectiveFrom ?? null,
    sources: [source, ...(source.supporting ?? [])],
    checkedOn,
    usedBy: ['house_purchase'],
    ...extra
  });
  const asSource = (entry) => ({
    title: entry.label,
    url: entry.url,
    supporting: (entry.supportingUrls ?? []).map((url) => ({ title: `${entry.label} (supporting page)`, url }))
  });

  const central = asSource(meta.centralBankMortgageMeasures);
  const mortgageChecked = meta.centralBankMortgageMeasures.asOfDate;
  law('mortgage', 'first_time_buyer_income_multiple', 'Most a first-time buyer can borrow, as a multiple of income', rules.mortgage.firstTimeBuyerIncomeMultiple, 'multiple', central, mortgageChecked);
  law('mortgage', 'second_subsequent_buyer_income_multiple', 'Most a second or later buyer can borrow, as a multiple of income', rules.mortgage.secondSubsequentBuyerIncomeMultiple, 'multiple', central, mortgageChecked);
  law('mortgage', 'principal_home_max_ltv', 'Most a buyer can borrow, as a share of the home’s value', rules.mortgage.principalHomeMaxLtv, 'rate', central, mortgageChecked);
  law('mortgage', 'minimum_deposit_rate', 'Smallest deposit a buyer needs, as a share of the home’s value', rules.mortgage.minimumDepositRate, 'rate', central, mortgageChecked);

  const stamp = asSource(meta.stampDuty);
  rules.stampDuty.bands.forEach((band, index) => {
    const lower = index === 0 ? null : rules.stampDuty.bands[index - 1].upTo;
    const where = lower === null
      ? `a home’s price up to ${eur(band.upTo)}`
      : (band.upTo === null ? `the part of a home’s price above ${eur(lower)}` : `the part of a home’s price between ${eur(lower)} and ${eur(band.upTo)}`);
    law('stamp_duty', `band_${index + 1}.rate`, `Residential stamp duty on ${where}`, band.rate, 'rate', stamp, meta.stampDuty.asOfDate);
    if (band.upTo !== null) {
      law('stamp_duty', `band_${index + 1}.upper_limit`, `Residential stamp duty, upper limit of band ${index + 1}`, band.upTo, 'eur', stamp, meta.stampDuty.asOfDate);
    }
  });

  const htb = asSource(meta.helpToBuy);
  const htbChecked = meta.helpToBuy.asOfDate;
  // One quantity with two dated values, so a date picks the cap that applies to it.
  const reliefQuantity = 'ie.house_purchase.help_to_buy.maximum_relief';
  law('help_to_buy', 'maximum_relief.from_2020_07_23', 'Most Help to Buy can refund a first-time buyer, for contracts signed from 23 July 2020 to 6 October 2026', rules.helpToBuy.earlierMaximumRelief, 'eur', htb, htbChecked, { quantity: reliefQuantity, effectiveFrom: rules.helpToBuy.earlierMaximumReliefFrom });
  law('help_to_buy', 'maximum_relief.from_2026_10_07', 'Most Help to Buy can refund a first-time buyer, for contracts signed from 7 October 2026', rules.helpToBuy.maximumRelief, 'eur', htb, htbChecked, { quantity: reliefQuantity, effectiveFrom: rules.helpToBuy.maximumReliefFrom });
  law('help_to_buy', 'maximum_price', 'Highest price of a home that qualifies for Help to Buy', rules.helpToBuy.maximumPrice, 'eur', htb, htbChecked);
  law('help_to_buy', 'price_share', 'Help to Buy refund as a share of the home’s price, at most', rules.helpToBuy.priceShare, 'rate', htb, htbChecked);
  law('help_to_buy', 'minimum_qualifying_mortgage_share', 'Smallest share of the price that must be a mortgage for Help to Buy', rules.helpToBuy.minimumQualifyingMortgageShare, 'rate', htb, htbChecked);
  law('help_to_buy', 'scheme_end_date', 'Date Help to Buy ends', rules.helpToBuy.schemeEndDateIso, 'date', htb, htbChecked);

  const fhs = asSource(meta.firstHomeScheme);
  const fhsChecked = meta.firstHomeScheme.verifiedOn;
  const fhsRules = rules.firstHomeScheme;
  law('first_home_scheme', 'minimum_applicant_age', 'Youngest age an applicant to the First Home Scheme can be', fhsRules.minimumApplicantAge, 'age', fhs, fhsChecked);
  law('first_home_scheme', 'minimum_deposit_rate', 'Smallest deposit the First Home Scheme requires, as a share of the price', fhsRules.minimumDepositRate, 'rate', fhs, fhsChecked);
  law('first_home_scheme', 'minimum_equity_share', 'Smallest share of the price the First Home Scheme provides', fhsRules.minimumEquityShare, 'rate', fhs, fhsChecked);
  law('first_home_scheme', 'minimum_equity_amount', 'Smallest amount the First Home Scheme provides', fhsRules.minimumEquityAmount, 'eur', fhs, fhsChecked);
  law('first_home_scheme', 'maximum_share_without_help_to_buy', 'Most the First Home Scheme provides, as a share of the price, without Help to Buy', fhsRules.maximumShareWithoutHtb, 'rate', fhs, fhsChecked);
  law('first_home_scheme', 'maximum_share_with_help_to_buy', 'Most the First Home Scheme provides, as a share of the price, with Help to Buy', fhsRules.maximumShareWithHtb, 'rate', fhs, fhsChecked);
  fhsRules.serviceChargeBands.forEach((band, index) => {
    const years = band.toYear === null ? `from year ${band.fromYear}` : `years ${band.fromYear} to ${band.toYear}`;
    law('first_home_scheme', `service_charge.band_${index + 1}`, `First Home Scheme service charge, ${years}`, band.rate, 'rate_a_year', fhs, fhsChecked);
  });
  FHS_PRICE_CEILINGS.forEach((ceiling) => {
    const ceilingSource = { title: 'First Home Scheme, property price ceilings', url: ceiling.sourceUrl };
    for (const [type, label] of [['house', 'a house'], ['apartment', 'an apartment'], ['selfBuild', 'a self-build']]) {
      law('first_home_scheme', `price_ceiling.${ceiling.code}.${type === 'selfBuild' ? 'self_build' : type}`,
        `Highest price of ${label} the First Home Scheme covers in ${ceiling.localAuthority}`, ceiling[type], 'eur', ceilingSource, ceiling.verifiedOn);
    }
  });

  const assumption = (group, field, label, value, unit, basis, checkedOn) => add({
    id: `ie.house_purchase.${group}.${field}`,
    quantity: `ie.house_purchase.${group}.${field}`,
    label,
    value,
    unit,
    status: 'approved',
    kind: 'planeir_assumption',
    effectiveFrom: null,
    sources: [PLANEIR_SOURCE(basis)],
    checkedOn,
    checkedOnFrom: 'catalogue',
    usedBy: ['house_purchase']
  });
  const standard = 'Planeir House Purchase standard planning assumptions';
  const rulesChecked = rules.verifiedOn;
  assumption('mortgage', 'term_years', 'Mortgage term used to illustrate repayments', rules.mortgage.termYearsDefault, 'years', standard, rulesChecked);
  assumption('mortgage', 'sensitivity_rate_change', 'Change in the mortgage rate used to show how repayments would move', rules.mortgage.sensitivityRateDelta, 'rate', standard, rulesChecked);
  assumption('mortgage', 'sensitivity_terms_years', 'Mortgage terms shown side by side', rules.mortgage.sensitivityTermsYears.map((years) => `${years}`).join(', '), 'text', standard, rulesChecked);
  assumption('deposit_savings', 'projection_horizon_months', 'Longest period a deposit-saving plan is projected over', rules.depositSavings.projectionHorizonMonths, 'months', standard, rulesChecked);
  assumption('purchase_costs', 'legal_and_conveyancing', 'Standard legal and conveyancing cost of buying a home', rules.purchaseCosts.legalAndConveyancing, 'eur', standard, rulesChecked);
  assumption('purchase_costs', 'valuation', 'Standard valuation cost of buying a home', rules.purchaseCosts.valuation, 'eur', standard, rulesChecked);
  for (const [acquisition, cost] of Object.entries(rules.purchaseCosts.surveyOrEngineerByAcquisition)) {
    assumption('purchase_costs', `survey_or_engineer.${acquisition}`, `Standard survey or engineer cost, ${acquisition.replace(/_/g, ' ')}`, cost, 'eur', standard, rulesChecked);
  }
  assumption('purchase_costs', 'moving_and_furnishing', 'Standard moving and furnishing cost of buying a home', rules.purchaseCosts.movingAndFurnishing, 'eur', standard, rulesChecked);
  assumption('purchase_costs', 'contingency', 'Standard contingency allowance when buying a home', rules.purchaseCosts.contingency, 'eur', standard, rulesChecked);
}

// ---------------------------------------------------------------------------
// Central Planeir assumptions
// ---------------------------------------------------------------------------

function collectPlaneirAssumptions(out) {
  const add = entryBuilder({ id: 'planeir_assumptions', version: PLANEIR_ASSUMPTIONS_VERSION }, out);
  const a = PLANEIR_ASSUMPTIONS;
  // An assumption approved on its own day (its own `approvedOn`) carries that day; the rest carry the set's.
  const approvedText = (day) => `Planeir central planning assumptions, approved ${dateShown(day)}`;
  const row = (field, label, value, unit, basis, usedBy, ownApprovedOn = null) => add({
    id: `planeir.assumption.${field}`,
    quantity: `planeir.assumption.${field}`,
    label,
    value,
    unit,
    status: 'approved',
    kind: 'planeir_assumption',
    effectiveFrom: null,
    sources: [PLANEIR_SOURCE(ownApprovedOn ? approvedText(ownApprovedOn) : basis)],
    checkedOn: ownApprovedOn ?? a.approvedOn,
    checkedOnFrom: ownApprovedOn ? 'own' : 'catalogue',
    usedBy
  });
  const approved = approvedText(a.approvedOn);
  row('investment_growth', 'Long-term investment growth assumed, before inflation', a.investment.nominalGrowthRate, 'rate_a_year', approved, ['pension_projection']);
  row('general_inflation', 'General inflation assumed', a.inflation.generalRate, 'rate_a_year', approved, ['pension_projection', 'net_retirement_cashflow', 'college_funding', 'future_cost_fund']);
  row('education_inflation', 'Education cost inflation assumed', a.inflation.educationRate, 'rate_a_year', approved, ['college_funding', 'future_cost_fund', 'goals_and_resources']);
  row('net_retirement_present_value_rate', 'After-tax growth used to work out the fund needed for retirement spending', a.netRetirement.presentValueRate, 'rate_a_year', approved, ['net_retirement_cashflow'], a.netRetirement.approvedOn);
  row('college_start_age', 'Age a child is assumed to start college', a.collegeFunding.startAge, 'age', approved, ['college_funding', 'goals_and_resources']);
  row('college_duration_years', 'Years of college assumed for each child', a.collegeFunding.durationYears, 'years', approved, ['college_funding', 'goals_and_resources']);
  for (const scenario of a.collegeFunding.scenarios) {
    row(`college_annual_cost.${scenario.id}`, `Yearly college cost per child in today’s money, ${scenario.title.toLowerCase()}`, scenario.annualCostTodayPerChild, 'eur_a_year', approved, ['college_funding', 'goals_and_resources']);
  }
  const reserve = (key, who) => {
    row(`reserve_months.${key}.minimum`, `Cash reserve floor for a ${who} household, in months of spending`, a.liquidity[key].minimumBufferMonths, 'months', approved, ['liquidity_analysis', ...(key === 'working' ? ['house_purchase'] : [])]);
    row(`reserve_months.${key}.target`, `Cash reserve target for a ${who} household, in months of spending`, a.liquidity[key].targetBufferMonths, 'months', approved, ['liquidity_analysis', ...(key === 'working' ? ['house_purchase'] : [])]);
  };
  reserve('working', 'working');
  reserve('retired', 'retired');
}

// ---------------------------------------------------------------------------
// Market figures
// ---------------------------------------------------------------------------

function collectMarket(out) {
  const add = entryBuilder({ id: 'ie_market', version: MARKET_FIGURES_VERSION }, out);
  for (const figure of MARKET_FIGURES) {
    const evidence = figure.method.kind === 'reviewed' ? marketFigureEvidence(figure) : null;
    add({
      id: figure.id,
      quantity: figure.id,
      label: figure.label,
      value: marketFigureValue(figure.id),
      unit: figure.unit,
      status: 'current',
      kind: 'market',
      effectiveFrom: figure.changedOn,
      // What a client can be told: the published rates of large Irish banks. The
      // providers and their pages are internal provenance, in `observations`.
      sources: [{ title: 'Published rates of large Irish banks and lenders', url: null }],
      checkedOn: figure.checkedOn,
      usedBy: figure.usedBy,
      extra: {
        method: figure.method,
        changedOn: figure.changedOn,
        reviewEveryDays: figure.reviewEveryDays,
        figureVersion: figure.version,
        observations: figure.observations,
        ...(evidence ? { evidence } : {})
      }
    });
  }
}

/** Every figure in every catalogue, in a stable order. */
export function collectFigures() {
  const out = [];
  collectTaxRules(out);
  collectIrelandRules(out);
  collectSocialWelfare(out);
  collectHousePurchase(out);
  collectPlaneirAssumptions(out);
  collectMarket(out);
  const unknown = out.flatMap((figure) => figure.usedBy.filter((name) => !FIGURE_MODULES.includes(name)));
  if (unknown.length > 0) {
    throw new Error(`Figures name modules the register does not know: ${[...new Set(unknown)].join(', ')}.`);
  }
  return out;
}
