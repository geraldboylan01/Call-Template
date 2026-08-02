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
  const min = comparable(source?.min);
  const max = comparable(source?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  return { min: source.min, max: source.max };
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
    }
  };
  if (fact.certainty === 'unknown') {
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
  return [
    ...mappedGoals,
    ...(extraction.semanticFacts || []),
    ...mappedPositions,
    ...mappedCompletions
  ].slice(0, MAX_PLANNER_CANDIDATES);
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
