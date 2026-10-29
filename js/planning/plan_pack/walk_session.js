import { compilePlanPack } from './compiler.js';
import { normalizePlanPack } from './schema.js';
import { prepareResourceRoute } from './resource_ledger.js';
import { cloneJson } from '../utils.js';
import { classifyLever } from './lever_catalogue.js';
import { proveSingleMajorFailure, ordinaryDraft } from './major_policy.js';

export const METHOD_ORDER = Object.freeze(['reserve', 'protection', 'loans_and_cards', 'dated_costs_soonest_first', 'mortgage', 'retirement']);
export const RETIREMENT_GOALS = Object.freeze(['retire', 'retire_early', 'improve_pension']);
export const refusal = error => ({ path: error.path ?? '/routeDraft', code: error.code ?? 'invalid_input', message: error.message });
export const bounded = (path, reason) => ({ kind: 'bounded', reason: `${reason} (${path}).`, factPaths: [path] });
export const fact = path => ({ kind: 'fact', path });
export function sourcePack(input) {
  const raw = input?.source?.normalizedPlanPack ?? input?.compilation?.source?.normalizedPlanPack ?? input?.planPack;
  if (!raw) throw Object.assign(new Error('Supply a compiled plan with its immutable source plan pack.'), { path: '/compiledPlan/source', code: 'missing_information' });
  return normalizePlanPack(raw, { allowMultipleMajors: true });
}
export function wireDraft(draft) {
  if (!draft || typeof draft !== 'object' || !Array.isArray(draft.changes)) throw Object.assign(new Error('Supply a route draft with changes.'), { path: '/routeDraft' });
  return cloneJson(draft);
}
const identity = change => `${change.type}:${change.goalId ?? change.personId ?? change.outgoingId ?? change.assetId ?? change.propertyId ?? ''}`;
export function upsert(draft, change) {
  const next = cloneJson(draft), index = next.changes.findIndex(old => identity(old) === identity(change));
  if (index < 0) next.changes.push(cloneJson(change));
  else if (['moveGoal', 'pensionContribution'].includes(change.type)) {
    next.changes[index] = { ...next.changes[index], ...cloneJson(change), sources: { ...next.changes[index].sources, ...cloneJson(change.sources) } };
  } else next.changes[index] = cloneJson(change);
  return next;
}
export function withoutTargetFunding(pack, draft, goalId) {
  const retirement = RETIREMENT_GOALS.includes(pack.household.goals.find(goal => goal.goalId === goalId)?.type);
  return { ...cloneJson(draft), changes: cloneJson(draft.changes.filter(change => !(change.type === 'useCash' && change.goalId === goalId)
    && !(retirement && change.type === 'pensionContribution'))) };
}
function goalSources(pack, goalId) {
  const index = pack.household.goals.findIndex(goal => goal.goalId === goalId);
  return { index, goalId: fact(`/household/goals/${index}/goalId`), path: `/household/goals/${index}` };
}
export function cashChoice(pack, goalId, amount, reason = 'Fund this goal inside its native cash limit and the protected reserve') {
  const sources = goalSources(pack, goalId);
  return { type: 'useCash', goalId, amount, sources: { goalId: sources.goalId, amount: bounded(sources.path, reason) } };
}
export function moveChoice(pack, goalId, field, value, reason = 'Search this stated goal flexibility') {
  const sources = goalSources(pack, goalId);
  return { type: 'moveGoal', goalId, [field]: value, sources: { goalId: sources.goalId,
    [field]: bounded(`/goalFlexibility/${goalId}/${field}`, reason) } };
}
export function meets(ledger, goalIds) {
  if (!ledger?.reserveProtected) return false;
  const ids = goalIds ?? ledger.goalOrder;
  return ids.every(id => ledger.goals.some(goal => goal.goalId === id && goal.state === 'covered'))
    && ledger.years.every(row => row.cashflowDeficit <= 0.005);
}
export function prefix(ledger, goalId) {
  const index = ledger.goalOrder.indexOf(goalId);
  return index < 0 ? [] : ledger.goalOrder.slice(0, index + 1);
}

/** A call-local cache only. Financial probes call the very same B1 preparer;
 * every returned choice is then compiled with all original chapters/options.
 */
