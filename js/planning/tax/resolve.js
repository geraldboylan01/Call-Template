/**
 * The rules in force for one tax year, under Planéir's projection policy.
 *
 * 1. Parameters each Budget sets come from the latest catalogue year at or
 *    before the year asked for, unchanged in euro terms. Never indexed.
 * 2. Changes the law fixes by date and amount (the PRSI rises, the SFT steps
 *    and any SFT Revenue has since published) are applied on their dates and
 *    held at their last value afterwards.
 * 3. A formula that depends on data not yet published (the SFT from 2030) is
 *    never evaluated or forecast. Step 2 holds the last known figure instead.
 *
 * The policy itself is recorded as the `taxProjection` Planéir assumption;
 * this file is its only implementation.
 */

import {
  IE_LEGISLATED_SCHEDULES,
  IE_TAX_FIRST_YEAR,
  IE_TAX_RULES_BY_YEAR,
  IE_TAX_RULES_VERSION
} from './rules_ie.js';

export const DEFAULT_IE_TAX_CATALOGUE = Object.freeze({
  version: IE_TAX_RULES_VERSION,
  rulesByYear: IE_TAX_RULES_BY_YEAR,
  schedules: IE_LEGISLATED_SCHEDULES
});

function requireTaxYear(year, fieldName = 'year') {
  if (typeof year !== 'number' || !Number.isInteger(year)) {
    throw new Error(`${fieldName} must be an integer tax year; received ${JSON.stringify(year)}.`);
  }
  if (year < IE_TAX_FIRST_YEAR) {
    throw new Error(`${fieldName} must be ${IE_TAX_FIRST_YEAR} or later; the tax catalogue starts in ${IE_TAX_FIRST_YEAR}.`);
  }
  return year;
}

/**
 * Refuse a threshold schedule the law could not produce.
 *
 * Years must rise one entry at a time and the amount may never fall, because
 * s.787O takes the higher of the previous year's threshold and its indexed
 * value.
 */
function validateSftSchedule(fixed) {
  if (!Array.isArray(fixed) || fixed.length === 0) {
    throw new Error('standardFundThreshold.fixed must be a non-empty array.');
  }
  fixed.forEach((entry, index) => {
    const field = `standardFundThreshold.fixed[${index}]`;
    if (!entry || typeof entry !== 'object') {
      throw new Error(`${field} must be an object.`);
    }
    if (!Number.isInteger(entry.year)) {
      throw new Error(`${field}.year must be an integer.`);
    }
    if (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount) || entry.amount <= 0) {
      throw new Error(`${field}.amount must be a positive number.`);
    }
    if (index === 0) {
      return;
    }
    const previous = fixed[index - 1];
    if (entry.year <= previous.year) {
      throw new Error(`${field}.year must be later than ${previous.year}.`);
    }
    if (entry.amount < previous.amount) {
      throw new Error(
        `${field}.amount of ${entry.amount} is below the ${previous.year} threshold of ${previous.amount}; `
        + 'the law does not allow the Standard Fund Threshold to fall.'
      );
    }
  });
  return fixed;
}

/**
 * A catalogue with one more officially published SFT recorded.
 *
 * Returns a new catalogue rather than changing the one passed in. This is how a
 * test exercises a published figure, and how the real one is added when Revenue
 * publishes it: as a fixed amount with its source, never as a projection.
 */
export function recordPublishedSft(catalogue, { year, amount, source = null }) {
  const base = catalogue || DEFAULT_IE_TAX_CATALOGUE;
  const threshold = base.schedules.standardFundThreshold;
  const fixed = [
    ...threshold.fixed,
    Object.freeze({ year, amount, basis: 'published', source })
  ];
  validateSftSchedule(fixed);
  return Object.freeze({
    ...base,
    schedules: Object.freeze({
      ...base.schedules,
      standardFundThreshold: Object.freeze({ ...threshold, fixed: Object.freeze(fixed) })
    })
  });
}

/**
 * The threshold for a year: the figure recorded for that year, or the last
 * one recorded before it, held.
 */
export function resolveSft(year, catalogue = DEFAULT_IE_TAX_CATALOGUE) {
  requireTaxYear(year);
  const threshold = catalogue.schedules.standardFundThreshold;
  const fixed = validateSftSchedule(threshold.fixed);
  const applicable = [...fixed].reverse().find((entry) => entry.year <= year);
  if (!applicable) {
    throw new Error(`year ${year} is before the first recorded Standard Fund Threshold.`);
  }
  const lastKnown = fixed[fixed.length - 1];
  return Object.freeze({
    year,
    amount: applicable.amount,
    basis: applicable.year === year ? 'fixed' : 'held',
    recordedYear: applicable.year,
    recordedBasis: applicable.basis,
    lastKnownYear: lastKnown.year,
    lastKnownAmount: lastKnown.amount,
    indexedFromYear: threshold.indexedFromYear,
    source: applicable.source || null
  });
}

