// Golden characterisation of the consumer planning turn.
//
// This is a SAFETY NET for the A0/A1 extraction described in
// docs/agent-testing-environment-plan.md. It replays every recorded scenario
// through the production planning pipeline and snapshots the complete resulting
// planning state — goals, facts, module slots, opportunities, capacity, the
// execution set, and every client-facing field of the signed meeting brief.
//
// The golden file is generated from the pre-extraction code path. After the
// shared turn service is extracted, this harness is re-pointed at the extracted
// service and the golden must still match BYTE FOR BYTE. That is the proof the
// extraction was a faithful move rather than a rewrite.
//
// It never touches the network, needs no API key, and does not use D1: it
// exercises the pure planning core plus the pure fact-proposal core, which is
// exactly the surface the extraction is allowed to move.
//
//   node ./scripts/check-consumer-turn-characterisation.mjs            verify
//   node ./scripts/check-consumer-turn-characterisation.mjs --update   regenerate

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MODULE_IDS,
  buildGoalModulePlan,
  createHouseholdProfile,
  normalizeHouseholdProfile,
  resolveSemanticFact
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
const TEST_HASH_KEY = 'c2ltdWxhdG9yLXRlc3Qta2V5LTMyLWJ5dGVzLW9rMDA';
const ENV = { CONSUMER_RATE_LIMIT_HASH_KEY: TEST_HASH_KEY };
const CONFIG = Object.freeze({
  goalRoutingEnabled: true,
  moduleRoutingEnabled: true,
  allowedModules: ALL_RELEASED_FOR_TEST,
  realtimeSpokenCompletionEnabled: false,
  realtimeConversationV2Enabled: true
});

const scenarioPath = fileURLToPath(new URL('./fixtures/consumer-realtime-scenarios.json', import.meta.url));
const goldenPath = fileURLToPath(new URL('./fixtures/consumer-turn-characterisation.json', import.meta.url));
const update = process.argv.includes('--update');

const dataset = JSON.parse(readFileSync(scenarioPath, 'utf8'));
assert.equal(dataset.schemaVersion, 'consumer-realtime-scenario-dataset-v1');

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
 * production planner emits, so the candidate mapping under test is the real one.
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

/** Snapshot only stable, meaning-bearing fields. Timestamps and signatures are excluded. */
function snapshotTurn(profile, state, plan, brief) {
  return {
    profileRevision: profile.revision,
    stage: state.stage,
    goals: profile.goals.map((goal) => ({
      type: goal.type,
      priority: goal.priority,
      status: goal.status
    })),
    goalAssessment: {
      primaryGoalType: state.goalAssessment?.primaryGoalType ?? null,
      activeGoalTypes: [...(state.goalAssessment?.activeGoalTypes || [])],
      deferredGoalTypes: [...(state.goalAssessment?.deferredGoalTypes || [])],
      confidence: state.goalAssessment?.confidence ?? null
    },
    requiresGoalPriorityQuestion: state.requiresGoalPriorityQuestion === true,
    requiresDecisionTopicQuestion: state.requiresDecisionTopicQuestion === true,
    nextQuestion: {
      factId: state.nextQuestion?.factId ?? null,
      prompt: state.nextQuestion?.prompt ?? null
    },
    moduleSlots: (state.moduleSlots || []).map((slot) => ({
      slot: slot.slot,
      moduleId: slot.moduleId,
      source: slot.source,
      selectionState: slot.selectionState,
      availability: slot.availability,
      intakeStatus: slot.intakeStatus,
      relatedGoalTypes: [...(slot.relatedGoalTypes || [])],
      missingFactIds: [...(slot.missingFactIds || [])]
    })),
    moduleOpportunities: (state.moduleOpportunities || []).map((item) => ({
      moduleId: item.moduleId,
      state: item.state,
      supportingFactIds: [...(item.supportingFactIds || [])]
    })),
    capacity: {
      maximumAnalyses: state.capacity?.maximumAnalyses ?? null,
      used: state.capacity?.used ?? null,
      atLimit: state.capacity?.atLimit === true,
      overflowModuleIds: [...(state.capacity?.overflowModuleIds || [])],
      replaceableModuleIds: [...(state.capacity?.replaceableModuleIds || [])]
    },
    // The deterministic execution rule. D15 pins this; it must never drift.
    executionModuleIds: [...(plan.executionModuleIds || [])],
    withheldOpportunityModuleIds: (plan.withheldOpportunities || []).map((item) => item.moduleId),
    brief: {
      phase: brief.phase,
      currentTopic: brief.currentTopic,
      provisional: brief.provisional,
      readyToConfirm: brief.readyToConfirm,
      moduleState: brief.moduleState,
      analyses: (brief.analyses || []).map((item) => ({
        slot: item.slot,
        moduleId: item.moduleId,
        label: item.label,
        status: item.status,
        intakeStatus: item.intakeStatus
      })),
      questionBatch: brief.questionBatch
        ? {
            topic: brief.questionBatch.topic,
            prompt: brief.questionBatch.prompt,
            primaryFactId: brief.questionBatch.primaryFact?.factId ?? null
          }
        : null,
      stillNeeded: (brief.stillNeeded || []).map((item) => item.factId),
      moduleOffer: brief.moduleOffer
        ? {
            moduleId: brief.moduleOffer.moduleId,
            anchor: brief.moduleOffer.anchor,
            spokenOffer: brief.moduleOffer.spokenOffer
          }
        : null,
      capacityDecision: brief.capacityDecision
        ? {
            candidateModuleId: brief.capacityDecision.candidateModuleId,
            currentModuleIds: [...brief.capacityDecision.currentModuleIds],
            spoken: brief.capacityDecision.spoken
          }
        : null,
      confirmationSummary: brief.confirmationSummary
    }
  };
}

