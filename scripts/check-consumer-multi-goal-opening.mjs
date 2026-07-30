// Regression: the multi-goal opening turn that produced a live clarification loop.
//
// INCIDENT. In a live realtime meeting the client opened with:
//
//   "I'm 25 and early in my career. I want to get a broader picture of my
//    financial position, and I'm hoping to buy a house in the future, so I want
//    to make sure I'm properly set up for that."
//
// The assistant repeatedly said it had not understood and asked for the point
// to be repeated. It never progressed past the opening.
//
// ROOT CAUSE. Stating two goals in one turn sets `requiresGoalPriorityQuestion`,
// which makes `describeConversationState` return empty `moduleSlots` and
// `recommendations`. `composeMeetingBrief` built `questionBatch` ONLY from the
// missing facts of routed analyses, so with none it emitted
// `questionBatch: null`. The conversational v2 phase guidance instructs the
// model to "ask exactly the single server-authored questionBatch.prompt" — with
// none, it had nothing to say and asked the client to repeat themselves, on
// every turn, forever. The deterministic clarification question existed the
// whole time in `state.nextQuestion`; it simply never reached the brief.
//
// This reproduces at commit 40ac8b8, before the A0/A1 extraction, so it is a
// pre-existing defect and not a regression from that work.
//
// The fixture runs under the EXACT production module allowlist, because that is
// what the live meeting was running.

import assert from 'node:assert/strict';

import {
  buildGoalModulePlan,
  createHouseholdProfile,
  normalizeHouseholdProfile
} from '../js/planning/index.js';
import { containsInternalModuleTerminology } from '../js/planning/module_offers.js';
import { describeConversationState } from '../worker/src/consumer/conversation.js';
import {
  composeMeetingBrief,
  isLikelyIncompleteRealtimeUtterance
} from '../worker/src/consumer/realtime_planner.js';
import { buildPlanningStateSlice } from '../worker/src/consumer/planning_context.js';
import {
  deterministicFallbackExtraction,
  mapPlannerExtractionToCandidates,
  planFactProposal
} from '../worker/src/consumer/planning_facts.js';

const NOW = '2026-07-25T09:00:00.000Z';
const ENV = { CONSUMER_RATE_LIMIT_HASH_KEY: 'c2ltdWxhdG9yLXRlc3Qta2V5LTMyLWJ5dGVzLW9rMDA' };

/** The exact allowlist the live adviser canary runs with. */
const PRODUCTION_ALLOWED_MODULES = ['house_purchase', 'liquidity_analysis'];
/** The full catalogue, for the same journey without the canary restriction. */
const ALL_MODULES = [
  'personal_balance_sheet', 'house_purchase', 'liquidity_analysis',
  'mortgage_analysis', 'pension_projection', 'college_funding', 'loan_analysis'
];

const UTTERANCE = "I'm 25 and early in my career. I want to get a broader picture of my "
  + "financial position, and I'm hoping to buy a house in the future, so I want to make "
  + "sure I'm properly set up for that.";

function configFor(allowedModules) {
  return Object.freeze({
    goalRoutingEnabled: true,
    moduleRoutingEnabled: true,
    allowedModules,
    realtimeSpokenCompletionEnabled: false,
    realtimeConversationV2Enabled: true,
    moduleOffersEnabled: false
  });
}

