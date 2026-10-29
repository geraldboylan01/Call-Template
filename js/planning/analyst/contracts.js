import Ajv from 'ajv';
import { FIGURE_KINDS, FIGURE_MODULES } from '../figures/kinds.js';
import { getLeverCatalogue } from '../plan_pack/lever_catalogue.js';

export const ANALYST_VERSION = 'analyst-tools-3.0.0';
export const RUN_LIMITS = Object.freeze({ routes: 3, whatifsPerRoute: 8, pricingCalls: 30, compilerRunsPerCall: 80, compilerRuns: 1500 });
export const PRICING_TOOLS = Object.freeze(['price_route', 'goal_ways', 'suggest_routes', 'balancing_moves', 'run_whatif']);
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string', minLength: 1 };
const routeId = { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' };
const source = { oneOf: [
  object({ kind: { const: 'fact' }, path: text }, ['kind', 'path']),
  object({ kind: { const: 'default' }, path: text, version: text }, ['kind', 'path', 'version']),
  object({ kind: { const: 'bounded' }, reason: text, factPaths: { type: 'array', minItems: 1, items: text } }, ['kind', 'reason', 'factPaths'])
] };
const parameterSchema = parameter => {
  const schema = Object.fromEntries(['minimum', 'exclusiveMinimum', 'multipleOf', 'default'].filter(key => parameter[key] !== undefined).map(key => [key, parameter[key]]));
  const type = parameter.integer ? 'integer' : parameter.type;
  if (Array.isArray(parameter.type) && parameter.choices) schema.anyOf = [
    { type: parameter.integer ? 'integer' : 'number', minimum: parameter.minimum }, { enum: parameter.choices }
  ];
  else { schema.type = type; if (parameter.choices) schema.enum = parameter.choices; }
  if (parameter.bounds) schema.description = parameter.bounds;
  return schema;
};
// Parameter names, types, defaults and bounds come from the compiler's catalogue.
// The compiler remains authoritative for fact references and contextual bounds.
const leverSchemas = getLeverCatalogue().levers.map(lever => object({
  type: { const: lever.type },
  ...Object.fromEntries(Object.entries(lever.parameters).map(([key, parameter]) => [key, parameterSchema(parameter)])),
  sources: object(Object.fromEntries(Object.keys(lever.parameters).map(key => [key, source])))
}, ['type', 'sources', ...Object.entries(lever.parameters).filter(([, parameter]) => !parameter.optional).map(([key]) => key)]));
const route = object({ id: routeId, title: text, changes: { type: 'array', items: { oneOf: leverSchemas } } }, ['id', 'changes']);
const parts = object(Object.fromEntries(['does', 'why', 'gives', 'costs', 'check'].map(key => [key, text])), ['does', 'why', 'gives', 'costs', 'check']);
const sectionIds = ['current_position', 'ledger', 'protecting', 'inefficiencies', 'goals', 'cash_flow_after', 'net_worth_after', 'risks', 'check_next'];
const ids = { type: 'array', items: text, uniqueItems: true };
const goal = object({ goalId: text, title: text, parts, limitationIds: ids }, ['goalId', 'title', 'parts']);
const story = object({
  routeId, headline: text, summary: text, whatifs: { type: 'array', items: object({ id: text }, ['id']) },
  sections: {
    type: 'array', minItems: 9, maxItems: 9,
    items: sectionIds.map(id => object({ id: { const: id }, title: text, parts, limitationIds: ids, issues: ids, freedCash: ids, majorMoves: ids,
      risks: { type: 'array', items: object({ changeIds: ids }, ['changeIds']) },
      ...(id === 'goals' ? { goals: { type: 'array', items: goal } } : {})
    }, ['id', 'title', 'parts', ...(id === 'goals' ? ['goals'] : [])]))
  }
}, ['routeId', 'headline', 'summary', 'sections']);

export const TOOL_CATALOGUE = Object.freeze([
  { name: 'read_position', description: 'Read compact facts and story keys for current or a priced route. Ask for up to twenty keys to inspect their full source and basis.', inputSchema: object({ routeId, keys: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: text } }) },
  { name: 'read_figures', description: 'Read dated register values and their provenance.', inputSchema: object({
    offset: { type: 'integer', minimum: 0 },
    ids: { type: 'array', maxItems: 10, items: text }, kinds: { anyOf: [{ type: 'array', items: { enum: FIGURE_KINDS } }, { enum: FIGURE_KINDS }] },
    module: { enum: FIGURE_MODULES }, onDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
  }) },
  { name: 'read_explainers', description: 'Read the code-owned explainers by ID or by the figures they explain. Read-only; wording is returned unchanged.',
    inputSchema: object({ ids: { type: 'array', items: text }, figureIds: { type: 'array', items: text } }) },
  { name: 'goal_ways', description: 'Price the native ways to meet one goal at its point in a route draft. Supply route or a saved routeId; omitted route starts an empty walk. Choose a returned route and retain it with price_route.',
    inputSchema: object({ routeId, goalId: text, route }, ['goalId']) },
  { name: 'suggest_routes', description: 'Return up to five independently priced native ledger walks, with their source drafts and reasons. Choose candidates through price_route; the story still has at most three alternatives.', inputSchema: object() },
  { name: 'price_route', description: 'Price any catalogue lever through the full profile-to-plan compiler and resource ledger. Returns the ledger, route story facts with bases, issues, and setting-source checks.',
    inputSchema: { ...object({ route, candidateId: text, reason: text }), anyOf: [{ required: ['route'] }, { required: ['candidateId'] }] } },
  { name: 'balancing_moves', description: 'Find native ordinary goal moves and lever sizes for a route or saved routeId. Omitted route starts an empty draft. An explicit tradeDownHome or sellProperty type uses the native major search, optionally in a fixed year. All compiler invocations count against the engine budget.',
    inputSchema: object({ route, routeId, type: { enum: ['tradeDownHome', 'sellProperty'] }, propertyId: text, year: { type: 'integer' } }) },
  { name: 'run_whatif', description: 'Not built yet: run a sourced what-if.', unavailable: true,
    inputSchema: object({ routeId, kind: text, parameters: { type: 'object' }, sources: { type: 'object' } }, ['routeId']) },
  { name: 'missing_facts', description: 'Return missing household facts as form questions, and separate implementation gaps.', inputSchema: object() },
  { name: 'submit_story', description: 'Run the full B1.5 story checker on the selected compiled plan. Only a passing draft is accepted for analyst:open. Never releases a story.',
    inputSchema: object({ story }, ['story']) }
]);

