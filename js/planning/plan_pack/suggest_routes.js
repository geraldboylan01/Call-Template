import { cloneJson } from '../utils.js';
import { PLANEIR_ASSUMPTIONS } from '../planeir_assumptions.js';
import { classifyLever } from './lever_catalogue.js';
import { walkSession, bounded, fact, upsert, moveChoice, meets, refusal, METHOD_ORDER } from './walk_session.js';
import { cashWalk, spendCeiling, cents, amount, minimum, maximum, removeChange } from './walk_search.js';
import { goalWaysInSession } from './goal_ways.js';
import { findBalancingMoves } from './balancing_moves.js';
import { singleMajorTrials } from './major_policy.js';
import { propertyMoveBounds, PROPERTY_LEVERS } from './property_moves.js';

async function cashFirst(session, start) {
  const result = await cashWalk(session, start);
  const probe = await session.fast(result.draft);
  const retirement = probe.ledger?.goalFunding.find(goal => goal.kind === 'retirement');
  if (retirement && !probe.ledger.pricing.find(goal => goal.goalId === retirement.goalId).priced.onTrackAtToday) {
    const ways = await goalWaysInSession(session, result.draft, retirement.goalId, { searchLevers: false });
    const cash = ways.ways.find(way => way.kind === 'money_now' && way.meetsGoalOnTime)
      ?? ways.ways.find(way => way.kind === 'mix' && way.meetsGoalOnTime);
    if (cash) result.draft = cash.route;
  }
  return result;
}

/** Minimise a feasible combination conditionally, one setting at a time. No
 * economic score or ranking across different human trade-offs is introduced.
 */
async function minimiseOrdinary(session, draft) {
  let next = cloneJson(draft);
  for (const change of [...next.changes].reverse()) {
    const without = removeChange(next, candidate => JSON.stringify(candidate) === JSON.stringify(change));
    if (meets((await session.fast(without)).ledger)) { next = without; continue; }
    if (change.type === 'spendLess') {
      const selected = await minimum(session, value => upsert(next, { ...change, annualAmount: amount(value) }), 1, cents(change.annualAmount), probe => meets(probe.ledger));
      if (selected) next = selected.draft;
    } else if (change.type === 'useCash') {
      const probe = await session.fast(next), value = probe.ledger?.goalFunding.find(goal => goal.goalId === change.goalId)?.cashAllocated;
      if (value) {
        const selected = await minimum(session, minor => upsert(next, { ...change, amount: amount(minor) }), 1, cents(value), probe => meets(probe.ledger));
        if (selected) next = selected.draft;
      }
    } else if (change.type === 'moveGoal') {
      const goal = session.pack.household.goals.find(goal => goal.goalId === change.goalId);
      for (const field of Object.keys(change).filter(field => !['type', 'goalId', 'sources'].includes(field))) {
        const active = next.changes.find(row => row.type === 'moveGoal' && row.goalId === change.goalId);
        if (!active) break;
        const omitted = cloneJson(active); delete omitted[field]; if (omitted.sources) delete omitted.sources[field];
        const rest = removeChange(next, row => row.type === 'moveGoal' && row.goalId === change.goalId);
        const withoutField = Object.keys(omitted).some(key => !['type', 'goalId', 'sources'].includes(key)) ? upsert(rest, omitted) : rest;
        if (meets((await session.fast(withoutField)).ledger)) { next = withoutField; continue; }
        const original = field === 'targetIncomeToday' || field === 'targetAmount' ? goal.targetAmount?.amount : null;
        if (Number.isFinite(original)) {
          const selected = await maximum(session, minor => upsert(next, { ...active, [field]: amount(minor) }), cents(active[field]), cents(original), probe => meets(probe.ledger));
          if (selected) next = selected.draft;
        } else if (['retirementAge', 'clearByAge'].includes(field)) {
          const binding = session.pack.planningInputs.goalBindings.find(row => row.goalId === change.goalId);
          const person = [session.pack.household.primaryPerson, session.pack.household.partner].find(row => row?.personId === binding?.personId)
            ?? (!session.pack.household.partner ? session.pack.household.primaryPerson : null);
          const initial = await session.fast(rest);
          const funding = initial.ledger?.goalFunding.find(row => row.goalId === change.goalId);
          const start = field === 'retirementAge' ? person?.intendedRetirementAge : person && funding ? person.age + funding.startsInYears : null;
          if (start !== null) for (let value = Math.max(start + 1, session.pack.goalFlexibility[change.goalId][field][0]); value <= active[field]; value++) {
            const candidate = upsert(next, { ...active, [field]: value });
            if (meets((await session.fast(candidate)).ledger)) { next = candidate; break; }
          }
        } else if (field === 'targetDate') {
          const range = session.pack.goalFlexibility[change.goalId][field];
          const startYear = Number((goal.targetDate ?? session.pack.calculationDate).slice(0, 4));
          for (let year = startYear + 1; year <= Number(active[field].slice(0, 4)); year++) {
            const value = `${year}-01-01` < range[0] ? range[0] : `${year}-01-01`;
            if (value > active[field]) continue;
            const candidate = upsert(next, { ...active, [field]: value });
            if (meets((await session.fast(candidate)).ledger)) { next = candidate; break; }
          }
        }
      }
    }
  }
  return next;
}

