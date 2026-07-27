// Focused planner integration probe.
//
// Isolates WHY `extractRealtimePlannerTurn` fails, using the same model,
// endpoint, instructions, response schema and production-like configuration as
// the live meeting, against one fixed utterance.
//
// It distinguishes the four failure classes the incident report asked for:
//
//   1. PROVIDER REQUEST FAILURE — non-2xx from /v1/responses. Reports the HTTP
//      status and the provider's own error type/code/param and request id.
//   2. PROVIDER RESPONSE-SCHEMA FAILURE — 2xx but status != completed, or a
//      refusal, or no structured output. Reports the incomplete reason and the
//      output/reasoning token counts, which is how a reasoning model signals it
//      ran out of budget rather than erroring.
//   3. LOCAL PARSING/VALIDATION FAILURE — the response arrived but
//      validatePlannerExtraction rejected it.
//   4. PERSISTENCE FAILURE AFTER SUCCESSFUL EXTRACTION — the extraction was
//      valid but applying its candidates failed.
//
// Diagnostics are categorical and bounded. The utterance is fixed and
// synthetic; no conversation content is recorded beyond the extracted
// structure, which is what is under test.
//
//   OPENAI_API_KEY=... node ./scripts/run-consumer-planner-probe.mjs
//
// Without a key it prints the exact request it WOULD send and exits 0, so the
// request shape can be reviewed without spending anything.

import assert from 'node:assert/strict';

import { MODULE_IDS, createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/index.js';
import { getConsumerConfig, PLANNER_MODEL_ALLOWLIST } from '../worker/src/consumer/config.js';
import { describeConversationState } from '../worker/src/consumer/conversation.js';
import { extractRealtimePlannerTurn } from '../worker/src/consumer/realtime_planner.js';
import { buildPlanningStateSlice } from '../worker/src/consumer/planning_context.js';
import { mapPlannerExtractionToCandidates, planFactProposal } from '../worker/src/consumer/planning_facts.js';

function plannerRequestBodyWithoutComments(source) {
  const body = source.slice(
    source.indexOf('body: JSON.stringify({'),
    source.indexOf('signal: controller.signal')
  );
  // Strip comments: the code explains WHY there is no cap, and that explanation
  // must not itself trip the check.
  return body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const UTTERANCE = "I'm 25 and my main goal is to buy a house in about five years.";
const NOW = '2026-07-25T09:00:00.000Z';

// Production-like: the exact adviser-canary allowlist and flags.
const env = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  CONSUMER_DB: {},
  CONSUMER_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 31).toString('base64url'),
  CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url'),
  CONSUMER_JOURNEY_ENABLED: 'true',
  CONSUMER_MODULE_ROUTING_ENABLED: 'true',
  CONSUMER_GOAL_ROUTING_ENABLED: 'true',
  CONSUMER_ALLOWED_MODULE_IDS: 'house_purchase,liquidity_analysis',
  CONSUMER_COHORT: 'adviser_test',
  CONSUMER_CONSENT_POLICY_VERSION: 'consumer-adviser-test-v1',
  CONSUMER_CONSENT_MANIFEST_ID: 'consumer-adviser-test-manifest-v1',
  CONSUMER_ANALYSIS_NOTICE_ID: 'analysis-adviser-test-v1',
  CONSUMER_AI_NOTICE_ID: 'ai-adviser-test-v1',
  CONSUMER_PRIVACY_NOTICE_URL: 'https://planeir.ie/plan/privacy.html',
  CONSUMER_SESSION_TTL_DAYS: '7',
  ...(process.env.CONSUMER_REALTIME_PLANNER_MODEL
    ? { CONSUMER_REALTIME_PLANNER_MODEL: process.env.CONSUMER_REALTIME_PLANNER_MODEL }
    : {}),
};
const config = Object.freeze({ ...getConsumerConfig(env), realtimeConversationV2Enabled: true });

function freshProfile() {
  return normalizeHouseholdProfile({
    ...createHouseholdProfile({ profileId: 'planner-probe', nowIso: NOW, calculationDateIso: NOW.slice(0, 10) }),
    revision: 1
  });
}

