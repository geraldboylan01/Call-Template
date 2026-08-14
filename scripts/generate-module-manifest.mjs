// Compiles the adviser-authored module manifests in docs/modules/*.md into
// js/planning/module_manifest.generated.js.
//
// This ships INERT: nothing reads the generated manifest yet. Its whole job for
// now is the parity assertion below, which proves the authored data reproduces
// today's live routing, availability and intake contracts exactly. P2 switches
// buildGoalModulePlan onto it and deletes the hand-maintained tables.
//
// The manifest set is the COMPLETE registered catalogue, not the consumer-
// routable subset. Availability, routing eligibility and implementation status
// are recorded as independent axes, because a module can be adviser-available
// with no engine, no fact-find and no consumer route — and must not disappear
// from the adviser portal for any of those reasons. See
// docs/module-catalogue-reconciliation.md.
//
// Mirrors generate-planning-playbook-manifest.mjs: a marker locates the machine
// data, prose is compiled alongside it, and `--check` fails CI on drift.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  GOAL_TYPES,
  MODULE_IDS,
  buildGoalModulePlan,
  createHouseholdProfile,
  getPlanningModuleDefinition,
  listPlanningModuleDefinitions,
  normalizeHouseholdProfile
} from '../js/planning/index.js';
import { isConsumerVisibleModule } from '../js/planning/module_availability.js';
import {
  REQUIRED_CONSUMER_LANGUAGE_FIELDS,
  parseAuthoredModuleDocument,
  validateModuleManifest
} from '../js/planning/module_manifest_validation.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const moduleDir = resolve(root, 'docs/modules');
const outputPath = resolve(root, 'js/planning/module_manifest.generated.js');

function fail(message) {
  throw new Error(message);
}
/**
 * Derive today's effective conversational routing by running the live planner
 * for one goal at a time. Behavioural rather than structural on purpose: the
 * parity check must survive P2 deleting the ROUTES table it would otherwise
 * have imported.
 */
function liveRouting(candidateManifest) {
  const nowIso = '2026-07-25T00:00:00.000Z';
  const byModule = new Map();
  for (const type of GOAL_TYPES) {
    const base = createHouseholdProfile({
      profileId: 'manifest-parity',
      nowIso,
      calculationDateIso: nowIso.slice(0, 10)
    });
    const profile = normalizeHouseholdProfile({
      ...base,
      revision: 1,
      // 45 keeps the household out of the early-life branch, so the balance
      // sheet's default injection is visible where it applies.
      primaryPerson: { ...base.primaryPerson, age: 45 },
      goals: [{ goalId: 'g1', type, title: type, priority: 'high', status: 'active' }]
    });
    const plan = buildGoalModulePlan(profile, {
      allowedModuleIds: Object.values(MODULE_IDS),
      candidateManifest
    });
    for (const slot of plan.moduleSlots) {
      if (!byModule.has(slot.moduleId)) byModule.set(slot.moduleId, []);
      byModule.get(slot.moduleId).push({ type, source: slot.source });
    }
  }
  return byModule;
}