async function ordinaryCombination(session, start) {
  const pack = session.pack, initial = await session.fast(start), refusals = [];
  if (!initial.ledger) return { draft: null, refusals: initial.refusals };
  let structural = cloneJson(start);
  // Finite whole-holding levers have no continuous-size contract. Priceable
  // holdings enter in source order, and cash is then walked in method order.
  for (const [index, asset] of pack.household.assets.entries()) {
    if (asset.type !== 'investment' || !(asset.currentValue?.amount > 0)) continue;
    const sold = upsert(structural, { type: 'sellAsset', assetId: asset.assetId, sources: { assetId: fact(`/household/assets/${index}/assetId`) } });
    const probe = await session.fast(sold);
    if (probe.ledger) structural = sold; else refusals.push(...probe.refusals);
  }
  let walked = await cashFirst(session, structural);
  if (meets((await session.fast(walked.draft)).ledger)) return { draft: await minimiseOrdinary(session, walked.draft), refusals };
  try {
    const probe = await session.fast(structural);
    const upper = amount(cents(spendCeiling(pack, probe, { ordinary: true })));
    if (upper > 0) structural = upsert(structural, { type: 'spendLess', annualAmount: upper,
      sources: { annualAmount: bounded('/household/expenses/monthlyEssential', 'Use the ordinary spending bound without crossing stated essentials') } });
  } catch (error) { refusals.push(refusal(error)); }
  walked = await cashFirst(session, structural);
  if (meets((await session.fast(walked.draft)).ledger)) return { draft: await minimiseOrdinary(session, walked.draft), refusals };
  for (const id of initial.ledger.goalOrder) {
    for (const [field, range] of Object.entries(pack.goalFlexibility[id] ?? {})) {
      let value = ['targetAmount', 'targetIncomeToday'].includes(field) ? range[0] : range[1];
      if (field === 'retirementAge') {
        const binding = pack.planningInputs.goalBindings.find(binding => binding.goalId === id);
        const person = [pack.household.primaryPerson, pack.household.partner].find(person => person?.personId === binding?.personId)
          ?? (!pack.household.partner ? pack.household.primaryPerson : null);
        if (!person) continue;
        value = Math.min(value, person.intendedRetirementAge + PLANEIR_ASSUMPTIONS.routes.majorWorkingLongerYears);
        if (value < range[0]) continue;
      }
      const moved = upsert(structural, moveChoice(pack, id, field, value, 'Test the ordinary endpoint inside the stated goal flexibility'));
      if (moved.changes.some(change => classifyLever(pack, change).scale === 'major')) continue;
      const probe = await session.fast(moved);
      if (!probe.ledger) { refusals.push(...probe.refusals); continue; }
      structural = moved;
      walked = await cashFirst(session, structural);
      if (meets((await session.fast(walked.draft)).ledger)) return { draft: await minimiseOrdinary(session, walked.draft), refusals };
    }
  }
  // Full clearances are discrete choices. Try each against the same ordinary
  // envelope, rather than assuming that spending cash always improves a plan.
  for (const [index, binding] of pack.planningInputs.outgoingBindings.entries()) {
    const cleared = upsert(structural, { type: 'clearOutgoing', outgoingId: binding.id, paidFrom: 'savings', sources: { outgoingId: fact(`/planningInputs/outgoingBindings/${index}/id`),
      paidFrom: { kind: 'default', path: '/routes/clearOutgoingPaidFrom', version: PLANEIR_ASSUMPTIONS.version } } });
    const probe = await session.fast(cleared);
    if (!probe.ledger) { refusals.push(...probe.refusals); continue; }
    const choice = await cashFirst(session, cleared);
    if (meets((await session.fast(choice.draft)).ledger)) return { draft: await minimiseOrdinary(session, choice.draft), refusals };
  }
  return { draft: null, refusals, reason: 'No supported ordinary single move or this method-ordered ordinary combination funds every goal.' };
}

