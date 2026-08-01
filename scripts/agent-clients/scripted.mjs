/**
 * Scripted simulated client — the default, and the only one CI uses.
 *
 * Replays a fixed turn list and returns the scenario's recorded planner
 * extraction for each turn. No network, no API key, fully deterministic, so a
 * routing or persistence regression fails the build for a reason that is always
 * the same.
 *
 * The `plannerFails` option simulates a provider outage, which is how the
 * deterministic-fallback path is exercised.
 */

import { ConsumerError } from '../../worker/src/consumer/errors.js';

/** Expand a scenario's shorthand extraction into a full PlannerExtractionV3. */
export function toPlannerExtraction(sourceTurnId, shorthand = {}) {
  return {
    schemaVersion: 'PlannerExtractionV3',
    sourceTurnId,
    goalCandidates: (shorthand.goals || []).map((goal, index) => ({
      candidateId: `goal-${index + 1}`,
      goalType: typeof goal === 'string' ? goal : goal.type,
      confidence: (typeof goal === 'object' && goal.confidence) || 'high',
      priorityHint: (typeof goal === 'object' && goal.priorityHint) || 'unspecified',
      evidenceText: 'scenario evidence',
      correctionTarget: (typeof goal === 'object' && goal.correctionTarget) || ''
    })),
    semanticFacts: (shorthand.facts || []).map((fact, index) => ({
      candidateId: `fact-${index + 1}`,
      operation: fact.operation || 'upsert',
      factId: fact.factId,
      value: fact.value,
      certainty: fact.certainty || 'exact',
      evidenceText: 'scenario evidence',
      correctionTarget: fact.correctionTarget || ''
    })),
    positions: (shorthand.positions || []).map((position, index) => ({
      candidateId: `position-${index + 1}`,
      operation: position.operation || 'upsert',
      kind: position.kind,
      label: position.label || '',
      entityId: position.entityId || '',
      linkedEntityId: position.linkedEntityId || '',
      amount: position.amount || null,
      country: '',
      owner: position.owner || null,
      propertyUse: position.propertyUse || null,
      pensionType: position.pensionType || null,
      agricultural: null,
      certainty: position.certainty || 'exact',
      evidenceText: 'scenario evidence',
      correctionTarget: ''
    })),
    sectionCompletions: shorthand.sectionCompletions || [],
    invalidCandidates: [],
    clientQuestion: shorthand.clientQuestion
      || { present: false, intent: 'none', topic: '', questionText: '' },
    ambiguities: shorthand.ambiguities || [],
    narrativeSummary: shorthand.narrativeSummary || { summary: '', evidence: [] }
  };
}

export function createScriptedClient({ plannerFails = false } = {}) {
  return {
    id: 'scripted',
    async nextMessage({ scenario, turnIndex }) {
      return scenario.turns[turnIndex]?.say ?? null;
    },
    async extractionFor({ scenario, turnIndex, sourceTurnId }) {
      if (plannerFails) {
        throw new ConsumerError(502, 'realtime_planner_request_failed', 'simulated provider outage');
      }
      return toPlannerExtraction(sourceTurnId, scenario.turns[turnIndex]?.extraction || {});
    }
  };
}
