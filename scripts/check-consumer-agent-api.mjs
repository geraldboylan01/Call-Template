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
  applyProfilePatch,
  buildGoalModulePlan,
  createHouseholdProfile,
  getModuleReadiness,
  normalizeHouseholdProfile
} from '../js/planning/index.js';
import { containsInternalModuleTerminology } from '../js/planning/module_offers.js';
import { NON_CONTRIBUTORY_PENSION_TYPES } from '../js/planning/profile.js';
import { maxRelievableContributionRatePercent } from '../js/pension_math.js';
import { MODULE_MANIFEST } from '../js/planning/module_manifest.generated.js';
import { mapRealtimeFact } from '../worker/src/consumer/realtime_fact_mapper.js';
import { goalFamily } from '../js/planning/goal_plan.js';
import {
  FINANCIAL_POSITION_KINDS,
  plannerContextSlice,
  positionCandidatesToRealtimeFacts,
  validatePlannerExtraction
} from '../worker/src/consumer/realtime_planner.js';
import { realtimeChoiceVocabulary } from '../worker/src/consumer/realtime_fact_mapper.js';
import {
  bindCandidateToAskedEntity,
  mapPlannerExtractionToCandidates,
  mapRealtimeProposalFact
} from '../worker/src/consumer/planning_facts.js';

const NOW_ISO = '2026-08-02T09:00:00.000Z';
import { listSemanticFactDefinitions } from '../js/planning/semantic_facts.js';
import { describeConversationState } from '../worker/src/consumer/conversation.js';
import { composeMeetingBrief } from '../worker/src/consumer/realtime_planner.js';
import { buildPlanningStateSlice, complexJourney } from '../worker/src/consumer/planning_context.js';
import {
  resolveCapacityDecision,
  resolveModuleOffer
} from '../worker/src/consumer/planning_turn.js';
import { agentToolsForState } from '../worker/src/consumer/agent_text_channel.js';
import {
  buildRealtimeConversationV2Instructions,
  realtimeAssumptionInstructions,
  realtimeRecordedFactInstructions
} from '../worker/src/consumer/realtime_provider.js';
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
  // The spoken statements the meeting owes a client -- a figure assumed from a
  // range they gave, and an analysis dropped for want of an essential figure --
  // must reach BOTH transports. The agent transport is the tester for the voice
  // journey, so a rule only one of them follows tests nothing.
  const briefState = {
    meetingBrief: {
      assumptionNotices: [{ factId: 'cash_savings', text: 'You said savings is between A and B, so I will work with C.' }],
      droppedAnalysisNotices: [{ moduleId: 'personal_balance_sheet', text: 'I will not be able to review your picture.' }],
      questionBatch: { prompt: 'What age are you?' }
    }
  };
  const lines = realtimeAssumptionInstructions(briefState);
  assert.equal(lines.length, 1, 'both notice kinds are delivered as one instruction');
  assert.match(lines[0], /same breath as your next question/, 'the meeting keeps moving');
  assert.match(lines[0], /Do not pause for the client to confirm it/, 'an assumption is stated, not put to a vote');
  assert.match(lines[0], /so I will work with C/);
  assert.match(lines[0], /I will not be able to review your picture/);
  assert.deepEqual(realtimeAssumptionInstructions({ meetingBrief: {} }), [],
    'no notice means no instruction at all');
  assert.deepEqual(realtimeAssumptionInstructions({}), []);

  // The shared pack is what both transports build from, so carrying the notices
  // there is what makes them identical.
  const instructions = buildRealtimeConversationV2Instructions(briefState);
  assert.ok(instructions.includes(lines[0]), 'the shared instruction pack carries the notices');

  // And the voice session must not restate them, or the two transports would
  // drift the moment one copy was edited.
  const realtimeSession = readFileSync(`${root}/worker/src/consumer/realtime_session.js`, 'utf8');
  assert.doesNotMatch(realtimeSession, /assumptionNotices/,
    'the voice session must not author its own copy of the assumption instruction');
  pass('assumption and dropped-analysis notices come from the one shared instruction pack');
}

