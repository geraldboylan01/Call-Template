import { normalizeHouseholdProfile } from './profile.js';
import {
  canonicalCollectionFields,
  getSemanticFactDefinition,
  listSemanticFactDefinitions
} from './semantic_facts.js';
import {
  assertIsoDateTime,
  assertJsonCompatible,
  cloneJson,
  enumValue,
  finiteNumber,
  isPlainObject,
  nonEmptyString,
  sha256Json,
  stableStringify
} from './utils.js';

/**
 * Deterministic contracts for the transcript-to-notes reconciler.
 *
 * This module deliberately contains no model call, repository access or JSON
 * Patch escape hatch. A model may propose one of the bounded operations below;
 * only this code decides whether the proposal is grounded and what it means for
 * the ledger and HouseholdProfile.
 */

export const PLANNING_NOTE_KINDS = Object.freeze([
  'fact',
  'position',
  'summary',
  'future_event',
  'scenario_option',
  'completion'
]);

export const PLANNING_NOTE_CERTAINTIES = Object.freeze([
  'exact',
  'approximate',
  'range',
  'unknown',
  'none'
]);

export const PLANNING_NOTE_LIFECYCLES = Object.freeze([
  'active',
  'superseded',
  'retracted',
  'needs_clarification'
]);

export const PLANNING_NOTE_REVIEW_STATUSES = Object.freeze([
  'provisional',
  'planner_verified',
  'planner_corrected',
  'user_confirmed'
]);

export const PLANNING_NOTE_SOURCES = Object.freeze([
  'realtime_note',
  'planner_reconciliation',
  'consumer_edit',
  'legacy_import'
]);

export const RECONCILIATION_OPERATIONS = Object.freeze([
  'upsert_note',
  'correct_note',
  'reclassify_note',
  'retract_note',
  'merge_entities',
  'set_completion',
  'set_scenario',
  'request_clarification'
]);

export const RECONCILIATION_REASON_CODES = Object.freeze([
  'missing_note',
  'incorrect_value',
  'wrong_owner',
  'duplicate_entity',
  'aggregate_summary',
  'future_event',
  'explicit_correction',
  'unknown_answer',
  'explicit_none',
  'scenario_option',
  'incorrect_classification',
  'stale_note',
  'ambiguous_reference',
  'needs_clarification'
]);

export const NEED_ANSWER_POLICIES = Object.freeze([
  'value',
  'value_or_none',
  'unknown_allowed'
]);

export const NEED_STATUSES = Object.freeze([
  'open',
  'estimate_requested',
  'blocked_unknown',
  'deferred',
  'satisfied'
]);

export const NEED_IMPORTANCES = Object.freeze(['required', 'recommended', 'optional']);
const RECONCILIATION_VERDICTS = Object.freeze([
  'clean',
  'changes_proposed',
  'clarification_required'
]);
const MAX_OPERATION_GROUPS = 12;
const MAX_OPERATIONS_PER_GROUP = 12;
const MAX_TOTAL_OPERATIONS = 40;
const MAX_EVIDENCE_REFS = 6;
const NUMERIC_STRING = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const DATE_LIKE_STRING = /^(?:\d{4}-\d{2}(?:-\d{2})?(?:T[^\s]+)?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}|\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4})$/iu;
const VALUE_ID_FIELD = /^(?:id|.+Ids?)$/;

const CURRENCY_EVIDENCE = Object.freeze({
  EUR: /(?:€|\beuros?\b|\bEUR\b)/iu,
  GBP: /(?:£|\bpounds?\b|\bsterling\b|\bGBP\b)/iu,
  USD: /(?:\$|\bdollars?\b|\bUSD\b)/iu
});

const PENSION_TYPE_EVIDENCE = Object.freeze({
  occupational: /\b(?:occupational|workplace|employer|company)\b/iu,
  prsa: /\bPRSA\b/iu,
  personal: /\b(?:personal|private)\s+(?:pension|retirement)\b/iu,
  defined_benefit: /\b(?:defined[- ]benefit|DB\s+pension|public[- ]sector\s+pension)\b/iu,
  buyout_bond: /\b(?:buyout\s+bond|personal\s+retirement\s+bond)\b/iu,
  other: /\bother\b/iu
});

const PENSION_CONTRIBUTION_STATUS_EVIDENCE = Object.freeze({
  active: /\b(?:active|currently\s+(?:contribut|pay)|contribut\w*\s+(?:to|into)|pay\w*\s+into)\b/iu,
  paid_up: /\b(?:paid[- ]up|preserved|frozen|no\s+longer\s+contribut|stopped\s+contribut)\b/iu,
  not_applicable: /\b(?:not\s+applicable|defined[- ]benefit|DB\s+pension|buyout\s+bond|personal\s+retirement\s+bond)\b/iu,
  unknown: /\b(?:unknown|unsure|do(?:n't|\s+not)\s+know|not\s+sure)\b/iu
});

const SCENARIO_STATUS_EVIDENCE = Object.freeze({
  exploring: /\b(?:explor\w*|consider\w*|could|might|may|options?|alternatives?)\b|\b(?:have\s+not|haven't|not)\s+(?:chosen|decided)\b/iu,
  selected: /\b(?:selected|chosen|decided|settled|intend|target|will)\b/iu,
  active: /\bactive\b/iu,
  completed: /\b(?:completed|done|finished)\b/iu,
  paused: /\b(?:paused|deferred|on\s+hold)\b/iu
});

const FREEFORM_TOKEN_ALIASES = Object.freeze({
  annual: /\b(?:annual|annually|yearly|year)\b/iu,
  db: /\b(?:DB|defined[- ]benefit)\b/iu,
  dc: /\b(?:DC|defined[- ]contribution)\b/iu,
  expected: /\b(?:expect\w*|coming|due)\b/iu,
  rounded: /\b(?:rounded|roughly|about|circa|approx(?:imate(?:ly)?)?)\b/iu,
  total: /\b(?:total|together|altogether)\b/iu
});

const CONTROL_OWNED_KEYS = new Set([
  'confirmedAt',
  'confirmedByUser',
  'confirmationStatus',
  'executionStatus',
  'readyToConfirm',
  'runAnalysis',
  'selectedAnalyses',
  'selectedModuleIds',
  'selectedModules'
]);

/**
 * Which facts hold a position, and the shape of the record each one takes.
 *
 * EXPORTED SO THE PROMPT AND THE VALIDATOR CANNOT DISAGREE. The reconciler
 * prompt used to describe this shape in prose — "copy that slot ID into the
 * canonical record's entity ID field" — and there is no `entityId` field in a
 * canonical record; income sources carry `incomeId`, pensions `pensionId`.
 * A real planner model followed that sentence literally, wrote `value.entityId`,
 * and `assertPositionRecord` refused every entity it proposed. Telling the model
 * what this constant already says is the only way those two stay in step.
 *
 * `requiredKeys` is the smallest record `normalizeHouseholdProfile` will accept
 * for that collection. It is written out rather than introspected because the
 * normalizer is imperative and has no schema to read — but it is not trusted:
 * check-planner-fact-contracts proves, for every collection, that this exact set
 * normalizes and that dropping ANY member of it fails. A field added to the
 * profile contract without being added here fails that audit rather than
 * surviving as a shape the planner is told is complete and is not.
 */
export const POSITION_PROJECTIONS = Object.freeze({
  asset_position: Object.freeze({
    collection: 'assets', idKey: 'assetId', ownerKey: 'ownerIds',
    requiredKeys: Object.freeze(['assetId', 'type', 'label'])
  }),
  liability_position: Object.freeze({
    collection: 'liabilities', idKey: 'liabilityId', ownerKey: 'ownerIds',
    requiredKeys: Object.freeze(['liabilityId', 'type', 'label'])
  }),
  mortgage_position: Object.freeze({
    collection: 'liabilities', idKey: 'liabilityId', ownerKey: 'ownerIds',
    requiredKeys: Object.freeze(['liabilityId', 'type', 'label'])
  }),
  loan_position: Object.freeze({
    collection: 'liabilities', idKey: 'liabilityId', ownerKey: 'ownerIds',
    requiredKeys: Object.freeze(['liabilityId', 'type', 'label'])
  }),
  income_sources: Object.freeze({
    collection: 'incomeSources', idKey: 'incomeId', ownerKey: 'ownerId',
    requiredKeys: Object.freeze(['incomeId', 'ownerId', 'type', 'label'])
  }),
  pension_positions: Object.freeze({
    collection: 'pensions', idKey: 'pensionId', ownerKey: 'ownerId',
    requiredKeys: Object.freeze(['pensionId', 'ownerId', 'type'])
  }),
  property_position: Object.freeze({
    collection: 'properties', idKey: 'propertyId', ownerKey: 'ownerIds',
    requiredKeys: Object.freeze(['propertyId', 'use'])
  }),
  business_position: Object.freeze({
    collection: 'businesses', idKey: 'businessId', ownerKey: 'ownerIds',
    requiredKeys: Object.freeze(['businessId', 'label', 'agricultural'])
  }),
  dependants: Object.freeze({
    collection: 'dependants', idKey: 'dependantId', ownerKey: null,
    requiredKeys: Object.freeze(['dependantId'])
  })
});

const ENTITY_COLLECTION_FACT_IDS = Object.freeze({
  assets: Object.freeze(['asset_position', 'cash_savings']),
  liabilities: Object.freeze([
    'liability_position', 'liability_monthly_payment',
    'mortgage_position', 'mortgage_current_balance', 'mortgage_annual_interest_rate',
    'mortgage_remaining_term_months', 'loan_position', 'loan_current_balance',
    'loan_annual_interest_rate', 'loan_remaining_term_months'
  ]),
  incomeSources: Object.freeze(['income_sources', 'gross_household_income']),
  pensions: Object.freeze([
    'pension_positions', 'pension_current_value', 'pension_contribution_status',
    'pension_employee_contribution_rate', 'pension_employer_contribution_rate',
    'pension_projected_annual_income', 'pension_benefit_start_age',
    'pension_retirement_lump_sum'
  ]),
  properties: Object.freeze(['property_position']),
  businesses: Object.freeze(['business_position']),
  dependants: Object.freeze(['dependants', 'dependant_current_age'])
});

const SIDECAR_KEYS = Object.freeze({
  summary: 'statedSummaries',
  future_event: 'futureEvents',
  scenario_option: 'decisionScenarios',
  completion: 'completions'
});

class ReconciliationValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconciliationValidationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReconciliationValidationError(code, message);
}

function optionalString(value, fieldName) {
  if (value === null || typeof value === 'undefined' || value === '') return undefined;
  return nonEmptyString(value, fieldName);
}

function uniqueStrings(value, fieldName, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array.`);
  const normalized = value.map((item, index) => nonEmptyString(item, `${fieldName}[${index}]`));
  if (!allowEmpty && normalized.length === 0) throw new Error(`${fieldName} must not be empty.`);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${fieldName} must not contain duplicate values.`);
  }
  return normalized;
}

function jsonValue(value, fieldName) {
  assertJsonCompatible(value, fieldName);
  return cloneJson(value);
}

function normalizeStoredEvidenceRef(raw, fieldName) {
  if (!isPlainObject(raw)) throw new Error(`${fieldName} must be an object.`);
  const start = finiteNumber(raw.start, `${fieldName}.start`, { min: 0, integer: true });
  const end = finiteNumber(raw.end, `${fieldName}.end`, { min: 1, integer: true });
  if (end <= start) throw new Error(`${fieldName}.end must be greater than start.`);
  return {
    turnId: nonEmptyString(raw.turnId, `${fieldName}.turnId`),
    start,
    end
  };
}

function normalizeEvidenceQuote(raw, fieldName) {
  if (!isPlainObject(raw)) throw new Error(`${fieldName} must be an object.`);
  const quote = nonEmptyString(raw.quote, `${fieldName}.quote`);
  if (quote.length > 1_000) throw new Error(`${fieldName}.quote must be 1,000 characters or fewer.`);
  return {
    turnId: nonEmptyString(raw.turnId, `${fieldName}.turnId`),
    quote
  };
}

