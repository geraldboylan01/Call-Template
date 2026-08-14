/**
 * Pure validation for authored and draft module manifests.
 *
 * Filesystem discovery, Markdown file naming, registry parity and generated
 * output remain in scripts/generate-module-manifest.mjs. This module owns the
 * validation rules shared by that authoritative build and adviser tooling.
 */

import { GOAL_TYPES } from './contracts.js';
import { getSemanticFactDefinition } from './semantic_facts.js';

const MANIFEST_MARKER = '<!-- planeir-module-manifest -->';
const MODULE_ID_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;
const PINNED_VALUES = new Set(['never', 'when_eligible']);
const GOAL_ROLES = new Set(['direct', 'companion']);
const IMPLEMENTATION_STATUSES = new Set([
  'engine',
  'template_only',
  'routing_label',
  'capability',
  'planned'
]);
const INTAKE_STATUSES = new Set(['approved', 'incomplete']);
const READINESS_STATUSES = new Set(['approved', 'remediation_required', 'not_reviewed', 'not_applicable']);
const PROFILE_HAS_KINDS = new Set([
  'cash', 'pension', 'property', 'business', 'dependants', 'mortgage', 'loan'
]);
const MAX_PROSE = 1_200;
const MAX_SIGNAL = 160;
const MAX_SIGNALS = 12;
const MAX_OFFER_CLAUSES = 4;
export const REQUIRED_CONSUMER_LANGUAGE_FIELDS = Object.freeze([
  'consumerOfferDescription',
  'consumerShortLabel',
  'consumerConfirmationDescription',
  'offerQuestion'
]);
const CONSUMER_LANGUAGE_FIELDS = new Set([
  ...REQUIRED_CONSUMER_LANGUAGE_FIELDS,
  'offerClauses'
]);
const CONSUMER_LANGUAGE_LIMITS = Object.freeze({
  consumerOfferDescription: 1_200,
  consumerShortLabel: 240,
  consumerConfirmationDescription: 400,
  offerQuestion: 240,
  offerClauseText: 400
});
const INSTRUCTION_LIKE = /\b(?:ignore (?:all|any|previous)|disregard (?:all|any|previous)|system prompt|you are now|act as|new instructions?)\b/i;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UNRESOLVED_PLACEHOLDER = /[{}]/;

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

function validateConsumerText(value, field, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${label} requires a non-empty consumerLanguage.${field}.`);
  }
  if (value.length > maximum) {
    fail(`${label} consumerLanguage.${field} exceeds ${maximum} characters.`);
  }
  if (value !== value.replace(/\s+/g, ' ').trim() || CONTROL_CHARACTER.test(value)) {
    fail(`${label} consumerLanguage.${field} must be clean, single-line text.`);
  }
  if (INSTRUCTION_LIKE.test(value)) {
    fail(`${label} consumerLanguage.${field} contains instruction-like text.`);
  }
  if (UNRESOLVED_PLACEHOLDER.test(value)) {
    fail(`${label} consumerLanguage.${field} contains an unresolved placeholder.`);
  }
}

function validateConsumerLanguage(manifest, label) {
  const required = manifest.availability?.platformConsumerApproved === true
    && manifest.implementation?.hasRunnableEngine === true;
  const language = manifest.consumerLanguage;
  if (!language) {
    if (required) fail(`${label} requires consumerLanguage for approved runnable consumer use.`);
    return;
  }
  if (typeof language !== 'object' || Array.isArray(language)) {
    fail(`${label} has an invalid consumerLanguage object.`);
  }
  for (const field of Object.keys(language)) {
    if (!CONSUMER_LANGUAGE_FIELDS.has(field)) {
      fail(`${label} has unsupported consumerLanguage.${field}.`);
    }
  }
  for (const field of REQUIRED_CONSUMER_LANGUAGE_FIELDS) {
    validateConsumerText(language[field], field, label, CONSUMER_LANGUAGE_LIMITS[field]);
  }
  if (!language.offerQuestion.endsWith('?')) {
    fail(`${label} consumerLanguage.offerQuestion must be a question.`);
  }

  if (language.offerClauses === undefined) return;
  if (!Array.isArray(language.offerClauses)
    || language.offerClauses.length === 0
    || language.offerClauses.length > MAX_OFFER_CLAUSES) {
    fail(`${label} consumerLanguage.offerClauses must contain one to ${MAX_OFFER_CLAUSES} clauses when present.`);
  }
  for (const [index, clause] of language.offerClauses.entries()) {
    const clauseLabel = `offerClauses[${index}]`;
    if (!clause || typeof clause !== 'object' || Array.isArray(clause)) {
      fail(`${label} consumerLanguage.${clauseLabel} must be an object.`);
    }
    const clauseKeys = Object.keys(clause);
    if (clauseKeys.length !== 2 || !clauseKeys.includes('text') || !clauseKeys.includes('when')) {
      fail(`${label} consumerLanguage.${clauseLabel} must contain only text and when.`);
    }
    validateConsumerText(
      clause.text,
      `${clauseLabel}.text`,
      label,
      CONSUMER_LANGUAGE_LIMITS.offerClauseText
    );
    const when = clause.when;
    if (!when || typeof when !== 'object' || Array.isArray(when)
      || Object.keys(when).length !== 1 || !Array.isArray(when.anyGoal)
      || when.anyGoal.length === 0) {
      fail(`${label} consumerLanguage.${clauseLabel}.when must contain a non-empty anyGoal array.`);
    }
    if (new Set(when.anyGoal).size !== when.anyGoal.length) {
      fail(`${label} consumerLanguage.${clauseLabel}.when.anyGoal contains duplicates.`);
    }
    for (const goalType of when.anyGoal) {
      if (!GOAL_TYPES.includes(goalType)) {
        fail(`${label} consumerLanguage.${clauseLabel}.when.anyGoal references unknown goal ${goalType}.`);
      }
    }
  }
}

/** Validate one parsed manifest with the exact rules used by the build. */
export function validateModuleManifest(manifest, label = 'module manifest') {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail(`${label} must be a manifest object.`);
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
  if (availability.adviserConsumerEnabled && !availability.platformConsumerApproved) {
    fail(`${label} is adviser-enabled for consumers without platform consumer approval.`);
  }
  if (availability.platformConsumerApproved && manifest.implementation?.hasRunnableEngine !== true) {
    fail(`${label} is platform-consumer-approved without a runnable engine.`);
  }
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
  validateConsumerLanguage(manifest, label);

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
  if (implementation.status === 'capability' && (routing.adviserGoals || []).length > 0) {
    fail(`${label} is a capability and must not carry adviser goals.`);
  }
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

/** Parse and validate the machine block plus bounded prose from one authored Markdown document. */
export function parseAuthoredModuleDocument(source, label = 'module manifest') {
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
  return {
    manifest: validateModuleManifest(manifest, label),
    prose: {
      purpose: proseSection(source, 'Purpose', label),
      whenToUse: proseSection(source, 'When to use', label),
      whenNotToUse: proseSection(source, 'When not to use', label),
      clientSignals: clientSignals(source, label)
    }
  };
}
