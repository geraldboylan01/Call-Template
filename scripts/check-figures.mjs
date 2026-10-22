// The figures register: every figure that can change (law, market prices,
// Planeir's own assumptions), with its value, its source and when it was checked.
//
// This grows with the register. Market figures first: the arithmetic that works
// a value out of its quotes, the soundness of every catalogue entry, and the
// proof that the modules read the register instead of carrying their own copy.
// Then the law the modules used to type in for themselves, now in a catalogue,
// and the social welfare rates the protection gap needs. Then the index and the
// register that collect every figure from every catalogue.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
import {
  FIGURE_KINDS,
  FIGURE_MODULES,
  FIGURE_UNITS,
  PROVIDER_NAMES,
  namesAProvider
} from '../js/planning/figures/kinds.js';
import { collectFigures } from '../js/planning/figures/collect.js';
import { formatFigureValue } from '../js/planning/figures/format.js';
import {
  FIGURES_INDEX_VERSION,
  renderIndexSource,
  renderRegisterMarkdown,
  summariseCatalogues
} from '../js/planning/figures/register_build.js';
import {
  FIGURES_CATALOGUES,
  FIGURES_INDEX,
  FIGURES_INDEX_VERSION as GENERATED_INDEX_VERSION
} from '../js/planning/figures/figures_index.generated.js';
import { figuresVersionLabel, getFigures } from '../js/planning/figures/get_figures.js';
import { compilePlanPack, resolvePlanNarration } from '../js/planning/plan_pack/compiler.js';
import { DEFAULT_IE_TAX_CATALOGUE, resolveTaxRules, withTaxCatalogue } from '../js/planning/tax/resolve.js';
import { PLANEIR_ASSUMPTIONS, assumptionRecord } from '../js/planning/planeir_assumptions.js';
import { HOUSE_PURCHASE_RULES } from '../js/house_purchase/config.js';
import { IRISH_PENSION_RELIEF_LIMITS } from '../js/planning/ireland_rules.js';
import {
  IE_CGT_FIXED_RULES,
  IE_INVESTMENT_RULES,
  IE_LEGISLATED_SCHEDULES,
  IE_TAX_RULES_BY_YEAR
} from '../js/planning/tax/rules_ie.js';
import {
  blockProblems,
  budgetGaps,
  budgetReferences,
  daysBetween,
  duplicateQuantities,
  figureFailures,
  figureWarnings
} from '../js/planning/figures/checks.js';
import {
  PENSION_EARNINGS_CAP,
  computePensionProjection,
  maxRelievableContributionRatePercent,
  maxRelievablePersonalContribution,
  normalizePensionInputs,
  pensionConversationGuidance
} from '../js/pension_math.js';
import { normalizeNetRetirementInputs } from '../js/net_retirement_math.js';
import { normalizeCollegeFundingInputs } from '../js/college_funding_math.js';
import { assumptionLabel } from '../js/planning/planeir_assumptions.js';
import { IRISH_STATE_PENSION_CONTRIBUTORY, statePensionRuleForYear } from '../js/planning/ireland_rules.js';
import { SOCIAL_WELFARE_RATES_VERSION, SOCIAL_WELFARE_SERIES } from '../js/planning/social_welfare_ie.js';
import {
  socialWelfareAnnualEur,
  socialWelfareRateOn,
  socialWelfareSeries,
  socialWelfareSeriesProblems
} from '../js/planning/social_welfare_rates.js';

let failures = 0;
const asyncChecks = [];
/** Today, or the day a test says it is: warnings about age depend on it. */
const TODAY = process.env.FIGURES_TODAY ?? new Date().toISOString().slice(0, 10);