function normalizedEvidenceRefs(raw, fieldName = 'evidenceRefs') {
  if (!Array.isArray(raw)) throw new Error(`${fieldName} must be an array.`);
  if (raw.length > MAX_EVIDENCE_REFS) {
    throw new Error(`${fieldName} must contain at most ${MAX_EVIDENCE_REFS} entries.`);
  }
  const refs = raw.map((item, index) => normalizeStoredEvidenceRef(item, `${fieldName}[${index}]`));
  const identities = refs.map((item) => `${item.turnId}:${item.start}:${item.end}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error(`${fieldName} must not contain duplicate spans.`);
  }
  return refs;
}

/** Normalize one encrypted PlanningNoteV1 ledger record. */
export function normalizePlanningNoteV1(raw, { nowIso = new Date().toISOString() } = {}) {
  if (!isPlainObject(raw)) throw new Error('PlanningNoteV1 must be an object.');
  const schemaVersion = raw.schemaVersion ?? 1;
  if (schemaVersion !== 1) throw new Error(`Unsupported PlanningNoteV1 schemaVersion ${schemaVersion}.`);
  if (!Object.hasOwn(raw, 'value')) throw new Error('PlanningNoteV1.value is required, including null.');

  const createdAt = assertIsoDateTime(raw.createdAt ?? nowIso, 'PlanningNoteV1.createdAt');
  const note = {
    schemaVersion: 1,
    noteId: nonEmptyString(raw.noteId, 'PlanningNoteV1.noteId'),
    noteKind: enumValue(raw.noteKind, PLANNING_NOTE_KINDS, 'PlanningNoteV1.noteKind'),
    factId: nonEmptyString(raw.factId, 'PlanningNoteV1.factId'),
    value: jsonValue(raw.value, 'PlanningNoteV1.value'),
    certainty: enumValue(raw.certainty, PLANNING_NOTE_CERTAINTIES, 'PlanningNoteV1.certainty'),
    lifecycle: enumValue(raw.lifecycle, PLANNING_NOTE_LIFECYCLES, 'PlanningNoteV1.lifecycle'),
    reviewStatus: enumValue(raw.reviewStatus, PLANNING_NOTE_REVIEW_STATUSES, 'PlanningNoteV1.reviewStatus'),
    source: enumValue(raw.source, PLANNING_NOTE_SOURCES, 'PlanningNoteV1.source'),
    evidenceRefs: normalizedEvidenceRefs(raw.evidenceRefs ?? [], 'PlanningNoteV1.evidenceRefs'),
    replacesNoteIds: uniqueStrings(raw.replacesNoteIds ?? [], 'PlanningNoteV1.replacesNoteIds'),
    createdAt
  };

  const factInstanceId = optionalString(raw.factInstanceId, 'PlanningNoteV1.factInstanceId');
  const entityId = optionalString(raw.entityId, 'PlanningNoteV1.entityId');
  const ownerId = optionalString(raw.ownerId, 'PlanningNoteV1.ownerId');
  const reviewedAt = raw.reviewedAt
    ? assertIsoDateTime(raw.reviewedAt, 'PlanningNoteV1.reviewedAt')
    : undefined;
  if (factInstanceId) note.factInstanceId = factInstanceId;
  if (entityId) note.entityId = entityId;
  if (ownerId) note.ownerId = ownerId;
  if (reviewedAt) note.reviewedAt = reviewedAt;

  if (note.noteKind === 'position' && !note.entityId) {
    throw new Error('PlanningNoteV1.entityId is required for a position note.');
  }
  if (note.noteKind === 'completion' && !note.factInstanceId) {
    throw new Error('PlanningNoteV1.factInstanceId is required for a completion note.');
  }
  if (note.replacesNoteIds.includes(note.noteId)) {
    throw new Error('PlanningNoteV1 cannot replace itself.');
  }
  if (note.certainty === 'range') {
    const range = isPlainObject(note.value?.range) ? note.value.range : note.value;
    const endpoint = (value) => (
      typeof value === 'number'
        ? value
        : isPlainObject(value) && typeof value.amount === 'number'
          ? value.amount
          : Number.NaN
    );
    const min = endpoint(range?.min);
    const max = endpoint(range?.max);
    if (!isPlainObject(range)
      || !Number.isFinite(min)
      || !Number.isFinite(max)
      || max < min) {
      throw new Error('A range note must retain finite min and max endpoints.');
    }
  }
  if (note.source === 'planner_reconciliation'
    && note.noteKind !== 'completion'
    && note.evidenceRefs.length === 0) {
    throw new Error('Planner-created notes require stored client evidence.');
  }
  return note;
}

export function normalizePlanningNotesV1(raw, options = {}) {
  if (!Array.isArray(raw)) throw new Error('Planning notes must be an array.');
  const notes = raw.map((note) => normalizePlanningNoteV1(note, options));
  const ids = notes.map((note) => note.noteId);
  if (new Set(ids).size !== ids.length) throw new Error('Planning notes must contain unique noteId values.');
  return notes;
}

/** Normalize one owner- and fact-instance-specific NeedV2. */
export function normalizeNeedV2(raw, {
  allowedOwnerIds,
  allowedEntityIds
} = {}) {
  if (!isPlainObject(raw)) throw new Error('NeedV2 must be an object.');
  const need = {
    schemaVersion: 2,
    needId: nonEmptyString(raw.needId, 'NeedV2.needId'),
    factId: nonEmptyString(raw.factId, 'NeedV2.factId'),
    factInstanceId: nonEmptyString(raw.factInstanceId, 'NeedV2.factInstanceId'),
    reasonCode: nonEmptyString(raw.reasonCode, 'NeedV2.reasonCode'),
    prompt: nonEmptyString(raw.prompt, 'NeedV2.prompt'),
    importance: enumValue(raw.importance, NEED_IMPORTANCES, 'NeedV2.importance'),
    blockingModuleIds: uniqueStrings(raw.blockingModuleIds ?? [], 'NeedV2.blockingModuleIds'),
    answerPolicy: enumValue(raw.answerPolicy, NEED_ANSWER_POLICIES, 'NeedV2.answerPolicy'),
    status: enumValue(raw.status, NEED_STATUSES, 'NeedV2.status')
  };
  const entityId = optionalString(raw.entityId, 'NeedV2.entityId');
  const ownerId = optionalString(raw.ownerId, 'NeedV2.ownerId');
  const entityLabel = optionalString(raw.entityLabel, 'NeedV2.entityLabel');
  if (entityId) need.entityId = entityId;
  if (ownerId) need.ownerId = ownerId;
  if (entityLabel) need.entityLabel = entityLabel;

  if (allowedOwnerIds && ownerId && !new Set(allowedOwnerIds).has(ownerId)) {
    throw new Error(`NeedV2.ownerId ${ownerId} is not a known owner.`);
  }
  if (allowedEntityIds && entityId && !new Set(allowedEntityIds).has(entityId)) {
    throw new Error(`NeedV2.entityId ${entityId} is not a known entity.`);
  }
  return need;
}

function normalizeOperation(raw, groupIndex, operationIndex) {
  const fieldName = `operationGroups[${groupIndex}].operations[${operationIndex}]`;
  if (!isPlainObject(raw)) throw new Error(`${fieldName} must be an object.`);
  const op = enumValue(raw.op, RECONCILIATION_OPERATIONS, `${fieldName}.op`);
  const operation = {
    operationId: nonEmptyString(raw.operationId, `${fieldName}.operationId`),
    op,
    reasonCode: enumValue(raw.reasonCode, RECONCILIATION_REASON_CODES, `${fieldName}.reasonCode`),
    evidence: (raw.evidence ?? []).map((item, index) => (
      normalizeEvidenceQuote(item, `${fieldName}.evidence[${index}]`)
    ))
  };
  if (operation.evidence.length > MAX_EVIDENCE_REFS) {
    throw new Error(`${fieldName}.evidence must contain at most ${MAX_EVIDENCE_REFS} entries.`);
  }
  if (operation.evidence.length === 0) {
    throw new Error(`${fieldName}.evidence must cite at least one finalized client span.`);
  }

  for (const key of ['targetNoteId', 'factId', 'factInstanceId', 'entityId', 'ownerId', 'noteKind', 'certainty', 'targetEntityId']) {
    const value = optionalString(raw[key], `${fieldName}.${key}`);
    if (value) operation[key] = value;
  }
  if (operation.noteKind) {
    operation.noteKind = enumValue(operation.noteKind, PLANNING_NOTE_KINDS, `${fieldName}.noteKind`);
  }
  if (operation.certainty) {
    operation.certainty = enumValue(operation.certainty, PLANNING_NOTE_CERTAINTIES, `${fieldName}.certainty`);
  }
  if (typeof raw.sourceEntityIds !== 'undefined') {
    operation.sourceEntityIds = uniqueStrings(raw.sourceEntityIds, `${fieldName}.sourceEntityIds`);
  }
  if (Object.hasOwn(raw, 'value')) operation.value = jsonValue(raw.value, `${fieldName}.value`);

  const noteCreating = ['upsert_note', 'correct_note', 'reclassify_note', 'set_completion', 'set_scenario'];
  if (noteCreating.includes(op)) {
    for (const key of ['factId', 'noteKind', 'certainty']) {
      if (!operation[key]) throw new Error(`${fieldName}.${key} is required for ${op}.`);
    }
    if (!Object.hasOwn(operation, 'value')) throw new Error(`${fieldName}.value is required for ${op}.`);
  }
  if (['correct_note', 'reclassify_note', 'retract_note'].includes(op) && !operation.targetNoteId) {
    throw new Error(`${fieldName}.targetNoteId is required for ${op}.`);
  }
  if (op === 'retract_note' && !operation.factId) {
    throw new Error(`${fieldName}.factId is required for retract_note.`);
  }
  if (op === 'merge_entities') {
    if (!operation.factId || !operation.targetEntityId || !operation.sourceEntityIds?.length) {
      throw new Error(`${fieldName} requires factId, targetEntityId and sourceEntityIds.`);
    }
    if (operation.sourceEntityIds.includes(operation.targetEntityId)) {
      throw new Error(`${fieldName}.sourceEntityIds cannot contain targetEntityId.`);
    }
  }
  if (op === 'set_completion' && operation.noteKind !== 'completion') {
    throw new Error(`${fieldName}.noteKind must be completion for set_completion.`);
  }
  if (op === 'set_scenario' && operation.noteKind !== 'scenario_option') {
    throw new Error(`${fieldName}.noteKind must be scenario_option for set_scenario.`);
  }
  if (op === 'request_clarification') {
    if (!Object.hasOwn(operation, 'value')) {
      throw new Error(`${fieldName}.value must contain a NeedV2 for request_clarification.`);
    }
    operation.value = normalizeNeedV2(operation.value);
  }
  return operation;
}

/**
 * The identities an operation touches. Two operations are dependent when they
 * touch any identity in common — the same note, the same entity, the same fact
 * instance. Nothing else couples them.
 */
function operationDependencyKeys(operation) {
  const keys = [];
  if (operation.targetNoteId) keys.push(`note:${operation.targetNoteId}`);
  if (operation.factInstanceId) keys.push(`instance:${operation.factInstanceId}`);
  for (const entityId of [
    operation.entityId,
    operation.targetEntityId,
    ...(operation.sourceEntityIds || [])
  ]) {
    if (entityId) keys.push(`entity:${entityId}`);
  }
  return keys;
}

/**
 * ATOMICITY MUST BE EARNED, NOT ASSUMED.
 *
 * A group means "these land together or not at all", and that is right for
 * operations that genuinely depend on each other. But nothing told the planner
 * how granular a group should be, so it returned every correction for a turn in
 * ONE group: eleven operations, one of them unsupported, and the other ten —
 * three pension values, an income, a household correction, a summary
 * reclassification, all independent and all correct — came back
 * `dependency_group_rejected`.
 *
 * Prompt guidance alone cannot be trusted with this, because the cost of the
 * model getting it wrong is silently discarding correct work. So the coupling
 * is recomputed here from what the operations actually touch. Each group is
 * decomposed into its connected components over shared note, entity and fact
 * identities; operations that share nothing become independent groups and can
 * no longer take each other down.
 *
 * This only ever REMOVES coupling the operations do not exhibit. Anything that
 * shares an identity stays in one atomic group, and relative order is
 * preserved, so a correction that follows an upsert on the same note still
 * validates against it.
 *
 * A planner CAN still couple operations that share no identity — two facts that
 * are only true together, where applying one alone would misstate the picture.
 * That is what `atomic: true` is for, and it is honoured exactly as given. It
 * has to be claimed rather than assumed, because a group that gets atomicity by
 * accident silently discards correct work, and the planner was never told what
 * a group meant.
 */
export function splitIndependentOperationGroups(groups) {
  return groups.flatMap((group) => {
    const operations = group.operations;
    if (group.atomic === true || operations.length < 2) return [group];
    const parent = operations.map((_, index) => index);
    const find = (index) => {
      let root = index;
      while (parent[root] !== root) root = parent[root];
      while (parent[index] !== root) {
        const next = parent[index];
        parent[index] = root;
        index = next;
      }
      return root;
    };
    const union = (left, right) => { parent[find(left)] = find(right); };

    const firstSeenBy = new Map();
    operations.forEach((operation, index) => {
      for (const key of operationDependencyKeys(operation)) {
        if (firstSeenBy.has(key)) union(firstSeenBy.get(key), index);
        else firstSeenBy.set(key, index);
      }
    });

    const components = new Map();
    operations.forEach((operation, index) => {
      const root = find(index);
      if (!components.has(root)) components.set(root, []);
      components.get(root).push(operation);
    });
    if (components.size < 2) return [group];
    // Suffixed only when a split actually happened, so an untouched group keeps
    // the id the planner gave it and stays comparable across runs.
    return [...components.values()].map((componentOperations, index) => ({
      groupId: `${group.groupId}#${index + 1}`,
      operations: componentOperations
    }));
  });
}