/** What a correct planner extraction of the reported utterance contains. */
const INCIDENT_EXTRACTION = {
  sourceTurnId: 'incident-opening-turn',
  goalCandidates: [
    {
      candidateId: 'goal-1', goalType: 'understand_position', confidence: 'high',
      priorityHint: 'unspecified', evidenceText: 'broader picture of my financial position',
      correctionTarget: ''
    },
    {
      candidateId: 'goal-2', goalType: 'buy_home', confidence: 'high',
      priorityHint: 'unspecified', evidenceText: 'hoping to buy a house in the future',
      correctionTarget: ''
    }
  ],
  semanticFacts: [
    {
      candidateId: 'fact-1', operation: 'upsert', factId: 'person_current_age',
      value: 25, certainty: 'exact', evidenceText: "I'm 25", correctionTarget: ''
    },
    {
      candidateId: 'fact-2', operation: 'upsert', factId: 'career_stage',
      value: 'early_career', certainty: 'approximate', evidenceText: 'early in my career',
      correctionTarget: ''
    }
  ],
  positions: [],
  sectionCompletions: [],
  invalidCandidates: [],
  clientQuestion: { present: false, intent: 'none', topic: '', questionText: '' },
  ambiguities: [],
  narrativeSummary: { summary: '', evidence: [] }
};

const passes = [];
function pass(message) {
  passes.push(message);
  console.info(`[MultiGoalOpening] PASS: ${message}`);
}

function freshProfile(id) {
  return normalizeHouseholdProfile({
    ...createHouseholdProfile({ profileId: id, nowIso: NOW, calculationDateIso: NOW.slice(0, 10) }),
    revision: 1
  });
}

function applyOpeningTurn(config, profileId) {
  let profile = freshProfile(profileId);
  const rejected = [];
  for (const candidate of mapPlannerExtractionToCandidates(INCIDENT_EXTRACTION)) {
    try {
      profile = planFactProposal({
        config,
        profile,
        state: describeConversationState(profile, config),
        fact: { factId: candidate.factId, value: candidate.value, certainty: candidate.certainty },
        plannerBatch: true
      }).profile;
    } catch (error) {
      rejected.push({ candidateId: candidate.candidateId, factId: candidate.factId, code: error?.code });
    }
  }
  return { profile, rejected };
}

async function briefFor(profile, config) {
  const state = describeConversationState(profile, config);
  const sessionRow = { current_profile_revision: profile.revision };
  return composeMeetingBrief({
    env: ENV,
    context: {
      state: buildPlanningStateSlice({ state, profile, sessionRow, config, channel: 'voice' }),
      profile,
      config,
      sessionRow
    },
    extraction: {},
    sourceTurnId: 'incident-opening-turn'
  });
}

/* ------------------------------------------------------------------ */

{
  // The turn is a complete statement. It must never be held back as a fragment.
  assert.equal(
    isLikelyIncompleteRealtimeUtterance(UTTERANCE),
    false,
    'the opening statement must not be classified as an incomplete utterance'
  );
  // Nor must any clause of it, if semantic VAD split the turn.
  for (const clause of [
    "I'm 25 and early in my career",
    'I want to get a broader picture of my financial position',
    "I'm hoping to buy a house in the future",
    "so I want to make sure I'm properly set up for that"
  ]) {
    assert.equal(
      isLikelyIncompleteRealtimeUtterance(clause),
      false,
      `a complete clause must not be held as a fragment: "${clause}"`
    );
  }
  pass('the opening statement, and every clause of it, is treated as complete');
}

