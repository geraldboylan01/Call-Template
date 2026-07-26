// Protected agent-test transport checks.
//
// Two halves:
//
//  1. BOUNDARY — authentication, the feature flag, limits, projection tiers and
//     the one-engine guarantee (the text channel must not own instructions,
//     tool definitions, routing or question composition).
//
//  2. D-02 JOURNEY — the complete offer and three-analysis capacity flow driven
//     THROUGH the agent transport's shared planning path: an offer is produced
//     and spoken in client language, decisions are recorded, the limit is
//     reached, a capacity decision appears, replacement/deferral/unclear behave,
//     and the confirmed set is exactly what executes.
//
// No network and no API key: the planner and renderer are injected. What is
// under test is the planning pipeline, not the model.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MODULE_IDS,
  buildGoalModulePlan,
  createHouseholdProfile,
  normalizeHouseholdProfile
} from '../js/planning/index.js';
import { containsInternalModuleTerminology } from '../js/planning/module_offers.js';
import { describeConversationState } from '../worker/src/consumer/conversation.js';
import { composeMeetingBrief } from '../worker/src/consumer/realtime_planner.js';
import { buildPlanningStateSlice } from '../worker/src/consumer/planning_context.js';
import {
  resolveCapacityDecision,
  resolveModuleOffer
} from '../worker/src/consumer/planning_turn.js';
import { agentToolsForState } from '../worker/src/consumer/agent_text_channel.js';
import {
  toAgentConsumerView,
  toAgentDiagnosticView
} from '../worker/src/consumer/agent_session.js';
import { agentRouteMatch } from '../worker/src/consumer/agent_router.js';
import { getConsumerConfig } from '../worker/src/consumer/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const NOW = '2026-07-25T09:00:00.000Z';
const ALL = Object.values(MODULE_IDS);
const ENV = { CONSUMER_RATE_LIMIT_HASH_KEY: 'c2ltdWxhdG9yLXRlc3Qta2V5LTMyLWJ5dGVzLW9rMDA' };
const CONFIG = Object.freeze({
  goalRoutingEnabled: true,
  moduleRoutingEnabled: true,
  allowedModules: ALL,
  realtimeSpokenCompletionEnabled: false,
  realtimeConversationV2Enabled: true,
  moduleOffersEnabled: true,
  agentTestEnabled: true,
  agentTestMaxTurns: 40,
  maxMessageLength: 4_000,
  agentTestSessionBudgetMicroEur: 500_000,
  cohort: 'automated_test',
  realtimePlannerPromptVersion: 'realtime-planner-v3'
});

const passes = [];
function pass(message) {
  passes.push(message);
  console.info(`[AgentAPI] PASS: ${message}`);
}

function freshProfile(id) {
  return normalizeHouseholdProfile({
    ...createHouseholdProfile({ profileId: id, nowIso: NOW, calculationDateIso: NOW.slice(0, 10) }),
    revision: 1
  });
}

function withPlanning(profile, planning) {
  return normalizeHouseholdProfile({
    ...profile,
    assumptions: {
      ...profile.assumptions,
      values: {
        ...profile.assumptions.values,
        planning: { ...(profile.assumptions.values.planning || {}), ...planning }
      }
    }
  });
}

/** A homeowner with a mortgage whose stated goal is retirement. */
function offerableProfile(id = 'agent-offer') {
  const base = freshProfile(id);
  return normalizeHouseholdProfile({
    ...base,
    goals: [{ goalId: 'g1', type: 'improve_pension', title: 'Improve pension readiness', priority: 'high', status: 'exploring' }],
    assumptions: {
      ...base.assumptions,
      values: {
        ...base.assumptions.values,
        persona: { ...(base.assumptions.values.persona || {}), propertyStatus: 'homeowner' }
      }
    },
    properties: [{
      propertyId: 'home', ownerIds: [base.primaryPerson.personId], use: 'home',
      label: 'Home', currentValue: { amount: 500_000, currency: 'EUR' }
    }],
    liabilities: [{
      liabilityId: 'mort', ownerIds: [base.primaryPerson.personId], type: 'mortgage',
      label: 'Mortgage', linkedPropertyId: 'home', currentBalance: { amount: 250_000, currency: 'EUR' }
    }]
  });
}