/** Normalize the bounded model-facing ReconciliationPlanV1 contract. */
export function normalizeReconciliationPlanV1(raw) {
  if (!isPlainObject(raw)) throw new Error('ReconciliationPlanV1 must be an object.');
  const schemaVersion = raw.schemaVersion ?? 1;
  if (schemaVersion !== 1) throw new Error(`Unsupported ReconciliationPlanV1 schemaVersion ${schemaVersion}.`);
  if (!Array.isArray(raw.operationGroups)) {
    throw new Error('ReconciliationPlanV1.operationGroups must be an array.');
  }
  if (raw.operationGroups.length > MAX_OPERATION_GROUPS) {
    throw new Error(`ReconciliationPlanV1 supports at most ${MAX_OPERATION_GROUPS} operation groups.`);
  }
  const plan = {
    schemaVersion: 1,
    verdict: enumValue(raw.verdict, RECONCILIATION_VERDICTS, 'ReconciliationPlanV1.verdict'),
    reviewedNoteIds: uniqueStrings(raw.reviewedNoteIds ?? [], 'ReconciliationPlanV1.reviewedNoteIds'),
    operationGroups: raw.operationGroups.map((group, groupIndex) => {
      const fieldName = `operationGroups[${groupIndex}]`;
      if (!isPlainObject(group) || !Array.isArray(group.operations)) {
        throw new Error(`${fieldName} must contain an operations array.`);
      }
      if (group.operations.length === 0 || group.operations.length > MAX_OPERATIONS_PER_GROUP) {
        throw new Error(`${fieldName}.operations must contain 1-${MAX_OPERATIONS_PER_GROUP} entries.`);
      }
      return {
        groupId: nonEmptyString(group.groupId, `${fieldName}.groupId`),
        // Atomicity is OPT-IN. See splitIndependentOperationGroups: a group
        // that does not claim it is decomposed by the identities its
        // operations actually touch.
        atomic: group.atomic === true,
        operations: group.operations.map((operation, operationIndex) => (
          normalizeOperation(operation, groupIndex, operationIndex)
        ))
      };
    })
  };
  const groupIds = plan.operationGroups.map((group) => group.groupId);
  if (new Set(groupIds).size !== groupIds.length) {
    throw new Error('ReconciliationPlanV1 must contain unique groupId values.');
  }
  const operations = plan.operationGroups.flatMap((group) => group.operations);
  if (operations.length > MAX_TOTAL_OPERATIONS) {
    throw new Error(`ReconciliationPlanV1 supports at most ${MAX_TOTAL_OPERATIONS} operations.`);
  }
  const operationIds = operations.map((operation) => operation.operationId);
  if (new Set(operationIds).size !== operationIds.length) {
    throw new Error('ReconciliationPlanV1 must contain unique operationId values.');
  }
  if (plan.verdict === 'clean' && operations.length > 0) {
    throw new Error('A clean ReconciliationPlanV1 cannot contain operations.');
  }
  if (plan.verdict === 'changes_proposed'
    && !operations.some((operation) => operation.op !== 'request_clarification')) {
    throw new Error('changes_proposed requires at least one mutating operation.');
  }
  if (plan.verdict === 'clarification_required'
    && !operations.some((operation) => operation.op === 'request_clarification')) {
    throw new Error('clarification_required requires a request_clarification operation.');
  }
  return plan;
}

function normalizeTranscriptTurns(raw) {
  if (!Array.isArray(raw)) throw new Error('transcriptTurns must be an array.');
  const turns = raw.map((turn, index) => {
    if (!isPlainObject(turn)) throw new Error(`transcriptTurns[${index}] must be an object.`);
    const role = String(turn.role || turn.speaker || '').toLowerCase();
    return {
      turnId: nonEmptyString(turn.turnId, `transcriptTurns[${index}].turnId`),
      role,
      finalized: turn.finalized === true,
      text: typeof turn.text === 'string' ? turn.text : '',
      sequence: typeof turn.sequence === 'number' && Number.isFinite(turn.sequence)
        ? turn.sequence
        : index
    };
  });
  const ids = turns.map((turn) => turn.turnId);
  if (new Set(ids).size !== ids.length) throw new Error('transcriptTurns must contain unique turnId values.');
  return turns;
}

function verifyEvidence(operation, turnIndex) {
  const refs = operation.evidence.map((evidence) => {
    const turn = turnIndex.get(evidence.turnId);
    if (!turn) fail('evidence_turn_unknown', `Evidence turn ${evidence.turnId} is not in the supplied transcript context.`);
    if (!turn.finalized) fail('evidence_turn_not_finalized', `Evidence turn ${evidence.turnId} is not finalized.`);
    if (!['user', 'client'].includes(turn.role)) {
      fail('evidence_role_not_client', `Evidence turn ${evidence.turnId} is not a client turn.`);
    }
    const start = turn.text.indexOf(evidence.quote);
    if (start < 0) fail('evidence_quote_not_exact', `Evidence quote is not an exact span of ${evidence.turnId}.`);
    if (turn.text.indexOf(evidence.quote, start + 1) >= 0) {
      fail('evidence_quote_ambiguous', `Evidence quote occurs more than once in ${evidence.turnId}.`);
    }
    return {
      turnId: evidence.turnId,
      start,
      end: start + evidence.quote.length,
      quote: evidence.quote,
      sequence: turn.sequence
    };
  });
  const identities = refs.map((item) => `${item.turnId}:${item.start}:${item.end}`);
  if (new Set(identities).size !== identities.length) {
    fail('evidence_span_duplicate', `Operation ${operation.operationId} repeats an evidence span.`);
  }
  return refs;
}

function assertStoredNoteEvidence(note, turnIndex) {
  if (!Array.isArray(note.evidenceRefs) || note.evidenceRefs.length === 0) {
    fail(
      'review_evidence_missing',
      `Provisional note ${note.noteId} cannot be planner-verified without stored client evidence.`
    );
  }
  for (const ref of note.evidenceRefs) {
    const turn = turnIndex.get(ref.turnId);
    if (!turn) fail('review_evidence_turn_unknown', `Review evidence turn ${ref.turnId} is unavailable.`);
    if (!turn.finalized) fail('review_evidence_turn_not_finalized', `Review evidence turn ${ref.turnId} is not finalized.`);
    if (!['user', 'client'].includes(turn.role)) {
      fail('review_evidence_role_not_client', `Review evidence turn ${ref.turnId} is not a client turn.`);
    }
    if (!Number.isSafeInteger(ref.start)
      || !Number.isSafeInteger(ref.end)
      || ref.start < 0
      || ref.end <= ref.start
      || ref.end > turn.text.length) {
      fail('review_evidence_span_invalid', `Review evidence for ${note.noteId} is outside its client turn.`);
    }
  }
}

const SPOKEN_NUMBER_VALUES = Object.freeze({
  zero: 0, one: 1, two: 2, both: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
});
const SPOKEN_NUMBER_SCALES = Object.freeze({ hundred: 100, thousand: 1_000, million: 1_000_000 });

function numericLeaves(value, found = [], path = []) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    found.push({ value, path });
    return found;
  }
  if (typeof value === 'string' && NUMERIC_STRING.test(value.trim())) {
    found.push({ value: Number(value.trim().replaceAll(',', '')), path });
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => numericLeaves(item, found, [...path, String(index)]));
    return found;
  }
  Object.entries(value).forEach(([key, item]) => numericLeaves(item, found, [...path, key]));
  return found;
}

function spokenNumbers(text) {
  const tokens = [...String(text).toLowerCase().matchAll(/\p{L}+/gu)].map((match) => match[0]);
  const values = [];
  for (let start = 0; start < tokens.length; start += 1) {
    const first = tokens[start];
    if (!Object.hasOwn(SPOKEN_NUMBER_VALUES, first)
      && !(first === 'a' && Object.hasOwn(SPOKEN_NUMBER_SCALES, tokens[start + 1]))) continue;
    let total = 0;
    let group = 0;
    let decimal = '';
    let point = false;
    let consumed = 0;
    for (let index = start; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === 'and' && consumed > 0 && !point) {
        const next = tokens[index + 1];
        if (Object.hasOwn(SPOKEN_NUMBER_VALUES, next) || Object.hasOwn(SPOKEN_NUMBER_SCALES, next)) {
          consumed += 1;
          continue;
        }
        break;
      }
      if (token === 'point' && consumed > 0 && !point) {
        point = true;
        consumed += 1;
        continue;
      }
      if (point) {
        const digit = SPOKEN_NUMBER_VALUES[token];
        if (!Number.isInteger(digit) || digit < 0 || digit > 9) break;
        decimal += String(digit);
        consumed += 1;
        continue;
      }
      if (token === 'a' && Object.hasOwn(SPOKEN_NUMBER_SCALES, tokens[index + 1])) {
        group += 1;
        consumed += 1;
        continue;
      }
      if (Object.hasOwn(SPOKEN_NUMBER_VALUES, token)) {
        group += SPOKEN_NUMBER_VALUES[token];
        consumed += 1;
        continue;
      }
      if (!Object.hasOwn(SPOKEN_NUMBER_SCALES, token)) break;
      const scale = SPOKEN_NUMBER_SCALES[token];
      if (scale === 100) group = (group || 1) * scale;
      else {
        total += (group || 1) * scale;
        group = 0;
      }
      consumed += 1;
    }
    if (!consumed || (point && !decimal)) continue;
    values.push(Number(`${total + group}${decimal ? `.${decimal}` : ''}`));
    start += consumed - 1;
  }
  return values;
}

function groundedNumbers(text) {
  const values = [];
  const pattern = /(?<![\p{L}\p{N}_])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:k|thousand|m|million|bn|billion)?(?![\p{L}\p{N}_])/giu;
  for (const match of String(text).matchAll(pattern)) {
    const raw = match[0].trim();
    const numberMatch = raw.match(/^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/);
    if (!numberMatch) continue;
    const base = Number(numberMatch[0].replaceAll(',', ''));
    const suffix = raw.slice(numberMatch[0].length).trim().toLowerCase();
    const scale = ['k', 'thousand'].includes(suffix) ? 1_000
      : ['m', 'million'].includes(suffix) ? 1_000_000
        : ['bn', 'billion'].includes(suffix) ? 1_000_000_000
          : 1;
    const scaled = base * scale;
    if (Number.isFinite(scaled)) values.push(scaled);
    const after = String(text).slice((match.index ?? 0) + match[0].length);
    if (/^\s*(?:%|percent\b|per\s+cent\b)/i.test(after) && Number.isFinite(base / 100)) {
      values.push(base / 100);
    }
  }
  values.push(...spokenNumbers(text));
  return values;
}

function numbersEqual(left, right) {
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-9);
}

function numericLeafMap(value) {
  return new Map(numericLeaves(value).map((leaf) => [leaf.path.join('.'), leaf.value]));
}

function dateLikeLeaves(value, found = [], path = []) {
  if (typeof value === 'string' && DATE_LIKE_STRING.test(value.trim())) {
    found.push({ value: value.trim(), path });
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => dateLikeLeaves(item, found, [...path, String(index)]));
    return found;
  }
  Object.entries(value).forEach(([key, item]) => dateLikeLeaves(item, found, [...path, key]));
  return found;
}

function dateLikeLeafMap(value) {
  return new Map(dateLikeLeaves(value).map((leaf) => [leaf.path.join('.'), leaf.value]));
}

function changedNumericLeaves(operation, targetNote) {
  if (!Object.hasOwn(operation, 'value')) return [];
  const proposed = numericLeafMap(operation.value);
  if (!targetNote || !['correct_note', 'reclassify_note'].includes(operation.op)) {
    return [...proposed.entries()].map(([path, value]) => ({ path, value }));
  }
  const current = numericLeafMap(targetNote.value);
  return [...proposed.entries()]
    .filter(([path, value]) => !current.has(path) || !numbersEqual(current.get(path), value))
    .map(([path, value]) => ({ path, value }));
}

function changedDateLikeLeaves(operation, targetNote) {
  if (!Object.hasOwn(operation, 'value')) return [];
  const proposed = dateLikeLeafMap(operation.value);
  if (!targetNote || !['correct_note', 'reclassify_note'].includes(operation.op)) {
    return [...proposed.entries()].map(([path, value]) => ({ path, value }));
  }
  const current = dateLikeLeafMap(targetNote.value);
  return [...proposed.entries()]
    .filter(([path, value]) => !current.has(path) || current.get(path) !== value)
    .map(([path, value]) => ({ path, value }));
}

function assertNumericGrounding(operation, targetNote, evidenceRefs) {
  const supported = evidenceRefs.flatMap((ref) => groundedNumbers(ref.quote));
  const changed = changedNumericLeaves(operation, targetNote);
  const unsupported = changed
    .filter((leaf) => !supported.some((value) => numbersEqual(value, leaf.value)));
  if (unsupported.length > 0) {
    fail(
      'numeric_value_unsupported',
      `Operation ${operation.operationId} includes uncited numeric values at ${unsupported.map((item) => item.path).join(', ')}.`
    );
  }
  return { changed, supported };
}

function assertDateGrounding(operation, targetNote, evidenceRefs) {
  const changed = changedDateLikeLeaves(operation, targetNote);
  const unsupported = changed.filter((leaf) => (
    !evidenceRefs.some((ref) => ref.quote.includes(leaf.value))
  ));
  if (unsupported.length > 0) {
    fail(
      'date_value_unsupported',
      `Operation ${operation.operationId} includes uncited date values at ${unsupported.map((item) => item.path).join(', ')}.`
    );
  }
}

