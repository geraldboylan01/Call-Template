/**
 * The Standard Fund Threshold, chargeable excess tax and the lump sum credit
 * (brief, 4.8).
 *
 * The threshold is tested per person at each benefit crystallisation event.
 * The amount above it is taxed at the higher rate of income tax, ring-fenced
 * from everything else, and the standard-rate tax already taken from lump sums
 * since 2011 is credited against that charge. Unused credit carries forward.
 *
 * `crystallise` needs no income data, which is what lets the retirement engine
 * call it at the start of a retirement year, before that year's withdrawals are
 * known (brief, 7.2).
 */

import { resolveTaxRules } from '../resolve.js';
import { splitLumpSum } from './lump_sum.js';

const SFT_HEAD_ID = 'sft';

function requireNonNegative(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a number greater than or equal to 0.`);
  }
  return value;
}

/**
 * The chargeable excess and the tax on it, before and after the credit.
 *
 * Chargeable excess = max(0, SFT already used + fund value crystallised - SFT),
 * exactly as the brief states it (4.8).
 */
export function chargeableExcessTax({ fundValue, sftUsed = 0, availableCredit = 0, rules }) {
  const sft = rules.sft.amount;
  const rate = rules.chargeableExcessTax.rate;
  const chargeableExcess = Math.max(0, sftUsed + fundValue - sft);
  const grossCet = chargeableExcess * rate;
  const creditApplied = Math.min(availableCredit, grossCet);

  return {
    sft,
    sftYear: rules.year,
    sftBasis: rules.sft.basis,
    sftRecordedYear: rules.sft.recordedYear,
    sftUsedBefore: sftUsed,
    sftUsedAfter: sftUsed + fundValue,
    chargeableExcess,
    cetRate: rate,
    grossCet,
    creditAvailable: availableCredit,
    creditApplied,
    netCet: grossCet - creditApplied,
    creditCarriedForward: availableCredit - creditApplied
  };
}

/**
 * The fund left for drawdown once the lump sum is paid and the net CET is taken.
 *
 * The administrator pays the net CET out of the fund. Where a very large lump
 * sum leaves too little in the fund to cover it, the rest comes out of the lump
 * sum, so the drawdown fund never goes below zero.
 */
function settleDrawdownFund({ fundValue, lumpSum, netCet }) {
  const residual = fundValue - lumpSum - netCet;
  return {
    drawdownFund: Math.max(0, residual),
    cetPaidFromLumpSum: Math.max(0, -residual)
  };
}

/**
 * One benefit crystallisation, worked through on its own: lump sum tax, SFT,
 * chargeable excess, CET, credit and drawdown fund.
 *
 * `personState` is the person's carried state (lumpSumsSince2005, sftUsed,
 * unrelievedLumpSumTax). The result includes the state that follows, which is
 * exactly what `computeTaxYear` records when the same event is included there.
 */
export function crystallise({ year, fundValue, lumpSum = 0, personState = {}, rules = null }) {
  requireNonNegative(fundValue, 'fundValue');
  requireNonNegative(lumpSum, 'lumpSum');
  if (lumpSum > fundValue) {
    throw new Error(`lumpSum of ${lumpSum} is more than the fundValue of ${fundValue}.`);
  }
  const resolved = rules || resolveTaxRules(year);
  const prior = {
    lumpSumsSince2005: requireNonNegative(personState.lumpSumsSince2005 ?? 0, 'personState.lumpSumsSince2005'),
    sftUsed: requireNonNegative(personState.sftUsed ?? 0, 'personState.sftUsed'),
    unrelievedLumpSumTax: requireNonNegative(personState.unrelievedLumpSumTax ?? 0, 'personState.unrelievedLumpSumTax')
  };

  const split = splitLumpSum({ lumpSum, priorLumpSums: prior.lumpSumsSince2005, rules: resolved });
  const cet = chargeableExcessTax({
    fundValue,
    sftUsed: prior.sftUsed,
    availableCredit: prior.unrelievedLumpSumTax + split.standardRateTax,
    rules: resolved
  });
  const settled = settleDrawdownFund({ fundValue, lumpSum, netCet: cet.netCet });

  return {
    year: resolved.year,
    fundValue,
    lumpSum,
    priorLumpSums: split.priorLumpSums,
    lumpSumTaxFree: split.taxFree,
    lumpSumStandardRatePart: split.standardRatePart,
    lumpSumTax: split.standardRateTax,
    scheduleE: split.scheduleE,
    ...cet,
    ...settled,
    nextPersonState: {
      ...personState,
      lumpSumsSince2005: split.cumulativeAfter,
      sftUsed: cet.sftUsedAfter,
      unrelievedLumpSumTax: cet.creditCarriedForward
    }
  };
}

/** The disclosures one crystallisation raises, in the order they read best. */
function crystallisationDisclosures(record) {
  const disclosures = [{ code: 'SFT_THRESHOLD', params: { amount: record.sft, years: [record.sftYear] } }];
  if (record.sftBasis === 'held') {
    disclosures.push({ code: 'SFT_HELD', params: { heldAmount: record.sft, years: [record.sftYear] } });
  }
  if (record.sftUsedBefore > 0) {
    disclosures.push({ code: 'SFT_ALREADY_USED', params: { amount: record.sftUsedBefore } });
  }
  if (record.chargeableExcess > 0) {
    disclosures.push({ code: 'SFT_CET', params: { rate: record.cetRate } });
  }
  if (record.creditApplied > 0) {
    disclosures.push({ code: 'SFT_CREDIT', params: { amount: record.creditCarriedForward } });
  }
  return disclosures;
}

export const sftHead = Object.freeze({
  id: SFT_HEAD_ID,
  phase: 'pension_events',
  /**
   * Tests each crystallisation against the threshold in the order the events
   * were given, so two crystallisations in one year each see the threshold the
   * other has already used.
   */
  compute(context) {
    const lines = [];
    const disclosures = [];
    const rules = context.rules;

    context.crystallisations.forEach((record) => {
      const personState = context.state.people[record.personId];
      const cet = chargeableExcessTax({
        fundValue: record.fundValue,
        sftUsed: personState.sftUsed,
        availableCredit: personState.unrelievedLumpSumTax + (record.lumpSumTax || 0),
        rules
      });
      const settled = settleDrawdownFund({ fundValue: record.fundValue, lumpSum: record.lumpSum, netCet: cet.netCet });
      personState.sftUsed = cet.sftUsedAfter;
      personState.unrelievedLumpSumTax = cet.creditCarriedForward;
      Object.assign(record, cet, settled);

      const ruleId = rules.chargeableExcessTax.ruleId;
      if (cet.chargeableExcess > 0) {
        lines.push(
          { head: SFT_HEAD_ID, ruleId, personId: record.personId, kind: 'charge', label: 'Chargeable excess tax', base: cet.chargeableExcess, rate: cet.cetRate, amount: cet.grossCet },
          { head: SFT_HEAD_ID, ruleId, personId: record.personId, kind: 'credit', label: 'Lump sum tax credited against chargeable excess tax', base: null, rate: null, amount: -cet.creditApplied }
        );
      }
      disclosures.push(...crystallisationDisclosures(record));
    });

    return { lines, disclosures };
  }
});
