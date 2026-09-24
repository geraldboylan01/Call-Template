/**
 * PRSI, per person (brief, 4.5 and 4.6).
 *
 * Charged only on ARF withdrawals, rental profit and earnings, never on the
 * State Pension, occupational pensions, annuities or the Schedule E part of a
 * lump sum. The rate is the year's blended rate from the legislated schedule.
 */

const PRSI_HEAD_ID = 'prsi';

/** Income PRSI can be charged on. Employment counts in full, before pension contributions. */
function prsiableIncome(income) {
  return income.arfDistribution + income.rentalProfit + income.employment;
}

/** Whether the person reached 66 before the cut-off year (born before 1958 for 2024). */
function reached66Before(person, rules) {
  return person.birthYear + rules.prsi.liableUnderAge < rules.prsi.reached66BeforeYear;
}

/** Liability for one person in one year, with the reason, so the disclosure can say it. */
function prsiLiability(person, rules) {
  const prsi = rules.prsi;
  if (person.age < prsi.liableUnderAge) {
    return { liable: true, reason: 'under_66' };
  }
  if (person.age >= prsi.exemptFromAge) {
    return { liable: false, reason: 'aged_70' };
  }
  if (reached66Before(person, rules)) {
    return { liable: false, reason: 'reached_66_before_2024' };
  }
  if (person.receivingStatePensionContributory) {
    return { liable: false, reason: 'receiving_state_pension_contributory' };
  }
  return { liable: true, reason: 'not_receiving_state_pension_contributory' };
}

export const prsiHead = Object.freeze({
  id: PRSI_HEAD_ID,
  phase: 'income',
  compute(context) {
    const rules = context.rules;
    const lines = [];
    const disclosures = [];

    const byPerson = context.people.map((person) => {
      const base = prsiableIncome(person.income);
      const liability = prsiLiability(person, rules);
      const amount = liability.liable ? base * rules.prsi.rate : 0;

      if (person.income.statePension > 0 || person.income.occupationalPension > 0) {
        disclosures.push({ code: 'PRSI_NONE_ON_PENSIONS' });
      }
      if (base > 0 && liability.reason === 'reached_66_before_2024') {
        disclosures.push({ code: 'PRSI_PRE_2024_COHORT' });
      }
      if (amount > 0) {
        lines.push({ head: PRSI_HEAD_ID, ruleId: rules.prsi.ratesInYear.map((entry) => entry.ruleId).join('+'), personId: person.id, kind: 'charge', label: 'PRSI', base, rate: rules.prsi.rate, amount });
        disclosures.push({ code: 'PRSI_UNTIL_SPC' });
        if (rules.prsi.blended) {
          disclosures.push({ code: 'PRSI_BLENDED' });
        }
      }

      return {
        personId: person.id,
        prsiableIncome: base,
        liable: liability.liable,
        reason: liability.reason,
        rate: rules.prsi.rate,
        prsi: amount
      };
    });

    return {
      lines,
      disclosures,
      byPerson,
      total: byPerson.reduce((total, entry) => total + entry.prsi, 0)
    };
  }
});
