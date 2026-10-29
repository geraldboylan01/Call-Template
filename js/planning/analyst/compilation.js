import { profileToPlanPack } from '../profile_to_plan_pack.js';
import { sha256Json } from '../utils.js';

/** Full B1 assembly, including its route-specific chapter adapter refusals. */
export function assembleCaseRoutes(caseFile, routes, { beforeCompile } = {}) {
  return profileToPlanPack(caseFile.pinned.profile, {
    confirmedRevision: caseFile.pinned.confirmedRevision, calculationDate: caseFile.pinned.calculationDate,
    clientLabel: caseFile.pinned.planPack.clientName, routes, beforeCompile
  });
}

/** The exact compilation both submission and analyst:open use. Reuse only a
 * compilation for these same pinned inputs and the same selected wire drafts.
 */
export async function compileCaseStories(caseFile, stories, execution = {}) {
  const routes = Object.keys(stories).filter(id => id !== 'current').map(id => {
    const route = caseFile.routeDrafts[id]?.route;
    if (!route) throw Object.assign(new Error('Price this story route before opening it.'), { path: '/story/' + id, code: 'unpriced_route' });
    return route;
  });
  const signature = await sha256Json({ pinHash: caseFile.pinHash, routes });
  if (caseFile.storyCompilation?.signature === signature) return caseFile.storyCompilation;
  if (!routes.length) return { signature, compilation: caseFile.pinned.currentPosition };
  if (routes.length === 1) {
    const compiled = caseFile.pricedRoutes[routes[0].id];
    const priced = compiled?.source?.normalizedPlanPack?.routes.find(row => row.id === routes[0].id);
    if (compiled?.status === 'compiled' && JSON.stringify(priced?.changes) === JSON.stringify(routes[0].changes)) return { signature, compilation: compiled };
  }
  const assembly = await assembleCaseRoutes(caseFile, routes, execution);
  if (assembly.compilation?.status !== 'compiled') throw Object.assign(new Error('The stories cannot share a compiled plan.'), {
    path: '/story', code: 'engine_refusal', diagnostics: assembly.routeRefusals ?? assembly.missingFacts.map(row => ({ path: row.fieldPath, code: row.factId, message: row.reason }))
  });
  return { signature, compilation: assembly.compilation };
}
