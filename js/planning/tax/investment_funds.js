/**
 * What money invested outside a pension is subject to, for the notes a module
 * shows beside it.
 *
 * The tax engine does not compute exit tax or the eight-year charge. This file
 * reads the rules for a date and says which disclosures apply; the words are
 * in disclosures.js and every figure in them comes from the rules catalogue.
 * A module raises these with `afterTaxInvestmentDisclosures` and renders them
 * with `renderTaxDisclosures`, the same as any other tax disclosure.
 */

import { assertIsoDate } from '../utils.js';

function requireIsoDate(value, field) {
  return assertIsoDate(value, field);
}

/**
 * Whether a rule was known on a date. An announced rule is not, before the day
 * it was announced: a date before Budget day gets the law as it then stood.
 */
function knownOn(entry, dateIso) {
  return entry.status !== 'announced' || !entry.announcedOn || entry.announcedOn <= dateIso;
}

function requireInvestmentRules(rules) {
  const funds = rules?.investmentFunds;
  if (!funds || !Array.isArray(funds.exitTaxRateSchedule)) {
    throw new Error('rules.investmentFunds is missing; pass rules from resolveTaxRules.');
  }
  return funds;
}

/**
 * The exit tax entry in force on a date: the last one on or before it, so the
 * final rate is held. Throws for a date before the first entry.
 */
export function exitTaxRateOn(dateIso, rules) {
  requireIsoDate(dateIso, 'date');
  const schedule = requireInvestmentRules(rules).exitTaxRateSchedule;
  const entry = [...schedule].reverse().find((candidate) => candidate.effectiveFrom <= dateIso && knownOn(candidate, dateIso));
  if (!entry) {
    throw new Error(`No exit tax rate is recorded for ${dateIso}.`);
  }
  return entry;
}

/** The next scheduled change after a date, or null. */
function nextExitTaxChange(dateIso, rules) {
  const schedule = requireInvestmentRules(rules).exitTaxRateSchedule;
  return schedule.find((entry) => entry.effectiveFrom > dateIso && knownOn(entry, dateIso)) || null;
}

/**
 * The disclosures to show beside money invested outside a pension, as of a date.
 *
 * - `pensionAtReliefLimit`: the household's pension contributions are already at
 *   the most that gets income tax relief, which is why the money goes here.
 *   `reliefLimit` ({ share, earningsCap }) adds the figures when the module has
 *   them from the pension rules.
 * - The exit tax rate in force on `asOf`, with the eight-year charge.
 * - An announced rate: the one in force on `asOf` if it is not yet law, or else
 *   the next scheduled change.
 * - The Investment Account, unless `includeInvestmentAccount` is false.
 */
export function afterTaxInvestmentDisclosures({
  asOf,
  rules,
  pensionAtReliefLimit = false,
  reliefLimit = null,
  includeInvestmentAccount = true
} = {}) {
  requireIsoDate(asOf, 'asOf');
  const funds = requireInvestmentRules(rules);
  const disclosures = [];

  if (pensionAtReliefLimit) {
    const params = reliefLimit && Number.isFinite(reliefLimit.share) && Number.isFinite(reliefLimit.earningsCap)
      ? { share: reliefLimit.share, earningsCap: reliefLimit.earningsCap }
      : null;
    disclosures.push({ code: 'PENSION_AT_RELIEF_LIMIT', params });
  }

  const inForce = exitTaxRateOn(asOf, rules);
  disclosures.push({ code: 'INVESTMENT_FUND_TAX', params: { rate: inForce.rate } });

  const announced = inForce.status === 'announced' ? inForce : nextExitTaxChange(asOf, rules);
  if (announced && announced.status === 'announced') {
    disclosures.push({
      code: 'INVESTMENT_FUND_TAX_ANNOUNCED',
      params: {
        rate: announced.rate,
        effectiveFrom: announced.effectiveFrom,
        announcedBy: announced.announcedBy,
        inForce: announced === inForce
      }
    });
  }

  if (includeInvestmentAccount && funds.investmentAccount && knownOn(funds.investmentAccount, asOf)) {
    disclosures.push({ code: 'INVESTMENT_ACCOUNT', params: { asOf } });
  }

  return disclosures;
}