{
  // THE APP MUST NOT CLAIM IT SAVED SOMETHING IT REFUSED. A live call as a Cork
  // nurse gave her pension contribution rates, was told "that confirms the
  // contribution rates, so I won't ask for them again", and neither figure had
  // been stored. It asked again on the next turn.
  const withFacts = realtimeRecordedFactInstructions({
    meetingBrief: { understood: [{ label: 'Your age' }, { label: 'Retirement goal' }] }
  });
  assert.equal(withFacts.length, 1);
  assert.match(withFacts[0], /only details currently on this client's record are: Your age; Retirement goal/);
  assert.match(withFacts[0], /NEVER state or imply that any other figure has been captured/);
  assert.match(withFacts[0], /never promise not to ask for something again/,
    'the exact phrasing that misled a real caller is named');
  const empty = realtimeRecordedFactInstructions({});
  assert.match(empty[0], /Nothing is on this client's record yet/,
    'an empty record must still constrain what may be claimed, not fall silent');
  assert.ok(
    buildRealtimeConversationV2Instructions({
      meetingBrief: { understood: [{ label: 'Your age' }] }
    }).includes(withFacts[0].replace('; Retirement goal', '')),
    'the rule lives in the shared pack, so both transports obey it'
  );
  pass('the meeting may only claim a figure is captured if it is actually on the record');
}

{
  // THE CATALOGUE IS THE SCHEMA. The planner invented partner_annual_income,
  // primary_annual_income, partner_current_age and partner_employment_context
  // in a single live turn; none exist, so a client's stated household incomes
  // were rejected and lost. An enum makes that impossible rather than refused.
  const source = readFileSync(`${root}/worker/src/consumer/realtime_planner.js`, 'utf8');
  assert.match(source, /factId: \{ type: 'string', enum: SEMANTIC_FACT_IDS \}/,
    'the planner schema must constrain factId to the real catalogue');
  assert.doesNotMatch(source, /factId: \{ type: 'string', maxLength: 120 \}/,
    'a free-string factId lets the planner invent ids that are silently dropped');
  assert.match(source, /listSemanticFactDefinitions\(\)\.map\(\(definition\) => definition\.factId\)/,
    'the list is derived from the catalogue, never hand-maintained');
  const catalogue = listSemanticFactDefinitions().map((item) => item.factId);
  for (const invented of [
    'partner_annual_income', 'primary_annual_income', 'partner_current_age', 'partner_employment_context'
  ]) {
    assert.ok(!catalogue.includes(invented), `${invented} is not a real fact and must be unreachable`);
  }
  for (const real of ['income_sources', 'person_current_age', 'employment_context']) {
    assert.ok(catalogue.includes(real), `${real} is the id the planner should have used`);
  }
  pass('the planner can only name semantic facts that actually exist');
}

{
  // INCOME HAD NO WORKING ROUTE. The only path was the income_sources entity
  // fact, which needs a stable short name the planner never produced, so a
  // client stating their salary in plain words lost it every time. Income is
  // now a position, reusing the id-derivation every other position already has.
  assert.ok(FINANCIAL_POSITION_KINDS.includes('income'), 'income must be a position kind');
  const mapped = positionCandidatesToRealtimeFacts([
    {
      candidateId: 'c1', kind: 'income', operation: 'upsert', label: 'Mary salary',
      owner: 'primary', incomeType: 'employment',
      amount: { amount: 58_000, currency: 'EUR' }, certainty: 'exact', evidenceText: 'on about 58,000'
    },
    {
      candidateId: 'c2', kind: 'income', operation: 'upsert', label: 'Tom salary',
      owner: 'partner', incomeType: 'unknown',
      amount: { amount: 41_000, currency: 'EUR' }, certainty: 'exact', evidenceText: 'earns about 41,000'
    }
  ]);
  assert.equal(mapped.length, 2);
  assert.deepEqual(mapped.map((item) => item.factId), ['income_sources', 'income_sources']);
  assert.equal(mapped[0].value.entityId, 'mary_salary', 'the id is derived from the label, not invented');
  assert.deepEqual(mapped[0].value.grossAnnual, { amount: 58_000, currency: 'EUR' },
    'a stated salary is gross — assuming net would understate every projection built on it');
  assert.ok(!('amount' in mapped[0].value), 'the raw amount must not shadow grossAnnual');
  assert.equal(mapped[0].value.type, 'employment');
  assert.equal(mapped[1].value.type, 'employment',
    'an unqualified income type must not be left unset, which failed the entity guard outright');
  assert.equal(mapped[1].value.owner, 'partner');
  pass('a plainly stated salary now reaches the profile, for each owner');
}

{
  // NEVER RETRY A TIMEOUT. Measured warm against the real planner: ~2.7s for a
  // short answer, 4.1-6.1s for a rich multi-fact one, with occasional spikes.
  // A turn that could not finish in eight seconds will almost never finish in
  // a six-second remainder, so splitting the budget spent fourteen seconds of
  // the client's time and threw the answer away anyway.
  const source = readFileSync(`${root}/worker/src/consumer/realtime_planner.js`, 'utf8');
  assert.match(source, /if \(error\?\.code === 'realtime_planner_timeout'\) throw error;/,
    'a timeout must fall back immediately, not spend more silence failing again');
  assert.doesNotMatch(source, /realtimePlannerTotalBudgetMs/,
    'the split-budget retry is gone; it was the worst of both options');
  // A FAST failure is different: it costs nothing and usually succeeds.
  assert.match(source, /if \(elapsed > 2_000 \|\| remaining < 2_000\) throw error;/,
    'only a failure that came back quickly is worth repeating');
  assert.match(source, /retryOfFastFailure: true/);
  const budgets = getConsumerConfig({ CONSUMER_JOURNEY_ENABLED: 'false' });
  assert.equal(budgets.realtimePlannerTimeoutMs, 14_000,
    'the single attempt must cover the measured latency tail, not the median');
  assert.equal(
    getConsumerConfig({
      CONSUMER_JOURNEY_ENABLED: 'false', CONSUMER_REALTIME_PLANNER_TIMEOUT_MS: '99999'
    }).realtimePlannerTimeoutMs,
    20_000,
    'and it stays a bounded ceiling — silence is still a cost'
  );
  pass('a planner timeout falls back at once; only a fast failure is retried');
}

{
  // THE VOCABULARY THE PROMPT PROMISED. It told the planner to use "the
  // server-supplied vocabulary" for choice facts and nothing ever supplied it,
  // so it guessed: a nurse working for the HSE produced public_sector, "we're
  // both PAYE" produced paye. Neither exists, so both were dropped.
  const vocabulary = realtimeChoiceVocabulary();
  assert.ok(Object.keys(vocabulary).length >= 8, 'every choice fact needs its list');
  assert.ok(vocabulary.employment_context.includes('employee'));
  assert.ok(!vocabulary.employment_context.includes('public_sector'),
    'the guessed values are genuinely absent — that is why supplying the list matters');
  const slice = plannerContextSlice({ state: {}, sessionRow: { current_profile_revision: 1 } });
  assert.deepEqual(slice.choiceVocabulary, vocabulary,
    'the planner is actually given the list, on every turn');
  const plannerSource = readFileSync(`${root}/worker/src/consumer/realtime_planner.js`, 'utf8');
  assert.match(plannerSource, /MUST use a value listed in context\.choiceVocabulary/,
    'and is told to use it rather than invent');
  assert.match(plannerSource, /emit no fact rather than inventing a value/,
    'an unmatched value must be omitted, not guessed — a guess loses the answer silently');
  pass('choice facts are constrained by a vocabulary the planner can actually see');
}

{
  // EXTRACTION DIFFICULTY IS ABOUT WHAT WAS SAID, NOT WHO IS SAYING IT.
  // complexJourney escalates on any partner, so every turn of a couple's call
  // ran at medium reasoning: measured twice as slow (8.1-12.2s vs 4.6-7.7s) and
  // extracting no more. That is why a rich answer timed out and was discarded.
  const source = readFileSync(`${root}/worker/src/consumer/realtime_planner.js`, 'utf8');
  assert.match(source, /reasoningEscalation\?\.reason === 'contradictory_facts'/,
    'the planner escalates only where deliberation earns its cost');
  // The conversational model keeps the broader signal — this decouples the two,
  // it does not remove the capability.
  const provider = readFileSync(`${root}/worker/src/consumer/realtime_provider.js`, 'utf8');
  assert.match(provider, /state\.reasoningEscalation\?\.requested/,
    'the spoken model still uses the full journey-complexity signal');
  const withPartner = complexJourney({ partner: { personId: 'p' }, goals: [] }, {});
  assert.equal(withPartner.requested, true, 'a partner is still a complex journey');
  assert.equal(withPartner.reason, 'complex_household');
  assert.notEqual(withPartner.reason, 'contradictory_facts',
    'and that reason must NOT slow the planner down');
  const contradictory = complexJourney(
    { assumptions: { values: { unresolvedContradictions: ['x'] } }, goals: [] }, {}
  );
  assert.equal(contradictory.reason, 'contradictory_facts',
    'reconciling a contradiction is a judgement, and still escalates');
  pass('planner reasoning escalates on contradictions only, not on household shape');
}

{
  // A REJECTION MUST NAME WHAT WAS LOST. A candidate whose valueJson would not
  // parse was reported with no factId, so the diagnostic read "the engine would
  // not record: " with nothing after it — true, useless, unactionable.
  const parsed = validatePlannerExtraction({
    goalCandidates: [], positions: [], sectionCompletions: [],
    clientQuestion: { present: false, intent: 'none', topic: '', questionText: '' },
    ambiguities: [], narrativeSummary: { summary: 'x', evidence: [] },
    semanticFacts: [{
      operation: 'upsert', factId: 'cash_savings', valueJson: '{not valid json',
      certainty: 'exact', evidenceText: 'said something', correctionTarget: ''
    }]
  });
  assert.equal(parsed.semanticFacts.length, 0, 'the unparseable candidate is still dropped');
  assert.equal(parsed.invalidCandidates.length, 1);
  assert.equal(parsed.invalidCandidates[0].factId, 'cash_savings',
    'and the rejection names the fact the client was trying to give');
  assert.equal(parsed.invalidCandidates[0].errorCode, 'realtime_planner_candidate_value_invalid');
  pass('a rejected candidate names the fact it was trying to record');
}

{
  // A HUNDREDFOLD ERROR REACHED A REAL PENSION PROJECTION. "I put in about
  // 6.5%" was written by the planner as 0.065, divided by a hundred again, and
  // stored as 0.065% of pay. Nobody contributes that; everybody recognises 6.5%.
  const blank = normalizeHouseholdProfile({
    ...createHouseholdProfile({ profileId: 'rate', nowIso: NOW_ISO, calculationDateIso: '2026-08-02' }),
    revision: 1
  });
  const rateFor = (value) => mapRealtimeProposalFact(blank, {
    factId: 'pension_employee_contribution_rate', value, certainty: 'exact'
  }).canonicalValue.employeeContributionRate;
  assert.equal(rateFor(6.5), 0.065, 'a percentage is a percentage');
  assert.equal(rateFor(0.065), 0.065, 'and a fraction means the same thing, not a hundredth of it');
  assert.equal(rateFor(14), 0.14);
  assert.equal(rateFor(0.14), 0.14);
  assert.equal(rateFor(1), 0.01, 'a bare 1 is one percent — the ambiguity only cuts below 1');
  assert.equal(rateFor(40), 0.4);
  const plannerSource = readFileSync(`${root}/worker/src/consumer/realtime_planner.js`, 'utf8');
  assert.match(plannerSource, /A contribution rate is a PERCENTAGE of pay/,
    'and the planner is finally told which unit to send');
  pass('a contribution rate means the same whichever unit it arrives in');
}

{
  // POSITIONS BEFORE THE SCALARS THAT ATTACH TO THEM. Applying semantic facts
  // first let a contribution rate create its own placeholder pension, so one
  // HSE pension arrived as two records and the rates landed on the phantom.
  const ordered = mapPlannerExtractionToCandidates({
    goalCandidates: [],
    semanticFacts: [{
      candidateId: 'fact-1', factId: 'pension_employee_contribution_rate',
      value: 6.5, certainty: 'exact', evidenceText: 'I put in about 6.5%'
    }],
    positions: [{
      candidateId: 'position-1', kind: 'pension', operation: 'upsert', label: 'HSE pension',
      pensionType: 'defined_benefit', certainty: 'exact', evidenceText: 'an HSE pension'
    }],
    sectionCompletions: []
  });
  const pensionAt = ordered.findIndex((item) => item.factId === 'pension_positions');
  const rateAt = ordered.findIndex((item) => item.factId === 'pension_employee_contribution_rate');
  assert.ok(pensionAt >= 0 && rateAt >= 0, 'both candidates survive');
  assert.ok(pensionAt < rateAt,
    'the pension must exist before a rate tries to attach to it');

  // And the other direction: a partner's salary needs the partner to exist.
  const withPartner = mapPlannerExtractionToCandidates({
    goalCandidates: [],
    semanticFacts: [{
      candidateId: 'fact-1', factId: 'partner_person',
      value: { include: true }, certainty: 'exact', evidenceText: 'include Tom'
    }],
    positions: [{
      candidateId: 'position-1', kind: 'income', operation: 'upsert', label: 'Tom salary',
      owner: 'partner', incomeType: 'employment',
      amount: { amount: 41_000, currency: 'EUR' }, certainty: 'exact', evidenceText: "Tom's on 41,000"
    }],
    sectionCompletions: []
  });
  const partnerAt = withPartner.findIndex((item) => item.factId === 'partner_person');
  const incomeAt = withPartner.findIndex((item) => item.factId === 'income_sources');
  assert.ok(partnerAt >= 0 && incomeAt >= 0);
  assert.ok(partnerAt < incomeAt,
    'the partner must exist before an income owned by them is applied');
  pass('entities are created before the figures that belong to them, in both directions');
}

{
  // THE MEETING ALREADY KNOWS WHICH ONE IT MEANT. With three pensions on record
  // the question is specific -- "the pension from your old job" -- and the
  // signed question carries the exact entity. The client answers "thirty
  // percent", the planner extracts a bare number, and the engine refused it as
  // ambiguous. Three concurrent calls all ended there, six rates outstanding.
  const askedState = {
    meetingBrief: {
      questionBatch: {
        primaryFact: {
          factId: 'pension_employee_contribution_rate',
          factInstanceId: 'pension_employee_contribution_rate:pension_realtime_old_job'
        }
      }
    }
  };
  const bound = bindCandidateToAskedEntity(
    { factId: 'pension_employee_contribution_rate', value: 30 }, askedState
  );
  assert.equal(bound.value.entityId, 'pension_realtime_old_job',
    'a bare answer inherits the pension the question named');
  assert.equal(bound.value.value, 30, 'and keeps the figure the client gave');
  // An answer that already identifies itself is left alone.
  const explicit = bindCandidateToAskedEntity(
    { factId: 'pension_employee_contribution_rate', value: { entityId: 'other', rate: 30 } }, askedState
  );
  assert.equal(explicit.value.entityId, 'other', 'the client naming a different one still wins');
  // A different question must not donate its entity.
  assert.equal(
    bindCandidateToAskedEntity({ factId: 'cash_savings', value: 5 }, askedState).value, 5,
    'an unrelated fact is untouched'
  );
  // An unscoped question has no entity to give.
  assert.equal(
    bindCandidateToAskedEntity({ factId: 'x', value: 1 }, {
      meetingBrief: { questionBatch: { primaryFact: { factId: 'x', factInstanceId: 'x' } } }
    }).value,
    1
  );
  pass('an answer inherits the identity of whatever the meeting asked about');
}

{
  // Contracts the planner was never told, each of which silently lost a fact.
  const source = readFileSync(`${root}/worker/src/consumer/realtime_planner.js`, 'utf8');
  assert.match(source, /valueJson MUST be valid JSON/,
    'choice values came back as bare unquoted words and failed to parse');
  assert.match(source, /A CONTRIBUTION ARRANGEMENT IS NOT A POSITION/,
    '"her company pays 10%" became a fourth pension the client does not have');
  assert.match(source, /Never emit a fact called dependants/,
    'dependants needs an entity identity the planner cannot supply');
  const provider = readFileSync(`${root}/worker/src/consumer/realtime_provider.js`, 'utf8');
  assert.match(provider, /Never open with what you cannot do/,
    'the meeting opened with a disclaimer before anything had been asked for');
  pass('the planner is told the contracts that were silently losing facts');
}

{
  // A PRESERVED POLICY CANNOT BE CONTRIBUTED TO. A buyout bond holds benefits
  // from a scheme the client has left; asking what they and their employer pay
  // into it is a question with no correct answer, and the meeting repeated it
  // because no answer could be accepted.
  const NOW_PBS = '2026-08-02T09:00:00.000Z';
  const prov = {
    source: 'user_confirmation', confidence: 'high', certainty: 'exact',
    capturedAt: NOW_PBS, confirmedByUser: true
  };
  const built = applyProfilePatch(
    createHouseholdProfile({ profileId: 'pen', nowIso: NOW_PBS, calculationDateIso: '2026-08-02' }),
    {
      patchId: 'pen-1',
      operations: [
        { op: 'add', path: '/goals/-', value: { goalId: 'g1', type: 'retire', title: 'Retire', status: 'active', priority: 'high' }, provenance: prov },
        { op: 'add', path: '/primaryPerson/age', value: 53, provenance: prov },
        { op: 'add', path: '/pensions/-', value: { pensionId: 'bond', ownerId: 'primary', type: 'buyout_bond', currentValue: { amount: 380_000, currency: 'EUR' } }, provenance: prov },
        { op: 'add', path: '/pensions/-', value: { pensionId: 'work', ownerId: 'primary', type: 'occupational', currentValue: { amount: 360_000, currency: 'EUR' } }, provenance: prov }
      ]
    },
    { nowIso: NOW_PBS }
  ).profile;
  assert.equal(built.pensions[0].type, 'buyout_bond', 'the type survives the profile contract');
  const pensionAsks = (profile) => getModuleReadiness('pension_projection', profile).requiredMissing
    .filter((item) => /^\/pensions\//.test(item.fieldPath || ''))
    .map((item) => item.fieldPath);
  const withStatus = (status) => applyProfilePatch(built, {
    patchId: `pen-status-${status}`,
    operations: [{ op: 'add', path: '/pensions/1/contributionStatus', value: status, provenance: prov }]
  }, { nowIso: NOW_PBS }).profile;

  // Whether a pension is still being paid into is its own question, asked before
  // any percentage. Assuming every non-bond pension is contributory invented two
  // rate questions for arrangements that cannot accept a contribution at all.
  assert.deepEqual(pensionAsks(built), ['/pensions/1/contributionStatus'],
    'an unknown contribution status is asked before any rate, and never for the preserved bond');
  assert.deepEqual(
    pensionAsks(withStatus('active')),
    ['/pensions/1/employeeContributionRate', '/pensions/1/employerContributionRate'],
    'only the contributory pension is asked for rates; the preserved one is not'
  );
  assert.deepEqual(pensionAsks(withStatus('paid_up')), [],
    'a paid-up pension is projected without contributions rather than asked for rates');
  assert.ok(NON_CONTRIBUTORY_PENSION_TYPES.includes('buyout_bond'));
  // Its value still counts — only the contribution questions are dropped.
  assert.ok(!getModuleReadiness('pension_projection', built).requiredMissing
    .some((item) => item.fieldPath === '/pensions/0/currentValue'));
  // AND A SPOKEN RATE LANDS ON IT WITHOUT BEING ASKED WHICH. A buyout bond
  // cannot be paid into, so with exactly one contributory pension on record
  // "I pay 30% and they pay 10%" is not ambiguous. Refusing it lost both rates
  // on a real call and made the meeting ask a question it could not accept an
  // answer to.
  for (const factId of ['pension_employee_contribution_rate', 'pension_employer_contribution_rate']) {
    const mapped = mapRealtimeFact(built, { factId, value: 30, certainty: 'exact' });
    assert.match(mapped.fieldPath, /^\/pensions\/1\//,
      `${factId} must land on the contributory pension, not the buyout bond`);
  }
  pass('a preserved pension is valued but never asked what is paid into it');
}

{
  // "I PAY THE MAX" IS AN ANSWER, not a missing one. It is the Revenue age band
  // applied to the client's age. Treating it as no answer made one observed call
  // ask the same question nine times and finish unable to run the analysis.
  const NOW = '2026-08-03T09:00:00.000Z';
  const prov = { source: 'user_confirmation', confidence: 'high', certainty: 'exact', capturedAt: NOW, confirmedByUser: true };
  const profile = applyProfilePatch(
    createHouseholdProfile({ profileId: 'max', nowIso: NOW, calculationDateIso: '2026-08-03' }),
    {
      patchId: 'max-1',
      operations: [
        { op: 'add', path: '/primaryPerson/age', value: 53, provenance: prov },
        { op: 'add', path: '/partner', value: { personId: 'partner', age: 48 }, provenance: prov },
        { op: 'add', path: '/pensions/-', value: { pensionId: 'aon', ownerId: 'partner', label: 'Aon lifestyle fund', type: 'occupational', currentValue: { amount: 500_000, currency: 'EUR' } }, provenance: prov }
      ]
    },
    { nowIso: NOW }
  ).profile;

  // The band is applied to the OWNER of the pension, not to whoever is speaking.
  assert.equal(
    mapRealtimeFact(profile, { factId: 'pension_employee_contribution_rate', value: { maxForAge: true, owner: 'partner' }, certainty: 'exact' }).canonicalValue,
    0.25,
    'a 48-year-old partner maxes at 25%, stored as a fraction like any other rate'
  );
  assert.equal(
    mapRealtimeFact(profile, { factId: 'pension_employee_contribution_rate', value: { maxForAge: true, owner: 'primary' }, certainty: 'exact' }).canonicalValue,
    0.3,
    'a 53-year-old maxes at 30%, stored as a fraction like any other rate'
  );
  for (const [age, expected] of [[25, 15], [35, 20], [48, 25], [53, 30], [57, 35], [62, 40]]) {
    assert.equal(maxRelievableContributionRatePercent(age), expected, `age ${age}`);
  }
  // Refuses rather than guesses: a guessed band silently changes what the client
  // contributes, and the age is required for this analysis anyway.
  const ageless = applyProfilePatch(
    createHouseholdProfile({ profileId: 'noage', nowIso: NOW, calculationDateIso: '2026-08-03' }),
    { patchId: 'noage-1', operations: [{ op: 'add', path: '/pensions/-', value: { pensionId: 'p', ownerId: 'primary', label: 'Scheme', type: 'occupational' }, provenance: prov }] },
    { nowIso: NOW }
  ).profile;
  assert.throws(
    () => mapRealtimeFact(ageless, { factId: 'pension_employee_contribution_rate', value: { maxForAge: true }, certainty: 'exact' }),
    (error) => error.code === 'realtime_pension_max_age_required',
    'without an age the maximum must be refused, never guessed'
  );

  // The conversation is told the rule, so it can use it instead of re-asking --
  // and told the one thing the rule does not settle.
  const guidance = MODULE_MANIFEST.find((entry) => entry.moduleId === 'pension_projection').conversationGuidance;
  assert.ok(guidance.some((line) => /under 30: 15%/.test(line) && /60 and over: 40%/.test(line)),
    'the age bands reach the meeting');
  assert.ok(guidance.some((line) => /115,000/.test(line)), 'the earnings cap reaches the meeting');
  assert.ok(guidance.some((line) => /do not ask for a percentage again/.test(line)),
    'the meeting is told "the maximum" is an answer');
  assert.ok(guidance.some((line) => /employer contribution is a separate arrangement/.test(line)
    && /never for a self-employed client/.test(line)),
    'the employer side is asked only where an employer could exist');
  // The planner must report the phrase, never compute the number.
  const planner = readFileSync(`${root}worker/src/consumer/realtime_planner.js`, 'utf8');
  assert.match(planner, /Never work out the percentage yourself/,
    'deterministic code owns the derivation, not the model');
  pass('"I pay the max" is a complete answer, resolved from the client\'s age');
}

{
  // A RATE SAID IN THE SAME BREATH AS A PENSION BELONGS TO IT. The planner is
  // not reliable about saying whose it is -- asked in isolation it attributed
  // "she pays the max" to the primary person -- and a rate with no owner cannot
  // be placed in a household holding several pensions, so it was refused.
  const withOnePension = {
    goalCandidates: [], sectionCompletions: [], invalidCandidates: [],
    positions: [{ candidateId: 'position-1', kind: 'pension', label: 'Aon lifestyle fund', owner: 'partner', evidenceText: 'Aoife has 500,000 in an Aon fund' }],
    semanticFacts: [
      { candidateId: 'fact-1', factId: 'pension_employee_contribution_rate', value: { maxForAge: true }, certainty: 'exact', evidenceText: 'she pays the max' },
      { candidateId: 'fact-2', factId: 'pension_employer_contribution_rate', value: 10, certainty: 'exact', evidenceText: 'her company pays 10%' }
    ]
  };
  const bound = mapPlannerExtractionToCandidates(withOnePension)
    .filter((candidate) => /contribution_rate/.test(candidate.factId));
  assert.equal(bound.length, 2);
  assert.ok(bound.every((candidate) => candidate.value.owner === 'partner'),
    'both rates inherit the owner of the only pension named in the turn');

  // TWO pensions named is genuinely ambiguous. Guessing between them would put a
  // real contribution on the wrong pot, which is worse than asking.
  const withTwo = {
    ...withOnePension,
    positions: [
      { candidateId: 'position-1', kind: 'pension', label: 'Aon fund', owner: 'partner', evidenceText: 'a' },
      { candidateId: 'position-2', kind: 'pension', label: 'Irish Life', owner: 'primary', evidenceText: 'b' }
    ]
  };
  assert.ok(
    mapPlannerExtractionToCandidates(withTwo)
      .filter((candidate) => /contribution_rate/.test(candidate.factId))
      .every((candidate) => !candidate.value?.owner),
    'two pensions in one turn leaves the rate unowned rather than guessing'
  );

  // An owner the planner DID state is never overwritten.
  const stated = {
    ...withOnePension,
    semanticFacts: [{ candidateId: 'fact-1', factId: 'pension_employer_contribution_rate', value: { rate: 10, owner: 'primary' }, certainty: 'exact', evidenceText: 'x' }]
  };
  assert.equal(
    mapPlannerExtractionToCandidates(stated)
      .find((candidate) => /contribution_rate/.test(candidate.factId)).value.owner,
    'primary',
    'a stated owner wins over the inferred one'
  );
  pass('a contribution rate inherits the owner of the pension named beside it');
}

{
  // ONE HOLDING, ONE QUESTION. Asking the two rates a turn apart is how they
  // ended up on different pensions: "the employer pays 10% into that same one"
  // arrived after the meeting had moved to the next holding.
  const source = readFileSync(`${root}/worker/src/consumer/realtime_planner.js`, 'utf8');
  assert.match(source, /linkedFact: linkedRequestedFact/,
    'the paired rate travels with the question, instead of linkedFact always being null');
  assert.match(source, /maxQuestions: linkedRequestedFact \? 2 : 1/,
    'and the batch admits it is asking for two things');
  assert.match(source, /and does your employer add anything on top\?/,
    'both rates are asked in one breath');
  pass('both contribution rates for one pension are asked together');
}

{
  // GOALS IN THE SAME FAMILY ARE ONE CHOICE. "I'd love to go part-time at 60"
  // accumulated retire_early, improve_pension and retire in one live call.
  assert.equal(goalFamily('retire'), goalFamily('retire_early'));
  assert.equal(goalFamily('retire'), goalFamily('improve_pension'));
  assert.equal(goalFamily('buy_home'), goalFamily('optimise_mortgage'));
  assert.notEqual(goalFamily('retire'), goalFamily('fund_education'),
    'genuinely different concerns must still be a real choice');
  assert.equal(goalFamily('fund_education'), 'fund_education',
    'a goal with no family is its own concern');
  pass('overlapping goal types are one concern, so the client is not asked to arbitrate them');
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
