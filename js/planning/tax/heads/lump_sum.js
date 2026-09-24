/**
 * Retirement lump sums (brief, 4.7).
 *
 * Every retirement lump sum paid since 7 December 2005 counts against one
 * lifetime allowance. The first slice is tax-free, the next is taxed at the
 * standard rate and ring-fenced from the rest of the person's tax, and anything
 * above the ceiling is Schedule E income for the year. Earlier lump sums use up
 * the lower slices first, which is why the split depends on what came before.
 */

const LUMP_SUM_HEAD_ID = 'lump_sum';

/**
 * How one lump sum divides between the three slices, given what has already
 * been paid. Revenue's Pensions Manual Chapter 27, Example 4 is golden case G6.
 */
export function splitLumpSum({ lumpSum, priorLumpSums = 0, rules }) {
  const { lifetimeTaxFree, standardRateCeiling, standardRate } = rules.lumpSum;
  const before = priorLumpSums;
  const after = before + lumpSum;
  const taxFree = Math.max(0, Math.min(after, lifetimeTaxFree) - Math.min(before, lifetimeTaxFree));
  const standardRatePart = Math.max(
    0,
    Math.min(after, standardRateCeiling) - Math.max(before, lifetimeTaxFree)
  );
  const scheduleE = Math.max(0, after - Math.max(before, standardRateCeiling));

  return {
    lumpSum,
    priorLumpSums: before,
    cumulativeAfter: after,
    taxFree,
    standardRatePart,
    standardRate,
    standardRateTax: standardRatePart * standardRate,
    scheduleE
  };
}

export const lumpSumHead = Object.freeze({
  id: LUMP_SUM_HEAD_ID,
  phase: 'pension_events',
  /**
   * Splits each crystallisation's lump sum, records the lifetime total in the
   * working state, and adds any Schedule E part to that person's income so the
   * income heads tax it with the rest of the year (brief, 4.6).
   */
  compute(context) {
    const lines = [];
    const disclosures = [];
    const rules = context.rules;

    context.crystallisations.forEach((record) => {
      if (!(record.lumpSum > 0)) {
        return;
      }
      const personState = context.state.people[record.personId];
      const split = splitLumpSum({
        lumpSum: record.lumpSum,
        priorLumpSums: personState.lumpSumsSince2005,
        rules
      });
      personState.lumpSumsSince2005 = split.cumulativeAfter;
      context.personById.get(record.personId).income.lumpSumScheduleE += split.scheduleE;
      Object.assign(record, {
        priorLumpSums: split.priorLumpSums,
        lumpSumTaxFree: split.taxFree,
        lumpSumStandardRatePart: split.standardRatePart,
        lumpSumTax: split.standardRateTax,
        scheduleE: split.scheduleE
      });

      const ruleId = rules.lumpSum.ruleId;
      lines.push(
        { head: LUMP_SUM_HEAD_ID, ruleId, personId: record.personId, kind: 'exempt', label: 'Tax-free lump sum', base: split.taxFree, rate: 0, amount: 0 },
        { head: LUMP_SUM_HEAD_ID, ruleId, personId: record.personId, kind: 'charge', label: 'Lump sum taxed at the standard rate', base: split.standardRatePart, rate: split.standardRate, amount: split.standardRateTax }
      );
      if (split.scheduleE > 0) {
        lines.push({ head: LUMP_SUM_HEAD_ID, ruleId, personId: record.personId, kind: 'income', label: 'Lump sum taxed as income (Schedule E)', base: split.scheduleE, rate: null, amount: 0 });
      }

      disclosures.push({ code: 'LUMP_SUM_RULES' });
      if (split.priorLumpSums > 0) {
        disclosures.push({ code: 'LUMP_SUM_PRIOR', params: { amount: split.priorLumpSums } });
      }
    });

    return { lines, disclosures };
  }
});
