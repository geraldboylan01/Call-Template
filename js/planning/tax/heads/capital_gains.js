/**
 * Capital gains tax on selling property.
 *
 * One household year. Each sale's gain is worked out on its own (indexation,
 * then principal private residence, then the 2011 to 2014 relief), split
 * between its owners, and then each person's year is settled in the order
 * Revenue sets out: this year's losses, a spouse's unused losses where they
 * are assessed jointly, losses carried forward, the annual exemption, and the
 * rate in force on the date of each sale.
 *
 * Reliefs that depend on facts the engine cannot check are asserted in the
 * input (brief, decision 7): `homeUse` says whether the property was the
 * owner's home and `acquiredBy` whether it was bought. Nothing is inferred.
 *
 * Sources are recorded against each rule in `rules_ie.js`.
 */

const CAPITAL_GAINS_HEAD_ID = 'capital_gains';
const JOINT_PERSON_ID = 'joint';

/* ------------------------------------------------------------------ dates */

function parseIsoDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The date `years` after a date, as a UTC timestamp. 29 February falls back to the 28th. */
function anniversary(date, years) {
  const year = date.year + years;
  return Date.UTC(year, date.month - 1, Math.min(date.day, daysInMonth(year, date.month)));
}

/**
 * The time from one date to another in years: whole years by anniversary,
 * then the part year as a share of the year it falls in.
 *
 * Revenue's examples only use whole years. A part year is counted exactly,
 * which gives very slightly less relief than rounding down would, so any
 * error is against the client (brief, decision 9).
 */
export function yearsBetween(fromIso, toIso) {
  const from = parseIsoDate(fromIso);
  const to = parseIsoDate(toIso);
  const toTime = Date.UTC(to.year, to.month - 1, to.day);
  let whole = Math.max(0, to.year - from.year);
  while (whole > 0 && anniversary(from, whole) > toTime) {
    whole -= 1;
  }
  const start = anniversary(from, whole);
  const next = anniversary(from, whole + 1);
  return whole + (toTime - start) / (next - start);
}

/* ------------------------------------------------------------- the rules */

/**
 * The indexation multiplier for what was paid on a date (s.556). Costs from
 * 2003 are not indexed. Indexation also does not apply to costs in the twelve
 * months before a sale, which cannot arise here: every indexed cost is from
 * 2002 or earlier and every sale is from 2026.
 */
export function indexationMultiplier(acquisitionDate, indexationRules) {
  if (acquisitionDate < indexationRules.earliestSupportedAcquisition) {
    throw new Error(
      `acquisitionDate ${acquisitionDate} is before 6 April 1974, which needs the market value on that date. It is not supported.`
    );
  }
  const period = indexationRules.periods.find((entry) => entry.from <= acquisitionDate && acquisitionDate <= entry.to);
  return period
    ? { period: period.period, multiplier: period.multiplier }
    : { period: null, multiplier: 1 };
}

/**
 * The exempt share of a gain under s.604A, for property bought between
 * 7 December 2011 and 31 December 2014 at market value.
 */
export function section604AShare({ acquisitionDate, disposalDate, acquiredBy }, rules) {
  const inWindow = acquisitionDate >= rules.acquiredFrom && acquisitionDate <= rules.acquiredTo;
  if (!inWindow) {
    return { inWindow: false, applies: false, yearsOwned: null, exemptShare: 0 };
  }
  const yearsOwned = yearsBetween(acquisitionDate, disposalDate);
  if (acquiredBy !== 'purchase') {
    return { inWindow: true, applies: false, yearsOwned, exemptShare: 0 };
  }
  const minimumYears = disposalDate >= rules.minimumYearsFromDisposal ? rules.minimumYears : rules.exemptYears;
  let exemptShare = 0;
  if (yearsOwned > rules.exemptYears) {
    exemptShare = rules.exemptYears / yearsOwned;
  } else if (yearsOwned >= minimumYears) {
    exemptShare = 1;
  }
  return { inWindow: true, applies: exemptShare > 0, yearsOwned, exemptShare };
}