function significantCueTerms(...values) {
  const ignored = new Set(['about', 'amount', 'annual', 'current', 'household', 'position', 'value']);
  return [...new Set(values
    .flatMap((value) => String(value || '').toLowerCase().split(/[^\p{L}\p{N}]+/u))
    .filter((term) => term.length >= 4 && !ignored.has(term)))];
}

function quoteHasCue(text, terms) {
  const normalized = String(text).toLowerCase();
  return terms.some((term) => {
    const stem = term.length > 5 ? term.slice(0, 5) : term;
    return new RegExp(`\\b${regexEscape(stem)}[\\p{L}\\p{N}_-]*`, 'iu').test(normalized);
  });
}

function numericValueAppearsInOtherEntity(value, entityId, notes) {
  return notes.some((note) => note.lifecycle === 'active'
    && note.entityId
    && note.entityId !== entityId
    && numericLeaves(note.value).some((leaf) => numbersEqual(leaf.value, value)));
}

function assertNumericSemanticBinding(operation, targetNote, evidenceRefs, grounding, notes, entities) {
  if (grounding.changed.length === 0) return;
  const quotes = evidenceRefs.map((ref) => ref.quote).join(' ');
  const proposedValues = grounding.changed.map((leaf) => leaf.value);
  const distinctEvidence = [...new Set(grounding.supported.map((value) => String(value)))];
  const hasExtraEvidenceNumbers = distinctEvidence.some((raw) => {
    const value = Number(raw);
    return !proposedValues.some((proposed) => numbersEqual(value, proposed)
      || numbersEqual(value / 100, proposed));
  });
  const entityId = operation.entityId || targetNote?.entityId;
  if (entityId) {
    const entity = entities.get(entityId);
    const entityCues = significantCueTerms(
      entity?.label,
      ...(entity?.aliases || []),
      ...(entity?.newEntitySlot ? [operation.value?.label] : [])
    );
    const duplicatedElsewhere = proposedValues.some((value) => (
      numericValueAppearsInOtherEntity(value, entityId, notes)
    ));
    if ((duplicatedElsewhere || hasExtraEvidenceNumbers) && !quoteHasCue(quotes, entityCues)) {
      fail(
        'numeric_entity_binding_ambiguous',
        `Operation ${operation.operationId} does not bind its numeric evidence to entity ${entityId}.`
      );
    }
    return;
  }
  if (hasExtraEvidenceNumbers) {
    const definition = getSemanticFactDefinition(operation.factId);
    const factCues = significantCueTerms(operation.factId, definition?.label);
    if (!quoteHasCue(quotes, factCues)) {
      fail(
        'numeric_fact_binding_ambiguous',
        `Operation ${operation.operationId} cites multiple figures without binding them to ${operation.factId}.`
      );
    }
  }
}

function rejectControlOwnedKeys(value, path = 'value') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectControlOwnedKeys(item, `${path}[${index}]`));
    return;
  }
  Object.entries(value).forEach(([key, item]) => {
    if (CONTROL_OWNED_KEYS.has(key)) {
      fail('control_field_forbidden', `${path}.${key} is controlled outside reconciliation.`);
    }
    rejectControlOwnedKeys(item, `${path}.${key}`);
  });
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quoteContainsAlias(quotes, aliases) {
  const terms = aliases.filter((alias) => typeof alias === 'string' && alias.trim());
  return terms.some((alias) => new RegExp(`\\b${regexEscape(alias.trim())}\\b`, 'iu').test(quotes));
}

function ownerRecords(profile, suppliedOwners = []) {
  const records = [{
    ownerId: profile.primaryPerson.personId,
    role: 'primary',
    label: profile.primaryPerson.displayName || 'you',
    aliases: ['i', 'me', 'my', 'mine', 'myself', profile.primaryPerson.displayName].filter(Boolean)
  }];
  if (profile.partner) {
    records.push({
      ownerId: 'household',
      role: 'household',
      label: 'the household',
      aliases: ['we', 'our', 'ours', 'joint', 'jointly', 'household']
    });
    records.push({
      ownerId: profile.partner.personId,
      role: 'partner',
      label: profile.partner.displayName || 'your partner',
      aliases: [
        'partner', 'spouse', 'wife', 'husband', 'she', 'he', 'her', 'his',
        profile.partner.displayName
      ].filter(Boolean)
    });
  }
  for (const raw of suppliedOwners) {
    if (!isPlainObject(raw)) continue;
    const ownerId = optionalString(raw.ownerId, 'owners.ownerId');
    if (!ownerId) continue;
    const existing = records.find((record) => record.ownerId === ownerId);
    const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((item) => typeof item === 'string') : [];
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, ...aliases])];
      if (raw.label) existing.label = String(raw.label);
    }
  }
  return new Map(records.map((record) => [record.ownerId, record]));
}

/**
 * The scope every fact is written at, derived from the registry.
 *
 * Three scopes, and a fact belongs to exactly one. A SINGLETON has one slot for
 * the whole household -- `/assumptions/values/persona/employmentContext` holds
 * one term, not one per person -- so it takes no entity. A PERSON fact has a
 * slot per person and is keyed by `personId`. Everything else is a position or
 * a collection member, keyed by its own entity.
 *
 * This used to be a two-item literal on the person entity, so every other
 * person-shaped fact the planner named was refused as an entity/fact mismatch,
 * and the household scope did not exist at all: `household` was a valid OWNER
 * and never a valid ENTITY, which refused six correct operations per batch. A
 * derivation cannot drift from the registry the way that literal did.
 */
const SCOPE_COLLECTION_ROOTS = new Set([
  'pensions', 'assets', 'properties', 'liabilities',
  'incomeSources', 'businesses', 'dependants', 'goals'
]);

let factScopeCache = null;
function factScopes() {
  if (factScopeCache) return factScopeCache;
  const singleton = [];
  const person = [];
  for (const definition of listSemanticFactDefinitions()) {
    if (POSITION_PROJECTIONS[definition.factId]) continue;
    if (definition.entity?.kind === 'root_object' && definition.entity.idKey === 'personId') {
      person.push(definition.factId);
      continue;
    }
    if (definition.entity) continue;
    const patterns = (definition.mappings || []).map((mapping) => mapping.pathPattern || '');
    // A fact whose home is an array root is a member of that collection, not a
    // single household slot. `goals` is one of those roots even though nothing
    // keys an entity off it here, so it is named alongside the rest rather
    // than falling through and turning `primary_goal` into a singleton.
    if (patterns.some((pattern) => SCOPE_COLLECTION_ROOTS.has(pattern.split('/')[1]))) continue;
    singleton.push(definition.factId);
  }
  factScopeCache = Object.freeze({
    singleton: Object.freeze(singleton),
    person: Object.freeze(person)
  });
  return factScopeCache;
}

/**
 * The household-wide scope. A singleton fact may name it instead of an entity.
 * Callers read it off the catalogue's `householdScopeEntityId` rather than
 * importing it, so the constant stays module-local.
 */
const HOUSEHOLD_SCOPE_ENTITY_ID = 'household';

export function singletonFactIds() {
  return [...factScopes().singleton];
}

function isSingletonFact(factId) {
  return factScopes().singleton.includes(factId);
}

function profileEntityRecords(profile) {
  const result = [];
  for (const [factId, projection] of Object.entries(POSITION_PROJECTIONS)) {
    for (const record of profile[projection.collection] || []) {
      const entityId = record[projection.idKey];
      if (!entityId) continue;
      const ownerIds = projection.ownerKey === 'ownerId'
        ? [record.ownerId]
        : projection.ownerKey === 'ownerIds'
          ? [...record.ownerIds]
          : [];
      result.push({
        entityId,
        factIds: [...new Set([factId, ...(ENTITY_COLLECTION_FACT_IDS[projection.collection] || [])])],
        ownerIds,
        label: record.label || entityId,
        collection: projection.collection
      });
    }
  }
  const { singleton, person } = factScopes();
  // The primary client IS the household's singleton subject, so naming them on
  // a singleton fact resolves to the same slot as naming no entity at all and
  // is accepted. The partner is NOT: "herself is still working" has no
  // canonical home, and coercing it would overwrite the client's own
  // retirement status with their partner's. That stays refused.
  result.push({
    entityId: profile.primaryPerson.personId,
    factIds: [...person, ...singleton],
    ownerIds: [profile.primaryPerson.personId],
    label: profile.primaryPerson.displayName || 'you',
    collection: 'people'
  });
  if (profile.partner) {
    result.push({
      entityId: profile.partner.personId,
      factIds: [...person],
      ownerIds: [profile.partner.personId],
      label: profile.partner.displayName || 'your partner',
      collection: 'people'
    });
  }
  result.push({
    entityId: HOUSEHOLD_SCOPE_ENTITY_ID,
    factIds: [...singleton],
    ownerIds: [],
    label: 'the household',
    collection: 'household',
    aliases: ['we', 'our', 'joint', 'household']
  });
  return result;
}

const NEW_ENTITY_SLOTS = Object.freeze([
  ['asset_position', 'assets', 'asset'],
  ['liability_position', 'liabilities', 'liability'],
  ['mortgage_position', 'liabilities', 'mortgage'],
  ['loan_position', 'liabilities', 'loan'],
  ['income_sources', 'incomeSources', 'income source'],
  ['pension_positions', 'pensions', 'pension'],
  ['property_position', 'properties', 'property'],
  ['business_position', 'businesses', 'business']
]);

/**
 * ONE CATALOGUE, sent to the planner and enforced by the validator.
 *
 * These were two lists. The worker built one to put in the prompt and this
 * module built another to judge the answer against, and they disagreed: the
 * planner was never shown the primary person yet was refused for naming facts
 * on them, and was never told which fact types an entity accepts at all. A
 * planner cannot resolve a spoken reference safely against a catalogue it
 * cannot see, and a rule the prompt never states is not a contract -- it is a
 * trap. Both sides now read the same object.
 *
 * The planner may still PROPOSE any mapping in here; validation is unchanged
 * and still refuses invented entities, impossible owners, wrong entity types
 * and unresolvable references.
 *
 * @param {object} profile Normalized household profile.
 * @param {Array} notes Ledger notes, whose entities join the catalogue.
 * @param {object} [options]
 * @param {number} [options.slotsPerCollection] Blank slots offered per collection.
 * @param {string[]|null} [options.slotFactIds] Restrict slots to these position facts.
 * @param {string[]} [options.retiredEntityIds] Entities that must not be offered.
 */
export function buildReconciliationIdentityCatalogue(profile, notes = [], {
  slotsPerCollection = 2,
  slotFactIds = null,
  retiredEntityIds = []
} = {}) {
  const normalized = normalizeHouseholdProfile(profile);
  const retired = new Set(retiredEntityIds);
  const entities = [];
  const seen = new Set();
  const push = (record) => {
    if (!record.entityId || seen.has(record.entityId) || retired.has(record.entityId)) return;
    seen.add(record.entityId);
    entities.push(record);
  };
  for (const record of profileEntityRecords(normalized)) {
    push({ aliases: [], ...record });
  }
  for (const note of notes) {
    if (!note?.entityId || note.lifecycle !== 'active') continue;
    const existing = entities.find((entity) => entity.entityId === note.entityId);
    if (existing) {
      existing.factIds = [...new Set([...(existing.factIds || []), note.factId])];
      continue;
    }
    push({
      entityId: note.entityId,
      label: note.value?.label || note.entityId,
      ownerIds: note.ownerId ? [note.ownerId] : [],
      factIds: [note.factId],
      collection: 'planning_notes',
      aliases: []
    });
  }
  const slots = slotFactIds
    ? NEW_ENTITY_SLOTS.filter(([factId]) => slotFactIds.includes(factId))
    : NEW_ENTITY_SLOTS;
  for (const [factId, collection, label] of slots) {
    for (let index = 1; index <= slotsPerCollection; index += 1) {
      push({
        entityId: `recon_slot_${factId}_${index}`,
        label: `new ${label} ${index}`,
        ownerIds: [],
        factIds: [factId],
        collection,
        aliases: [label],
        newEntitySlot: true
      });
    }
  }
  return {
    owners: [...ownerRecords(normalized).values()],
    entities,
    // Facts with one household-wide slot. They take no entity; the household
    // scope or the primary client resolves to that same slot.
    singletonFactIds: singletonFactIds(),
    householdScopeEntityId: HOUSEHOLD_SCOPE_ENTITY_ID
  };
}

function entityRecords(profile, suppliedEntities = []) {
  const records = new Map();
  for (const raw of [...profileEntityRecords(profile), ...suppliedEntities]) {
    if (!isPlainObject(raw)) continue;
    const entityId = optionalString(raw.entityId, 'entities.entityId');
    if (!entityId) continue;
    const existing = records.get(entityId) || {
      entityId,
      factIds: [],
      ownerIds: [],
      aliases: [],
      label: entityId,
      newEntitySlot: false
    };
    existing.factIds = [...new Set([
      ...existing.factIds,
      ...(Array.isArray(raw.factIds) ? raw.factIds.filter((item) => typeof item === 'string') : [])
    ])];
    existing.ownerIds = [...new Set([
      ...existing.ownerIds,
      ...(Array.isArray(raw.ownerIds) ? raw.ownerIds.filter((item) => typeof item === 'string') : [])
    ])];
    existing.aliases = [...new Set([
      ...existing.aliases,
      ...(Array.isArray(raw.aliases) ? raw.aliases.filter((item) => typeof item === 'string') : []),
      ...(raw.label ? [String(raw.label)] : [])
    ])];
    if (raw.label) existing.label = String(raw.label);
    if (raw.collection) existing.collection = String(raw.collection);
    if (raw.newEntitySlot === true) existing.newEntitySlot = true;
    records.set(entityId, existing);
  }
  return records;
}

