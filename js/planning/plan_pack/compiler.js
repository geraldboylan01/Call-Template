import { normalizePlanPack, finiteJson, PlanPackError, fail } from './schema.js';
import { buildChapter, routeContext, LaterStage, protectionDefaultRequests } from './chapters.js';
import { prepareResourceRoute, prepareCurrentPosition } from './resource_ledger.js';
import { checkCasePack, checkModulePayload } from '../../module_pipeline.js';
import { cloneJson, sha256Json } from '../utils.js';
import { PLANEIR_ASSUMPTIONS_VERSION } from '../planeir_assumptions.js';
import { IE_TAX_RULES_VERSION } from '../tax/rules_ie.js';
import { IRELAND_RULES_CATALOGUE_VERSION } from '../ireland_rules.js';
import { figuresVersionLabel, getFigures } from '../figures/get_figures.js';
import { HOUSEHOLD_CASH_FLOW_BANNED_PHRASES, HOUSEHOLD_CASH_FLOW_PROVIDER_NAMES } from '../../household_cash_flow_math.js';
import { classifyLever } from './lever_catalogue.js';
import { proveSingleMajorFailure } from './major_policy.js';
import { propertyMoveChapter, propertyMoveRows } from './property_move_story.js';

const PLAN_PACK_COMPILER_VERSION = 'plan-pack-1.7.0';
const versions = Object.freeze({
  compiler: PLAN_PACK_COMPILER_VERSION,
  assumptions: PLANEIR_ASSUMPTIONS_VERSION,
  taxRules: IE_TAX_RULES_VERSION,
  irelandRules: IRELAND_RULES_CATALOGUE_VERSION,
  figures: figuresVersionLabel()
});
export { versions as PLAN_PACK_VERSIONS };
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function json(value) { return finiteJson(value); }
function errorRow(error, routeId, chapter) {
  return {
    code: error.code ?? 'engine_refusal',
    path: error.path ?? '/chapters',
    message: error.message,
    ...(error.stage ? { stage: error.stage } : {}),
    ...(routeId ? { routeId } : {}),
    ...(chapter ? { chapter } : {})
  };
}
function derivedOutputs(module) {
  const g = module.generated;
  return json({
    assumptions: g.assumptions, outputs: g.outputs, outputsBucketed: g.outputsBucketed,
    tables: g.tables, charts: (g.charts ?? []).map(({ id: _id, ...chart }) => chart)
  });
}
// A figure id can carry a year or a date (ie.income_tax.2026.standard_rate), so a part may start with a digit.
const placeholderPattern = /\{([a-z][a-z0-9_-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9_-]*)+)\}/g;
/**
 * Every figure in the register, as a placeholder: {figure.<id>}. Narration never
 * types a rate, a band or a limit. It names the figure, and the register's value
 * is shown as the register shows it (20%, €44,000, age 65), so a figure reads the
 * same wherever it is used.
 */
