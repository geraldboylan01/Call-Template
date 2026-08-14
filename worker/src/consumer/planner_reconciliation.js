/**
 * T2 transcript-to-notes reconciliation.
 *
 * This model call is deliberately separate from the low-latency T1 extractor.
 * It can propose only the closed semantic operations normalized and validated
 * by js/planning/reconciliation.js. It never receives JSON Patch authority and
 * it never confirms a profile or authorises an analysis run.
 */

import {
  PLANNING_NOTE_CERTAINTIES,
  PLANNING_NOTE_KINDS,
  RECONCILIATION_OPERATIONS,
  RECONCILIATION_REASON_CODES,
  applyReconciliationPlan,
  buildReconciliationIdentityCatalogue,
  normalizeNeedV2,
  normalizePlanningNotesV1,
  normalizeReconciliationPlanV1
} from '../../../js/planning/reconciliation.js';
import {
  getSemanticFactDefinition,
  listSemanticFactDefinitions,
  resolveSemanticFact
} from '../../../js/planning/semantic_facts.js';
import { getPlanningModuleDefinition } from '../../../js/planning/module_registry.js';
import { ConsumerError } from './errors.js';
import { stableStringify } from './crypto.js';
import { toConsumerRealtimePlanningLists } from './planning_context.js';
import {
  buildConfirmedRealtimeFactSummary,
  mapRealtimeFact,
  realtimeChoiceVocabulary,
  realtimeFactValueVocabulary
} from './realtime_fact_mapper.js';
import { plannerContextSlice } from './realtime_planner.js';
import {
  completePlannerReconciliation,
  ensureLegacyPlanningNotes,
  listPlanningNotes,
  listReconciliationTranscriptWindow,
  listRealtimeWriteOutcomes,
  loadPlannerReconciliation,
  recordRealtimeUsage,
  startPlannerReconciliation
} from './realtime_repository.js';

const PLANNER_RECONCILIATION_V1 = 'ReconciliationPlanV1';

const FACT_IDS = Object.freeze(
  listSemanticFactDefinitions().map((definition) => definition.factId).sort()
);
const SAFE_PROVIDER_ID = /^[A-Za-z0-9._:-]{1,200}$/;

const RECONCILIATION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    verdict: {
      type: 'string',
      enum: ['clean', 'changes_proposed', 'clarification_required']
    },
    reviewedNoteIds: {
      type: 'array',
      maxItems: 200,
      items: { type: 'string', maxLength: 160 }
    },
    operationGroups: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          groupId: { type: 'string', maxLength: 160 },
          atomic: { type: 'boolean' },
          operations: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: {
              type: 'object',
              properties: {
                operationId: { type: 'string', maxLength: 160 },
                op: { type: 'string', enum: RECONCILIATION_OPERATIONS },
                targetNoteId: { type: 'string', maxLength: 160 },
                factId: { type: 'string', enum: FACT_IDS },
                factInstanceId: { type: 'string', maxLength: 240 },
                entityId: { type: 'string', maxLength: 160 },
                ownerId: { type: 'string', maxLength: 160 },
                noteKind: { type: 'string', enum: PLANNING_NOTE_KINDS },
                certainty: { type: 'string', enum: PLANNING_NOTE_CERTAINTIES },
                targetEntityId: { type: 'string', maxLength: 160 },
                sourceEntityIds: {
                  type: 'array',
                  maxItems: 12,
                  items: { type: 'string', maxLength: 160 }
                },
                valueJson: { type: 'string', maxLength: 4_000 },
                reasonCode: { type: 'string', enum: RECONCILIATION_REASON_CODES },
                evidence: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 6,
                  items: {
                    type: 'object',
                    properties: {
                      turnId: { type: 'string', maxLength: 160 },
                      quote: { type: 'string', maxLength: 1_000 }
                    },
                    required: ['turnId', 'quote'],
                    additionalProperties: false
                  }
                }
              },
              required: [
                'operationId', 'op', 'targetNoteId', 'factId',
                'factInstanceId', 'entityId', 'ownerId', 'noteKind',
                'certainty', 'targetEntityId', 'sourceEntityIds', 'valueJson',
                'reasonCode', 'evidence'
              ],
              additionalProperties: false
            }
          }
        },
        required: ['groupId', 'atomic', 'operations'],
        additionalProperties: false
      }
    }
  },
  required: ['schemaVersion', 'verdict', 'reviewedNoteIds', 'operationGroups'],
  additionalProperties: false
});