function assertKnownIdentity(operation, targetNote, owners, entities, evidenceRefs) {
  const effectiveEntityId = operation.entityId || targetNote?.entityId;
  const effectiveOwnerId = operation.ownerId || targetNote?.ownerId;
  const entity = effectiveEntityId ? entities.get(effectiveEntityId) : null;
  const owner = effectiveOwnerId ? owners.get(effectiveOwnerId) : null;
  if (effectiveEntityId && !entity) {
    fail('entity_unknown', `Entity ${effectiveEntityId} is not in the server-supplied entity index.`);
  }
  if (effectiveOwnerId && !owner) {
    fail('owner_unknown', `Owner ${effectiveOwnerId} is not in the confirmed household.`);
  }
  if (owner?.role === 'household'
    && ![...owners.values()].some((record) => record.role === 'partner')) {
    fail('partner_not_confirmed', 'A joint household write requires a confirmed partner record.');
  }
  if (owner?.role === 'partner' && ![...owners.values()].some((record) => record.role === 'partner')) {
    fail('partner_not_confirmed', 'A partner-owned note requires a confirmed partner record.');
  }
  if (entity && effectiveOwnerId && entity.ownerIds.length > 0 && !entity.ownerIds.includes(effectiveOwnerId)) {
    if (operation.reasonCode !== 'wrong_owner') {
      fail('entity_owner_mismatch', `Entity ${effectiveEntityId} is not assigned to owner ${effectiveOwnerId}.`);
    }
  }
  if (entity && operation.factId && entity.factIds.length > 0 && !entity.factIds.includes(operation.factId)) {
    fail('entity_fact_mismatch', `Entity ${effectiveEntityId} is not valid for fact ${operation.factId}.`);
  }
  if (entity?.newEntitySlot) {
    if (operation.op !== 'upsert_note') {
      fail('new_entity_operation_invalid', 'A server-issued new-entity slot may only create an evidence-backed note.');
    }
    if (!effectiveOwnerId) {
      fail('new_entity_owner_missing', 'A new financial position requires one known owner.');
    }
    const quotes = evidenceRefs.map((ref) => ref.quote).join(' ');
    if (owner?.role === 'partner' || owner?.role === 'household') {
      if (!quoteContainsAlias(quotes, owner.aliases)) {
        fail('new_entity_owner_evidence_missing', `New position owner ${effectiveOwnerId} is not explicit in client evidence.`);
      }
    } else if (owner?.role === 'primary') {
      const partner = [...owners.values()].find((record) => record.role === 'partner');
      if (partner && quoteContainsAlias(quotes, partner.aliases)
        && !quoteContainsAlias(quotes, owner.aliases)) {
        fail('new_entity_owner_mismatch', 'Partner evidence cannot create a primary-client position.');
      }
    }
  }
  const changesOwner = targetNote?.ownerId && effectiveOwnerId && targetNote.ownerId !== effectiveOwnerId;
  const correctsEntityOwner = entity
    && effectiveOwnerId
    && entity.ownerIds.length > 0
    && !entity.ownerIds.includes(effectiveOwnerId);
  if (changesOwner || correctsEntityOwner) {
    if (operation.reasonCode !== 'wrong_owner') {
      fail('owner_change_reason_required', 'Changing owner requires reasonCode wrong_owner.');
    }
    const quotes = evidenceRefs.map((ref) => ref.quote).join(' ');
    if (!owner || !quoteContainsAlias(quotes, owner.aliases)) {
      fail('owner_change_evidence_missing', `Owner correction to ${effectiveOwnerId} lacks an explicit owner cue.`);
    }
  }
  if (targetNote && operation.factId && operation.factId !== targetNote.factId
    && operation.op !== 'reclassify_note') {
    fail('fact_identity_changed', 'Only reclassify_note may change a note fact identity.');
  }
  // The reconciler may only name facts that exist. The model's own schema
  // already restricts factId to the registered catalogue, so anything else
  // reaching here came from a caller that bypassed it -- and an unregistered
  // fact projects into a sidecar with no definition, no owning module and no
  // way for any adapter to consume it, which reads as working while recording
  // nothing anyone can use.
  if (operation.factId && !getSemanticFactDefinition(operation.factId)) {
    fail(
      'fact_identity_unknown',
      `Operation ${operation.operationId} names ${operation.factId}, which is not a registered semantic fact.`
    );
  }
}

function assertTargetFreshness(targetNote, evidenceRefs, turnIndex) {
  if (!targetNote || targetNote.evidenceRefs.length === 0) return;
  const targetSequences = targetNote.evidenceRefs
    .map((ref) => turnIndex.get(ref.turnId)?.sequence)
    .filter((value) => typeof value === 'number');
  if (targetSequences.length === 0) return;
  const newestTarget = Math.max(...targetSequences);
  const newestOperation = Math.max(...evidenceRefs.map((ref) => ref.sequence));
  if (newestOperation < newestTarget) {
    fail('evidence_older_than_target', 'A correction cannot override newer client evidence with an older span.');
  }
}

function storedRefs(evidenceRefs) {
  return evidenceRefs.map(({ turnId, start, end }) => ({ turnId, start, end }));
}

/**
 * Build the canonical record a position note projects.
 *
 * The reconciler is given entity and owner identities, never the internal
 * collection key, so identity is stamped here from the server-resolved values
 * rather than trusted from the model. The financial content stays a wholesale
 * replacement: correcting a pot-shaped mistake into defined-benefit semantics
 * has to be able to drop currentValue, so an omitted field means removed.
 * Only the descriptive label carries forward, because it holds no numeric leaf
 * and several collections require one to normalize at all.
 */
function positionRecordFromOperation(operation, targetNote, entityId, ownerId) {
  const projection = POSITION_PROJECTIONS[operation.factId];
  if (!projection || !isPlainObject(operation.value)) return cloneJson(operation.value);
  const record = cloneJson(operation.value);
  // `entityId` is the reconciler's identity vocabulary, not a profile field.
  delete record.entityId;
  record[projection.idKey] = entityId;
  const inheritedLabel = isPlainObject(targetNote?.value) ? targetNote.value.label : null;
  if (!record.label && typeof inheritedLabel === 'string' && inheritedLabel) {
    record.label = inheritedLabel;
  }
  if (ownerId && projection.ownerKey === 'ownerId') record.ownerId = ownerId;
  if (ownerId && projection.ownerKey === 'ownerIds') {
    const owners = Array.isArray(record.ownerIds) ? record.ownerIds : [];
    record.ownerIds = owners.includes(ownerId) ? owners : [...owners, ownerId];
  }
  return record;
}

function noteFromOperation(operation, targetNote, evidenceRefs, nowIso) {
  // A singleton has one household-wide slot, so the scope it was NAMED at is
  // not part of its identity. The planner may reach it via the household scope
  // or via the primary client; both are stored the same unentitied way the
  // live lane already writes them, so one fact cannot end up as three ledger
  // instances that no need id ever matches.
  const singleton = isSingletonFact(operation.factId);
  const factInstanceId = singleton
    ? operation.factId
    : operation.factInstanceId
      || (targetNote?.factId === operation.factId ? targetNote.factInstanceId : null)
      || (operation.entityId ? `${operation.factId}:${operation.entityId}` : operation.factId);
  const entityId = singleton ? null : (operation.entityId || targetNote?.entityId || null);
  const ownerId = operation.ownerId || targetNote?.ownerId || null;
  const value = operation.noteKind === 'position' && entityId
    ? positionRecordFromOperation(operation, targetNote, entityId, ownerId)
    : operation.value;
  return normalizePlanningNoteV1({
    schemaVersion: 1,
    noteId: `recon_${operation.operationId}`,
    noteKind: operation.noteKind,
    factId: operation.factId,
    factInstanceId,
    ...(entityId ? { entityId } : {}),
    ...(ownerId ? { ownerId } : {}),
    value,
    certainty: operation.certainty,
    lifecycle: 'active',
    reviewStatus: targetNote ? 'planner_corrected' : 'planner_verified',
    source: 'planner_reconciliation',
    evidenceRefs: storedRefs(evidenceRefs),
    replacesNoteIds: targetNote ? [targetNote.noteId] : [],
    createdAt: nowIso,
    reviewedAt: nowIso
  }, { nowIso });
}

function replaceNote(notes, noteId, updater) {
  const index = notes.findIndex((note) => note.noteId === noteId);
  if (index < 0) fail('target_note_unknown', `Target note ${noteId} does not exist.`);
  const next = [...notes];
  next[index] = updater(next[index]);
  return next;
}

function rewritePositionEntityId(note, entityId) {
  const projection = POSITION_PROJECTIONS[note.factId];
  if (!projection || !isPlainObject(note.value)) return cloneJson(note.value);
  return { ...cloneJson(note.value), [projection.idKey]: entityId };
}

function applyValidatedOperation(notes, operation, targetNote, evidenceRefs, nowIso) {
  if (operation.op === 'request_clarification') {
    return { notes, clarificationNeeds: [operation.value] };
  }
  if (operation.op === 'retract_note') {
    return {
      notes: replaceNote(notes, targetNote.noteId, (note) => normalizePlanningNoteV1({
        ...note,
        lifecycle: 'retracted',
        reviewStatus: 'planner_corrected',
        reviewedAt: nowIso
      }, { nowIso })),
      clarificationNeeds: []
    };
  }
  if (operation.op === 'merge_entities') {
    let next = [...notes];
    for (const sourceEntityId of operation.sourceEntityIds) {
      const sourceNotes = next.filter((note) => note.entityId === sourceEntityId && note.lifecycle === 'active');
      for (const sourceNote of sourceNotes) {
        next = replaceNote(next, sourceNote.noteId, (note) => normalizePlanningNoteV1({
          ...note,
          lifecycle: 'superseded',
          reviewStatus: 'planner_corrected',
          reviewedAt: nowIso
        }, { nowIso }));
        const movedValue = rewritePositionEntityId(sourceNote, operation.targetEntityId);
        const duplicate = next.some((note) => note.lifecycle === 'active'
          && note.entityId === operation.targetEntityId
          && note.factId === sourceNote.factId
          && note.noteKind === sourceNote.noteKind
          && stableStringify(note.value) === stableStringify(movedValue));
        if (duplicate) continue;
        next.push(normalizePlanningNoteV1({
          ...sourceNote,
          noteId: `recon_${operation.operationId}_${sourceNote.noteId}`,
          factInstanceId: `${sourceNote.factId}:${operation.targetEntityId}`,
          entityId: operation.targetEntityId,
          ...(operation.ownerId ? { ownerId: operation.ownerId } : {}),
          value: movedValue,
          lifecycle: 'active',
          reviewStatus: 'planner_corrected',
          source: 'planner_reconciliation',
          evidenceRefs: storedRefs(evidenceRefs),
          replacesNoteIds: [sourceNote.noteId],
          createdAt: nowIso,
          reviewedAt: nowIso
        }, { nowIso }));
      }
    }
    return { notes: next, clarificationNeeds: [] };
  }

  let next = [...notes];
  // AN UPSERT ON AN EXISTING HOLDING IS AN UPDATE OF IT, NOT A SECOND ONE.
  //
  // A position is identified by its entity, so an `upsert_note` naming an
  // entity that already holds an active position note is describing that same
  // holding. Pushing a second note for it produced two active positions for one
  // pension and the whole batch then failed `active_position_duplicate` — which
  // is exactly what a real planner hit when it created an income record and then
  // sent a second operation to fill in the amount. Superseding the predecessor
  // is the same thing a correction does, so the invariant is never broken and
  // the duplicate protection below never has to catch this.
  const supersedes = targetNote || (operation.op === 'upsert_note'
    && operation.noteKind === 'position'
    && operation.entityId
    ? notes.find((note) => note.noteKind === 'position'
      && note.factId === operation.factId
      && note.entityId === operation.entityId
      && note.lifecycle === 'active')
    : null);
  if (supersedes) {
    next = replaceNote(next, supersedes.noteId, (note) => normalizePlanningNoteV1({
      ...note,
      lifecycle: 'superseded',
      reviewStatus: 'planner_corrected',
      reviewedAt: nowIso
    }, { nowIso }));
  }
  // The new note is still built from the OPERATION, not merged with what it
  // replaces: an upsert states the record it wants, and quietly retaining
  // fields the planner did not restate would carry stale values forward under
  // a correction the client asked for.
  next.push(noteFromOperation(operation, targetNote, evidenceRefs, nowIso));
  return { notes: next, clarificationNeeds: [] };
}