for (const [label, allowed] of [
  ['production allowlist', PRODUCTION_ALLOWED_MODULES],
  ['full catalogue', ALL_MODULES]
]) {
  const config = configFor(allowed);
  const { profile, rejected } = applyOpeningTurn(config, `incident-${allowed.length}`);

  assert.deepEqual(rejected, [], `${label}: no candidate from the opening turn may be rejected`);

  // Both goals recognised.
  const goals = profile.goals.map((goal) => goal.type);
  assert.ok(goals.includes('understand_position'), `${label}: the broad financial-position goal is recognised`);
  assert.ok(goals.includes('buy_home'), `${label}: the future home-purchase goal is recognised`);

  // Age recorded.
  assert.equal(profile.primaryPerson.age, 25, `${label}: the stated age is recorded`);
  assert.equal(
    profile.assumptions.values.persona.careerStage,
    'early_career',
    `${label}: the stated career stage is recorded`
  );

  const state = describeConversationState(profile, config);
  const plan = buildGoalModulePlan(profile, { allowedModuleIds: allowed });
  assert.deepEqual(
    [...plan.goalAssessment.activeGoalTypes].sort(),
    ['buy_home', 'understand_position'],
    `${label}: both goals stay active`
  );
  assert.deepEqual(plan.goalAssessment.deferredGoalTypes, [], `${label}: neither goal is dropped`);

  const brief = await briefFor(profile, config);

  // THE INCIDENT ASSERTION. The brief must carry exactly one thing to ask.
  assert.ok(
    brief.questionBatch,
    `${label}: the brief must never go to the model without a question — this is the clarification loop`
  );
  assert.ok(
    brief.questionBatch.prompt && brief.questionBatch.prompt.trim().length > 0,
    `${label}: the brief question must have text`
  );
  assert.ok(
    brief.nextObjective.promptHint && brief.nextObjective.promptHint.trim().length > 0,
    `${label}: the brief must carry a next objective`
  );

  // With two goals and no stated focus, the right next move is to ask which
  // comes first — not to ask the client to repeat themselves.
  assert.equal(
    state.requiresGoalPriorityQuestion,
    true,
    `${label}: two unranked goals require the priority question`
  );
  assert.equal(
    brief.questionBatch.primaryFact.factId,
    'primary_goal_focus',
    `${label}: the brief asks which goal to focus on first`
  );
  assert.match(
    brief.questionBatch.prompt,
    /focus|most useful|first/i,
    `${label}: the question advances the meeting rather than asking for a repeat`
  );

  // It must not be a request to repeat, restate or clarify what was just said.
  assert.doesNotMatch(
    brief.questionBatch.prompt,
    /repeat|say (?:that )?again|didn.t (?:quite )?(?:catch|get|understand)|one more time/i,
    `${label}: the meeting must not ask the client to repeat a complete statement`
  );

  // Client-safe language throughout.
  assert.equal(
    containsInternalModuleTerminology(brief.questionBatch.prompt),
    false,
    `${label}: the question uses client language`
  );
  for (const goalType of ['understand_position', 'buy_home']) {
    assert.ok(
      !brief.questionBatch.prompt.includes(goalType),
      `${label}: no internal goal code reaches the client`
    );
  }

  pass(`${label}: both goals and the age are recorded, and the meeting advances with a real question`);
}

{
  // Answering the question must break the loop, not restart it.
  const config = configFor(PRODUCTION_ALLOWED_MODULES);
  const { profile } = applyOpeningTurn(config, 'incident-followup');
  const focused = normalizeHouseholdProfile({
    ...profile,
    assumptions: {
      ...profile.assumptions,
      values: {
        ...profile.assumptions.values,
        planning: { ...(profile.assumptions.values.planning || {}), primaryGoalType: 'buy_home' }
      }
    }
  });
  const state = describeConversationState(focused, config);
  assert.equal(state.requiresGoalPriorityQuestion, false, 'answering the question resolves it');
  assert.ok(state.moduleSlots.length > 0, 'analyses appear once the focus is known');

  const brief = await briefFor(focused, config);
  assert.ok(brief.questionBatch, 'the follow-up brief still carries a question');
  assert.notEqual(
    brief.questionBatch.primaryFact.factId,
    'primary_goal_focus',
    'the priority question is not asked twice'
  );
  assert.ok(brief.analyses.length > 0, 'the client-facing analyses are now described');
  assert.ok(
    brief.stillNeeded.length > 0,
    'the meeting now has real facts to collect, so it progresses past the opening'
  );
  pass('answering the focus question resolves it once and the meeting progresses to intake');
}

