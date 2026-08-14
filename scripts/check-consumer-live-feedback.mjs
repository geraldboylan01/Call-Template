#!/usr/bin/env node

/**
 * PHASE 3 — the background planner improving the live conversation.
 *
 * THE DEFECT THIS PINS. The client says "I'm 57". The fast lane accepts it but
 * it does not reach `/primaryPerson/age`, so the pension analysis goes on
 * listing `person_current_age:primary` as a required input and the meeting asks
 * for an age the client has already given. The background reconciler is what
 * repairs that — but a repair the conversation never sees is not a repair.
 *
 * So this drives the REAL Durable Object over real D1 with the model stubbed,
 * and asserts the whole loop end to end: the reconciler lands the fact, the
 * deterministic readiness recomputes, and the refreshed state actually reaches
 * the speaking model in the item it is handed.
 *
 * WHAT IS DELIBERATELY NOT STUBBED: `liveStateProjection`, `loadLiveContext`,
 * `liveVolatileStateItem`, the reconciliation scheduler, the validator, the
 * projector and the CAS. Only the provider socket and the planner model are
 * fakes, because those are the two things a test cannot own.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ConsumerLiveSession } from '../worker/src/consumer/live/live_session.js';
import { loadLiveContext, liveStateProjection } from '../worker/src/consumer/live/live_tools.js';
import { liveVolatileStateItem } from '../worker/src/consumer/live/catalogue_prompt.js';
import { loadAgentContext, processAgentTurn } from '../worker/src/consumer/agent_session.js';
import { listPlanningNotes } from '../worker/src/consumer/realtime_repository.js';
import { getPlanningModuleDefinition } from '../js/planning/module_registry.js';
import { makeConfig, makeEnv, newDatabase, newSession } from './agent-harness/transports.mjs';

const FUTURE = '2030-01-01T00:00:00.000Z';

/**
 * The client turn everything hangs off. The age is stated plainly, so an
 * evidence quote for it is a contiguous span of what they actually said.
 */
const OPENING = "I'm 57 and married, my wife is 59. I want to sort out my pension before I retire. "
  + 'I have an occupational pension worth about 319,000.';

/* --------------------------------------------------------- durable fakes */

function fakeDurableState(initial = {}) {
  const values = new Map(Object.entries(initial));
  const waitUntilPromises = [];
  let initialization;
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async setAlarm() {}
  };
  return {
    state: {
      storage,
      blockConcurrencyWhile(callback) { initialization = Promise.resolve(callback()); },
      waitUntil(promise) { waitUntilPromises.push(Promise.resolve(promise)); }
    },
    values,
    waitUntilPromises,
    initialized: () => initialization
  };
}

/** A provider socket that records what the Worker sends it. */
function fakeProviderSocket() {
  const sent = [];
  return {
    socket: { readyState: 1, send: (text) => sent.push(JSON.parse(text)) },
    sent,
    stateItems: () => sent
      .filter((event) => event?.type === 'conversation.item.create'
        && event?.item?.role === 'system'
        && event?.item?.type === 'message')
      .map((event) => String(event.item.content?.[0]?.text || ''))
  };
}

/* ------------------------------------------------------------- the model */