const FIGURE_PLACEHOLDERS = Object.freeze(Object.fromEntries(
  getFigures().map(figure => ['figure.' + figure.id, Object.freeze({ value: figure.valueShown, type: 'text' })])
));
const euro = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const count = new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 });
const year = new Intl.NumberFormat('en-IE', { useGrouping: false, maximumFractionDigits: 0 });
const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function resolvePlanNarration(template, values, path = '/narration') {
  const literal = template.replace(placeholderPattern, '');
  if (/[{}]/.test(literal)) fail(path, 'contains an unclosed or invalid placeholder.');
  if (/[\p{N}€£$%]/u.test(literal)) fail(path, 'financial figures, percentages and dates must use registered placeholders.');
  if (/\b(?:covered|affordable|balanced|recommended)\b/i.test(literal)) fail(path, 'calculated goal states and plan conclusions cannot be typed in narration.');
  const bad = [...HOUSEHOLD_CASH_FLOW_BANNED_PHRASES, ...HOUSEHOLD_CASH_FLOW_PROVIDER_NAMES].find(pattern => pattern.test(literal));
  if (bad) fail(path, 'contains wording the plan does not accept; author revised wording rather than rewriting it in code.');
  const rendered = template.replace(placeholderPattern, (_match, key) => {
    if (!Object.hasOwn(values, key)) fail(path, 'unknown or unavailable placeholder {' + key + '}; references cannot cross routes or traverse arbitrary objects.');
    const entry = values[key];
    if (entry.value === null || entry.value === undefined || (typeof entry.value === 'number' && !Number.isFinite(entry.value))) fail(path, 'placeholder {' + key + '} has no computed value.');
    if (entry.type === 'money') return euro.format(entry.value);
    if (entry.type === 'number') return count.format(entry.value);
    if (entry.type === 'year') return year.format(entry.value);
    return String(entry.value);
  });
  return { text: rendered, html: '<p>' + escapeHtml(rendered) + '</p>' };
}
const PLAN_PACK_METRIC_TYPES = frozen({
  household_cash_flow: { income: 'money', bankTakeHome: 'money', tax: 'money', pensions: 'money', leftOver: 'money' },
  liquidity_analysis: { currentCash: 'money', monthlyExpenditure: 'money', monthsCovered: 'number', minimumCash: 'money', targetCash: 'money', surplusCash: 'money', shortfallCash: 'money' },
  personal_balance_sheet: { grossAssets: 'money', totalLiabilities: 'money', netWorth: 'money', spendableReserves: 'money', reserveMonths: 'number' },
  mortgage_analysis: { monthlyPayment: 'money', totalInterest: 'money', interestSaved: 'money' },
  loan_analysis: { monthlyPayment: 'money', totalInterest: 'money', interestSaved: 'money' },
  pension_projection: { requiredPot: 'money', projectedPot: 'money', retirementYear: 'year' },
  net_retirement_cashflow: { requiredFundToday: 'money', availableInvestmentFundToday: 'money' },
  college_funding: { firstCollegeYear: 'year', finalCollegeYear: 'year', fundingPeriodYears: 'number' },
  future_cost_fund: { requiredToday: 'money', moneyNow: 'money', lumpSumToday: 'money', yearlyAmount: 'money', totalCost: 'money' }
});
function registeredPlaceholders(pack, resourceLedger) {
  const keys = new Set(['route.cashUsed', 'route.goalsMoved', 'route.goalChangeCount', 'plan.calculationDate', ...Object.keys(FIGURE_PLACEHOLDERS)]);
  if (resourceLedger) {
    for (const key of ['cashAvailable', 'reserve', 'cashRemaining', 'yearlyRemaining', 'balanceStatus']) keys.add('ledger.' + key);
    for (const goal of pack.household.goals) for (const key of ['state', 'firstShortYear', 'firstMoneyYear', 'coveredFromYear']) keys.add('goals.' + goal.goalId + '.' + key);
  }
  for (const chapter of pack.chapters) {
    for (const key of Object.keys(PLAN_PACK_METRIC_TYPES[chapter] ?? {})) keys.add(chapter + '.' + key);
    if (chapter === 'protection_gap') for (const id of ['today', ...pack.planningInputs.protectionCases.map(c => c.id),
      ...protectionDefaultRequests(pack.household, pack).map(request => request.id ?? (request.kind === 'death' ? request.personId + '-died' : request.personId + '-cannot-work'))]) {
      for (const key of ['moneyIn', 'gap', 'months']) keys.add(chapter + '.' + id + '.' + key);
    }
  }
  return keys;
}
function placeholders(pack, context, cases) {
  const values = {
    'route.cashUsed': { value: context.cashUsed, type: 'money' },
    'route.goalsMoved': { value: context.movedGoals.map(id => pack.household.goals.find(g => g.goalId === id).title).join(', '), type: 'text' },
    'route.goalChangeCount': { value: context.movedGoals.length, type: 'number' },
    'plan.calculationDate': { value: pack.calculationDate, type: 'text' },
    ...FIGURE_PLACEHOLDERS
  };
  if (context.resourceLedger) {
    const ledger = context.resourceLedger;
    for (const [key, value] of Object.entries({ cashAvailable: ledger.cashAvailableAfterReserve, reserve: ledger.reserve.protectedAmount,
      cashRemaining: ledger.cashRemaining, yearlyRemaining: ledger.years[0].remaining })) values['ledger.' + key] = { value, type: 'money' };
    values['ledger.balanceStatus'] = { value: ledger.balanced ? 'Balances' : 'Does not balance', type: 'text' };
    for (const goal of ledger.goals) {
      values['goals.' + goal.goalId + '.state'] = { value: goal.stateWord, type: 'text' };
      for (const key of ['firstShortYear', 'firstMoneyYear', 'coveredFromYear']) values['goals.' + goal.goalId + '.' + key] = {
        value: goal[key] === null ? null : Number(pack.calculationDate.slice(0, 4)) + goal[key], type: 'year'
      };
    }
  }
  for (const [chapter, entry] of cases) {
    for (const [key, value] of Object.entries(entry.metrics ?? {})) {
      const type = chapter === 'protection_gap' ? (key.endsWith('.months') ? 'number' : 'money') : PLAN_PACK_METRIC_TYPES[chapter]?.[key];
      if (type) values[chapter + '.' + key] = { value, type };
    }
  }
  return values;
}
function validateLiteralNarration(pack, resourceLedger) {
  // Check syntax and literal claims even when a missing stage prevents pricing.
  const registered = registeredPlaceholders(pack, resourceLedger);
  for (const [routeId, template] of Object.entries(pack.narration)) {
    const tokens = [...template.matchAll(placeholderPattern)].map(match => match[1]);
    for (const key of tokens) if (!registered.has(key)) fail('/narration/' + routeId, 'unknown placeholder {' + key + '}.');
    const syntactic = Object.fromEntries(tokens.map(key => [key, { value: '', type: 'text' }]));
    resolvePlanNarration(template, syntactic, '/narration/' + routeId);
  }
}

