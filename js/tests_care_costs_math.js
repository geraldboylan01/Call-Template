import assert from 'node:assert/strict';

import {
  FAIR_DEAL_RULE_BLOCKS,
  FAIR_DEAL_RULES_VERSION,
  resolveFairDealRules
} from './planning/care/fair_deal_rules_ie.js';
import { socialWelfareRateOn } from './planning/social_welfare_rates.js';
import { collectFigures } from './planning/figures/collect.js';
import { resolveTaxRules } from './planning/tax/resolve.js';
import { PLANEIR_ASSUMPTIONS } from './planning/planeir_assumptions.js';
import {
  computeCareCostProjection,
  getCareCostCases,
  getDefaultCareCostScenarioId,
  normalizeCareCostInputs
} from './care_costs_math.js';

/**
 * Typed here on purpose, from Schedule 1 of the Act and the HSE and Revenue
 * pages as read on 27 and 21 October 2026, so a slip in the catalogue cannot
 * agree with itself. The brief's "The figures register" table lists the same
 * rules with their sources.
 */
const PRINTED_RULES = Object.freeze({
  'income.share.single': 0.8,
  'income.share.couple': 0.4,
  'income.rental_share': 0,
  'assets.rate': 0.075,
  'assets.couple_divisor': 2,
  'assets.disregard.single': 36_000,
  'assets.disregard.couple': 72_000,
  'home.cap_years': 3,
  'home.couple_both_in_care_cap': 0.225,
  'retained.single_pension_share': 0.2,
  'retained.couple_at_home_pension_multiple': 1.2,
  'transfers.look_back_years': 5,
  'review.earliest_request_months': 12,
  'loan.repay_after_death_months.revenue': 12,
  'loan.repay_after_death_months.hse': 18,
  'loan.repay_on_sale_months': 6,
  'loan.late_interest_daily': 0.000219
});


/** Every run is dated, so a test never depends on the day it is run. */
export const CARE_TODAY = '2026-10-28';

const NON_CONTRIBUTORY_66_TO_79 = 'ie.social_welfare.state_pension_non_contributory.personal_66_to_79';

const SINGLE_PAYER = Object.freeze({
  taxStatus: 'single',
  people: Object.freeze([Object.freeze({
    id: 'you', age: 52, incomes: Object.freeze([Object.freeze({ type: 'employment', grossAnnual: 80_000 })])
  })])
});

const FOUR_CASES = Object.freeze([
  Object.freeze({ id: 'first', personMoney: 'first', familyFunding: 'each_year' }),
  Object.freeze({ id: 'alongside', personMoney: 'alongside', familyFunding: 'each_year' }),
  Object.freeze({ id: 'loan', basis: 'fair_deal_with_loan', personMoney: 'first', familyFunding: 'each_year' }),
  Object.freeze({ id: 'private', basis: 'private_fee', personMoney: 'first', familyFunding: 'each_year' })
]);

/**
 * The brief's worked example: Mam, 84, widowed, in Meath, a State pension of
 * €15,600 (under the over-65 exemption, so no tax), savings of €90,000 and a
 * home worth €320,000. The fee is the €1,313 the brief used; a stated fee
 * replaces the county average, so these figures do not move with the HSE's list.
 */
export const CARE_SAMPLE = Object.freeze({
  personLabel: 'Mam',
  age: 84,
  county: 'Meath',
  weeklyFee: 1313,
  incomes: Object.freeze([Object.freeze({ type: 'statePension', grossAnnual: 15_600 })]),
  cash: 90_000,
  home: Object.freeze({ value: 320_000, borrowings: 0 }),
  startsInYears: 0,
  payer: SINGLE_PAYER,
  scenarios: FOUR_CASES
});

/** A wealthy single person whose contribution is above the fee while the home counts. */
export const CARE_WEALTHY = Object.freeze({
  personLabel: 'Dad',
  age: 85,
  incomes: Object.freeze([
    Object.freeze({ type: 'statePension', grossAnnual: 16_000 }),
    Object.freeze({ type: 'occupationalPension', grossAnnual: 20_000 })
  ]),
  cash: 500_000,
  home: Object.freeze({ value: 900_000, borrowings: 0 }),
  startsInYears: 0,
  payer: SINGLE_PAYER,
  scenarios: Object.freeze([
    Object.freeze({ id: 'first', personMoney: 'first', familyFunding: 'each_year' }),
    Object.freeze({ id: 'alongside', personMoney: 'alongside', familyFunding: 'each_year' }),
    Object.freeze({ id: 'kept', personMoney: 'kept', familyFunding: 'each_year' })
  ])
});

