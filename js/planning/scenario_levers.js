/**
 * What a "what-if" is allowed to change, per module.
 *
 * THE LEVERS ARE DECLARED IN THE MANIFESTS, NOT HERE. Each scenario-aware
 * module's `implementation.scenarioLevers` in docs/modules/<id>.md says which
 * assumptions may move, within what range, and what each one MEANS in a
 * client's terms. This file only reads them. That placement is the whole point:
 * the live prompt is generated from the manifests and is byte-stable, so
 * teaching the model a new lever costs a manifest edit and nothing at runtime,
 * where writing the same thing into the per-turn prompt would be paid for on
 * every turn of every call forever.
 *
 * WHY A SECOND SANITISER EXISTS ALONGSIDE THE HOUSE-PURCHASE ONE. That one
 * (js/house_purchase/engine.js) deliberately DROPS anything invalid, because it
 * backs browser controls where a half-typed number should mean "use the base
 * case" rather than blank the screen. Silence is the right answer there and the
 * wrong answer here: a model that sets `retirement_age=95` and is told nothing
 * will believe it ran the scenario it asked for and describe results that came
 * from the base case. So this defaults to strict and says what was wrong.
 */

import { MODULE_MANIFEST } from './module_manifest.generated.js';

const TYPES = {
  integer: { check: (value) => Number.isInteger(value), describe: 'a whole number' },
  money: { check: (value) => Number.isFinite(value), describe: 'an amount in euro' },
  rate: { check: (value) => Number.isFinite(value), describe: 'a rate as a decimal (0.05 = 5%)' },
  number: { check: (value) => Number.isFinite(value), describe: 'a number' }
};

const manifestFor = (moduleId) => MODULE_MANIFEST.find((entry) => entry.moduleId === moduleId) || null;

/** The declared levers for a module, or an empty list if it is not scenario-aware. */
export function scenarioLeversFor(moduleId) {
  return manifestFor(moduleId)?.implementation?.scenarioLevers || [];
}

/** Modules that can actually take a what-if today. */
export function scenarioAwareModuleIds() {
  return MODULE_MANIFEST
    .filter((entry) => (entry.implementation?.scenarioLevers || []).length > 0)
    .map((entry) => entry.moduleId);
}

export class ScenarioLeverError extends Error {
  constructor(message, { moduleId, leverId } = {}) {
    super(message);
    this.name = 'ScenarioLeverError';
    this.code = 'scenario_lever_invalid';
    this.moduleId = moduleId || null;
    this.leverId = leverId || null;
  }
}

/**
 * Validate a set of what-if overrides against a module's declared levers.
 *
 * @param {string} moduleId
 * @param {Object} overrides
 * @param {Object} [options]
 * @param {boolean} [options.strict] throw on anything unusable (default). Pass
 *   false for browser controls, where an incomplete value means "base case".
 * @returns {Object} the accepted overrides
 * @throws {ScenarioLeverError} in strict mode, naming the lever and the range
 */
export function sanitizeScenarioOverrides(moduleId, overrides, { strict = true } = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return {};
  const levers = scenarioLeversFor(moduleId);
  if (levers.length === 0) {
    if (strict) {
      throw new ScenarioLeverError(
        `${moduleId} cannot take a what-if — it declares no scenario levers.`,
        { moduleId }
      );
    }
    return {};
  }
  const byId = new Map(levers.map((lever) => [lever.id, lever]));
  const accepted = {};
  for (const [key, raw] of Object.entries(overrides)) {
    const lever = byId.get(key);
    if (!lever) {
      if (strict) {
        throw new ScenarioLeverError(
          `${moduleId} has no "${key}" to change. It can vary: ${levers.map((item) => item.id).join(', ')}.`,
          { moduleId, leverId: key }
        );
      }
      continue;
    }
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    const type = TYPES[lever.type] || TYPES.number;
    const withinRange = Number.isFinite(value)
      && value >= (Number.isFinite(lever.min) ? lever.min : -Infinity)
      && value <= (Number.isFinite(lever.max) ? lever.max : Infinity);
    if (!type.check(value) || !withinRange) {
      if (strict) {
        throw new ScenarioLeverError(
          `${moduleId} "${key}" must be ${type.describe} between ${lever.min} and ${lever.max}`
          + ` — got ${JSON.stringify(raw)}.`,
          { moduleId, leverId: key }
        );
      }
      continue;
    }
    accepted[key] = value;
  }
  return accepted;
}

/**
 * The scenario section of the live prompt, GENERATED FROM THE MANIFESTS.
 *
 * Written out here rather than hand-maintained in catalogue_prompt.js so that
 * the prompt cannot drift from what the engines will actually accept — the same
 * discipline `registryFieldList()` already applies to collection field names.
 * It joins the cached, byte-stable prefix, so its length is paid once per
 * session and then served from cache.
 */
export function scenarioPromptSection() {
  const ids = scenarioAwareModuleIds();
  if (ids.length === 0) return '';
  const lines = [
    'WHAT-IF ANALYSES. When someone asks what would happen if something were different',
    '-- retiring earlier, saving more, a cheaper house -- that is not a new analysis.',
    'It is the same one re-run on a changed assumption. Run the base case first so',
    'there is something to compare against, then re-run with the change.',
    'Only these analyses can vary, and only these assumptions:'
  ];
  for (const moduleId of ids) {
    for (const lever of scenarioLeversFor(moduleId)) {
      lines.push(`- ${moduleId}.${lever.id}: ${lever.means} (${lever.min} to ${lever.max})`);
    }
  }
  return lines.join('\n');
}
