import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  applyProfilePatch,
  createHouseholdProfile,
  extractRulesOnlyProfilePatch,
  getPlanningModuleDefinition,
  getSemanticFactDefinition,
  recommendModules
} from '../js/planning/index.js';
import { readJsonPointer } from '../js/planning/utils.js';

const fixtureUrl = new URL('./fixtures/consumer-routing-golden.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const REQUIRED_COVERAGE = Object.freeze([
  'first_home',
  'retirement',
  'mortgage',
  'college',
  'multi_goal',
  'corrections',
  'unknown_figures',
  'unsupported_adviser_only'
]);

function releaseGate(definition) {
  if (definition.consumerAvailable) return 'consumer_enabled';
  if (definition.status === 'adviser_only') return 'adviser_only';
  return 'consumer_gated';
}

function nextTurnTime(index) {
  return `2026-07-14T10:${String(index + 1).padStart(2, '0')}:00.000Z`;
}

function applyConversation(testCase) {
  let profile = createHouseholdProfile({
    profileId: `golden-${testCase.id}`,
    nowIso: fixture.capturedAt,
    calculationDateIso: fixture.calculationDateIso
  });
  testCase.turns.forEach((message, index) => {
    const extraction = extractRulesOnlyProfilePatch(message, {
      profile,
      capturedAt: fixture.capturedAt,
      conversationTurnId: `${testCase.id}-turn-${index + 1}`
    });
    assert.match(extraction.extractionVersion, /^rules-extraction-/);
    profile = applyProfilePatch(profile, extraction.patch, { nowIso: nextTurnTime(index) }).profile;
  });
  return profile;
}

function assertModules(testCase, profile) {
  const first = recommendModules(profile);
  const second = recommendModules(profile);
  assert.deepEqual(second, first, `${testCase.id}: routing changed across identical evaluations`);
  assert.deepEqual(
    first.map((recommendation) => recommendation.moduleId),
    testCase.expected.modules.map((module) => module.moduleId),
    `${testCase.id}: routed module order`
  );
  first.forEach((recommendation, index) => {
    const expected = testCase.expected.modules[index];
    const definition = getPlanningModuleDefinition(recommendation.moduleId);
    assert.ok(definition, `${testCase.id}: missing definition for ${recommendation.moduleId}`);
    assert.equal(recommendation.source, 'deterministic_rule', `${testCase.id}: non-deterministic route source`);
    assert.equal(recommendation.status, expected.selectionStatus, `${testCase.id}: selection status`);
    assert.ok(
      recommendation.triggeredRuleIds.includes(expected.routeRuleId),
      `${testCase.id}: missing route rule ${expected.routeRuleId}`
    );
    assert.equal(recommendation.readiness.status, expected.readinessStatus, `${testCase.id}: readiness status`);
    assert.equal(definition.status, expected.releaseStatus, `${testCase.id}: release status`);
    assert.equal(definition.consumerAvailable, expected.consumerAvailable, `${testCase.id}: consumer gate`);
    assert.equal(releaseGate(definition), expected.releaseGate, `${testCase.id}: derived release gate`);
  });
}

function assertProfileExpectations(testCase, profile) {
  assert.deepEqual(
    profile.goals.map((goal) => goal.type),
    testCase.expected.goalTypes,
    `${testCase.id}: canonical goals`
  );
  for (const [path, expected] of Object.entries(testCase.expected.profileValues || {})) {
    assert.deepEqual(readJsonPointer(profile, path), expected, `${testCase.id}: ${path}`);
  }
  for (const path of testCase.expected.absentProfilePaths || []) {
    assert.equal(readJsonPointer(profile, path), undefined, `${testCase.id}: invented ${path}`);
  }
}

assert.equal(fixture.fixtureVersion, 1);
assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0);
assert.equal(new Set(fixture.cases.map((testCase) => testCase.id)).size, fixture.cases.length, 'duplicate fixture ids');
const covered = new Set(fixture.cases.flatMap((testCase) => testCase.coverage || []));
REQUIRED_COVERAGE.forEach((coverage) => assert.ok(covered.has(coverage), `missing golden coverage: ${coverage}`));

const primaryGoal = getSemanticFactDefinition('primary_goal');
assert.deepEqual({
  factId: primaryGoal.factId,
  valueType: primaryGoal.valueType,
  profilePathTemplate: primaryGoal.profilePathTemplate,
  sensitivity: primaryGoal.sensitivity,
  confirmationPolicy: primaryGoal.confirmationPolicy
}, {
  factId: 'primary_goal',
  valueType: 'entity',
  profilePathTemplate: '/goals',
  sensitivity: 'normal',
  confirmationPolicy: 'final_review'
});

for (const testCase of fixture.cases) {
  const profile = applyConversation(testCase);
  assert.equal(profile.revision, testCase.turns.length, `${testCase.id}: one atomic revision per turn`);
  assertProfileExpectations(testCase, profile);
  assertModules(testCase, profile);
  console.info(`[ConsumerRoutingGolden] PASS: ${testCase.id}`);
}

console.info(`[ConsumerRoutingGolden] ${fixture.cases.length}/${fixture.cases.length} golden conversations passed.`);
