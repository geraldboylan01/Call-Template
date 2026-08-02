/**
 * Transport-independent fact proposal core.
 *
 * Every one of these functions was moved verbatim out of the Realtime Durable
 * Object (realtime_session.js). They decide how a planner-extracted candidate
 * becomes a canonical profile change, and they know nothing about audio, WebRTC,
 * leases or the provider. A voice meeting and a text/agent meeting must reach
 * the same profile from the same statement, so there is exactly one copy.
 *
 * The split is deliberate:
 *   - `planFactProposal` is PURE. It validates, maps and projects one fact onto
 *     a profile and returns the next profile. Offline harnesses and the shared
 *     turn service both use it, so neither needs a database.
 *   - Persistence (fact proposals, revisioned commits, tool-attempt accounting)
 *     stays with the caller, because only the caller knows which transport's
 *     bookkeeping applies.
 */

import { normalizeHouseholdProfile } from '../../../js/planning/profile.js';
import { extractRulesOnlyProfilePatch } from '../../../js/planning/rules_only_extraction.js';
import { getSemanticFactDefinition } from '../../../js/planning/semantic_facts.js';
import { ConsumerError } from './errors.js';
import {
  mapRealtimeFact,
  modulesEnabledByFacts,
  realtimeFactAllowed
} from './realtime_fact_mapper.js';
import {
  PLANNER_EXTRACTION_V3,
  positionCandidatesToRealtimeFacts,
  sectionCompletionToRealtimeFact
} from './realtime_planner.js';
import { applyProfilePatch } from './validators.js';

/** The maximum candidates one finalized turn may produce. */
export const MAX_PLANNER_CANDIDATES = 24;

export function boundedProposalRange(value) {
  const source = value?.range && typeof value.range === 'object' ? value.range : value;
  const comparable = (item) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Number(item.amount)
      : Number(item)
  );
  // The planner writes a money range as {minAmount, maxAmount, currency} --
  // that is the shape it naturally produces for an entity fact, and it is not
  // the {min, max} shape this function was written for. The mismatch silently
  // failed every stated range: an agent-driven call as a Cork nurse answered
  // "somewhere between 180,000 and 220,000" and it was refused as an invalid
  // range, so the meeting asked the same question a third time.
  //
  // Accept both, and normalise here rather than making each caller care.
  const endpoints = source?.minAmount !== undefined || source?.maxAmount !== undefined
    ? {
        min: source.currency ? { amount: source.minAmount, currency: source.currency } : source.minAmount,
        max: source.currency ? { amount: source.maxAmount, currency: source.currency } : source.maxAmount
      }
    : { min: source?.min, max: source?.max };
  const min = comparable(endpoints.min);
  const max = comparable(endpoints.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  return { min: endpoints.min, max: endpoints.max };
}