{
  // The opening greeting the client should hear before any of this.
  const { REALTIME_V2_WELCOME_INSTRUCTIONS } = await import('../worker/src/consumer/realtime_session.js');
  assert.ok(REALTIME_V2_WELCOME_INSTRUCTIONS, 'the welcome instructions are exported for inspection');
  assert.match(REALTIME_V2_WELCOME_INSTRUCTIONS, /welcome/i, 'the greeting opens with a welcome');
  assert.match(REALTIME_V2_WELCOME_INSTRUCTIONS, /Plan[ée]ir/, 'the greeting introduces Planéir');
  assert.match(REALTIME_V2_WELCOME_INSTRUCTIONS, /AI/, 'the greeting discloses that this is an AI');
  assert.match(
    REALTIME_V2_WELCOME_INSTRUCTIONS,
    /Do not .*(?:ask for financial figures|call a tool)/i,
    'the greeting explicitly forbids asking for figures or calling a tool'
  );
  assert.match(
    REALTIME_V2_WELCOME_INSTRUCTIONS,
    /invitation to describe/i,
    'the greeting ends by inviting the client to describe what they want help with'
  );
  pass('the intended opening greeting is a warm, AI-disclosed welcome that asks for no figures');
}

/* ------------------------------------------------------------------ */
/* Second incident: the planner failed and the meeting blamed the client */
/* ------------------------------------------------------------------ */

// Live transcript, verbatim. The assistant answered both turns with "the last
// planning note couldn't be updated — could you restate that point?", and the
// UI stayed at zero goals. That is the `planner_recovery` branch: the AI
// planner call threw, so NOTHING was extracted. Rephrasing cannot fix a
// provider outage, so the meeting looped.
const LIVE_TURN_1 = "Well, I'm 25 and I'm mostly interested in saving up for buying a house in the "
  + "future. So that's my, I guess, my main goal. After that, it's just whatever other financial "
  + "advice you have for someone of my age would be great.";
const LIVE_TURN_2 = "My main goal is just to buy a house in about five years' time.";

{
  // With the AI planner dead, the deterministic extractor must still capture
  // the goal and the age. This is what stops the meeting stalling.
  for (const [label, utterance] of [['turn 1', LIVE_TURN_1], ['turn 2', LIVE_TURN_2]]) {
    const extraction = deterministicFallbackExtraction({
      transcript: utterance,
      profile: freshProfile(`fallback-${label.replace(/\s/g, '')}`),
      sourceTurnId: 'live-turn'
    });
    assert.ok(extraction, `${label}: the deterministic fallback must salvage the turn`);
    assert.equal(extraction.degraded, true, `${label}: the extraction is marked degraded`);
    assert.ok(
      extraction.goalCandidates.some((goal) => goal.goalType === 'buy_home'),
      `${label}: the home-purchase goal is recovered without the AI planner`
    );
  }
  const first = deterministicFallbackExtraction({
    transcript: LIVE_TURN_1,
    profile: freshProfile('fallback-age'),
    sourceTurnId: 'live-turn'
  });
  assert.ok(
    first.semanticFacts.some((fact) => fact.factId === 'person_current_age' && fact.value === 25),
    'the stated age is recovered without the AI planner'
  );
  pass('a planner outage still captures the home-purchase goal and the age deterministically');
}

{
  // And that salvaged extraction must flow through the normal candidate path,
  // producing a real profile and a real next question.
  const config = configFor(PRODUCTION_ALLOWED_MODULES);
  let profile = freshProfile('fallback-journey');
  const extraction = deterministicFallbackExtraction({
    transcript: LIVE_TURN_1, profile, sourceTurnId: 'live-turn'
  });
  const rejected = [];
  for (const candidate of mapPlannerExtractionToCandidates(extraction)) {
    try {
      profile = planFactProposal({
        config,
        profile,
        state: describeConversationState(profile, config),
        fact: { factId: candidate.factId, value: candidate.value, certainty: candidate.certainty },
        plannerBatch: true
      }).profile;
    } catch (error) {
      rejected.push({ factId: candidate.factId, code: error?.code });
    }
  }
  assert.deepEqual(rejected, [], `no salvaged candidate may be rejected: ${JSON.stringify(rejected)}`);
  assert.ok(profile.goals.some((goal) => goal.type === 'buy_home'), 'buy_home is persisted as an active goal');
  assert.equal(profile.primaryPerson.age, 25, 'age 25 is persisted');

  const brief = await briefFor(profile, config);
  assert.ok(brief.questionBatch, 'the degraded meeting still has a question to ask');
  assert.ok(brief.analyses.length > 0, 'the client can see what is being prepared');
  assert.doesNotMatch(
    brief.questionBatch.prompt,
    /repeat|restate|say (?:that )?again|different words|rephrase/i,
    'a degraded meeting must never ask the client to restate a valid goal'
  );
  pass('the salvaged turn persists the goal and age, and the meeting advances with a real question');
}