const SYSTEM_PROMPT = `You are Planéir's background planning-note reconciler.

The realtime voice model has already written provisional notes. Compare those notes with the finalized transcript and the current deterministic needs. Return only the closed ReconciliationPlanV1 operations in the schema.

Evidence rules:
- Only finalized CLIENT transcript turns are evidence. Assistant text, current notes, requirements and profile state are context, never evidence.
- Every operation must quote an exact, contiguous client span from the cited turn.
- Every proposed number must appear in its cited quote. Do not calculate totals, dates, percentages, midpoints or conversions.
- Use only supplied note, entity, owner and fact identities. Never invent an identity or JSON path.
- An entity is valid for a fact only when the entity's factIds list that fact. Resolve a spoken reference by matching it against entity labels and aliases; where two entities match equally well, request_clarification instead of picking one.
- A fact in singletonFactIds has ONE household-wide slot. Give it entity householdScopeEntityId or no entity at all. Never attach it to the partner or to a position: there is no per-person slot, and naming one would overwrite the client's own value with somebody else's.
- Where factContracts gives a fact choices, the value must be exactly one of those terms. Do not describe the answer in your own words or add extra keys. If no term fits the evidence, request_clarification.
- An entity marked newEntitySlot is a server-issued identity for one omitted position. Use one only when exact client evidence establishes that distinct position, and copy that slot ID into the canonical record's entity ID field.
- A partner or joint owner is valid only when that owner exists in the supplied household.
- Preserve uncertainty, ranges, explicit none and which person/position they concern.

Reconciliation rules:
- Put an omitted evidenced fact in upsert_note.
- Correct a wrong value or owner with correct_note and cite the corrective wording.
- Reclassify totals as summary, expected amounts as future_event, and unresolved alternatives as scenario_option.
- A stated total is not another holding. A future inheritance is not a current asset. A candidate retirement age is not a settled target.
- CLASSIFY EVERY AMOUNT AS ONE OR THE OTHER. A statement describing an individual holding ("the Zurich one is 415,000") is noteKind position. A statement describing a total, combined value, or the set as a whole ("about a million across the pensions", "altogether", "between them") is reasonCode aggregate_summary AND noteKind summary — the two must agree, and an aggregate_summary carrying any other noteKind is refused. Record the total; do not also record it as a holding, and do not split it into one holding per policy.
- Where a total was already written as a holding, repair it with reclassify_note to summary from that same note. That keeps the client's words and their evidence while taking the figure out of the holdings the analysis adds up.
- Retract or merge only when the transcript explicitly proves the note/entity is wrong or duplicated.
- Use set_completion for an exact owner/position unknown or none answer.
- If the transcript does not resolve an ambiguity safely, request_clarification with a complete NeedV2 value.
- selectedAnalyses[].inputs is what each analysis needs. Prioritise inputs marked missing whose evidence the client has already given; an input marked satisfied needs no further operation. Information no analysis consumes is still worth keeping as an evidence-backed note, and is not a failure.

Grouping rules:
- A group is a unit that lands together or not at all. One failing operation discards every other operation in its group, so grouping unrelated corrections together throws away correct work.
- Put each independent correction in its OWN group. Several corrections from one turn are normally several groups, not one.
- Group operations together only when they describe the same note, entity or fact instance, or when applying one without the other would misstate the position.
- Set atomic true only for that second case — operations that must land together but share no identity. Otherwise set atomic false.
- reviewedNoteIds may contain only notes that already carry server-stored client offsets present in this context. A span-free realtime note cannot be verified by ID alone; replace it with an evidence-backed correct_note, even when its value is unchanged.
- Never add confirmation, readiness, selected-module or execution fields.
- If nothing needs changing or clarification, return verdict clean and no operations.`;

function responseOutputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content?.text === 'string') return content.text;
    }
  }
  return '';
}

const isPlainObject = (value) => Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value);

function parseValueJson(valueJson, operationId) {
  try {
    return JSON.parse(valueJson);
  } catch (_error) {
    throw new ConsumerError(
      502,
      'planner_reconciliation_output_invalid',
      `Reconciliation operation ${operationId} returned invalid JSON.`
    );
  }
}

/**
 * One operation's wire form. Throws only for that operation.
 *
 * `valueJson` is a JSON document inside a JSON string, so the structured-output
 * schema cannot constrain a single character of it, and the model does
 * occasionally emit something unparseable. That used to fail the WHOLE plan —
 * `Reconciliation operation op7 returned invalid JSON` discarded six other
 * correct operations that had nothing wrong with them. Same blast radius the
 * grouping fix removed, arriving through a different door.
 */
function normalizeModelOperation(operation) {
  const normalized = {
    operationId: operation.operationId,
    op: operation.op,
    reasonCode: operation.reasonCode,
    evidence: operation.evidence,
    sourceEntityIds: operation.sourceEntityIds
  };
  for (const key of [
    'targetNoteId', 'factId', 'factInstanceId', 'entityId', 'ownerId',
    'noteKind', 'certainty', 'targetEntityId'
  ]) {
    if (typeof operation[key] === 'string' && operation[key]) normalized[key] = operation[key];
  }
  if (typeof operation.valueJson === 'string') {
    normalized.value = parseValueJson(operation.valueJson, operation.operationId);
  }
  // A clarification carries a NeedV2, and the operation already states
  // that need's identity in its own required fields. Asking the model to
  // repeat it inside the value was a second chance to get it wrong, and
  // it did: a value missing factInstanceId failed the whole plan, so one
  // omitted field cost every other correction in the batch. Identity is
  // taken from the operation, which is the copy that gets validated
  // against the supplied allowlists anyway.
  if (operation.op === 'request_clarification' && isPlainObject(normalized.value)) {
    const factId = normalized.factId || normalized.value.factId;
    const entityId = normalized.entityId || normalized.value.entityId;
    // The NeedV2 goes inside a JSON string, so the structured-output
    // schema cannot constrain any of it. Every field the model has to
    // invent is a way to lose the whole plan: one out-of-enum
    // `importance` discarded a batch of otherwise valid corrections. The
    // enums are bookkeeping the server owns anyway, so they are coerced
    // to their defaults rather than trusted. Nothing here touches a
    // financial value, an identity or an evidence span.
    const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
    normalized.value = {
      ...normalized.value,
      ...(factId ? { factId } : {}),
      ...(entityId ? { entityId } : {}),
      ...(normalized.ownerId || normalized.value.ownerId
        ? { ownerId: normalized.ownerId || normalized.value.ownerId } : {}),
      factInstanceId: normalized.factInstanceId
        || normalized.value.factInstanceId
        || (factId && entityId ? `${factId}:${entityId}` : factId || ''),
      importance: oneOf(
        normalized.value.importance,
        ['required', 'recommended', 'optional'],
        'required'
      ),
      status: oneOf(
        normalized.value.status,
        ['open', 'estimate_requested', 'blocked_unknown', 'deferred', 'satisfied'],
        'open'
      ),
      answerPolicy: oneOf(
        normalized.value.answerPolicy,
        ['value', 'value_or_none', 'unknown_allowed'],
        'unknown_allowed'
      ),
      reasonCode: typeof normalized.value.reasonCode === 'string' && normalized.value.reasonCode
        ? normalized.value.reasonCode
        : operation.reasonCode || 'required_input_missing',
      prompt: typeof normalized.value.prompt === 'string' && normalized.value.prompt
        ? normalized.value.prompt
        : `Please clarify ${String(factId || 'this').replaceAll('_', ' ')}.`
    };
  }
  return normalized;
}