function completionFactMapping(profile, fact, normalizedRange = null) {
  const definition = getSemanticFactDefinition(fact.factId);
  if (!definition) {
    throw new ConsumerError(400, 'realtime_fact_unknown', 'That semantic fact is not recognised.');
  }
  // A RANGE is inherently numeric. "I don't know", though, is something a
  // client can say about ANYTHING, and refusing to record it was a real defect:
  // an agent-driven run caught the meeting asking "roughly what is your home
  // worth?" four times because property_position is an entity fact and the
  // client's "I don't know" was rejected every time.
  if (normalizedRange && !['money', 'number'].includes(definition.valueType)) {
    throw new ConsumerError(
      400,
      'realtime_fact_range_invalid',
      'Only a numerical or monetary fact may be recorded as a range.'
    );
  }
  const completionFacts = {
    ...(profile.assumptions?.values?.completionFacts || {}),
    unknownFactIds: {
      ...(profile.assumptions?.values?.completionFacts?.unknownFactIds || {})
    },
    rangedFactValues: {
      ...(profile.assumptions?.values?.completionFacts?.rangedFactValues || {})
    },
    estimateDeclinedFactIds: {
      ...(profile.assumptions?.values?.completionFacts?.estimateDeclinedFactIds || {})
    }
  };
  if (fact.certainty === 'unknown') {
    // ONE estimate prompt, then we stop asking. The first "I don't know" is not
    // final: the meeting comes back once for a rough idea or a range, because
    // clients very often have one and an approximate figure still runs the
    // analysis. A SECOND "I don't know" for the same fact is the client
    // declining that estimate, and that is what makes the answer final --
    // derived from what is already on record, so no separate bookkeeping write
    // is needed and both transports reach it identically.
    if (completionFacts.unknownFactIds[fact.factId] === true) {
      completionFacts.estimateDeclinedFactIds[fact.factId] = true;
    }
    completionFacts.unknownFactIds[fact.factId] = true;
    delete completionFacts.rangedFactValues[fact.factId];
    return {
      fieldPath: '/assumptions/values/completionFacts',
      metadataPath: `/assumptions/values/completionFacts/unknownFactIds/${fact.factId}`,
      canonicalValue: completionFacts,
      displayValue: 'Unknown'
    };
  }
  delete completionFacts.unknownFactIds[fact.factId];
  delete completionFacts.estimateDeclinedFactIds[fact.factId];
  completionFacts.rangedFactValues[fact.factId] = normalizedRange;
  return {
    fieldPath: '/assumptions/values/completionFacts',
    metadataPath: `/assumptions/values/completionFacts/rangedFactValues/${fact.factId}`,
    canonicalValue: completionFacts,
    displayValue: normalizedRange
  };
}

export function mapRealtimeProposalFact(profile, fact) {
  if (fact.certainty === 'unknown') return completionFactMapping(profile, fact);
  if (fact.certainty !== 'range') return mapRealtimeFact(profile, fact);
  const range = boundedProposalRange(fact.value);
  if (!range) {
    throw new ConsumerError(400, 'realtime_fact_range_invalid', 'A ranged fact requires finite minimum and maximum values.');
  }
  const minimum = mapRealtimeFact(profile, { ...fact, certainty: 'exact', value: range.min });
  const maximum = mapRealtimeFact(profile, { ...fact, certainty: 'exact', value: range.max });
  if (minimum.fieldPath !== maximum.fieldPath) {
    throw new ConsumerError(409, 'realtime_fact_range_invalid', 'The ranged fact does not map to one stable profile field.');
  }
  const normalizedRange = { min: minimum.displayValue, max: maximum.displayValue };
  const checked = boundedProposalRange(normalizedRange);
  if (!checked) {
    throw new ConsumerError(400, 'realtime_fact_range_invalid', 'The ranged fact minimum must not exceed its maximum.');
  }
  // A RANGE IS AN ANSWER, not a gap. "Somewhere between 300 and 400 thousand"
  // is the client telling us what they know, so take the midpoint and carry on.
  // The stated range is kept beside it: the meeting announces which figure it
  // will use and invites a correction, but nothing waits on a confirmation.
  const numericPart = (endpoint) => Number(
    endpoint && typeof endpoint === 'object' && !Array.isArray(endpoint) ? endpoint.amount : endpoint
  );
  const midpoint = (numericPart(checked.min) + numericPart(checked.max)) / 2;
  const mapped = mapRealtimeFact(profile, {
    ...fact,
    certainty: 'approximate',
    value: minimum.displayValue && typeof minimum.displayValue === 'object'
      ? { ...minimum.displayValue, amount: midpoint }
      : midpoint
  });
  const completionFacts = {
    ...(profile.assumptions?.values?.completionFacts || {}),
    rangedFactValues: {
      ...(profile.assumptions?.values?.completionFacts?.rangedFactValues || {}),
      [fact.factId]: normalizedRange
    }
  };
  return {
    ...mapped,
    additionalPatch: {
      ...(mapped.additionalPatch || {}),
      '/assumptions/values/completionFacts': completionFacts
    },
    certainty: 'approximate',
    derivedFromRange: normalizedRange
  };
}

