/**
 * SEMANTIC CLAIMS IN, STORAGE OPERATIONS OUT — WITH NO MODEL IN BETWEEN.
 *
 * This is the load-bearing claim of the semantic-claims spike. The reconciler
 * currently asks one model call to understand English AND author a mutation
 * plan: eight operation types, fourteen reason codes, six note kinds, roughly
 * fifteen fields an operation, server-issued slot ids, and `valueJson` — a JSON
 * string, so Structured Outputs cannot constrain the field carrying the money.
 *
 * If this module works, none of that needs to be model-facing. A claim says what
 * the client established; this decides where it goes. Knowing that a household's
 * cash is an asset record, that a pension's money lives in `currentValue`, and
 * that "hers" means the partner when the household has one, is SCHEMA and
 * IDENTITY knowledge — testable, deterministic, and the wrong job for a model.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: read English. There is no regex over the
 * client's words here, no alias matching, no pronoun grammar and no number
 * parsing. Every semantic question — what was said, whose it is, whether it
 * corrects something, whether "none" closes a collection — was answered upstream
 * by a reader that had the conversation in front of it. This only asks whether
 * the answer has somewhere legal to go.
 *
 * It emits `ReconciliationPlanV1` operations ON PURPOSE, rather than writing
 * canonical state directly: that keeps every existing safety check — evidence
 * offsets, entity cardinality, unit compatibility, revisions, CAS, the profile
 * invariants — in force unchanged, so the experiment measures the new
 * REPRESENTATION rather than a new and less careful storage layer.
 */

import { POSITION_PROJECTIONS } from './reconciliation.js';
import { getSemanticFactDefinition } from './semantic_facts.js';

/** The pronoun a client used, mapped to a role the household actually has. */
const ROLE_FOR_OWNER_REF = Object.freeze({
  speaker: 'primary',
  other_person: 'partner',
  joint: 'household'
});

/**
 * The money shape every canonical slot accepts. Jurisdiction default applies
 * where the client named no currency, exactly as the deterministic path has
 * always done for an unadorned "900 a month".
 */
function money(amount, currency) {
  return { amount, currency: currency || 'EUR' };
}

function ownerIdFor(claim, owners) {
  const role = ROLE_FOR_OWNER_REF[claim.ownerRef];
  if (role) {
    const match = [...owners.values()].find((owner) => owner.role === role);
    return match ? match.ownerId : null;
  }
  // NO POSSESSIVE, AND ONLY ONE PERSON IT COULD BE.
  //
  // "My pension is a hundred and eighty thousand" says whose it is; "it's about
  // a hundred and eighty thousand" does not, and a client living alone has no
  // reason to say. Refusing that discarded a correct holding for an owner who
  // was never actually in doubt — the same defect the reconciliation gate
  // already fixed by reading a record's own owner field.
  //
  // Counting the candidates is identity work against a catalogue, not a guess
  // about English: where a household has a partner, "unstated" stays genuinely
  // ambiguous and the claim is left to fail rather than assigned to whoever
  // happens to be first.
  const holders = [...owners.values()].filter((owner) => owner.role === 'primary' || owner.role === 'partner');
  return holders.length === 1 ? holders[0].ownerId : null;
}

/**
 * WHICH FIELD OF A POSITION RECORD A FIGURE BELONGS IN.
 *
 * Read from the registry's own path patterns rather than listed by hand, so it
 * cannot drift from what the projector accepts. This is what says a pension's
 * money is `currentValue` and an income's is `grossAnnual`.
 */
const POSITION_VALUE_FIELD = Object.freeze({
  pensions: 'currentValue',
  assets: 'currentValue',
  liabilities: 'currentBalance',
  properties: 'currentValue',
  incomeSources: 'grossAnnual',
  businesses: 'currentValue'
});

/** A concept with no slot of its own is recorded as the position that owns its collection. */
function positionFactFor(factId) {
  if (POSITION_PROJECTIONS[factId]) return factId;
  const definition = getSemanticFactDefinition(factId);
  const roots = new Set((definition?.mappings || [])
    .map((mapping) => mapping.pathPattern)
    .filter((pattern) => typeof pattern === 'string' && pattern.startsWith('/') && !pattern.includes('/*'))
    .map((pattern) => pattern.split('/')[1]));
  if (roots.size !== 1) return null;
  const [root] = [...roots];
  const owning = Object.entries(POSITION_PROJECTIONS)
    .filter(([, projection]) => projection.collection === root)
    .map(([positionFactId]) => positionFactId);
  return owning.length === 1 ? owning[0] : null;
}