const ajv = new Ajv({ allErrors: true, strict: false, multipleOfPrecision: 8 });
const validators = new Map(TOOL_CATALOGUE.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
export function validateToolInput(name, input) {
  const validate = validators.get(name);
  if (validate(input)) return [];
  return validate.errors.map(error => ({ code: 'invalid_input',
    path: '/input' + error.instancePath + (error.keyword === 'required' ? '/' + error.params.missingProperty
      : error.keyword === 'additionalProperties' ? '/' + error.params.additionalProperty : ''),
    message: error.message
  }));
}

export function refused(code, path, message) {
  return { ok: false, status: 'refused', refusals: [{ code, path, message }] };
}

export function budgetRefusal(caseFile, name, input) {
  if (PRICING_TOOLS.includes(name)
    && caseFile.budget.pricingCalls >= RUN_LIMITS.pricingCalls) {
    return refused('budget_exceeded', '/budget/pricingCalls', 'The plan has used its pricing tool calls.');
  }
  if (name === 'run_whatif' && (caseFile.budget.whatifsByRoute[input.routeId] ?? 0) >= RUN_LIMITS.whatifsPerRoute) {
    return refused('budget_exceeded', '/budget/whatifsByRoute/' + input.routeId, 'This route has used its what-ifs.');
  }
  if (name === 'submit_story') {
    const alternatives = new Set(Object.keys(caseFile.storyDrafts).filter(id => id !== 'current'));
    if (input.story.routeId !== 'current') alternatives.add(input.story.routeId);
    if (alternatives.size > RUN_LIMITS.routes) return refused('budget_exceeded', '/input/story/routeId', 'At most three alternatives can appear in the story.');
  }
  return null;
}