function clearCompletionFactMarker(profile, factId, fieldPath = null) {
  const completionFacts = profile.assumptions?.values?.completionFacts;
  if (!completionFacts) return profile;
  if (completionFacts.unknownFactIds) delete completionFacts.unknownFactIds[factId];
  if (completionFacts.estimateDeclinedFactIds) delete completionFacts.estimateDeclinedFactIds[factId];
  if (completionFacts.rangedFactValues) delete completionFacts.rangedFactValues[factId];
  if (fieldPath && completionFacts.confirmedNonePaths) {
    delete completionFacts.confirmedNonePaths[fieldPath];
  }
  if (fieldPath && completionFacts.completedPaths) {
    delete completionFacts.completedPaths[fieldPath];
  }
  return profile;
}

export function patchForMappedRealtimeFact(mapped) {
  return {
    ...(mapped.additionalPatch || {}),
    [mapped.fieldPath]: mapped.canonicalValue
  };
}

export function applyMappedRealtimeFact(profile, fact, mapped) {
  const patch = patchForMappedRealtimeFact(mapped);
  let nextProfile = applyProfilePatch(profile, patch, [], 'consumer_edit');
  const metadataPath = mapped.metadataPath || mapped.fieldPath;
  // The MAPPER decides the recorded certainty when it resolved the value
  // itself. A stated range becomes an approximate midpoint, so the metadata
  // must say approximate — recording it as `range` would demand a range on a
  // field that now holds a single number.
  // The mapper decides the recorded certainty when it resolved the value
  // itself: a stated range becomes an approximate midpoint, so the metadata
  // says approximate rather than demanding a range on a single number.
  const certainty = String(mapped.certainty || fact.certainty || 'unknown');
  const storedRange = mapped.derivedFromRange
    ? boundedProposalRange(mapped.derivedFromRange)
    : certainty === 'range' ? boundedProposalRange(mapped.displayValue) : null;
  const rangeNumber = (value) => Number(value && typeof value === 'object' ? value.amount : value);
  const range = storedRange
    ? { min: rangeNumber(storedRange.min), max: rangeNumber(storedRange.max) }
    : null;
  Object.keys(nextProfile.fieldMetadata || {})
    .filter((path) => path === metadataPath || path.startsWith(`${metadataPath}/`))
    .forEach((path) => {
      nextProfile.fieldMetadata[path] = {
        ...nextProfile.fieldMetadata[path],
        source: 'user_statement',
        confidence: certainty === 'exact' ? 'high' : certainty === 'unknown' ? 'low' : 'medium',
        certainty,
        confirmedByUser: false,
        ...(range ? { range } : {})
      };
    });
  // A midpoint keeps the range it came from on record: that is what the client
  // actually said, and the assumption notice quotes it back to them.
  if (!['unknown', 'range'].includes(certainty) && !mapped.derivedFromRange) {
    clearCompletionFactMarker(nextProfile, fact.factId, mapped.fieldPath);
  }
  return normalizeHouseholdProfile(nextProfile);
}

function realtimeFactDependencyRank(fact) {
  const factId = String(fact?.factId || '');
  if (factId === 'primary_goal' || factId === 'self_description') return 0;

  const definition = getSemanticFactDefinition(factId);
  if (definition?.profilePathTemplate?.startsWith('/assumptions/values/persona/')) return 10;
  if (factId === 'partner_person') return 20;

  // Collection/root entity proposals establish stable identities and owners.
  // They must be projected before any scalar proposal that selects or updates
  // one of those records, regardless of the model's submitted array order.
  if (definition?.valueType === 'entity') return 30;

  // Reconciliation reads both the generic asset and specialist collection, so
  // it is the final dependency layer rather than an ordinary scalar/choice.
  if (factId === 'specialist_asset_reconciliation') return 50;
  return 40;
}

