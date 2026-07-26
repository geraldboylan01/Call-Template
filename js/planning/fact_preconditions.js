/**
 * Fact preconditions: questions that cannot sensibly be asked of this client.
 *
 * A module's intake contract lists every fact it can use. Some of those facts
 * are unanswerable for particular people — asking a sole trader what their
 * employer contributes to a pension is the clearest example, and was a live
 * failure. A precondition marks such a fact as not applicable, so it never
 * enters a question queue rather than being filtered out at the point of speech.
 *
 * Preconditions read accumulated profile state through the same circumstance
 * conditions the manifest uses everywhere else.
 */

import { getModuleManifest } from './module_availability.js';
import { getSemanticFactDefinition } from './semantic_facts.js';
import { readJsonPointer } from './utils.js';

function circumstanceValue(profile, factId) {
  const pathPattern = getSemanticFactDefinition(factId)?.mappings?.[0]?.pathPattern;
  return pathPattern ? readJsonPointer(profile, pathPattern) : undefined;
}

function conditionHolds(profile, condition) {
  if (!condition || typeof condition !== 'object') return false;
  const value = circumstanceValue(profile, condition.fact);
  if (value === undefined || value === null) return false;
  if (Array.isArray(condition.in)) return condition.in.includes(value);
  if (condition.equals !== undefined) return value === condition.equals;
  if (Number.isFinite(condition.min)) return Number.isFinite(Number(value)) && Number(value) >= condition.min;
  return false;
}

/**
 * Why a fact is not applicable to this client, or null when it is applicable.
 * `moduleId` may be omitted to check every module that requires the fact.
 */
export function factPreconditionBlock(factId, profile, moduleId = null) {
  const entries = moduleId
    ? [getModuleManifest(moduleId)].filter(Boolean)
    : [];
  for (const entry of entries) {
    const precondition = entry.factPreconditions?.[factId];
    if (!precondition?.skipWhen) continue;
    if (conditionHolds(profile, precondition.skipWhen)) {
      return { moduleId: entry.moduleId, factId, reason: precondition.reason || '' };
    }
  }
  return null;
}

export function isFactApplicable(factId, profile, moduleId = null) {
  return factPreconditionBlock(factId, profile, moduleId) === null;
}

/**
 * Drop facts this client cannot be asked about.
 * @param {{factId: string, moduleId?: string}[]} missing
 */
export function withoutInapplicableFacts(missing, profile) {
  return (missing || []).filter((item) => (
    isFactApplicable(item.factId, profile, item.moduleId || null)
  ));
}