/** One of a couple, the partner staying at home, on a low income so the retained-income threshold binds. */
export const CARE_COUPLE = Object.freeze({
  personLabel: 'Dad',
  age: 80,
  weeklyFee: 1315,
  incomes: Object.freeze([Object.freeze({ type: 'statePension', grossAnnual: 14_000 })]),
  couple: Object.freeze({ partnerIncomes: Object.freeze([Object.freeze({ type: 'statePension', grossAnnual: 10_000 })]) }),
  cash: 40_000,
  startsInYears: 0,
  durationYears: 4,
  payer: SINGLE_PAYER,
  scenarios: Object.freeze([Object.freeze({ id: 'first', personMoney: 'first', familyFunding: 'each_year' })])
});

const withInputs = (base, changes) => ({ ...base, ...changes });
const run = (inputs, options = {}) => computeCareCostProjection(inputs, { today: CARE_TODAY, ...options });
const caseOf = (projection, id) => projection.debug.cases.find((entry) => entry.id === id);

function near(actual, expected, message, tolerance = 0.005) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
}

const BANNED = /Bank of Ireland|AIB|p\.a\.|we recommend|you should|\bbest\b|\bideal\b|\boptimal\b|\bbetter\b|\bworse\b|\bcheapest\b|insurance/i;

function collectStrings(value, found = []) {
  if (typeof value === 'string') {
    found.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((entry) => collectStrings(entry, found));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => collectStrings(entry, found));
  }
  return found;
}

function runCase(name, fn) {
  try {
    fn();
    console.info(`[CareCostsTests] PASS: ${name}`);
    return { name, pass: true };
  } catch (error) {
    console.error(`[CareCostsTests] FAIL: ${name}\n    ${error.message}`);
    return { name, pass: false, error: error.message };
  }
}