function contextFor(profile) {
  const state = describeConversationState(profile, config);
  const sessionRow = { id: 'cs_planner_probe', current_profile_revision: profile.revision, confirmed_profile_revision: null };
  return {
    config,
    sessionRow,
    profile,
    state: buildPlanningStateSlice({ state, profile, sessionRow, config, channel: 'voice' })
  };
}

console.info('=== Planner configuration ===');
console.info(`  planner model      : ${config.realtimePlannerModel}`);
console.info(`  model approved     : ${config.realtimePlannerModelConfigured}`);
console.info(`  allowlist          : ${PLANNER_MODEL_ALLOWLIST.join(', ')}`);
console.info('  max output tokens  : (none — the model applies its native maximum)');
console.info(`  timeout ms         : ${config.realtimePlannerTimeoutMs}`);
console.info(`  prompt version     : ${config.realtimePlannerPromptVersion}`);
console.info(`  endpoint           : https://api.openai.com/v1/responses`);
console.info(`  allowed modules    : ${config.allowedModules.join(', ')}`);

// The planner model must be one the deployment approved, whatever the env says.
assert.ok(
  PLANNER_MODEL_ALLOWLIST.includes(config.realtimePlannerModel),
  'the resolved planner model must be on the server-side allowlist'
);
assert.equal(
  config.realtimePlannerMaxOutputTokens,
  undefined,
  'the planner must impose no application-level output-token cap'
);
{
  // Read the request the planner actually builds, not a copy of it.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../worker/src/consumer/realtime_planner.js', import.meta.url), 'utf8');
  assert.ok(
    !plannerRequestBodyWithoutComments(source).includes('max_output_tokens'),
    'the outgoing planner request must omit max_output_tokens entirely'
  );
}
if (!config.realtimePlannerModelConfigured) {
  console.warn('  WARNING: CONSUMER_REALTIME_PLANNER_MODEL was not an approved value; '
    + `falling back to ${config.realtimePlannerModel}.`);
}

if (!env.OPENAI_API_KEY) {
  console.info('\n=== DRY RUN (no OPENAI_API_KEY) ===');
  console.info('  Request shape that would be sent:');
  console.info(JSON.stringify({
    model: config.realtimePlannerModel,
    store: false,
    reasoning: { effort: 'low' },
    text: { format: { type: 'json_schema', name: 'planner_extraction_v3', strict: true, schema: '<PLANNER_SCHEMA>' } }
  }, null, 2).split('\n').map((line) => `    ${line}`).join('\n'));
  console.info(`\n  Utterance: "${UTTERANCE}"`);
  console.info('\n  Set OPENAI_API_KEY to run the live probe.');
  process.exit(0);
}

console.info(`\n=== Live probe ===\n  Utterance: "${UTTERANCE}"`);

const profile = freshProfile();
const context = contextFor(profile);
let extraction = null;

// -- Classes 1-3: the planner call itself -----------------------------------
try {
  const planned = await extractRealtimePlannerTurn({
    env,
    config,
    context,
    sourceTurnId: 'planner-probe-turn',
    transcript: UTTERANCE,
    recentTurns: []
  });
  extraction = planned.extraction;
  console.info('\n  [1-3] PLANNER CALL: ok');
  console.info(`        model=${planned.metadata.model} latencyMs=${planned.metadata.latencyMs}`);
  console.info(`        tokens in=${planned.metadata.inputTokens} out=${planned.metadata.outputTokens} cached=${planned.metadata.cachedInputTokens}`);
  console.info(`        providerRequestId=${planned.metadata.providerRequestId}`);
} catch (error) {
  const code = error?.code || 'unknown';
  const klass = code === 'realtime_planner_request_failed'
    ? '1 PROVIDER REQUEST FAILURE'
    : ['realtime_planner_response_incomplete', 'realtime_planner_refused', 'realtime_planner_output_missing'].includes(code)
      ? '2 PROVIDER RESPONSE-SCHEMA FAILURE'
      : ['realtime_planner_output_invalid', 'realtime_planner_response_invalid'].includes(code)
        ? '3 LOCAL PARSING/VALIDATION FAILURE'
        : code === 'realtime_planner_timeout'
          ? '1 PROVIDER REQUEST FAILURE (timeout)'
          : 'UNCLASSIFIED';
  console.error(`\n  *** FAILURE CLASS ${klass} ***`);
  console.error(`      code       : ${code}`);
  for (const [key, value] of Object.entries(error?.metadata || {})) {
    if (value !== null && value !== undefined) console.error(`      ${key.padEnd(11)}: ${value}`);
  }
  console.error('\n  The planner did NOT return a usable extraction. Fix this before the live call.');
  process.exit(1);
}