function monthStart(year, month) {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/**
 * The PRSI rate for a year, blended by months in force where it changes during
 * the year (brief, 4.1): income is assumed to arrive evenly across the year.
 */
function resolvePrsiRate(year, catalogue = DEFAULT_IE_TAX_CATALOGUE) {
  requireTaxYear(year);
  const schedule = catalogue.schedules.prsiRate;
  const monthsByRate = new Map();
  for (let month = 1; month <= 12; month += 1) {
    const date = monthStart(year, month);
    const entry = [...schedule].reverse().find((candidate) => candidate.effectiveFrom <= date);
    if (!entry) {
      throw new Error(`No PRSI rate is recorded for ${date}.`);
    }
    monthsByRate.set(entry, (monthsByRate.get(entry) || 0) + 1);
  }
  const entries = [...monthsByRate.entries()];
  const rate = entries.reduce((total, [entry, months]) => total + (entry.rate * months), 0) / 12;
  const last = schedule[schedule.length - 1];
  return Object.freeze({
    rate,
    blended: entries.length > 1,
    ratesInYear: Object.freeze(entries.map(([entry, months]) => Object.freeze({
      ruleId: entry.ruleId,
      rate: entry.rate,
      months
    }))),
    lastScheduledChange: last.effectiveFrom,
    held: year > Number(last.effectiveFrom.slice(0, 4))
  });
}

function latestRulesYear(year, rulesByYear) {
  const years = Object.keys(rulesByYear).map(Number).filter((candidate) => candidate <= year);
  if (years.length === 0) {
    throw new Error(`No tax rules are recorded for ${year} or earlier.`);
  }
  return Math.max(...years);
}

function buildResolvedRules(year, catalogue) {
  const rulesYear = latestRulesYear(year, catalogue.rulesByYear);
  const block = catalogue.rulesByYear[rulesYear];
  const prsiRate = resolvePrsiRate(year, catalogue);
  const sft = resolveSft(year, catalogue);
  const sftFixed = catalogue.schedules.standardFundThreshold.fixed;
  const lastFixedSft = sftFixed[sftFixed.length - 1];
  const prsiSchedule = catalogue.schedules.prsiRate;

  return Object.freeze({
    year,
    version: catalogue.version,
    rulesYear,
    heldForward: year > rulesYear,
    status: block.status,
    enactedBy: block.enactedBy,
    verifiedOn: block.verifiedOn,
    incomeTax: block.incomeTax,
    ageExemption: block.ageExemption,
    usc: block.usc,
    prsi: Object.freeze({
      ...block.prsi,
      rate: prsiRate.rate,
      blended: prsiRate.blended,
      ratesInYear: prsiRate.ratesInYear,
      rateHeld: prsiRate.held
    }),
    lumpSum: block.lumpSum,
    chargeableExcessTax: Object.freeze({
      ruleId: block.chargeableExcessTax.ruleId,
      rate: block.incomeTax.higherRate,
      sources: block.chargeableExcessTax.sources
    }),
    sft,
    sftBasis: sft.basis,
    // What the standing disclosures say the law has already fixed, read from
    // the schedules so the sentence moves when the schedules do.
    legislatedChanges: Object.freeze({
      prsiFinalChangeYear: Number(prsiSchedule[prsiSchedule.length - 1].effectiveFrom.slice(0, 4)),
      prsiChangeMonth: 'October',
      sftLastFixedYear: lastFixedSft.year,
      sftLastFixedAmount: lastFixedSft.amount
    })
  });
}

const defaultCache = new Map();

/**
 * The rules in force for `year`. Years before 2026 throw.
 *
 * Resolved rules for the built-in catalogue are cached by year: a 60-year
 * projection asks for the same handful of years thousands of times.
 */
export function resolveTaxRules(year, { catalogue = null } = {}) {
  requireTaxYear(year);
  if (!catalogue || catalogue === DEFAULT_IE_TAX_CATALOGUE) {
    if (!defaultCache.has(year)) {
      defaultCache.set(year, buildResolvedRules(year, DEFAULT_IE_TAX_CATALOGUE));
    }
    return defaultCache.get(year);
  }
  return buildResolvedRules(year, catalogue);
}