async function combinedMajors(session, draft) {
  const proof = await singleMajorTrials(session.pack, draft);
  if (!proof.base.ledger || proof.base.feasible || proof.unavailable.length || proof.trials.some(trial => trial.feasible)) return { draft: null,
    refusals: proof.unavailable, reason: 'A no-single-major proof is absent or a single move is enough.' };
  const candidates = proof.trials.filter(trial => trial.ledger).map(trial => trial.draft.changes.filter(change => classifyLever(session.pack, change).scale === 'major')[0]).filter(Boolean);
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const a = candidates[i], b = candidates[j];
    if (a.type === b.type || (PROPERTY_LEVERS.includes(a.type) && PROPERTY_LEVERS.includes(b.type))) continue;
    let choice = upsert(upsert(proof.ordinary, a), b);
    const cut = [a, b].find(change => change.type === 'spendLess');
    if (cut) {
      const withoutCut = removeChange(choice, change => change.type === 'spendLess');
      const other = await session.fast(withoutCut);
      if (!other.ledger) continue;
      const upper = amount(cents(spendCeiling(session.pack, other)));
      if (upper <= 0) continue;
      choice = upsert(choice, { ...cut, annualAmount: Math.min(cut.annualAmount, upper) });
    }
    if (!meets((await session.fast(choice)).ledger)) continue;
    for (const change of [a, b]) {
      if (change.type === 'spendLess') {
        const active = choice.changes.find(row => row.type === 'spendLess');
        const sized = await minimum(session, value => upsert(choice, { ...active, annualAmount: amount(value) }), 1, cents(active.annualAmount), probe => meets(probe.ledger));
        if (sized) choice = sized.draft;
      } else if (change.type === 'tradeDownHome') {
        const range = propertyMoveBounds(session.pack).newHomePrice;
        const sized = await maximum(session, value => upsert(choice, { ...change, newHomePrice: amount(value) }), cents(range[0]), cents(range[1]), probe => meets(probe.ledger));
        if (sized) choice = sized.draft;
      } else if (change.type === 'moveGoal') {
        const range = session.pack.goalFlexibility[change.goalId].retirementAge;
        for (let age = range[0]; age <= change.retirementAge; age++) {
          const smaller = upsert(choice, { ...change, retirementAge: age });
          if (meets((await session.fast(smaller)).ledger)) { choice = smaller; break; }
        }
      }
    }
    return { draft: choice, refusals: [], basis: 'Each setting minimised with the other fixed; the compiler independently verifies the no-single-major proof.' };
  }
  return { draft: null, refusals: [], reason: 'No supported pair of major moves funds the fixed ordinary draft. Multi-property sales need their own transaction adapter.' };
}

/** Up to five independently priced whole walks. The v1 plan-pack cap remains
 * current plus three alternatives; suggestions are separate candidates for
 * the analyst to retain, never silently inserted as five plan-pack routes.
 */
export async function suggestRoutes(compiledPlan) {
  try {
    const session = walkSession(compiledPlan), empty = { id: 'walk', changes: [] };
    const base = await session.fast(empty);
    if (!base.ledger) return { status: 'refused', suggestions: [], refusals: base.refusals };
    const suggestions = [], refusals = [], signatures = new Map();
    const add = async (family, draft, why, minimisation = null) => {
      if (!draft || suggestions.length >= 5) return;
      const signature = JSON.stringify(draft.changes);
      if (signatures.has(signature)) { signatures.get(signature).families.push(family); return; }
      const priced = await session.price(draft);
      const entry = { families: [family], what: cloneJson(draft.changes), why, minimisation,
        route: cloneJson(draft), pricing: priced, allGoalsOnTime: priced.meetsAllGoals };
      suggestions.push(entry); signatures.set(signature, entry);
    };
    const cash = await cashFirst(session, empty);
    await add('lump_sum_first', cash.draft, 'Commit spare cash goal by goal in method order, preserving the reserve and repricing yearly funding after each choice.');
    await add('cash_kept', empty, 'Keep uncommitted cash and use the native yearly funding requirements, with any remaining gap shown.');
    const ordinary = await findBalancingMoves(session, empty, { ordinaryOnly: true, includeMajor: false });
    const single = ordinary.moves[0];
    if (single) await add('smallest_ordinary_moves', single.route, single.why, single.minimum);
    else if (meets(base.ledger)) await add('smallest_ordinary_moves', empty, 'No ordinary move is needed to fund the stated goals.');
    else {
      const combined = await ordinaryCombination(session, empty);
      if (combined.draft) await add('smallest_ordinary_moves', combined.draft,
        'Compose ordinary changes in method order, then remove redundant changes and minimise each remaining numeric setting with the others fixed.',
        { basis: 'conditional_minima_not_an_economic_ranking' });
      refusals.push(...combined.refusals);
    }
    refusals.push(...cash.refusals, ...ordinary.refusals);
    if (!meets((await session.fast(cash.draft)).ledger)) {
      const balanced = await findBalancingMoves(session, cash.draft);
      for (const move of balanced.moves.filter(move => move.scale === 'major')) await add('smallest_major_move', move.route, move.why, move.minimum);
      refusals.push(...balanced.refusals);
      if (!balanced.moves.some(move => move.scale === 'major') && suggestions.length < 5) {
        const combined = await combinedMajors(session, cash.draft);
        if (combined.draft) await add('major_combination_after_single_moves_fail', combined.draft, combined.basis,
          { basis: 'conditional_minima_with_compiler_verified_single_major_exhaustion' });
        refusals.push(...combined.refusals);
      }
    }
    return { status: 'priced', methodOrder: METHOD_ORDER, goalOrder: base.ledger.goalOrder, suggestions, refusals,
      ordering: 'Method families and source order only; no rank, recommendation or outcome score.' };
  } catch (error) { return { status: 'refused', suggestions: [], refusals: [refusal(error)] }; }
}