/**
 * The wire plan, with unusable operations dropped rather than the whole batch.
 *
 * An operation the server cannot even parse never reaches validation, so this
 * is not a relaxation: it is refused exactly as before. What changed is who
 * else it takes with it. A group that CLAIMED atomicity still loses all of its
 * operations when one is unusable — that is what the claim means — but an
 * unclaimed group keeps the operations that parsed.
 */
export function normalizeModelReconciliationPlan(raw) {
  const droppedOperations = [];
  const operationGroups = [];
  for (const group of (raw?.operationGroups || [])) {
    const atomic = group?.atomic === true;
    const rawOperations = group?.operations || [];
    const operations = [];
    let atomicGroupLost = false;
    for (const operation of rawOperations) {
      try {
        operations.push(normalizeModelOperation(operation));
      } catch (error) {
        droppedOperations.push({
          groupId: group?.groupId || null,
          operationId: operation?.operationId || null,
          code: error?.code || 'planner_reconciliation_output_invalid',
          reason: String(error?.message || '').slice(0, 200)
        });
        if (atomic) { atomicGroupLost = true; break; }
      }
    }
    if (atomicGroupLost) {
      for (const operation of rawOperations) {
        const operationId = operation?.operationId || null;
        if (droppedOperations.some((entry) => entry.operationId === operationId)) continue;
        droppedOperations.push({
          groupId: group?.groupId || null,
          operationId,
          code: 'dependency_group_rejected',
          reason: 'An atomic group lost an operation the server could not parse.'
        });
      }
      continue;
    }
    if (operations.length === 0) continue;
    // `atomic` is carried through. Dropping it here silently decomposed every
    // group the planner had deliberately claimed.
    operationGroups.push({ groupId: group?.groupId, atomic, operations });
  }

  const plan = {
    schemaVersion: raw?.schemaVersion,
    // If dropping unusable operations emptied the plan, the honest verdict is
    // that nothing could be changed, not a `changes_proposed` with nothing in
    // it — which the contract rightly refuses. Only a plan this function
    // actually emptied is downgraded; a model that returns `changes_proposed`
    // with no operations still fails, because that is its own mistake.
    verdict: raw?.verdict === 'changes_proposed'
      && operationGroups.length === 0
      && droppedOperations.length > 0
      ? 'clean'
      : raw?.verdict,
    reviewedNoteIds: raw?.reviewedNoteIds,
    operationGroups
  };
  try {
    return { plan: normalizeReconciliationPlanV1(plan), droppedOperations };
  } catch (error) {
    // ONE UNUSABLE GROUP IS NOT AN UNUSABLE PLAN.
    //
    // The per-operation loop above catches wire-shape errors, but the contract
    // normalizer runs afterwards over the whole plan and is all-or-nothing, so
    // a single `reclassify_note` missing its `targetNoteId` failed the entire
    // reconciliation. Observed live: four groups returned, three of them
    // perfectly valid, and the turn recorded nothing at all. That is the same
    // blast radius the per-operation parsing fix removed, one layer up.
    //
    // Re-normalize each group ALONE against the same contract. Nothing is
    // relaxed -- a group that cannot satisfy the contract is still refused in
    // full, and is reported as dropped rather than disappearing.
    const salvaged = [];
    for (const group of operationGroups) {
      try {
        normalizeReconciliationPlanV1({ ...plan, verdict: 'changes_proposed', operationGroups: [group] });
        salvaged.push(group);
      } catch (groupError) {
        for (const operation of group.operations) {
          droppedOperations.push({
            groupId: group.groupId || null,
            operationId: operation.operationId || null,
            code: 'planner_reconciliation_output_invalid',
            reason: String(groupError?.message || '').slice(0, 200)
          });
        }
      }
    }
    const reason = String(error?.message || '').slice(0, 300);
    if (salvaged.length > 0) {
      try {
        return {
          plan: normalizeReconciliationPlanV1({
            ...plan,
            verdict: 'changes_proposed',
            operationGroups: salvaged
          }),
          droppedOperations
        };
      } catch (_residual) {
        // Fall through: the refusal is in the plan envelope, not one group.
      }
    }
    // Nothing survived, or the envelope itself is wrong. The reason the shape
    // was refused is the only thing that makes this fixable.
    const failure = new ConsumerError(
      502,
      'planner_reconciliation_output_invalid',
      `The background planner returned an invalid reconciliation plan: ${reason}`
    );
    failure.metadata = { reason };
    throw failure;
  }
}

