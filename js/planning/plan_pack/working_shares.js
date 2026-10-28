import { hasOwnerConfirmedNone } from '../profile.js';
import { PlanPackError } from './schema.js';

function missing(path, message) { throw new PlanPackError(path, message, 'missing_information'); }
function amount(value, path) {
  if (!value || value.currency !== 'EUR' || !Number.isFinite(value.amount)) missing(path, 'A stated EUR amount is required; no currency conversion or missing value is inferred.');
  return value.amount;
}
export function people(profile) { return [profile.primaryPerson, profile.partner].filter(Boolean); }

export function ownerBankPay(profile, personId, { optional = false } = {}) {
  const owned = profile.incomeSources.filter(i => i.ownerIds.includes(personId));
  if (!owned.length) {
    if (hasOwnerConfirmedNone(profile, '/incomeSources', personId) || profile.assumptions.values.completionFacts?.confirmedNonePaths?.['/incomeSources'] === true) return 0;
    missing('/household/incomeSources', 'State income or confirm no income for ' + personId + '; an absent record does not establish zero bank pay.');
  }
  if (owned.some(i => i.ownerIds.length !== 1 || !i.netAnnual)) {
    if (optional) return null;
    missing('/household/incomeSources', 'Per-person bank take-home is missing or jointly owned. It is not inferred from gross income or split between people.');
  }
  return owned.reduce((sum, i) => sum + amount(i.netAnnual, '/household/incomeSources/' + profile.incomeSources.indexOf(i) + '/netAnnual'), 0);
}
// Each person's share of annual left over follows their bank take-home and
// stops funding goals from their own retirement year.
export function planWorkingShares(pack, profile, takeHomeByPerson) {
  const year = Number(pack.calculationDate.slice(0, 4));
  const members = people(profile);
  const pay = Object.fromEntries(members.map(p => [p.personId, members.length === 1 ? null : takeHomeByPerson?.[p.personId] ?? ownerBankPay(profile, p.personId)]));
  const total = Object.values(pay).reduce((sum, value) => sum + value, 0);
  return members.map(person => {
    const share = members.length === 1 ? 1 : total > 0 ? pay[person.personId] / total : 0;
    const working = share > 0 && person.employmentStatus !== 'retired';
    if (working && !Number.isInteger(person.intendedRetirementAge)) {
      missing('/household/' + (person === profile.partner ? 'partner' : 'primaryPerson') + '/intendedRetirementAge',
        'State when ' + person.personId + ' intends to retire; their share of annual left over stops funding goals from that year.');
    }
    // Someone already retired keeps their share: today's left over already comes from retirement income.
    const offset = working ? person.intendedRetirementAge - person.age : null;
    return { personId: person.personId, takeHome: pay[person.personId], share, stopsFromOffset: offset, stopsFromYear: offset === null ? null : year + offset };
  });
}
