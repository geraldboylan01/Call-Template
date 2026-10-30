import { cloneJson } from '../utils.js';
import { walkSession, wireDraft, withoutTargetFunding, upsert, cashChoice, moveChoice, availableAt, goalOutcome, prefix, meets, refusal, RETIREMENT_GOALS, METHOD_ORDER } from './walk_session.js';
import { amount, cents, minimum, pensionMembers, contributions } from './walk_search.js';
import { findBalancingMoves } from './balancing_moves.js';
import { inefficiencyFirst } from './debt_efficiency.js';

/** One goal at its ledger point. Every choice carries the exact wire draft and
 * the complete priceRoute result; callers cannot mistake a prefix for a plan.
 */
export async function goalWays(compiledPlan, routeDraft, goalId, execution = {}) {
  try {
    const session = walkSession(compiledPlan, execution);
    const start = await inefficiencyFirst(session, wireDraft(routeDraft));
    return await goalWaysInSession(session, start.draft, goalId);
  }
  catch (error) { return { status: 'refused', goalId, ways: [], levers: [], refusals: [refusal(error)] }; }
}
export async function goalWaysInSession(session, routeDraft, goalId, { searchLevers = true } = {}) {
  const pack = session.pack, goal = pack.household.goals.find(goal => goal.goalId === goalId);
  if (!goal || ['paused', 'completed'].includes(goal.status)) return { status: 'refused', goalId, ways: [], levers: [],
    refusals: [{ path: '/goalId', code: 'invalid_input', message: 'Name an active household funding goal.' }] };
  const draft = withoutTargetFunding(pack, routeDraft, goalId);
  const base = await session.fast(draft);
  if (!base.ledger) return { status: 'refused', goalId, ways: [], levers: [], refusals: base.refusals };
  const funding = base.ledger.goalFunding.find(row => row.goalId === goalId);
  if (!funding) return { status: 'refused', goalId, ways: [], levers: [],
    refusals: [{ path: '/household/goals/' + pack.household.goals.indexOf(goal), code: 'not_a_funding_goal',
      message: 'This goal is not a funding stage. The reserve is protected before the walk; protection needs its separate priced contract.' }] };
  const available = availableAt(base.ledger, goalId), ways = [], refusals = [];
  const add = async (kind, choice, why, extra = {}) => {
    const priced = await session.price(choice);
    ways.push({ kind, why, ...extra, route: cloneJson(choice), pricing: priced, ...goalOutcome(priced, goalId) });
    return ways.at(-1);
  };
  const unavailable = (kind, path, message) => ways.push({ kind, status: 'unavailable', route: null, pricing: null, meetsGoalOnTime: false,
    refusals: [{ path, code: 'missing_information', message }] });
  const surplus = await add(funding.kind === 'retirement' ? 'extra_contributions' : 'surplus', draft,
    funding.kind === 'retirement' ? 'The pension engine searches recurring personal contributions after relief, preserving each person’s date and limit.'
      : 'Use the goal engine’s yearly funding requirement after prior commitments.');
  if (funding.kind !== 'retirement') {
    await add('lump_sum', funding.wholeCash > 0 ? upsert(draft, cashChoice(pack, goalId, 'whole')) : draft,
      funding.kind === 'debt' ? 'The native lump sum that retains today’s repayment and reaches the goal age.' : 'The native amount needed now for this dated cost.');
    const mix = amount(cents(Math.min(available.spareCash, (funding.wholeCash ?? 0) / 2)));
    if (mix > 0) await add('mix', upsert(draft, cashChoice(pack, goalId, mix, 'Illustrate part of the native lump-sum need, retaining cash for the remaining walk')),
      'Illustrate part cash and part yearly funding; the engine reprices the remaining requirement.', { illustrationBasis: 'Half the engine-priced cash need, capped by uncommitted cash, to illustrate both funding sources.' });
    else unavailable('mix', '/planningInputs/cashAssetId', 'No uncommitted cash is available for a mixed funding choice.');
    if (goal.type === 'optimise_mortgage') await add('term_to_goal_age', draft,
      'The existing mortgage engine sets the repayment term to the goal’s age. With this target, the higher-repayment and term-to-age descriptions are the same choice.',
      { equivalentTo: 'surplus', engineInput: base.ledger.pricing.find(row => row.goalId === goalId).input });
  } else {
    const members = pensionMembers(pack, base.ledger, goalId);
    const room = members.reduce((sum, member) => sum + member.headroom, 0);
    const maxCash = amount(cents(Math.min(available.spareCash, room)));
    const native = base.ledger.pricing.find(row => row.goalId === goalId).priced;
    if (native.onTrackAtToday) {
      await add('money_now', draft, 'Current contributions already meet the target; no extra one-off contribution is needed.', { equivalentTo: 'extra_contributions', requiredOneOffGross: 0 });
      await add('mix', draft, 'No extra one-off or recurring contribution is needed for this target.', { equivalentTo: 'extra_contributions' });
    } else if (members.length && maxCash > 0) {
      const projected = probe => (probe.ledger?.goalFunding.find(row => row.goalId === goalId)?.projectedPotGap ?? Infinity) <= 0.005;
      const makeCash = value => contributions(pack, draft, members, amount(value));
      const selected = await minimum(session, makeCash, 1, cents(maxCash), projected);
      await add('money_now', selected?.draft ?? makeCash(cents(maxCash)),
        'Pay a gross personal contribution from savings today. The native engine applies this year’s relief and grows the contribution once; the annual tax estimate credits relief in this year, not as immediate cash.',
        { requiredOneOffGross: selected ? amount(selected.value) : null, maximumAvailableGross: maxCash,
          allocationBasis: 'In proportion to each named member’s available personal relief room; no tax-ranking claim.' });
      // This is an explicit example of a mixed choice, not a claim of a global
      // optimum over a household's tax allocations or account preferences.
      const cash = amount(cents(maxCash / 2)), annualRoom = amount(cents(room - cash));
      const makeMix = value => contributions(pack, draft, members, cash, amount(value));
      const recurring = cash > 0 ? await minimum(session, makeMix, 1, cents(annualRoom), projected) : null;
      if (cash > 0) await add('mix', recurring?.draft ?? makeMix(cents(annualRoom)),
        'Illustrate one-off cash plus the smallest recurring increase in the remaining relief room that reaches the pension target, if one does.',
        { oneOffGross: cash, allocationBasis: 'Half the available cash/relief budget is the bounded illustration; remaining room follows the same declared per-member split.' });
      else unavailable('mix', '/household/assets', 'There is no positive cash amount for this mixed illustration.');
    } else {
      unavailable('money_now', members.length ? '/household/assets' : '/household/pensions', 'Establish available cash and an earning member with an active contributory pension and current relief headroom.');
      unavailable('mix', '/household/pensions', 'A mixed personal contribution needs the same active pension, cash and relief facts.');
    }
    for (const field of ['retirementAge', 'targetIncomeToday']) {
      const range = pack.goalFlexibility[goalId]?.[field];
      const kind = field === 'retirementAge' ? 'later_age' : 'lower_target';
      if (!range) { unavailable(kind, `/goalFlexibility/${goalId}/${field}`, 'State this flexibility before illustrating a changed goal.'); continue; }
      if (field === 'retirementAge') {
        const binding = pack.planningInputs.goalBindings.find(binding => binding.goalId === goalId);
        const people = [base.context.profile.primaryPerson, base.context.profile.partner].filter(Boolean);
        const person = people.find(person => person.personId === binding?.personId) ?? (people.length === 1 ? people[0] : null);
        if (!person) { unavailable(kind, '/planningInputs/goalBindings', 'Name the person whose retirement age this goal changes.'); continue; }
        const value = Math.max(range[0], person.intendedRetirementAge + 1);
        if (value > range[1]) { unavailable(kind, `/goalFlexibility/${goalId}/${field}`, 'No later age is inside this stated range.'); continue; }
        await add(kind, upsert(draft, moveChoice(pack, goalId, field, value)), 'Price the first later age inside the stated flexibility.');
      } else {
        const value = Math.min(range[1], goal.targetAmount.amount - 0.01);
        if (value < range[0]) { unavailable(kind, `/goalFlexibility/${goalId}/${field}`, 'No lower target is inside this stated range.'); continue; }
        await add(kind, upsert(draft, moveChoice(pack, goalId, field, Math.round(value * 100) / 100)), 'Price the first lower target, to the cent, inside stated flexibility.');
      }
    }
  }
  const balancing = searchLevers && !meets(base.ledger, prefix(base.ledger, goalId))
    ? await findBalancingMoves(session, draft, { goalId }) : { moves: [], refusals: [] };
  refusals.push(...balancing.refusals);
  return { status: 'priced', goalId, methodOrder: METHOD_ORDER, goalOrder: base.ledger.goalOrder, available,
    stages: { reserve: 'protected_by_the_ledger', protection: pack.chapters.includes('protection_gap') ? 'separate_priced_chapter' : 'requires_separate_protection_contract' },
    ways, levers: balancing.moves, refusals, scope: 'Earlier commitments and this goal; each pricing result also discloses the whole-route outcome.' };
}
