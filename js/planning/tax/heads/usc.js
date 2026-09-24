/**
 * Universal Social Charge, per person (brief, 4.4 and 4.6).
 *
 * Aggregate income leaves out the State Pension and other Social Protection
 * payments, both for the charge and for the exemption and reduced-rate tests.
 * Once aggregate income is above the exemption threshold, all of it is charged.
 */

const USC_HEAD_ID = 'usc';

/** Income USC is charged on. Employment counts in full, before pension contributions. */
function uscAggregateIncome(income) {
  return income.occupationalPension
    + income.arfDistribution
    + income.employment
    + income.rentalProfit
    + income.lumpSumScheduleE;
}

/** Income that counts towards the surcharge. In Phase 1 that is rental profit. */
function uscNonPayeIncome(income) {
  return income.rentalProfit;
}

function chargeBands(amount, bands) {
  let lower = 0;
  let total = 0;
  const slices = [];
  for (const band of bands) {
    if (amount <= lower) {
      break;
    }
    const upper = band.upTo === null ? amount : Math.min(amount, band.upTo);
    const base = upper - lower;
    if (base > 0) {
      slices.push({ base, rate: band.rate, amount: base * band.rate });
      total += base * band.rate;
    }
    if (band.upTo === null) {
      break;
    }
    lower = band.upTo;
  }
  return { total, slices };
}

function uscForPerson(person, rules) {
  const usc = rules.usc;
  const aggregate = uscAggregateIncome(person.income);
  const lines = [];
  const disclosures = [];

  if (person.income.statePension > 0) {
    disclosures.push({ code: 'USC_STATE_PENSION_EXEMPT' });
  }

  if (aggregate <= usc.exemptionThreshold) {
    return { personId: person.id, aggregateIncome: aggregate, basis: 'exempt', charge: 0, surcharge: 0, usc: 0, lines, disclosures };
  }

  const reduced = person.age >= usc.reduced.fromAge && aggregate <= usc.reduced.aggregateIncomeCeiling;
  const bands = reduced ? usc.reduced.bands : usc.bands;
  const ruleId = reduced ? usc.reduced.ruleId : usc.ruleId;
  const charged = chargeBands(aggregate, bands);
  charged.slices.forEach((slice) => {
    lines.push({ head: USC_HEAD_ID, ruleId, personId: person.id, kind: 'charge', label: 'USC', base: slice.base, rate: slice.rate, amount: slice.amount });
  });
  if (reduced) {
    disclosures.push({ code: 'USC_REDUCED_70' });
  }

  const surchargeBase = Math.max(0, uscNonPayeIncome(person.income) - usc.surcharge.nonPayeThreshold);
  const surcharge = surchargeBase * usc.surcharge.rate;
  if (surcharge > 0) {
    lines.push({ head: USC_HEAD_ID, ruleId: usc.surcharge.ruleId, personId: person.id, kind: 'charge', label: 'USC surcharge on non-PAYE income', base: surchargeBase, rate: usc.surcharge.rate, amount: surcharge });
    disclosures.push({ code: 'USC_SURCHARGE' });
  }

  return {
    personId: person.id,
    aggregateIncome: aggregate,
    basis: reduced ? 'reduced' : 'standard',
    charge: charged.total,
    surcharge,
    usc: charged.total + surcharge,
    lines,
    disclosures
  };
}

export const uscHead = Object.freeze({
  id: USC_HEAD_ID,
  phase: 'income',
  compute(context) {
    const lines = [];
    const disclosures = [];
    const byPerson = context.people.map((person) => {
      const outcome = uscForPerson(person, context.rules);
      lines.push(...outcome.lines);
      disclosures.push(...outcome.disclosures);
      return {
        personId: outcome.personId,
        aggregateIncome: outcome.aggregateIncome,
        basis: outcome.basis,
        charge: outcome.charge,
        surcharge: outcome.surcharge,
        usc: outcome.usc
      };
    });
    return {
      lines,
      disclosures,
      byPerson,
      total: byPerson.reduce((total, entry) => total + entry.usc, 0)
    };
  }
});