const OWNER_HINT_KEYS = Object.freeze(['owner', 'ownerId', 'ownerIds', 'owners', 'personId']);

/**
 * ONE CANONICALISATION FOR BOTH LANES.
 *
 * The live lane already turns a conversational fact value into the canonical
 * one -- `{"age": 57, "owner": "primary"}` into `57` at `/primaryPerson/age`,
 * a spoken choice into the vocabulary term, a rate into a fraction. The
 * reconciler wrote its note values into the profile raw, so the identical
 * sentence produced a canonical value down one lane and a dropped write down
 * the other. Every observed call lost the client's own age that way.
 *
 * The note carries the owner separately from the value, so hand the mapper an
 * owner it would otherwise have to assume -- but only into an object that does
 * not already state one, and never by reshaping a scalar or a money value.
 *
 * `null` and refusal are different answers and the projector treats them
 * differently. A fact outside the mapper's remit returns null, so the raw note
 * value is still projected exactly as it was before this adapter existed. A
 * fact the mapper OWNS but whose value it rejects returns a refusal, and that
 * is final -- no raw fallback smuggles an unvalidated value into the slot.
 */
function mapReconciledFactValue(profile, note) {
  const value = isPlainObject(note.value) && note.ownerId
    && !OWNER_HINT_KEYS.some((key) => Object.hasOwn(note.value, key))
    ? { ...note.value, ownerId: note.ownerId }
    : note.value;
  try {
    return mapRealtimeFact(profile, {
      factId: note.factId,
      value,
      ...(note.entityId ? { entityId: note.entityId } : {}),
      ...(note.ownerId ? { ownerId: note.ownerId } : {})
    });
  } catch (error) {
    return error?.code === 'realtime_fact_not_supported' ? null : { refused: true };
  }
}

const LEGACY_POSITION_COLLECTIONS = Object.freeze([
  ['assets', 'assetId', () => 'asset_position', (item) => (
    (item.ownerIds || []).length > 1 ? 'household' : item.ownerIds?.[0]
  )],
  ['properties', 'propertyId', () => 'property_position', (item) => (
    (item.ownerIds || []).length > 1 ? 'household' : item.ownerIds?.[0]
  )],
  ['pensions', 'pensionId', () => 'pension_positions', (item) => item.ownerId],
  ['liabilities', 'liabilityId', (item) => item.type === 'mortgage'
    ? 'mortgage_position' : item.type === 'loan' ? 'loan_position' : 'liability_position', (item) => (
    (item.ownerIds || []).length > 1 ? 'household' : item.ownerIds?.[0]
  )],
  ['incomeSources', 'incomeId', () => 'income_sources', (item) => item.ownerId],
  ['businesses', 'businessId', () => 'business_position', (item) => (
    (item.ownerIds || []).length > 1 ? 'household' : item.ownerIds?.[0]
  )],
  ['dependants', 'dependantId', () => 'dependants', () => null]
]);

const POSITION_FACT_IDS = new Set([
  'asset_position',
  'property_position',
  'pension_positions',
  'liability_position',
  'mortgage_position',
  'loan_position',
  'income_sources',
  'business_position',
  'dependants'
]);

function safeLegacyNoteId(profile, factInstanceId, index) {
  const raw = `legacy_${profile.profileId}_${factInstanceId}_${index}`;
  return raw.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 200);
}

/** Evidence-less snapshot notes for profile facts created before the ledger. */
export function legacyPlanningNotesFromProfile(profile) {
  const createdAt = profile.updatedAt || new Date(0).toISOString();
  const notes = [];
  const seen = new Set();
  const add = (note) => {
    if (!note.factInstanceId || seen.has(note.factInstanceId)) return;
    seen.add(note.factInstanceId);
    notes.push({
      schemaVersion: 1,
      noteId: safeLegacyNoteId(profile, note.factInstanceId, notes.length + 1),
      lifecycle: 'active',
      reviewStatus: 'provisional',
      source: 'legacy_import',
      evidenceRefs: [],
      replacesNoteIds: [],
      createdAt,
      ...note
    });
  };
  for (const [collection, idKey, factFor, ownerFor] of LEGACY_POSITION_COLLECTIONS) {
    for (const record of profile[collection] || []) {
      const entityId = record?.[idKey];
      if (!entityId) continue;
      const factId = factFor(record);
      const ownerId = ownerFor(record);
      add({
        noteKind: 'position',
        factId,
        factInstanceId: `${factId}:${entityId}`,
        entityId,
        ...(ownerId ? { ownerId } : {}),
        value: record,
        certainty: 'exact'
      });
    }
  }
  for (const fact of buildConfirmedRealtimeFactSummary(profile)) {
    if (POSITION_FACT_IDS.has(fact.factId)) continue;
    const resolved = resolveSemanticFact({
      factId: fact.factId,
      fieldPath: fact.fieldPath || '',
      entityId: fact.entityId || null
    }, { profile });
    const factInstanceId = resolved.factInstanceId
      || (fact.entityId ? `${fact.factId}:${fact.entityId}` : fact.factId);
    const explicitNone = fact.value === 'None'
      || fact.value?.operation === 'confirm_none';
    const completion = explicitNone || ['unknown', 'range'].includes(fact.certainty);
    add({
      noteKind: completion ? 'completion' : 'fact',
      factId: fact.factId,
      factInstanceId,
      ...(fact.entityId || resolved.entityId ? { entityId: fact.entityId || resolved.entityId } : {}),
      ...(fact.ownerId || resolved.ownerId ? { ownerId: fact.ownerId || resolved.ownerId } : {}),
      value: explicitNone ? { resolution: 'confirmed_none' } : fact.value,
      certainty: explicitNone ? 'none' : fact.certainty || 'unknown'
    });
  }
  return normalizePlanningNotesV1(notes, { nowIso: createdAt });
}

