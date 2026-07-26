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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MODULE_IDS,
  buildGoalModulePlan,
  createHouseholdProfile,
  normalizeHouseholdProfile,
  resolveSemanticFact
} from '../js/planning/index.js';
import { describeConversationState } from '../worker/src/consumer/conversation.js';
import {
  mapRealtimeFact,
  realtimeFactAllowed
} from '../worker/src/consumer/realtime_fact_mapper.js';
import {
  composeMeetingBrief,
  positionCandidatesToRealtimeFacts
} from '../worker/src/consumer/realtime_planner.js';
import { applyProfilePatch } from '../worker/src/consumer/validators.js';

const NOW = '2026-07-25T09:00:00.000Z';
const ALL_RELEASED_FOR_TEST = Object.values(MODULE_IDS);
// A deterministic 32-byte base64url key. The simulator only needs the brief to
// sign; it never leaves the process.
const TEST_HASH_KEY = 'c2ltdWxhdG9yLXRlc3Qta2V5LTMyLWJ5dGVzLW9rMDA';
const ENV = { CONSUMER_RATE_LIMIT_HASH_KEY: TEST_HASH_KEY };
const CONFIG = {
  goalRoutingEnabled: true,
  moduleRoutingEnabled: true,
  allowedModules: ALL_RELEASED_FOR_TEST,
  realtimeSpokenCompletionEnabled: false,
  // The scenarios model the conversational v2 meeting, which is the shipped
  // canary path.
  realtimeConversationV2Enabled: true
};
// realtime_session.js:2955 applies the module-relevance gate only when v2 is
// off (`!realtimeFactAllowed(...) && !realtimeConversationV2Enabled`). The
// simulator must mirror that exactly, or it reports drops that production never
// performs.
const FACT_GATE_APPLIES = CONFIG.realtimeConversationV2Enabled !== true;

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

/** Convert a scripted extraction into the realtime fact list the planner emits. */
function extractionToFacts(extraction = {}) {
  const positionCandidates = (extraction.positions || []).map((position, index) => ({
    candidateId: `${position.kind}-${index}`,
    kind: position.kind,
    label: position.label,
    owner: position.owner,
    propertyUse: position.propertyUse,
    pensionType: position.pensionType,
    linkedEntityId: position.linkedEntityId,
    operation: position.operation,
    certainty: position.certainty || 'exact',
    evidenceText: position.evidenceText || '',
    amount: parseMoney(position.amountJson)
  }));
  return [
    ...(extraction.goalCandidates || []).map((goal) => ({
      factId: 'primary_goal',
      value: { type: goal.type },
      certainty: 'exact'
    })),
    ...(extraction.semanticFacts || []).map((fact) => ({
      factId: fact.factId,
      value: fact.value,
      certainty: fact.certainty || 'exact'
    })),
    ...positionCandidatesToRealtimeFacts(positionCandidates)
  ];
}

function enabledModuleIds(profile) {
  return new Set(
    buildGoalModulePlan(profile, { allowedModuleIds: ALL_RELEASED_FOR_TEST })
      .moduleSlots.map((slot) => slot.moduleId)
  );
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
    const enabled = enabledModuleIds(profile);
    for (const fact of extractionToFacts(turn.extraction)) {
      if (FACT_GATE_APPLIES && !realtimeFactAllowed(fact.factId, enabled)) {
        rejectedFacts.push({ turn: turn.label, factId: fact.factId, value: fact.value });
        continue;
      }
      let mapped;
      try {
        mapped = mapRealtimeFact(profile, fact);
      } catch (error) {
        rejectedFacts.push({
          turn: turn.label,
          factId: fact.factId,
          value: fact.value,
          error: error?.code || error?.message
        });
        continue;
      }
      profile = applyProfilePatch(
        profile,
        { [mapped.fieldPath]: mapped.canonicalValue, ...(mapped.additionalPatch || {}) },
        [],
        'consumer_realtime',
        mapped.removePaths || []
      );
    }

    state = describeConversationState(profile, CONFIG);
    const brief = await composeMeetingBrief({
      env: ENV,
      context: {
        state: {
          ...state,
          profileRevision: profile.revision,
          facts: [],
          // Mirror the reshaping the Durable Object performs before it composes
          // a brief (realtime_session.js:2346) — the planner reads a flattened
          // `requiredMissing`, not the nested readiness object.
          recommendations: (state.recommendations || []).map((item) => ({
            moduleId: item.moduleId,
            status: item.readiness?.status || item.status || 'unknown',
            assumptionsUsed: item.readiness?.assumptionsUsed || [],
            requiredMissing: (item.readiness?.requiredMissing || []).map((missing) => {
              const semantic = resolveSemanticFact(missing, { profile, moduleId: item.moduleId });
              return {
                factId: semantic.factId,
                factInstanceId: semantic.factInstanceId,
                importance: missing.importance,
                reason: typeof missing.reason === 'string' ? missing.reason.slice(0, 240) : ''
              };
            })
          }))
        },
        profile,
        config: CONFIG,
        sessionRow: { current_profile_revision: profile.revision }
      },
      extraction: {},
      sourceTurnId: `sim-${scenario.id}-${turn.label}`
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
  const transcript = result.askedPrompts.map((item) => item.prompt).join('\n');

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
  void transcript;
}

if (failures.length > 0) {
  console.error(`\n[ConversationSim] ${failures.length} failure(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.info(`\n[ConversationSim] ${dataset.scenarios.length} scenarios passed.`);
}