/**
 * A STATED TOTAL IS NOT A HOLDING, and the plan has to say which it is.
 *
 * `aggregate_summary` has been a legal reasonCode since the contract was
 * written, and `summary` has been a legal noteKind, but nothing tied them
 * together. So a plan could say "this is the client's aggregate" in the
 * reasonCode and "this is a holding" in the noteKind, and the second one won
 * because the noteKind is what projects. Observed live: "there's about a
 * million in the pensions" landed in `/pensions` beside the three real ones,
 * and Pension Projection was handed €2.07m for a client with €1.07m. The
 * deterministic arithmetic was right; the canonical input was not.
 *
 * The classification is the planner's to make and this is only its
 * enforcement. Nothing here inspects amounts, compares an operation against
 * its siblings, or reads the wording -- a holding whose value happens to equal
 * the sum of the others is a holding, and stays one.
 */
function assertAggregateIsNotAPosition(operation, targetNote) {
  const aggregate = operation.reasonCode === 'aggregate_summary';
  const noteKind = operation.noteKind || targetNote?.noteKind || null;
  if (aggregate && noteKind && noteKind !== 'summary') {
    fail(
      'aggregate_not_a_position',
      `Operation ${operation.operationId} is classified aggregate_summary, so it must be a summary note, not ${noteKind}.`
    );
  }
  // Deliberately not enforced here: an aggregate that already landed as a
  // position is repaired by `reclassify_note` from that very entity, so the
  // repair path necessarily names a position. Refusing it would close the only
  // route back out of the mistake this rule exists to prevent.
}

function validateOperation(operation, notes, context) {
  const targetNote = operation.targetNoteId
    ? notes.find((note) => note.noteId === operation.targetNoteId)
    : null;
  if (operation.targetNoteId && !targetNote) {
    fail('target_note_unknown', `Target note ${operation.targetNoteId} does not exist.`);
  }
  if (targetNote && targetNote.lifecycle !== 'active') {
    fail('target_note_inactive', `Target note ${targetNote.noteId} is not active.`);
  }
  if (operation.op === 'retract_note' && targetNote?.source === 'legacy_import') {
    try {
      assertStoredNoteEvidence(targetNote, context.turnIndex);
    } catch {
      fail(
        'legacy_retraction_evidence_unavailable',
        `Legacy note ${targetNote.noteId} cannot be automatically retracted without retained client evidence.`
      );
    }
  }
  const evidenceRefs = verifyEvidence(operation, context.turnIndex);
  assertTargetFreshness(targetNote, evidenceRefs, context.turnIndex);
  rejectControlOwnedKeys(operation.value);

  if (operation.op === 'merge_entities') {
    const mergeEvidence = evidenceRefs.map((ref) => ref.quote).join(' ');
    if (operation.reasonCode !== 'duplicate_entity'
      || !/\b(?:duplicate|duplicated|same\s+(?:entry|account|asset|pension|property|debt)|twice|double[- ]count(?:ed|ing)?)\b/iu.test(mergeEvidence)) {
      fail('merge_duplicate_evidence_missing', 'Entity merges require explicit client wording that the records duplicate each other.');
    }
    if (!context.entities.has(operation.targetEntityId)) {
      fail('merge_target_unknown', `Merge target ${operation.targetEntityId} is not a stable entity.`);
    }
    for (const sourceEntityId of operation.sourceEntityIds) {
      if (!context.entities.has(sourceEntityId)) {
        fail('merge_source_unknown', `Merge source ${sourceEntityId} is not a stable entity.`);
      }
      if (!notes.some((note) => note.entityId === sourceEntityId && note.lifecycle === 'active')) {
        fail('merge_source_inactive', `Merge source ${sourceEntityId} has no active note.`);
      }
    }
    const targetOwners = context.entities.get(operation.targetEntityId).ownerIds;
    const sourceOwners = operation.sourceEntityIds.flatMap((entityId) => context.entities.get(entityId).ownerIds);
    if (targetOwners.length > 0 && sourceOwners.some((ownerId) => !targetOwners.includes(ownerId))) {
      fail('merge_owner_mismatch', 'Entity merges cannot cross owners. Correct ownership before merging.');
    }
    if (operation.ownerId
      && (!context.owners.has(operation.ownerId)
        || (targetOwners.length > 0 && !targetOwners.includes(operation.ownerId)))) {
      fail('merge_owner_unknown', 'An entity merge owner must match the stable target entity.');
    }
    return { targetNote, evidenceRefs };
  }

  if (operation.op === 'request_clarification') {
    const allowedOwnerIds = [...context.owners.keys()];
    const allowedEntityIds = [...context.entities.keys()];
    operation.value = normalizeNeedV2(operation.value, { allowedOwnerIds, allowedEntityIds });
    return { targetNote, evidenceRefs };
  }

  assertAggregateIsNotAPosition(operation, targetNote);
  assertKnownIdentity(operation, targetNote, context.owners, context.entities, evidenceRefs);
  const grounding = assertNumericGrounding(operation, targetNote, evidenceRefs);
  assertDateGrounding(operation, targetNote, evidenceRefs);
  assertNumericSemanticBinding(
    operation,
    targetNote,
    evidenceRefs,
    grounding,
    notes,
    context.entities
  );
  return { targetNote, evidenceRefs };
}

function rejectedNeed(operation, notes, context, code) {
  const target = operation.targetNoteId
    ? notes.find((note) => note.noteId === operation.targetNoteId)
    : null;
  const factId = operation.factId || target?.factId;
  if (!factId) return null;
  const entityId = operation.entityId || target?.entityId;
  const ownerId = operation.ownerId || target?.ownerId;
  const entity = entityId ? context.entities.get(entityId) : null;
  const owner = ownerId ? context.owners.get(ownerId) : null;
  const definition = getSemanticFactDefinition(factId);
  const subject = entity?.label || owner?.label || 'this item';
  return normalizeNeedV2({
    needId: `reconcile_${operation.operationId}`,
    factId,
    factInstanceId: operation.factInstanceId || target?.factInstanceId || (entityId ? `${factId}:${entityId}` : factId),
    ...(entityId ? { entityId } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(subject ? { entityLabel: subject } : {}),
    reasonCode: `reconciliation_${code}`,
    prompt: `Please clarify ${definition?.label?.toLowerCase() || factId.replaceAll('_', ' ')} for ${subject}.`,
    importance: 'required',
    blockingModuleIds: definition?.moduleIds || [],
    answerPolicy: 'unknown_allowed',
    status: 'open'
  });
}

const ENTITY_COLLECTION_FOR_ROOT = Object.freeze({
  pensions: 'pensionId',
  assets: 'assetId',
  properties: 'propertyId',
  liabilities: 'liabilityId',
  incomeSources: 'incomeId',
  businesses: 'businessId',
  dependants: 'dependantId'
});

/**
 * WHERE A CORRECTED SCALAR IS WRITTEN, declared rather than inferred.
 *
 * The semantic-fact registry lists which module READS each path. That is a
 * different question from where a correction should be WRITTEN, and using it
 * for both is why `monthly_spending` could never project: it maps to
 * `/expenses/monthlyEssential`, `/expenses/annualTotal` and `/expenses`, three
 * candidates survived, and the resolver returned null rather than guess between
 * a monthly figure and an annual one. Correct of it — but the correction then
 * had nowhere to go, every turn, forever.
 *
 * So the canonical home is stated here, explicitly and in one place. This table
 * is deliberately SHORT and deliberately closed: a fact earns an entry only
 * when its canonical destination is unambiguous from the fact's own meaning.
 * `income_sources` is absent on purpose — "I earn 78,000" and "I take home
 * 42,000" reach the same fact and different paths, and nothing in the note
 * distinguishes them, so it must keep failing closed until the registry can
 * tell gross from net.
 *
 * Adding an entry is a contract decision, reviewed like any other. Facts with a
 * single mapping need no entry; the resolver below already determines those.
 */
const CANONICAL_SCALAR_PATHS = Object.freeze({
  // The fact is named for the period it measures, so the monthly slot is the
  // only reading of it. `/expenses/annualTotal` is `annual_net_spending`.
  monthly_spending: '/expenses/monthlyEssential'
});

/**
 * Does the note carry a single settled value of the type the fact declares?
 *
 * Only a value of the declared shape may take a canonical slot. A range keeps
 * its endpoints and belongs in the ledger, not in a field that can hold exactly
 * one figure; an unknown or absent value is not a correction at all.
 */
function scalarValueMatchesDeclaredType(note) {
  const valueType = getSemanticFactDefinition(note.factId)?.valueType || null;
  const value = note.value;
  if (value === null || typeof value === 'undefined') return false;
  if (valueType === 'money') {
    return isPlainObject(value)
      && Number.isFinite(value.amount)
      && typeof value.currency === 'string'
      && value.currency.length > 0;
  }
  if (valueType === 'number') return Number.isFinite(value);
  if (valueType === 'boolean') return typeof value === 'boolean';
  if (valueType === 'date' || valueType === 'choice') {
    return typeof value === 'string' && value.length > 0;
  }
  // An entity-valued or undeclared fact has no single canonical slot.
  return false;
}

/**
 * Where a scalar fact note writes in the profile, or null when that cannot be
 * decided without guessing.
 *
 * A fact's registry mapping is a set of candidate paths, not one path: a fact
 * about a person exists for the primary client and the partner, and a fact
 * about a holding is a wildcard over its collection. The note carries the owner
 * and entity, so the choice is determined rather than inferred — and where it
 * is not (an unknown owner, an entity that is not on the profile, more than one
 * candidate left) this returns null and the operation stays unprojected, which
 * is the existing fail-closed behaviour rather than a write to a guessed path.
 */
/**
 * WHERE A FACT MAY BE WRITTEN, AS DATA.
 *
 * Stated here rather than anywhere else because this file is what ENFORCES it:
 * `POSITION_PROJECTIONS` decides which facts are collections,
 * `scalarProfilePathForNote` decides which have a scalar home, and both are two
 * lines away. A second description of these rules kept next to the prompt would
 * be a copy that drifts, and drift is exactly the failure this exists to stop —
 * three paid probes went on a prompt sentence that described a record field
 * (`entityId`) no record has ever had.
 *
 * `target` is the only question a caller needs to ask:
 *   position  the fact IS a collection; its note value is the canonical record
 *   scalar    the fact has a single canonical slot; its note value is the value
 *   none      the fact has no canonical home at all, so it may be kept as
 *             evidence but must never be advertised as canonically writable
 */
export function canonicalFactContract(factId, definition) {
  if (!definition) return null;
  const projection = POSITION_PROJECTIONS[factId];
  if (projection) {
    return Object.freeze({
      factId,
      target: 'position',
      noteKind: 'position',
      collection: projection.collection,
      idKey: projection.idKey,
      ownerKey: projection.ownerKey,
      requiredKeys: projection.requiredKeys,
      // Read from the registry's own path patterns, never listed by hand: this
      // is what says a pension's money is `currentValue` and an income's is
      // `grossAnnual`/`netAnnual`.
      valueFields: Object.freeze(canonicalCollectionFields()[projection.collection] || []),
      valueType: definition.valueType
    });
  }
  // The same filter `scalarProfilePathForNote` applies: a mapping onto the ROOT
  // of an entity collection is not a scalar slot, it is the collection itself.
  const scalarPatterns = (definition.mappings || [])
    .map((mapping) => mapping.pathPattern)
    .filter((pattern) => typeof pattern === 'string' && pattern.startsWith('/'))
    .filter((pattern) => !ENTITY_COLLECTION_FOR_ROOT[pattern.split('/')[1]]
      || pattern.includes('/*/'))
    // `/goals` is a collection too, and one this bridge does not manage — the
    // goal plan owns it. It is absent from ENTITY_COLLECTION_FOR_ROOT because
    // nothing there needs an id key for it, so a naive read of the mappings
    // called `primary_goal` a writable scalar. It is not: every paid probe
    // reported `primary_goal: scalar_value_unprojectable` on every single pass,
    // because the reconciler kept being told it could write a slot that has
    // never accepted a value from here.
    .filter((pattern) => pattern.split('/')[1] !== 'goals');
  const writable = Object.hasOwn(CANONICAL_SCALAR_PATHS, factId) || scalarPatterns.length > 0;
  // A scalar under `/collection/*/field` lives INSIDE a position: it has no home
  // of its own until that position exists. `pension_current_value` is the case
  // that matters — it is a value about a pension, and naming it a position was
  // one of the three shapes a real planner got wrong.
  const scoped = scalarPatterns.find((pattern) => pattern.includes('/*/'));
  return Object.freeze({
    factId,
    target: writable ? 'scalar' : 'none',
    noteKind: 'fact',
    ...(scoped ? { entityCollection: scoped.split('/')[1] } : {}),
    valueType: definition.valueType
  });
}

function scalarProfilePathForNote(profile, note) {
  // A collection fact is not a scalar. `pension_positions` maps to `/pensions`,
  // so a fact-kind note carrying a count would replace the whole array with a
  // number. Holdings are projected by the position machinery and nothing else.
  if (POSITION_PROJECTIONS[note.factId]) return null;
  // A declared canonical home wins over the consumption mappings. See
  // CANONICAL_SCALAR_PATHS: the registry says which modules READ a fact, which
  // is not the same question as where a correction to it should be WRITTEN.
  //
  // The declared path names a slot; it does not license writing anything into
  // it. A range, a null or a bare number where the fact declares money is still
  // refused and stays in the ledger — a stated range is genuinely not a scalar,
  // and turning "between €3,000 and €3,500" into a canonical figure would be
  // inventing the number the reconciler is forbidden to invent.
  if (Object.hasOwn(CANONICAL_SCALAR_PATHS, note.factId)) {
    return scalarValueMatchesDeclaredType(note)
      ? CANONICAL_SCALAR_PATHS[note.factId]
      : null;
  }
  const patterns = (getSemanticFactDefinition(note.factId)?.mappings || [])
    .map((mapping) => mapping.pathPattern)
    .filter((pattern) => typeof pattern === 'string' && pattern.startsWith('/'))
    // Nor may a scalar write the root of any entity collection.
    .filter((pattern) => !ENTITY_COLLECTION_FOR_ROOT[pattern.split('/')[1]]
      || pattern.includes('/*/'));
  if (patterns.length === 0) return null;

  const ownerId = note.ownerId || null;
  const isPrimary = ownerId && ownerId === profile.primaryPerson?.personId;
  const isPartner = ownerId && ownerId === profile.partner?.personId;
  const owned = patterns.filter((pattern) => {
    if (pattern.startsWith('/primaryPerson')) return isPrimary || !ownerId;
    if (pattern.startsWith('/partner')) return isPartner;
    return true;
  });
  const candidates = owned.length > 0 ? owned : patterns;

  const resolved = candidates.map((pattern) => {
    if (!pattern.includes('/*')) return pattern;
    if (!note.entityId) return null;
    const [, root] = pattern.split('/');
    const idKey = ENTITY_COLLECTION_FOR_ROOT[root];
    if (!idKey) return null;
    const index = (profile[root] || []).findIndex((record) => record?.[idKey] === note.entityId);
    return index >= 0 ? pattern.replace('/*', `/${index}`) : null;
  }).filter(Boolean);

  return resolved.length === 1 ? resolved[0] : null;
}

/** Write a resolved scalar path, creating only the containers it names. */
function writeProfilePath(profile, path, value) {
  const tokens = path.split('/').slice(1);
  let cursor = profile;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (!isPlainObject(cursor[token]) && !Array.isArray(cursor[token])) {
      if (!isPlainObject(cursor[token])) cursor[token] = {};
    }
    cursor = cursor[token];
  }
  cursor[tokens[tokens.length - 1]] = cloneJson(value);
}