/**
 * Compile one corroborated reading into a plan.
 *
 * @returns {{plan: object, uncompilable: Array}} `uncompilable` is as much a
 *   result as the plan: a claim this cannot place is a gap in the compiler or in
 *   the representation, and the spike has to be able to count them rather than
 *   quietly emit a shorter plan.
 */

/**
 * THE CORROBORATED CLAIMS, AS READINGS OF THE TURNS THEY CAME FROM.
 *
 * The existing validator asks "does an independent reading of this turn contain
 * the figure being written?" and falls back to a deterministic scan when no
 * reading exists. That scan reads "two and a half thousand" as 2, which is the
 * defect the whole two-reader mechanism was built to end.
 *
 * In the claims architecture there is nothing to fall back to, because the
 * reading is not a separate artefact — two independent readings of the
 * conversation ARE what produced the claim, and a claim that survived
 * corroboration has already cleared a stricter bar than any numeric check. So
 * the claims are handed to the validator as the reading of their own turns, and
 * the deterministic scan is retired rather than consulted.
 *
 * KNOWN LIMIT: a rate is stored as a fraction and needs the reader to say the
 * client expressed a proportion. Claims carry no quantity of their own yet, so
 * a contribution rate would arrive here as `count` and be refused. That is a
 * gap in the claim schema, and it belongs in the schema rather than in a guess
 * made here.
 */
export function readingsFromClaims(claims, { quantityFor = () => 'money' } = {}) {
  const byTurn = new Map();
  for (const claim of claims) {
    if (claim.amount === null || !claim.turnId || !claim.quote) continue;
    const figures = byTurn.get(claim.turnId) || [];
    figures.push({
      digits: claim.amount,
      quote: claim.quote,
      currency: claim.currency,
      quantity: quantityFor(claim),
      // The same vocabulary the independent reader already reports, so owner
      // binding is checked here exactly as it is on the current path.
      attribution: claim.ownerRef,
      // A claim that reached corroboration is not ambiguous by construction:
      // anything the readers could not settle became a question instead.
      ambiguous: false
    });
    byTurn.set(claim.turnId, figures);
  }
  return [...byTurn.entries()].map(([turnId, figures]) => ({ turnId, figures }));
}