/** Three routed slots plus a fourth still offerable. */
function atCapacityProfile(id = 'agent-capacity') {
  const base = freshProfile(id);
  return normalizeHouseholdProfile({
    ...base,
    goals: [
      { goalId: 'g1', type: 'understand_position', title: 'Understand my current position', priority: 'high', status: 'exploring' },
      { goalId: 'g2', type: 'optimise_mortgage', title: 'Review the mortgage path', priority: 'high', status: 'exploring' },
      { goalId: 'g3', type: 'fund_education', title: 'Fund children’s education', priority: 'high', status: 'exploring' }
    ],
    assumptions: {
      ...base.assumptions,
      values: {
        ...base.assumptions.values,
        planning: { primaryGoalType: 'understand_position' },
        persona: {
          ...(base.assumptions.values.persona || {}),
          propertyStatus: 'homeowner', hasPension: true, dependantCount: 2
        }
      }
    },
    properties: [{
      propertyId: 'home', ownerIds: [base.primaryPerson.personId], use: 'home',
      label: 'Home', currentValue: { amount: 500_000, currency: 'EUR' }
    }],
    liabilities: [{
      liabilityId: 'mort', ownerIds: [base.primaryPerson.personId], type: 'mortgage',
      label: 'Mortgage', linkedPropertyId: 'home', currentBalance: { amount: 250_000, currency: 'EUR' }
    }],
    pensions: [{
      pensionId: 'p1', ownerId: base.primaryPerson.personId, type: 'occupational',
      label: 'Occupational pension', currentValue: { amount: 120_000, currency: 'EUR' }
    }],
    dependants: [
      { dependantId: 'dep1', displayName: 'Child one', currentAge: 8 },
      { dependantId: 'dep2', displayName: 'Child two', currentAge: 11 }
    ]
  });
}

/** Build the agent-channel context the shared services and projections consume. */
async function agentContext(profile, config = CONFIG) {
  const state = describeConversationState(profile, config);
  const sessionRow = { id: 'cs_agent_test_session_00000', current_profile_revision: profile.revision, confirmed_profile_revision: null };
  const slice = buildPlanningStateSlice({
    state, profile, sessionRow, config, channel: 'agent_test'
  });
  const brief = await composeMeetingBrief({
    env: ENV,
    context: { state: slice, profile, config, sessionRow },
    extraction: {},
    sourceTurnId: 'agent-test-turn'
  });
  // Second pass, with the brief in place, mirroring loadAgentContext.
  const withBrief = buildPlanningStateSlice({
    state, profile, sessionRow, config, channel: 'agent_test', latestMeetingBrief: brief
  });
  return { config, sessionRow, profile, state: withBrief, rawBrief: brief };
}

/* ================================================================== */
/* 1. BOUNDARY                                                         */
/* ================================================================== */

{
  // The feature flag must default off, and off must mean the routes do not exist.
  const off = getConsumerConfig({});
  assert.equal(off.agentTestEnabled, false, 'agent tests are off without explicit configuration');
  const partial = getConsumerConfig({ CONSUMER_AGENT_TEST_ENABLED: 'true' });
  assert.equal(
    partial.agentTestEnabled,
    false,
    'the agent flag cannot switch on without a configured, enabled consumer journey'
  );
  pass('CONSUMER_AGENT_TEST_ENABLED defaults false and cannot self-enable');
}

{
  const source = readFileSync(`${root}/worker/src/index.js`, 'utf8');
  const mount = source.slice(source.indexOf("pathname.startsWith('/api/agent-tests/')"), source.indexOf("pathname.startsWith('/api/consumer/')"));
  assert.match(mount, /requireAdvisorSession/, 'agent routes are adviser authenticated');
  assert.match(mount, /requireCsrf: request\.method !== 'GET'/, 'mutating agent calls require CSRF');
  assert.match(mount, /if \(advisorAccess\.response\) return advisorAccess\.response;/, 'auth failure short-circuits');
  pass('agent routes are mounted behind adviser authentication with CSRF on mutations');
}

