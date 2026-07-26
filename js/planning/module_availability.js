/**
 * Effective consumer availability.
 *
 * "Can a consumer see this module?" used to be one ambiguous boolean, which
 * conflated four independent questions: does it run, has the platform approved
 * it, has this adviser switched it on, and does it fit this client. Collapsing
 * those meant a module could look consumer-ready because it happened to have an
 * engine.
 *
 * Consumer visibility is a HARD filter. A module that fails any gate must be
 * completely invisible in the consumer journey — not described as deferred,
 * adviser-only, potentially useful or available later. Advisers still see every
 * module, with its status, in the adviser catalogue.
 */

import { MODULE_MANIFEST } from './module_manifest.generated.js';

export const CONSUMER_VISIBILITY_POLICY_VERSION = 'consumer-visibility-1.0.0';

/** Ordered so the first failure is the most fundamental. */
export const CONSUMER_GATES = Object.freeze([
  'runnable_engine',
  'platform_consumer_approved',
  'adviser_consumer_enabled',
  'release_allowlist'
]);

const MANIFEST_BY_ID = new Map(MODULE_MANIFEST.map((entry) => [entry.moduleId, entry]));

export function getModuleManifest(moduleId) {
  return MANIFEST_BY_ID.get(moduleId) || null;
}

export function listModuleManifests() {
  return [...MODULE_MANIFEST];
}

/**
 * Resolve the four independent controls into one decision plus the reason.
 *
 * @param {string} moduleId
 * @param {object} [options]
 * @param {Set<string>|string[]|null} [options.allowedModuleIds] release allowlist
 * @param {Record<string, boolean>} [options.adviserOverrides] adviser enablement overrides
 */
export function effectiveConsumerAvailability(moduleId, {
  allowedModuleIds = null,
  adviserOverrides = null
} = {}) {
  const entry = getModuleManifest(moduleId);
  if (!entry) {
    return Object.freeze({ visible: false, blockedBy: 'unknown_module', gates: Object.freeze({}) });
  }
  const adviserEnabled = adviserOverrides && Object.hasOwn(adviserOverrides, moduleId)
    ? adviserOverrides[moduleId] === true
    : entry.availability.adviserConsumerEnabled === true;
  const allowed = allowedModuleIds
    ? (allowedModuleIds instanceof Set ? allowedModuleIds : new Set(allowedModuleIds))
    : null;
  const gates = Object.freeze({
    runnable_engine: entry.implementation.hasRunnableEngine === true,
    platform_consumer_approved: entry.availability.platformConsumerApproved === true,
    adviser_consumer_enabled: adviserEnabled,
    release_allowlist: allowed ? allowed.has(moduleId) : true
  });
  const blockedBy = CONSUMER_GATES.find((gate) => gates[gate] !== true) || null;
  return Object.freeze({ visible: blockedBy === null, blockedBy, gates });
}

/** The hard filter. Anything false here must never reach a consumer surface. */
export function isConsumerVisibleModule(moduleId, options) {
  return effectiveConsumerAvailability(moduleId, options).visible === true;
}

/**
 * Server-side validation for the adviser module-management surface.
 *
 * An adviser may always switch a module OFF — that only narrows what a consumer
 * sees. Switching one ON requires platform approval and a runnable engine, so a
 * UI or API cannot expose an unapproved analysis by flipping a flag.
 */
export function validateAdviserConsumerToggle(moduleId, enabled) {
  const entry = getModuleManifest(moduleId);
  if (!entry) {
    return Object.freeze({ ok: false, code: 'unknown_module', message: 'That module does not exist.' });
  }
  if (enabled !== true) {
    return Object.freeze({ ok: true, code: null, message: '' });
  }
  if (entry.implementation.hasRunnableEngine !== true) {
    return Object.freeze({
      ok: false,
      code: 'module_not_runnable',
      message: `${entry.name} has no deterministic engine, so it cannot be enabled for consumers.`
    });
  }
  if (entry.availability.platformConsumerApproved !== true) {
    return Object.freeze({
      ok: false,
      code: 'module_not_platform_approved',
      message: `${entry.name} has not passed platform consumer approval, so it cannot be enabled for consumers.`
    });
  }
  return Object.freeze({ ok: true, code: null, message: '' });
}

/**
 * Adviser-facing catalogue row. Deliberately exposes everything the consumer
 * journey must never see, because the adviser surface is where approval and
 * enablement status belong.
 */
export function adviserCatalogueEntry(moduleId, options) {
  const entry = getModuleManifest(moduleId);
  if (!entry) return null;
  const effective = effectiveConsumerAvailability(moduleId, options);
  return Object.freeze({
    moduleId: entry.moduleId,
    name: entry.name,
    implementationType: entry.implementation.status,
    hasRunnableEngine: entry.implementation.hasRunnableEngine === true,
    adviserAvailable: entry.availability.adviser === true,
    platformConsumerApproved: entry.availability.platformConsumerApproved === true,
    adviserConsumerEnabled: entry.availability.adviserConsumerEnabled === true,
    effectiveConsumerVisible: effective.visible,
    blockedBy: effective.blockedBy,
    releaseStatus: entry.status,
    clientBenefit: entry.clientBenefit || '',
    eligibilitySummary: Object.freeze({
      goals: Object.freeze((entry.routing.goals || []).map((goal) => goal.type)),
      suggestedWhen: Object.freeze((entry.routing.suggestedWhen || []).map((rule) => rule.reason)),
      requireAll: Object.freeze([...(entry.eligibility?.requireAll || [])]),
      excludeIf: Object.freeze([...(entry.eligibility?.excludeIf || [])])
    }),
    requiredFacts: Object.freeze([...entry.requiredFacts]),
    intakeContract: entry.implementation.intakeContract,
    remediation: Object.freeze([...(entry.consumerReadiness?.blockingItems || [])]),
    readinessStatus: entry.consumerReadiness?.status || 'not_reviewed'
  });
}

export function listAdviserCatalogue(options) {
  return MODULE_MANIFEST
    .filter((entry) => entry.availability.adviser === true)
    .map((entry) => adviserCatalogueEntry(entry.moduleId, options));
}
