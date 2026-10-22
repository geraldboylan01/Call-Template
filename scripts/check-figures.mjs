// The figures register: every figure that can change (law, market prices,
// Planeir's own assumptions), with its value, its source and when it was checked.
//
// This grows with the register. Market figures first: the arithmetic that works
// a value out of its quotes, the soundness of every catalogue entry, and the
// proof that the modules read the register instead of carrying their own copy.
// Then the law the modules used to type in for themselves, now in a catalogue,
// and the social welfare rates the protection gap needs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MARKET_FIGURES, MARKET_FIGURES_VERSION } from '../js/planning/figures/market_ie.js';
import {
  marketFigure,
  marketFigureEvidence,
  marketFigureProblems,
  marketFigureValue,
  resolveMarketFigureValue,
  roundToStep
} from '../js/planning/figures/market_math.js';
import { PROVIDER_NAMES, namesAProvider } from '../js/planning/figures/kinds.js';
import { PLANEIR_ASSUMPTIONS, assumptionRecord } from '../js/planning/planeir_assumptions.js';
import { HOUSE_PURCHASE_RULES } from '../js/house_purchase/config.js';
import { IRISH_PENSION_RELIEF_LIMITS } from '../js/planning/ireland_rules.js';
import { IE_TAX_RULES_BY_YEAR } from '../js/planning/tax/rules_ie.js';
import {
  PENSION_EARNINGS_CAP,
  maxRelievableContributionRatePercent,
  maxRelievablePersonalContribution,
  normalizePensionInputs,
  pensionConversationGuidance
} from '../js/pension_math.js';
import { normalizeNetRetirementInputs } from '../js/net_retirement_math.js';
import { normalizeCollegeFundingInputs } from '../js/college_funding_math.js';
import { assumptionLabel } from '../js/planning/planeir_assumptions.js';
import { IRISH_STATE_PENSION_CONTRIBUTORY } from '../js/planning/ireland_rules.js';
import { SOCIAL_WELFARE_RATES_VERSION, SOCIAL_WELFARE_SERIES } from '../js/planning/social_welfare_ie.js';
import {
  socialWelfareAnnualEur,
  socialWelfareRateOn,
  socialWelfareSeries,
  socialWelfareSeriesProblems
} from '../js/planning/social_welfare_rates.js';

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.info(`[Figures] PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[Figures] FAIL: ${name}\n    ${error.message}`);
  }
}

const observation = (value, extra = {}) => ({
  sourceLabel: 'Example source',
  url: 'https://example.ie/rates',
  value,
  quotedAs: 'AER',
  effective: null,
  retrievedOn: '2026-10-22',
  ...extra
});

const figureOf = (method, values) => ({
  id: 'ie.market.test.example',
  label: 'An example rate',
  unit: 'rate_a_year',
  method,
  observations: values.map((value) => observation(value)),
  checkedOn: '2026-10-22',
  changedOn: '2026-10-01',
  reviewEveryDays: 35,
  usedBy: ['house_purchase'],
  version: '1.0.0'
});

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

check('the mean of two quotes rounds to the step', () => {
  assert.equal(resolveMarketFigureValue(figureOf({ kind: 'mean', roundTo: 0.001 }, [0.001, 0.0025])), 0.002);
});

check('the median ignores one outlying quote, where the mean would not', () => {
  const values = [0.02, 0.03, 0.02];
  assert.equal(resolveMarketFigureValue(figureOf({ kind: 'median', roundTo: 0.001 }, values)), 0.02);
  assert.equal(resolveMarketFigureValue(figureOf({ kind: 'mean', roundTo: 0.001 }, values)), 0.023);
});

check('the median of an even count is the mean of the middle two', () => {
  assert.equal(resolveMarketFigureValue(figureOf({ kind: 'median', roundTo: 0.0001 }, [0.01, 0.02, 0.03, 0.05])), 0.025);
});

check('a single source needs exactly its one quote', () => {
  assert.equal(resolveMarketFigureValue(figureOf({ kind: 'single', roundTo: 0.0025 }, [0.0376])), 0.0375);
  assert.throws(() => resolveMarketFigureValue(figureOf({ kind: 'single' }, [])), /at least 1 observation/);
});

