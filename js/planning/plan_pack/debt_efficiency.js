import { cloneJson } from '../utils.js';
import { PLANEIR_ASSUMPTIONS } from '../planeir_assumptions.js';
import { resolveTaxRules } from '../tax/resolve.js';

function cashRateAfterTax(date) {
  return PLANEIR_ASSUMPTIONS.cash.instantAccessGrossRate * (1 - resolveTaxRules(Number(date.slice(0, 4))).dirt.rate);
}

/** The same comparison as idle_cash_vs_debt, restricted to loans and cards.
 * Unknown balances/rates never become a zero or an invented ordering. */
function dearDebts(pack, spareCash) {
  const rate = cashRateAfterTax(pack.calculationDate);
  return spareCash > 0 ? pack.household.liabilities.filter(debt => ['loan', 'credit_card'].includes(debt.type)
    && debt.currentBalance?.currency === 'EUR' && debt.currentBalance.amount > 0 && debt.annualInterestRate > rate)
    .sort((a, b) => b.annualInterestRate - a.annualInterestRate || a.liabilityId.localeCompare(b.liabilityId)) : [];
}

export function clearance(pack, debt) {
  const index = pack.planningInputs.outgoingBindings.findIndex(binding => binding.liabilityId === debt.liabilityId);
  if (index < 0) return null;
  return { type: 'clearOutgoing', outgoingId: pack.planningInputs.outgoingBindings[index].id, paidFrom: 'savings', sources: {
    outgoingId: { kind: 'fact', path: `/planningInputs/outgoingBindings/${index}/id` },
    paidFrom: { kind: 'default', path: '/routes/clearOutgoingPaidFrom', version: PLANEIR_ASSUMPTIONS.version }
  } };
}

/** Put the clearance before goal funding. Reprice whole/remaining instructions;
 * cap literal assignments only when the earlier clearance needs their cash. */
async function beforeGoals(session, draft, debt) {
  const change = clearance(session.pack, debt);
  if (!change) return null;
  const fundedDebtGoals = session.pack.planningInputs.goalBindings.filter(binding => binding.liabilityId === debt.liabilityId).map(binding => binding.goalId);
  const next = cloneJson(draft);
  next.changes = next.changes.filter(row => !(row.type === 'useCash' && fundedDebtGoals.includes(row.goalId)));
  next.changes.unshift(change);
  const cash = next.changes.filter(row => row.type === 'useCash');
  const pensions = next.changes.filter(row => row.type === 'pensionContribution' && row.oneOffAmount);
  next.changes = next.changes.filter(row => row.type !== 'useCash').flatMap(row => {
    if (row.type !== 'pensionContribution' || !row.oneOffAmount) return [row];
    if (!row.annualAmount) return [];
    const annual = cloneJson(row); delete annual.oneOffAmount; if (annual.sources) delete annual.sources.oneOffAmount;
    return [annual];
  });
  const opening = await session.fast(next);
  if (!opening.ledger?.reserveProtected) return null;
  let left = Math.max(0, opening.ledger.spareCashRemaining);
  for (const id of opening.ledger.goalOrder) for (const row of cash.filter(row => row.goalId === id)) {
    const probe = await session.fast(next), quote = probe.ledger?.goalFunding.find(goal => goal.goalId === id);
    const wanted = row.amount === 'whole' ? quote?.wholeCash : row.amount === 'remaining' ? quote?.maximumCash : row.amount;
    const amount = Math.floor(Math.min(left, wanted ?? 0) * 100 + 1e-7) / 100;
    if (amount > 0) {
      const unchanged = typeof row.amount === 'number' ? row.amount <= left : wanted <= left;
      const path = '/household/goals/' + session.pack.household.goals.findIndex(goal => goal.goalId === id);
      next.changes.push(unchanged ? row : { ...row, amount, sources: { goalId: { kind: 'fact', path: path + '/goalId' }, ...row.sources, amount: {
        kind: 'bounded', reason: `Use the cash left after earlier debt clearances (${path}).`, factPaths: [path]
      } } });
      left -= unchanged ? wanted : amount;
    }
  }
  // Retirement cash comes after the earlier goals too. A contribution is
  // reduced only in this counterfactual; the caller keeps it if any previously
  // covered goal would become short after the native pension repricing.
  for (const row of pensions) {
    const value = Math.min(row.oneOffAmount, Math.floor(left * 100 + 1e-7) / 100);
    if (value <= 0) continue;
    const source = { kind: 'bounded',
      reason: 'Use retirement cash left after debt clearances (/household/pensions).', factPaths: ['/household/pensions'] };
    const personPath = session.pack.household.primaryPerson.personId === row.personId ? '/household/primaryPerson/personId' : '/household/partner/personId';
    const restored = value === row.oneOffAmount ? row : { ...row, oneOffAmount: value, sources: {
      personId: { kind: 'fact', path: personPath }, ...(row.annualAmount ? { annualAmount: source } : {}), ...row.sources, oneOffAmount: source
    } };
    const index = next.changes.findIndex(change => change.type === 'pensionContribution' && change.personId === row.personId);
    if (index >= 0) next.changes[index] = restored; else next.changes.push(restored);
    left -= value;
  }
  return next;
}

function lostGoals(before, after) {
  return (before?.goals ?? []).filter(goal => goal.state === 'covered'
    && (!after?.reserveProtected || after.goals.find(row => row.goalId === goal.goalId)?.state !== 'covered')).map(goal => goal.goalId);
}

/** Every walk starts here, including a walk that keeps cash for later goals.
 * Each debt is tested against the completed walk, so an on-time goal is never
 * sacrificed merely to improve the borrowing/cash-rate comparison. */