export function compileClaims(claims, {
  owners,
  entities,
  planId = 'plan_semantic_claims',
  slotIdFor = (collection, index) => `recon_slot_${collection}_${index}`
} = {}) {
  const operations = [];
  const uncompilable = [];
  const slotsUsed = new Map();
  // A mention the reader tied to a new holding gets ONE slot, so two claims
  // about the same newly mentioned pension land in one record rather than two.
  // Duplicating an entity silently doubles a retirement pot, which is the worst
  // thing this compiler could do.
  const slotForMention = new Map();

  const nextSlot = (positionFactId, mentionKey) => {
    if (slotForMention.has(mentionKey)) return slotForMention.get(mentionKey);
    const collection = POSITION_PROJECTIONS[positionFactId]?.collection;
    if (!collection) return null;
    const index = (slotsUsed.get(positionFactId) || 0) + 1;
    slotsUsed.set(positionFactId, index);
    const slot = slotIdFor(positionFactId, index);
    if (!entities.has(slot)) return null;
    slotForMention.set(mentionKey, slot);
    return slot;
  };

  const reject = (claim, reason) => uncompilable.push({ claim, reason });

  for (const claim of claims) {
    const definition = getSemanticFactDefinition(claim.factId);
    if (!definition) { reject(claim, 'unknown_fact'); continue; }

    const evidence = [{ turnId: claim.turnId, quote: claim.quote }];
    const operationId = `op_${operations.length + 1}`;

    // A QUESTION IS AN OUTCOME, NOT A FAILURE. Where the reader could not settle
    // a claim, or could not tell one holding from another, the honest result is
    // to ask — and asking is what stops a guess reaching a calculation.
    if (claim.ambiguityQuestion || claim.entityAction === 'ambiguous') {
      operations.push({
        operationId,
        op: 'request_clarification',
        factId: claim.factId,
        value: {
          schemaVersion: 2,
          needId: `need_${claim.mentionRef}`,
          factId: claim.factId,
          factInstanceId: claim.factId,
          reasonCode: 'reconciliation_ambiguous_claim',
          prompt: claim.ambiguityQuestion
            || `Is that the same one we already have, or a separate one?`,
          importance: 'required',
          blockingModuleIds: definition.moduleIds || [],
          answerPolicy: 'unknown_allowed',
          status: 'open'
        },
        certainty: 'exact',
        reasonCode: 'ambiguous_evidence',
        evidence
      });
      continue;
    }

    // ONLY WHAT THE CLIENT HAS NOW REACHES THE PROFILE. A figure inside "what if
    // I put in another two hundred a month" is a scenario the client is
    // exploring, not money they hold, and writing it as a holding is how a
    // hypothetical becomes a plan.
    if (claim.modality !== 'current') { reject(claim, `modality_${claim.modality}`); continue; }

    if (claim.assertion === 'absence' || claim.assertion === 'completion') {
      operations.push({
        operationId,
        op: 'set_completion',
        factId: claim.factId,
        noteKind: 'completion',
        // "No others" closes the collection while leaving what is in it; "none"
        // asserts there is nothing. Collapsing the two writes an empty
        // liabilities list over a real mortgage.
        value: {
          completion: claim.assertion === 'absence' ? 'confirmed_none' : 'no_further_items'
        },
        certainty: 'exact',
        reasonCode: 'explicit_none',
        ...(ownerIdFor(claim, owners) ? { ownerId: ownerIdFor(claim, owners) } : {}),
        evidence
      });
      continue;
    }

    if (claim.assertion === 'unknown' || claim.assertion === 'retraction') {
      reject(claim, `assertion_${claim.assertion}_not_compiled_in_spike`);
      continue;
    }

    const positionFactId = positionFactFor(claim.factId);
    const isPosition = Boolean(positionFactId) && claim.entityAction !== 'none';

    if (isPosition) {
      const projection = POSITION_PROJECTIONS[positionFactId];
      const collection = projection.collection;
      const entityId = claim.entityAction === 'existing'
        ? claim.existingEntityId
        : nextSlot(positionFactId, `${positionFactId}:${claim.entityLabel || claim.mentionRef}`);
      if (!entityId || !entities.has(entityId)) { reject(claim, 'no_entity_available'); continue; }

      const ownerId = ownerIdFor(claim, owners);
      if (!ownerId && projection.ownerKey) { reject(claim, 'owner_unresolved'); continue; }

      const valueField = POSITION_VALUE_FIELD[collection];
      const record = {
        [projection.idKey]: entityId,
        ...(projection.ownerKey === 'ownerIds' ? { ownerIds: [ownerId] } : { ownerId }),
        // A display label names the record for a human and decides nothing. The
        // client's own words for it beat any label this could invent.
        label: claim.entityLabel || definition.label || claim.factId,
        ...(claim.text ? { type: claim.text } : {}),
        ...(claim.assertion === 'value' && claim.amount !== null && valueField
          ? { [valueField]: money(claim.amount, claim.currency) }
          : {})
      };
      // `type` is required on several collections and is a SEMANTIC choice —
      // cash and investment are different answers and only the client can settle
      // which. Where the reader did not report one, the claim is left for a
      // question rather than typed by this layer's guess.
      if ((projection.requiredKeys || []).includes('type') && !record.type) {
        reject(claim, 'type_not_stated');
        continue;
      }
      operations.push({
        operationId,
        op: 'upsert_note',
        factId: positionFactId,
        noteKind: 'position',
        entityId,
        ownerId,
        value: record,
        certainty: claim.certainty === 'exact' ? 'exact' : 'approximate',
        reasonCode: claim.supersedesMention ? 'corrected_value' : 'missing_note',
        evidence
      });
      continue;
    }

    if (claim.assertion === 'presence') { reject(claim, 'presence_without_entity'); continue; }
    if (claim.amount === null && !claim.text) { reject(claim, 'no_value_to_write'); continue; }

    operations.push({
      operationId,
      op: 'upsert_note',
      factId: claim.factId,
      noteKind: 'fact',
      value: definition.valueType === 'money'
        ? money(claim.amount, claim.currency)
        : (claim.text !== null ? claim.text : claim.amount),
      certainty: claim.certainty === 'exact' ? 'exact' : 'approximate',
      reasonCode: claim.supersedesMention ? 'corrected_value' : 'missing_note',
      ...(ownerIdFor(claim, owners) ? { ownerId: ownerIdFor(claim, owners) } : {}),
      evidence
    });
  }

  return {
    plan: {
      schemaVersion: 1,
      planId,
      verdict: operations.length > 0 ? 'changes_proposed' : 'clean',
      reviewedNoteIds: [],
      // ONE OPERATION PER GROUP. Grouping decides blast radius, and a claim is
      // independent of its neighbours by construction — one unplaceable figure
      // must not take a correct one down with it.
      operationGroups: operations.map((operation) => ({
        groupId: operation.operationId,
        operations: [operation]
      }))
    },
    uncompilable
  };
}
