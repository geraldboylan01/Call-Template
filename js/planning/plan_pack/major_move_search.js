import { compilePlanPack } from './compiler.js';
import { propertyMoveBounds, PROPERTY_LEVERS } from './property_moves.js';
import { cloneJson } from '../utils.js';
import { normalizePlanPack } from './schema.js';
import { classifyLever } from './lever_catalogue.js';

/** Full-B1 probes, never chapter heuristics or an AI estimate. Prices in cents;
 * years in ascending order. An explicit year fixes the sale date; otherwise
 * trade downs maximise price across years, breaking ties with the earliest.
 * No route, opening tax state, or failed probe is mutated or reused.
 * The optional maxProbes guard stops before compilation and returns completed
 * probes so a caller can enforce and account for its remaining engine budget.
 */
export async function sizeMajorMove(rawPack, route, options = {}, { maxProbes = Infinity, beforeCompile } = {}) {
  const probes = [];
  if (maxProbes !== Infinity && (!Number.isInteger(maxProbes) || maxProbes < 0)) {
    return { status: 'refused', refusals: [{ path: '/maxProbes', code: 'invalid_input', message: 'Use a non-negative whole probe budget.' }], probes };
  }
  try { return await searchMajorMove(rawPack, route, options, probes, maxProbes, beforeCompile); }
  catch (error) {
    if (error.code !== 'budget_exceeded') throw error;
    return { status: 'refused', refusals: [{ path: error.path ?? '/budget/compilerRunsPerCall', code: error.code, message: error.message }], probes };
  }
}