function check(name, fn) {
  try {
    fn();
    console.info(`[Figures] PASS: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`[Figures] FAIL: ${name}\n    ${error.message}`);
  }
}

/**
 * A check that awaits. They run one after another at the end, with the engines'
 * own progress logging muted, since a plan compile prints every case it builds.
 */
function checkAsync(name, fn) {
  asyncChecks.push([name, fn]);
}

async function runAsyncChecks() {
  for (const [name, fn] of asyncChecks) {
    const { info, log } = console;
    console.info = () => {};
    console.log = () => {};
    try {
      await fn();
      console.info = info;
      console.log = log;
      console.info(`[Figures] PASS: ${name}`);
    } catch (error) {
      console.info = info;
      console.log = log;
      failures += 1;
      console.error(`[Figures] FAIL: ${name}\n    ${error.message}`);
    }
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
  assert.equal(namesAProvider('Central Bank of Ireland mortgage measures'), null, 'the regulator is not a lender');
  assert.equal(namesAProvider('Bank of Ireland and the Central Bank of Ireland'), 'Bank of Ireland', 'a lender beside the regulator is still caught');
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
  // The Department's Budget 2027 table, "maximum weekly rate (from January 2027)".
  const printed2027 = {
    'ie.social_welfare.state_pension_contributory.personal_under_80': 309.30,
    'ie.social_welfare.state_pension_contributory.personal_80_and_over': 319.30,
    'ie.social_welfare.bereaved_partners_contributory.personal_under_66': 269.50,
    'ie.social_welfare.bereaved_partners_contributory.personal_66_to_79': 309.30,
    'ie.social_welfare.bereaved_partners_contributory.personal_80_and_over': 319.30,
    'ie.social_welfare.invalidity_pension.personal': 269.50,
    'ie.social_welfare.illness_benefit.personal_highest': 264.00
  };
  for (const [id, weekly] of Object.entries(printed2027)) {
    const rate = socialWelfareRateOn(id, '2027-01-01');
    assert.equal(rate.weeklyEur, weekly, id);
    assert.equal(rate.status, 'announced', `${id} is announced until it is payable`);
    assert.equal(rate.announcedBy, 'Budget 2027', id);
    assert.equal(socialWelfareRateOn(id, '2026-12-31').weeklyEur, printed2026[id], `${id} is still the 2026 rate on 31 December 2026`);
    assert.equal(weekly - printed2026[id], 10, `${id} rises by the 10 euro the Budget announced`);
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

// ---------------------------------------------------------------------------
// The index and the register
// ---------------------------------------------------------------------------

const collected = collectFigures();

check('how values are shown: money, rates, ages, dates and weekly amounts read as a person would say them', () => {
  const shown = [
    [0.002, 'rate_a_year', '0.2% a year'],
    [0.0175, 'rate', '1.75%'],
    [0.0435, 'rate', '4.35%'],
    [44_000, 'eur', '€44,000'],
    [2_200_000, 'eur', '€2,200,000'],
    [299.3, 'eur_a_week', '€299.30 a week'],
    [15_563.6, 'eur_a_year', '€15,563.60 a year'],
    [65, 'age', 'age 65'],
    ['2029-12-31', 'date', '31 December 2029'],
    [3.5, 'multiple', '3.5 times'],
    [1, 'years', '1 year'],
    [8, 'years', '8 years']
  ];
  for (const [value, unit, expected] of shown) assert.equal(formatFigureValue(value, unit), expected, `${value} as ${unit}`);
  assert.throws(() => formatFigureValue(1, 'furlongs'), /Unknown figure unit/);
});

check('every collected figure is well formed: a plain label, a known kind, unit and modules, and a value shown as the unit says', () => {
  assert.ok(collected.length > 200, 'the register is not empty');
  const ids = collected.map((figure) => figure.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const figure of collected) {
    assert.ok(/^[a-z][a-z0-9_-]*(\.[a-zA-Z0-9][a-zA-Z0-9_-]*)+$/.test(figure.id), `${figure.id} is an id a placeholder can carry`);
    assert.ok(figure.label && figure.label.trim() === figure.label, `${figure.id} has a label`);
    assert.ok(FIGURE_KINDS.includes(figure.kind), `${figure.id} kind`);
    assert.ok(FIGURE_UNITS.includes(figure.unit), `${figure.id} unit`);
    assert.equal(figure.valueShown, formatFigureValue(figure.value, figure.unit), `${figure.id} is shown as its unit says`);
    assert.ok(figure.usedBy.length > 0 && figure.usedBy.every((name) => FIGURE_MODULES.includes(name)), `${figure.id} usedBy`);
  }
});

check('no label, source title or listed provenance a client could hear names a bank or lender, outside a market figure\'s own quotes', () => {
  for (const figure of collected) {
    for (const text of [figure.label, figure.valueShown, ...figure.sources.map((source) => source.title)]) {
      assert.equal(namesAProvider(text), null, `${figure.id}: ${text}`);
    }
  }
});

check('the generated index is exactly what the catalogues collect now', () => {
  assert.equal(GENERATED_INDEX_VERSION, FIGURES_INDEX_VERSION);
  assert.deepEqual(JSON.parse(JSON.stringify(FIGURES_INDEX)), JSON.parse(JSON.stringify(collected)));
  assert.deepEqual(JSON.parse(JSON.stringify(FIGURES_CATALOGUES)), summariseCatalogues(collected));
  assert.equal(readFileSync(fileURLToPath(new URL('../js/planning/figures/figures_index.generated.js', import.meta.url)), 'utf8'), renderIndexSource(collected, summariseCatalogues(collected)));
});

check('the readable register is exactly what the catalogues render to now', () => {
  const written = readFileSync(fileURLToPath(new URL('../docs/figures-register.md', import.meta.url)), 'utf8');
  assert.equal(written, renderRegisterMarkdown(collected, summariseCatalogues(collected)));
  assert.ok(written.includes('Do not edit by hand'));
});

check('the staleness check bites: change one catalogue value and the index and register no longer match', () => {
  const tampered = collected.map((figure, index) => (index === 0 ? { ...figure, value: figure.value + 1, valueShown: 'changed' } : figure));
  const catalogues = summariseCatalogues(tampered);
  assert.notEqual(renderIndexSource(tampered, catalogues), renderIndexSource(collected, summariseCatalogues(collected)));
  assert.notEqual(renderRegisterMarkdown(tampered, catalogues), renderRegisterMarkdown(collected, summariseCatalogues(collected)));
});

check('every catalogue reaches the register, with its version', () => {
  const ids = FIGURES_CATALOGUES.map((catalogue) => catalogue.id).sort();
  assert.deepEqual(ids, ['house_purchase_rules', 'ie_market', 'ie_planning_rules', 'ie_social_welfare', 'ie_tax_rules', 'planeir_assumptions']);
  FIGURES_CATALOGUES.forEach((catalogue) => assert.ok(catalogue.version && catalogue.count > 0, catalogue.id));
  assert.equal(FIGURES_CATALOGUES.reduce((total, catalogue) => total + catalogue.count, 0), FIGURES_INDEX.length);
});

check('figures read from catalogues are the catalogues\' own values, not retyped: a sample from each', () => {
  const byId = new Map(collected.map((figure) => [figure.id, figure]));
  const years = Object.keys(IE_TAX_RULES_BY_YEAR).map(Number);
  const first = IE_TAX_RULES_BY_YEAR[Math.min(...years)];
  assert.equal(byId.get(`${first.incomeTax.ruleId}.standard_rate_band.single`).value, first.incomeTax.standardRateBand.single);
  assert.equal(byId.get(`${first.dirt.ruleId}.rate`).value, first.dirt.rate);
  assert.equal(byId.get('ie.pension_relief.limits.earnings_cap').value, PENSION_EARNINGS_CAP);
  assert.equal(byId.get('ie.market.cash.instant_access_gross_rate').value, marketFigureValue('ie.market.cash.instant_access_gross_rate'));
  assert.equal(byId.get('planeir.assumption.investment_growth').value, PLANEIR_ASSUMPTIONS.investment.nominalGrowthRate);
  assert.equal(byId.get('ie.house_purchase.help_to_buy.maximum_relief').value, HOUSE_PURCHASE_RULES.helpToBuy.maximumRelief);
  assert.equal(byId.get('ie.social_welfare.illness_benefit.personal_highest.from_2026_01_01').value, socialWelfareRateOn('ie.social_welfare.illness_benefit.personal_highest', '2026-06-01').weeklyEur);
});

// ---------------------------------------------------------------------------
// The rules the register is held to
// ---------------------------------------------------------------------------

/**
 * Budgets recorded for a tax year that has no block yet. A ratchet, like the
 * stale-exports baseline: a gap not listed here fails, and so does an entry here
 * that is no longer a gap, so the list can only shrink. It is empty: the 2027
 * block, announced in Budget 2027, closed the only one. A new Budget recorded
 * without its block fails the check until the block is added.
 */
const KNOWN_BUDGET_GAPS = [];

const BUDGET_CATALOGUES = {
  taxRules: IE_TAX_RULES_BY_YEAR,
  schedules: IE_LEGISLATED_SCHEDULES,
  investmentRules: IE_INVESTMENT_RULES,
  cgtFixedRules: IE_CGT_FIXED_RULES,
  socialWelfare: SOCIAL_WELFARE_SERIES
};

check('every figure has a source and a check date that is not in the future', () => {
  assert.deepEqual(figureFailures(collected, TODAY), []);
});

check('the rule refuses a figure with no source, no check date, a future date, or law with no https source', () => {
  const sound = collected.find((figure) => figure.kind === 'law');
  const refused = [
    ['no source', { source: undefined }, /has no source/],
    ['a blank source title', { source: { title: ' ', url: null } }, /has no source/],
    ['no check date', { checkedOn: undefined }, /no checkedOn/],
    ['a check date in the future', { checkedOn: '2999-01-01' }, /in the future/],
    ['law with no https url', { sources: [{ title: 'x', url: null }] }, /needs a source with an https url/],
    ['a tracking parameter', { sources: [{ title: 'x', url: 'https://www.gov.ie/x/?utm_source=chatgpt.com' }] }, /tracking parameters/],
    ['an unknown module', { usedBy: ['nowhere'] }, /usedBy/],
    ['an unknown kind', { kind: 'rumour' }, /unknown kind/]
  ];
  for (const [what, patch, expected] of refused) {
    const failuresFound = figureFailures([{ ...sound, ...patch }], TODAY);
    assert.ok(failuresFound.some((failure) => expected.test(failure)), `${what} should be refused; got ${JSON.stringify(failuresFound)}`);
  }
  const market = collected.find((figure) => figure.kind === 'market');
  assert.ok(figureFailures([{ ...market, observations: [] }], TODAY).some((failure) => /every quote needs an https url/.test(failure)));
});

check('no quantity is defined twice: each has one owning catalogue and one value for each effective date', () => {
  assert.deepEqual(duplicateQuantities(collected), []);
  const first = collected[0];
  const other = collected.find((figure) => figure.catalogue.id !== first.catalogue.id);
  assert.ok(duplicateQuantities([first, { ...other, quantity: first.quantity }]).some((problem) => /defined in both/.test(problem)), 'two catalogues, one quantity');
  assert.ok(duplicateQuantities([first, { ...first, id: `${first.id}.again` }]).some((problem) => /same effective date/.test(problem)), 'one catalogue, one date, two values');
  assert.deepEqual(duplicateQuantities([first, { ...first, id: `${first.id}.later`, effectiveFrom: '2099-01-01' }]), [], 'a later date is a new value, not a duplicate');
});

check('the tax blocks are sound: an announced block says which Budget, an enacted block says which Act, each has a check date', () => {
  assert.deepEqual(blockProblems(IE_TAX_RULES_BY_YEAR), []);
  assert.ok(blockProblems({ 2027: { status: 'announced', verifiedOn: '2026-10-22' } }).some((problem) => /announcedBy and announcedOn/.test(problem)));
  assert.ok(blockProblems({ 2027: { status: 'enacted', verifiedOn: '2026-10-22' } }).some((problem) => /enactedBy/.test(problem)));
  assert.ok(blockProblems({ 2027: { status: 'rumoured', verifiedOn: '2026-10-22' } }).some((problem) => /status/.test(problem)));
  assert.ok(blockProblems({ 2027: { status: 'announced', announcedBy: 'Budget 2027', announcedOn: '2026-10-06' } }).some((problem) => /verifiedOn/.test(problem)));
});

check('a Budget recorded for a year with no announced block for that year is a failure, apart from the named known gap', () => {
  const found = budgetGaps(IE_TAX_RULES_BY_YEAR, BUDGET_CATALOGUES);
  const unexpected = found.filter((gap) => !KNOWN_BUDGET_GAPS.some((known) => known.budget === gap.budget && known.year === gap.year));
  assert.deepEqual(unexpected.map((gap) => `${gap.budget}: ${gap.where.join(', ')}`), [], 'a Budget is recorded with no block for its year');
  const resolved = KNOWN_BUDGET_GAPS.filter((known) => !found.some((gap) => gap.budget === known.budget && gap.year === known.year));
  assert.deepEqual(resolved, [], 'a known gap is closed, so remove it from KNOWN_BUDGET_GAPS');
  found.forEach((gap) => console.warn(`[Figures] KNOWN GAP: ${gap.budget} is recorded in ${gap.where.length} places (${gap.where.slice(0, 3).join(', ')}) but tax year ${gap.year} has no block yet.`));
});

check('the Budget rule bites: a Budget with no block fails, an announced or enacted block closes it, a draft does not', () => {
  const catalogues = { x: { rate: { announcedBy: 'Budget 2031', value: 1 } } };
  assert.equal(budgetGaps({}, catalogues).length, 1);
  assert.equal(budgetGaps({ 2031: { status: 'announced' } }, catalogues).length, 0);
  assert.equal(budgetGaps({ 2031: { status: 'enacted' } }, catalogues).length, 0);
  assert.equal(budgetGaps({ 2030: { status: 'enacted' } }, catalogues).length, 1, 'the wrong year does not close it');
  assert.equal(budgetGaps({ 2031: { status: 'draft' } }, catalogues).length, 1);
  assert.deepEqual(budgetReferences({ a: [{ announcedBy: 'Budget 2027' }, { announcedBy: 'Finance Act 2025' }] }).map((found) => found.year), [2027], 'only Budgets count');
  assert.ok(budgetReferences(IE_LEGISLATED_SCHEDULES).length >= 2, 'the real schedules record Budget 2027');
});

check('warnings: a market figure past its review interval, a reviewed rate its quotes have left, an announced rule gone quiet', () => {
  const market = collected.filter((figure) => figure.kind === 'market');
  const stale = market[0];
  const later = new Date(Date.parse(`${stale.checkedOn}T00:00:00Z`) + (stale.reviewEveryDays + 1) * 86_400_000).toISOString().slice(0, 10);
  assert.ok(figureWarnings([stale], later).some((warning) => /last checked \d+ days ago/.test(warning)), 'one day over the interval warns');
  const onTime = new Date(Date.parse(`${stale.checkedOn}T00:00:00Z`) + stale.reviewEveryDays * 86_400_000).toISOString().slice(0, 10);
  assert.equal(figureWarnings([{ ...stale, evidence: undefined }], onTime).length, 0, 'on the last day it does not');
  const drifted = market.find((figure) => figure.evidence);
  assert.ok(figureWarnings([drifted], drifted.checkedOn).some((warning) => /quotes now point to/.test(warning)), 'a reviewed rate the evidence has left warns');
  const announced = collected.find((figure) => figure.kind === 'announced_law');
  assert.equal(figureWarnings([announced], announced.checkedOn).length, 0);
  assert.ok(figureWarnings([announced], '2999-01-01').some((warning) => /whether it has been enacted/.test(warning)));
  assert.equal(daysBetween('2026-10-22', '2026-10-29'), 7);
});

for (const warning of figureWarnings(collected, TODAY)) {
  console.warn(`[Figures] WARN: ${warning}`);
}

// ---------------------------------------------------------------------------
// Reading the register: getFigures, and the plan pack's {figure.<id>} placeholders
// ---------------------------------------------------------------------------

check('getFigures returns every figure with its value and source, and nothing a client must not hear', () => {
  const all = getFigures();
  assert.equal(all.length, FIGURES_INDEX.length);
  for (const figure of all) {
    assert.ok('value' in figure && figure.valueShown && figure.source.title && figure.checkedOn && figure.catalogueVersion, `${figure.id} carries value, source, check date and version`);
    assert.ok(!('observations' in figure) && !('method' in figure) && !('evidence' in figure), `${figure.id} carries no quotes`);
    assert.equal(namesAProvider(JSON.stringify(figure)), null, `${figure.id} names no provider`);
  }
});

check('getFigures filters by ids, kind and module, and combines them', () => {
  const ids = ['ie.dirt.2026.rate', 'ie.pension_relief.limits.earnings_cap'];
  assert.deepEqual(getFigures({ ids }).map((figure) => figure.id), ids);
  const market = getFigures({ kinds: ['market'] });
  assert.ok(market.length === 3 && market.every((figure) => figure.kind === 'market'));
  assert.ok(getFigures({ kinds: 'announced_law' }).every((figure) => figure.kind === 'announced_law'));
  const protection = getFigures({ module: 'protection_gap' });
  assert.ok(protection.length >= 5 && protection.every((figure) => figure.usedBy.includes('protection_gap')));
  assert.ok(protection.some((figure) => figure.id.startsWith('ie.social_welfare.illness_benefit')), 'Illness Benefit is there for the protection gap');
  assert.deepEqual(getFigures({ module: 'protection_gap', kinds: ['market'] }), []);
  assert.deepEqual(getFigures({ ids, module: 'house_purchase' }).map((figure) => figure.id), ['ie.dirt.2026.rate']);
});

check('getFigures refuses what it cannot answer, rather than leaving a figure out of an answer', () => {
  assert.throws(() => getFigures({ ids: ['ie.dirt.2026.rate', 'ie.dirt.2031.rate'] }), /holds no figure with the id "ie\.dirt\.2031\.rate"/);
  assert.throws(() => getFigures({ kinds: ['rumour'] }), /Unknown figure kind/);
  assert.throws(() => getFigures({ module: 'nowhere' }), /Unknown module/);
  assert.throws(() => getFigures({ onDate: '22/10/2026' }), /YYYY-MM-DD/);
  assert.throws(() => getFigures({ ids: 'ie.dirt.2026.rate' }), /array of figure ids/);
});

check('getFigures is read-only: what it returns cannot be changed, and cannot change the register', () => {
  const [figure] = getFigures({ ids: ['ie.dirt.2026.rate'] });
  assert.ok(Object.isFrozen(figure) && Object.isFrozen(figure.source) && Object.isFrozen(figure.sources) && Object.isFrozen(figure.usedBy));
  assert.throws(() => { figure.value = 0.5; }, TypeError);
  assert.throws(() => { figure.usedBy.push('anywhere'); }, TypeError);
  assert.ok(Object.isFrozen(getFigures()));
  assert.equal(getFigures({ ids: ['ie.dirt.2026.rate'] })[0].value, FIGURES_INDEX.find((entry) => entry.id === 'ie.dirt.2026.rate').value);
});

check('onDate gives the value in force on that date: the latest to have taken effect, never a later announced one', () => {
  const rate = (onDate) => getFigures({ onDate, ids: ['ie.cgt.rate.2012-12', 'ie.cgt.rate.2026-10'] }).map((figure) => figure.valueShown);
  assert.deepEqual(rate('2026-10-06'), ['33%'], 'the day before the Budget cut');
  assert.deepEqual(rate('2026-10-07'), ['31%'], 'the day the cut takes effect');
  assert.deepEqual(rate('2030-01-01'), ['31%'], 'later years hold the last rate');
  assert.deepEqual(rate('2012-12-05'), [], 'before the first rate nothing is in force');
  const all = getFigures({ onDate: '2026-06-01' });
  const quantities = all.map((figure) => FIGURES_INDEX.find((entry) => entry.id === figure.id).quantity);
  assert.equal(new Set(quantities).size, quantities.length, 'one value for each quantity');
});

check('the register version label names the index and every catalogue behind it', () => {
  const label = figuresVersionLabel();
  assert.ok(label.startsWith(FIGURES_INDEX_VERSION));
  FIGURES_CATALOGUES.forEach((catalogue) => assert.ok(label.includes(catalogue.version), catalogue.id));
});

check('every figure id can be a placeholder: the plan pack pattern carries all of them', () => {
  for (const figure of FIGURES_INDEX) {
    const values = { [`figure.${figure.id}`]: { value: figure.valueShown, type: 'text' } };
    const { text } = resolvePlanNarration(`Shown as {figure.${figure.id}}.`, values);
    assert.equal(text, `Shown as ${figure.valueShown}.`, figure.id);
  }
});

const readPack = () => JSON.parse(readFileSync(fileURLToPath(new URL('../scripts/fixtures/plan-packs/valid-small.json', import.meta.url)), 'utf8'));
const narrationOf = (result, routeId) => result.routes.find((route) => route.id === routeId);

checkAsync('narration states a rate from the register: the pack compiles and shows the register\'s value', async () => {
  const pack = readPack();
  pack.narration.clear_car = 'This route uses {route.cashUsed}. The standard rate is {figure.ie.income_tax.2026.standard_rate} and the earnings cap is {figure.ie.pension_relief.limits.earnings_cap}.';
  const result = await compilePlanPack(pack);
  const route = narrationOf(result, 'clear_car');
  assert.equal(route.status, 'compiled', JSON.stringify(result.diagnostics));
  assert.match(route.narration.text, /The standard rate is 20% and the earnings cap is €115,000\./);
  assert.ok(result.versions.figures.startsWith(FIGURES_INDEX_VERSION), 'the saved plan names the register it was written from');
});

checkAsync('narration still cannot type a figure, and cannot name one the register does not hold', async () => {
  const typed = readPack();
  typed.narration.clear_car = 'The standard rate is 20%.';
  const typedResult = await compilePlanPack(typed);
  assert.equal(typedResult.status, 'invalid');
  assert.match(JSON.stringify(typedResult.diagnostics), /must use registered placeholders/);
  const unknown = readPack();
  unknown.narration.clear_car = 'The standard rate is {figure.ie.income_tax.2031.standard_rate}.';
  const unknownResult = await compilePlanPack(unknown);
  assert.equal(unknownResult.status, 'invalid');
  assert.match(JSON.stringify(unknownResult.diagnostics), /unknown placeholder \{figure\.ie\.income_tax\.2031\.standard_rate\}/);
});

checkAsync('the compiled plan names the register version, with the market figures\' version in it, so a saved plan says which figures it was written from', async () => {
  const first = await compilePlanPack(readPack());
  assert.equal(first.status, 'compiled', JSON.stringify(first.diagnostics));
  assert.ok(first.versions.figures.includes('ie-market-'), 'market figures are named in the version');
});

await runAsyncChecks();

// ---------------------------------------------------------------------------
// The catch-up: Budget 2027 in the register and in the engines
// ---------------------------------------------------------------------------

check('the 2027 tax year is in the register as announced law, with its changed rules listed once and the unchanged ones not repeated', () => {
  const byId = new Map(collected.map((figure) => [figure.id, figure]));
  const band = byId.get('ie.income_tax.2027.standard_rate_band.single');
  assert.equal(band.value, 46_500);
  assert.equal(band.valueShown, '€46,500');
  assert.equal(band.kind, 'announced_law');
  assert.equal(band.effectiveFrom, '2027-01-01');
  assert.equal(byId.get('ie.income_tax.2026.standard_rate_band.single').value, 44_000, '2026 is still there, as it was');
  assert.equal(byId.get('ie.usc.2027.standard.band_2.upper_limit').value, 30_300);
  assert.equal(byId.get('ie.income_tax.2027.personal_credit.widowed').value, 2_665);
  assert.equal(byId.get('ie.exit_tax.rate.2027').valueShown, '35%');
  assert.equal(byId.get('ie.cgt.rate.2026-10').valueShown, '31%');
  for (const unchanged of ['ie.dirt.2027.rate', 'ie.lump_sum.2027.lifetime_tax_free', 'ie.income_tax.age_exemption.2027.from_age', 'ie.prsi.liability.2027.liable_under_age']) {
    assert.ok(!byId.has(unchanged), `${unchanged} is the 2026 rule carried over, not listed again`);
  }
  assert.ok(figureWarnings(collected, '2026-10-22').every((warning) => !/income_tax\.2027/.test(warning)));
});

check('Help to Buy is 35,000 from 7 October 2026, as Revenue prints it, with the scheme\'s other parameters unchanged', () => {
  const byId = new Map(collected.map((figure) => [figure.id, figure]));
  const relief = byId.get('ie.house_purchase.help_to_buy.maximum_relief');
  assert.equal(relief.value, 35_000);
  assert.equal(relief.effectiveFrom, '2026-10-07');
  assert.equal(relief.kind, 'law');
  assert.equal(relief.checkedOn, '2026-10-22');
  assert.ok(relief.sources.some((source) => /revenue\.ie\/en\/property\/help-to-buy-incentive\/how-much-can-you-claim/.test(source.url)), 'the page that prints both amounts is a source');
  assert.equal(byId.get('ie.house_purchase.help_to_buy.price_share').value, 0.1);
  assert.equal(byId.get('ie.house_purchase.help_to_buy.maximum_price').value, 500_000);
  assert.equal(byId.get('ie.house_purchase.help_to_buy.scheme_end_date').value, '2029-12-31');
});

check('every 2027 figure the Budget announced names its source documents: the Department\'s book, and the Bill where it legislates', () => {
  const bill = collected.filter((figure) => /^ie\.(income_tax|usc)\.2027\./.test(figure.id) || /^ie\.income_tax\.employee_credit\.2027\./.test(figure.id));
  assert.equal(bill.length, 19, 'nine income tax figures, two employee credit figures and eight USC figures');
  for (const figure of bill) {
    const urls = figure.sources.map((source) => source.url);
    assert.ok(urls.some((url) => /Tax_Policy_Changes_Book\.pdf$/.test(url)), `${figure.id} cites the Department's book`);
    assert.ok(urls.some((url) => /data\.oireachtas\.ie\/ie\/oireachtas\/bill\/2026\/98\//.test(url)), `${figure.id} cites the Finance (No. 2) Bill 2026`);
    assert.equal(figure.checkedOn, '2026-10-22');
  }
});

check('the State Pension in the engines is the rate for the plan\'s own year, with the year, the rate and the Budget it came from stated', () => {
  assert.equal(statePensionRuleForYear(2026).weeklyMaximumEur, 299.30);
  assert.equal(statePensionRuleForYear(2026).status, 'in_force');
  assert.equal(statePensionRuleForYear(2027).weeklyMaximumEur, 309.30);
  assert.equal(statePensionRuleForYear(2027).annualMaximumEur, 16_083.60);
  assert.equal(statePensionRuleForYear(2027).status, 'announced');
  assert.equal(statePensionRuleForYear(2035).weeklyMaximumEur, 309.30, 'later years hold the last rate known');
  assert.equal(statePensionRuleForYear(2019).weeklyMaximumEur, 299.30, 'a year before the first rate uses the first, as the engines always have');
  const plan = (currentYear) => computePensionProjection({
    currentYear, growthRate: 0.05, inflationRate: 0.02, wageGrowthRate: 0.02, incomeMode: 'target', targetIncomeToday: 42_000, horizonEndAge: 92,
    pensions: [{ id: 'a', title: 'A', currentAge: 62, retirementAge: 66, currentSalary: 70_000, currentPot: 300_000, personalPct: 0.08, employerPct: 0.06 }]
  });
  const row = (projection) => projection.assumptionsTable.rows.find((entry) => entry[0] === 'Maximum Irish State Pension (gross)')[1];
  const rule = (projection) => projection.assumptionsTable.rows.find((entry) => entry[0] === 'State Pension rule')[1];
  const now = plan(2026);
  const next = plan(2027);
  assert.equal(row(now), '€15,563.60 a year (€299.30 a week)');
  assert.match(rule(now), /effective January 2026; default start age 66$/);
  assert.equal(row(next), '€16,083.60 a year (€309.30 a week)');
  assert.match(rule(next), /effective January 2027, announced in Budget 2027; default start age 66$/);
});

checkAsync('the pinned design catalogue holds across an async run until it settles, and is put back whether it resolves or rejects', async () => {
  const pinned = { ...DEFAULT_IE_TAX_CATALOGUE, rulesByYear: { 2026: DEFAULT_IE_TAX_CATALOGUE.rulesByYear[2026] } };
  const yearInside = await withTaxCatalogue(pinned, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return resolveTaxRules(2031).rulesYear;
  });
  assert.equal(yearInside, 2026, 'still pinned after an await');
  assert.equal(resolveTaxRules(2031).rulesYear, 2027, 'restored once it resolved');
  await assert.rejects(() => withTaxCatalogue(pinned, async () => { throw new Error('async boom'); }), /async boom/);
  assert.equal(resolveTaxRules(2031).rulesYear, 2027, 'restored once it rejected');
});

/**
 * Where the State Pension rate is still typed into wording instead of read from the
 * catalogue. They are all the Worker's spoken and prompt text for the live lane, which
 * says the 2026 rate whatever the date. A ratchet like the others: a new copy fails,
 * and so does a listed file once it no longer has one.
 */
const KNOWN_STATE_PENSION_COPIES = [
  'worker/src/consumer/live/compliance.js',
  'worker/src/consumer/realtime_completion.js',
  'worker/src/consumer/realtime_planner.js',
  'worker/src/consumer/realtime_provider.js'
];

check('the State Pension rate is typed in nowhere outside the catalogue, apart from the named wording that still says the 2026 rate', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const skip = /(^|\/)(tests_[^/]*|figures_index\.generated|social_welfare_ie|playbook_manifest\.generated)\.js$|node_modules/;
  const found = [];
  const walk = (directory) => {
    for (const name of readdirSync(`${root}${directory}`)) {
      const path = `${directory}/${name}`;
      if (statSync(`${root}${path}`).isDirectory()) walk(path);
      else if (name.endsWith('.js') && !skip.test(path) && /299\.30?(?!\d)|15[,_]?563\.6|309\.30?(?!\d)|16[,_]?083\.6/.test(repoFile(path))) found.push(path);
    }
  };
  ['js', 'worker/src'].forEach(walk);
  assert.deepEqual(found.sort(), [...KNOWN_STATE_PENSION_COPIES].sort());
});

if (failures > 0) {
  console.error(`[Figures] ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.info('[Figures] All figure checks passed.');
