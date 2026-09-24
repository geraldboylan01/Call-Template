/**
 * ARF imputed distributions (brief, 4.9).
 *
 * The rates and the age test are dated Irish rules and live in
 * `ireland_rules.js`; this head only applies them. An imputed distribution is
 * taxed exactly like one actually taken, so there is nothing further to charge
 * here: the caller models the minimum as withdrawn, includes it in the
 * `arfDistribution` item, and says how much of that item it was. The head
 * checks the claim holds together and raises the disclosure that goes with it.
 */

import {
  IRISH_ARF_MINIMUM_DRAWDOWN,
  irishArfMinimumRate
} from '../../ireland_rules.js';

const ARF_IMPUTED_HEAD_ID = 'arf_imputed';

/** The imputed distribution for a fund valued at `openingValue`, at this attained age. */
export function arfImputedDistribution({ attainedAge, openingValue }) {
  const rate = irishArfMinimumRate(attainedAge, openingValue);
  return {
    ruleId: IRISH_ARF_MINIMUM_DRAWDOWN.ruleId,
    rate,
    amount: openingValue * rate
  };
}

export const arfImputedHead = Object.freeze({
  id: ARF_IMPUTED_HEAD_ID,
  phase: 'pension_events',
  compute(context) {
    const lines = [];
    const disclosures = [];

    context.people.forEach((person) => {
      if (!(person.imputedMinimum > 0)) {
        return;
      }
      lines.push({
        head: ARF_IMPUTED_HEAD_ID,
        ruleId: IRISH_ARF_MINIMUM_DRAWDOWN.ruleId,
        personId: person.id,
        kind: 'income',
        label: 'Imputed ARF distribution, included in the ARF withdrawal',
        base: person.imputedMinimum,
        rate: null,
        amount: 0
      });
      disclosures.push({ code: 'ARF_MINIMUM' });
    });

    return { lines, disclosures };
  }
});