{
  // One invalid secondary candidate must not block the valid goal. This is the
  // independent-rejection property the incident report asked about.
  const config = configFor(PRODUCTION_ALLOWED_MODULES);
  let profile = freshProfile('independent-rejection');
  const mixed = {
    ...INCIDENT_EXTRACTION,
    goalCandidates: [{
      candidateId: 'goal-1', goalType: 'buy_home', confidence: 'high', priorityHint: 'primary',
      evidenceText: 'buying a house', correctionTarget: ''
    }],
    semanticFacts: [
      { candidateId: 'f1', operation: 'upsert', factId: 'person_current_age', value: 25, certainty: 'exact', evidenceText: 'x', correctionTarget: '' },
      // Plausible but unsupported — exactly what a planner emits from
      // "saving up ... in about five years".
      { candidateId: 'f2', operation: 'upsert', factId: 'home_purchase_timeframe_years', value: 5, certainty: 'approximate', evidenceText: 'x', correctionTarget: '' },
      { candidateId: 'f3', operation: 'upsert', factId: 'savings_goal', value: 'house_deposit', certainty: 'approximate', evidenceText: 'x', correctionTarget: '' }
    ]
  };
  const outcomes = [];
  for (const candidate of mapPlannerExtractionToCandidates(mixed)) {
    try {
      profile = planFactProposal({
        config, profile, state: describeConversationState(profile, config),
        fact: { factId: candidate.factId, value: candidate.value, certainty: candidate.certainty },
        plannerBatch: true
      }).profile;
      outcomes.push({ factId: candidate.factId, accepted: true });
    } catch (error) {
      outcomes.push({ factId: candidate.factId, accepted: false, code: error?.code });
    }
  }
  assert.ok(
    outcomes.some((o) => o.factId === 'primary_goal' && o.accepted),
    'the valid goal is accepted despite unsupported siblings'
  );
  assert.ok(
    outcomes.some((o) => o.factId === 'person_current_age' && o.accepted),
    'the valid age is accepted despite unsupported siblings'
  );
  assert.ok(
    outcomes.some((o) => !o.accepted),
    'the unsupported candidates are genuinely rejected'
  );
  assert.ok(profile.goals.some((goal) => goal.type === 'buy_home'), 'buy_home survives');
  assert.equal(
    profile.assumptions.values.planning.primaryGoalType,
    'buy_home',
    'the home-purchase goal is treated as primary'
  );
  pass('an unsupported secondary candidate is rejected independently and never blocks the valid goal');
}

