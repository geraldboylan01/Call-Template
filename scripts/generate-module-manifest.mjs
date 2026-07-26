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
  getSemanticFactDefinition,
  listPlanningModuleDefinitions,
  normalizeHouseholdProfile
} from '../js/planning/index.js';
import { isConsumerVisibleModule } from '../js/planning/module_availability.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const moduleDir = resolve(root, 'docs/modules');
const outputPath = resolve(root, 'js/planning/module_manifest.generated.js');
const MANIFEST_MARKER = '<!-- planeir-module-manifest -->';
const MODULE_ID_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;
const PINNED_VALUES = new Set(['never', 'when_eligible']);
const GOAL_ROLES = new Set(['direct', 'companion']);
const IMPLEMENTATION_STATUSES = new Set([
  // a deterministic run() exists
  'engine',
  // an adviser playbook/renderer exists but no engine and no approved fact-find
  'template_only',
  // selects other modules rather than calculating (retirement_goal_analysis)
  'routing_label',
  // composed across scenario-aware modules, never selectable (scenario_analysis)
  'capability',
  // named in the catalogue, not yet built
  'planned'
]);
const INTAKE_STATUSES = new Set(['approved', 'incomplete']);
const READINESS_STATUSES = new Set(['approved', 'remediation_required', 'not_reviewed', 'not_applicable']);
// Mirrors PROFILE_HAS_PREDICATES in goal_plan.js.
const PROFILE_HAS_KINDS = new Set([
  'cash', 'pension', 'property', 'business', 'dependants', 'mortgage', 'loan'
]);
const MAX_PROSE = 1_200;
const MAX_SIGNAL = 160;
const MAX_SIGNALS = 12;
// Adviser prose is semi-trusted: it is written by a colleague, but it reaches a
// model prompt, so it must not be able to carry instructions.
const INSTRUCTION_LIKE = /\b(?:ignore (?:all|any|previous)|disregard (?:all|any|previous)|system prompt|you are now|act as|new instructions?)\b/i;

function fail(message) {
  throw new Error(message);
}

