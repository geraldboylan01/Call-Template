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
  NEED_ANSWER_POLICIES,
  NEED_IMPORTANCES,
  NEED_STATUSES,
  PLANNING_NOTE_KINDS,
  POSITION_PROJECTIONS,
  RECONCILIATION_OPERATIONS,
  RECONCILIATION_REASON_CODES,
  applyReconciliationPlan,
  canonicalFactContract,
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
import { CURRENCY_CODES } from '../../../js/planning/contracts.js';
import { COLLECTION_TYPE_CHOICES } from '../../../js/planning/profile.js';
import { classifyGoalPriorityHint } from '../../../js/planning/goal_catalogue.js';
import {
  boundedUncoveredValueEvidence,
  valueEvidenceCoverage
} from '../../../js/planning/value_evidence.js';
import { ConsumerError } from './errors.js';
import { stableStringify } from './crypto.js';
import { toConsumerRealtimePlanningLists } from './planning_context.js';
import { readClientTurnFigures } from './turn_reading.js';
import {
  buildConfirmedRealtimeFactSummary,
  mapRealtimeFact,
  realtimeChoiceVocabulary,
  realtimeFactValueVocabulary
} from './realtime_fact_mapper.js';
import { plannerContextSlice } from './realtime_planner.js';
import {
  appendRealtimeEvent,
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
    valueEvidenceDispositions: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          evidenceId: { type: 'string', maxLength: 360 },
          disposition: {
            type: 'string',
            enum: ['operation_proposed', 'clarification_proposed', 'not_current_fact']
          },
          operationIds: {
            type: 'array',
            maxItems: 6,
            items: { type: 'string', maxLength: 160 }
          }
        },
        required: ['evidenceId', 'disposition', 'operationIds'],
        additionalProperties: false
      }
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
  required: [
    'schemaVersion', 'verdict', 'reviewedNoteIds',
    'valueEvidenceDispositions', 'operationGroups'
  ],
  additionalProperties: false
});