{
  // Planner failures are operational faults and must never be narrated to the
  // client or turn into a request to repeat a perfectly clear answer.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    new URL('../worker/src/consumer/realtime_session.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /applyDeterministicFallback/, 'a planner failure tries the deterministic fallback first');
  assert.match(
    source,
    /const fallback = await this\.applyDeterministicFallback[\s\S]{0,200}if \(fallback\)/,
    'the fallback runs before any recovery response is authorised'
  );
  assert.match(source, /consecutivePlannerFailures/, 'consecutive planner failures are counted');
  assert.match(
    source,
    /authorizeResponse\('planner_degraded'\)/,
    'an internal planner failure continues through a non-technical response path'
  );
  const degraded = source.slice(source.indexOf("authorizationReason === 'planner_degraded'"));
  const instruction = degraded.slice(0, degraded.indexOf('\n', degraded.indexOf('?')) + 400);
  assert.match(instruction, /Do not mention any technical issue/i, 'the degraded message suppresses internal faults');
  assert.match(instruction, /do not ask the client to repeat, restate or rephrase/i, 'the degraded message never asks for a repeat');
  assert.doesNotMatch(
    instruction,
    /Say plainly.*technical|having a technical problem saving notes/i,
    'the old spoken technical-difficulty preamble cannot return'
  );
  assert.match(
    source,
    /let planned;[\s\S]*try \{[\s\S]*planned = await extractRealtimePlannerTurn[\s\S]*\} catch \(error\)[\s\S]*Only extraction\/provider failures belong/,
    'only extraction/provider failures enter the deterministic fallback'
  );
  pass('a planner failure stays operationally visible without disrupting the spoken conversation');
}

{
  // The planner model must be its own validated, allowlisted setting — not
  // inherited from the AI-intake defaultModel, which is a different feature.
  const { getConsumerConfig, PLANNER_MODEL_ALLOWLIST } = await import('../worker/src/consumer/config.js');
  const base = {
    CONSUMER_JOURNEY_ENABLED: 'true',
    CONSUMER_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 31).toString('base64url'),
    CONSUMER_RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 47).toString('base64url'),
    CONSUMER_DB: {},
    CONSUMER_CONSENT_POLICY_VERSION: 'v1', CONSUMER_CONSENT_MANIFEST_ID: 'm1',
    CONSUMER_ANALYSIS_NOTICE_ID: 'a1', CONSUMER_AI_NOTICE_ID: 'ai1',
    CONSUMER_PRIVACY_NOTICE_URL: 'https://planeir.ie/plan/privacy.html',
    CONSUMER_SESSION_TTL_DAYS: '7'
  };
  assert.ok(PLANNER_MODEL_ALLOWLIST.length > 0, 'there is a server-side planner model allowlist');

  const byDefault = getConsumerConfig(base);
  assert.ok(
    PLANNER_MODEL_ALLOWLIST.includes(byDefault.realtimePlannerModel),
    'the default planner model is on the allowlist'
  );
  assert.equal(byDefault.realtimePlannerModelConfigured, true, 'an unset value is an approved default');

  // An unapproved model must never reach the provider.
  const rogue = getConsumerConfig({ ...base, CONSUMER_REALTIME_PLANNER_MODEL: 'some-unreviewed-model' });
  assert.ok(
    PLANNER_MODEL_ALLOWLIST.includes(rogue.realtimePlannerModel),
    'an unapproved planner model falls back to an approved one'
  );
  assert.equal(rogue.realtimePlannerModelConfigured, false, 'the unapproved value is reported as such');

  // Changing the AI-intake model must NOT change the planner.
  const retunedIntake = getConsumerConfig({ ...base, CONSUMER_AI_DEFAULT_MODEL: 'gpt-5.6-sol' });
  assert.equal(
    retunedIntake.realtimePlannerModel,
    byDefault.realtimePlannerModel,
    'retuning the AI-intake model must not silently retune the planner'
  );

  // The planner imposes NO application-level output cap. Reasoning tokens count
  // toward max_output_tokens, so any ceiling we pick silently truncates the
  // response into status:"incomplete" instead of erroring. The model and
  // endpoint apply their own native maximum.
  assert.equal(
    byDefault.realtimePlannerMaxOutputTokens,
    undefined,
    'there is no application-level planner output-token cap in config'
  );
  const { readFileSync: read } = await import('node:fs');
  const plannerSource = read(new URL('../worker/src/consumer/realtime_planner.js', import.meta.url), 'utf8');
  const requestBody = plannerSource
    .slice(
      plannerSource.indexOf('body: JSON.stringify({'),
      plannerSource.indexOf('signal: controller.signal')
    )
    // Strip comments: the code explains WHY there is no cap, and that
    // explanation must not itself trip the check.
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(requestBody.length > 0, 'the planner request body was located');
  assert.ok(
    !requestBody.includes('max_output_tokens'),
    'the outgoing planner request omits max_output_tokens'
  );
  pass('the planner model is explicitly configured, allowlisted, and independent of AI intake');
}