function assertParity(entries) {
  const routing = liveRouting(entries);
  const divergences = [];
  const byModuleId = new Map(entries.map((entry) => [entry.moduleId, entry]));

  // ANTI-NARROWING. P1 manifested only the intake-approved modules and silently
  // dropped six adviser-available ones. From P6 the adviser module admin resolves
  // its list from this registry, so an incomplete manifest set would make those
  // modules disappear from the portal. The catalogue must stay complete.
  for (const definition of listPlanningModuleDefinitions()) {
    if (!byModuleId.has(definition.id)) {
      fail(`${definition.id} is a registered planning module with no manifest in docs/modules/.\n`
        + '  Every registered module must be catalogued, including adviser-only and template-only\n'
        + '  modules. See docs/module-catalogue-reconciliation.md.');
    }
  }

  for (const entry of entries) {
    const definition = getPlanningModuleDefinition(entry.moduleId);
    if (!definition) fail(`${entry.moduleId} is not a registered planning module.`);

    // --- Identity and availability: asserted for every module ---
    if (entry.name !== definition.name) fail(`${entry.moduleId}: manifest name does not match the registry.`);
    if (entry.kind !== definition.kind) fail(`${entry.moduleId}: manifest kind does not match the registry.`);
    if (entry.status !== definition.status) fail(`${entry.moduleId}: manifest status does not match the registry.`);
    if (entry.availability.adviser !== (definition.adviserAvailable === true)) {
      fail(`${entry.moduleId}: availability.adviser does not match the registry.`);
    }
    if (entry.availability.consumer !== (definition.consumerAvailable === true)) {
      fail(`${entry.moduleId}: availability.consumer does not match the registry.`);
    }
    if (entry.implementation.intakeContract !== definition.intakeContract.status) {
      fail(`${entry.moduleId}: implementation.intakeContract does not match the registry.`);
    }
    if (JSON.stringify(entry.conversationGuidance || []) !== JSON.stringify(definition.conversationGuidance || [])) {
      fail(`${entry.moduleId}: conversationGuidance does not match the JavaScript module registry.`);
    }
    const hasEngine = typeof definition.run === 'function';
    if (hasEngine !== (entry.implementation.status === 'engine')) {
      fail(`${entry.moduleId}: implementation.status is "${entry.implementation.status}" but the registry `
        + `${hasEngine ? 'has' : 'has no'} a run() engine.`);
    }

    // --- Intake facts: only meaningful where the contract is approved ---
    if (definition.intakeContract.status === 'approved') {
      const registryFacts = [...definition.intakeContract.semanticFactIds].sort();
      const manifestFacts = [...entry.requiredFacts].sort();
      if (JSON.stringify(registryFacts) !== JSON.stringify(manifestFacts)) {
        fail(`${entry.moduleId}: requiredFacts do not match the module intake contract.\n`
          + `  registry: ${registryFacts.join(', ')}\n  manifest: ${manifestFacts.join(', ')}`);
      }
    } else if (entry.requiredFacts.length > 0) {
      fail(`${entry.moduleId}: has an incomplete intake contract, so it must not declare requiredFacts.`);
    }

    // --- Routing: asserted against live behaviour for every module, so that a
    // module claiming to be unroutable really is ---
    const routes = routing.get(entry.moduleId) || [];

    // A module the consumer cannot see is filtered out before a plan is built,
    // so its declared routes are correctly absent from live plans. Assert the
    // property that actually matters — it never reaches a plan — and compare
    // declared routes only for modules that can appear.
    const consumerVisible = isConsumerVisibleModule(entry.moduleId, { candidateManifest: entries });
    if (!consumerVisible) {
      if (routes.length > 0) {
        fail(`${entry.moduleId} is not consumer-visible but still reached a plan: `
          + routes.map((route) => route.type).join(', '));
      }
    } else {
      const liveGoals = routes
        .filter((route) => route.source === 'goal_direct' || route.source === 'goal_companion')
        .map((route) => `${route.type}:${route.source === 'goal_direct' ? 'direct' : 'companion'}`)
        .sort();
      const manifestGoals = entry.routing.goals.map((goal) => `${goal.type}:${goal.role}`).sort();
      if (JSON.stringify(liveGoals) !== JSON.stringify(manifestGoals)) {
        fail(`${entry.moduleId}: manifest routing.goals do not reproduce live routing.\n`
          + `  live:     ${liveGoals.join(', ') || '(none)'}\n  manifest: ${manifestGoals.join(', ') || '(none)'}`);
      }
      const livePinned = routes.some((route) => route.source === 'balance_sheet_default') ? 'when_eligible' : 'never';
      if (entry.routing.pinned !== livePinned) {
        fail(`${entry.moduleId}: routing.pinned is "${entry.routing.pinned}" but live routing behaves as "${livePinned}".`);
      }
      if (entry.routing.consumerRoutable !== (routes.length > 0)) {
        fail(`${entry.moduleId}: routing.consumerRoutable is ${entry.routing.consumerRoutable} `
          + `but live routing ${routes.length > 0 ? 'does' : 'does not'} select it.`);
      }
    }

    // Recorded, not fatal. `applicableGoals` is a third representation that no
    // routing code reads; P2 resolves it. Surfacing the gap here stops it being
    // silently inherited.
    const declared = [...definition.applicableGoals].sort();
    const routed = [...new Set(entry.routing.goals.map((goal) => goal.type))].sort();
    if (JSON.stringify(declared) !== JSON.stringify(routed)) {
      divergences.push({
        moduleId: entry.moduleId,
        registryApplicableGoals: declared,
        routedGoals: routed
      });
    }
  }
  return divergences;
}