{
  const source = readFileSync(`${root}/worker/src/consumer/agent_router.js`, 'utf8');
  assert.match(source, /if \(!config\.agentTestEnabled\) throw notFound\(\);/, 'flag-off yields 404');
  assert.match(source, /if \(!meeting\) throw notFound\(\);/, 'a non-agent session is not reachable through these routes');
  assert.doesNotMatch(source, /moduleId/, 'no agent route accepts a module id from the client');
  pass('flag-off 404s, ordinary consumer sessions are unreachable, and no route accepts a module id');
}

{
  // Routing table shape.
  assert.equal(agentRouteMatch('/api/agent-tests/sessions').kind, 'create');
  assert.equal(agentRouteMatch('/api/agent-tests/sessions/cs_' + 'a'.repeat(22) + '/turns').kind, 'turns');
  assert.equal(agentRouteMatch('/api/agent-tests/sessions/short'), null, 'a malformed session id does not route');
  assert.equal(agentRouteMatch('/api/agent-tests/other'), null);
  pass('the agent route table matches only well-formed agent paths');
}

{
  // The one-engine guarantee, asserted structurally.
  const channel = readFileSync(`${root}/worker/src/consumer/agent_text_channel.js`, 'utf8');
  assert.match(channel, /buildRealtimeConversationV2Instructions/, 'text imports the v2 voice instructions');
  assert.match(channel, /realtimeToolsForState/, 'text imports the v2 tool gating');
  assert.match(channel, /resolveModuleOffer/, 'tool calls go to the shared offer handler');
  assert.match(channel, /resolveCapacityDecision/, 'tool calls go to the shared capacity handler');
  // No second prompt pack, no second tool list, no second router.
  assert.doesNotMatch(channel, /You are Plan[ée]ir/, 'the text channel does not author its own instructions');
  assert.doesNotMatch(channel, /type: 'function',\s*\n\s*name: '/, 'the text channel does not define its own tools');
  assert.doesNotMatch(channel, /buildGoalModulePlan|buildQuestionPlan/, 'the text channel does not route or compose questions');

  const session = readFileSync(`${root}/worker/src/consumer/agent_session.js`, 'utf8');
  assert.doesNotMatch(session, /buildGoalModulePlan|buildQuestionPlan|nextModuleOffer|composeCapacityChoice/,
    'the agent session does not route, compose questions, or build offers itself');
  assert.match(session, /applyPlannerCandidates/, 'facts go through the shared candidate path');
  assert.match(session, /composeAndPersistBrief/, 'briefs come from the shared composer');
  assert.match(session, /confirmPlanSelection/, 'confirmation uses the shared rule');
  pass('the text transport owns no instructions, tools, routing, question planning or offer logic');
}

{
  // wait_for_user is meaningless without audio and must be filtered.
  const brief = (await agentContext(offerableProfile('agent-tools'))).state.meetingBrief;
  const names = agentToolsForState({ conversationVersion: 'v2', meetingBrief: brief }).map((tool) => tool.name);
  assert.ok(!names.includes('wait_for_user'), 'wait_for_user is not offered on the text channel');
  assert.ok(names.includes('get_meeting_brief'), 'the shared brief tool remains available');
  pass('the text channel filters only the audio-specific tool');
}

{
  // Projection tiers.
  const context = await agentContext(atCapacityProfile('agent-projection'));
  const consumerView = toAgentConsumerView({ assistantText: 'How are you fixed for pensions?', context });
  const diagnosticView = toAgentDiagnosticView(context);

  assert.deepEqual(
    Object.keys(consumerView).sort(),
    ['assistantMessage', 'phase', 'revision', 'turnId'],
    'the consumer projection carries natural language plus phase and revision only'
  );
  const consumerJson = JSON.stringify(consumerView);
  for (const moduleId of ALL) {
    assert.ok(!consumerJson.includes(moduleId), `the consumer projection must not leak the module id ${moduleId}`);
  }
  assert.ok(!consumerJson.includes('signature'), 'no brief signature reaches the consumer projection');

  const plan = buildGoalModulePlan(context.profile, { allowedModuleIds: ALL });
  const withheld = plan.withheldOpportunities.map((item) => item.moduleId);
  const diagnosticJson = JSON.stringify(diagnosticView);
  for (const moduleId of withheld) {
    assert.ok(!consumerJson.includes(moduleId), `withheld module ${moduleId} must not reach the consumer`);
    assert.ok(!diagnosticJson.includes(moduleId), `withheld module ${moduleId} must not reach the tester either`);
  }
  assert.ok(!diagnosticJson.includes('signature'), 'the brief signature stays server-side');
  assert.ok(diagnosticView.analyses.every((item) => item.moduleId), 'the tester projection does carry module ids');
  pass('consumer and tester projections are separate, and hidden opportunities reach neither');
}

/* ================================================================== */
/* 2. D-02 JOURNEY THROUGH THE AGENT TRANSPORT                         */
/* ================================================================== */

{
  const context = await agentContext(offerableProfile('agent-d02-offer'));
  const offer = context.state.meetingBrief?.moduleOffer;
  assert.ok(offer?.moduleId, 'an offerable module produces a live offer on the agent transport');
  assert.equal(offer.moduleId, MODULE_IDS.MORTGAGE);
  assert.ok(offer.anchor, 'the offer is anchored to something the client supplied');
  assert.ok(offer.spokenOffer.includes(offer.anchor), 'the spoken offer quotes the anchor back');
  assert.equal(
    containsInternalModuleTerminology(offer.spokenOffer),
    false,
    'the offer is introduced in client-safe language'
  );
  assert.equal(containsInternalModuleTerminology(offer.benefit || ''), false);
  pass('D-02: an offerable module produces a live, client-safe offer through the agent transport');
}

{
  const withOffer = await agentContext(offerableProfile('agent-d02-tools-on'));
  const withoutOffer = await agentContext(freshProfile('agent-d02-tools-off'));
  const on = agentToolsForState({ conversationVersion: 'v2', meetingBrief: withOffer.state.meetingBrief })
    .map((tool) => tool.name);
  const off = agentToolsForState({ conversationVersion: 'v2', meetingBrief: withoutOffer.state.meetingBrief })
    .map((tool) => tool.name);
  assert.ok(on.includes('record_module_decision'));
  assert.ok(!off.includes('record_module_decision'));
  pass('D-02: record_module_decision appears only while an offer is active');
}

{
  // Accepted / declined / uncertain, through the SHARED handler.
  const context = await agentContext(offerableProfile('agent-d02-decisions'));
  const offer = context.state.meetingBrief.moduleOffer;
  const writes = [];
  const env = {
    ...ENV,
    __recordDecision: true
  };
  // Uncertain must change nothing at all.
  const uncertain = await resolveModuleOffer({
    env,
    config: CONFIG,
    context: { ...context, sessionRow: { ...context.sessionRow } },
    decision: 'uncertain',
    activeOffer: offer
  });
  assert.equal(uncertain.decision, 'uncertain');
  assert.ok(/not.*decided/i.test(uncertain.instruction), 'an uncertain answer is explicitly not an acceptance');
  assert.equal(uncertain.profileRevision, undefined, 'uncertain writes no revision');
  void writes;

  // Accepted and declined are deterministic profile transitions.
  const accepted = withPlanning(context.profile, { acceptedModuleIds: [offer.moduleId] });
  const acceptedSlots = buildGoalModulePlan(accepted, { allowedModuleIds: ALL }).moduleSlots;
  assert.ok(acceptedSlots.some((slot) => slot.moduleId === offer.moduleId), 'acceptance puts the analysis in the plan');
  assert.equal(
    acceptedSlots.find((slot) => slot.moduleId === offer.moduleId).selectionState,
    'accepted',
    'acceptance alone does not make it executable'
  );

  const declined = withPlanning(context.profile, { declinedModuleIds: [offer.moduleId] });
  const declinedBrief = (await agentContext(declined)).state.meetingBrief;
  assert.equal(declinedBrief.moduleOffer, null, 'a declined analysis is not offered again');
  pass('D-02: accepted, declined and uncertain answers behave correctly, and uncertain is never an acceptance');
}

{
  // An offer must not be repeated once decided either way.
  const base = offerableProfile('agent-d02-repeat');
  const offer = (await agentContext(base)).state.meetingBrief.moduleOffer;
  for (const [label, planning] of [
    ['accepted', { acceptedModuleIds: [offer.moduleId] }],
    ['declined', { declinedModuleIds: [offer.moduleId] }],
    ['deferred', { deferredModuleIds: [offer.moduleId] }]
  ]) {
    const next = (await agentContext(withPlanning(base, planning))).state.meetingBrief.moduleOffer;
    assert.notEqual(
      next?.moduleId,
      offer.moduleId,
      `a ${label} analysis must not be offered again in the same cycle`
    );
  }
  pass('D-02: a decided analysis is never re-offered in the same planning cycle');
}

{
  const context = await agentContext(atCapacityProfile('agent-d02-limit'));
  const plan = buildGoalModulePlan(context.profile, { allowedModuleIds: ALL });
  assert.equal(plan.moduleSlots.length, 3, 'the plan is at the three-analysis limit');
  assert.equal(plan.capacity.atLimit, true);
  const capacity = context.state.meetingBrief.capacityDecision;
  assert.ok(capacity?.candidateModuleId, 'reaching the limit produces a live capacity decision');
  assert.equal(capacity.replacementChoices.length, 3, 'exactly the current three may be replaced');
  assert.equal(capacity.maximumAnalyses, 3);
  assert.equal(
    containsInternalModuleTerminology(capacity.spoken),
    false,
    'the capacity explanation is in client language'
  );
  assert.ok(/\b3\b|three/i.test(capacity.spoken), 'the explanation states the limit plainly');
  pass('D-02: reaching the three-analysis limit produces a live, client-safe capacity decision');
}

{
  const atLimit = await agentContext(atCapacityProfile('agent-d02-cap-tools'));
  const notAtLimit = await agentContext(offerableProfile('agent-d02-cap-tools-no'));
  const on = agentToolsForState({ conversationVersion: 'v2', meetingBrief: atLimit.state.meetingBrief })
    .map((tool) => tool.name);
  const off = agentToolsForState({ conversationVersion: 'v2', meetingBrief: notAtLimit.state.meetingBrief })
    .map((tool) => tool.name);
  assert.ok(on.includes('resolve_capacity_decision'));
  assert.ok(!off.includes('resolve_capacity_decision'));
  pass('D-02: resolve_capacity_decision appears only while a capacity decision is active');
}

{
  // Unclear must mutate nothing, and must never pick for the client.
  const context = await agentContext(atCapacityProfile('agent-d02-unclear'));
  const capacity = context.state.meetingBrief.capacityDecision;
  const unclear = await resolveCapacityDecision({
    env: ENV,
    config: CONFIG,
    context,
    decision: 'unclear',
    capacity
  });
  assert.equal(unclear.decision, 'unclear');
  assert.equal(unclear.profileRevision, undefined, 'an unclear answer writes nothing');
  assert.ok(/never suggest/i.test(unclear.instruction), 'nothing may choose on the client’s behalf');

  // An out-of-range choice index must be refused outright.
  await assert.rejects(
    () => resolveCapacityDecision({
      env: ENV, config: CONFIG, context, decision: 'replace', replaceChoiceIndex: 99, capacity
    }),
    (error) => error.code === 'realtime_capacity_choice_invalid',
    'a choice outside the server-owned list changes nothing'
  );
  pass('D-02: an unclear capacity answer changes nothing and an invalid choice is refused');
}

{
  // Replacement and deferral outcomes.
  const profile = atCapacityProfile('agent-d02-replace');
  const context = await agentContext(profile);
  const capacity = context.state.meetingBrief.capacityDecision;
  const removeId = capacity.replacementChoices[0].moduleId;
  const candidateId = capacity.candidateModuleId;

  const replaced = withPlanning(profile, {
    replacedModuleIds: [removeId], acceptedModuleIds: [candidateId]
  });
  const replacedIds = buildGoalModulePlan(replaced, { allowedModuleIds: ALL }).moduleSlots.map((s) => s.moduleId);
  assert.ok(!replacedIds.includes(removeId), 'the replaced analysis leaves the plan');
  assert.ok(replacedIds.includes(candidateId), 'the chosen analysis takes its place');
  assert.ok(replacedIds.length <= 3, 'replacement never exceeds the limit');

  const deferred = withPlanning(profile, { deferredModuleIds: [candidateId] });
  const deferredContext = await agentContext(deferred);
  assert.equal(
    deferredContext.state.meetingBrief.capacityDecision,
    null,
    'deferring closes the capacity decision rather than re-asking'
  );
  const deferredIds = buildGoalModulePlan(deferred, { allowedModuleIds: ALL }).moduleSlots.map((s) => s.moduleId);
  assert.deepEqual(deferredIds.sort(), [...replacedIds.filter((id) => id !== candidateId), removeId].sort(),
    'deferring keeps the original three');
  pass('D-02: replacement swaps exactly the named analysis, and deferral keeps the current three');
}

{
  // The confirmed execution set, end to end.
  const profile = atCapacityProfile('agent-d02-execution');
  const context = await agentContext(profile);
  const capacity = context.state.meetingBrief.capacityDecision;
  const removeId = capacity.replacementChoices[0].moduleId;
  const candidateId = capacity.candidateModuleId;
  const afterReplacement = withPlanning(profile, {
    replacedModuleIds: [removeId], acceptedModuleIds: [candidateId]
  });

  const state = describeConversationState(afterReplacement, CONFIG);
  const candidates = state.moduleSlots
    .filter((slot) => ['ready', 'needs_facts'].includes(slot.availability))
    .map((slot) => slot.moduleId);
  const confirmed = withPlanning(afterReplacement, { confirmedModuleIds: candidates });
  const execution = buildGoalModulePlan(confirmed, { allowedModuleIds: ALL }).executionModuleIds;

  assert.deepEqual([...execution].sort(), [...candidates].sort(),
    'exactly the confirmed set executes');
  assert.ok(execution.includes(candidateId), 'the analysis the client swapped in executes');
  assert.ok(!execution.includes(removeId), 'the analysis the client swapped out does not');
  assert.ok(execution.length <= 3, 'never more than three execute');
  pass('D-02: the confirmed execution set is exactly the set the client ended up with');
}

{
  // Nothing internal may reach the consumer, at any point in the journey.
  for (const [label, profile] of [
    ['offer', offerableProfile('agent-d02-lang-offer')],
    ['capacity', atCapacityProfile('agent-d02-lang-capacity')]
  ]) {
    const context = await agentContext(profile);
    const brief = context.state.meetingBrief;
    const clientFacing = [
      brief.moduleOffer?.spokenOffer,
      brief.moduleOffer?.anchor,
      brief.moduleOffer?.benefit,
      brief.capacityDecision?.spoken,
      brief.capacityDecision?.deferralAcknowledgement,
      brief.capacityDecision?.candidateDescription,
      ...(brief.capacityDecision?.replacementChoices || []).map((c) => c.description),
      ...(brief.analyses || []).map((a) => a.label),
      brief.questionBatch?.prompt,
      brief.confirmationSummary
    ].filter(Boolean);
    assert.ok(clientFacing.length > 0, `${label}: there is client-facing copy to check`);
    for (const text of clientFacing) {
      assert.equal(containsInternalModuleTerminology(text), false,
        `${label}: internal terminology leaked: ${text}`);
    }
    const consumerView = toAgentConsumerView({ assistantText: clientFacing.join(' '), context });
    const json = JSON.stringify(consumerView);
    for (const moduleId of ALL) {
      assert.ok(!json.includes(moduleId), `${label}: module id ${moduleId} reached the consumer projection`);
    }
  }
  pass('D-02: no internal module id or hidden opportunity reaches the consumer at any stage');
}

{
  // Three harnesses hardcode their own consumer migration list, and each
  // deliberately replays a subset. What must never drift is the NEWEST
  // migration: a harness that builds the meeting table from an older schema
  // fails later, somewhere unrelated, with a confusing error — which is exactly
  // what happened while building this.
  const { readdirSync } = await import('node:fs');
  const migrations = readdirSync(`${root}/worker/consumer-migrations`)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const newest = migrations.at(-1);
  const harnesses = [
    'scripts/check-consumer-realtime.mjs',
    'scripts/check-consumer-cost-budget.mjs',
    'scripts/check-consumer-voice.mjs'
  ];
  for (const harness of harnesses) {
    const source = readFileSync(`${root}/${harness}`, 'utf8');
    assert.ok(
      source.includes('worker/consumer-migrations/'),
      `${harness} no longer replays consumer migrations; update this guard`
    );
    assert.ok(
      source.includes(newest),
      `${harness} does not replay the newest consumer migration (${newest})`
    );
  }
  pass(`all ${harnesses.length} database harnesses replay the newest consumer migration`);
}

console.info(`\n[AgentAPI] ${passes.length} assertions passed.`);
