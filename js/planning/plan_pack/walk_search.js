import { PLANEIR_ASSUMPTIONS } from '../planeir_assumptions.js';
import { maxRelievablePersonalContribution } from '../../pension_math.js';
import { NON_CONTRIBUTORY_PENSION_TYPES } from '../profile.js';
import { cloneJson } from '../utils.js';
import { bounded, fact, upsert, cashChoice } from './walk_session.js';

export const cents = amount => Math.floor(Math.max(0, amount) * 100 + 1e-7);
export const amount = minor => minor / 100;
export function removeChange(draft, test) { return { ...cloneJson(draft), changes: cloneJson(draft.changes.filter(change => !test(change))) }; }
export async function minimum(session, make, low, high, predicate) {
  if (high < low) return null;
  const upper = await session.fast(make(high));
  if (!predicate(upper)) return null;
  let selected = { draft: make(high), probe: upper, value: high };
  while (low <= high) {
    const mid = Math.floor((low + high) / 2), draft = make(mid), probe = await session.fast(draft);
    if (predicate(probe)) { selected = { draft, probe, value: mid }; high = mid - 1; } else low = mid + 1;
  }
  return selected;
}
export async function maximum(session, make, low, high, predicate) {
  if (high < low) return null;
  const lower = await session.fast(make(low));
  if (!predicate(lower)) return null;
  let selected = { draft: make(low), probe: lower, value: low };
  while (low <= high) {
    const mid = Math.floor((low + high) / 2), draft = make(mid), probe = await session.fast(draft);
    if (predicate(probe)) { selected = { draft, probe, value: mid }; low = mid + 1; } else high = mid - 1;
  }
  return selected;
}

export function pensionMembers(pack, ledger, goalId) {
  const quote = ledger.pricing.find(quote => quote.goalId === goalId);
  if (quote?.kind !== 'retirement') return [];
  return quote.input.pensions.flatMap(member => {
    if (!pack.household.pensions.some(pension => pension.ownerId === member.id && pension.contributionStatus === 'active' && !NON_CONTRIBUTORY_PENSION_TYPES.includes(pension.type))) return [];
    const before = quote.priced.costsToday.years[0]?.members.find(row => row.id === member.id)?.gross;
    if (!Number.isFinite(before) || !(member.currentSalary > 0) || member.currentAge >= member.retirementAge) return [];
    const cap = maxRelievablePersonalContribution(member.currentAge, member.currentSalary) - before;
    const personPath = pack.household.primaryPerson.personId === member.id ? '/household/primaryPerson/personId' : '/household/partner/personId';
    const salaryIndex = pack.household.incomeSources.findIndex(income => income.ownerIds.includes(member.id) && income.grossAnnual && income.type === 'employment');
    return [{ personId: member.id, headroom: amount(cents(cap)), personPath,
      factPath: salaryIndex >= 0 ? `/household/incomeSources/${salaryIndex}/grossAnnual` : '/household/pensions' }];
  });
}
/** A declared funding illustration, not a tax optimisation: distribute a total
 * gross increase in proportion to the named members' remaining relief room.
 * Tax, cap, accumulation and retirement coverage are always engine-priced.
 */
export function contributions(pack, draft, members, totalOnce, totalAnnual = 0) {
  const split = (total, rooms) => {
    const sum = rooms.reduce((a, b) => a + b, 0), result = rooms.map(room => sum ? Math.min(room, Math.floor(total * room / sum)) : 0);
    let left = total - result.reduce((a, b) => a + b, 0);
    for (let i = 0; i < rooms.length && left > 0; i++) { const add = Math.min(left, rooms[i] - result[i]); result[i] += add; left -= add; }
    return result;
  };
  const rooms = members.map(member => cents(member.headroom));
  const once = split(cents(totalOnce), rooms), yearly = split(cents(totalAnnual), rooms.map((room, i) => room - once[i]));
  let next = cloneJson(draft);
  for (let i = 0; i < members.length; i++) {
    if (!once[i] && !yearly[i]) continue;
    const member = members[i];
    next = upsert(next, { type: 'pensionContribution', personId: member.personId,
      ...(once[i] ? { oneOffAmount: amount(once[i]) } : {}), ...(yearly[i] ? { annualAmount: amount(yearly[i]) } : {}),
      sources: { personId: fact(member.personPath),
        ...(once[i] ? { oneOffAmount: bounded(member.factPath, 'Distribute the chosen cash budget in proportion to remaining personal relief room') } : {}),
        ...(yearly[i] ? { annualAmount: bounded(member.factPath, 'Search recurring gross contributions within the remaining personal relief room') } : {}) } });
  }
  return next;
}

/** Commit literal cash amounts step by step. A later choice never steals a
 * previous goal's unresolved "remaining" instruction. All amounts are priced
 * again after each step; existing cash assignments are never counted twice.
 */
export async function cashWalk(session, draft) {
  let next = cloneJson(draft), initial = await session.fast(next);
  if (!initial.ledger) return { draft: next, refusals: initial.refusals };
  for (const goalId of initial.ledger.goalOrder) {
    const probe = await session.fast(next);
    if (!probe.ledger) return { draft: next, refusals: probe.refusals };
    const quote = probe.ledger.goalFunding.find(goal => goal.goalId === goalId);
    if (!(quote?.wholeCash > 0)) continue;
    const cash = Math.min(quote.maximumCash, quote.wholeCash, quote.cashAllocated + Math.max(0, probe.ledger.spareCashRemaining));
    if (cash <= quote.cashAllocated + 0.005) continue;
    const setting = cash >= quote.wholeCash - 0.005 ? 'whole' : amount(cents(cash));
    if (typeof setting === 'number' && setting < 0.01) continue;
    next = upsert(next, cashChoice(session.pack, goalId, setting, 'Use the native cash requirement in method order after earlier commitments'));
  }
  return { draft: next, refusals: [] };
}

export function spendCeiling(pack, probe, { ordinary = false } = {}) {
  const essential = pack.household.expenses.monthlyEssential;
  const source = pack.household.fieldMetadata['/expenses/monthlyEssential']?.application;
  if (!essential || essential.currency !== 'EUR' || source?.paths?.includes('spending.spend')) throw Object.assign(new Error('Establish stated essential spending before searching a spending cut.'), { path: '/household/expenses/monthlyEssential', code: 'missing_information' });
  const total = pack.household.expenses.annualTotal.amount;
  let eliminated = pack.household.liabilities.filter(debt => probe.context.profile.liabilities.find(row => row.liabilityId === debt.liabilityId)?.currentBalance?.amount === 0)
    .reduce((sum, debt) => sum + (debt.monthlyPayment?.amount ?? 0) * 12, 0);
  const move = probe.ledger.propertyMove;
  if (move) eliminated += (move.rental?.running ?? 0) + (move.offset > 0 ? move.debts.reduce((sum, debt) => sum + debt.annualPayment, 0) : 0);
  return Math.max(0, Math.min(total - 12 * essential.amount - eliminated,
    ordinary ? total * PLANEIR_ASSUMPTIONS.routes.spendLess.ordinaryFractionOfAnnualSpending : Infinity));
}