function operationRequiresCurrentFactProjection(operation, baselineNotes, profile) {
  const currentKindNeedsBridge = (noteKind, factId, note) => (
    noteKind === 'fact' && !(profile && note && scalarProfilePathForNote(profile, note))
  ) || (noteKind === 'position' && !POSITION_PROJECTIONS[factId]);
  if (['upsert_note', 'correct_note', 'reclassify_note'].includes(operation.op)
    && currentKindNeedsBridge(operation.noteKind, operation.factId, operation)) return true;
  if (['reclassify_note', 'retract_note'].includes(operation.op)) {
    const target = baselineNotes.find((note) => note.noteId === operation.targetNoteId);
    if (target && currentKindNeedsBridge(target.noteKind, target.factId, target)) return true;
  }
  if (operation.op === 'merge_entities') {
    return baselineNotes.some((note) => operation.sourceEntityIds.includes(note.entityId)
      && note.lifecycle === 'active'
      && currentKindNeedsBridge(note.noteKind, note.factId, note));
  }
  return false;
}

function sidecarRecord(note) {
  return {
    ledgerNoteId: note.noteId,
    factId: note.factId,
    ...(note.factInstanceId ? { factInstanceId: note.factInstanceId } : {}),
    ...(note.entityId ? { entityId: note.entityId } : {}),
    ...(note.ownerId ? { ownerId: note.ownerId } : {}),
    value: cloneJson(note.value),
    certainty: note.certainty,
    evidenceRefs: cloneJson(note.evidenceRefs)
  };
}

function assertPositionRecord(note, projection) {
  if (!isPlainObject(note.value)) {
    fail('position_value_invalid', `Position note ${note.noteId} must contain one canonical profile record.`);
  }
  if (note.value[projection.idKey] !== note.entityId) {
    fail(
      'position_entity_mismatch',
      `Position note ${note.noteId} value.${projection.idKey} must equal its stable entityId.`
    );
  }
  if (projection.ownerKey === 'ownerId' && note.ownerId && note.value.ownerId !== note.ownerId) {
    fail('position_owner_mismatch', `Position note ${note.noteId} has conflicting owner identities.`);
  }
  if (projection.ownerKey === 'ownerIds' && note.ownerId
    && (!Array.isArray(note.value.ownerIds) || !note.value.ownerIds.includes(note.ownerId))) {
    fail('position_owner_mismatch', `Position note ${note.noteId} value must include its ownerId.`);
  }
}

/**
 * Project active ledger records into HouseholdProfile v1 without arbitrary
 * paths. Only complete records for the closed position fact allowlist can
 * affect current holdings. Planning-only note kinds go exclusively to their
 * assumptions sidecars.
 *
 * A POSITION NOTE THIS CONTRACT CANNOT REPRESENT IS QUARANTINED, NOT FATAL.
 *
 * This used to throw, and throwing was a session-ending trap. The projection
 * runs over the WHOLE ledger, not just the notes a plan touched, and the ledger
 * is re-read every turn. So one malformed note -- typically a realtime capture
 * whose value.ownerId disagreed with its own ownerId -- made every subsequent
 * reconciliation fail at this final global step. Correctly validated,
 * fully evidenced operations about entirely unrelated facts came back as
 * `discarded_global_invariant`, forever, and the reconciler could never apply
 * the very correction that would have repaired the note wedging it.
 *
 * Quarantine is strictly MORE conservative than the alternative, not less. The
 * note is still refused the canonical profile; it is simply refused on its own
 * rather than taking the batch with it. Its entity is left out of `managedIds`
 * too, so whatever the profile already holds for that position survives
 * untouched instead of being dropped along with the note that can no longer
 * describe it. `onUnprojectable` reports each one so a quarantine is visible
 * and repairable rather than silent.
 *
 * This is the policy the scalar pass below already applies, stated in its own
 * comment. Positions were the inconsistency.
 */
/**
 * The canonical values a scalar note may take, best candidate first.
 *
 * The reconciler used to write `note.value` straight into the profile slot,
 * while the live lane ran the same conversational value through a per-fact
 * mapper first. So the two lanes disagreed about what a fact value IS. The
 * planner describes a fact -- `{"age": 57, "owner": "primary"}` -- and
 * `/primaryPerson/age` holds a number, so the write failed normalization and
 * was skipped in silence: a REQUIRED pension input, accepted and applied,
 * discarded on the way to the profile in every observed call.
 *
 * `mapFactValue` is the live lane's own mapper, injected rather than imported
 * so this module keeps no dependency on the worker. It only ever supplies a
 * candidate: it cannot widen where a fact may be written, because the path was
 * already decided by `scalarProfilePathForNote` and a value it refuses still
 * falls back to the raw one.
 *
 * Three rails keep an injected mapper from writing somewhere it was not asked
 * to. Its value is used ONLY when its own `fieldPath` agrees with the path
 * resolved here -- two independent resolvers reaching the same slot -- because
 * a mapper that means `/goals/0` must never have its value written to
 * `/goals`. A null canonical value is dropped: a deletion is what a
 * `completion` note and its sidecar are for, and must not arrive through the
 * scalar bridge. And a mapper that OWNS a fact has the last word on it: when
 * it refuses the value, there is no raw fallback.
 *
 * That last rail is what stops a descriptive object reaching a slot with no
 * shape of its own. `/assumptions/values/persona/*` holds vocabulary terms and
 * the profile contract cannot tell one string from another, so a raw
 * `{"employmentType":"permanent","occupation":"IT developer"}` normalises
 * cleanly and lands as canonical nonsense. The mapper knows the vocabulary;
 * where it says no, the note stays in the ledger as evidence and the fact
 * stays uncanonicalised, which is the honest answer.
 */
function canonicalScalarCandidates(profile, note, path, mapFactValue) {
  const candidates = [];
  if (mapFactValue) {
    let mapped = null;
    try {
      mapped = mapFactValue(profile, note);
    } catch (_error) {
      mapped = { refused: true };
    }
    if (isPlainObject(mapped) && mapped.refused === true) return [];
    const canonical = mappedValueForPath(mapped, path);
    if (canonical !== null && typeof canonical !== 'undefined') candidates.push(canonical);
  }
  candidates.push(note.value);
  return candidates.filter((value, index) => (
    index === 0 || stableStringify(value) !== stableStringify(candidates[0])
  ));
}

/**
 * The mapper's own value for EXACTLY this slot, or undefined.
 *
 * WHY A PREFIX IS NOT A WIDENING. Some facts canonicalise as a named field
 * inside a parent object: the mapper answers for `/assumptions/values/retirement`
 * with `{targetIncomeToday: 45000}`, while `scalarProfilePathForNote` resolves
 * the leaf `/assumptions/values/retirement/targetIncomeToday`. A bare `===`
 * comparison called those two answers a disagreement and dropped the mapped
 * value, so `target_retirement_income` fell through to the RAW note value and
 * `{amount: 45000, currency: "EUR"}` was written into a slot that holds a bare
 * number. It normalised cleanly — the profile contract cannot tell one object
 * from another there — and the pension analysis then refused to run against its
 * own required input, reporting `analysis_missing_information` on a figure the
 * client had stated plainly. Same family as the `/primaryPerson/age` loss this
 * bridge was built for, one level of nesting further out.
 *
 * The rail the `===` was protecting still holds, because the direction matters.
 * Only a mapper answering for an ANCESTOR of the resolved path is unwrapped, and
 * only by walking the exact remaining segments through plain objects — so the
 * value returned is the one the mapper itself placed at that precise slot, not
 * an inference about it. A mapper answering for something NARROWER than the
 * resolved path is still refused: `/goals/0` may not be written to `/goals`.
 * Anything the walk cannot resolve returns undefined and the caller falls back
 * exactly as it did before, so no other fact changes behaviour.
 */
function mappedValueForPath(mapped, path) {
  if (!isPlainObject(mapped) || typeof mapped.fieldPath !== 'string') return undefined;
  if (mapped.fieldPath === path) return mapped.canonicalValue;
  // An empty or root fieldPath would address the whole profile. That is the
  // widening this function exists to refuse.
  if (mapped.fieldPath.length <= 1 || !path.startsWith(`${mapped.fieldPath}/`)) return undefined;
  let cursor = mapped.canonicalValue;
  for (const token of path.slice(mapped.fieldPath.length + 1).split('/')) {
    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, token)) return undefined;
    cursor = cursor[token];
  }
  return cursor;
}

export function projectPlanningNotesToProfile(rawProfile, rawNotes, {
  onUnprojectable = () => {},
  mapFactValue = null
} = {}) {
  const profile = normalizeHouseholdProfile(rawProfile);
  const notes = normalizePlanningNotesV1(rawNotes);
  const next = cloneJson(profile);

  for (const [factId, projection] of Object.entries(POSITION_PROJECTIONS)) {
    const related = notes.filter((note) => note.factId === factId && note.noteKind === 'position');
    const quarantined = new Set();
    for (const note of related) {
      if (note.lifecycle !== 'active') continue;
      try {
        assertPositionRecord(note, projection);
      } catch (error) {
        quarantined.add(note.noteId);
        onUnprojectable({
          noteId: note.noteId,
          factId,
          entityId: note.entityId || null,
          code: error instanceof ReconciliationValidationError ? error.code : 'position_unprojectable',
          message: error.message
        });
      }
    }
    // Quarantined notes forfeit their claim on the collection, so the record
    // the profile already holds stays put rather than vanishing with them.
    const usable = related.filter((note) => !quarantined.has(note.noteId));
    const managedIds = new Set(usable.map((note) => note.entityId));
    const active = usable.filter((note) => note.lifecycle === 'active');
    const activeIds = active.map((note) => note.entityId);
    if (new Set(activeIds).size !== activeIds.length) {
      fail('active_position_duplicate', `More than one active ${factId} note targets the same entity.`);
    }
    const unmanaged = (next[projection.collection] || [])
      .filter((record) => !managedIds.has(record[projection.idKey]));
    const projected = active.map((note) => cloneJson(note.value));
    next[projection.collection] = [...unmanaged, ...projected];
  }

  // Scalar facts. A correction to a retirement age, a spending figure or an
  // income was accepted by the validator and then had nowhere to go: only
  // positions and the planning sidecars were projected, so the ledger recorded
  // the fix and the profile never saw it. Written oldest-first so a later note
  // for the same path wins, and only where the path is unambiguous.
  // Ties break on LEDGER ORDER, not on note id. Two notes written by the same
  // batch share a createdAt, and an alphabetical tiebreak decided which of them
  // reached the profile by the spelling of its operation id: a correction to
  // €6,200 lost to the €5,800 it was correcting because "corrected" sorts
  // before "first". Ledger order is the order the operations were applied,
  // which is the order the client said them in.
  const ledgerPosition = new Map(notes.map((note, index) => [note.noteId, index]));
  const scalarNotes = notes
    .filter((note) => note.noteKind === 'fact' && note.lifecycle === 'active')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || ledgerPosition.get(left.noteId) - ledgerPosition.get(right.noteId));
  for (const note of scalarNotes) {
    const path = scalarProfilePathForNote(next, note);
    if (!path) continue;
    // A scalar the profile contract will not accept is skipped, not fatal. The
    // registry says where a fact lives, not what shape that field takes, so a
    // value the reconciler was right to record can still be wrong for the slot
    // it maps to. Failing the whole reconciliation over one of those would
    // throw away every other correction in the batch -- the projection is a
    // best-effort bridge, and what it cannot place stays in the ledger.
    //
    // Skipped is not the same as unobserved, though. This used to `continue`
    // in silence, so a required module input could be accepted, applied and
    // dropped while the result reported `fullyProjected: true`. Every skip is
    // now reported through the same channel as a quarantined position, which
    // is what makes the loss measurable instead of invisible.
    let written = false;
    let failure = null;
    for (const value of canonicalScalarCandidates(next, note, path, mapFactValue)) {
      const trial = cloneJson(next);
      writeProfilePath(trial, path, value);
      try {
        normalizeHouseholdProfile(trial);
      } catch (error) {
        failure = failure || error;
        continue;
      }
      writeProfilePath(next, path, value);
      written = true;
      break;
    }
    if (!written) {
      onUnprojectable({
        noteId: note.noteId,
        factId: note.factId,
        entityId: note.entityId || null,
        code: 'scalar_value_unprojectable',
        message: `Note ${note.noteId} holds no value ${path} accepts: ${failure?.message || 'unknown'}`
      });
    }
  }

  const planning = next.assumptions.values.planning;
  const ledgerNoteIds = new Set(notes.map((note) => note.noteId));
  for (const [noteKind, sidecarKey] of Object.entries(SIDECAR_KEYS)) {
    const sidecarAlreadyExists = Array.isArray(planning[sidecarKey]);
    const existing = sidecarAlreadyExists ? planning[sidecarKey] : [];
    const unmanaged = existing.filter((item) => (
      !isPlainObject(item) || !item.ledgerNoteId || !ledgerNoteIds.has(item.ledgerNoteId)
    ));
    const projected = notes
      .filter((note) => note.noteKind === noteKind && note.lifecycle === 'active')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.noteId.localeCompare(right.noteId))
      .map(sidecarRecord);
    if (sidecarAlreadyExists || unmanaged.length > 0 || projected.length > 0) {
      planning[sidecarKey] = [...unmanaged, ...projected];
    }
  }
  return normalizeHouseholdProfile(next);
}

