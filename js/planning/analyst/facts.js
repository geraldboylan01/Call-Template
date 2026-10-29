import { readPlanPosition } from '../plan_pack/story_facts.js';
import { compactStoryFacts, storyFactRegistry } from '../../plan_story_registry.js';

/** One story key set, shared with submission and the compiled-plan screen. */
export function compiledFacts(compiled, routeId) {
  const position = readPlanPosition(compiled);
  const selected = position.routes.find(row => row.routeId === routeId);
  if (!selected) throw Object.assign(new Error('This compilation has no such route.'), { path: '/input/routeId', code: 'unpriced_route' });
  const ledger = compiled.resourceLedger.routes.find(row => row.routeId === routeId);
  const route = compiled.routes.find(row => row.id === routeId);
  const chapters = Object.entries(route.chapterCases).map(([chapter, caseId]) => {
    const entry = compiled.chapters.find(row => row.id === chapter).cases.find(row => row.id === caseId);
    return { chapter, caseId, nativeCaseId: entry.nativeCaseId, metrics: entry.metrics };
  });
  const ledgerSummary = Object.fromEntries([
    'status', 'goalFundingStatus', 'openingCash', 'recordedCash', 'cashAvailableAfterReserve',
    'cashAllocated', 'cashRemaining', 'reserveProtected', 'baselineLeftOver', 'balanced', 'goalsCovered'
  ].filter(key => Object.hasOwn(ledger, key)).map(key => [key, ledger[key]]));
  ledgerSummary.reserve = ledger.reserve?.protectedAmount ?? null;
  return { position, selected, registry: storyFactRegistry(position, routeId), storyFacts: compactStoryFacts(position, routeId), chapters, ledgerSummary };
}