/** Exported so a test can assert the prompt binds to the contracts it is sent. */
export const RECONCILIATION_SYSTEM_PROMPT = `You are Planéir's background planning-note reconciler.

The realtime voice model has already written provisional notes. Compare those notes with the finalized transcript and the current deterministic needs. Return only the closed ReconciliationPlanV1 operations in the schema.

Evidence rules:
- Only finalized CLIENT transcript turns are evidence. Assistant text, current notes, requirements and profile state are context, never evidence.
- Every operation must quote an exact, contiguous client span from the cited turn.
- Every proposed number must appear in its cited quote. Do not calculate totals, dates, percentages, midpoints or conversions.
- CITE THE NARROWEST SPAN THAT STILL IDENTIFIES THE NUMBER: the shortest stored client span holding the exact figure AND the words saying what it refers to, excluding unrelated numbers. A quote carrying other figures cannot bind yours to its entity and is refused as ambiguous. From "I'm on 95,000 a year. I put in 6 percent and the company puts in 8 percent." cite "I'm on 95,000 a year". Narrow by trimming, never by rewriting, and never past the describing words — a bare figure has nothing left to bind it.
- Use only supplied note, entity, owner and fact identities. Never invent an identity or JSON path.
- An entity is valid for a fact only when the entity's factIds list that fact.
- WHOSE FACT IS THIS? Deciding that is your job, and nothing downstream will do it for you. Read the client's turn, the assistant question it answers, and the recent conversation, then choose the owner and entity from the supplied catalogues. The client speaking about themselves — "mine", "I have", "my pension" — means the primary person, whose catalogue label may simply read "you". Speech about their partner — "hers", "his", "my wife's", or the partner's name — means the partner entity. A scale or subject stated once carries across the sentence: "mine is a hundred and eighty grand and hers is ninety" is TWO pensions, 180000 for the primary and 90000 for the partner, and each operation must name its own owner and entity.
- Use ONLY owner and entity identifiers that appear in the supplied owners and entities lists, exactly as written. Never invent, guess, abbreviate or construct an identifier, and never reuse one belonging to a different person or holding. A new holding takes the newEntitySlot provided for that collection.
- Where ownership is genuinely unclear — the client said "the pension" and the household holds two, or "ours" for a fact that has one per-person slot — return request_clarification naming the ambiguity instead of choosing. Guessing an owner writes someone else's money into this person's plan, and a clarification costs one question.
- A fact in singletonFactIds has ONE household-wide slot. Give it entity householdScopeEntityId or no entity at all. Never attach it to the partner or to a position: there is no per-person slot, and naming one would overwrite the client's own value with somebody else's.
- Where factContracts gives a fact choices, the value must be exactly one of those terms. Do not describe the answer in your own words or add extra keys. If no term fits the evidence, request_clarification.
- Use exactly the noteKind valueContracts gives each fact.
- WRITE ONLY WHERE THERE IS SOMEWHERE TO WRITE. A factId is usable on this turn only when some supplied entity lists it in its factIds. Check that before choosing, because a fact with no entity that accepts it reaches nothing, however well evidenced it is.
- A figure describing a holding belongs IN that holding's record, not in a scalar fact beside it. Pension worth, income amount, property value and loan balance are fields of the position named in positionContracts — write the position record on that collection's entity or its newEntitySlot. Do not reach for a separate scalar factId to carry a holding's value.
- To change an existing holding use correct_note with its targetNoteId; an upsert_note on an entity that already holds an active position updates it. Either way your record REPLACES the old one, so restate every field you still want, including the money.
- A position value IS the canonical record, shaped by that fact's entry in positionContracts: its requiredKeys, its idKey set to the operation's entityId, its owner under its ownerKey. Any other detail goes in one of that entry's valueFields, using that exact name — a figure under a name not listed there is written nowhere. There is no entityId field inside a canonical record.
- valueContracts gives the canonical shape of every fact you may write. A fact absent from it has no canonical home: keep it as an evidenced note, never invent a slot for it.
- Money is {"amount": <number from the quote>, "currency": <a listed code>} — both keys, every time, including money nested inside a position record (grossAnnual, netAnnual, currentValue, monthlyPayment). Money without its currency reaches nothing. A SPOKEN FIGURE CARRIES NO CURRENCY WORD, and that is ordinary speech rather than a gap: this jurisdiction is Ireland, so use EUR whenever the client did not name a currency, exactly as the server does. A missing currency word is never a reason to request_clarification; ask only when the client named a currency you cannot reconcile with the amount.
- The SERVER decides gross versus net from the client's words, not you. Never ask which an ordinary salary is — record it. If you cannot tell which annual key to use, send the figure as "amount" in the income record and the server places it.
- An entity marked newEntitySlot is a server-issued identity for one omitted position. Use one only when exact client evidence establishes that position.
- A partner or joint owner is valid only when that owner exists in the supplied household.
- Preserve uncertainty, ranges, explicit none and which person/position they concern.
- uncoveredValueEvidence is a deterministic, occurrence-addressed inventory of explicit values the fast lane did not account for. Review EVERY listed item exactly once and return one valueEvidenceDispositions entry with its exact evidenceId. It is a review obligation, not a guessed category: use its exact context to decide whether it is a current fact, holding, income component, debt, rate, aggregate, scenario, future value, correction or something safely left as evidenced context. Never create a write merely because an item is listed.
- Use operation_proposed only when operationIds names the write(s) that recover that exact occurrence. Use clarification_proposed only when operationIds names request_clarification operation(s) needed to place it safely. Use not_current_fact, with no operation ids, only when the occurrence is genuinely an aggregate, scenario, superseded value, identifier, historical/future context or otherwise not a current canonical fact. The server checks exact one-to-one coverage, operation acceptance and that each operation's quote encloses the named source occurrence; an omitted, duplicated, unrelated or rejected disposition fails the whole review.

Reconciliation rules:
- Put an omitted evidenced fact in upsert_note.
- Correct a wrong value or owner with correct_note and cite the corrective wording.
- Reclassify totals as summary, expected amounts as future_event, and unresolved alternatives as scenario_option.
- A stated total is not another holding. A future inheritance is not a current asset. A candidate retirement age is not a settled target.
- CLASSIFY EVERY AMOUNT AS ONE OR THE OTHER. An individual holding ("the Zurich one is 415,000") is noteKind position. A total or combined value ("about a million across the pensions", "altogether", "between them") is reasonCode aggregate_summary AND noteKind summary — both, or it is refused. Record the total; never also as a holding, and never split into one holding per policy.
- Where a total was already written as a holding, repair it with reclassify_note to summary from that same note. That keeps the client's words and their evidence while taking the figure out of the holdings the analysis adds up.
- Retract or merge only when the transcript explicitly proves the note/entity is wrong or duplicated.
- Use set_completion for an exact owner/position unknown or none answer.
- If the transcript does not resolve an ambiguity safely, request_clarification with a NeedV2 shaped by clarificationContract. Its entityId/ownerId/entityLabel are optional and may name ONLY an identity already in this context — asking about someone who does not exist yet is normal, so omit them rather than inventing one.
- selectedAnalyses[].inputs is what each analysis needs. Prioritise inputs marked missing whose evidence the client has already given; an input marked satisfied needs no further operation. Information no analysis consumes is still worth keeping as an evidence-backed note, and is not a failure.

Grouping rules:
- A group is a unit that lands together or not at all. One failing operation discards every other operation in its group, so grouping unrelated corrections together throws away correct work.
- Put each independent correction in its OWN group. Several corrections from one turn are normally several groups, not one.
- Group operations together only when they describe the same note, entity or fact instance, or when applying one without the other would misstate the position.
- Set atomic true only for that second case — operations that must land together but share no identity. Otherwise set atomic false.
- When exact evidence says a liability is secured on or belongs to a stated property, preserve the edge in the property_position value as associatedLiabilityIds containing the supplied liability entity id. If either endpoint uses a newEntitySlot, create/correct both endpoints in the SAME atomic group; the server rejects a dangling, cross-owner or evidence-free relationship. Do not infer a link from proximity alone.
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

function valueEvidenceFailure(message) {
  throw new ConsumerError(
    502,
    'planner_reconciliation_value_evidence_incomplete',
    message
  );
}

function operationEnclosesEvidence(operation, item, input) {
  const turn = (input?.transcriptTurns || []).find((candidate) => candidate.turnId === item.turnId);
  if (!turn || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)) return false;
  return (operation?.evidence || []).some((ref) => {
    if (ref.turnId !== item.turnId || typeof ref.quote !== 'string' || !ref.quote) return false;
    const quoteStart = turn.text.indexOf(ref.quote);
    if (quoteStart < 0 || turn.text.indexOf(ref.quote, quoteStart + 1) >= 0) return false;
    return quoteStart <= item.start && quoteStart + ref.quote.length >= item.end;
  });
}

/**
 * The paid T2 pass may classify an uncovered value, but it cannot silently
 * omit one. This binds every model disposition to the deterministic occurrence
 * inventory and, for writes/clarifications, to an operation whose exact quote
 * encloses that occurrence. Passing acceptedOperationIds additionally proves
 * those operations survived the ordinary strict reconciliation validator.
 */
export function validateValueEvidenceDispositions({
  raw,
  plan,
  input,
  acceptedOperationIds = null
}) {
  const expected = Array.isArray(input?.uncoveredValueEvidence)
    ? input.uncoveredValueEvidence
    : [];
  const supplied = Array.isArray(raw?.valueEvidenceDispositions)
    ? raw.valueEvidenceDispositions
    : [];
  const expectedIds = new Set(expected.map((item) => item.evidenceId));
  const suppliedIds = supplied.map((item) => String(item?.evidenceId || ''));
  if (suppliedIds.some((id) => !id)
    || new Set(suppliedIds).size !== suppliedIds.length
    || suppliedIds.length !== expectedIds.size
    || suppliedIds.some((id) => !expectedIds.has(id))) {
    valueEvidenceFailure('The background planner did not disposition every uncovered value exactly once.');
  }
  const operations = new Map((plan?.operationGroups || [])
    .flatMap((group) => group.operations || [])
    .map((operation) => [operation.operationId, operation]));
  const accepted = acceptedOperationIds ? new Set(acceptedOperationIds) : null;
  const rejectedOperationIds = [];
  const resolvedEvidenceIds = [];
  const unresolved = new Set();
  for (const disposition of supplied) {
    const item = expected.find((candidate) => candidate.evidenceId === disposition.evidenceId);
    const operationIds = Array.isArray(disposition.operationIds) ? disposition.operationIds : [];
    if (new Set(operationIds).size !== operationIds.length) {
      valueEvidenceFailure(`Value evidence ${disposition.evidenceId} repeats an operation identity.`);
    }
    if (disposition.disposition === 'not_current_fact') {
      if (operationIds.length !== 0) {
        valueEvidenceFailure(`Non-current evidence ${disposition.evidenceId} cannot name a write.`);
      }
      // A reasoned "this is not a canonical fact" IS a resolution. The
      // occurrence has been reviewed and answered; it is not outstanding work.
      resolvedEvidenceIds.push(disposition.evidenceId);
      continue;
    }
    if (operationIds.length === 0) {
      valueEvidenceFailure(`Value evidence ${disposition.evidenceId} has no recovery operation.`);
    }
    for (const operationId of operationIds) {
      const operation = operations.get(operationId);
      if (!operation || !operationEnclosesEvidence(operation, item, input)) {
        valueEvidenceFailure(`Operation ${operationId} is not grounded in value evidence ${disposition.evidenceId}.`);
      }
      const clarification = operation.op === 'request_clarification';
      if ((disposition.disposition === 'clarification_proposed') !== clarification) {
        valueEvidenceFailure(`Operation ${operationId} does not match its value-evidence disposition.`);
      }
      if (accepted && !accepted.has(operationId)) {
        rejectedOperationIds.push(operationId);
        unresolved.add(disposition.evidenceId);
      }
    }
    if (!unresolved.has(disposition.evidenceId)) resolvedEvidenceIds.push(disposition.evidenceId);
  }
  const byDisposition = (kind) => supplied.filter((item) => (
    item.disposition === kind && !unresolved.has(item.evidenceId)
  )).length;
  return {
    dispositions: supplied,
    complete: rejectedOperationIds.length === 0,
    rejectedOperationIds: [...new Set(rejectedOperationIds)],
    // The occurrence funnel for this pass, classified by how each reviewed
    // value ended. Counts only; the occurrences themselves stay in the
    // encrypted output.
    counts: Object.freeze({
      uncovered: expectedIds.size,
      recovered: byDisposition('operation_proposed'),
      clarified: byDisposition('clarification_proposed'),
      notCurrentFact: byDisposition('not_current_fact'),
      unresolved: unresolved.size
    }),
    // Per-occurrence outcome, so a meeting can bound how many times it re-asks
    // about a value nothing has been able to place. `complete` alone could
    // only ever say "something failed", never which occurrence.
    reviewedEvidenceIds: [...expectedIds],
    resolvedEvidenceIds: [...new Set(resolvedEvidenceIds)],
    unresolvedEvidenceIds: [...unresolved]
  };
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
export function mapReconciledFactValue(profile, note) {
  const evidenceText = (note.evidenceRefs || []).map((ref) => ref.quote).filter(Boolean).join(' ');
  let value = isPlainObject(note.value) && note.ownerId
    && !OWNER_HINT_KEYS.some((key) => Object.hasOwn(note.value, key))
    ? { ...note.value, ownerId: note.ownerId }
    : note.value;
  if (note.factId === 'primary_goal') {
    const goalType = typeof value === 'string' ? value : value?.type;
    value = {
      ...(isPlainObject(value) ? value : {}),
      type: goalType,
      priorityHint: classifyGoalPriorityHint(goalType, evidenceText)
    };
  }
  try {
    return mapRealtimeFact(profile, {
      factId: note.factId,
      value,
      ...(note.entityId ? { entityId: note.entityId } : {}),
      ...(note.ownerId ? { ownerId: note.ownerId } : {}),
      // The client's own words for this note, so shared canonicalisation rules
      // that read the wording — gross versus take-home income — reach the same
      // conclusion here as they do on the live lane. The quotes are server-
      // stored spans of finalized client turns, so this cannot smuggle in
      // assistant text or anything the client did not say.
      evidenceText
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
 * Which of the facts in play hold a position, and the record shape each takes.
 *
 * WHY THIS IS DATA AND NOT A SENTENCE. The prompt already had a sentence about
 * it, and the sentence was wrong: it told the model to copy an identity into
 * "the canonical record's entity ID field", which does not exist. A real planner
 * model wrote `value.entityId` on every entity it proposed and the projector
 * refused all of them. The same model also marked the SCALAR
 * `pension_current_value` as a position, because nothing told it which facts are
 * collections — and a position note for a non-position fact falls between both
 * projectors, so it is accepted and silently does nothing.
 *
 * Both answers already existed in `POSITION_PROJECTIONS`, the constant the
 * validator enforces. This hands the model that same constant rather than a
 * paraphrase of it, for the same reason `factValueContracts` exists: the last
 * time this prompt described a shape instead of naming it, the model invented
 * its own keys for a closed slot.
 */
function positionContracts(factIds) {
  const contracts = [];
  for (const factId of [...new Set(factIds.filter(Boolean))].sort()) {
    const projection = POSITION_PROJECTIONS[factId];
    if (!projection) continue;
    contracts.push({
      factId,
      idKey: projection.idKey,
      ownerKey: projection.ownerKey,
      // Told a record needs a `type` but not which values are legal, a planner
      // guesses — and a pension typed "pension" is thrown out by profile
      // normalization after everything else about it was right. The vocabulary
      // comes from the same constants that enforce it.
      typeChoices: COLLECTION_TYPE_CHOICES[projection.collection] || null
    });
  }
  return contracts;
}

/**
 * THE FULL PLANNER-FACING CONTRACT, DERIVED — never written out by hand.
 *
 * Exported so the offline conformance audit can check the shapes this promises
 * against the shapes the projector actually accepts, for every fact in play. The
 * whole point is that there is ONE derivation: three paid probes were spent
 * discovering, one layer at a time, that the prompt's prose disagreed with the
 * projector about the record's id field, about which facts are positions, and
 * then about whether a money value needs its currency. Prose cannot be tested.
 * This can.
 */
export function plannerFactContracts(factIds) {
  const contracts = [];
  const vocabulary = realtimeChoiceVocabulary();
  for (const factId of [...new Set(factIds.filter(Boolean))].sort()) {
    const definition = getSemanticFactDefinition(factId);
    const contract = canonicalFactContract(factId, definition);
    // A fact with no canonical home is kept as evidence and must not be
    // advertised as somewhere the planner can write.
    if (!contract || contract.target === 'none') continue;
    const choices = vocabulary[factId] || realtimeFactValueVocabulary(factId);
    const entry = {
      factId,
      target: contract.target,
      noteKind: contract.noteKind,
      valueType: contract.valueType,
      // A scalar that lives inside a position has no home until that position
      // exists, and must name it.
      ...(contract.entityCollection ? { inCollection: contract.entityCollection } : {})
    };
    if (contract.target === 'position') {
      entry.idKey = contract.idKey;
      entry.ownerKey = contract.ownerKey;
      entry.requiredKeys = contract.requiredKeys;
      entry.valueFields = contract.valueFields;
      if (factId === 'property_position') {
        entry.relationshipFields = [{
          field: 'associatedLiabilityIds',
          value: 'array of known liability entity ids',
          requires: 'explicit property-liability wording; atomic endpoint group when either endpoint is new'
        }];
      }
    }
    if (choices) entry.choices = choices;
    // MONEY IS THE ONE VALUE TYPE THE SCHEMA CANNOT PIN DOWN. `valueJson` is a
    // free string, so nothing stops `{"amount": 95000}` — which normalizes
    // nowhere, because currency is required. A real planner omitted it twice in
    // one run, inside a position record and again on a scalar.
    if (contract.valueType === 'money') entry.money = MONEY_SHAPE;
    contracts.push(entry);
  }
  return contracts;
}

/** The only money shape any canonical slot accepts, nested or not. */
const MONEY_SHAPE = Object.freeze({ amount: 'number', currency: CURRENCY_CODES });

/**
 * THE SHAPE OF A QUESTION THE PLANNER WANTS TO ASK.
 *
 * `request_clarification` carries a NeedV2, and the model was never shown what
 * one looks like. On a paid probe it wanted to ask whether a partner should be
 * included, invented `entityId: "partner"` for a person the household does not
 * yet contain, and `normalizeNeedV2` refused it — twice, in the same run. So the
 * planner's fail-closed path could not actually fail closed: the one operation
 * whose whole purpose is "I cannot resolve this safely, please ask" was itself
 * unusable.
 *
 * The refusal is right and stays. What was missing is that the identity fields
 * are OPTIONAL, and that when supplied they must name something the catalogue
 * already contains — which is exactly the thing a model asking about a
 * not-yet-existing person cannot do, and does not need to.
 */
const CLARIFICATION_CONTRACT = Object.freeze({
  op: 'request_clarification',
  valueIs: 'NeedV2',
  required: Object.freeze([
    'schemaVersion', 'needId', 'factId', 'factInstanceId',
    'reasonCode', 'prompt', 'importance', 'blockingModuleIds', 'answerPolicy', 'status'
  ]),
  schemaVersion: 2,
  importance: NEED_IMPORTANCES,
  answerPolicy: NEED_ANSWER_POLICIES,
  status: NEED_STATUSES,
  // Optional, and only ever an identity the catalogue already lists. Asking
  // about something that does not exist yet is the normal case: omit them.
  optionalIdentity: Object.freeze(['entityId', 'ownerId', 'entityLabel'])
});

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
  reviewTurnIds = null,
  // Occurrences this meeting has already reviewed to its bounded limit without
  // being able to place them safely. They are NOT covered and are never
  // recorded as captured; they are finished being asked about. Presenting them
  // again would spend a paid review on a question already answered "no", and
  // would hold the confirmation barrier shut for the rest of the call.
  terminallyUnresolvedEvidenceIds = [],
  voiceWriteOutcomes = []
}) {
  const recent = turns.map((turn, sequence) => ({
    turnId: turn.id,
    role: turn.role,
    finalized: turn.finalized !== false,
    text: String(turn.transcript || '').slice(0, 4_000),
    sequence: Number.isSafeInteger(turn.sequence) ? turn.sequence : sequence,
    // The proposition this turn answered, as the live session recorded it.
    // Null where it was never captured; adjacency is not a substitute.
    answersTurnId: turn.answersTurnId || null
  }));
  const planning = toConsumerRealtimePlanningLists(context.state, context.profile);
  const requestedReviewTurnIds = [...new Set(
    (Array.isArray(reviewTurnIds) && reviewTurnIds.length > 0 ? reviewTurnIds : [throughTurnId])
      .map((turnId) => String(turnId || ''))
      .filter(Boolean)
  )];
  const requestedReviewSet = new Set(requestedReviewTurnIds);
  const reviewTurns = recent.filter((turn) => (
    turn.role === 'user' && requestedReviewSet.has(turn.turnId)
  ));
  const uncovered = [];
  // How many explicit values the fast lane DID account for on the reviewed
  // turns. Without it the funnel has a numerator and no denominator: "three
  // values were missed" means something very different in a turn of four than
  // in a turn of thirty.
  let coveredValueEvidenceCount = 0;
  for (const turn of reviewTurns) {
    const outcomes = voiceWriteOutcomes.filter((outcome) => (
      String(outcome?.sourceTurnId || throughTurnId) === turn.turnId
    ));
    // Only server-issued occurrence provenance can retire an occurrence. A
    // legacy bare value such as {amount: 25000} cannot distinguish which of two
    // equal-valued holdings was actually saved, so treating it as coverage
    // would recreate the exact omission this audit exists to catch. Older
    // attempts without provenance are safely re-reviewed against canonical
    // state and the strict reconciliation validators.
    const acceptedFastValues = outcomes.flatMap((outcome) => (
      Array.isArray(outcome?.result?.sourcedValueEvidence)
        ? outcome.result.sourcedValueEvidence
        : []
    ));
    const coverage = valueEvidenceCoverage(turn.text, acceptedFastValues);
    coveredValueEvidenceCount += coverage.covered.length;
    uncovered.push(...coverage.uncovered.map((item) => ({
      ...item,
      evidenceId: `${turn.turnId}:${item.evidenceId}`,
      turnId: turn.turnId
    })));
  }
  const terminal = new Set((Array.isArray(terminallyUnresolvedEvidenceIds)
    ? terminallyUnresolvedEvidenceIds
    : []).map((id) => String(id || '')).filter(Boolean));
  const reviewable = uncovered.filter((item) => !terminal.has(item.evidenceId));
  const terminallyUnresolved = uncovered.filter((item) => terminal.has(item.evidenceId));
  const boundedRaw = boundedUncoveredValueEvidence({ uncovered: reviewable }, { limit: 12 });
  const uncoveredById = new Map(uncovered.map((item) => [item.evidenceId, item]));
  const boundedCoverage = {
    ...boundedRaw,
    items: boundedRaw.items.map((item) => {
      const source = uncoveredById.get(item.evidenceId);
      return {
        ...item,
        turnId: source?.turnId || null,
        start: source?.start ?? null,
        end: source?.end ?? null
      };
    })
  };
  const missingReviewTurnIds = requestedReviewTurnIds.filter((turnId) => (
    !reviewTurns.some((turn) => turn.turnId === turnId)
  ));
  const hasValueCoverageGap = boundedCoverage.items.length > 0;
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
  /** Every fact this pass could touch: what is known, what is missing, what is noted. */
  const inPlayFactIds = [
    ...canonicalFacts.map((fact) => fact.factId),
    ...needs.map((need) => need.factId),
    ...notes.map((note) => note.factId),
    ...selectedAnalyses.flatMap((analysis) => analysis.inputs.map((input) => input.factId)),
    ...(hasValueCoverageGap
      ? listSemanticFactDefinitions()
        .filter((definition) => ['money', 'number'].includes(definition.valueType)
          || (Object.hasOwn(POSITION_PROJECTIONS, definition.factId)
            && POSITION_PROJECTIONS[definition.factId].ownerKey))
        .map((definition) => definition.factId)
      : [])
  ];
  const catalogue = buildReconciliationIdentityCatalogue(context.profile, notes, {
    // Four blank slots per collection for eight collections was 32 of the 40
    // catalogue entries, nearly all of them never used. Ordinary reviews keep
    // two and only the analysis-relevant collections. A deterministic value
    // gap temporarily exposes up to four per collection (bounded by the gap
    // count), so three omitted peer holdings can be recovered without restoring
    // an unbounded identity catalogue.
    slotsPerCollection: hasValueCoverageGap
      ? Math.min(4, Math.max(2, boundedCoverage.items.length))
      : 2,
    slotFactIds: hasValueCoverageGap
      ? POSITION_SLOT_FACT_IDS
      : positionFactIdsForModules(selectedAnalyses),
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
    factContracts: factValueContracts(inPlayFactIds),
    positionContracts: positionContracts(inPlayFactIds),
    // The derived contract, from the constants the projector itself enforces.
    // `factContracts` and `positionContracts` remain because the prompt already
    // names them; this carries what neither of them could say — the value shape.
    valueContracts: plannerFactContracts(inPlayFactIds),
    clarificationContract: CLARIFICATION_CONTRACT,
    canonicalFacts,
    needs,
    selectedAnalyses,
    currentQuestion: signedQuestionContext(context),
    voiceWriteOutcomes,
    reviewTurnIds: requestedReviewTurnIds,
    missingReviewTurnIds,
    coveredValueEvidenceCount,
    uncoveredValueEvidence: boundedCoverage.items,
    // Deferred to the next checkpoint, not lost and not silently covered. The
    // set strictly shrinks because every reviewed occurrence either resolves
    // or spends one of its bounded attempts.
    uncoveredValueEvidenceOverflowCount: boundedCoverage.overflowCount,
    // Reviewed to the bounded limit and still unplaceable. Reported so the
    // meeting can see what was never captured, and excluded from the review
    // obligation so it cannot hold the confirmation barrier shut.
    terminallyUnresolvedValueEvidence: terminallyUnresolved.slice(0, 12).map((item) => ({
      evidenceId: item.evidenceId,
      turnId: item.turnId,
      valueText: item.raw,
      normalizedValue: item.value,
      currency: item.currency
    }))
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
          { role: 'system', content: RECONCILIATION_SYSTEM_PROMPT },
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
  validateValueEvidenceDispositions({ raw, plan, input });
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
 * Run one persisted reconciliation attempt. Shadow mode validates and records
 * the exact would-be ledger/profile but never mutates them. Apply mode remains
 * fail-closed until the shadow promotion gate is explicitly completed.
 *
 * `preparedPlan` is a plan this session ALREADY obtained from the model. Passing
 * it re-runs the deterministic half against fresh state without spending a
 * second model call — see runPlannerReconciliation for why that matters.
 */
async function runPlannerReconciliationAttempt({
  env,
  config,
  context,
  leaseId,
  throughTurnId,
  reviewTurnIds = null,
  terminallyUnresolvedEvidenceIds = [],
  trigger = 'material_turn',
  retryAttempt = 0,
  rebaseAttempt = 0,
  preparedPlan = null
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
  const auditedTurnIds = [...new Set(
    (Array.isArray(reviewTurnIds) && reviewTurnIds.length > 0 ? reviewTurnIds : [throughTurnId])
      .map((turnId) => String(turnId || ''))
      .filter(Boolean)
  )];
  const turns = await listReconciliationTranscriptWindow(
    env,
    context.sessionRow.id,
    leaseId,
    throughTurnId,
    { maxClientTurns: 8, referencedTurnIds: [...referencedTurnIds, ...auditedTurnIds] }
  );
  const outcomeGroups = await Promise.all(auditedTurnIds.map(async (sourceTurnId) => {
    const outcomes = await listRealtimeWriteOutcomes(
      env,
      context.sessionRow.id,
      leaseId,
      sourceTurnId,
      24
    );
    return outcomes.map((outcome) => ({ ...outcome, sourceTurnId }));
  }));
  const voiceWriteOutcomes = outcomeGroups.flat();
  const input = buildPlannerReconciliationContext({
    context,
    turns,
    notes,
    throughTurnId,
    reviewTurnIds: auditedTurnIds,
    terminallyUnresolvedEvidenceIds,
    voiceWriteOutcomes
  });
  if (input.missingReviewTurnIds.length > 0) {
    throw new ConsumerError(
      409,
      'planner_reconciliation_review_turn_missing',
      'An outstanding material turn is outside the retained reconciliation transcript.'
    );
  }
  // OVERFLOW DEGRADES, IT DOES NOT INVALIDATE.
  //
  // Failing the whole checkpoint on a thirteenth uncovered value threw away
  // the twelve this pass could have reviewed AND every unrelated correction
  // travelling with them — and because the same occurrences are recomputed
  // next time, it failed identically for the rest of the meeting. The pass now
  // reviews its bounded twelve and reports the remainder, which the next
  // checkpoint picks up.
  const presentedValueEvidenceIds = input.uncoveredValueEvidence.map((item) => item.evidenceId);
  const retryIdentity = Math.max(0, Math.min(1, Number(retryAttempt) || 0));
  // A rebase runs at a NEW base revision, so it already gets a distinct
  // identity; the suffix is only added when one is needed, which keeps every
  // first attempt's key byte-identical to the one it has always had.
  const rebaseIdentity = Math.max(0, Number(rebaseAttempt) || 0);
  const started = await startPlannerReconciliation(env, {
    sessionId: context.sessionRow.id,
    leaseId,
    baseProfileRevision: context.profile.revision,
    throughTurnId,
    trigger,
    mode: config.plannerReconciliationMode,
    idempotencyKey: `${leaseId}:${throughTurnId}:${context.profile.revision}:${config.plannerReconciliationPromptVersion}:retry-${retryIdentity}`
      + (rebaseIdentity > 0 ? `:rebase-${rebaseIdentity}` : ''),
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
    if (preparedPlan) {
      // The model already answered. Only the deterministic half re-runs, and
      // its usage was metered when that answer arrived — metering it again per
      // rebase would bill one planner call several times over.
      requested = preparedPlan;
    } else {
      requested = await requestPlannerReconciliation({ env, config, input });
      await recordReconciliationUsage(
        env,
        config,
        context.sessionRow.id,
        leaseId,
        requested.metadata
      ).catch(() => {});
    }
    // A SECOND READER THAT NEVER SAW THE FIRST ONE'S ANSWER.
    //
    // Read independently of the reconciler's plan — the reading is requested
    // from the transcript alone and cannot be influenced by what the reconciler
    // proposed. In `shadow` the readings are recorded and thrown away; only in
    // `apply` are they handed to the validator as the authority on which
    // figures a turn contains.
    const turnReadings = await readReviewedTurns({ env, config, input });
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
      turnReadings: config.turnReadingMode === 'apply' ? turnReadings : [],
      mapFactValue: mapReconciledFactValue
    });
    if (config.turnReadingMode !== 'off') {
      recordTurnReadingAgreement({
        env,
        sessionId: context.sessionRow.id,
        leaseId,
        turnReadings,
        plan: requested.plan,
        mode: config.turnReadingMode,
        input,
        validation
      });
    }
    const valueEvidenceReview = validateValueEvidenceDispositions({
      raw: requested.raw,
      plan: requested.plan,
      input,
      acceptedOperationIds: validation.acceptedOperationIds
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
      valueEvidenceReview,
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
      // The occurrence funnel, so real-user testing can measure the mechanism
      // rather than infer it. `covered` is how many explicit values the fast
      // lane accounted for on the reviewed turns; `deferred` is how many this
      // bounded pass could not fit and left for the next checkpoint.
      valueOutcomes: {
        ...valueEvidenceReview.counts,
        covered: input.coveredValueEvidenceCount,
        deferred: input.uncoveredValueEvidenceOverflowCount
      },
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
        // The plan the model produced, carried out whole so a rebase can reuse
        // it. Without this the only way back from a conflict is another call.
        requested,
        errorCode: completed.errorCode || 'planner_reconciliation_stale'
      };
    }
    return {
      status: completed.status,
      plan: requested.plan,
      validation,
      metadata: requested.metadata,
      requested,
      valueEvidenceReviewComplete: valueEvidenceReview.complete,
      rejectedValueEvidenceOperationIds: valueEvidenceReview.rejectedOperationIds,
      reviewedValueEvidenceIds: valueEvidenceReview.reviewedEvidenceIds,
      resolvedValueEvidenceIds: valueEvidenceReview.resolvedEvidenceIds,
      unresolvedValueEvidenceIds: valueEvidenceReview.unresolvedEvidenceIds,
      valueEvidenceOverflowCount: input.uncoveredValueEvidenceOverflowCount,
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
      // A FAILED PASS STILL HAD WORK IN FRONT OF IT. Leaving these at zero
      // would make a review that crashed indistinguishable from one that had
      // nothing to review, which is the "different outcomes, same status"
      // collapse this schema exists to prevent. The occurrences were shown and
      // none of them resolved, so that is exactly what is recorded.
      valueOutcomes: {
        covered: input.coveredValueEvidenceCount,
        uncovered: presentedValueEvidenceIds.length,
        unresolved: presentedValueEvidenceIds.length,
        deferred: input.uncoveredValueEvidenceOverflowCount
      },
      errorCode: error instanceof ConsumerError ? error.code : 'planner_reconciliation_failed'
    }).catch(() => null);
    if (completed?.status === 'conflicted') {
      return {
        status: 'conflicted',
        ...(requested ? { requested } : {}),
        reviewedValueEvidenceIds: presentedValueEvidenceIds,
        errorCode: completed.errorCode || 'planner_reconciliation_stale'
      };
    }
    // Which occurrences this pass had put in front of the model, so a failure
    // still spends one of their bounded review attempts. Without this a model
    // that reliably fails on one awkward value would be asked about it forever.
    error.reviewedValueEvidenceIds = presentedValueEvidenceIds;
    throw error;
  }
}

/**
 * How many times a validated plan may be re-projected onto newer canonical
 * state before the attempt is abandoned.
 *
 * A rebase is deterministic validation plus a D1 batch — tens of milliseconds
 * against the model call's fifteen to twenty seconds — so the window in which a
 * client turn can overtake it is a rounding error by comparison. Two is enough
 * for a very unlucky meeting and small enough that a genuinely contended
 * session gives up rather than spinning.
 */
const MAX_RECONCILIATION_REBASE_ATTEMPTS = 2;

/**
 * How many client turns one checkpoint reads independently.
 *
 * Every turn the pass may cite needs a reading, or a fact Realtime missed has
 * no second reader and falls back to the parser that missed it too. Bounded so
 * a long meeting does not pay for its whole transcript at every checkpoint.
 */
const MAX_TURNS_READ_PER_PASS = 6;

/**
 * REBASE THE PLANNER'S ANSWER; DO NOT THROW IT AWAY.
 *
 * The completion is a whole-profile write at `baseRevision + 1`, so it MUST
 * fail closed when the base has moved — writing that snapshot over a newer
 * revision would erase every fact the client supplied in the meantime. That
 * part is right and is unchanged.
 *
 * What was wrong was the consequence. In a live meeting the client keeps
 * talking and `save_facts` keeps landing, so one ordinary turn arriving during
 * the fifteen-to-twenty-second model call bumped `latest_profile_revision` and
 * discarded a fully validated batch — measured: an `applied` reconciliation
 * that removed a phantom EUR 658,000 pension became `conflicted` and left the
 * phantom in the profile, purely because the client answered the next question.
 * The correction was then never applied, `injectVolatileState` was never
 * reached, and the conversation went on asking for what the planner had already
 * worked out. The feedback loop could not close because nothing ever landed.
 *
 * The model's answer does not go stale when the profile moves; only its
 * PROJECTION does. So on a conflict this reloads canonical state and re-runs
 * the deterministic half — `applyReconciliationPlan` — against the newer
 * profile and the newer notes, with the SAME plan. No second model call, no
 * second token spend, and nothing anywhere near the reply path.
 *
 * This is not a weakening. Every operation is re-validated in full against the
 * state it will actually be written onto: evidence re-checked against stored
 * turns, identities re-checked against the current catalogue, correction
 * targets required to still exist. An operation that genuinely contradicts what
 * the client has since said now fails validation on the rebase — a correct
 * fail-closed rejection of that one operation, instead of collateral damage to
 * every unrelated correction beside it.
 *
 * `loadContext` is optional. Without it the behaviour is exactly what it was:
 * one attempt, and a conflict is terminal.
 */
/**
 * Read every client turn this pass is reviewing, independently of the plan.
 *
 * Returns [] when the feature is off or the provider could not be reached. An
 * absent reading is not a failure to escalate: the validator falls back to the
 * deterministic path that shipped before this existed, which is no worse than
 * the behaviour it replaces.
 */
async function readReviewedTurns({ env, config, input }) {
  if (config.turnReadingMode === 'off') return [];
  const turns = Array.isArray(input?.transcriptTurns) ? input.transcriptTurns : [];
  const byId = new Map(turns.map((turn) => [String(turn.turnId), turn]));

  // READ EVERY CLIENT TURN THIS PASS MAY CITE, not only the ones something
  // already noticed. A turn Realtime proposed nothing for, and whose figures
  // the parser cannot see, is invisible to the obligation list — and those are
  // precisely the omissions the reader exists to recover. Scoping the reader to
  // the obligations would have let the parser decide, by its own blind spots,
  // which sentences were allowed to be understood.
  const candidates = turns
    .filter((turn) => turn.role !== 'assistant' && turn.finalized !== false)
    .filter((turn) => String(turn.text || '').trim().length > 0);
  // Bounded, newest first: an unbounded window would grow the cost of every
  // checkpoint with the length of the meeting.
  const window = candidates.slice(-MAX_TURNS_READ_PER_PASS);

  const readings = [];
  for (const turn of window) {
    // The question the client was answering, as the LIVE SESSION recorded it.
    // Falling back to the preceding stored row is what paired "400." with the
    // next question instead of the one it answered, because rows are ordered by
    // transcription completion. Where no link was captured, say nothing rather
    // than assert something false.
    const proposition = turn.answersTurnId ? byId.get(String(turn.answersTurnId)) : null;
    const reading = await readClientTurnFigures({
      env,
      config,
      turnId: turn.turnId,
      transcript: turn.text,
      assistantQuestion: proposition?.text || ''
    }).catch(() => null);
    if (reading) readings.push(reading);
  }
  return readings;
}

/**
 * Record how often the two readers agreed.
 *
 * This is the measurement that has to precede `apply`. Disagreement sets the
 * clarification cost; agreement on a WRONG figure is the failure this design
 * would not otherwise see, which is why the event carries the figures
 * themselves and not just a count.
 */
function recordTurnReadingAgreement({
  env, sessionId, leaseId, turnReadings, plan, mode, input, validation
}) {
  const proposed = (plan?.operationGroups || [])
    .flatMap((group) => group.operations || [])
    .filter((operation) => operation.op !== 'request_clarification')
    .flatMap((operation) => numericLeafValues(operation.value));
  const read = turnReadings.flatMap((reading) => reading.figures
    .filter((figure) => !figure.ambiguous)
    .map((figure) => figure.digits));
  const agreed = proposed.filter((value) => read.some((other) => Math.abs(other - value) < 1e-9));

  void appendRealtimeEvent(env, {
    sessionId,
    leaseId,
    direction: 'server',
    eventType: 'planner.turn_reading.agreement',
    payload: {
      mode,
      turnsRead: turnReadings.length,
      proposedCount: proposed.length,
      agreedCount: agreed.length,
      disagreedCount: proposed.length - agreed.length
    }
  }).catch(() => {});

  // THE PER-TURN DIAGNOSTIC RECORD.
  //
  // Enough to answer "why did this turn produce that profile change" — which
  // turn, which reader, how the two readings compared, where each fact was
  // bound, and what the pass did about it. COUNTS AND IDENTIFIERS ONLY: the
  // figures a client spoke are content, and the event schema permits no arrays
  // or objects precisely so that content cannot drift into a stream that is
  // read casually. The words themselves stay in the transcript store behind
  // their own access controls, reachable by the turn ids recorded here.
  const turns = Array.isArray(input?.transcriptTurns) ? input.transcriptTurns : [];
  const reviewed = new Set((input?.reviewTurnIds || []).map((turnId) => String(turnId)));
  const operations = (plan?.operationGroups || []).flatMap((group) => group.operations || []);
  const accepted = new Set(validation?.acceptedOperationIds || []);
  const rejectionByGroup = new Map((validation?.rejectedGroups || [])
    .map((group) => [String(group.groupId), String(group.code || '')]));
  const groupOf = new Map((plan?.operationGroups || []).flatMap((group) => (
    (group.operations || []).map((operation) => [operation.operationId, String(group.groupId)])
  )));

  for (const reading of turnReadings) {
    const turnId = String(reading.turnId);
    if (!reviewed.has(turnId)) continue;
    const index = turns.findIndex((turn) => String(turn.turnId) === turnId);
    const assistantTurn = index > 0
      ? [...turns.slice(0, index)].reverse().find((turn) => turn.role === 'assistant')
      : null;
    const turnOperations = operations.filter((operation) => (
      (operation.evidence || []).some((ref) => String(ref.turnId) === turnId)
    ));
    void appendRealtimeEvent(env, {
      sessionId,
      leaseId,
      direction: 'server',
      eventType: 'planner.turn_review.diagnostic',
      payload: {
        mode,
        clientTurnId: turnId,
        assistantTurnId: assistantTurn ? String(assistantTurn.turnId) : null,
        readerPromptVersion: reading.promptVersion || null,
        figuresRead: reading.figures.filter((figure) => !figure.ambiguous).length,
        figuresAmbiguous: reading.figures.filter((figure) => figure.ambiguous).length,
        realtimeOutcomeCount: (input?.voiceWriteOutcomes || [])
          .filter((outcome) => String(outcome?.sourceTurnId || '') === turnId).length,
        operationCount: turnOperations.length,
        acceptedCount: turnOperations.filter((op) => accepted.has(op.operationId)).length,
        clarificationCount: turnOperations
          .filter((op) => op.op === 'request_clarification').length,
        rejectedCount: turnOperations.filter((op) => !accepted.has(op.operationId)).length,
        profileChanged: validation?.profileChanged === true,
        ledgerChanged: validation?.ledgerChanged === true,
        status: validation?.status || null
      }
    }).catch(() => {});

    // One per operation: "which person did this pension get attached to" is the
    // question a wrong binding raises, and it deserves a direct answer.
    for (const operation of turnOperations.slice(0, 16)) {
      const landed = accepted.has(operation.operationId);
      void appendRealtimeEvent(env, {
        sessionId,
        leaseId,
        direction: 'server',
        eventType: 'planner.turn_review.binding',
        payload: {
          clientTurnId: turnId,
          operationId: String(operation.operationId || ''),
          op: String(operation.op || ''),
          factId: String(operation.factId || ''),
          ownerId: operation.ownerId ? String(operation.ownerId) : null,
          entityId: operation.entityId ? String(operation.entityId) : null,
          accepted: landed,
          rejectionCode: landed
            ? null
            : rejectionByGroup.get(groupOf.get(operation.operationId) || '') || null
        }
      }).catch(() => {});
    }
  }
}

/** Every number inside an operation value, wherever it is nested. */
function numericLeafValues(value, found = []) {
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((item) => numericLeafValues(item, found));
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'schemaVersion') continue;
    if (typeof item === 'number' && Number.isFinite(item)) found.push(item);
    else numericLeafValues(item, found);
  }
  return found;
}

export async function runPlannerReconciliation({
  env,
  config,
  context,
  leaseId,
  throughTurnId,
  reviewTurnIds = null,
  terminallyUnresolvedEvidenceIds = [],
  trigger = 'material_turn',
  retryAttempt = 0,
  loadContext = null
}) {
  let currentContext = context;
  let preparedPlan = null;
  let outcome = null;
  const rebasedFromRevisions = [];

  for (let rebaseAttempt = 0; rebaseAttempt <= MAX_RECONCILIATION_REBASE_ATTEMPTS; rebaseAttempt += 1) {
    const baseRevision = Number(currentContext?.profile?.revision);
    try {
      outcome = await runPlannerReconciliationAttempt({
        env,
        config,
        context: currentContext,
        leaseId,
        throughTurnId,
        reviewTurnIds,
        terminallyUnresolvedEvidenceIds,
        trigger,
        retryAttempt,
        rebaseAttempt,
        preparedPlan
      });
    } catch (error) {
      // `startPlannerReconciliation` refuses to open an attempt whose base has
      // already moved. That is the same conflict arriving earlier, so it is
      // rebasable on exactly the same terms — but only when there is a plan to
      // rebase; a first attempt that cannot even start has nothing to reuse.
      if (error?.code !== 'profile_revision_conflict' || !preparedPlan || !loadContext) throw error;
      outcome = { status: 'conflicted', errorCode: 'planner_reconciliation_stale', requested: preparedPlan };
    }

    if (outcome?.requested) preparedPlan = outcome.requested;
    if (outcome?.status !== 'conflicted') break;
    if (!loadContext || !preparedPlan || rebaseAttempt === MAX_RECONCILIATION_REBASE_ATTEMPTS) break;

    const refreshed = await loadContext().catch(() => null);
    // Nothing to rebase ONTO. If canonical state did not actually move, the
    // conflict came from somewhere the deterministic pass cannot fix, and
    // re-running it would only produce the same refusal again.
    if (!refreshed || Number(refreshed.profile?.revision) === baseRevision) break;
    rebasedFromRevisions.push(baseRevision);
    currentContext = refreshed;
  }

  return rebasedFromRevisions.length > 0
    ? { ...outcome, rebasedFromRevisions }
    : outcome;
}
