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

console.info(`\n[MultiGoalOpening] ${passes.length} assertions passed.`);
