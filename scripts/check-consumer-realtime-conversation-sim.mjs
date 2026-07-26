// Offline conversation simulator.
//
// The paid live probe (run-consumer-realtime-conversation-probe.mjs) is the only
// harness that currently exercises conversational behaviour, so a routing defect
// is invisible until someone pays to replay a call. This simulator closes that
// gap: it replays scripted planner extractions through the *real* fact gate,
// goal routing, module readiness and question-composition path with no network
// and no API key, and asserts on the questions the meeting would actually ask.
//
// It deliberately starts downstream of the model. Whether the planner *emits*
// a given fact is a prompt question that only the live probe can answer; whether
// the pipeline then does something sensible with it is decided entirely by code,
// and that is what this file protects.
//
// It drives the PRODUCTION shared turn service — worker/src/consumer/planning_facts.js
// and planning_context.js — not a local copy of it. It previously hand-mirrored
// the Durable Object's candidate mapping, fact gate and brief-context reshaping,
// with the source line numbers written into comments; every one of those line
// references had already drifted, and the fact gate it described had moved. A
// harness that re-implements the thing it is testing eventually tests nothing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MODULE_IDS,
  createHouseholdProfile,
  normalizeHouseholdProfile
} from '../js/planning/index.js';
import { describeConversationState } from '../worker/src/consumer/conversation.js';
import { composeMeetingBrief } from '../worker/src/consumer/realtime_planner.js';
import {
  mapPlannerExtractionToCandidates,
  planFactProposal
} from '../worker/src/consumer/planning_facts.js';
import { buildPlanningStateSlice } from '../worker/src/consumer/planning_context.js';

const NOW = '2026-07-25T09:00:00.000Z';
const ALL_RELEASED_FOR_TEST = Object.values(MODULE_IDS);
// A deterministic 32-byte base64url key. The simulator only needs the brief to
// sign; it never leaves the process.
const TEST_HASH_KEY = 'c2ltdWxhdG9yLXRlc3Qta2V5LTMyLWJ5dGVzLW9rMDA';
const ENV = { CONSUMER_RATE_LIMIT_HASH_KEY: TEST_HASH_KEY };
const CONFIG = Object.freeze({
  goalRoutingEnabled: true,
  moduleRoutingEnabled: true,
  allowedModules: ALL_RELEASED_FOR_TEST,
  realtimeSpokenCompletionEnabled: false,
  // The scenarios model the conversational v2 meeting, which is the shipped
  // canary path. The module-relevance fact gate is disabled under v2; that
  // decision now lives in planFactProposal rather than being mirrored here.
  realtimeConversationV2Enabled: true
});

const datasetPath = fileURLToPath(new URL('./fixtures/consumer-realtime-scenarios.json', import.meta.url));
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
assert.equal(dataset.schemaVersion, 'consumer-realtime-scenario-dataset-v1');
assert.ok(Array.isArray(dataset.scenarios) && dataset.scenarios.length > 0);
assert.equal(
  new Set(dataset.scenarios.map((item) => item.id)).size,
  dataset.scenarios.length,
  'Scenario ids must be unique.'
);

function emptyProfile(profileId) {
  return normalizeHouseholdProfile({
    ...createHouseholdProfile({
      profileId,
      nowIso: NOW,
      calculationDateIso: NOW.slice(0, 10)
    }),
    revision: 1
  });
}

