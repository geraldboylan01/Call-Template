import { PLANEIR_ASSUMPTIONS } from '../planeir_assumptions.js';
import { classifyLever } from './lever_catalogue.js';
import { sizeMajorMove } from './major_move_search.js';
import { bounded, fact, upsert, moveChoice, cashChoice, meets, prefix, refusal, walkSession } from './walk_session.js';
import { amount, cents, minimum, maximum, pensionMembers, cashWalk, spendCeiling } from './walk_search.js';

export async function findBalancingMoves(session, draft, { goalId, ordinaryOnly = false, includeMajor = true } = {}) {
  const base = await session.fast(draft), moves = [], refusals = [], failed = [];
  if (!base.ledger) return { status: 'refused', moves, refusals: base.refusals };
  const ids = goalId ? prefix(base.ledger, goalId) : undefined;
  const ok = probe => meets(probe.ledger, ids);
  if (ok(base)) return { status: 'not_needed', moves, refusals, scope: ids ?? base.ledger.goalOrder };
  const add = async (kind, candidate, minimumSetting, why) => {
    if (!candidate) { failed.push({ kind, reason: 'No setting inside this supported range funds the scoped goals.' }); return; }
    const priced = await session.price(candidate.draft ?? candidate);
    if (!meets(priced.ledger, ids) || (!goalId && priced.status !== 'compiled')) {
      refusals.push(...priced.refusals); failed.push({ kind, reason: 'The full compiler did not confirm this candidate.' }); return;
    }
    const changes = priced.routeDraft.changes;
    const scale = changes.some(change => classifyLever(session.pack, change).scale === 'major') ? 'major' : 'ordinary';
    if (ordinaryOnly && scale === 'major') return;
    moves.push({ kind, scale, minimum: minimumSetting, why, route: priced.routeDraft, pricedRoute: priced });
  };
  const pack = session.pack;
  const goals = goalId ? [goalId] : base.ledger.goalOrder;
  for (const id of goals) {
    const funding = base.ledger.goalFunding.find(goal => goal.goalId === id);
    if (!funding) continue;
    if (funding.maximumCash > 0) {
      const limit = Math.min(funding.maximumCash, funding.cashAllocated + Math.max(0, base.ledger.spareCashRemaining));
      const make = value => upsert(draft, cashChoice(pack, id, amount(value), 'Find the smallest cash allocation that funds the scoped goals'));
      const selected = await minimum(session, make, Math.max(1, cents(funding.cashAllocated)), cents(limit), ok);
      await add('useCash:' + id, selected, selected ? { amount: amount(selected.value), unit: 'EUR', step: 0.01 } : null,
        'Use only the cash needed to remove the funding shortfall, inside the opening reserve.');
    }
    const goal = base.context.profile.goals.find(goal => goal.goalId === id);
    const flex = pack.goalFlexibility[id];
    if (!flex) { refusals.push({ path: '/goalFlexibility/' + id, code: 'missing_information', message: 'Goal moves need stated flexibility; no range is invented.' }); continue; }
    for (const [field, range] of Object.entries(flex)) {
      if (['retirementAge', 'clearByAge'].includes(field)) {
        const binding = pack.planningInputs.goalBindings.find(binding => binding.goalId === id);
        const people = [base.context.profile.primaryPerson, base.context.profile.partner].filter(Boolean);
        const person = people.find(person => person.personId === binding?.personId) ?? (people.length === 1 ? people[0] : null);
        if (!person) { refusals.push({ path: '/planningInputs/goalBindings', code: 'missing_information', message: 'Name the person whose age this goal uses.' }); continue; }
        const current = field === 'retirementAge' ? person.intendedRetirementAge : person.age + funding.startsInYears;
        let selected = null;
        for (let value = Math.max(current + 1, range[0]); value <= range[1]; value++) {
          const candidate = upsert(draft, moveChoice(pack, id, field, value));
          if (ordinaryOnly && candidate.changes.some(change => classifyLever(pack, change).scale === 'major')) continue;
          if (ok(await session.fast(candidate))) { selected = { draft: candidate, value }; break; }
        }
        await add('moveGoal:' + id + ':' + field, selected, selected ? { value: selected.value, difference: selected.value - current, unit: 'years', step: 1 } : null,
          'The first allowed later age that funds the scoped goals, using the existing goal engine.');
      } else if (field === 'targetDate') {
        const current = goal.targetDate ?? `${Number(pack.calculationDate.slice(0, 4)) + funding.startsInYears}-01-01`;
        let selected = null;
        for (let year = Number(current.slice(0, 4)) + 1; year <= Number(range[1].slice(0, 4)); year++) {
          const value = `${year}-01-01` < range[0] ? range[0] : `${year}-01-01`;
          if (value > range[1] || value <= current) continue;
          const candidate = upsert(draft, moveChoice(pack, id, field, value));
          if (ok(await session.fast(candidate))) { selected = { draft: candidate, value }; break; }
        }
        await add('moveGoal:' + id + ':targetDate', selected, selected ? { value: selected.value, from: current, unit: 'calendar_date' } : null,
          'The earliest permitted calendar-year boundary that removes the shortfall; native dated-cost pricing uses whole years.');
      } else {
        const current = goal.targetAmount?.amount;
        if (!Number.isFinite(current)) { refusals.push({ path: '/household/goals/' + pack.household.goals.findIndex(row => row.goalId === id) + '/targetAmount', code: 'missing_information', message: 'State the target before searching a reduction.' }); continue; }
        const selected = await maximum(session, value => upsert(draft, moveChoice(pack, id, field, amount(value))),
          Math.max(1, cents(range[0])), Math.min(cents(current), cents(range[1])), ok);
        await add('moveGoal:' + id + ':' + field, selected, selected ? { value: amount(selected.value), difference: current - amount(selected.value), unit: 'EUR', step: 0.01 } : null,
          'The highest target inside stated flexibility that funds the scoped goals.');
      }
    }
  }
  try {
    const upper = cents(spendCeiling(pack, base, { ordinary: ordinaryOnly }));
    const make = value => upsert(draft, { type: 'spendLess', annualAmount: amount(value), sources: { annualAmount: bounded('/household/expenses/annualTotal', 'Search the smallest reduction above the stated essential floor') } });
    const selected = await minimum(session, make, 1, upper, ok);
    await add('spendLess', selected, selected ? { annualAmount: amount(selected.value), unit: 'EUR/year', step: 0.01 } : null,
      'The smallest cut whose native ledger funds every scoped goal; the essential floor and major boundary still apply.');
  } catch (error) { refusals.push(refusal(error)); }
  for (const binding of pack.planningInputs.outgoingBindings) {
    if (draft.changes.some(change => change.type === 'clearOutgoing' && change.outgoingId === binding.id)) continue;
    const index = pack.planningInputs.outgoingBindings.indexOf(binding);
    const candidate = upsert(draft, { type: 'clearOutgoing', outgoingId: binding.id, paidFrom: 'savings', sources: { outgoingId: fact(`/planningInputs/outgoingBindings/${index}/id`),
      paidFrom: { kind: 'default', path: '/routes/clearOutgoingPaidFrom', version: PLANEIR_ASSUMPTIONS.version } } });
    const probe = await session.fast(candidate);
    if (ok(probe)) await add('clearOutgoing:' + binding.id, candidate, { liabilityId: binding.liabilityId, basis: 'full_balance_only' }, 'Clear the recorded balance once and reuse its stopped repayments.');
    else refusals.push(...probe.refusals);
  }
  for (const [index, asset] of pack.household.assets.entries()) {
    if (asset.type !== 'investment' || !(asset.currentValue?.amount > 0) || draft.changes.some(change => change.type === 'sellAsset' && change.assetId === asset.assetId)) continue;
    const sold = upsert(draft, { type: 'sellAsset', assetId: asset.assetId, sources: { assetId: fact(`/household/assets/${index}/assetId`) } });
    const allocated = await cashWalk(session, sold), probe = await session.fast(allocated.draft);
    if (ok(probe)) await add('sellAsset:' + asset.assetId, allocated.draft, { assetId: asset.assetId, basis: 'whole_holding_only' }, 'Price the whole holding through tax, then commit the proceeds in method order.');
    else refusals.push(...allocated.refusals, ...probe.refusals);
  }
  const retirement = goals.find(id => base.ledger.goalFunding.find(goal => goal.goalId === id)?.kind === 'retirement');
  if (retirement) for (const member of pensionMembers(pack, base.ledger, retirement)) {
    for (const key of ['annualAmount', 'oneOffAmount']) {
      const committed = draft.changes.find(change => change.type === 'pensionContribution' && change.personId === member.personId);
      const other = committed?.[key === 'annualAmount' ? 'oneOffAmount' : 'annualAmount'] ?? 0;
      const upper = Math.min(cents(member.headroom - other), key === 'oneOffAmount'
        ? cents(Math.max(0, base.ledger.spareCashRemaining + (committed?.oneOffAmount ?? 0))) : Infinity);
      const make = value => upsert(draft, { type: 'pensionContribution', personId: member.personId, [key]: amount(value),
        sources: { personId: fact(member.personPath), [key]: bounded(member.factPath, 'Search inside the named person’s personal relief room') } });
      const projected = probe => (probe.ledger?.goalFunding.find(goal => goal.goalId === retirement)?.projectedPotGap ?? Infinity) <= 0.005;
      const selected = await minimum(session, make, 1, upper, key === 'annualAmount' ? projected : ok);
      if (selected && ok(selected.probe)) await add('pensionContribution:' + member.personId + ':' + key, selected,
        { [key]: amount(selected.value), personId: member.personId, unit: 'EUR', step: 0.01 }, 'The smallest named contribution in the supported funding contract, priced after relief.');
    }
  }
  if (includeMajor && !ordinaryOnly && !draft.changes.some(change => classifyLever(pack, change).scale === 'major')) {
    const majorTypes = [{ type: 'tradeDownHome' }, ...pack.household.properties.filter(property => property.use !== 'home').map(property => ({ type: 'sellProperty', propertyId: property.propertyId }))];
    for (const options of majorTypes) {
      const sized = await sizeMajorMove(pack, draft, { ...options, ...(goalId ? { goalIds: ids } : {}) });
      if (sized.status === 'sized') await add(options.type + ':' + (options.propertyId ?? 'home'), sized.route,
        { setting: sized.route.changes.at(-1), bounds: sized.bounds }, 'The smallest major move inside the central bounds that funds the scoped goals.');
      else if (sized.status === 'refused') refusals.push(...sized.refusals);
      else failed.push({ kind: options.type, reason: sized.reason ?? 'No applicable major move.' });
    }
  }
  return { status: moves.length ? 'moves' : 'none', scope: ids ?? base.ledger.goalOrder, moves, refusals, failed,
    basis: 'Each numeric setting is minimised separately, holding the other committed draft choices fixed. Fixed whole-holding and full-clearance levers have no fractional-size contract.' };
}

/** One self-contained priced route is the input, as returned by priceRoute or
 * any goal way. No tool, I/O, global search state, or ranking is involved. */
export async function balancingMoves(pricedRoute) {
  try {
    const session = walkSession(pricedRoute);
    return await findBalancingMoves(session, pricedRoute.routeDraft);
  } catch (error) { return { status: 'refused', moves: [], refusals: [refusal(error)] }; }
}