async function runScenario(scenario) {
  let profile = emptyProfile(`char-${scenario.id}`);
  const turns = [];
  const rejections = [];

  for (const turn of scenario.turns) {
    const sourceTurnId = `char-${scenario.id}-${turn.label}`;
    const extraction = toPlannerExtraction(turn.extraction, sourceTurnId);
    const candidates = mapPlannerExtractionToCandidates(extraction);

    // The production planner batch proposes one candidate at a time against a
    // freshly reloaded profile. Mirror that exactly.
    for (const candidate of candidates) {
      const state = describeConversationState(profile, CONFIG);
      try {
        const result = planFactProposal({
          config: CONFIG,
          profile,
          state,
          fact: {
            factId: candidate.factId,
            value: candidate.value,
            certainty: candidate.certainty
          },
          plannerBatch: true
        });
        profile = result.profile;
      } catch (error) {
        rejections.push({
          turn: turn.label,
          candidateId: candidate.candidateId,
          factId: candidate.factId,
          code: error?.code || 'unknown'
        });
      }
    }

    const state = describeConversationState(profile, CONFIG);
    const plan = buildGoalModulePlan(profile, { allowedModuleIds: ALL_RELEASED_FOR_TEST });
    const brief = await composeMeetingBrief({
      env: ENV,
      context: {
        state: buildPlanningStateSlice({ state, profile, sessionRow: { current_profile_revision: profile.revision } }),
        profile,
        config: CONFIG,
        sessionRow: { current_profile_revision: profile.revision }
      },
      extraction: {},
      sourceTurnId
    });
    turns.push({
      label: turn.label,
      ...snapshotTurn(profile, state, plan, brief)
    });
  }

  return { id: scenario.id, turns, rejections };
}

const results = [];
for (const scenario of dataset.scenarios) {
  results.push(await runScenario(scenario));
}

// Every deliberate regeneration of the golden is recorded here. An entry is
// required: the whole point of a characterisation test is that behaviour cannot
// change silently.
const CHANGE_LOG = [
  {
    date: '2026-07-26',
    change: 'Baseline captured from the pre-extraction code path (A0).',
    fields: []
  },
  {
    date: '2026-07-26',
    change: 'D-03 fixed: assumptions.values.planning is now guaranteed by profile '
      + 'normalisation, so a client\'s stated primary goal (primary_goal_focus) '
      + 'persists instead of being rejected as invalid_profile_patch. Each scenario '
      + 'gains one profile revision because a fact that used to fail now saves. '
      + 'Goals, module slots, questions, capacity, execution set and every brief '
      + 'field are unchanged — these fixtures each state a single goal, so the '
      + 'stated focus and mention order agree.',
    fields: ['profileRevision', 'rejections']
  },
  {
    date: '2026-08-09',
    change: 'The pension intake question is now owner-scoped. It asked "in your own '
      + 'name", which is why a confirmed spouse\'s pension was never sought: the '
      + 'requirement knew whose pension was missing, but the spoken question threw '
      + 'that away and asked the primary client again. The prompt now comes from the '
      + 'owner-scoped need, and names buyout bond rather than AVC because a buyout '
      + 'bond is a distinct position the projection models and cannot be paid into. '
      + 'Only the pension prompt changes: unscoped questions keep their existing '
      + 'conversational wording, and nextQuestion still agrees with the brief.',
    fields: ['brief.questionBatch.prompt', 'nextQuestion.prompt']
  }
];

const snapshot = {
  schemaVersion: 'consumer-turn-characterisation-v1',
  note: 'Generated by scripts/check-consumer-turn-characterisation.mjs. Regenerate with --update ONLY when a behaviour change is intended, and add a changeLog entry saying what changed and why.',
  changeLog: CHANGE_LOG,
  scenarios: results
};

const serialised = `${JSON.stringify(snapshot, null, 2)}\n`;

if (update) {
  writeFileSync(goldenPath, serialised);
  console.info(`[Characterisation] golden written: ${results.length} scenarios, ${results.reduce((total, item) => total + item.turns.length, 0)} turns.`);
  process.exit(0);
}

let expected;
try {
  expected = readFileSync(goldenPath, 'utf8');
} catch (_error) {
  console.error('[Characterisation] no golden file. Generate it with --update first.');
  process.exit(1);
}

if (expected !== serialised) {
  const expectedParsed = JSON.parse(expected);
  const differences = [];
  for (const scenario of snapshot.scenarios) {
    const before = expectedParsed.scenarios.find((item) => item.id === scenario.id);
    if (!before) {
      differences.push(`[${scenario.id}] is new`);
      continue;
    }
    scenario.turns.forEach((turn, index) => {
      const previous = before.turns[index];
      if (!previous) {
        differences.push(`[${scenario.id}] turn ${turn.label} is new`);
        return;
      }
      for (const key of Object.keys(turn)) {
        const now = JSON.stringify(turn[key]);
        const then = JSON.stringify(previous[key]);
        if (now !== then) {
          differences.push(`[${scenario.id}/${turn.label}] ${key}\n      before: ${then}\n      after:  ${now}`);
        }
      }
    });
  }
  console.error(`\n[Characterisation] planning behaviour changed in ${differences.length} place(s):\n`);
  for (const difference of differences.slice(0, 40)) console.error(`  ${difference}`);
  if (differences.length > 40) console.error(`  … and ${differences.length - 40} more`);
  console.error('\nIf the change is intended, document it and re-run with --update.');
  process.exit(1);
}

console.info(`[Characterisation] ${results.length} scenarios, ${results.reduce((total, item) => total + item.turns.length, 0)} turns — planning behaviour unchanged.`);