{
  // A planner failure must be self-diagnosing next time.
  const { readFileSync } = await import('node:fs');
  const planner = readFileSync(new URL('../worker/src/consumer/realtime_planner.js', import.meta.url), 'utf8');
  assert.match(planner, /readPlannerProviderError/, 'a rejected planner call reads the provider error classification');
  assert.match(planner, /incomplete_details\?\.reason/, 'an incomplete response records why it was incomplete');
  assert.match(planner, /reasoning_tokens/, 'reasoning token usage is recorded on an incomplete response');
  assert.match(planner, /config\.realtimePlannerModel/, 'the planner uses its dedicated model');
  assert.ok(
    !/const model = complex \? config\.complexModel : config\.defaultModel/.test(planner),
    'the planner no longer borrows the AI-intake model'
  );

  const schema = readFileSync(new URL('../worker/src/consumer/realtime_event_schema.js', import.meta.url), 'utf8');
  for (const field of ['providerStatus', 'providerErrorType', 'providerErrorCode', 'incompleteReason', 'plannerModel']) {
    assert.ok(schema.includes(field), `the deferred planner event records ${field}`);
  }
  const session = readFileSync(new URL('../worker/src/consumer/realtime_session.js', import.meta.url), 'utf8');
  assert.match(session, /degradedTurnCount/, 'a degraded meeting reports how many turns were degraded');
  assert.match(session, /degradedPlannerTurns \+= 1/, 'degraded turns are counted');
  pass('a planner failure now records the provider status, error class and incomplete reason');
}

{
  // The planner's schema carries every value as a JSON string, so it naturally
  // emits {"value": x} for a choice and {"age": 25} for a number. Numbers and
  // goals already unwrapped; orientation facts did not, so life_stage,
  // career_stage, property_status, employment_context, retirement_status and
  // household_structure were ALL silently rejected in production. Those are
  // exactly the facts that drive routing. Confirmed against the live API.
  const config = configFor(PRODUCTION_ALLOWED_MODULES);
  const base = freshProfile('wrapped-values');
  const cases = [
    ['life_stage', 'early_adult', { value: 'early_adult' }],
    ['property_status', 'renter', { value: 'renter' }],
    ['employment_context', 'employee', { value: 'employee' }],
    ['has_pension', false, { value: false }],
    ['dependant_count', 2, { value: 2 }],
    ['person_current_age', 25, { age: 25 }]
  ];
  for (const [factId, bare, wrapped] of cases) {
    for (const [shape, value] of [['bare', bare], ['wrapped', wrapped]]) {
      const result = planFactProposal({
        config,
        profile: base,
        state: describeConversationState(base, config),
        fact: { factId, value, certainty: 'exact' },
        plannerBatch: true
      });
      assert.ok(
        result.mapped,
        `${factId} must accept its ${shape} shape as the planner emits it`
      );
    }
  }
  // Tolerating the wrapper must NOT weaken validation.
  assert.throws(
    () => planFactProposal({
      config,
      profile: base,
      state: describeConversationState(base, config),
      fact: { factId: 'life_stage', value: { value: 'not_a_real_stage' }, certainty: 'exact' },
      plannerBatch: true
    }),
    (error) => error.code === 'realtime_fact_value_invalid',
    'an invalid choice is still rejected inside a wrapper'
  );
  pass('orientation facts accept the wrapped shape the planner emits, without weakening validation');
}

console.info(`\n[MultiGoalOpening] ${passes.length} assertions passed.`);
