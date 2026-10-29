import { cloneJson } from '../utils.js';
import { PLANEIR_ASSUMPTIONS } from '../planeir_assumptions.js';
import { normalizePlanPack, PlanPackError } from './schema.js';
import { prepareResourceRoute } from './resource_ledger.js';
import { classifyLever } from './lever_catalogue.js';
import { propertyMoveBounds, PROPERTY_LEVERS } from './property_moves.js';
import { bounded, fact, upsert, moveChoice, meets } from './walk_session.js';
import { amount, cents, spendCeiling } from './walk_search.js';

export function ordinaryDraft(pack, route) {
  const changes = [];
  for (const change of route.changes) {
    if (classifyLever(pack, change).scale !== 'major') { changes.push(cloneJson(change)); continue; }
    if (change.type === 'moveGoal') {
      const remaining = cloneJson(change); delete remaining.retirementAge; if (remaining.sources) delete remaining.sources.retirementAge;
      if (Object.keys(remaining).some(key => !['type', 'goalId', 'sources'].includes(key))) changes.push(remaining);
    }
  }
  return { ...cloneJson(route), changes };
}

/** Strongest supported settings (all years/ages where timing can differ),
 * holding the already committed ordinary draft fixed. No financial formula is
 * approximated here: every trial uses the same native B1 preparer.
 */
function majorEndpoints(pack, route, base) {
  const candidates = [], unavailable = [];
  try {
    const upper = amount(cents(spendCeiling(pack, base)));
    if (upper > pack.household.expenses.annualTotal.amount * PLANEIR_ASSUMPTIONS.routes.spendLess.ordinaryFractionOfAnnualSpending) {
      candidates.push(upsert(route, { type: 'spendLess', annualAmount: upper, sources: { annualAmount: bounded('/household/expenses/monthlyEssential', 'Test the strongest spending move above stated essentials') } }));
    }
  } catch (error) { unavailable.push({ path: error.path, code: error.code, message: error.message }); }
  for (const goal of pack.household.goals) {
    const range = pack.goalFlexibility[goal.goalId]?.retirementAge;
    if (!range) continue; // An unstated range does not authorise this move.
    const binding = pack.planningInputs.goalBindings.find(binding => binding.goalId === goal.goalId);
    const people = [pack.household.primaryPerson, pack.household.partner].filter(Boolean);
    const person = people.find(person => person.personId === binding?.personId) ?? (people.length === 1 ? people[0] : null);
    if (!person) { unavailable.push({ path: '/planningInputs/goalBindings', code: 'missing_information', message: 'Name the person whose retirement age this goal changes.' }); continue; }
    for (let age = Math.max(range[0], person.intendedRetirementAge + PLANEIR_ASSUMPTIONS.routes.majorWorkingLongerYears + 1); age <= range[1]; age++) {
      candidates.push(upsert(route, moveChoice(pack, goal.goalId, 'retirementAge', age, 'Test each permitted major retirement delay')));
    }
  }
  const bounds = propertyMoveBounds(pack);
  const last = Math.min(bounds.year[1], base.ledger.years.find(row => row.shortfall > 0.005)?.year ?? bounds.year[1]);
  for (let year = bounds.year[0]; year <= last; year++) {
    if (bounds.newHomePrice) candidates.push(upsert(route, { type: 'tradeDownHome', year, newHomePrice: bounds.newHomePrice[0],
      sources: { year: bounded('/household/properties', 'Test each sale year before the first funding gap'), newHomePrice: bounded('/household/properties', 'Test the strongest trade down inside central price bounds') } }));
    for (const [index, property] of pack.household.properties.entries()) if (property.use !== 'home') candidates.push(upsert(route,
      { type: 'sellProperty', propertyId: property.propertyId, year, sources: { propertyId: fact(`/household/properties/${index}/propertyId`),
        year: bounded(`/household/properties/${index}/currentValue`, 'Test each sale year before the first funding gap') } }));
  }
  return { candidates, unavailable };
}

export async function singleMajorTrials(pack, route) {
  const trial = async draft => {
    try {
      const normalized = normalizePlanPack({ ...cloneJson(pack), narration: {}, routes: [{ id: 'current' }, draft] });
      const prepared = await prepareResourceRoute(normalized, normalized.routes[1], 1);
      return { draft, ...prepared, feasible: meets(prepared.ledger), refusals: [] };
    } catch (error) { return { draft, ledger: null, feasible: false,
      refusals: [{ path: error.path ?? '/routes', code: error.code ?? 'engine_refusal', message: error.message }] }; }
  };
  const ordinary = ordinaryDraft(pack, route), base = await trial(ordinary);
  if (!base.ledger || base.feasible) return { ordinary, base, trials: [], unavailable: base.refusals };
  const endpoints = majorEndpoints(pack, ordinary, base), trials = [];
  for (const candidate of endpoints.candidates) trials.push(await trial(candidate));
  const unknown = trials.flatMap(result => result.refusals.filter(row => row.code === 'missing_information' || row.code.startsWith('requires_') || row.code === 'engine_refusal'));
  return { ordinary, base, trials, unavailable: [...endpoints.unavailable, ...unknown] };
}

/** No caller-provided waiver exists. The compiler independently rechecks the
 * no-single-major condition before accepting a multi-major wire route.
 */
export async function proveSingleMajorFailure(pack, route, index) {
  const path = `/routes/${index}/changes`;
  if (route.changes.filter(change => PROPERTY_LEVERS.includes(change.type)).length > 1) throw new PlanPackError(path, 'At most one major property move is supported: a multi-property transaction timeline needs its own adapter.', 'requires_multi_property_adapter');
  const proof = await singleMajorTrials(pack, route);
  if (proof.base.feasible || proof.trials.some(trial => trial.feasible)) throw new PlanPackError(path,
    'At most one major move is allowed: a single move can fund this same ordinary draft.');
  if (!proof.base.ledger || proof.unavailable.length) throw new PlanPackError(path,
    'At most one major move is allowed until all applicable single-major trials can be priced; unresolved fact: ' + (proof.unavailable[0]?.path ?? '/household') + '.', 'requires_single_major_proof');
  return { basis: 'no_single_major_funds_the_same_committed_ordinary_draft', calculationDate: pack.calculationDate,
    ordinaryChanges: proof.ordinary.changes, assumptionsVersion: PLANEIR_ASSUMPTIONS.version,
    trials: proof.trials.map(trial => ({ changes: trial.draft.changes, balanced: trial.ledger?.balanced ?? false,
      goalsCovered: trial.ledger?.goalsCovered ?? false, refusals: trial.refusals })) };
}