function proseSection(source, heading, label, { required = true } = {}) {
  const pattern = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`, 'im');
  const match = pattern.exec(source);
  const text = (match?.[1] || '').trim();
  if (!text) {
    if (required) fail(`${label} is missing the "## ${heading}" section.`);
    return '';
  }
  if (text.length > MAX_PROSE) fail(`${label} section "${heading}" exceeds ${MAX_PROSE} characters.`);
  if (INSTRUCTION_LIKE.test(text)) fail(`${label} section "${heading}" contains instruction-like text.`);
  return text.replace(/\s+/g, ' ').trim();
}

function clientSignals(source, label) {
  const pattern = /^##\s+Client signals\s*$([\s\S]*?)(?=^##\s|\Z)/im;
  const block = (pattern.exec(source)?.[1] || '').trim();
  if (/^_none recorded\._$/i.test(block)) return [];
  const signals = [...block.matchAll(/^-\s*"([^"]+)"\s*$/gm)].map((item) => item[1].trim());
  for (const signal of signals) {
    if (!signal || signal.length > MAX_SIGNAL) fail(`${label} has an invalid client signal.`);
    if (INSTRUCTION_LIKE.test(signal)) fail(`${label} has an instruction-like client signal.`);
  }
  if (signals.length > MAX_SIGNALS) fail(`${label} lists more than ${MAX_SIGNALS} client signals.`);
  return signals;
}

function parseManifest(source, label) {
  const markerIndex = source.indexOf(MANIFEST_MARKER);
  if (markerIndex < 0) fail(`${label} is missing the ${MANIFEST_MARKER} marker.`);
  const fenced = /```json\s*([\s\S]*?)```/.exec(source.slice(markerIndex));
  if (!fenced) fail(`${label} has no JSON block after its manifest marker.`);
  let manifest;
  try {
    manifest = JSON.parse(fenced[1]);
  } catch (_error) {
    fail(`${label} contains invalid manifest JSON.`);
  }
  if (!MODULE_ID_PATTERN.test(manifest.moduleId || '')) fail(`${label} has an invalid moduleId.`);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.manifestVersion || '')) fail(`${label} has an invalid manifestVersion.`);

  const availability = manifest.availability || {};
  if (typeof availability.adviser !== 'boolean') fail(`${label} has a non-boolean availability.adviser.`);
  if (typeof availability.consumer !== 'boolean') fail(`${label} has a non-boolean availability.consumer.`);
  if (typeof availability.platformConsumerApproved !== 'boolean') {
    fail(`${label} has a non-boolean availability.platformConsumerApproved.`);
  }
  if (typeof availability.adviserConsumerEnabled !== 'boolean') {
    fail(`${label} has a non-boolean availability.adviserConsumerEnabled.`);
  }
  // The invariant the adviser UI and API must also enforce server-side: a module
  // cannot be switched on for consumers unless the platform approved it and it
  // actually runs.
  if (availability.adviserConsumerEnabled && !availability.platformConsumerApproved) {
    fail(`${label} is adviser-enabled for consumers without platform consumer approval.`);
  }
  if (availability.platformConsumerApproved && manifest.implementation?.hasRunnableEngine !== true) {
    fail(`${label} is platform-consumer-approved without a runnable engine.`);
  }
  // Legacy field must stay consistent with the authoritative controls while it
  // exists, so nothing reading it during migration sees a different answer.
  const derivedConsumer = availability.platformConsumerApproved === true
    && availability.adviserConsumerEnabled === true
    && manifest.implementation?.hasRunnableEngine === true;
  if (availability.consumer !== derivedConsumer) {
    fail(`${label}: legacy availability.consumer (${availability.consumer}) disagrees with the `
      + `authoritative controls (${derivedConsumer}).`);
  }

  const readiness = manifest.consumerReadiness || {};
  if (!READINESS_STATUSES.has(readiness.status)) fail(`${label} has an invalid consumerReadiness.status.`);
  if (readiness.status === 'remediation_required' && (readiness.blockingItems || []).length === 0) {
    fail(`${label} requires remediation but lists no blocking items.`);
  }
  if (availability.platformConsumerApproved && readiness.status !== 'approved') {
    fail(`${label} is platform-consumer-approved but its readiness review is "${readiness.status}".`);
  }
  // A module a consumer can be offered must be able to explain what it does for
  // them, in their language.
  if (availability.platformConsumerApproved && !String(manifest.clientBenefit || '').trim()) {
    fail(`${label} is consumer-approved but has no clientBenefit descriptor.`);
  }

  const implementation = manifest.implementation || {};
  if (!IMPLEMENTATION_STATUSES.has(implementation.status)) {
    fail(`${label} has an invalid implementation.status.`);
  }
  if (!INTAKE_STATUSES.has(implementation.intakeContract)) {
    fail(`${label} has an invalid implementation.intakeContract.`);
  }
  if (typeof implementation.hasRunnableEngine !== 'boolean') {
    fail(`${label} has a non-boolean implementation.hasRunnableEngine.`);
  }
  if (typeof implementation.scenarioAware !== 'boolean') {
    fail(`${label} has a non-boolean implementation.scenarioAware.`);
  }

  const routing = manifest.routing || {};
  if (typeof routing.consumerRoutable !== 'boolean') fail(`${label} has a non-boolean routing.consumerRoutable.`);
  if (!PINNED_VALUES.has(routing.pinned)) fail(`${label} has an invalid routing.pinned value.`);
  if (!Number.isInteger(routing.priorityBoost)) fail(`${label} has a non-integer routing.priorityBoost.`);
  for (const goal of [...(routing.goals || []), ...(routing.adviserGoals || [])]) {
    if (!GOAL_TYPES.includes(goal.type)) fail(`${label} references unknown goal ${goal.type}.`);
    if (!GOAL_ROLES.has(goal.role)) fail(`${label} goal ${goal.type} has an invalid role.`);
    if (goal.requiresFact !== undefined && !getSemanticFactDefinition(goal.requiresFact)) {
      fail(`${label} goal ${goal.type} requires unknown fact ${goal.requiresFact}.`);
    }
  }
  // suggestedWhen drives circumstance-based suggestion. Every rule must carry a
  // client-facing reason, because a suggestion is only ever offered out loud —
  // it must never widen what runs without being explained and confirmed.
  for (const rule of routing.suggestedWhen || []) {
    const reason = typeof rule.reason === 'string' ? rule.reason.trim() : '';
    if (!reason) fail(`${label} has a suggestion rule with no client-facing reason.`);
    if (reason.length > MAX_PROSE) fail(`${label} has an over-long suggestion reason.`);
    if (INSTRUCTION_LIKE.test(reason)) fail(`${label} has an instruction-like suggestion reason.`);
    if (!Array.isArray(rule.anyOf) || rule.anyOf.length === 0) {
      fail(`${label} has a suggestion rule with no conditions.`);
    }
    for (const condition of rule.anyOf) {
      if (typeof condition.profileHas === 'string') {
        if (!PROFILE_HAS_KINDS.has(condition.profileHas)) {
          fail(`${label} suggestion uses unknown profileHas "${condition.profileHas}".`);
        }
        continue;
      }
      if (!getSemanticFactDefinition(condition.fact)) {
        fail(`${label} suggestion references unknown fact ${condition.fact}.`);
      }
      if (!Array.isArray(condition.in) && condition.equals === undefined && !Number.isFinite(condition.min)) {
        fail(`${label} suggestion condition for ${condition.fact} has no comparison.`);
      }
    }
  }
  if (implementation.status === 'capability' && (routing.suggestedWhen || []).length > 0) {
    fail(`${label} is a capability and must not be suggestible.`);
  }

  // adviserGoals are the extra edges the execution-time router recommends,
  // covering adviser-only analyses that consumer goal routing deliberately
  // never selects. A capability has no edges of either kind.
  if (implementation.status === 'capability' && (routing.adviserGoals || []).length > 0) {
    fail(`${label} is a capability and must not carry adviser goals.`);
  }

  // A capability is not a module. Scenario handling is composed over
  // scenario-aware modules; letting it carry routes or adviser availability
  // would reintroduce it as a selectable analysis.
  if (implementation.status === 'capability') {
    if (routing.consumerRoutable || (routing.goals || []).length > 0) {
      fail(`${label} is a capability and must not be consumer-routable or carry goals.`);
    }
    if (availability.adviser || availability.consumer) {
      fail(`${label} is a capability and must not be offered to advisers or consumers.`);
    }
  }
  if (routing.consumerRoutable && !availability.adviser) {
    fail(`${label} is consumer-routable but not adviser-available, which is not a supported combination.`);
  }

  for (const factId of manifest.requiredFacts || []) {
    if (!getSemanticFactDefinition(factId)) fail(`${label} references unknown semantic fact ${factId}.`);
  }
  for (const factId of Object.keys(manifest.factPreconditions || {})) {
    if (!(manifest.requiredFacts || []).includes(factId)) {
      fail(`${label} has a precondition for ${factId}, which it does not require.`);
    }
  }
  return manifest;
}

/**
 * Derive today's effective conversational routing by running the live planner
 * for one goal at a time. Behavioural rather than structural on purpose: the
 * parity check must survive P2 deleting the ROUTES table it would otherwise
 * have imported.
 */
function liveRouting() {
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
    const plan = buildGoalModulePlan(profile, { allowedModuleIds: Object.values(MODULE_IDS) });
    for (const slot of plan.moduleSlots) {
      if (!byModule.has(slot.moduleId)) byModule.set(slot.moduleId, []);
      byModule.get(slot.moduleId).push({ type, source: slot.source });
    }
  }
  return byModule;
}

function assertParity(entries) {
  const routing = liveRouting();
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
    const consumerVisible = isConsumerVisibleModule(entry.moduleId);
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
  const manifest = parseManifest(source, label);
  if (`${manifest.moduleId}.md` !== name) fail(`${label} does not match its moduleId.`);
  return {
    ...manifest,
    purpose: proseSection(source, 'Purpose', label),
    whenToUse: proseSection(source, 'When to use', label),
    whenNotToUse: proseSection(source, 'When not to use', label),
    clientSignals: clientSignals(source, label)
  };
}).sort((left, right) => left.moduleId.localeCompare(right.moduleId));

const duplicates = entries.map((entry) => entry.moduleId)
  .filter((id, index, all) => all.indexOf(id) !== index);
if (duplicates.length) fail(`Duplicate module manifests: ${[...new Set(duplicates)].join(', ')}`);

const divergences = assertParity(entries);

const source = `/* Generated by scripts/generate-module-manifest.mjs. Do not edit. */\n`
  + `export const MODULE_MANIFEST_VERSION = 'planeir-module-manifest-1.0.0';\n\n`
  + `export const MODULE_MANIFEST = Object.freeze(${JSON.stringify(entries, null, 2)}.map(Object.freeze));\n`;

if (process.argv.includes('--check')) {
  const current = readFileSync(outputPath, 'utf8');
  if (current !== source) fail('Generated module manifest is stale. Run `npm run generate:module-manifest`.');
  console.info(`[ModuleManifest] ${entries.length} manifests match live routing and intake contracts.`);
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