async function searchMajorMove(rawPack, route, { type, propertyId, year, goalIds }, probes, maxProbes, beforeCompile) {
  const refused = (path, message) => ({ status: 'refused', refusals: [{ path, message, code: 'invalid_input' }] });
  let pack;
  try { pack = normalizePlanPack(rawPack, { allowMultipleMajors: true }); } catch (error) { return refused(error.path ?? '/planPack', error.message); }
  const base = cloneJson(route);
  if (goalIds !== undefined && (!Array.isArray(goalIds) || !goalIds.length || goalIds.some(id => !pack.household.goals.some(goal => goal.goalId === id)))) return refused('/goalIds', 'Name existing funding goals for a scoped walk probe.');
  if (!PROPERTY_LEVERS.includes(type)) return refused('/type', 'Choose tradeDownHome or sellProperty.');
  if (!base || base.id === 'current' || !Array.isArray(base.changes) || base.changes.some(c => PROPERTY_LEVERS.includes(c?.type))) return refused('/route', 'Supply an alternative draft without a property move.');
  const bounds = propertyMoveBounds(pack);
  if (year !== undefined && (!Number.isInteger(year) || year < bounds.year[0] || year > bounds.year[1])) return refused('/year', 'Choose a year inside the central search horizon.');
  const run = async change => {
    if (probes.length >= maxProbes) throw Object.assign(new Error('The plan has used its engine runs; the major-move search stopped before another probe.'), { code: 'budget_exceeded' });
    const candidate = { ...base, changes: [...base.changes, ...(change ? [change] : [])] };
    const result = await compilePlanPack({ ...pack, narration: {}, routes: [{ id: 'current' }, candidate] }, { resourceLedger: true, beforeCompile });
    const ledger = result.resourceLedger?.routes.find(row => row.routeId === candidate.id);
    const scoped = goalIds !== undefined;
    const ok = scoped ? ledger?.reserveProtected && goalIds.every(id => ledger.goals.some(goal => goal.goalId === id && goal.state === 'covered'))
      && ledger.years.every(row => row.cashflowDeficit <= 0.005) && result.diagnostics.every(row => row.code === 'unbalanced_route')
      : result.status === 'compiled' && ledger?.balanced && ledger?.goalsCovered;
    probes.push({ setting: change ?? null, ok: Boolean(ok), refusals: result.diagnostics });
    return { ok, ledger, compilation: result, route: candidate };
  };
  const baseline = await run(null);
  if (!baseline.ledger) return { status: 'refused', refusals: baseline.compilation.diagnostics, probes };
  if (baseline.ok) return { status: 'not_needed', route: base, ledger: baseline.ledger, bounds, probes };
  if (base.changes.some(change => classifyLever(pack, change).scale === 'major')) return refused('/route/changes', 'Start from a draft without a major lever; a second major needs the later combined-move search.');
  const properties = pack.household.properties;
  const property = type === 'tradeDownHome' ? properties.filter(p => p.use === 'home').length === 1 && properties.find(p => p.use === 'home') : properties.find(p => p.propertyId === propertyId);
  if (!property) return refused('/household/properties', 'Identify the home or the second property.');
  const path = `/household/properties/${properties.indexOf(property)}`;
  const bounded = parameter => ({ kind: 'bounded', reason: `Code searches ${parameter} within central bounds, citing ${path}/currentValue.`, factPaths: [path + '/currentValue'] });
  const make = (saleYear, price) => ({ type, year: saleYear,
    ...(type === 'tradeDownHome' ? { newHomePrice: price } : { propertyId }),
    sources: { year: bounded('year'), ...(type === 'tradeDownHome' ? { newHomePrice: bounded('replacement price') } : { propertyId: { kind: 'fact', path: path + '/propertyId' } }) } });
  const missing = result => result.compilation.diagnostics.filter(row => row.code === 'missing_information' || row.code.startsWith('requires_') || row.code === 'unsupported_parameter_source' || row.code === 'engine_refusal');
  let selected = null;
  const firstShortYear = baseline.ledger.years.find(row => goalIds
    ? row.goals.some(goal => goalIds.includes(goal.goalId) && goal.shortfall > 0.005) : row.shortfall > 0.005)?.year;
  // A transaction after an existing gap cannot repair that earlier gap.
  const lastYear = year ?? Math.min(bounds.year[1], firstShortYear ?? bounds.year[1]);
  if (type === 'tradeDownHome') {
    if (!bounds.newHomePrice) return refused(path + '/currentValue', 'Establish the current home value.');
    const select = probe => {
      const price = probe.route.changes.at(-1).newHomePrice;
      if (!selected || price > selected.route.changes.at(-1).newHomePrice) selected = probe;
    };
    for (let saleYear = year ?? bounds.year[0]; saleYear <= lastYear; saleYear++) {
      let low = Math.round(bounds.newHomePrice[0] * 100), high = Math.round(bounds.newHomePrice[1] * 100);
      const smallest = await run(make(saleYear, low / 100));
      if (missing(smallest).length) return { status: 'refused', refusals: missing(smallest), bounds, probes };
      if (smallest.ok) {
        select(smallest);
        while (low <= high) {
          const mid = Math.floor((low + high) / 2), probe = await run(make(saleYear, mid / 100));
          if (missing(probe).length) return { status: 'refused', refusals: missing(probe), bounds, probes };
          if (probe.ok) { select(probe); low = mid + 1; } else high = mid - 1;
        }
      }
    }
  } else {
    for (let saleYear = year ?? bounds.year[0]; saleYear <= lastYear; saleYear++) {
      const probe = await run(make(saleYear));
      if (missing(probe).length) return { status: 'refused', refusals: missing(probe), bounds, probes };
      if (probe.ok) { selected = probe; break; }
    }
  }
  return selected ? { status: 'sized', route: selected.route, ledger: selected.ledger, compilation: selected.compilation, bounds, probes,
    ...(goalIds ? { scope: { goalIds, wholeRouteBalanced: selected.ledger.balanced && selected.ledger.goalsCovered } } : {}) }
    : { status: 'none', reason: 'No move inside these bounds funds every goal on time while protecting the reserve.', bounds, probes };
}