export function runCareCostsTests() {
  const cases = [];

  cases.push(runCase('The Fair Deal rules in force are the ones the Act and the pages print, and the catalogue holds nothing else', () => {
    const rules = resolveFairDealRules('2026-10-28');
    assert.equal(rules.version, FAIR_DEAL_RULES_VERSION);
    assert.equal(rules.status, 'enacted');
    for (const [name, value] of Object.entries(PRINTED_RULES)) {
      assert.equal(rules.value(name), value, name);
    }
    assert.equal(FAIR_DEAL_RULE_BLOCKS[0].rules.length, Object.keys(PRINTED_RULES).length);
  }));

  cases.push(runCase('Every rule has its own id, an https source and a check date that is not in the future', () => {
    const ids = new Set();
    for (const rule of FAIR_DEAL_RULE_BLOCKS.flatMap((block) => block.rules)) {
      assert.match(rule.ruleId, /^ie\.fair_deal\.[a-z_.]+\.\d{4}$/, rule.name);
      assert.ok(!ids.has(rule.ruleId), `${rule.ruleId} is used twice`);
      ids.add(rule.ruleId);
      assert.ok(rule.sources.length > 0 && rule.sources.every((source) => /^https:\/\//.test(source.url)), rule.name);
      assert.match(rule.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, rule.name);
      assert.ok(rule.verifiedOn <= '2026-10-28', `${rule.name} is checked in the future`);
    }
  }));

  cases.push(runCase('The Act’s rules name Schedule 1 or section 30 first, and carry the day it was read', () => {
    const rules = FAIR_DEAL_RULE_BLOCKS[0].rules.filter((rule) => !rule.name.startsWith('loan.'));
    for (const rule of rules) {
      assert.match(rule.sources[0].url, /revisedacts\.lawreform\.ie\/eli\/2009\/act\/15\//, rule.name);
      assert.equal(rule.verifiedOn, '2026-10-27', rule.name);
    }
  }));

  cases.push(runCase('The loan’s two conflicting repayment periods are two rules with their own sources', () => {
    const rules = resolveFairDealRules('2026-10-28');
    assert.notEqual(rules.ruleId('loan.repay_after_death_months.revenue'), rules.ruleId('loan.repay_after_death_months.hse'));
    const blockRules = FAIR_DEAL_RULE_BLOCKS[0].rules;
    const revenue = blockRules.find((rule) => rule.name.endsWith('.revenue'));
    const hse = blockRules.find((rule) => rule.name.endsWith('.hse'));
    assert.match(revenue.sources[0].url, /revenue\.ie/);
    assert.match(hse.sources[0].url, /hse\.ie/);
  }));

  cases.push(runCase('The rules are found by date: before the first block is refused, and a later date holds the last block', () => {
    assert.throws(() => resolveFairDealRules('2024-01-31'), /recorded from 2024-02-01/);
    assert.throws(() => resolveFairDealRules('31/10/2026'), /YYYY-MM-DD/);
    assert.equal(resolveFairDealRules('2024-02-01').effectiveFrom, '2024-02-01');
    const later = resolveFairDealRules('2040-06-01');
    assert.equal(later.effectiveFrom, '2024-02-01');
    assert.equal(later.latest, true);
    assert.throws(() => later.value('income.share.nope'), /no rule named/);
  }));

  cases.push(runCase('A test catalogue changes the result: the rules are read, never copied', () => {
    const [block] = FAIR_DEAL_RULE_BLOCKS;
    const changed = Object.freeze({
      ...block,
      rules: Object.freeze(block.rules.map((rule) => (rule.name === 'assets.rate' ? { ...rule, value: 0.05 } : rule)))
    });
    assert.equal(resolveFairDealRules('2026-10-28', { catalogue: [changed] }).value('assets.rate'), 0.05);
    assert.equal(resolveFairDealRules('2026-10-28').value('assets.rate'), 0.075);
  }));

  cases.push(runCase('State Pension (Non-Contributory), aged 66 to 79: €288 now, €298 announced from January 2027, and a date before the series is refused', () => {
    assert.equal(socialWelfareRateOn(NON_CONTRIBUTORY_66_TO_79, '2026-10-28').weeklyEur, 288);
    assert.equal(socialWelfareRateOn(NON_CONTRIBUTORY_66_TO_79, '2026-12-31').weeklyEur, 288);
    const next = socialWelfareRateOn(NON_CONTRIBUTORY_66_TO_79, '2027-01-01');
    assert.equal(next.weeklyEur, 298);
    assert.equal(next.status, 'announced');
    assert.equal(next.latest, true);
    assert.throws(() => socialWelfareRateOn(NON_CONTRIBUTORY_66_TO_79, '2026-01-01'), /no rate recorded on or before/);
  }));

  cases.push(runCase('The register lists every Fair Deal rule once, as law with its source and checked date, and the care figures beside them', () => {
    const figures = collectFigures();
    const fairDeal = figures.filter((figure) => figure.catalogue.id === 'ie_fair_deal_rules');
    assert.equal(fairDeal.length, Object.keys(PRINTED_RULES).length);
    for (const figure of fairDeal) {
      assert.equal(figure.kind, 'law', figure.id);
      assert.deepEqual(figure.usedBy, ['care_costs'], figure.id);
      assert.match(figure.checkedOn, /^2026-10-(21|27)$/, figure.id);
      assert.match(figure.source.url, /^https:\/\//, figure.id);
    }
    const quantities = fairDeal.map((figure) => figure.quantity);
    assert.equal(new Set(quantities).size, quantities.length);
    assert.ok(quantities.includes('ie.fair_deal.loan.repay_after_death_months.revenue'));
    assert.ok(quantities.includes('ie.fair_deal.loan.repay_after_death_months.hse'));

    const care = figures.filter((figure) => figure.id.startsWith('planeir.assumption.care.'));
    assert.ok(care.every((figure) => figure.kind === 'planeir_assumption' && figure.usedBy.includes('care_costs')));
    const ids = care.map((figure) => figure.id);
    assert.ok(ids.includes('planeir.assumption.care.agreed_prices.list_number'));
    assert.ok(ids.includes('planeir.assumption.care.agreed_prices.county.meath.average'));
    assert.equal(ids.filter((id) => id.includes('.county.')).length, 26);
    assert.ok(ids.includes('planeir.assumption.care.relative_care.default_years'));
    assert.ok(ids.includes('planeir.assumption.care.own_care_stress.start_age'));
    const education = figures.find((figure) => figure.id === 'planeir.assumption.education_inflation');
    assert.ok(education.usedBy.includes('care_costs'));
    const pension = figures.find((figure) => figure.quantity === NON_CONTRIBUTORY_66_TO_79 && figure.status === 'in_force');
    assert.deepEqual(pension.usedBy, ['care_costs']);
  }));

  // ----------------------------------------------------------------- the engine

  cases.push(runCase('The worked example: every figure in the year-one table, and the home part stops after three years at 22.5%', () => {
    const first = caseOf(run(CARE_SAMPLE), 'first');
    const [one, two, three, four] = first.rows;
    near(one.fee, 68_276, 'weekly fee 1,313 x 52');
    near(one.incomePart, 12_480, 'keeps the larger of 20% of 15,600 (3,120) or 20% of 288 x 52 (2,995.20)');
    near(one.savingsPart, 4_050, '7.5% of 90,000 less 36,000');
    near(one.homePart, 24_000, '7.5% of 320,000');
    near(one.assessedContribution, 40_530, 'her contribution');
    near(one.contribution / 52, 779.42, 'about 779 a week', 0.01);
    near(one.hsePays, 27_746, 'the HSE pays the rest');
    assert.equal(one.fairDealApplies, true);
    assert.equal(first.fairDealYearCount, 5, 'her contribution never reaches the fee, so Fair Deal lowers the cost every year');
    near(first.homePartAssessedTotal, 72_000, 'three years of 24,000 is 22.5% of 320,000');
    near(first.homePartAssessedTotal / 320_000, 0.225, 'the cap');
    assert.equal(two.homePart, 24_000);
    assert.equal(three.homePart, 24_000);
    assert.equal(four.homePart, 0, 'nothing on the home from year four');
    assert.equal(first.homePartEndsAfterYear, 3);
    assert.equal(first.homePartEndsCalendarYear, 2029);
  }));

  cases.push(runCase('Without Fair Deal: the same year costs 68,276, her income less her allowance pays 12,480 and 55,796 is left; her savings last under two years', () => {
    const priced = caseOf(run(CARE_SAMPLE), 'private');
    const one = priced.rows[0];
    assert.equal(one.fairDealApplies, false);
    assert.equal(one.fairDealWouldNotLowerTheCost, false, 'a case that chose to pay privately is not told Fair Deal would not lower the cost');
    near(one.due, 68_276, 'the fee');
    near(one.fromIncome, 12_480, 'her income less the allowance Fair Deal leaves her');
    near(one.fromSavings, 55_796, 'what is left');
    assert.equal(priced.savingsLastYears, 1);
    assert.ok(priced.rows[1].familyBeforeRelief > 0, 'after that the family pays');
    near(priced.rows.reduce((total, row) => total + row.hsePays, 0), 0, 'the HSE pays nothing');
  }));

  cases.push(runCase('The Nursing Home Loan: the home part is deferred in Fair Deal years, grown with prices, and shown in today’s money', () => {
    const loan = caseOf(run(CARE_SAMPLE), 'loan');
    near(loan.rows[0].due, 40_530 - 24_000, 'the home part is not due');
    near(loan.rows[0].deferredToLoan, 24_000, 'deferred');
    assert.equal(loan.rows[3].deferredToLoan, 0, 'nothing from year four');
    near(loan.loanTodaysMoney, 24_000 * (1 + 1 / 1.02 + 1 / 1.02 ** 2), 'each deferred part, deflated to today', 0.01);
    near(loan.loanAtEnd, 24_000 * (1.02 ** 5 + 1.02 ** 4 + 1.02 ** 3), 'each deferred part, grown with prices to the end of care', 0.01);
    near(loan.estateHomeAfterLoanTodaysMoney, 320_000 - loan.loanTodaysMoney, 'the home less the loan');
    assert.equal(caseOf(run(CARE_SAMPLE), 'first').loanTodaysMoney, 0, 'no loan unless the case defers');
  }));

  cases.push(runCase('Fair Deal only when it lowers the cost: a wealthy person pays privately in years 1 to 3 and uses it from year 4 for every setting', () => {
    const projection = run(CARE_WEALTHY);
    for (const id of ['first', 'alongside', 'kept']) {
      const [one, two, three, four, five] = caseOf(projection, id).rows;
      [one, two, three].forEach((row) => {
        near(row.homePart, 67_500, `${id}: the home alone adds 7.5% of 900,000`);
        assert.equal(row.fairDealApplies, false, `${id} year ${row.yearInCare} is private`);
        assert.equal(row.fairDealWouldNotLowerTheCost, true, `${id} year ${row.yearInCare} says so`);
        assert.equal(row.hsePays, 0);
        assert.ok(row.assessedContribution > row.fee);
      });
      // The three years count from entering care, not from the first Fair Deal year.
      [four, five].forEach((row) => {
        assert.equal(row.homePart, 0, `${id}: no home part in year ${row.yearInCare}`);
        assert.equal(row.fairDealApplies, true, `${id}: Fair Deal applies in year ${row.yearInCare}`);
        assert.ok(row.assessedContribution < row.fee);
      });
    }
  }));

  cases.push(runCase('Applying after time in care: three years in care means nothing on the home, two years leaves one year of it', () => {
    const three = run(withInputs(CARE_SAMPLE, { yearsInCareSoFar: 3 }));
    caseOf(three, 'first').rows.forEach((row) => assert.equal(row.homePart, 0, `year ${row.yearInCare}`));
    assert.equal(caseOf(three, 'first').rows[0].yearInCare, 4);
    const two = caseOf(run(withInputs(CARE_SAMPLE, { yearsInCareSoFar: 2 })), 'first');
    assert.equal(two.rows[0].homePart, 24_000);
    assert.equal(two.rows[1].homePart, 0);
    assert.equal(two.homePartEndsAfterYear, 3);
  }));

  cases.push(runCase('A couple with the partner at home: the retained-income threshold (1.2 times the State Pension rate) binds on a low income', () => {
    const [row] = caseOf(run(CARE_COUPLE), 'first').rows;
    near(row.netIncome, 24_000, 'both State pensions, under the exemption, so no tax');
    near(row.retainedIncomeThreshold, 1.2 * 288 * 52, 'the rate and 20% of it');
    assert.equal(row.safeguardBinds, true);
    near(row.incomePart, 24_000 - (1.2 * 288 * 52), 'the couple’s income less the threshold, not 40% of it');
    near(row.savingsPart, 0, 'savings under the couple’s 72,000');
    near(row.assessedContribution, 6_028.8, 'the contribution');
  }));

  cases.push(runCase('Income below the State pension: 20% of the State pension rate sets the allowance', () => {
    const [row] = caseOf(run(withInputs(CARE_SAMPLE, {
      incomes: [{ type: 'statePension', grossAnnual: 9_000 }], cash: 0, home: undefined, scenarios: [FOUR_CASES[0]]
    })), 'first').rows;
    assert.equal(row.safeguardBinds, true);
    near(row.retainedIncomeThreshold, 0.2 * 288 * 52, '2,995.20');
    near(row.incomePart, 9_000 - 2_995.2, 'she keeps 2,995.20, not 20% of 9,000');
  }));

  cases.push(runCase('Transferred assets count though they cannot be spent', () => {
    const [row] = caseOf(run(withInputs(CARE_SAMPLE, {
      cash: 0, home: undefined, scenarios: [FOUR_CASES[0]], transferredInLastFiveYears: { cash: 100_000, nonCash: 0 }
    })), 'first').rows;
    near(row.savingsPart, (100_000 - 36_000) * 0.075, 'assessed on 100,000 less 36,000');
    assert.equal(row.fromSavings, 0, 'but there is nothing to spend');
    assert.ok(row.familyBeforeRelief > 0, 'so the family meets what the income does not');
  }));

  cases.push(runCase('Rent from her home under a registered tenancy is not charged, yet counts in full towards what she keeps', () => {
    const base = withInputs(CARE_SAMPLE, {
      incomes: [{ type: 'statePension', grossAnnual: 9_000 }], cash: 0, home: { value: 200_000, borrowings: 0 }
    });
    const exempt = caseOf(run(withInputs(base, { homeRent: { annual: 8_000 } })), 'first').rows[0];
    near(exempt.eligibleRent, 8_000, 'no tax on 17,000 at her age');
    near(exempt.incomePart, 0.8 * 9_000, '80% of her pension, 0% of the rent');
    const charged = caseOf(run(withInputs(base, { homeRent: { annual: 8_000, exemptionApplied: false } })), 'first').rows[0];
    near(charged.eligibleRent, 0);
    near(charged.incomePart, 0.8 * 17_000, 'with no exemption the rent is income like any other');
  }));

  cases.push(runCase('Each way of using her money: "first" spends it, "alongside" spreads it so it lasts exactly as long as the care, "kept" never spends it', () => {
    const projection = run(CARE_SAMPLE);
    const alongside = caseOf(projection, 'alongside');
    assert.ok(alongside.rows[0].familyBeforeRelief > 0, 'the family pays from year one, so its relief starts in year one');
    assert.ok(alongside.rows[0].relief > 0);
    assert.equal(alongside.savingsLastYears, 5);
    assert.equal(caseOf(projection, 'first').rows[0].familyBeforeRelief, 0);
    const kept = caseOf(run(withInputs(CARE_SAMPLE, {
      scenarios: [{ id: 'kept', personMoney: 'kept', familyFunding: 'each_year' }]
    })), 'kept');
    assert.ok(kept.rows.every((row) => row.fromSavings === 0));
    assert.ok(kept.rows[0].familyBeforeRelief > 0);
    assert.ok(kept.savingsLeft > 90_000, 'untouched savings only earn interest');
  }));

  cases.push(runCase('Relief is at the payer’s real rate: 40% above the band, a mix across it, and nothing where there is no tax to pay', () => {
    const alongside = (payerIncome) => caseOf(run(withInputs(CARE_SAMPLE, {
      payer: { taxStatus: 'single', people: [{ id: 'you', age: 52, incomes: [{ type: 'employment', grossAnnual: payerIncome }] }] },
      scenarios: [{ id: 'alongside', personMoney: 'alongside', familyFunding: 'each_year' }]
    })), 'alongside').rows[0];
    const high = alongside(80_000);
    near(high.relief, 0.4 * high.nursingHomePart, 'all above the 44,000 band');
    const straddling = alongside(46_000);
    near(straddling.relief, (0.2 * straddling.nursingHomePart) + (0.2 * 2_000), '40% on the 2,000 above the band and 20% on the rest');
    const low = alongside(10_000);
    assert.equal(low.relief, 0, 'no income tax to pay');
    assert.equal(low.familyAfterRelief, low.familyBeforeRelief);
    assert.ok(high.familyAfterRelief < high.familyBeforeRelief);
  }));

  cases.push(runCase('Extras do not qualify for relief, and the family is taken to meet them last', () => {
    const projection = run(withInputs(CARE_SAMPLE, {
      weeklyExtras: 50,
      scenarios: [{ id: 'alongside', personMoney: 'alongside', familyFunding: 'each_year' }]
    }));
    const [row] = caseOf(projection, 'alongside').rows;
    near(row.extras, 50 * 52, 'extras for a year');
    near(row.due, row.contribution + row.extras, 'on top of the contribution');
    near(row.nursingHomePart, Math.max(0, row.familyBeforeRelief - row.extras), 'relief is on the family’s share above the extras');
    near(row.relief, 0.4 * row.nursingHomePart);
  }));

  cases.push(runCase('Care past the payer’s retirement: the family’s amounts split at the year every payer has retired', () => {
    const retiring = withInputs(CARE_SAMPLE, {
      payer: {
        taxStatus: 'single',
        people: [{
          id: 'you', age: 52, incomes: [{ type: 'employment', grossAnnual: 80_000 }],
          retiresInYears: 2, incomesAfterRetirement: [{ type: 'occupationalPension', grossAnnual: 20_000 }]
        }]
      },
      scenarios: [{ id: 'private', basis: 'private_fee', personMoney: 'first', familyFunding: 'each_year' }]
    });
    const priced = caseOf(run(retiring), 'private');
    assert.equal(priced.retirementYearIndex, 2);
    near(priced.beforeRetirement, priced.rows[0].familyAfterRelief + priced.rows[1].familyAfterRelief);
    near(priced.afterRetirement, priced.rows.slice(2).reduce((total, row) => total + row.familyAfterRelief, 0));
    near(priced.beforeRetirement + priced.afterRetirement, priced.familyTotalAfterRelief);
    assert.ok(priced.rows[3].relief < 0.4 * priced.rows[3].nursingHomePart, 'a pension of 20,000 does not reach the higher rate');
    assert.equal(caseOf(run(CARE_SAMPLE), 'first').beforeRetirement, null, 'no retirement year given, no split');
  }));

  cases.push(runCase('Defaults: five years with 3 and 10 beside them, the national average with no county, the county average with one, a stated fee over both', () => {
    const prices = PLANEIR_ASSUMPTIONS.care.agreedPrices;
    const bare = { ...CARE_SAMPLE };
    delete bare.weeklyFee;
    delete bare.county;
    const national = run(bare);
    assert.equal(national.debug.inputs.durationYears, 5);
    assert.deepEqual(national.debug.inputs.compareDurations, [3, 10]);
    assert.deepEqual(national.debug.compareDurations.map((entry) => entry.durationYears), [3, 10]);
    near(caseOf(national, 'first').rows[0].fee, prices.nationalWeeklyAverage * 52, 'national average');
    assert.equal(national.debug.rulesUsed.priceList.feeSource, 'national_average');
    const meath = run({ ...bare, county: 'meath' });
    near(caseOf(meath, 'first').rows[0].fee, prices.countyWeeklyAverages.Meath.average * 52, 'county average');
    assert.equal(meath.debug.rulesUsed.priceList.feeSource, 'county_average');
    assert.equal(meath.debug.inputs.county, 'Meath');
    const stated = run({ ...bare, county: 'Meath', weeklyFee: 1400 });
    near(caseOf(stated, 'first').rows[0].fee, 1400 * 52, 'stated fee');
    assert.equal(stated.debug.rulesUsed.priceList.feeSource, 'stated');
    assert.deepEqual(normalizeCareCostInputs({ ...bare, durationYears: 10 }).compareDurations, [3], 'the default never repeats the main length');
    assert.equal(caseOf(run({ ...bare, durationYears: 8 }), 'first').rows.length, 8);
  }));

  cases.push(runCase('The State Pension rate behind the safeguard is the one on the day care starts, either side of 1 January 2027', () => {
    const threshold = (today, startsInYears = 0) => run(withInputs(CARE_COUPLE, { startsInYears }), { today })
      .debug.cases[0].rows[0].retainedIncomeThreshold;
    near(threshold('2026-12-31'), 1.2 * 288 * 52, '288 on 31 December 2026');
    near(threshold('2027-01-01'), 1.2 * 298 * 52, '298 on 1 January 2027');
    near(threshold('2026-10-28', 1), 1.2 * 298 * 52, 'care starting in a year uses the rate on that day');
    const used = run(CARE_COUPLE, { today: '2027-01-01' }).debug.rulesUsed.statePensionNonContributory;
    assert.equal(used.weeklyEur, 298);
    assert.equal(used.status, 'announced');
  }));

  cases.push(runCase('Every rule is read: a test catalogue changes the result, and so does a test date', () => {
    const [block] = FAIR_DEAL_RULE_BLOCKS;
    const changed = [Object.freeze({
      ...block,
      rules: Object.freeze(block.rules.map((rule) => (rule.name === 'assets.rate' ? { ...rule, value: 0.05 } : rule)))
    })];
    const [row] = caseOf(run(CARE_SAMPLE, { fairDealCatalogue: changed }), 'first').rows;
    near(row.savingsPart, 0.05 * 54_000, 'the savings part follows the catalogue');
    near(row.homePart, 0.05 * 320_000, 'and so does the home part');
    const later = [Object.freeze({ ...block, effectiveFrom: '2030-01-01' })];
    assert.throws(() => run(CARE_SAMPLE, { fairDealCatalogue: later }), /recorded from 2030-01-01/);
  }));

  cases.push(runCase('Rates are central: fees rise at the education and healthcare rate, savings earn the cash rate after DIRT, and a test can inject both', () => {
    const projection = run(CARE_SAMPLE);
    const used = projection.debug.assumptionsUsed;
    assert.equal(used.feeGrowthRate, PLANEIR_ASSUMPTIONS.inflation.educationRate);
    assert.equal(used.generalRate, PLANEIR_ASSUMPTIONS.inflation.generalRate);
    near(used.cashRateNet, PLANEIR_ASSUMPTIONS.cash.instantAccessGrossRate * (1 - resolveTaxRules(2026).dirt.rate), 'gross x (1 - DIRT)', 1e-12);
    const rows = caseOf(projection, 'first').rows;
    near(rows[1].fee / rows[0].fee, 1.04, 'fees rise 4% a year', 1e-12);
    const injected = run(CARE_SAMPLE, {
      assumptions: { ...PLANEIR_ASSUMPTIONS, inflation: { generalRate: 0.03, educationRate: 0.03 } }
    });
    near(caseOf(injected, 'first').rows[1].fee / caseOf(injected, 'first').rows[0].fee, 1.03, 'the injected rate', 1e-12);
    assert.deepEqual(projection.debug.notYetBuilt.slice(0, 3), ['lumpSumNow', 'yearlyFromHousehold', 'retirementCapitalNeeded']);
  }));

  cases.push(runCase('The course’s conventions are injectable and nothing else: a flat relief rate and no allowance in a private year', () => {
    const flat = caseOf(run(CARE_SAMPLE, { flatReliefRate: 0.4 }), 'alongside').rows[0];
    near(flat.relief, 0.4 * flat.nursingHomePart);
    const none = caseOf(run(CARE_SAMPLE, { privateAllowance: 'none' }), 'private').rows[0];
    near(none.fromIncome, 15_600, 'she keeps nothing');
    assert.throws(() => normalizeCareCostInputs({ ...CARE_SAMPLE, flatReliefRate: 0.4 }), /flatReliefRate is not accepted/);
  }));

  cases.push(runCase('Rejections, with the exact messages', () => {
    const refused = (changes, expected) => assert.throws(
      () => normalizeCareCostInputs(withInputs(CARE_SAMPLE, changes)),
      (error) => error.message === expected,
      expected
    );
    const f = 'generated.careCostInputs';
    refused({
      startsInYears: 0,
      scenarios: [FOUR_CASES[0], FOUR_CASES[1], { id: 'x', title: 'Lump sum now', personMoney: 'first', familyFunding: 'save_then_pay' }]
    }, `${f}.scenarios[2] (Lump sum now): save_then_pay needs care to start in a later year.`);
    refused({ county: 'Atlantis' }, `${f}.county must be one of the 26 counties.`);
    refused({
      scenarios: [{ id: 'p', title: 'Paid privately', basis: 'free', personMoney: 'first', familyFunding: 'each_year' }]
    }, `${f}.scenarios[0] (Paid privately): basis must be "lower_of", "fair_deal_with_loan" or "private_fee".`);
    refused({ feeGrowthRate: 0.05 }, `${f}.feeGrowthRate is not accepted. Fair Deal rules and rates are set centrally.`);
    refused({ assetRate: 0.1 }, `${f}.assetRate is not accepted. Fair Deal rules and rates are set centrally.`);
    refused({
      payer: { taxStatus: 'single', people: [{ id: 'you', age: 52, incomes: [], retiresInYears: 5 }] }
    }, `${f}.payer.people[0].incomesAfterRetirement is required when retiresInYears is given.`);
    refused({
      scenarios: [FOUR_CASES[0], FOUR_CASES[1], FOUR_CASES[2], FOUR_CASES[3], { id: 'fifth', personMoney: 'first', familyFunding: 'each_year' }]
    }, `${f}.scenarios supports at most 4 cases; received 5.`);
    refused({ scenarios: [FOUR_CASES[0], FOUR_CASES[0]] }, `${f}.scenarios[1].id must be unique.`);
    refused({ surprise: 1 }, `${f}.surprise is not a care costs field.`);
    refused({ startsInYears: 2, yearsInCareSoFar: 1 }, `${f}.yearsInCareSoFar can only be given when startsInYears is 0.`);
    refused({ home: undefined }, `${f}.scenarios[2] (With the Nursing Home Loan): fair_deal_with_loan needs a home.`);
    refused({ couple: { partnerIncomes: [] } }, `${f}.couple.partnerIncomes needs at least one income.`);
    refused({ baseScenarioId: 'nope' }, `${f}.baseScenarioId must match a case id.`);
    refused({ compareDurations: [5] }, `${f}.compareDurations[0] must differ from durationYears.`);
    for (const text of ['The best option', 'You should choose this', 'Paid through AIB', 'Cheapest way', 'p.a. 12,000']) {
      assert.throws(() => normalizeCareCostInputs(withInputs(CARE_SAMPLE, {
        scenarios: [{ id: 'w', title: text, personMoney: 'first', familyFunding: 'each_year' }]
      })), /never recommends or ranks/, text);
    }
    assert.throws(() => normalizeCareCostInputs(withInputs(CARE_SAMPLE, {
      scenarios: [{ id: 'w', description: 'costs €68276 a year', personMoney: 'first', familyFunding: 'each_year' }]
    })), /thousands separator/);
    assert.throws(() => normalizeCareCostInputs(withInputs(CARE_SAMPLE, { personLabel: 'Mam, the best' })), /never recommends or ranks/);
  }));

  cases.push(runCase('Normalising is idempotent, the cases are listed for the presenter, and the base case defaults to the first', () => {
    const once = normalizeCareCostInputs(CARE_SAMPLE);
    assert.deepEqual(normalizeCareCostInputs(once), once);
    assert.deepEqual(getCareCostCases(CARE_SAMPLE).map((entry) => entry.title), [
      'Mam’s money first', 'Mam’s money alongside yours', 'With the Nursing Home Loan', 'Paid privately, without Fair Deal'
    ]);
    assert.equal(getDefaultCareCostScenarioId(CARE_SAMPLE), 'first');
    assert.equal(getDefaultCareCostScenarioId(withInputs(CARE_SAMPLE, { baseScenarioId: 'private' })), 'private');
  }));

  cases.push(runCase('The words: every table and sentence is plain, names no provider, recommends nothing and writes amounts with a separator', () => {
    const projection = run(CARE_SAMPLE);
    const text = collectStrings({ a: projection.assumptionsTable, o: projection.outputsTable, t: projection.tables });
    text.forEach((entry) => {
      assert.ok(!BANNED.test(entry), `banned wording in "${entry}"`);
      assert.ok(!/€\d{4,}/.test(entry), `an amount without a thousands separator in "${entry}"`);
    });
    const rates = projection.assumptionsTable.rows.map((row) => row[1]).join(' | ');
    assert.ok(rates.includes('4% a year') && rates.includes('0.2% a year') && rates.includes('0.13% a year') && rates.includes('33%'));
    assert.ok(rates.includes('€288 a week') && rates.includes('ie-fair-deal-2026.1'));
    assert.ok(rates.includes('A review of the Fair Deal assessment is assumed each year'));
    const wealthy = collectStrings(run(CARE_WEALTHY).tables);
    assert.ok(wealthy.some((entry) => entry.includes('Fair Deal would not lower the cost this year')), 'a private year says so in those words');
    assert.ok(!wealthy.some((entry) => /not eligible|refused/i.test(entry)));
  }));

  const passed = cases.filter((entry) => entry.pass).length;
  const failed = cases.length - passed;
  const summary = { total: cases.length, passed, failed, results: cases };

  if (failed > 0) {
    console.warn('[CareCostsTests] Completed with failures', summary);
  } else {
    console.info('[CareCostsTests] All tests passed', { total: summary.total, passed: summary.passed });
  }

  return summary;
}