function parseMoney(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return Number.isFinite(parsed?.amount) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Reshape a scripted fixture extraction into the PlannerExtractionV3 shape the
 * production planner emits. This is fixture plumbing, not planning logic: the
 * mapping from an extraction to profile candidates belongs to the production
 * `mapPlannerExtractionToCandidates` and is called, not copied.
 */
function toPlannerExtraction(extraction = {}, sourceTurnId) {
  return {
    sourceTurnId,
    goalCandidates: (extraction.goalCandidates || []).map((goal, index) => ({
      candidateId: `goal-${index + 1}`,
      goalType: goal.type || goal.goalType,
      confidence: goal.confidence || 'high',
      priorityHint: goal.priorityHint || 'unspecified',
      evidenceText: goal.evidenceText || 'fixture',
      correctionTarget: goal.correctionTarget || ''
    })),
    semanticFacts: (extraction.semanticFacts || []).map((fact, index) => ({
      candidateId: `fact-${index + 1}`,
      operation: fact.operation || 'upsert',
      factId: fact.factId,
      value: fact.value,
      certainty: fact.certainty || 'exact',
      evidenceText: fact.evidenceText || 'fixture',
      correctionTarget: fact.correctionTarget || ''
    })),
    positions: (extraction.positions || []).map((position, index) => ({
      candidateId: `position-${index + 1}`,
      operation: position.operation || 'upsert',
      kind: position.kind,
      label: position.label || '',
      entityId: position.entityId || '',
      linkedEntityId: position.linkedEntityId || '',
      amount: parseMoney(position.amountJson),
      country: position.country || '',
      owner: position.owner || null,
      propertyUse: position.propertyUse || null,
      pensionType: position.pensionType || null,
      agricultural: null,
      certainty: position.certainty || 'exact',
      evidenceText: position.evidenceText || 'fixture',
      correctionTarget: position.correctionTarget || ''
    })),
    sectionCompletions: (extraction.sectionCompletions || []).map((item) => ({
      section: item.section,
      signal: item.signal,
      evidenceText: item.evidenceText || 'fixture'
    })),
    invalidCandidates: [],
    clientQuestion: { present: false, intent: 'none', topic: '', questionText: '' },
    ambiguities: [],
    narrativeSummary: { summary: '', evidence: [] }
  };
}

/**
 * Replay one scenario. Returns every question the meeting would have asked,
 * plus the facts the gate refused, so a dropped routing signal is visible
 * rather than silent.
 */
async function runScenario(scenario) {
  let profile = emptyProfile(`sim-${scenario.id}`);
  const askedPrompts = [];
  const rejectedFacts = [];
  const queuedFactIds = new Set();
  let state = describeConversationState(profile, CONFIG);

  for (const turn of scenario.turns) {
    const sourceTurnId = `sim-${scenario.id}-${turn.label}`;
    const extraction = toPlannerExtraction(turn.extraction, sourceTurnId);

    // The production planner batch proposes one candidate at a time against a
    // freshly reloaded profile. Both the mapping and the per-candidate gate are
    // the shipped implementations.
    for (const candidate of mapPlannerExtractionToCandidates(extraction)) {
      const currentState = describeConversationState(profile, CONFIG);
      try {
        profile = planFactProposal({
          config: CONFIG,
          profile,
          state: currentState,
          fact: {
            factId: candidate.factId,
            value: candidate.value,
            certainty: candidate.certainty
          },
          plannerBatch: true
        }).profile;
      } catch (error) {
        rejectedFacts.push({
          turn: turn.label,
          factId: candidate.factId,
          value: candidate.value,
          error: error?.code || error?.message
        });
      }
    }

    state = describeConversationState(profile, CONFIG);
    const brief = await composeMeetingBrief({
      env: ENV,
      context: {
        // The production state projection, called rather than mirrored.
        state: buildPlanningStateSlice({
          state,
          profile,
          sessionRow: { current_profile_revision: profile.revision },
          config: CONFIG
        }),
        profile,
        config: CONFIG,
        sessionRow: { current_profile_revision: profile.revision }
      },
      extraction: {},
      sourceTurnId
    });
    if (brief.questionBatch?.prompt) {
      askedPrompts.push({
        turn: turn.label,
        prompt: brief.questionBatch.prompt,
        factId: brief.questionBatch.primaryFact?.factId || null
      });
    }
    // `stillNeeded` is the queue of facts this meeting intends to ask for. It is
    // the honest target for a "never ask this" assertion: checking only the
    // current turn's prompt would pass a scenario that asks the forbidden
    // question three turns later.
    for (const missing of brief.stillNeeded || []) {
      queuedFactIds.add(missing.factId);
    }
  }

  return {
    profile,
    state,
    askedPrompts,
    queuedFactIds: [...queuedFactIds],
    rejectedFacts,
    moduleIds: state.moduleSlots.map((slot) => slot.moduleId)
  };
}

const failures = [];

for (const scenario of dataset.scenarios) {
  const result = await runScenario(scenario);
  const expected = scenario.expected || {};

  for (const factId of expected.mustNeverAskFactIds || []) {
    if (result.queuedFactIds.includes(factId)) {
      failures.push(`[${scenario.id}] queued a forbidden fact for this client: ${factId}`);
    }
  }

  // The meeting must open on the analysis the client's own goal selected. This
  // is the assertion that "do you own your home?" to a pension enquiry fails.
  if (expected.mustAskFirstFactId) {
    const first = result.askedPrompts[0];
    if (!first || first.factId !== expected.mustAskFirstFactId) {
      failures.push(
        `[${scenario.id}] expected the meeting to open on ${expected.mustAskFirstFactId}, `
        + `got ${first?.factId || 'no question'}${first ? `\n    "${first.prompt}"` : ''}`
      );
    }
  }

  for (const pattern of expected.mustNeverAsk || []) {
    const regex = new RegExp(pattern, 'i');
    const offending = result.askedPrompts.find((item) => regex.test(item.prompt));
    if (offending) {
      failures.push(
        `[${scenario.id}] asked a forbidden question matching /${pattern}/i\n`
        + `    turn "${offending.turn}": ${offending.prompt}`
      );
    }
  }

  if (Array.isArray(expected.expectedModuleIds)) {
    for (const moduleId of expected.expectedModuleIds) {
      if (!result.moduleIds.includes(moduleId)) {
        failures.push(`[${scenario.id}] expected module ${moduleId}, got [${result.moduleIds.join(', ')}]`);
      }
    }
  }
  for (const moduleId of expected.forbiddenModuleIds || []) {
    if (result.moduleIds.includes(moduleId)) {
      failures.push(`[${scenario.id}] module ${moduleId} must not be selected, got [${result.moduleIds.join(', ')}]`);
    }
  }

  const droppedRouting = result.rejectedFacts.filter((item) => (
    ['person_current_age', 'property_status', 'life_stage', 'career_stage',
      'household_structure', 'dependant_count', 'has_pension', 'employment_context',
      'retirement_status'].includes(item.factId)
  ));
  if (droppedRouting.length > 0) {
    failures.push(
      `[${scenario.id}] routing-context facts were discarded by the fact gate: `
      + droppedRouting.map((item) => `${item.factId}=${JSON.stringify(item.value)}`).join(', ')
    );
  }

  console.info(`[ConversationSim] ${scenario.id}`);
  console.info(`    modules: [${result.moduleIds.join(', ') || 'none'}]`);
  for (const asked of result.askedPrompts) {
    console.info(`    asked (${asked.turn}): ${asked.prompt}`);
  }
  console.info(`    queued: [${result.queuedFactIds.join(', ') || 'none'}]`);
  if (result.rejectedFacts.length > 0) {
    console.info(`    dropped: ${result.rejectedFacts.map((item) => item.factId).join(', ')}`);
  }
}

if (failures.length > 0) {
  console.error(`\n[ConversationSim] ${failures.length} failure(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.info(`\n[ConversationSim] ${dataset.scenarios.length} scenarios passed.`);
}