/**
 * What each selected analysis still needs, in the reconciler's own vocabulary.
 *
 * Adapters state a requirement as a profile path and leave the semantic
 * identity to be resolved, exactly as the question planner and the live
 * projection do. Reading `missing.factId` directly instead sent every need
 * through as `profile.unknown`, so the background planner was told an input was
 * outstanding, and for whom, but never which fact it was — and it can only bind
 * an operation to a fact it can name.
 */
function reconciliationNeeds(planning, profile) {
  const byInstance = new Map();
  for (const recommendation of planning.recommendations || []) {
    for (const missing of recommendation.requiredMissing || []) {
      const resolved = resolveSemanticFact(missing, {
        profile,
        moduleId: recommendation.moduleId
      });
      const factId = missing.factId || resolved.factId;
      const entityId = missing.entityId || resolved.entityId;
      const factInstanceId = missing.factInstanceId
        || resolved.factInstanceId
        || (entityId ? `${factId}:${entityId}` : factId);
      const current = byInstance.get(factInstanceId);
      const raw = {
        schemaVersion: 2,
        needId: current?.needId || `need_${factInstanceId}`.replace(/[^A-Za-z0-9_.:-]/g, '_'),
        factId,
        factInstanceId,
        ...(entityId ? { entityId } : {}),
        ...(missing.ownerId || resolved.ownerId ? { ownerId: missing.ownerId || resolved.ownerId } : {}),
        ...(missing.entityLabel || resolved.entityLabel
          ? { entityLabel: missing.entityLabel || resolved.entityLabel } : {}),
        reasonCode: missing.reasonCode || 'required_input_missing',
        prompt: missing.prompt || missing.reason || `Please clarify ${String(factId).replaceAll('_', ' ')}.`,
        importance: ['required', 'recommended', 'optional'].includes(missing.importance)
          ? missing.importance
          : 'required',
        blockingModuleIds: [...new Set([
          ...(current?.blockingModuleIds || []),
          recommendation.moduleId
        ])],
        answerPolicy: missing.answerPolicy || 'unknown_allowed',
        status: missing.status || 'open'
      };
      byInstance.set(factInstanceId, normalizeNeedV2(raw));
    }
  }
  return [...byInstance.values()];
}

const POSITION_SLOT_FACT_IDS = Object.freeze([
  'asset_position', 'liability_position', 'mortgage_position', 'loan_position',
  'income_sources', 'pension_positions', 'property_position', 'business_position'
]);

/**
 * WHAT EACH SELECTED ANALYSIS ACTUALLY NEEDS, and what it already has.
 *
 * The planner used to be told only that an analysis was `needs_facts`, with a
 * `blockingFactIds` array that was empty in every observed call. So it could
 * see that something was missing and never which canonical input, which is the
 * one thing that decides whether a spoken figure is worth canonicalising now.
 *
 * Readiness is keyed off validated canonical values and the deterministic need
 * list, never off freeform notes: a fact is `satisfied` only when it holds a
 * canonical value, and `missing` only when a module adapter says so.
 */
function moduleInputContract(moduleId, canonicalFacts, needs) {
  const contract = getPlanningModuleDefinition(moduleId)?.intakeContract;
  if (!contract || contract.status !== 'approved') return [];
  const satisfied = new Set(canonicalFacts.map((fact) => fact.factId));
  const missing = new Map();
  for (const need of needs) {
    if (!(need.blockingModuleIds || []).includes(moduleId)) continue;
    const entry = missing.get(need.factId) || { importance: need.importance, instances: [] };
    entry.instances.push(need.factInstanceId);
    missing.set(need.factId, entry);
  }
  return contract.semanticFactIds.map((factId) => {
    const outstanding = missing.get(factId);
    return {
      factId,
      status: outstanding ? 'missing' : satisfied.has(factId) ? 'satisfied' : 'not_supplied',
      ...(outstanding ? { missingInstances: outstanding.instances.slice(0, 6) } : {})
    };
  });
}

/** Blank-slot collections worth offering: the ones a selected analysis reads. */
function positionFactIdsForModules(selectedAnalyses) {
  const wanted = new Set(selectedAnalyses.flatMap((analysis) => (
    analysis.inputs.map((input) => input.factId)
  )));
  const offered = POSITION_SLOT_FACT_IDS.filter((factId) => wanted.has(factId));
  return offered.length > 0 ? offered : null;
}

/**
 * The value shape each fact accepts, so canonicalisation is not guesswork.
 *
 * A choice fact has a closed vocabulary and the reconciler was never shown it,
 * so it described the answer instead of naming it -- "permanent IT developer"
 * arrived as `{employmentType, occupation}` for a slot that holds one term.
 *
 * Only facts in play, and only those with a CLOSED vocabulary. A fact whose
 * value type the schema and the evidence rules already pin down learns nothing
 * from an entry here, and the latency budget has about a second of headroom:
 * everything in this prompt has to earn its tokens.
 */
function factValueContracts(factIds) {
  const vocabulary = realtimeChoiceVocabulary();
  const contracts = [];
  for (const factId of [...new Set(factIds.filter(Boolean))].sort()) {
    if (!getSemanticFactDefinition(factId)) continue;
    const choices = vocabulary[factId] || realtimeFactValueVocabulary(factId);
    if (!choices) continue;
    contracts.push({ factId, choices });
  }
  return contracts;
}