/** The rate in force on a date: the last schedule entry on or before it. */
function capitalGainsRateOn(date, rateSchedule) {
  const entry = [...rateSchedule].reverse().find((candidate) => candidate.effectiveFrom <= date);
  if (!entry) {
    throw new Error(`No capital gains tax rate is recorded for ${date}.`);
  }
  return entry;
}

/**
 * One sale's gain or loss before it is split between owners or set against
 * anything else.
 */
export function computeDisposalGain(disposal, cgtRules) {
  const investment = disposal.type === 'investmentDisposal';
  const index = investment && !disposal.acquisitionDate
    ? { period: null, multiplier: 1 }
    : indexationMultiplier(disposal.acquisitionDate, cgtRules.indexation);
  const netProceeds = disposal.proceeds - disposal.sellingCosts;
  const monetaryGain = netProceeds - disposal.acquisitionCost;
  const indexedCost = disposal.acquisitionCost * index.multiplier;
  const indexedGain = netProceeds - indexedCost;

  // Indexation can neither create a loss nor make one bigger (s.556(4)).
  let gain = 0;
  let loss = 0;
  let outcome = 'none';
  if (monetaryGain > 0 && indexedGain > 0) {
    gain = indexedGain;
    outcome = 'gain';
  } else if (monetaryGain > 0) {
    outcome = 'no_gain_no_loss';
  } else if (monetaryGain < 0) {
    loss = -monetaryGain;
    outcome = 'loss';
  }

  const homeExempt = !investment && disposal.homeUse === 'throughout';
  const relief = homeExempt || investment
    ? { inWindow: false, applies: false, yearsOwned: null, exemptShare: 0 }
    : section604AShare(disposal, cgtRules.section604A);
  const exemptShare = homeExempt ? 1 : relief.exemptShare;
  const exemptAmount = gain * exemptShare;
  const rateEntry = capitalGainsRateOn(disposal.disposalDate, cgtRules.rateSchedule);

  return {
    netProceeds,
    indexation: { period: index.period, multiplier: index.multiplier, indexedCost },
    monetaryGain,
    gainAfterIndexation: gain,
    lossAfterIndexation: loss,
    outcome,
    homeExempt,
    section604A: { ...relief, exemptAmount: homeExempt ? 0 : exemptAmount },
    chargeableGain: gain - exemptAmount,
    // A loss is allowable only in the share a gain would have been
    // chargeable (s.546(3)), so an exempt home or an exempt share gives none.
    allowableLoss: loss * (1 - exemptShare),
    rate: rateEntry.rate,
    rateRuleId: rateEntry.ruleId,
    rateStatus: rateEntry.status,
    rateEffectiveFrom: rateEntry.effectiveFrom,
    rateAnnouncedBy: rateEntry.announcedBy || null
  };
}

/* ---------------------------------------------------------------- settling */

/**
 * Take up to `amount` from the pieces, highest rate first, so losses and the
 * exemption go where they save the most. Returns what was taken.
 */
function absorb(pieces, amount) {
  let remaining = amount;
  pieces.forEach((piece) => {
    if (remaining <= 0) {
      return;
    }
    const taken = Math.min(piece.remaining, remaining);
    piece.remaining -= taken;
    remaining -= taken;
  });
  return amount - remaining;
}

function remainingGains(pieces) {
  return pieces.reduce((total, piece) => total + piece.remaining, 0);
}