export function orderRealtimeFactsByDependency(facts) {
  return [...facts].sort((left, right) => {
    const rankDifference = realtimeFactDependencyRank(left) - realtimeFactDependencyRank(right);
    if (rankDifference !== 0) return rankDifference;
    const leftId = String(left?.factId || '');
    const rightId = String(right?.factId || '');
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

/**
 * Turn one validated planner extraction into the ordered candidate list the
 * fact gate consumes. Goals become primary_goal (and primary_goal_focus when the
 * client named a focus); financial positions and section completions become
 * their semantic-fact equivalents. Deterministic server code owns this mapping —
 * the planner never names a module or a profile path.
 */
/**
 * Give an answer the identity of the thing it was asked about.
 *
 * THE MEETING ALREADY KNOWS WHICH ONE IT MEANT. When several pensions are on
 * record, the question the client hears is specific -- "what percentage of your
 * pay do you contribute to the pension from your old job?" -- and the signed
 * question carries the exact entity behind it. But the client answers "thirty
 * percent", the planner extracts a bare number with no pension attached, and
 * the engine refuses it as ambiguous. The question is then asked again, and
 * again, because there is no wording the client could use that would satisfy it.
 *
 * Three concurrent calls as the same household all ended here: six contribution
 * rates outstanding across three pensions, none of them answerable.
 *
 * Rediscovering the entity from the client's words is the wrong direction --
 * they were never told the pension's internal name and should not have to
 * repeat it. The identity travels forward from the question instead, which is
 * deterministic, costs nothing, and is exactly what a person would assume.
 */
/**
 * Facts that describe the same holding. Asked about one, a client naturally
 * answers several: "I pay 30% and the company does 10%" is one sentence about
 * one pension. Binding only the fact that was literally asked left the other
 * half of the answer homeless and refused.
 */
const ENTITY_FACT_FAMILIES = Object.freeze([
  Object.freeze([
    'pension_current_value',
    'pension_employee_contribution_rate',
    'pension_employer_contribution_rate'
  ])
]);

function sharesEntityWith(askedFactId, candidateFactId) {
  if (askedFactId === candidateFactId) return true;
  return ENTITY_FACT_FAMILIES.some((family) => (
    family.includes(askedFactId) && family.includes(candidateFactId)
  ));
}

export function bindCandidateToAskedEntity(candidate, state, profile = null) {
  const asked = state?.meetingBrief?.questionBatch?.primaryFact
    || state?.nextApprovedFact
    || state?.nextQuestion;
  if (!asked || !candidate?.factId || !sharesEntityWith(asked.factId, candidate.factId)) {
    return candidate;
  }
  // factInstanceId is `${factId}:${entityId}` when the question is scoped to a
  // particular holding; anything else carries no entity to inherit.
  const entityId = String(asked.factInstanceId || '').slice(String(asked.factId).length + 1);
  if (!entityId) return candidate;
  // An owner named by the planner only blocks the binding when it is a
  // DIFFERENT person from the one whose holding was asked about. "And Aoife's
  // is 10%" while discussing Dermot's scheme must not attach here -- but when
  // the question is about Aoife's own pension, naming her is agreement, not
  // contradiction, and refusing it lost her rates entirely.
  const namedOwner = candidate.value?.owner || candidate.value?.ownerId;
  if (namedOwner && profile) {
    const askedOwnerId = (profile.pensions || [])
      .find((pension) => pension.pensionId === entityId)?.ownerId;
    const namedOwnerId = namedOwner === 'partner'
      ? profile.partner?.personId
      : namedOwner === 'primary'
        ? profile.primaryPerson?.personId
        : namedOwner;
    if (askedOwnerId && namedOwnerId && askedOwnerId !== namedOwnerId) return candidate;
  } else if (namedOwner) {
    return candidate;
  }
  const value = candidate.value;
  const alreadyIdentified = value && typeof value === 'object' && !Array.isArray(value)
    && (value.entityId || value.id);
  if (alreadyIdentified) return candidate;
  return {
    ...candidate,
    value: value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, entityId }
      : { entityId, value }
  };
}

export function mapPlannerExtractionToCandidates(extraction) {
  const mappedGoals = (extraction.goalCandidates || [])
    .filter((candidate) => ['high', 'medium'].includes(candidate.confidence))
    .flatMap((candidate) => [{
      candidateId: candidate.candidateId,
      operation: candidate.correctionTarget ? 'correct' : 'upsert',
      factId: 'primary_goal',
      value: {
        type: candidate.goalType,
        ...(candidate.correctionTarget ? { correctionTarget: candidate.correctionTarget } : {})
      },
      certainty: candidate.confidence === 'high' ? 'exact' : 'approximate',
      evidenceText: candidate.evidenceText,
      correctionTarget: candidate.correctionTarget || ''
    }, ...(candidate.priorityHint === 'primary' ? [{
      candidateId: `${candidate.candidateId}-focus`,
      operation: 'upsert',
      factId: 'primary_goal_focus',
      value: candidate.goalType,
      certainty: 'exact',
      evidenceText: candidate.evidenceText,
      correctionTarget: ''
    }] : [])]);
  const mappedPositions = positionCandidatesToRealtimeFacts(extraction.positions || []);
  const mappedCompletions = (extraction.sectionCompletions || [])
    .map(sectionCompletionToRealtimeFact)
    .filter(Boolean);
  // ENTITIES BEFORE THE THINGS THAT REFERENCE THEM.
  //
  // Two ordering faults, in opposite directions, both from one turn where a
  // client introduced herself, her husband, both salaries and her pension:
  //
  //   Scalars before positions -- a contribution rate arrived before the
  //   pension it belongs to, so it created its own placeholder. One HSE
  //   pension became two records and the rates landed on the phantom.
  //
  //   Positions before people -- her husband's salary arrived before
  //   partner_person had created him, so an income owned by "partner" had no
  //   partner to own it, and his €41,000 was dropped.
  //
  // So the order is by WHAT EACH CANDIDATE ESTABLISHES: people first, then the
  // positions those people hold, then the figures that attach to a position.
  const establishesPerson = (candidate) => candidate?.factId === 'partner_person';
  const semanticFacts = extraction.semanticFacts || [];
  const ordered = [
    ...mappedGoals,
    ...semanticFacts.filter(establishesPerson),
    ...mappedPositions,
    ...semanticFacts.filter((candidate) => !establishesPerson(candidate)),
    ...mappedCompletions
  ];

  // NAMING A PARTNER'S MONEY ESTABLISHES THE PARTNER.
  //
  // Every partner-owned fact is refused until partner_person exists, and the
  // planner does not reliably emit it: asked to "include Aoife in the
  // planning", one turn produced her age and her employment and no
  // partner_person at all, so both were refused and the partner never came into
  // being. A later turn then refused her €500,000 pension for the same reason.
  //
  // Waiting for the model to remember a bookkeeping step is the wrong shape.
  // A fact explicitly owned by the partner IS the evidence that a partner
  // exists, so the household gains one here. Applying partner_person when a
  // partner is already present is idempotent -- it resolves to the same person
  // -- so this is safe to synthesise whenever it is absent.
  const ownedByPartner = (candidate) => (
    candidate?.value?.owner === 'partner' || candidate?.value?.ownerId === 'partner'
  );
  if (ordered.some(ownedByPartner) && !ordered.some(establishesPerson)) {
    ordered.unshift({
      candidateId: 'derived-partner-person',
      operation: 'upsert',
      factId: 'partner_person',
      value: { include: true },
      certainty: 'approximate',
      evidenceText: 'The client attributed a position or figure to their partner.',
      correctionTarget: ''
    });
  }
  return ordered.slice(0, MAX_PLANNER_CANDIDATES);
}

/**
 * Deterministic fallback extraction, for when the AI planner is unavailable.
 *
 * A failed planner call is an INTERNAL failure. It is not the client saying
 * something unclear, and asking them to rephrase cannot fix it — it just loops.
 * The deterministic rules extractor already reads plain text and finds stated
 * goals and a stated age with no network at all, so a planner outage degrades
 * to reduced extraction instead of a dead meeting.
 *
 * Deliberately narrow: goals and age only. These are the two things the rules
 * extractor identifies with high confidence and explicit textual evidence, and
 * they are what unblocks a meeting. Everything else waits for the planner.
 *
 * @returns {null|object} a PlannerExtractionV3-shaped extraction, or null when
 *   the turn genuinely yields nothing.
 */
export function deterministicFallbackExtraction({ transcript, profile, sourceTurnId, capturedAt = null }) {
  let rules;
  try {
    rules = extractRulesOnlyProfilePatch(String(transcript || ''), {
      profile,
      capturedAt: capturedAt || new Date().toISOString(),
      conversationTurnId: sourceTurnId
    });
  } catch (_error) {
    return null;
  }
  const goalCandidates = (rules.goalCandidates || [])
    .filter((candidate) => ['high', 'medium'].includes(candidate.confidence))
    .map((candidate, index) => ({
      candidateId: `fallback-goal-${index + 1}`,
      goalType: candidate.type,
      confidence: candidate.confidence,
      priorityHint: 'unspecified',
      evidenceText: (candidate.rationale || [])[0] || 'Stated in this turn.',
      correctionTarget: ''
    }));

  const ageOperation = (rules.patch?.operations || [])
    .find((operation) => operation.path === '/primaryPerson/age' && Number.isInteger(operation.value));
  const semanticFacts = ageOperation
    ? [{
        candidateId: 'fallback-age',
        operation: 'upsert',
        factId: 'person_current_age',
        value: ageOperation.value,
        certainty: 'exact',
        evidenceText: 'The client stated their age in this turn.',
        correctionTarget: ''
      }]
    : [];

  if (goalCandidates.length === 0 && semanticFacts.length === 0) return null;
  return {
    schemaVersion: PLANNER_EXTRACTION_V3,
    sourceTurnId,
    degraded: true,
    goalCandidates,
    semanticFacts,
    positions: [],
    sectionCompletions: [],
    invalidCandidates: [],
    clientQuestion: { present: false, intent: 'none', topic: '', questionText: '' },
    ambiguities: [],
    narrativeSummary: { summary: '', evidence: [] }
  };
}

/**
 * Validate, map and project ONE proposed fact onto a profile.
 *
 * Pure: no database, no network, no transport. Throws the same ConsumerError
 * codes the Realtime tool gate has always thrown, because those codes are part
 * of the contract the model is instructed to recover from.
 *
 * @returns {{profile, mapped, patch, confirmationPolicy, displayValue}}
 */
export function planFactProposal({ config, profile, state, fact, plannerBatch = false }) {
  if (!['exact', 'approximate', 'range', 'unknown'].includes(fact?.certainty)) {
    throw new ConsumerError(400, 'realtime_fact_certainty_invalid', 'Fact certainty is invalid.');
  }
  // A RANGE is inherently numeric. "I don't know" is not: a client can say it
  // about anything, and it must always be recordable so the meeting can
  // acknowledge the gap and move on instead of asking again.
  if (fact.certainty === 'range'
    && !['money', 'number'].includes(getSemanticFactDefinition(fact.factId)?.valueType)) {
    throw new ConsumerError(
      400,
      'realtime_fact_certainty_invalid',
      'Only a numerical or monetary fact may be recorded as unknown or as a range.'
    );
  }
  // The module-relevance gate applies only to the controlled v1 journey. The
  // conversational v2 meeting accumulates orientation facts that no currently
  // routed module needs yet, because those facts are precisely what select the
  // next module.
  const enabledModules = modulesEnabledByFacts(state.recommendations, [fact], profile);
  if (!realtimeFactAllowed(fact.factId, enabledModules)
    && !config.realtimeConversationV2Enabled) {
    throw new ConsumerError(409, 'realtime_fact_not_routed', 'That semantic fact is not used by the currently routed canary modules.');
  }
  const mapped = mapRealtimeProposalFact(profile, fact);
  const patch = patchForMappedRealtimeFact(mapped);
  const configuredConfirmationPolicy = getSemanticFactDefinition(fact.factId)?.confirmationPolicy || 'final_review';
  // Conversational v2 has no mandatory spoken confirmation tool. The silent
  // planner therefore saves even legacy read-back values as visibly reviewable
  // drafts; the authenticated final profile/plan confirmation remains the
  // authoritative gate. The controlled v1 journey keeps its existing spoken
  // read-back behaviour unchanged.
  const confirmationPolicy = config.realtimeConversationV2Enabled && plannerBatch
    ? 'final_review'
    : configuredConfirmationPolicy;
  return {
    profile: applyMappedRealtimeFact(profile, fact, mapped),
    mapped,
    patch,
    confirmationPolicy,
    displayValue: mapped.proposalValue ?? mapped.displayValue
  };
}