/**
 * Entities the ledger has retired, which must leave the catalogue.
 *
 * An aggregate reclassified to a summary stops being a holding, but its
 * evidence-free legacy snapshot stayed active and kept the entity alive: the
 * placeholder went on generating a required `pension_contribution_status` need
 * for a pension that no longer existed. An entity whose only remaining active
 * notes are summaries or completions is not a position any more.
 */
function retiredEntityIdsFromNotes(notes) {
  const byEntity = new Map();
  for (const note of notes) {
    if (!note?.entityId || note.lifecycle !== 'active') continue;
    const kinds = byEntity.get(note.entityId) || new Set();
    kinds.add(note.noteKind);
    byEntity.set(note.entityId, kinds);
  }
  return [...byEntity.entries()]
    .filter(([, kinds]) => kinds.size > 0
      && [...kinds].every((kind) => ['summary', 'scenario_option', 'future_event'].includes(kind)))
    .map(([entityId]) => entityId);
}

function signedQuestionContext(context) {
  const batch = context.state?.meetingBrief?.questionBatch;
  if (batch?.primaryFact?.factId) {
    return {
      prompt: batch.prompt || batch.primaryFact.prompt || '',
      primaryFact: batch.primaryFact,
      linkedFact: batch.linkedFact || null,
      boundFactInstanceIds: [batch.primaryFact, batch.linkedFact]
        .filter(Boolean)
        .map((fact) => fact.factInstanceId || fact.factId)
    };
  }
  const current = plannerContextSlice(context).currentQuestion;
  return current ? {
    prompt: current.prompt || '',
    primaryFact: current,
    linkedFact: null,
    boundFactInstanceIds: [current.factInstanceId || current.factId]
  } : null;
}

/**
 * Ordinary intake and a genuine block are different things to the reconciler.
 *
 * `needs_facts` means the meeting has simply not asked yet; `needs_information`
 * means the client cannot supply an input and the analysis is held. Collapsing
 * both into the latter told the planner every selected analysis was blocked,
 * which is the state in which chasing the remaining inputs looks pointless.
 */
function reconciliationModuleAvailability(slot) {
  const availability = String(slot?.availability || '').toLowerCase();
  if (['ready', 'needs_facts', 'needs_information', 'adviser_review_required'].includes(availability)) {
    return availability;
  }
  const values = [slot?.intakeStatus, slot?.status].map((value) => String(value || '').toLowerCase());
  if (values.some((value) => ['ready', 'complete', 'runnable'].includes(value))) return 'ready';
  return 'needs_facts';
}

export function buildPlannerReconciliationContext({
  context,
  turns,
  notes,
  throughTurnId,
  voiceWriteOutcomes = []
}) {
  const recent = turns.map((turn, sequence) => ({
    turnId: turn.id,
    role: turn.role,
    finalized: turn.finalized !== false,
    text: String(turn.transcript || '').slice(0, 4_000),
    sequence: Number.isSafeInteger(turn.sequence) ? turn.sequence : sequence
  }));
  const planning = toConsumerRealtimePlanningLists(context.state, context.profile);
  const canonicalFacts = buildConfirmedRealtimeFactSummary(context.profile);
  const needs = reconciliationNeeds(planning, context.profile);
  const moduleSlots = planning.moduleSlots || [];
  const selectedAnalyses = moduleSlots.map((slot) => {
    const availability = reconciliationModuleAvailability(slot);
    return {
      moduleId: slot.moduleId,
      description: slot.description,
      availability,
      runnable: availability === 'ready',
      intakeStatus: slot.intakeStatus,
      selectionState: slot.selectionState,
      inputs: moduleInputContract(slot.moduleId, canonicalFacts, needs)
    };
  });
  const catalogue = buildReconciliationIdentityCatalogue(context.profile, notes, {
    // Four blank slots per collection for eight collections was 32 of the 40
    // catalogue entries, nearly all of them never used. Two each, and only for
    // collections an analysis on the table actually reads, pays for the input
    // contract below without spending the latency budget.
    slotsPerCollection: 2,
    slotFactIds: positionFactIdsForModules(selectedAnalyses),
    retiredEntityIds: retiredEntityIdsFromNotes(notes)
  });
  return {
    schemaVersion: 1,
    throughTurnId,
    profileRevision: Number(context.profile.revision),
    transcriptTurns: recent,
    notes,
    owners: catalogue.owners,
    entities: catalogue.entities,
    singletonFactIds: catalogue.singletonFactIds,
    householdScopeEntityId: catalogue.householdScopeEntityId,
    factContracts: factValueContracts([
      ...canonicalFacts.map((fact) => fact.factId),
      ...needs.map((need) => need.factId),
      ...notes.map((note) => note.factId),
      ...selectedAnalyses.flatMap((analysis) => analysis.inputs.map((input) => input.factId))
    ]),
    canonicalFacts,
    needs,
    selectedAnalyses,
    currentQuestion: signedQuestionContext(context),
    voiceWriteOutcomes
  };
}

