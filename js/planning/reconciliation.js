import { normalizeHouseholdProfile } from './profile.js';
import { getSemanticFactDefinition } from './semantic_facts.js';
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

const NEED_IMPORTANCES = Object.freeze(['required', 'recommended', 'optional']);
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

const POSITION_PROJECTIONS = Object.freeze({
  asset_position: Object.freeze({ collection: 'assets', idKey: 'assetId', ownerKey: 'ownerIds' }),
  liability_position: Object.freeze({ collection: 'liabilities', idKey: 'liabilityId', ownerKey: 'ownerIds' }),
  mortgage_position: Object.freeze({ collection: 'liabilities', idKey: 'liabilityId', ownerKey: 'ownerIds' }),
  loan_position: Object.freeze({ collection: 'liabilities', idKey: 'liabilityId', ownerKey: 'ownerIds' }),
  income_sources: Object.freeze({ collection: 'incomeSources', idKey: 'incomeId', ownerKey: 'ownerId' }),
  pension_positions: Object.freeze({ collection: 'pensions', idKey: 'pensionId', ownerKey: 'ownerId' }),
  property_position: Object.freeze({ collection: 'properties', idKey: 'propertyId', ownerKey: 'ownerIds' }),
  business_position: Object.freeze({ collection: 'businesses', idKey: 'businessId', ownerKey: 'ownerIds' }),
  dependants: Object.freeze({ collection: 'dependants', idKey: 'dependantId', ownerKey: null })
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
  result.push({
    entityId: profile.primaryPerson.personId,
    factIds: ['person_current_age', 'intended_retirement_age'],
    ownerIds: [profile.primaryPerson.personId],
    label: profile.primaryPerson.displayName || 'you',
    collection: 'people'
  });
  if (profile.partner) {
    result.push({
      entityId: profile.partner.personId,
      factIds: ['partner_person', 'person_current_age', 'intended_retirement_age'],
      ownerIds: [profile.partner.personId],
      label: profile.partner.displayName || 'your partner',
      collection: 'people'
    });
  }
  return result;
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
  const factInstanceId = operation.factInstanceId
    || (targetNote?.factId === operation.factId ? targetNote.factInstanceId : null)
    || (operation.entityId ? `${operation.factId}:${operation.entityId}` : operation.factId);
  const entityId = operation.entityId || targetNote?.entityId || null;
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
  if (targetNote) {
    next = replaceNote(next, targetNote.noteId, (note) => normalizePlanningNoteV1({
      ...note,
      lifecycle: 'superseded',
      reviewStatus: 'planner_corrected',
      reviewedAt: nowIso
    }, { nowIso }));
  }
  next.push(noteFromOperation(operation, targetNote, evidenceRefs, nowIso));
  return { notes: next, clarificationNeeds: [] };
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
function scalarProfilePathForNote(profile, note) {
  // A collection fact is not a scalar. `pension_positions` maps to `/pensions`,
  // so a fact-kind note carrying a count would replace the whole array with a
  // number. Holdings are projected by the position machinery and nothing else.
  if (POSITION_PROJECTIONS[note.factId]) return null;
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
 */
export function projectPlanningNotesToProfile(rawProfile, rawNotes) {
  const profile = normalizeHouseholdProfile(rawProfile);
  const notes = normalizePlanningNotesV1(rawNotes);
  const next = cloneJson(profile);

  for (const [factId, projection] of Object.entries(POSITION_PROJECTIONS)) {
    const related = notes.filter((note) => note.factId === factId && note.noteKind === 'position');
    const managedIds = new Set(related.map((note) => note.entityId));
    const active = related.filter((note) => note.lifecycle === 'active');
    const activeIds = active.map((note) => note.entityId);
    if (new Set(activeIds).size !== activeIds.length) {
      fail('active_position_duplicate', `More than one active ${factId} note targets the same entity.`);
    }
    const unmanaged = (next[projection.collection] || [])
      .filter((record) => !managedIds.has(record[projection.idKey]));
    const projected = active.map((note) => {
      assertPositionRecord(note, projection);
      return cloneJson(note.value);
    });
    next[projection.collection] = [...unmanaged, ...projected];
  }

  // Scalar facts. A correction to a retirement age, a spending figure or an
  // income was accepted by the validator and then had nowhere to go: only
  // positions and the planning sidecars were projected, so the ledger recorded
  // the fix and the profile never saw it. Written oldest-first so a later note
  // for the same path wins, and only where the path is unambiguous.
  const scalarNotes = notes
    .filter((note) => note.noteKind === 'fact' && note.lifecycle === 'active')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.noteId.localeCompare(right.noteId));
  for (const note of scalarNotes) {
    const path = scalarProfilePathForNote(next, note);
    if (!path) continue;
    // A scalar the profile contract will not accept is skipped, not fatal. The
    // registry says where a fact lives, not what shape that field takes, so a
    // value the reconciler was right to record can still be wrong for the slot
    // it maps to. Failing the whole reconciliation over one of those would
    // throw away every other correction in the batch -- the projection is a
    // best-effort bridge, and what it cannot place stays in the ledger.
    const trial = cloneJson(next);
    writeProfilePath(trial, path, note.value);
    try {
      normalizeHouseholdProfile(trial);
    } catch (_error) {
      continue;
    }
    writeProfilePath(next, path, note.value);
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

  for (const group of plan.operationGroups) {
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
  try {
    projected = projectPlanningNotesToProfile(profile, workingNotes);
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
    rejectedGroups,
    operationOutcomes,
    reviewOutcomes,
    clarificationNeeds,
    unprojectedFactOperationIds,
    fullyProjected
  };
}
