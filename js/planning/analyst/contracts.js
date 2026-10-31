export * from './tool_catalogue.js';
import * as validators from './tool_validation.generated.js';
import { PRICING_TOOLS, RUN_LIMITS } from './tool_catalogue.js';

export function validateToolInput(name, input) {
  const validate = validators[name];
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