function stubModel(planFor) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.openai.com')) return original(url, init);
    calls += 1;
    const plan = planFor();
    if (plan instanceof Error) throw plan;
    return new Response(JSON.stringify({
      id: 'resp_stub', status: 'completed',
      output_text: JSON.stringify(plan),
      usage: { input_tokens: 100, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { restore: () => { globalThis.fetch = original; }, modelCalls: () => calls };
}

const operation = (over) => ({
  operationId: 'op', op: 'upsert_note', targetNoteId: '', factId: 'person_current_age',
  factInstanceId: '', entityId: '', ownerId: '', noteKind: 'fact', certainty: 'exact',
  targetEntityId: '', sourceEntityIds: [], valueJson: '{}', reasonCode: 'missing_note',
  evidence: [], ...over
});

/** What the reconciler works out from the transcript: the client is 57. */
function ageRepairPlan(turnId) {
  return {
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{
      groupId: 'primary_age',
      atomic: false,
      operations: [operation({
        operationId: 'primary_age',
        op: 'upsert_note',
        factId: 'person_current_age',
        factInstanceId: 'person_current_age:primary',
        entityId: 'primary',
        ownerId: 'primary',
        noteKind: 'fact',
        certainty: 'exact',
        reasonCode: 'missing_note',
        valueJson: JSON.stringify({ age: 57 }),
        evidence: [{ turnId, quote: "I'm 57" }]
      })]
    }]
  };
}

/* ------------------------------------------------------------- the seed */

const SILENT_RENDERER = async ({ context }) => ({
  text: 'Thanks — let me take that down.',
  fallback: false, decisions: [], usageMicroEur: 0, context
});

/**
 * A meeting in exactly the state the defect produces: the pension analysis is
 * selected and running, the partner's age IS on record, and the client's own
 * age is not — even though they said it in the very first sentence.
 */
async function seedMeeting(label) {
  const env = makeEnv(newDatabase(label), { CONSUMER_PLANNER_RECONCILIATION_MODE: 'apply' });
  const config = makeConfig(env);
  const { sessionId, meetingId } = await newSession(env, config);
  await processAgentTurn(env, config, {
    sessionId,
    meetingId,
    message: OPENING,
    deps: {
      extractTurn: async ({ sourceTurnId }) => ({
        extraction: {
          schemaVersion: 'PlannerExtractionV3',
          sourceTurnId,
          goalCandidates: [{
            candidateId: 'g1',
            goalType: 'improve_pension',
            confidence: 'high',
            priorityHint: 'primary',
            evidenceText: 'I want to sort out my pension before I retire',
            correctionTarget: ''
          }],
          semanticFacts: [
            // The partner's age lands. The client's own does not — which is
            // the projection failure the reconciler exists to repair, and the
            // reason these two must not be interchangeable afterwards.
            {
              candidateId: 's1',
              operation: 'upsert',
              factId: 'partner_person',
              value: { age: 59 },
              certainty: 'exact',
              evidenceText: 'my wife is 59',
              correctionTarget: ''
            }
          ],
          positions: [{
            candidateId: 'p1',
            operation: 'upsert',
            kind: 'pension',
            label: 'Occupational pension',
            entityId: 'occ_dc',
            linkedEntityId: '',
            amount: { amount: 319_000, currency: 'EUR' },
            country: '',
            owner: 'primary',
            propertyUse: null,
            pensionType: 'occupational',
            incomeType: null,
            agricultural: null,
            certainty: 'approximate',
            evidenceText: 'I have an occupational pension worth about 319,000',
            correctionTarget: ''
          }],
          sectionCompletions: [],
          invalidCandidates: [],
          clientQuestion: { present: false, intent: 'none', topic: '', questionText: '' },
          ambiguities: [],
          narrativeSummary: { summary: '', evidence: [] }
        },
        metadata: { costMicroEur: 0 }
      }),
      renderText: SILENT_RENDERER
    }
  });
  const turn = await env.CONSUMER_DB.prepare(`
    SELECT id FROM consumer_realtime_final_turns
    WHERE session_id = ? AND realtime_session_id = ? AND role = 'user'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).bind(sessionId, meetingId).first();
  return { env, config, sessionId, meetingId, turnId: turn.id };
}

/** A live Durable Object bound to that meeting, with a recording socket. */
async function liveSessionFor(seeded) {
  const durable = fakeDurableState();
  const session = new ConsumerLiveSession(durable.state, seeded.env);
  await durable.initialized();
  const provider = fakeProviderSocket();
  session.webSocket = provider.socket;
  session.meta = {
    sessionId: seeded.sessionId,
    leaseId: seeded.meetingId,
    hardExpiresAt: FUTURE,
    idleExpiresAt: FUTURE
  };
  return { session, durable, provider };
}

const projectionFor = async (seeded) => liveStateProjection(await loadLiveContext({
  env: seeded.env,
  config: seeded.config,
  sessionId: seeded.sessionId
}));

/**
 * The Phase 3 numbers, printed rather than tallied by hand.
 *
 * LIVE AND PLANNER LATENCY ARE SEPARATE ROWS ON PURPOSE. Collapsing them is how
 * a background pass that never touched the reply path ends up looking like a
 * slow conversation — and how a genuinely slow reply hides behind a fast one.
 */
const metrics = {
  reconciliations: 0,
  applied: 0,
  rebased: 0,
  staleAttempts: 0,
  plannerFailures: 0,
  plannerCalls: 0,
  moduleInputsSatisfiedByPlanner: 0,
  redundantQuestionsAfterRepair: 0,
  falsePositiveCanonicalFacts: 0,
  responsePathAwaitedPlannerMs: 0,
  plannerLatencyMs: []
};

function reportMetrics() {
  const median = (values) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  console.info('\n[ConsumerLiveFeedback] PHASE 3 MEASUREMENT');
  console.info(`  reconciliations run                 : ${metrics.reconciliations}`);
  console.info(`  applied                             : ${metrics.applied}`);
  console.info(`  rebased onto newer state            : ${metrics.rebased}`);
  console.info(`  stale attempts (conflicted)         : ${metrics.staleAttempts}`);
  console.info(`  planner failures/timeouts           : ${metrics.plannerFailures}`);
  console.info(`  planner model calls                 : ${metrics.plannerCalls}`);
  console.info(`  module inputs missing -> satisfied  : ${metrics.moduleInputsSatisfiedByPlanner}`);
  console.info(`  redundant questions after repair    : ${metrics.redundantQuestionsAfterRepair}`);
  console.info(`  false-positive canonical facts      : ${metrics.falsePositiveCanonicalFacts}`);
  console.info(`  live reply awaited planner          : ${metrics.responsePathAwaitedPlannerMs}ms`);
  console.info(`  planner latency, median             : ${median(metrics.plannerLatencyMs)}ms (separate metric)`);
}

const stillNeededIds = (projection) => (projection.analyses || [])
  .flatMap((analysis) => (analysis.stillNeeded || []).map((need) => need.factId));

/** The rendered age entries, which unlike `capturedFactIds` name whose they are. */
const capturedAges = (projection) => (projection.captured || [])
  .filter((phrase) => /Current age/i.test(phrase));

/* =========================================================== CASES A/E/F == */

{
  const seeded = await seedMeeting('live-feedback-loop');
  const before = await projectionFor(seeded);
  const beforeContext = await loadAgentContext(
    seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
  );

  // The starting state IS the bug: the client said their age in the first
  // sentence and the analysis is still asking for it.
  assert.equal(beforeContext.profile.primaryPerson.age, undefined,
    'the fixture must reproduce the projection failure, not paper over it');
  assert.equal(Number(beforeContext.profile.partner?.age), 59,
    'the partner age must be on record so the two can be told apart afterwards');
  assert.ok(stillNeededIds(before).includes('person_current_age'),
    'the analysis must genuinely still be asking for the age');
  // Entity-aware, because `capturedFactIds` is a flat list of bare fact ids and
  // the PARTNER's age is already captured — comparing bare ids here would make
  // this whole check pass before the repair ever ran.
  assert.ok(capturedAges(before).some((phrase) => /59/.test(phrase)),
    'the partner age must read as captured');
  assert.ok(!capturedAges(before).some((phrase) => /57/.test(phrase)),
    'and the client\'s own age must not, which is the defect');

  /* CASE F — the module contract, before. */
  const pensionContract = getPlanningModuleDefinition('pension_projection')?.intakeContract;
  assert.ok(pensionContract?.semanticFactIds?.includes('person_current_age'),
    'pension_projection must genuinely require the current age, or this proves nothing');

  const { session, provider } = await liveSessionFor(seeded);
  const stub = stubModel(() => ageRepairPlan(seeded.turnId));

  // THE RESPONSE PATH IS NOT ALLOWED TO WAIT. Queueing is synchronous
  // bookkeeping; every model call lives behind the drain chain.
  const queuedAt = Date.now();
  session.queueReconciliation({
    providerItemId: 'item_live_1',
    throughTurnId: seeded.turnId,
    ordinal: 1,
    trigger: 'answered_need'
  });
  const queueReturnedMs = Date.now() - queuedAt;
  assert.ok(queueReturnedMs < 250,
    `queueing reconciliation must return immediately, took ${queueReturnedMs}ms`);
  assert.equal(provider.stateItems().length, 0,
    'queueing must not have pushed anything at the model yet');
  metrics.responsePathAwaitedPlannerMs = Math.max(
    metrics.responsePathAwaitedPlannerMs,
    queueReturnedMs
  );

  const plannerStartedAt = Date.now();
  try {
    await session.reconciliationChain;
  } finally { stub.restore(); }
  metrics.reconciliations += 1;
  metrics.plannerLatencyMs.push(Date.now() - plannerStartedAt);
  metrics.plannerCalls += stub.modelCalls();

  assert.equal(stub.modelCalls(), 1, 'exactly one planner call for one reconciliation');

  /* CASE A — the fact is canonical and the need is closed. */
  const afterContext = await loadAgentContext(
    seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
  );
  assert.equal(Number(afterContext.profile.primaryPerson.age), 57,
    'the reconciler must canonicalise the age the client actually gave');
  assert.ok(Number(afterContext.profile.revision) > Number(beforeContext.profile.revision),
    'an applied reconciliation must advance the canonical revision');

  const after = await projectionFor(seeded);
  assert.ok(!stillNeededIds(after).includes('person_current_age'),
    'CASE A: the satisfied need must stop being listed as still needed');
  assert.ok(capturedAges(after).some((phrase) => /57/.test(phrase)),
    `CASE A: the age must read as captured, got: ${JSON.stringify(capturedAges(after))}`);

  /* CASE E — primary and partner did not become interchangeable. */
  assert.equal(Number(afterContext.profile.partner.age), 59,
    'CASE E: the partner age must be untouched by a repair to the client');
  assert.notEqual(
    Number(afterContext.profile.primaryPerson.age),
    Number(afterContext.profile.partner.age),
    'CASE E: two people with different ages must keep them'
  );
  const ageNotes = (await listPlanningNotes(
    seeded.env, seeded.sessionId, seeded.meetingId, { limit: 100 }
  )).filter((note) => note.factId === 'person_current_age' && note.lifecycle === 'active');
  const primaryAgeNote = ageNotes.find((note) => note.entityId === 'primary');
  assert.ok(primaryAgeNote, 'CASE E: the repair must be recorded against the client, by identity');
  assert.equal(primaryAgeNote.source, 'planner_reconciliation');

  /* CASE F — the module contract, after. */
  assert.ok(stillNeededIds(before).includes('person_current_age')
    && !stillNeededIds(after).includes('person_current_age'),
  'CASE F: the required module input must move from missing to satisfied');
  metrics.applied += 1;
  metrics.moduleInputsSatisfiedByPlanner += stillNeededIds(before)
    .filter((factId) => !stillNeededIds(after).includes(factId)).length;
  // A canonical fact the client never supplied. The repair quoted "I'm 57"
  // from their own turn, so anything else appearing alongside it would be one.
  metrics.falsePositiveCanonicalFacts += Number(afterContext.profile.primaryPerson.age) === 57
    ? 0
    : 1;
  const remaining = stillNeededIds(after);
  assert.ok(remaining.length > 0,
    'CASE F: the analysis should still want its other inputs — a repair is not a shortcut to ready');
  assert.ok(remaining.every((factId) => factId !== 'person_current_age'),
    'CASE F: and none of them may be the one just supplied');

  /* THE LOOP CLOSES: the refreshed state reached the speaking model. */
  const items = provider.stateItems();
  assert.ok(items.length > 0,
    'an applied reconciliation must push a refreshed state item — a repair the conversation '
    + 'cannot see does not stop the next question');
  const latest = items.at(-1);
  assert.match(latest, /Already known/, 'the pushed item must be the live state note');
  const ageLabel = 'Current age';
  assert.ok(latest.includes(ageLabel),
    `the refreshed note must carry the repaired fact, got: ${latest.slice(0, 400)}`);
  // The decisive assertion. `liveVolatileStateItem` is what the model reads, so
  // building it from the refreshed projection and finding the age under "Needs"
  // would mean the conversation is still being told to ask.
  const needsSection = latest.slice(latest.indexOf('Analyses in play'));
  const stillAsksForAge = needsSection.includes(`Needs ${ageLabel}`)
    || needsSection.includes(`; ${ageLabel} —`);
  assert.ok(!stillAsksForAge,
    `CASE A: the refreshed note must not still list the age under Needs, got: ${needsSection.slice(0, 400)}`);
  metrics.redundantQuestionsAfterRepair += stillAsksForAge ? 1 : 0;

  console.info('[ConsumerLiveFeedback] PASS: CASE A/E/F — a repaired fact closes its own need, '
    + 'keeps its owner, and reaches the conversation');
}

/* ========== the client keeps talking while the planner is still thinking === */

{
  const seeded = await seedMeeting('live-feedback-interrupted');
  const { session, provider } = await liveSessionFor(seeded);

  // ONE MORE ORDINARY TURN, landing inside the model call. This is the case
  // that used to discard the whole batch, and it is the reason the Durable
  // Object has to hand the reconciler a way to reload canonical state — a
  // wiring the quiet-lane case above cannot exercise.
  const stub = stubModel(() => ageRepairPlan(seeded.turnId));
  const originalRequest = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.openai.com')) {
      await processAgentTurn(seeded.env, seeded.config, {
        sessionId: seeded.sessionId,
        meetingId: seeded.meetingId,
        message: 'My employer puts in 6% as well.',
        deps: {
          extractTurn: async ({ sourceTurnId }) => ({
            extraction: {
              schemaVersion: 'PlannerExtractionV3',
              sourceTurnId,
              goalCandidates: [],
              semanticFacts: [{
                candidateId: 'x1',
                operation: 'upsert',
                factId: 'pension_employer_contribution_rate',
                value: 6,
                certainty: 'exact',
                evidenceText: 'My employer puts in 6% as well.',
                correctionTarget: ''
              }],
              positions: [],
              sectionCompletions: [],
              invalidCandidates: [],
              clientQuestion: { present: false, intent: 'none', topic: '', questionText: '' },
              ambiguities: [],
              narrativeSummary: { summary: '', evidence: [] }
            },
            metadata: { costMicroEur: 0 }
          }),
          renderText: SILENT_RENDERER
        }
      });
    }
    return originalRequest(url, init);
  };

  session.queueReconciliation({
    providerItemId: 'item_live_interrupted',
    throughTurnId: seeded.turnId,
    ordinal: 1,
    trigger: 'answered_need'
  });
  try {
    await session.reconciliationChain;
  } finally { globalThis.fetch = originalRequest; stub.restore(); }

  const afterContext = await loadAgentContext(
    seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
  );
  assert.equal(Number(afterContext.profile.primaryPerson.age), 57,
    'the repair must survive a client turn arriving during the planner call — this is the '
    + 'Durable Object\'s own rebase wiring, and without it the correction is silently lost');
  assert.equal(stub.modelCalls(), 1,
    'and it must cost exactly one planner call');
  assert.ok(provider.stateItems().length > 0,
    'the refreshed state must still reach the conversation after a rebase');
  metrics.reconciliations += 1;
  metrics.applied += 1;
  metrics.rebased += 1;
  // The first attempt genuinely did go stale. That it was recovered rather than
  // discarded is the point, so both numbers are worth carrying.
  metrics.staleAttempts += 1;
  metrics.plannerCalls += stub.modelCalls();
  console.info('[ConsumerLiveFeedback] PASS: the Durable Object rebases rather than losing the '
    + 'correction to an active client');
}

/* ============================ a failed reconciliation says nothing new ==== */

{
  const seeded = await seedMeeting('live-feedback-failure');
  const beforeContext = await loadAgentContext(
    seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
  );
  const { session, provider } = await liveSessionFor(seeded);
  const stub = stubModel(() => {
    const error = new Error('The background planner timed out.');
    error.code = 'planner_reconciliation_timeout';
    return error;
  });
  session.queueReconciliation({
    providerItemId: 'item_live_fail',
    throughTurnId: seeded.turnId,
    ordinal: 1,
    trigger: 'material_turn'
  });
  try {
    await session.reconciliationChain;
  } finally { stub.restore(); }
  metrics.reconciliations += 1;
  metrics.plannerFailures += 1;
  metrics.plannerCalls += stub.modelCalls();

  const afterContext = await loadAgentContext(
    seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
  );
  assert.equal(Number(afterContext.profile.revision), Number(beforeContext.profile.revision),
    'a planner timeout must not move canonical state');
  assert.equal(afterContext.profile.primaryPerson.age, undefined,
    'a planner timeout must not invent the thing it failed to work out');
  assert.equal(provider.stateItems().length, 0,
    'a failed reconciliation must not push a state item claiming a refresh that never happened');

  // AND THE MEETING IS STILL LIVE. Nothing about the failure terminalised it or
  // left the drain wedged.
  assert.equal(session.pendingReconciliationTurn, null,
    'a terminal failure must clear the durable job rather than spin on it');
  const projection = await projectionFor(seeded);
  assert.ok(stillNeededIds(projection).includes('person_current_age'),
    'the need simply stays open, which is the honest state after a failed repair');
  console.info('[ConsumerLiveFeedback] PASS: a planner failure leaves the meeting running and the '
    + 'state honest');
}

/* ======================= nothing model-shaped on the spoken reply path ==== */

{
  const source = readFileSync(
    new URL('../worker/src/consumer/live/live_session.js', import.meta.url),
    'utf8'
  );
  // The drain — the only thing that calls the reconciler — must be reached
  // through waitUntil, never awaited by a handler on the way to speech.
  assert.match(source, /this\.state\.waitUntil\(this\.reconciliationChain/,
    'the reconciliation chain must be detached through waitUntil');
  assert.match(source, /maybeScheduleReconciliation\(settledResponse\)|if \(settledResponse\) this\.maybeScheduleReconciliation/,
    'reconciliation must be scheduled only once the response has settled');
  // The rebase is deterministic re-projection. If it ever grew its own model
  // call, the background pass would double in length for no new information.
  const reconciliationSource = readFileSync(
    new URL('../worker/src/consumer/planner_reconciliation.js', import.meta.url),
    'utf8'
  );
  assert.match(reconciliationSource, /preparedPlan\s*\)?\s*{?\s*\n?\s*\/\/|if \(preparedPlan\)/,
    'a rebase must reuse the plan it already has');
  const requestCallSites = [...reconciliationSource.matchAll(/await requestPlannerReconciliation\(/g)];
  assert.equal(requestCallSites.length, 1,
    'there must remain exactly one place a reconciliation model call is issued');
  console.info('[ConsumerLiveFeedback] PASS: the planner stays off the spoken reply path');
}

/* ================ the state note the model reads is what we asserted on ==== */

{
  // Guards the assertion above against drifting apart from production: if the
  // renderer stops emitting "Needs", the CASE A check would pass vacuously.
  const rendered = liveVolatileStateItem({
    captured: ['Current age: 57'],
    analyses: [{
      description: 'a pension projection',
      status: 'needs_facts',
      stillNeeded: [{ factId: 'intended_retirement_age', whose: '', why: 'to project forward' }],
      mayAssume: []
    }],
    missing: ['intended_retirement_age'],
    unknown: [],
    blocked: [],
    goalsAgreed: true,
    readyToConfirm: false
  });
  assert.match(rendered, /Needs /,
    'the volatile state note must still express outstanding items as "Needs ..."');
  assert.match(rendered, /Already known/,
    'the volatile state note must still lead with what is already known');
  console.info('[ConsumerLiveFeedback] PASS: the state-note contract under test is the live one');
}

reportMetrics();

console.info('\n[ConsumerLiveFeedback] PASS: the background planner improves the live conversation');
