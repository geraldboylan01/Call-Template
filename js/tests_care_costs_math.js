import assert from 'node:assert/strict';

import {
  FAIR_DEAL_RULE_BLOCKS,
  FAIR_DEAL_RULES_VERSION,
  resolveFairDealRules
} from './planning/care/fair_deal_rules_ie.js';
import { socialWelfareRateOn } from './planning/social_welfare_rates.js';
import { collectFigures } from './planning/figures/collect.js';

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

const NON_CONTRIBUTORY_66_TO_79 = 'ie.social_welfare.state_pension_non_contributory.personal_66_to_79';

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