export const capitalGainsHead = Object.freeze({
  id: CAPITAL_GAINS_HEAD_ID,
  phase: 'capital_events',
  compute(context) {
    const lines = [];
    const disclosures = [];
    const disposals = context.disposals || [];
    if (disposals.length === 0) {
      return { lines, disclosures, outcome: { disposals: [], byPerson: [], total: 0 } };
    }
    const cgtRules = context.rules.capitalGainsTax;
    if (!cgtRules) {
      throw new Error(`No capital gains tax rules are recorded for ${context.year}.`);
    }

    const peopleIds = context.people.map((person) => person.id);
    const ledgers = new Map(peopleIds.map((id) => [id, {
      personId: id,
      pieces: [],
      currentYearLosses: 0,
      broughtForward: context.state.people[id].cgtLossesCarriedForward
    }]));

    const records = disposals.map((disposal, index) => {
      const computed = computeDisposalGain(disposal, cgtRules);
      const owners = disposal.personId === JOINT_PERSON_ID ? peopleIds : [disposal.personId];
      const share = 1 / owners.length;
      owners.forEach((ownerId) => {
        const ledger = ledgers.get(ownerId);
        if (computed.chargeableGain > 0) {
          ledger.pieces.push({ disposalIndex: index, rate: computed.rate, ruleId: computed.rateRuleId, amount: computed.chargeableGain * share, remaining: computed.chargeableGain * share });
        }
        ledger.currentYearLosses += computed.allowableLoss * share;
      });
      return { index, ...disposal, owners, ...computed, tax: 0 };
    });

    ledgers.forEach((ledger) => {
      ledger.pieces.sort((left, right) => (right.rate - left.rate) || (left.disposalIndex - right.disposalIndex));
      ledger.chargeableGains = remainingGains(ledger.pieces);
      ledger.currentYearLossesUsed = absorb(ledger.pieces, ledger.currentYearLosses);
      ledger.unusedCurrentYearLosses = ledger.currentYearLosses - ledger.currentYearLossesUsed;
      ledger.lossesFromSpouse = 0;
      ledger.lossesToSpouse = 0;
    });

    // A jointly assessed spouse's unused loss is set against the other's
    // gains automatically, unless they elect otherwise (Revenue, "If you make
    // a loss"). The election is not modelled.
    if (context.status === 'married_or_civil_partners' && peopleIds.length === 2) {
      const [first, second] = peopleIds.map((id) => ledgers.get(id));
      [[first, second], [second, first]].forEach(([giver, taker]) => {
        if (giver.unusedCurrentYearLosses > 0) {
          const moved = absorb(taker.pieces, giver.unusedCurrentYearLosses);
          giver.unusedCurrentYearLosses -= moved;
          giver.lossesToSpouse += moved;
          taker.lossesFromSpouse += moved;
        }
      });
    }

    const byPerson = [...ledgers.values()].map((ledger) => {
      const broughtForwardUsed = absorb(ledger.pieces, ledger.broughtForward);
      const annualExemptionUsed = absorb(ledger.pieces, cgtRules.annualExemption);
      let tax = 0;
      ledger.pieces.forEach((piece) => {
        if (piece.remaining <= 0) {
          return;
        }
        const pieceTax = piece.remaining * piece.rate;
        tax += pieceTax;
        records[piece.disposalIndex].tax += pieceTax;
        lines.push({ head: CAPITAL_GAINS_HEAD_ID, ruleId: piece.ruleId, personId: ledger.personId, kind: 'charge', label: records[piece.disposalIndex].type === 'investmentDisposal' ? 'Capital gains tax on investment' : 'Capital gains tax on property', base: piece.remaining, rate: piece.rate, amount: pieceTax });
      });
      if (annualExemptionUsed > 0) {
        lines.push({ head: CAPITAL_GAINS_HEAD_ID, ruleId: cgtRules.ruleId, personId: ledger.personId, kind: 'exempt', label: 'CGT annual exemption', base: annualExemptionUsed, rate: 0, amount: 0 });
      }
      const lossesCarriedForward = ledger.broughtForward - broughtForwardUsed + ledger.unusedCurrentYearLosses;
      context.state.people[ledger.personId].cgtLossesCarriedForward = lossesCarriedForward;
      return {
        personId: ledger.personId,
        chargeableGains: ledger.chargeableGains,
        currentYearLosses: ledger.currentYearLosses,
        currentYearLossesUsed: ledger.currentYearLossesUsed,
        lossesFromSpouse: ledger.lossesFromSpouse,
        lossesToSpouse: ledger.lossesToSpouse,
        lossesBroughtForward: ledger.broughtForward,
        lossesBroughtForwardUsed: broughtForwardUsed,
        annualExemptionUsed,
        taxableGains: remainingGains(ledger.pieces),
        tax,
        lossesCarriedForward
      };
    });

    records.forEach((record) => {
      record.netProceedsAfterTax = record.netProceeds - record.tax;
      if (record.section604A.exemptAmount > 0) {
        lines.push({ head: CAPITAL_GAINS_HEAD_ID, ruleId: cgtRules.section604A.ruleId, personId: record.personId, kind: 'exempt', label: 'Exempt share of the gain on property bought from 2011 to 2014', base: record.section604A.exemptAmount, rate: 0, amount: 0 });
      }
    });

    /* ------------------------------------------------------- disclosures */

    records.forEach((record) => {
      if (record.homeUse === 'throughout') {
        disclosures.push({ code: 'CGT_HOME_EXEMPT' });
        return;
      }
      disclosures.push({ code: 'CGT_RATE', params: { rate: record.rate, exemption: cgtRules.annualExemption } });
      if (record.rateStatus === 'announced') {
        disclosures.push({ code: 'CGT_RATE_ANNOUNCED', params: { rate: record.rate, effectiveFrom: record.rateEffectiveFrom, announcedBy: record.rateAnnouncedBy } });
      }
      if (record.homeUse === 'part') {
        disclosures.push({ code: 'CGT_HOME_PART' });
      } else if (record.homeUse === 'unknown') {
        disclosures.push({ code: 'CGT_HOME_UNKNOWN' });
      }
      if (record.indexation.multiplier > 1 && record.outcome !== 'none') {
        disclosures.push({
          code: record.outcome === 'no_gain_no_loss' ? 'CGT_INDEXATION_NO_GAIN' : 'CGT_INDEXATION',
          params: { period: record.indexation.period, multiplier: record.indexation.multiplier }
        });
      }
      if (record.section604A.applies && record.outcome === 'gain') {
        disclosures.push({ code: 'CGT_2011_2014', params: { share: record.section604A.exemptShare } });
      } else if (record.section604A.inWindow && !record.section604A.applies && record.acquiredBy !== 'purchase') {
        disclosures.push({ code: 'CGT_2011_2014_NOT_BOUGHT' });
      }
      if (record.type === 'investmentDisposal') {
        disclosures.push({ code: 'CGT_INVESTMENT_SCOPE' });
        if (record.acquisitionCostBasis === 'assumed_zero') disclosures.push({ code: 'CGT_BASE_COST_ASSUMED_ZERO' });
        if (!record.acquisitionDate && record.acquisitionCost > 0) disclosures.push({ code: 'CGT_ACQUISITION_DATE_UNKNOWN' });
      } else disclosures.push({ code: 'CGT_COSTS_ENTERED' });
    });

    // A sale of the family home alone raises only its own line: no rate, no
    // assumptions about other gains, because nothing is taxed.
    const taxedRecords = records.filter((record) => record.homeUse !== 'throughout');
    if (taxedRecords.some(record => record.type !== 'investmentDisposal')) {
      disclosures.push({ code: 'CGT_SCOPE' });
    }
    if (taxedRecords.some((record) => record.personId === JOINT_PERSON_ID)) {
      disclosures.push({ code: 'CGT_JOINT_SPLIT' });
    }
    const broughtForwardAvailable = byPerson.reduce((total, person) => total + person.lossesBroughtForward, 0);
    const broughtForwardUsed = byPerson.reduce((total, person) => total + person.lossesBroughtForwardUsed, 0);
    if (taxedRecords.length > 0 && broughtForwardAvailable === 0) {
      disclosures.push({ code: 'CGT_OTHER_GAINS' });
    } else if (broughtForwardUsed > 0) {
      disclosures.push({ code: 'CGT_LOSSES_USED', params: { amount: broughtForwardUsed } });
    }
    const fromSpouse = byPerson.reduce((total, person) => total + person.lossesFromSpouse, 0);
    if (fromSpouse > 0) {
      disclosures.push({ code: 'CGT_LOSS_SPOUSE', params: { amount: fromSpouse } });
    }
    const newLosses = byPerson.reduce((total, person) => (
      total + Math.max(0, person.lossesCarriedForward - (person.lossesBroughtForward - person.lossesBroughtForwardUsed))
    ), 0);
    if (newLosses > 0) {
      disclosures.push({ code: 'CGT_LOSS_CARRIED', params: { amount: newLosses } });
    }

    const total = byPerson.reduce((sum, person) => sum + person.tax, 0);
    return { lines, disclosures, outcome: { disposals: records, byPerson, total } };
  }
});
