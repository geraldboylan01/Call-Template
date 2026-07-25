// Compiles the adviser-authored module manifests in docs/modules/*.md into
// js/planning/module_manifest.generated.js.
//
// P1 ships this INERT: nothing reads the generated manifest yet. Its whole job
// for now is the parity assertion below, which proves the authored data
// reproduces today's live routing and intake contracts exactly. P2 switches
// buildGoalModulePlan onto it and deletes the hand-maintained tables.
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
  normalizeHouseholdProfile
} from '../js/planning/index.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const moduleDir = resolve(root, 'docs/modules');
const outputPath = resolve(root, 'js/planning/module_manifest.generated.js');
const MANIFEST_MARKER = '<!-- planeir-module-manifest -->';
const MODULE_ID_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;
const PINNED_VALUES = new Set(['never', 'when_eligible']);
const GOAL_ROLES = new Set(['direct', 'companion']);
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
  if (!PINNED_VALUES.has(manifest.pinned)) fail(`${label} has an invalid pinned value.`);
  if (!Number.isInteger(manifest.priorityBoost)) fail(`${label} has a non-integer priorityBoost.`);
  if (typeof manifest.consumerAvailable !== 'boolean') fail(`${label} has a non-boolean consumerAvailable.`);

  for (const goal of manifest.goals || []) {
    if (!GOAL_TYPES.includes(goal.type)) fail(`${label} references unknown goal ${goal.type}.`);
    if (!GOAL_ROLES.has(goal.role)) fail(`${label} goal ${goal.type} has an invalid role.`);
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
  for (const entry of entries) {
    const definition = getPlanningModuleDefinition(entry.moduleId);
    if (!definition) fail(`${entry.moduleId} is not a registered planning module.`);

    if (entry.name !== definition.name) fail(`${entry.moduleId}: manifest name does not match the registry.`);
    if (entry.status !== definition.status) fail(`${entry.moduleId}: manifest status does not match the registry.`);
    if (entry.consumerAvailable !== (definition.consumerAvailable === true)) {
      fail(`${entry.moduleId}: manifest consumerAvailable does not match the registry.`);
    }

    const registryFacts = [...definition.intakeContract.semanticFactIds].sort();
    const manifestFacts = [...entry.requiredFacts].sort();
    if (JSON.stringify(registryFacts) !== JSON.stringify(manifestFacts)) {
      fail(`${entry.moduleId}: requiredFacts do not match the module intake contract.\n`
        + `  registry: ${registryFacts.join(', ')}\n  manifest: ${manifestFacts.join(', ')}`);
    }

    const routes = routing.get(entry.moduleId) || [];
    const liveGoals = routes
      .filter((route) => route.source === 'goal_direct' || route.source === 'goal_companion')
      .map((route) => `${route.type}:${route.source === 'goal_direct' ? 'direct' : 'companion'}`)
      .sort();
    const manifestGoals = entry.goals.map((goal) => `${goal.type}:${goal.role}`).sort();
    if (JSON.stringify(liveGoals) !== JSON.stringify(manifestGoals)) {
      fail(`${entry.moduleId}: manifest goals do not reproduce live routing.\n`
        + `  live:     ${liveGoals.join(', ') || '(none)'}\n  manifest: ${manifestGoals.join(', ') || '(none)'}`);
    }

    const livePinned = routes.some((route) => route.source === 'balance_sheet_default') ? 'when_eligible' : 'never';
    if (entry.pinned !== livePinned) {
      fail(`${entry.moduleId}: manifest pinned is "${entry.pinned}" but live routing behaves as "${livePinned}".`);
    }

    // Recorded, not fatal. `applicableGoals` is a third representation that no
    // routing code reads; P2 resolves it. Surfacing the gap here stops it being
    // silently inherited.
    const declared = [...definition.applicableGoals].sort();
    const routed = [...new Set(entry.goals.map((goal) => goal.type))].sort();
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