check('a mean or median of one quote is refused', () => {
  assert.throws(() => resolveMarketFigureValue(figureOf({ kind: 'mean', roundTo: 0.001 }, [0.02])), /at least 2 observations/);
});

check('rounding is exact, with none of the float residue', () => {
  assert.equal(roundToStep(7 * 0.005, 0.005), 0.035);
  assert.equal(roundToStep(0.00175, 0.001), 0.002);
  assert.equal(roundToStep(0.0225, 0.005), 0.025);
  assert.equal(roundToStep(0.0224, 0.005), 0.02);
  assert.equal(roundToStep(0.0123, undefined), 0.0123, 'no step leaves the value alone');
});

check('the result does not depend on the order the quotes were collected in', () => {
  const forward = resolveMarketFigureValue(figureOf({ kind: 'median', roundTo: 0.001 }, [0.01, 0.02, 0.04]));
  const backward = resolveMarketFigureValue(figureOf({ kind: 'median', roundTo: 0.001 }, [0.04, 0.02, 0.01]));
  assert.equal(forward, backward);
});

check('a non-numeric quote is refused rather than counted as zero', () => {
  const bad = figureOf({ kind: 'mean', roundTo: 0.001 }, [0.01, 0.02]);
  bad.observations[1] = observation('2%');
  assert.throws(() => resolveMarketFigureValue(bad), /no numeric value/);
});

check('a reviewed figure keeps the value a person chose, and reports where the evidence points', () => {
  const figure = figureOf({ kind: 'reviewed', value: 0.035, reviewedOn: '2026-07-11', driftWarnAt: 0.002 }, [0.04, 0.036, 0.0375]);
  assert.equal(resolveMarketFigureValue(figure), 0.035);
  const evidence = marketFigureEvidence(figure);
  assert.equal(evidence.median, 0.0375);
  assert.equal(evidence.gap, 0.0025);
  assert.equal(evidence.drifted, true);
  const close = figureOf({ kind: 'reviewed', value: 0.037, reviewedOn: '2026-07-11', driftWarnAt: 0.002 }, [0.04, 0.036, 0.0375]);
  assert.equal(marketFigureEvidence(close).drifted, false);
});

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

check('every market figure is sound: id, label, quotes with dates and https sources, method and module names', () => {
  const problems = MARKET_FIGURES.flatMap((figure) => marketFigureProblems(figure));
  assert.deepEqual(problems, []);
});

check('the catalogue carries a version, and every figure in it has one', () => {
  assert.match(MARKET_FIGURES_VERSION, /^ie-market-\d{4}\.\d+$/);
  MARKET_FIGURES.forEach((figure) => assert.match(figure.version, /^\d+\.\d+\.\d+$/, figure.id));
});

check('market figure ids are unique', () => {
  const ids = MARKET_FIGURES.map((figure) => figure.id);
  assert.equal(new Set(ids).size, ids.length);
});

check('the shape check refuses what a hand edit could get wrong', () => {
  const sound = MARKET_FIGURES[0];
  const mutations = [
    ['a label that names a bank', { label: 'Bank of Ireland instant-access rate' }, /names a provider/],
    ['a quote with no https source', { observations: [{ ...sound.observations[0], url: 'http://x' }, sound.observations[1]] }, /https url/],
    ['a quote read after the figure was checked', { checkedOn: '2026-10-01' }, /retrieved after checkedOn/],
    ['a changedOn after checkedOn', { changedOn: '2026-12-01' }, /changedOn is later than checkedOn/],
    ['an unknown module', { usedBy: ['not_a_module'] }, /unknown module/],
    ['a unit we do not know', { unit: 'percent' }, /unit must be/],
    ['no review interval', { reviewEveryDays: 0 }, /reviewEveryDays/]
  ];
  for (const [what, patch, expected] of mutations) {
    const problems = marketFigureProblems({ ...sound, ...patch });
    assert.ok(problems.some((problem) => expected.test(problem)), `${what} should be refused; got ${JSON.stringify(problems)}`);
  }
});

