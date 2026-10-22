/**
 * The arithmetic behind a market figure. Pure: it reads nothing but the figure
 * it is given, so a job that collects quotes and this function together always
 * agree on the value (`market_ie.js` holds the data, never the answer).
 */

import { FIGURE_MODULES, namesAProvider } from './kinds.js';
import { MARKET_FIGURES } from './market_ie.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIGURE_ID = /^ie\.market(\.[a-z][a-z0-9_]*)+$/;

/** What a figure's value is measured in. `rate_a_year` is a fraction (0.02 is 2%). */
const MARKET_FIGURE_UNITS = Object.freeze(['rate_a_year', 'eur', 'eur_a_year', 'eur_a_month', 'multiple']);

const MARKET_METHOD_KINDS = Object.freeze(['median', 'mean', 'single', 'reviewed']);

function fail(message) {
  throw new Error(message);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Round to the nearest `step` (0.001 rounds a rate to a tenth of a percentage
 * point). Rounding through a 12-digit precision removes the float residue, so
 * 7 steps of 0.005 is exactly 0.035 and not 0.035000000000000003.
 */
export function roundToStep(value, step) {
  if (!(typeof step === 'number' && step > 0)) {
    return value;
  }
  return Number((Math.round(value / step) * step).toPrecision(12));
}

function requireObservations(figure, minimum) {
  const observations = figure.observations;
  if (!Array.isArray(observations) || observations.length < minimum) {
    fail(`${figure.id} needs at least ${minimum} observation${minimum === 1 ? '' : 's'}.`);
  }
  observations.forEach((observation, index) => {
    if (typeof observation.value !== 'number' || !Number.isFinite(observation.value)) {
      fail(`${figure.id} observation ${index} has no numeric value.`);
    }
  });
  return observations.map((observation) => observation.value);
}

/**
 * The value a figure's observations work out to under its method.
 *
 * `median`, `mean` and `single` come purely from the observations, rounded to
 * `method.roundTo`. `reviewed` returns the value a person chose; use
 * `marketFigureEvidence` to see where the observations now point.
 */
export function resolveMarketFigureValue(figure) {
  const method = figure?.method;
  if (!method || !MARKET_METHOD_KINDS.includes(method.kind)) {
    fail(`${figure?.id ?? 'figure'} has no recognised method.`);
  }
  if (method.kind === 'reviewed') {
    if (typeof method.value !== 'number' || !Number.isFinite(method.value)) {
      fail(`${figure.id} is reviewed but holds no value.`);
    }
    return method.value;
  }
  if (method.kind === 'single') {
    return roundToStep(requireObservations(figure, 1)[0], method.roundTo);
  }
  const values = requireObservations(figure, 2);
  return roundToStep(method.kind === 'median' ? median(values) : mean(values), method.roundTo);
}

/**
 * Where a reviewed figure's evidence now points: the median of its
 * observations, and how far that is from the value a person chose.
 */
export function marketFigureEvidence(figure) {
  const values = requireObservations(figure, 1);
  const evidenceMedian = Number(median(values).toPrecision(12));
  const value = resolveMarketFigureValue(figure);
  const gap = Number((evidenceMedian - value).toPrecision(12));
  const warnAt = figure.method?.driftWarnAt;
  return Object.freeze({
    median: evidenceMedian,
    gap,
    drifted: figure.method?.kind === 'reviewed' && typeof warnAt === 'number' && Math.abs(gap) > warnAt
  });
}

const BY_ID = new Map(MARKET_FIGURES.map((figure) => [figure.id, figure]));

export function marketFigure(id) {
  const figure = BY_ID.get(id);
  if (!figure) {
    fail(`No market figure has the id ${JSON.stringify(id)}.`);
  }
  return figure;
}

/** The worked-out value of a market figure, by id. */
export function marketFigureValue(id) {
  return resolveMarketFigureValue(marketFigure(id));
}

/**
 * Problems with a figure's shape, as strings. An empty list means it is sound.
 * A label may not name a provider: it is client-facing.
 */
export function marketFigureProblems(figure, { modules = FIGURE_MODULES } = {}) {
  const problems = [];
  const add = (message) => problems.push(`${figure?.id ?? 'figure'}: ${message}`);
  if (typeof figure?.id !== 'string' || !FIGURE_ID.test(figure.id)) {
    add('id must look like ie.market.<group>.<name>.');
  }
  if (typeof figure?.label !== 'string' || figure.label.trim() === '') {
    add('needs a plain label.');
  } else {
    const named = namesAProvider(figure.label);
    if (named) add(`label names a provider (${named}); labels are client-facing.`);
  }
  if (!MARKET_FIGURE_UNITS.includes(figure?.unit)) add(`unit must be one of ${MARKET_FIGURE_UNITS.join(', ')}.`);
  if (!MARKET_METHOD_KINDS.includes(figure?.method?.kind)) add('method.kind is not recognised.');
  if (!Array.isArray(figure?.observations) || figure.observations.length === 0) {
    add('needs at least one observation.');
  } else {
    figure.observations.forEach((observation, index) => {
      const where = `observation ${index}`;
      if (typeof observation.sourceLabel !== 'string' || observation.sourceLabel.trim() === '') add(`${where} has no sourceLabel.`);
      if (typeof observation.url !== 'string' || !/^https:\/\//.test(observation.url)) add(`${where} needs an https url.`);
      if (typeof observation.value !== 'number' || !Number.isFinite(observation.value)) add(`${where} has no numeric value.`);
      if (typeof observation.quotedAs !== 'string' || observation.quotedAs.trim() === '') add(`${where} needs quotedAs.`);
      if (observation.effective !== null && !ISO_DATE.test(observation.effective ?? '')) add(`${where}.effective must be a date or null.`);
      if (!ISO_DATE.test(observation.retrievedOn ?? '')) add(`${where}.retrievedOn must be a date.`);
      if (ISO_DATE.test(figure.checkedOn ?? '') && ISO_DATE.test(observation.retrievedOn ?? '') && observation.retrievedOn > figure.checkedOn) {
        add(`${where} was retrieved after checkedOn.`);
      }
    });
  }
  if (!ISO_DATE.test(figure?.checkedOn ?? '')) add('checkedOn must be a date.');
  if (!ISO_DATE.test(figure?.changedOn ?? '')) add('changedOn must be a date.');
  if (ISO_DATE.test(figure?.checkedOn ?? '') && ISO_DATE.test(figure?.changedOn ?? '') && figure.changedOn > figure.checkedOn) {
    add('changedOn is later than checkedOn.');
  }
  if (!Number.isInteger(figure?.reviewEveryDays) || figure.reviewEveryDays <= 0) add('reviewEveryDays must be a positive whole number.');
  if (!Array.isArray(figure?.usedBy) || figure.usedBy.length === 0) {
    add('usedBy must name at least one module.');
  } else if (modules) {
    figure.usedBy.filter((name) => !modules.includes(name)).forEach((name) => add(`usedBy names an unknown module (${name}).`));
  }
  if (typeof figure?.version !== 'string' || figure.version === '') add('needs a version.');
  if (problems.length === 0) {
    try {
      resolveMarketFigureValue(figure);
    } catch (error) {
      add(error.message);
    }
  }
  return problems;
}
