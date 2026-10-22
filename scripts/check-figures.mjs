// The figures register: every figure that can change (law, market prices,
// Planeir's own assumptions), with its value, its source and when it was checked.
//
// This grows with the register. Market figures first: the arithmetic that works
// a value out of its quotes, the soundness of every catalogue entry, and the
// proof that the modules read the register instead of carrying their own copy.

import assert from 'node:assert/strict';

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

if (failures > 0) {
  console.error(`[Figures] ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.info('[Figures] All figure checks passed.');