const files = readdirSync(moduleDir).filter((name) => name.endsWith('.md')).sort();
if (files.length === 0) fail('docs/modules contains no module manifests.');

const entries = files.map((name) => {
  const source = readFileSync(resolve(moduleDir, name), 'utf8');
  const label = `docs/modules/${name}`;
  const authored = parseAuthoredModuleDocument(source, label);
  const manifest = authored.manifest;
  if (`${manifest.moduleId}.md` !== name) fail(`${label} does not match its moduleId.`);
  const definition = getPlanningModuleDefinition(manifest.moduleId);
  return {
    ...manifest,
    ...(definition?.conversationGuidance?.length
      ? { conversationGuidance: [...definition.conversationGuidance] }
      : {}),
    ...authored.prose
  };
}).sort((left, right) => left.moduleId.localeCompare(right.moduleId));

const duplicates = entries.map((entry) => entry.moduleId)
  .filter((id, index, all) => all.indexOf(id) !== index);
if (duplicates.length) fail(`Duplicate module manifests: ${[...new Set(duplicates)].join(', ')}`);

// Permanent negative assertion: each required client-language field is removed
// in turn from a real approved manifest and must be rejected by the same
// validator used for authored files. This prevents a future refactor from
// accidentally reducing the build check to a positive-presence assertion.
const validationFixture = entries.find((entry) => (
  entry.availability.platformConsumerApproved === true
  && entry.implementation.hasRunnableEngine === true
));
if (!validationFixture) fail('No approved runnable module is available for consumer-language validation.');
for (const field of REQUIRED_CONSUMER_LANGUAGE_FIELDS) {
  const withoutField = {
    ...validationFixture,
    consumerLanguage: { ...validationFixture.consumerLanguage }
  };
  delete withoutField.consumerLanguage[field];
  let rejected = false;
  try {
    validateModuleManifest(withoutField, `${validationFixture.moduleId} negative validation`);
  } catch (error) {
    if (!String(error?.message || '').includes(`consumerLanguage.${field}`)) throw error;
    rejected = true;
  }
  if (!rejected) fail(`Removing consumerLanguage.${field} did not fail manifest validation.`);
}

const divergences = assertParity(entries);

const source = `/* Generated by scripts/generate-module-manifest.mjs. Do not edit. */\n`
  + `export const MODULE_MANIFEST_VERSION = 'planeir-module-manifest-1.2.0';\n\n`
  + `export const MODULE_MANIFEST = Object.freeze(${JSON.stringify(entries, null, 2)}.map(Object.freeze));\n`;

if (process.argv.includes('--check')) {
  const current = readFileSync(outputPath, 'utf8');
  if (current !== source) fail('Generated module manifest is stale. Run `npm run generate:module-manifest`.');
  console.info(`[ModuleManifest] ${entries.length} manifests match live routing and intake contracts.`);
  console.info(`[ModuleManifest] ${REQUIRED_CONSUMER_LANGUAGE_FIELDS.length} required descriptor deletions were rejected by negative validation.`);
} else {
  writeFileSync(outputPath, source);
  console.info(`[ModuleManifest] wrote ${entries.length} entries to ${outputPath}.`);
}

if (divergences.length > 0) {
  console.info('[ModuleManifest] registry applicableGoals diverge from routed goals (recorded for P2, not fatal):');
  for (const item of divergences) {
    console.info(`    ${item.moduleId}`);
    console.info(`      applicableGoals: ${item.registryApplicableGoals.join(', ') || '(none)'}`);
    console.info(`      routed:          ${item.routedGoals.join(', ') || '(none)'}`);
  }
}