export async function requestPlannerReconciliation({ env, config, input }) {
  const model = config.realtimePlannerModel;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.plannerReconciliationTimeoutMs);
  const startedAt = Date.now();
  const clientRequestId = crypto.randomUUID();
  let apiResponse;
  try {
    apiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(env.OPENAI_API_KEY || '').trim()}`,
        'Content-Type': 'application/json',
        'X-Client-Request-Id': clientRequestId
      },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: config.plannerReconciliationMaxOutputTokens,
        reasoning: { effort: 'low' },
        input: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: stableStringify(input) }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'planning_reconciliation_v1',
            strict: true,
            schema: RECONCILIATION_SCHEMA
          }
        }
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ConsumerError(504, 'planner_reconciliation_timeout', 'The background planner timed out.');
    }
    throw new ConsumerError(502, 'planner_reconciliation_unavailable', 'The background planner is unavailable.');
  } finally {
    clearTimeout(timer);
  }
  const providerRequestId = SAFE_PROVIDER_ID.test(String(apiResponse.headers.get('x-request-id') || ''))
    ? apiResponse.headers.get('x-request-id')
    : null;
  if (!apiResponse.ok) {
    apiResponse.body?.cancel?.().catch?.(() => {});
    const error = new ConsumerError(502, 'planner_reconciliation_request_failed', 'The background planner request failed.');
    error.metadata = { providerRequestId, providerStatus: apiResponse.status, model, latencyMs: Date.now() - startedAt };
    throw error;
  }
  let response;
  try {
    response = await apiResponse.json();
  } catch (_error) {
    throw new ConsumerError(502, 'planner_reconciliation_response_invalid', 'The background planner returned invalid JSON.');
  }
  if (response?.status !== 'completed') {
    throw new ConsumerError(502, 'planner_reconciliation_response_incomplete', 'The background planner response was incomplete.');
  }
  let raw;
  try {
    raw = JSON.parse(responseOutputText(response));
  } catch (_error) {
    throw new ConsumerError(502, 'planner_reconciliation_output_invalid', 'The background planner returned invalid structured output.');
  }
  const { plan, droppedOperations } = normalizeModelReconciliationPlan(raw);
  const usage = response?.usage || {};
  return {
    plan,
    raw,
    droppedOperations,
    metadata: {
      model,
      providerRequestId,
      providerResponseId: SAFE_PROVIDER_ID.test(String(response?.id || ''))
        ? response.id
        : clientRequestId,
      inputTokens: Number(usage.input_tokens || 0),
      outputTokens: Number(usage.output_tokens || 0),
      cachedInputTokens: Number(usage.input_tokens_details?.cached_tokens || 0),
      latencyMs: Date.now() - startedAt
    }
  };
}

async function recordReconciliationUsage(env, config, sessionId, leaseId, metadata) {
  if (!metadata?.providerResponseId) return;
  await recordRealtimeUsage(env, {
    sessionId,
    leaseId,
    providerResponseId: metadata.providerResponseId,
    usageKind: 'planner',
    tokens: {
      inputTextTokens: Math.max(0, metadata.inputTokens - metadata.cachedInputTokens),
      inputAudioTokens: 0,
      cachedTextTokens: metadata.cachedInputTokens,
      cachedAudioTokens: 0,
      outputTextTokens: metadata.outputTokens,
      outputAudioTokens: 0
    },
    rates: config.realtimeUsageRates,
    pricingVersion: config.realtimePricingVersion
  });
}

/**
 * Run one persisted reconciliation. Shadow mode validates and records the exact
 * would-be ledger/profile but never mutates them. Apply mode remains fail-
 * closed until the shadow promotion gate is explicitly completed.
 */
export async function runPlannerReconciliation({
  env,
  config,
  context,
  leaseId,
  throughTurnId,
  trigger = 'material_turn',
  retryAttempt = 0
}) {
  if (config.plannerReconciliationMode === 'legacy') return { status: 'legacy' };
  let notes = await listPlanningNotes(env, context.sessionRow.id, leaseId, { limit: 500 });
  notes = await ensureLegacyPlanningNotes(env, {
    sessionId: context.sessionRow.id,
    leaseId,
    profileRevision: context.profile.revision,
    notes: legacyPlanningNotesFromProfile(context.profile)
  });
  const referencedTurnIds = notes.flatMap((note) => (
    Array.isArray(note.evidenceRefs) ? note.evidenceRefs.map((ref) => ref.turnId) : []
  ));
  const [turns, voiceWriteOutcomes] = await Promise.all([
    listReconciliationTranscriptWindow(
      env,
      context.sessionRow.id,
      leaseId,
      throughTurnId,
      { maxClientTurns: 8, referencedTurnIds }
    ),
    listRealtimeWriteOutcomes(env, context.sessionRow.id, leaseId, throughTurnId, 24)
  ]);
  const input = buildPlannerReconciliationContext({
    context,
    turns,
    notes,
    throughTurnId,
    voiceWriteOutcomes
  });
  const retryIdentity = Math.max(0, Math.min(1, Number(retryAttempt) || 0));
  const started = await startPlannerReconciliation(env, {
    sessionId: context.sessionRow.id,
    leaseId,
    baseProfileRevision: context.profile.revision,
    throughTurnId,
    trigger,
    mode: config.plannerReconciliationMode,
    idempotencyKey: `${leaseId}:${throughTurnId}:${context.profile.revision}:${config.plannerReconciliationPromptVersion}:retry-${retryIdentity}`,
    promptVersion: config.plannerReconciliationPromptVersion,
    input
  });
  if (started.replayed) {
    if (started.row.status === 'pending') {
      return {
        status: 'pending',
        replayed: true,
        reconciliationId: started.row.id,
        reconciliationRevision: Number(started.row.reconciliation_revision),
        createdAt: started.row.created_at
      };
    }
    const saved = await loadPlannerReconciliation(env, context.sessionRow.id, leaseId, started.row.id);
    return { status: started.row.status, replayed: true, output: saved.output };
  }
  const attempt = started.row;
  let requested;
  try {
    requested = await requestPlannerReconciliation({ env, config, input });
    await recordReconciliationUsage(
      env,
      config,
      context.sessionRow.id,
      leaseId,
      requested.metadata
    ).catch(() => {});
    const validation = await applyReconciliationPlan({
      profile: context.profile,
      notes,
      plan: requested.plan,
      transcriptTurns: input.transcriptTurns,
      sessionId: context.sessionRow.id,
      transcriptWatermark: throughTurnId,
      baseProfileRevision: context.profile.revision,
      owners: input.owners,
      entities: input.entities,
      mapFactValue: mapReconciledFactValue
    });
    const applyRequested = config.plannerReconciliationMode === 'apply';
    const validationSucceeded = ['applied', 'no_change', 'needs_profile_projection', 'duplicate']
      .includes(validation.status);
    // Apply writes whenever the validator produced a changed profile or ledger.
    // `no_change` has nothing to persist.
    //
    // `needs_profile_projection` used to block the write. It means SOME accepted
    // operation has no canonical home -- a spending figure quoted without a
    // currency, a fact whose only mapping is a collection root -- and holding
    // the whole batch for it discards every operation that projected perfectly
    // well. Measured: one such operation cost nine accepted writes on one turn
    // and seven on another, the same blast radius the grouping and per-group
    // invariant work removed at the group level, arriving one layer down.
    //
    // The profile returned here is normalized and valid; it simply contains
    // less than the ledger does. That gap is real either way, and refusing to
    // write does not close it -- it just loses the rest of the batch too. The
    // unprojected operations stay in the ledger, reported in
    // `unprojectedFactOperationIds` and `unprojectableNotes`, which is what
    // makes them a repair target for the next pass.
    const writesProfile = applyRequested
      && ['applied', 'needs_profile_projection'].includes(validation.status)
      && (validation.profileChanged || validation.ledgerChanged);
    const status = !validationSucceeded
      ? (validation.status === 'conflicted' ? 'conflicted' : 'failed')
      : writesProfile ? 'applied' : 'shadow';
    const output = {
      schemaVersion: 1,
      plan: requested.plan,
      validation,
      applyRequested,
      applied: writesProfile,
      // Operations the server could not parse. Recorded so an unusable
      // operation is visible as itself rather than inferred from a plan that
      // is quietly shorter than the one the model returned.
      ...(requested.droppedOperations?.length
        ? { droppedOperations: requested.droppedOperations }
        : {})
    };
    const completed = await completePlannerReconciliation(env, {
      sessionId: context.sessionRow.id,
      leaseId,
      reconciliationId: attempt.id,
      reconciliationRevision: Number(attempt.reconciliation_revision),
      throughTurnId,
      status,
      output,
      model: requested.metadata.model,
      inputTokens: requested.metadata.inputTokens,
      outputTokens: requested.metadata.outputTokens,
      cachedInputTokens: requested.metadata.cachedInputTokens,
      latencyMs: requested.metadata.latencyMs,
      operationCount: requested.plan.operationGroups.flatMap((group) => group.operations).length,
      acceptedOperationCount: validation.acceptedOperationIds.length,
      rejectedOperationCount: validation.operationOutcomes
        .filter((outcome) => outcome.status !== 'accepted').length,
      // Only the operations the validator accepted reach the canonical state,
      // and they reach it exactly as it validated them.
      ...(writesProfile ? { appliedProfile: validation.profile, appliedNotes: validation.notes } : {}),
      errorCode: validationSucceeded ? null : `planner_reconciliation_${validation.status}`
    });
    if (completed.status === 'conflicted') {
      return {
        status: 'conflicted',
        plan: requested.plan,
        validation,
        metadata: requested.metadata,
        errorCode: completed.errorCode || 'planner_reconciliation_stale'
      };
    }
    return {
      status: completed.status,
      plan: requested.plan,
      validation,
      metadata: requested.metadata,
      appliedProfileRevision: completed.appliedProfileRevision ?? null,
      insertedNoteCount: completed.insertedNoteCount ?? 0,
      transitionedNoteCount: completed.transitionedNoteCount ?? 0
    };
  } catch (error) {
    const completed = await completePlannerReconciliation(env, {
      sessionId: context.sessionRow.id,
      leaseId,
      reconciliationId: attempt.id,
      reconciliationRevision: Number(attempt.reconciliation_revision),
      throughTurnId,
      status: 'failed',
      output: { schemaVersion: 1, errorCode: error?.code || 'planner_reconciliation_failed' },
      model: requested?.metadata?.model || config.realtimePlannerModel,
      inputTokens: requested?.metadata?.inputTokens || 0,
      outputTokens: requested?.metadata?.outputTokens || 0,
      cachedInputTokens: requested?.metadata?.cachedInputTokens || 0,
      latencyMs: requested?.metadata?.latencyMs || 0,
      operationCount: 0,
      acceptedOperationCount: 0,
      rejectedOperationCount: 0,
      errorCode: error instanceof ConsumerError ? error.code : 'planner_reconciliation_failed'
    }).catch(() => null);
    if (completed?.status === 'conflicted') {
      return {
        status: 'conflicted',
        errorCode: completed.errorCode || 'planner_reconciliation_stale'
      };
    }
    throw error;
  }
}