check('provider names are never in a label, and the name check matches whole words only', () => {
  MARKET_FIGURES.forEach((figure) => assert.equal(namesAProvider(figure.label), null, figure.id));
  assert.equal(namesAProvider('Published by AIB'), 'AIB');
  assert.equal(namesAProvider('A said that'), null, 'a word containing a name is not a name');
  assert.ok(PROVIDER_NAMES.includes('PTSB'));
});

check('the mortgage illustration is a reviewed figure whose evidence is recorded', () => {
  const figure = marketFigure('ie.market.mortgage.illustration_rate');
  assert.equal(figure.method.kind, 'reviewed');
  assert.ok(figure.observations.length >= 3);
  assert.equal(typeof marketFigureEvidence(figure).median, 'number');
});

// ---------------------------------------------------------------------------
// The modules read the register
// ---------------------------------------------------------------------------

check('the central cash assumption reads the register, quotes and all', () => {
  const id = 'ie.market.cash.instant_access_gross_rate';
  assert.equal(PLANEIR_ASSUMPTIONS.cash.instantAccessGrossRate, marketFigureValue(id));
  assert.equal(PLANEIR_ASSUMPTIONS.cash.figureId, id);
  assert.equal(PLANEIR_ASSUMPTIONS.cash.checkedOn, marketFigure(id).checkedOn);
  assert.equal(assumptionRecord('cashRate').value, marketFigureValue(id));
  assert.equal('observed' in PLANEIR_ASSUMPTIONS.cash, false, 'the quotes live in the register only');
});

check('House Purchase reads the regular-saver and mortgage-illustration rates from the register, every place it states them', () => {
  const saver = marketFigureValue('ie.market.cash.regular_saver_gross_rate');
  const mortgage = marketFigureValue('ie.market.mortgage.illustration_rate');
  assert.equal(HOUSE_PURCHASE_RULES.depositSavingsGrossAerDefault, saver);
  assert.equal(HOUSE_PURCHASE_RULES.depositSavings.grossAerDefault, saver);
  assert.equal(HOUSE_PURCHASE_RULES.mortgageRateIllustrationDefault, mortgage);
  assert.equal(HOUSE_PURCHASE_RULES.mortgage.illustrationRateDefault, mortgage);
});

// ---------------------------------------------------------------------------
// Law the modules used to carry for themselves: pension relief limits
// ---------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const repoFile = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