function profileContent(profile) {
  const comparable = cloneJson(profile);
  delete comparable.revision;
  delete comparable.updatedAt;
  delete comparable.confirmedAt;
  return comparable;
}

/** Stable, server-bound input for an idempotency hash. */
export function buildReconciliationIdempotencyInput({
  sessionId,
  transcriptWatermark,
  baseProfileRevision,
  plan
}) {
  return {
    schemaVersion: 1,
    sessionId: nonEmptyString(sessionId, 'sessionId'),
    transcriptWatermark: nonEmptyString(transcriptWatermark, 'transcriptWatermark'),
    baseProfileRevision: finiteNumber(baseProfileRevision, 'baseProfileRevision', { min: 0, integer: true }),
    plan: normalizeReconciliationPlanV1(plan)
  };
}

export async function hashReconciliationPlan(input) {
  return sha256Json(buildReconciliationIdempotencyInput(input));
}

/**
 * Validate dependency groups and apply every wholly valid group to a cloned
 * ledger. Independent invalid groups are rejected. Profile normalization is a
 * final global invariant: if it fails, neither notes nor profile are returned
 * as applied.
 */
export async function applyReconciliationPlan({
  profile: rawProfile,
  notes: rawNotes,
  plan: rawPlan,
  transcriptTurns: rawTurns,
  sessionId,
  transcriptWatermark,
  baseProfileRevision,
  appliedPlanHashes = [],
  owners = [],
  entities = [],
  // The live lane's fact mapper, injected by the worker. Absent, the projection
  // writes raw note values exactly as before, which keeps this module free of
  // any worker import and every existing caller behaving identically.
  mapFactValue = null,
  nowIso = new Date().toISOString()
}) {
  const profile = normalizeHouseholdProfile(rawProfile);
  const notes = normalizePlanningNotesV1(rawNotes, { nowIso });
  const plan = normalizeReconciliationPlanV1(rawPlan);
  const turns = normalizeTranscriptTurns(rawTurns);
  const idempotencyInput = buildReconciliationIdempotencyInput({
    sessionId,
    transcriptWatermark,
    baseProfileRevision,
    plan
  });
  const planHash = await sha256Json(idempotencyInput);
  const baseline = {
    planHash,
    idempotencyInput,
    profile,
    notes,
    profileChanged: false,
    ledgerChanged: false,
    acceptedGroupIds: [],
    acceptedOperationIds: [],
    rejectedGroups: [],
    operationOutcomes: [],
    reviewOutcomes: [],
    clarificationNeeds: [],
    unprojectedFactOperationIds: [],
    fullyProjected: true
  };

  if (new Set(appliedPlanHashes).has(planHash)) {
    return { ...baseline, status: 'duplicate' };
  }
  if (baseProfileRevision !== profile.revision) {
    return {
      ...baseline,
      status: 'conflicted',
      conflict: {
        code: 'base_profile_revision_stale',
        expectedRevision: profile.revision,
        receivedRevision: baseProfileRevision
      }
    };
  }

  const context = {
    owners: ownerRecords(profile, owners),
    entities: entityRecords(profile, entities),
    turnIndex: new Map(turns.map((turn) => [turn.turnId, turn]))
  };
  const verifiedReviewedNoteIds = new Set();
  const reviewOutcomes = [];
  for (const reviewedNoteId of plan.reviewedNoteIds) {
    const reviewedNote = notes.find((note) => note.noteId === reviewedNoteId);
    if (!reviewedNote) {
      reviewOutcomes.push({
        noteId: reviewedNoteId,
        status: 'rejected',
        code: 'review_note_unknown'
      });
      continue;
    }
    try {
      assertStoredNoteEvidence(reviewedNote, context.turnIndex);
      verifiedReviewedNoteIds.add(reviewedNoteId);
      reviewOutcomes.push({ noteId: reviewedNoteId, status: 'verified' });
    } catch (error) {
      reviewOutcomes.push({
        noteId: reviewedNoteId,
        status: 'rejected',
        code: error instanceof ReconciliationValidationError ? error.code : 'review_evidence_invalid'
      });
    }
  }

  let workingNotes = [...notes];
  const clarificationNeeds = [];
  const acceptedGroupIds = [];
  const acceptedOperationIds = [];
  const rejectedGroups = [];
  const operationOutcomes = [];
  const acceptedOperations = [];

  // After the plan hash, so idempotency still keys off exactly what the model
  // returned; the decomposition is a validation detail, not a different plan.
  for (const group of splitIndependentOperationGroups(plan.operationGroups)) {
    let groupNotes = [...workingNotes];
    const groupNeeds = [];
    let rejection = null;
    for (const operation of group.operations) {
      try {
        const { targetNote, evidenceRefs } = validateOperation(operation, groupNotes, context);
        const applied = applyValidatedOperation(
          groupNotes,
          operation,
          targetNote,
          evidenceRefs,
          assertIsoDateTime(nowIso, 'nowIso')
        );
        groupNotes = applied.notes;
        groupNeeds.push(...applied.clarificationNeeds);
      } catch (error) {
        rejection = {
          groupId: group.groupId,
          operationId: operation.operationId,
          code: error instanceof ReconciliationValidationError ? error.code : 'operation_invalid',
          message: error.message
        };
        const need = rejectedNeed(operation, groupNotes, context, rejection.code);
        if (need) groupNeeds.push(need);
        break;
      }
    }
    // THE PROFILE INVARIANTS, CHECKED PER GROUP RATHER THAN ONCE AT THE END.
    //
    // These invariants are not negotiable and are not relaxed here: a group
    // whose notes cannot project into a valid HouseholdProfile is still
    // refused in full. What changes is WHO ELSE it takes down. Checking only
    // after every accepted group had been merged made the first invalid note
    // fail the entire batch — observed live as one operation proposing
    // `"type": "pension"` (not a pension type) discarding six independent and
    // entirely valid operations: an age, an income, a spending correction, a
    // retirement scenario, a summary and a clarification.
    //
    // The check is cumulative, so a group that is only invalid in combination
    // with an earlier one is attributed to the later group — the one that
    // introduced the conflict. The final whole-profile projection below still
    // runs and still fails closed; it should now have nothing left to catch.
    if (!rejection) {
      try {
        projectPlanningNotesToProfile(profile, groupNotes, { mapFactValue });
      } catch (error) {
        const culprit = group.operations.at(-1);
        rejection = {
          groupId: group.groupId,
          operationId: culprit.operationId,
          code: error instanceof ReconciliationValidationError
            ? error.code
            : 'profile_invariant_failed',
          message: error.message
        };
        const need = rejectedNeed(culprit, workingNotes, context, rejection.code);
        if (need) groupNeeds.push(need);
      }
    }
    if (rejection) {
      const rejected = {
        ...rejection,
        operationIds: group.operations.map((operation) => operation.operationId)
      };
      rejectedGroups.push(rejected);
      group.operations.forEach((operation) => {
        operationOutcomes.push({
          groupId: group.groupId,
          operationId: operation.operationId,
          status: operation.operationId === rejection.operationId
            ? 'rejected'
            : 'discarded_group_atomicity',
          code: operation.operationId === rejection.operationId
            ? rejection.code
            : 'dependency_group_rejected'
        });
      });
      clarificationNeeds.push(...groupNeeds);
      continue;
    }
    workingNotes = groupNotes;
    acceptedGroupIds.push(group.groupId);
    acceptedOperationIds.push(...group.operations.map((operation) => operation.operationId));
    acceptedOperations.push(...group.operations);
    group.operations.forEach((operation) => operationOutcomes.push({
      groupId: group.groupId,
      operationId: operation.operationId,
      status: 'accepted'
    }));
    clarificationNeeds.push(...groupNeeds);
  }

  workingNotes = workingNotes.map((note) => {
    if (!verifiedReviewedNoteIds.has(note.noteId)
      || note.lifecycle !== 'active'
      || note.reviewStatus !== 'provisional') return note;
    return normalizePlanningNoteV1({
      ...note,
      reviewStatus: 'planner_verified',
      reviewedAt: nowIso
    }, { nowIso });
  });

  let projected;
  // Reported, never fatal. A quarantined note is a repair target for the next
  // pass, so it has to reach the caller rather than disappearing into a
  // best-effort projection.
  const unprojectableNotes = [];
  try {
    projected = projectPlanningNotesToProfile(profile, workingNotes, {
      onUnprojectable: (entry) => unprojectableNotes.push(entry),
      mapFactValue
    });
  } catch (error) {
    return {
      ...baseline,
      status: 'failed',
      rejectedGroups: [
        ...rejectedGroups,
        { groupId: '*', operationId: '*', code: error.code || 'profile_invariant_failed', message: error.message }
      ],
      operationOutcomes: operationOutcomes.map((outcome) => (
        outcome.status === 'accepted'
          ? { ...outcome, status: 'discarded_global_invariant', code: 'profile_invariant_failed' }
          : outcome
      )),
      reviewOutcomes,
      clarificationNeeds
    };
  }

  const profileChanged = stableStringify(profileContent(projected)) !== stableStringify(profileContent(profile));
  let finalProfile = profile;
  if (profileChanged) {
    const next = cloneJson(projected);
    next.revision = profile.revision + 1;
    next.updatedAt = assertIsoDateTime(nowIso, 'nowIso');
    delete next.confirmedAt;
    try {
      finalProfile = normalizeHouseholdProfile(next);
    } catch (error) {
      return {
        ...baseline,
        status: 'failed',
        rejectedGroups: [
          ...rejectedGroups,
          { groupId: '*', operationId: '*', code: 'profile_invariant_failed', message: error.message }
        ],
        operationOutcomes: operationOutcomes.map((outcome) => (
          outcome.status === 'accepted'
            ? { ...outcome, status: 'discarded_global_invariant', code: 'profile_invariant_failed' }
            : outcome
        )),
        reviewOutcomes,
        clarificationNeeds
      };
    }
  }
  const ledgerChanged = stableStringify(workingNotes) !== stableStringify(notes);
  const unprojectedFactOperationIds = acceptedOperations
    .filter((operation) => operationRequiresCurrentFactProjection(operation, notes, finalProfile))
    .map((operation) => operation.operationId);
  const fullyProjected = unprojectedFactOperationIds.length === 0;
  return {
    status: !fullyProjected
      ? 'needs_profile_projection'
      : profileChanged || ledgerChanged || acceptedGroupIds.length > 0 ? 'applied' : 'no_change',
    planHash,
    idempotencyInput,
    profile: finalProfile,
    notes: workingNotes,
    profileChanged,
    ledgerChanged,
    acceptedGroupIds,
    acceptedOperationIds,
    // Ledger notes the position contract cannot represent. They are excluded
    // from the canonical profile and listed here so the next pass can repair
    // them; they no longer take the rest of the batch down with them.
    unprojectableNotes,
    rejectedGroups,
    operationOutcomes,
    reviewOutcomes,
    clarificationNeeds,
    unprojectedFactOperationIds,
    fullyProjected
  };
}