export function walkSession(input, { beforeCompile } = {}) {
  const pack = sourcePack(input), probes = new Map(), compiled = new Map(), majorProofs = new Map();
  const candidate = draft => ({ ...cloneJson(pack), narration: {}, routes: [{ id: 'current' }, wireDraft(draft)] });
  const fast = async draft => {
    const key = JSON.stringify(draft);
    if (!probes.has(key)) probes.set(key, (async () => {
      try {
        const normalized = normalizePlanPack(candidate(draft), { allowMultipleMajors: true });
        const multiple = draft.changes.filter(change => classifyLever(normalized, change).scale === 'major').length > 1;
        let majorException = null;
        if (multiple) {
          const proofKey = JSON.stringify(ordinaryDraft(normalized, normalized.routes[1]));
          if (!majorProofs.has(proofKey)) majorProofs.set(proofKey, proveSingleMajorFailure(normalized, normalized.routes[1], 1));
          majorException = await majorProofs.get(proofKey);
        }
        const prepared = await prepareResourceRoute(normalized, normalized.routes[1], 1);
        if (majorException) prepared.ledger.majorException = majorException;
        return { ledger: { routeId: normalized.routes[1].id, ...prepared.ledger }, context: prepared.context, planPack: normalized, refusals: [] };
      } catch (error) { return { ledger: null, refusals: [refusal(error)] }; }
    })());
    return probes.get(key);
  };
  const price = async draft => {
    const key = JSON.stringify(draft);
    if (!compiled.has(key)) compiled.set(key, (async () => {
      let raw;
      try { raw = candidate(draft); } catch (error) { return { kind: 'priced_route', status: 'refused', routeDraft: cloneJson(draft), ledger: null, refusals: [refusal(error)] }; }
      const compilation = await compilePlanPack(raw, { resourceLedger: true, beforeCompile });
      const ledger = compilation.resourceLedger?.routes.find(row => row.routeId === draft.id) ?? null;
      const result = { kind: 'priced_route', status: compilation.status, planPack: compilation.source?.normalizedPlanPack ?? raw,
        routeDraft: cloneJson(draft), compileOptions: { resourceLedger: true }, compilation, ledger,
        meetsAllGoals: compilation.status === 'compiled' && meets(ledger), refusals: compilation.diagnostics };
      // If cash cannot be paid, retain a clearly labelled native quote without
      // pretending that an overdrawn household produced a financial case.
      if (!ledger && draft.changes.some(change => change.type === 'useCash' || change.oneOffAmount)) {
        const referenceDraft = cloneJson(draft), removedInstructions = [];
        // A goal way appends the choice currently being considered. Remove
        // cash instructions from the end, preserving earlier commitments for
        // as long as they can be priced. Keep a recurring contribution when
        // only its one-off cash part is being removed.
        for (let i = referenceDraft.changes.length - 1; i >= 0; i--) {
          const change = referenceDraft.changes[i];
          if (change.type !== 'useCash' && !change.oneOffAmount) continue;
          removedInstructions.push({ index: i, ...cloneJson(change) });
          if (change.oneOffAmount && change.annualAmount) {
            delete change.oneOffAmount; if (change.sources) delete change.sources.oneOffAmount;
          } else referenceDraft.changes.splice(i, 1);
          const reference = await fast(referenceDraft);
          if (reference.ledger) {
            result.fundingReference = { basis: 'same_draft_without_cash_instructions', removedInstructions,
              spareCash: reference.ledger.spareCashRemaining, goals: reference.ledger.goalFunding };
            break;
          }
        }
      }
      return result;
    })());
    return compiled.get(key);
  };
  return { pack, fast, price, beforeCompile, probeCount: () => probes.size };
}

/** Pure pricing seam for the future price_route wrapper; no tool or I/O. */
export async function priceRoute(compiledPlan, routeDraft, execution = {}) {
  try { return await walkSession(compiledPlan, execution).price(wireDraft(routeDraft)); }
  catch (error) { return { kind: 'priced_route', status: 'refused', ledger: null, refusals: [refusal(error)] }; }
}

export function availableAt(ledger, goalId) {
  const earlier = prefix(ledger, goalId).slice(0, -1);
  const committed = ledger.years.reduce((sum, row) => sum + (row.propertyCapitalForExpenses ?? 0)
    + row.goals.filter(goal => earlier.includes(goal.goalId)).reduce((s, goal) => s + goal.capitalAllocated, 0), 0);
  return {
    reserve: ledger.reserve, cashAfterExistingDraft: ledger.spareCashRemaining,
    spareCash: Math.max(0, ledger.spareCashRemaining - (ledger.propertyMove?.offset === 0 ? committed : 0)),
    earlierGoalIds: earlier,
    earlierGoalsOnTime: earlier.every(id => ledger.goals.find(goal => goal.goalId === id)?.state === 'covered'),
    years: ledger.years.map(row => ({ year: row.year,
      surplus: row.available - row.goals.filter(goal => earlier.includes(goal.goalId)).reduce((sum, goal) => sum + goal.planned - goal.capitalAllocated, 0),
      priorGoalFunding: row.goals.filter(goal => earlier.includes(goal.goalId)),
      ...(ledger.propertyMove ? { propertyCapitalReceived: row.propertyCapitalReceived,
        propertyCapitalBeforeThisGoal: Math.max(0, row.propertyCapitalOpening - row.propertyCapitalForExpenses
          - row.goals.filter(goal => earlier.includes(goal.goalId)).reduce((sum, goal) => sum + goal.capitalAllocated, 0)),
        propertyCapitalRemainingAfterAllGoals: row.propertyCapitalRemaining } : {}) }))
  };
}

export function goalOutcome(priced, goalId) {
  const ledger = priced.ledger, native = ledger?.goalFunding.find(goal => goal.goalId === goalId);
  const state = ledger?.goals.find(goal => goal.goalId === goalId);
  const reference = native ?? priced.fundingReference?.goals.find(goal => goal.goalId === goalId);
  return { meetsGoalOnTime: Boolean(ledger && meets(ledger, prefix(ledger, goalId))), wholeRouteMeetsGoals: priced.meetsAllGoals,
    state: state?.state ?? null, funding: reference ?? null,
    shortfall: { yearly: ledger?.years.map(row => ({ year: row.year, amount: row.goals.find(goal => goal.goalId === goalId)?.shortfall ?? 0 })) ?? [],
      pensionPot: native?.projectedPotGap ?? null,
      reserve: ledger ? Math.max(0, ledger.reserve.protectedAmount - ledger.cashRemaining) : null,
      cash: !ledger && priced.fundingReference?.removedInstructions.every(change => change.type === 'useCash' && change.goalId === goalId)
        && reference?.wholeCash !== null && reference?.wholeCash !== undefined
        ? Math.max(0, reference.wholeCash - priced.fundingReference.spareCash) : null },
    refusals: priced.refusals };
}