check('the pension relief limits are a sound catalogue entry: bands ascend from age 0, rates rise, sources are https, verified on a date', () => {
  const limits = IRISH_PENSION_RELIEF_LIMITS;
  assert.ok(ISO.test(limits.verifiedOn), 'verifiedOn is a date');
  assert.equal(limits.ageBands[0].fromAge, 0, 'the first band starts at birth');
  limits.ageBands.forEach((band, index) => {
    assert.ok(band.rate > 0 && band.rate < 1, `band ${index} rate is a share`);
    if (index > 0) {
      assert.ok(band.fromAge > limits.ageBands[index - 1].fromAge, `band ${index} starts later than the one before`);
      assert.ok(band.rate > limits.ageBands[index - 1].rate, `band ${index} allows more than the one before`);
    }
  });
  assert.ok(limits.earningsCap.amountEur > 0 && ISO.test(limits.earningsCap.effectiveFrom), 'the cap has an amount and a date');
  assert.ok(limits.sources.length >= 1 && limits.sources.every((source) => /^https:\/\//.test(source.url) && source.title), 'every source has a title and an https url');
});

check('the pension engine applies the catalogue at every whole age and salary, against an independent reference', () => {
  const { ageBands, earningsCap } = IRISH_PENSION_RELIEF_LIMITS;
  const reference = (age) => {
    let rate = ageBands[0].rate;
    for (const band of ageBands) if (age >= band.fromAge) rate = band.rate;
    return rate;
  };
  for (let age = 0; age <= 110; age += 1) {
    assert.equal(maxRelievableContributionRatePercent(age), Math.round(reference(age) * 100), `rate at ${age}`);
    for (const salary of [0, 30_000, earningsCap.amountEur, 200_000]) {
      assert.equal(
        maxRelievablePersonalContribution(age, salary),
        reference(age) * Math.min(salary, earningsCap.amountEur),
        `limit at ${age} on ${salary}`
      );
    }
  }
  assert.equal(PENSION_EARNINGS_CAP, earningsCap.amountEur);
  assert.equal(maxRelievableContributionRatePercent(-1), null);
  assert.equal(maxRelievableContributionRatePercent(Number.NaN), null);
});

check('the wording the conversation uses states every band and the cap from the catalogue', () => {
  const text = pensionConversationGuidance().join(' ');
  IRISH_PENSION_RELIEF_LIMITS.ageBands.forEach((band) => {
    assert.ok(text.includes(`${Math.round(band.rate * 100)}%`), `${band.rate} is stated`);
  });
  assert.ok(text.includes(IRISH_PENSION_RELIEF_LIMITS.earningsCap.amountEur.toLocaleString('en-IE')), 'the cap is stated');
});

// ---------------------------------------------------------------------------
// Central assumptions: nothing keeps a copy of its own
// ---------------------------------------------------------------------------

check('the pension engine defaults to the central growth, inflation and pay-growth assumptions', () => {
  const inputs = normalizePensionInputs({
    currentYear: 2026,
    targetIncomePctOfSalary: 0.5,
    pensions: [{ id: 'a', title: 'A', currentAge: 42, retirementAge: 67, currentSalary: 85_000, currentPot: 180_000, personalPct: 0.08, employerPct: 0.06 }]
  });
  assert.equal(inputs.growthRate, PLANEIR_ASSUMPTIONS.investment.nominalGrowthRate);
  assert.equal(inputs.inflationRate, PLANEIR_ASSUMPTIONS.inflation.generalRate);
  assert.equal(inputs.wageGrowthRate, PLANEIR_ASSUMPTIONS.inflation.generalRate);
});

check('the net retirement engine defaults to the central inflation and present-value assumptions', () => {
  const inputs = normalizeNetRetirementInputs({
    annualExpenditureToday: 50_000,
    incomeSources: [{ id: 'a', title: 'A', annualAmountToday: 1_000, startAge: 66 }]
  });
  assert.equal(inputs.expenditureInflationRate, PLANEIR_ASSUMPTIONS.inflation.generalRate);
  assert.equal(inputs.presentValueRate, PLANEIR_ASSUMPTIONS.netRetirement.presentValueRate);
});

check('the college engine defaults to the central general inflation assumption', () => {
  const inputs = normalizeCollegeFundingInputs({
    currentYear: 2026,
    children: [{ id: 'c', title: 'C', currentAge: 10, collegeStartAge: 18, collegeDurationYears: 4 }],
    scenarios: [{ id: 's', title: 'S', annualCostTodayPerChild: 5_000 }]
  });
  assert.equal(inputs.inflationRate, PLANEIR_ASSUMPTIONS.inflation.generalRate);
});

check('the present-value rate is a named central assumption with a plain basis, a label, and no provider', () => {
  const rule = PLANEIR_ASSUMPTIONS.netRetirement;
  assert.ok(rule.presentValueRate > 0 && rule.presentValueRate < 1);
  assert.ok(rule.basis.length > 40 && rule.disclosure.length > 20);
  const record = assumptionRecord('presentValueRate');
  assert.equal(record.key, 'presentValueRate');
  assert.equal(record.value, rule.presentValueRate);
  assert.ok(record.reason.includes(rule.basis) && record.reason.includes(PLANEIR_ASSUMPTIONS.version));
  assert.equal(assumptionLabel('presentValueRate'), 'Present-value discount rate');
  assert.equal(namesAProvider(`${rule.basis} ${rule.disclosure}`), null);
});

check('House Purchase reads DIRT from the tax catalogue and the reserve months from the central assumptions', () => {
  const years = Object.keys(IE_TAX_RULES_BY_YEAR).map(Number);
  const dirt = IE_TAX_RULES_BY_YEAR[Math.max(...years)].dirt.rate;
  assert.equal(HOUSE_PURCHASE_RULES.dirtRate, dirt);
  assert.equal(HOUSE_PURCHASE_RULES.depositSavings.dirtRateDefault, dirt);
  const saver = marketFigureValue('ie.market.cash.regular_saver_gross_rate');
  const net = Number((saver * (1 - dirt)).toFixed(4));
  assert.equal(HOUSE_PURCHASE_RULES.depositSavingsNetAerDefault, net);
  assert.equal(HOUSE_PURCHASE_RULES.depositSavings.netAerDefault, net);
  assert.equal(HOUSE_PURCHASE_RULES.reserve.recommendedMonths, PLANEIR_ASSUMPTIONS.liquidity.working.targetBufferMonths);
  assert.equal(HOUSE_PURCHASE_RULES.reserve.liquiditySafetyFloorMonths, PLANEIR_ASSUMPTIONS.liquidity.working.minimumBufferMonths);
});

check('the copies stay removed: no module types in a figure the register or a catalogue already owns', () => {
  const forbidden = [
    ['js/pension_math.js', /const DEFAULT_(INFLATION|WAGE_GROWTH|GROWTH)_RATE = 0\.\d/, 'a default rate typed in'],
    ['js/pension_math.js', /115_?000/, 'the earnings cap typed in'],
    ['js/pension_math.js', /maxAge: \d/, 'an age band typed in'],
    ['js/pension_math.js', /return 0\.(15|20|25|30|35|40);/, 'a relief rate typed in'],
    ['js/net_retirement_math.js', /const DEFAULT_(EXPENDITURE_INFLATION|PRESENT_VALUE)_RATE = 0\.\d/, 'a default rate typed in'],
    ['js/college_funding_math.js', /const DEFAULT_INFLATION_RATE = 0\.\d/, 'a default rate typed in'],
    ['js/planning/adapters/retirement.js', /\b0\.04\b/, 'the present-value rate typed in'],
    ['js/house_purchase/config.js', /dirtRate(Default)?: 0\.\d/, 'DIRT typed in'],
    ['js/house_purchase/config.js', /0\.0134/, 'the net saver rate typed in'],
    ['js/house_purchase/config.js', /(recommendedMonths|liquiditySafetyFloorMonths): \d/, 'reserve months typed in'],
    ['js/house_purchase/config.js', /(illustrationRateDefault|IllustrationDefault|grossAerDefault|GrossAerDefault): 0\.\d/, 'a market rate typed in']
  ];
  for (const [file, pattern, what] of forbidden) {
    assert.ok(!pattern.test(repoFile(file)), `${file} has ${what}`);
  }
});

// ---------------------------------------------------------------------------
// Social welfare rates, by effective date
// ---------------------------------------------------------------------------

check('every social welfare series is sound: dated rows rising, positive weekly rates, gov.ie or Citizens Information sources, no tracking parameters', () => {
  assert.match(SOCIAL_WELFARE_RATES_VERSION, /^ie-social-welfare-\d{4}\.\d+$/);
  const problems = SOCIAL_WELFARE_SERIES.flatMap((series) => socialWelfareSeriesProblems(series));
  assert.deepEqual(problems, []);
  const ids = SOCIAL_WELFARE_SERIES.map((series) => series.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

check('the shape check refuses what a hand edit could get wrong', () => {
  const sound = socialWelfareSeries('ie.social_welfare.illness_benefit.personal_highest');
  const row = sound.rates[0];
  const refused = [
    ['a source that is not gov.ie', { rates: [{ ...row, sources: [{ title: 'x', url: 'https://example.ie/rates' }] }] }, /not a gov\.ie or Citizens Information page/],
    ['a tracking parameter in a url', { rates: [{ ...row, sources: [{ title: 'x', url: 'https://www.gov.ie/en/x/?utm_source=chatgpt.com' }] }] }, /tracking parameters/],
    ['rows out of order', { rates: [row, { ...row, effectiveFrom: '2025-01-01' }] }, /must start after/],
    ['a zero rate', { rates: [{ ...row, weeklyEur: 0 }] }, /positive number/],
    ['an announced row with no Budget named', { rates: [{ ...row, effectiveFrom: '2027-01-01', status: 'announced' }] }, /announcedBy and announcedOn/],
    ['a rate with no date it was checked', { rates: [{ ...row, verifiedOn: undefined }] }, /verifiedOn/]
  ];
  for (const [what, patch, expected] of refused) {
    const problems = socialWelfareSeriesProblems({ ...sound, ...patch });
    assert.ok(problems.some((problem) => expected.test(problem)), `${what} should be refused; got ${JSON.stringify(problems)}`);
  }
});

check('the rate in force on a date is the last row on or before it, and a date before the first row is refused', () => {
  const id = 'ie.social_welfare.illness_benefit.personal_highest';
  const base = socialWelfareSeries(id);
  const first = base.rates[0];
  assert.equal(socialWelfareRateOn(id, first.effectiveFrom).weeklyEur, first.weeklyEur);
  assert.equal(socialWelfareRateOn(id, '2026-12-31').weeklyEur, base.rates.filter((row) => row.effectiveFrom <= '2026-12-31').pop().weeklyEur);
  assert.throws(() => socialWelfareRateOn(id, '2025-12-31'), /no rate recorded on or before/);
  assert.throws(() => socialWelfareRateOn(id, '31/12/2026'), /YYYY-MM-DD/);
  assert.throws(() => socialWelfareRateOn('ie.social_welfare.nope', '2026-06-01'), /No social welfare rate has the id/);
});

check('every row is the rate the Department printed, as read from its pages on 22 October 2026', () => {
  // Typed here on purpose, from the Budget 2026 table and the scheme pages, so a
  // slip in the catalogue cannot agree with itself. Rows from later Budgets are
  // checked in the same way when they are recorded.
  const printed2026 = {
    'ie.social_welfare.state_pension_contributory.personal_under_80': 299.30,
    'ie.social_welfare.state_pension_contributory.personal_80_and_over': 309.30,
    'ie.social_welfare.bereaved_partners_contributory.personal_under_66': 259.50,
    'ie.social_welfare.bereaved_partners_contributory.personal_66_to_79': 299.30,
    'ie.social_welfare.bereaved_partners_contributory.personal_80_and_over': 309.30,
    'ie.social_welfare.invalidity_pension.personal': 259.50,
    'ie.social_welfare.illness_benefit.personal_highest': 254.00
  };
  assert.deepEqual(SOCIAL_WELFARE_SERIES.map((series) => series.id).sort(), Object.keys(printed2026).sort());
  for (const [id, weekly] of Object.entries(printed2026)) {
    assert.equal(socialWelfareRateOn(id, '2026-06-01').weeklyEur, weekly, id);
  }
});

check('a weekly rate comes to its 52-week reference to the cent', () => {
  assert.equal(socialWelfareAnnualEur(254), 13_208);
  assert.equal(socialWelfareAnnualEur(259.50), 13_494);
  assert.equal(socialWelfareAnnualEur(299.30), 15_563.60);
});

check('the State Pension rule reads the social welfare catalogue and keeps no rate of its own', () => {
  const rate = socialWelfareRateOn('ie.social_welfare.state_pension_contributory.personal_under_80', '2026-01-01');
  assert.equal(IRISH_STATE_PENSION_CONTRIBUTORY.weeklyMaximumEur, rate.weeklyEur);
  assert.equal(IRISH_STATE_PENSION_CONTRIBUTORY.annualMaximumEur, socialWelfareAnnualEur(rate.weeklyEur));
  assert.equal(IRISH_STATE_PENSION_CONTRIBUTORY.effectiveFrom, rate.effectiveFrom);
  const source = repoFile('js/planning/ireland_rules.js');
  assert.ok(!/weeklyMaximumEur: \d|annualMaximumEur: [\d_]/.test(source), 'ireland_rules.js types a State Pension rate in');
});

if (failures > 0) {
  console.error(`[Figures] ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.info('[Figures] All figure checks passed.');