// -- Extraction content ------------------------------------------------------
const goals = extraction.goalCandidates.map((goal) => goal.goalType);
const facts = extraction.semanticFacts.map((fact) => `${fact.factId}=${JSON.stringify(fact.value)}`);
console.info(`\n  Extraction: goals=[${goals.join(', ')}] facts=[${facts.join(', ')}]`);
console.info(`              priorityHints=[${extraction.goalCandidates.map((g) => g.priorityHint).join(', ')}]`);

assert.ok(goals.includes('buy_home'), `the planner must extract buy_home, got [${goals.join(', ')}]`);
// The planner may wrap a value ({"age":25}) or send it bare (25); the shared
// fact mapper owns which shapes are accepted. Assert the fact was EXTRACTED
// here, and let candidate application below decide whether it maps.
assert.ok(
  extraction.semanticFacts.some((fact) => fact.factId === 'person_current_age'),
  `the planner must extract person_current_age, got [${facts.join(', ')}]`
);

// -- Class 4: applying what was extracted ------------------------------------
let working = profile;
const outcomes = [];
for (const candidate of mapPlannerExtractionToCandidates(extraction)) {
  try {
    working = planFactProposal({
      config,
      profile: working,
      state: describeConversationState(working, config),
      fact: { factId: candidate.factId, value: candidate.value, certainty: candidate.certainty },
      plannerBatch: true
    }).profile;
    outcomes.push({ factId: candidate.factId, accepted: true });
  } catch (error) {
    outcomes.push({ factId: candidate.factId, accepted: false, code: error?.code || 'unknown' });
  }
}
console.info('\n  [4] CANDIDATE APPLICATION:');
for (const outcome of outcomes) {
  console.info(`      ${outcome.accepted ? 'ACCEPT' : 'REJECT'}  ${String(outcome.factId).padEnd(30)} ${outcome.code || ''}`);
}

assert.ok(working.goals.some((goal) => goal.type === 'buy_home'), 'buy_home must persist');
assert.equal(working.primaryPerson.age, 25, 'age 25 must persist');

const finalState = describeConversationState(working, config);
console.info(`\n  Persisted goals   : ${working.goals.map((g) => g.type).join(', ')}`);
console.info(`  Persisted age     : ${working.primaryPerson.age}`);
console.info(`  Primary goal      : ${working.assumptions.values.planning.primaryGoalType ?? '(none stated)'}`);
console.info(`  Selected analyses : ${finalState.moduleSlots.map((s) => s.moduleId).join(', ') || 'none'}`);
console.info(`  Next question     : ${finalState.nextQuestion?.prompt ?? '(none)'}`);

assert.ok(finalState.nextQuestion?.prompt, 'the meeting must have a next question to ask');
assert.ok(
  !/repeat|restate|rephrase|different words/i.test(finalState.nextQuestion.prompt),
  'the meeting must not ask the client to restate a valid goal'
);
assert.ok(
  MODULE_IDS.HOUSE_PURCHASE && finalState.moduleSlots.some((slot) => slot.moduleId === MODULE_IDS.HOUSE_PURCHASE),
  'the home-purchase analysis must be selected'
);

console.info('\n=== PLANNER PROBE PASSED ===');
console.info('  The normal AI planner extracted, persisted and advanced. The deterministic');
console.info('  fallback was not involved.');