/**
 * B0 compiles engine inputs; explicit resourceLedger mode also checks B1
 * allocation and route balance. Every route starts from the same opening facts.
 */
export async function compilePlanPack(raw, { resourceLedger = false, currentPositionOnly = false, beforeCompile } = {}) {
  // Caller-local execution accounting, never part of the financial wire pack.
  // Throw before work so nested searches cannot exceed the caller's budget.
  beforeCompile?.();
  let pack;
  try {
    pack = frozen(normalizePlanPack(raw, { allowMultipleMajors: resourceLedger && !currentPositionOnly }));
    if (currentPositionOnly && (!resourceLedger || pack.routes.length !== 1 || pack.routes[0].id !== 'current' || pack.routes[0].changes.length)) {
      fail('/routes', 'Current-position mode requires resourceLedger and exactly the unchanged current route.');
    }
    validateLiteralNarration(pack, resourceLedger && !currentPositionOnly);
  }
  catch (error) {
    return { status: 'invalid', compilerVersion: PLAN_PACK_COMPILER_VERSION, diagnostics: [errorRow(error)], routes: [], chapters: [], casePacks: null };
  }
  const sourceHash = await sha256Json(pack);
  const diagnostics = [];
  const chapterMap = new Map(pack.chapters.map(id => [id, { id, cases: [] }]));
  const routes = [];
  const pendingCasePacks = [];
  const ledgers = [];
  for (const [index, route] of pack.routes.entries()) {
    let context;
    const proposed = [];
    try {
      if (resourceLedger) {
        const multiple = route.changes.filter(change => classifyLever(pack, change).scale === 'major').length > 1;
        const majorException = multiple ? await proveSingleMajorFailure(pack, route, index) : null;
        const prepared = currentPositionOnly ? await prepareCurrentPosition(pack) : await prepareResourceRoute(pack, route, index);
        if (majorException) prepared.ledger.majorException = majorException;
        context = prepared.context;
        if (!currentPositionOnly) context.resourceLedger = prepared.ledger;
        ledgers.push({ routeId: route.id, ...prepared.ledger });
        if (route.id !== 'current' && !prepared.ledger.balanced) fail('/routes/' + index,
          !prepared.ledger.reserveProtected ? 'This route spends cash protected for the emergency reserve.'
            : 'This route needs more annual funding than is available, first in ' + prepared.ledger.years.find(row => row.shortfall > 0.005).year + '.', 'unbalanced_route');
      } else context = routeContext(pack, route, index);
      for (const chapter of pack.chapters) {
        try {
          const built = await buildChapter(context, pack, chapter);
          const checked = checkModulePayload(built.payload, { calculationYear: Number(pack.calculationDate.slice(0, 4)) });
          if (!checked.ok) throw new PlanPackError('/chapters/' + pack.chapters.indexOf(chapter), checked.error, 'engine_refusal');
          const input = json(built.input);
          const builderVersion = built.moduleVersion ?? PLAN_PACK_COMPILER_VERSION;
          const inputHash = await sha256Json({ chapter, input, calculationDate: pack.calculationDate, builderVersion, versions });
          const caseId = 'case-' + inputHash.replace(/^sha256:/, '').slice(0, 20);
          proposed.push([chapter, {
            id: caseId, inputHash, input, payload: json(built.payload),
            nativeCaseId: built.nativeCaseId ?? 'today', basis: built.basis,
            metrics: json(built.metrics ?? {}), calculationFacts: json(built.calculationFacts ?? {}), derived: derivedOutputs(checked.module),
            assumptionsUsed: json(built.assumptionsUsed ?? []),
            warnings: json([...(built.warnings ?? []), ...checked.warnings]),
            provenance: {
              sourceHash, sourceDocument: 'normalized_plan_pack', builder: chapter, builderVersion,
              householdSource: '/household', transitionSource: '/planningInputs',
              uses: [{ routeId: route.id, routeSource: '/routes/' + index, routeChanges: cloneJson(context.changedFacts) }],
              builderHousehold: json(built.builderHousehold), calculationDateSource: '/calculationDate',
              versions
            }
          }]);
        } catch (error) {
          error.chapter = chapter;
          throw error;
        }
      }
      if (context.propertyMove) {
        const chapter = 'property_move', move = context.propertyMove;
        const property = pack.household.properties.find(row => row.propertyId === move.propertyId);
        const built = propertyMoveChapter(move, property);
        const checked = checkModulePayload(built.payload, { calculationYear: Number(pack.calculationDate.slice(0, 4)) });
        if (!checked.ok) fail('/chapters/property_move', checked.error, 'engine_refusal');
        const inputHash = await sha256Json({ chapter, input: json(built.input), versions });
        proposed.push([chapter, { ...json(built), id: 'case-' + inputHash.replace(/^sha256:/, '').slice(0, 20), inputHash,
          units: Object.fromEntries(propertyMoveRows(move, property).map(row => [row.key, row.unit])),
          derived: derivedOutputs(checked.module), provenance: { versions, builder: 'property_moves', builderVersion: PLAN_PACK_COMPILER_VERSION } }]);
        if (!chapterMap.has(chapter)) chapterMap.set(chapter, { id: chapter, cases: [] });
      }
      const casePack = { casePackVersion: 1, clientName: pack.clientName, modules: proposed.map(([, entry]) => entry.payload) };
      const checkedPack = checkCasePack(casePack, { calculationYear: Number(pack.calculationDate.slice(0, 4)) });
      if (!checkedPack.ok) fail('/routes/' + index, 'The existing case-pack validator refused the compiled route.', 'engine_refusal');
      const mapping = {};
      for (const [chapter, entry] of proposed) {
        const target = chapterMap.get(chapter);
        const shared = target.cases.find(c => c.inputHash === entry.inputHash);
        if (shared) shared.provenance.uses.push(...entry.provenance.uses);
        else target.cases.push(entry);
        if (target.cases.length > 4) fail('/chapters', chapter + ' exceeds the shared four-case cap.');
        mapping[chapter] = entry.id;
      }
      const narration = pack.narration[route.id] === undefined ? null
        : resolvePlanNarration(pack.narration[route.id], placeholders(pack, context, proposed), '/narration/' + route.id);
      routes.push({ id: route.id, title: route.title ?? route.id, status: 'compiled', chapterCases: mapping,
        sourceHousehold: cloneJson(context.profile), changes: context.changedFacts, narration });
      pendingCasePacks.push({ routeId: route.id, casePack });
    } catch (error) {
      diagnostics.push(errorRow(error, route.id, error.chapter));
      routes.push({ id: route.id, title: route.title ?? route.id, status: error instanceof LaterStage ? 'requires_later_stage' : 'invalid', chapterCases: {} });
    }
  }
  const status = routes.some(r => r.status === 'invalid') ? 'invalid'
    : routes.some(r => r.status === 'requires_later_stage') ? 'requires_later_stage' : 'compiled';
  if (resourceLedger) {
    const originalOrder = new Map(pack.routes.map((route, i) => [route.id, i]));
    const changeCount = id => new Set(pack.routes.find(r => r.id === id).changes.map(c => c.goalId ?? c.outgoingId ?? c.assetId)).size;
    routes.sort((a, b) => a.id === 'current' ? -1 : b.id === 'current' ? 1
      : ((ledgers.find(l => l.routeId === a.id)?.cashAllocated ?? 0) - (ledgers.find(l => l.routeId === b.id)?.cashAllocated ?? 0))
        || changeCount(a.id) - changeCount(b.id) || originalOrder.get(a.id) - originalOrder.get(b.id));
    const order = new Map(routes.map((r, i) => [r.id, i]));
    pendingCasePacks.sort((a, b) => order.get(a.routeId) - order.get(b.routeId));
    ledgers.sort((a, b) => order.get(a.routeId) - order.get(b.routeId));
  }
  if (resourceLedger && !currentPositionOnly) {
    const current = ledgers.find(ledger => ledger.routeId === 'current');
    if (current) for (const route of routes) {
      const ledger = ledgers.find(ledger => ledger.routeId === route.id);
      if (!ledger) continue;
      const delta = (before, after) => ({ current: before ?? null, route: after ?? null,
        difference: Number.isFinite(before) && Number.isFinite(after) ? after - before : null });
      route.differencesFromCurrent = {
        ...(ledger.propertyMove ? { endingCash: delta(current.endingCash ?? current.cashRemaining, ledger.endingCash),
          propertyCapitalCommitted: delta(current.propertyCapitalCommitted ?? 0, ledger.propertyCapitalCommitted) } : {}),
        cashAllocated: delta(current.cashAllocated, ledger.cashAllocated),
        cashRemaining: delta(current.cashRemaining, ledger.cashRemaining),
        annualSurplusBeforeGoalFunding: delta(current.baselineLeftOver, ledger.baselineLeftOver),
        annualSurplusAfterGoalFunding: delta(current.years[0]?.remaining, ledger.years[0]?.remaining),
        years: [...new Set([...current.years, ...ledger.years].map(row => row.year))].sort((a, b) => a - b).map(year => ({
          year, ...delta(current.years.find(row => row.year === year)?.remaining, ledger.years.find(row => row.year === year)?.remaining)
        })),
        goals: ledger.goals.map(goal => ({ goalId: goal.goalId, currentState: current.goals.find(row => row.goalId === goal.goalId)?.state ?? null, routeState: goal.state }))
      };
    }
  }
  return {
    planPackVersion: 1, compilerVersion: PLAN_PACK_COMPILER_VERSION, status,
    clientName: pack.clientName, calculationDate: pack.calculationDate, versions,
    source: { hash: sourceHash, normalizedPlanPack: cloneJson(pack) },
    scope: currentPositionOnly ? 'B2 current-position resources; goal funding not priced' : resourceLedger ? 'B1 resource-ledger checks' : 'B0 compilation only',
    resourceLedger: resourceLedger ? { stage: 'B1', status: currentPositionOnly ? (ledgers[0]?.status ?? 'incomplete') : ledgers.length === pack.routes.length ? 'priced' : 'incomplete', routes: ledgers } : { stage: 'B1', status: 'not_computed' },
    diagnostics, routes,
    chapters: status === 'invalid' ? [] : [...chapterMap.values()],
    // Atomic export: no partial pack can be passed to the app as successful.
    casePacks: status === 'compiled' ? pendingCasePacks : null
  };
}