export async function inefficiencyFirst(session, draft, { finish = async route => ({ draft: route, refusals: [] }) } = {}) {
  const opening = await session.fast({ id: draft.id, changes: [] });
  const supplied = await session.fast(draft);
  const spare = Math.max(opening.ledger?.cashAvailableAfterReserve ?? 0, supplied.ledger?.cashAvailableAfterReserve ?? 0);
  let next = cloneJson(draft);
  for (const debt of dearDebts(session.pack, spare)) {
    const base = await session.fast(next);
    const binding = clearance(session.pack, debt);
    if (!base.ledger || next.changes.some(row => row.type === 'clearOutgoing' && row.outgoingId === binding?.outgoingId)
      || base.ledger.propertyMove?.debts.some(row => row.liabilityId === debt.liabilityId && row.balance > 0)) continue;
    if (debt.earlyRepaymentAllowed === false) continue;
    const trial = await beforeGoals(session, next, debt);
    if (!trial) continue;
    const before = await finish(next), after = await finish(trial);
    const beforeProbe = await session.fast(before.draft), afterProbe = await session.fast(after.draft);
    if (afterProbe.ledger?.reserveProtected && !lostGoals(beforeProbe.ledger, afterProbe.ledger).length) next = trial;
  }
  // clearOutgoing is method-ordered even when an existing draft supplied one.
  const order = dearDebts(session.pack, spare).map(debt => clearance(session.pack, debt)?.outgoingId);
  next.changes.sort((a, b) => {
    const ai = a.type === 'clearOutgoing' ? order.indexOf(a.outgoingId) : -1, bi = b.type === 'clearOutgoing' ? order.indexOf(b.outgoingId) : -1;
    return ai >= 0 && bi >= 0 ? ai - bi : ai >= 0 ? -1 : bi >= 0 ? 1 : 0;
  });
  return finish(next);
}

/** Code-owned decisions for retained routes. Pricing stays literal: it reports
 * an omitted clearance rather than silently rewriting the submitted route. */
export async function debtDecisions(pack, draft, ledger, currentLedger, session) {
  const decisions = [];
  for (const debt of dearDebts(pack, Math.max(currentLedger?.cashAvailableAfterReserve ?? 0, ledger.cashAvailableAfterReserve))) {
    const binding = clearance(pack, debt), index = pack.household.liabilities.indexOf(debt);
    const path = `/household/liabilities/${index}`;
    const cleared = draft.changes.some(change => change.type === 'clearOutgoing' && change.outgoingId === binding?.outgoingId);
    const sold = ledger.propertyMove?.debts.some(row => row.liabilityId === debt.liabilityId && row.balance > 0);
    let code = cleared ? 'cleared_from_spare_cash' : sold ? 'repaid_by_property_sale' : 'not_cleared';
    let goalIds = [];
    if (!cleared && !sold) {
      if (debt.earlyRepaymentAllowed === false) code = 'recorded_terms_prevent_clearance';
      else if (!binding) code = 'missing_outgoing_binding';
      else {
        const trial = await beforeGoals(session, draft, debt);
        const after = trial && await session.fast(trial);
        goalIds = lostGoals(ledger, after?.ledger);
        if (!trial || !after?.ledger?.reserveProtected) code = 'insufficient_spare_cash';
        else if (goalIds.length) code = 'protects_on_time_goal';
      }
    }
    const retained = !cleared && !sold;
    const comparedAmount = retained ? Math.min(Math.max(0, ledger.spareCashRemaining), debt.currentBalance.amount) : 0;
    const yearlyCost = debt.currentBalance.amount * debt.annualInterestRate;
    const label = debt.label;
    const reason = {
      cleared_from_spare_cash: `${label} is cleared from spare cash before the goals, dearest borrowing rate first.`,
      repaid_by_property_sale: `The property sale repays ${label} from its proceeds.`,
      recorded_terms_prevent_clearance: `${label} is left running because its recorded terms do not allow early repayment.`,
      missing_outgoing_binding: `${label} is left running because its outgoing has no recorded clearance binding.`,
      insufficient_spare_cash: `${label} is left running because available spare cash cannot cover its balance while protecting the reserve and existing commitments.`,
      protects_on_time_goal: `${label} is left running because clearing it would leave an otherwise on-time goal short: ${goalIds.map(id => pack.household.goals.find(goal => goal.goalId === id)?.title ?? id).join(', ')}.`,
      not_cleared: `${label} is not cleared in this route. Its annual interest at the recorded balance is ${yearlyCost.toFixed(2)} euro.`
    }[code];
    decisions.push({ liabilityId: debt.liabilityId, label, path, code, reason, goalIds, retained, yearlyCost,
      repaymentsStopped: cleared ? debt.monthlyPayment.amount * 12 : 0,
      ...(cleared ? { clearanceYear: Number(pack.calculationDate.slice(0, 4)) } : {}),
      spareCash: Math.max(0, ledger.spareCashRemaining), comparedAmount, yearlyDifference: comparedAmount * (debt.annualInterestRate - cashRateAfterTax(pack.calculationDate)) });
  }
  return decisions;
}

export const debtNotes = ledger => (ledger?.debtDecisions ?? []).filter(row => row.retained && row.spareCash > 0.005)
  .map(row => ({ code: 'idle_cash_vs_debt_retained', path: row.path, reasonCode: row.code, message: row.reason,
    factKey: 'inefficiencies.' + row.liabilityId + '.reason', yearlyCost: row.yearlyCost, yearlyDifference: row.yearlyDifference }));
