#!/usr/bin/env node

/**
 * PHASE 3 — the planner's answer surviving a client who keeps talking.
 *
 * The completion is a whole-profile write at `baseRevision + 1`, so it must fail
 * closed when the base has moved. That is right, and it is unchanged. What was
 * wrong was the consequence: ONE ordinary fact write landing during the fifteen-
 * to-twenty-second model call discarded the entire validated batch. In a live
 * meeting the client is answering questions and `save_facts` is firing, so the
 * corrections were being thrown away precisely when the conversation was most
 * active — which is why the meeting went on asking for what the planner had
 * already worked out.
 *
 * These checks pin the two halves of the repair:
 *
 *   1. a conflicted completion writes NOTHING — not the profile, and not the
 *      ledger either, which it used to do; and
 *   2. the validated plan is re-projected onto the newer canonical state
 *      without a second model call, so the correction lands and the client's
 *      intervening answer is still there.
 *
 * The model is stubbed. The validator, projector, ledger and CAS guards are the
 * production ones.
 */

import assert from 'node:assert/strict';

import { loadAgentContext, processAgentTurn } from '../worker/src/consumer/agent_session.js';
import { runPlannerReconciliation } from '../worker/src/consumer/planner_reconciliation.js';
import { listPlanningNotes } from '../worker/src/consumer/realtime_repository.js';
import { makeConfig, makeEnv, newDatabase, newSession } from './agent-harness/transports.mjs';

const TRANSCRIPT = 'I have an old DC pension worth about €319,000 and a current occupational '
  + 'pension of about €339,000. Together they are about €658,000, which is just the two of them '
  + 'added up, not a third pension. We spend about 5,800 a month.';

const INTERRUPTION = 'I also have a Zurich PRSA of 415,000.';

const position = (candidateId, entityId, label, amount, over = {}) => ({
  candidateId,
  operation: 'upsert',
  kind: 'pension',
  label,
  entityId,
  linkedEntityId: '',
  amount: amount === null ? null : { amount, currency: 'EUR' },
  country: '',
  owner: 'primary',
  propertyUse: null,
  pensionType: 'occupational',
  incomeType: null,
  agricultural: null,
  certainty: 'exact',
  evidenceText: TRANSCRIPT,
  correctionTarget: '',
  ...over
});

const extractionOf = (sourceTurnId, { positions = [], semanticFacts = [] }) => ({
  schemaVersion: 'PlannerExtractionV3',
  sourceTurnId,
  goalCandidates: [],
  semanticFacts,
  positions,
  sectionCompletions: [],
  invalidCandidates: [],
  clientQuestion: { present: false, intent: 'none', topic: '', questionText: '' },
  ambiguities: [],
  narrativeSummary: { summary: '', evidence: [] }
});

const SILENT_RENDERER = async ({ context }) => ({
  text: 'Thanks, I have noted those.',
  fallback: false, decisions: [], usageMicroEur: 0, context
});

async function seedMeeting(label, mode = 'apply') {
  const env = makeEnv(newDatabase(label), { CONSUMER_PLANNER_RECONCILIATION_MODE: mode });
  const config = makeConfig(env);
  const { sessionId, meetingId } = await newSession(env, config);
  await processAgentTurn(env, config, {
    sessionId,
    meetingId,
    message: TRANSCRIPT,
    deps: {
      extractTurn: async ({ sourceTurnId }) => ({
        extraction: extractionOf(sourceTurnId, {
          positions: [
            position('p1', 'old_dc', 'Old DC pension', 319_000),
            position('p2', 'current_dc', 'Current occupational pension', 339_000),
            // The defect the architecture exists to correct: a stated total
            // recorded as though it were another holding.
            position('p3', 'pensions_total', 'Pensions total', 658_000)
          ],
          semanticFacts: [{
            candidateId: 's1',
            operation: 'upsert',
            factId: 'monthly_spending',
            value: { amount: 5_800, currency: 'EUR' },
            certainty: 'approximate',
            evidenceText: TRANSCRIPT,
            correctionTarget: ''
          }]
        }),
        metadata: { costMicroEur: 0 }
      }),
      renderText: SILENT_RENDERER
    }
  });
  const context = await loadAgentContext(env, config, sessionId, meetingId);
  const turn = await env.CONSUMER_DB.prepare(`
    SELECT id FROM consumer_realtime_final_turns
    WHERE session_id = ? AND realtime_session_id = ? AND role = 'user'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).bind(sessionId, meetingId).first();
  return { env, config, sessionId, meetingId, context, turnId: turn.id };
}

/** One more ordinary client turn, exactly as the live lane would land it. */
async function interrupt(seeded) {
  await processAgentTurn(seeded.env, seeded.config, {
    sessionId: seeded.sessionId,
    meetingId: seeded.meetingId,
    message: INTERRUPTION,
    deps: {
      extractTurn: async ({ sourceTurnId }) => ({
        extraction: extractionOf(sourceTurnId, {
          positions: [position('i1', 'zurich_prsa', 'Zurich PRSA', 415_000, {
            pensionType: 'prsa',
            evidenceText: INTERRUPTION
          })]
        }),
        metadata: { costMicroEur: 0 }
      }),
      renderText: SILENT_RENDERER
    }
  });
}

/**
 * The stub. `onCall` fires INSIDE the model call, which is the only place a
 * concurrent client turn can produce the race this file is about.
 */
function stubModel(planFor, { onCall = null } = {}) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.openai.com')) return original(url, init);
    calls += 1;
    if (onCall) await onCall(calls);
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
  operationId: 'op', op: 'upsert_note', targetNoteId: '', factId: 'pension_positions',
  factInstanceId: '', entityId: '', ownerId: '', noteKind: 'position', certainty: 'exact',
  targetEntityId: '', sourceEntityIds: [], valueJson: '{}', reasonCode: 'missing_note',
  evidence: [], ...over
});

/** Reclassify the stated total from a holding to a summary. */
function reclassifyTotalPlan(notes, turnId) {
  const total = notes.find((note) => (
    note.noteKind === 'position' && Number(note.value?.currentValue?.amount) === 658_000
  ));
  assert.ok(total, 'fixture note for the stated total is missing');
  return {
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{
      groupId: 'reclassify_total',
      atomic: false,
      operations: [operation({
        operationId: 'reclassify_total',
        op: 'reclassify_note',
        targetNoteId: total.noteId,
        factId: 'pension_positions',
        factInstanceId: total.factInstanceId,
        entityId: total.entityId,
        ownerId: 'primary',
        noteKind: 'summary',
        certainty: 'approximate',
        reasonCode: 'aggregate_summary',
        valueJson: JSON.stringify({
          label: 'Stated pension total',
          amount: { amount: 658_000, currency: 'EUR' }
        }),
        evidence: [{ turnId, quote: 'Together they are about €658,000' }]
      })]
    }]
  };
}

const pensionAmounts = (profile) => profile.pensions
  .map((item) => Number(item.currentValue?.amount || 0)).sort((a, b) => a - b);

const monthlySpend = (profile) => Number(profile?.expenses?.monthlyEssential?.amount ?? NaN);

/* ============================================================== CASE C ==== */
/* The planner is slower than the conversation.                               */

{
  const seeded = await seedMeeting('reconciliation-rebase-case-c');
  const notes = await listPlanningNotes(seeded.env, seeded.sessionId, seeded.meetingId, { limit: 50 });
  const baseRevision = Number(seeded.context.profile.revision);

  const stub = stubModel(() => reclassifyTotalPlan(notes, seeded.turnId), {
    onCall: async () => { await interrupt(seeded); }
  });
  let result;
  try {
    result = await runPlannerReconciliation({
      env: seeded.env,
      config: seeded.config,
      context: seeded.context,
      leaseId: seeded.meetingId,
      throughTurnId: seeded.turnId,
      loadContext: () => loadAgentContext(
        seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
      )
    });
  } finally { stub.restore(); }

  assert.equal(result.status, 'applied',
    `a client turn during the model call must not discard the correction, got ${result.status}`);
  assert.deepEqual(result.rebasedFromRevisions, [baseRevision],
    'the outcome must record that it was re-projected onto newer state');
  assert.equal(stub.modelCalls(), 1,
    'a rebase re-runs the DETERMINISTIC half only — a second model call would be a second bill '
    + 'and a second chance for the model to answer differently');

  const after = await loadAgentContext(
    seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
  );
  assert.deepEqual(pensionAmounts(after.profile), [319_000, 339_000, 415_000],
    'the phantom total must be gone AND the answer given during the model call must survive');
  assert.equal(after.profile.assumptions.values.planning.statedSummaries.length, 1,
    'the total must survive as a stated summary');
  console.info('[ConsumerReconciliationRebase] PASS: CASE C — a turn during the model call no longer '
    + 'costs the correction');
}

/* A conflicted completion writes nothing at all. */
{
  const seeded = await seedMeeting('reconciliation-rebase-conflict-atomic');
  const notes = await listPlanningNotes(seeded.env, seeded.sessionId, seeded.meetingId, { limit: 50 });

  // No loadContext: the conflict stays terminal, which is what isolates the
  // question this block asks — what did the CONFLICTED attempt leave behind?
  const stub = stubModel(() => reclassifyTotalPlan(notes, seeded.turnId), {
    onCall: async () => { await interrupt(seeded); }
  });
  let result;
  try {
    result = await runPlannerReconciliation({
      env: seeded.env,
      config: seeded.config,
      context: seeded.context,
      leaseId: seeded.meetingId,
      throughTurnId: seeded.turnId
    });
  } finally { stub.restore(); }

  assert.equal(result.status, 'conflicted');
  const after = await loadAgentContext(
    seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
  );
  assert.deepEqual(pensionAmounts(after.profile), [319_000, 339_000, 415_000, 658_000],
    'a conflicted reconciliation must leave the profile exactly as the client left it');

  // THE HALF THAT USED TO LEAK. `revision` is `baseRevision + 1`, and one
  // ordinary fact write moves the session to `baseRevision + 1` too, so a guard
  // that only compared revision numbers matched a revision this reconciliation
  // never computed against. The ledger was reclassified while the profile was
  // refused, and nothing reported a fault.
  const ledger = await listPlanningNotes(
    seeded.env, seeded.sessionId, seeded.meetingId, { limit: 50 }
  );
  assert.equal(
    ledger.filter((note) => note.source === 'planner_reconciliation').length,
    0,
    'a conflicted reconciliation must not write ledger notes either — a reclassified note beside '
    + 'an unreclassified profile is a divergence nothing downstream can detect'
  );
  const total = ledger.find((note) => (
    note.noteKind === 'position' && Number(note.value?.currentValue?.amount) === 658_000
  ));
  assert.equal(total?.lifecycle, 'active',
    'the note the refused operation targeted must remain active and repairable');
  console.info('[ConsumerReconciliationRebase] PASS: a conflicted completion writes neither profile '
    + 'nor ledger');
}

/* Newer canonical state wins: a stale operation is refused, not applied over. */
{
  const seeded = await seedMeeting('reconciliation-rebase-stale-refused');
  const notes = await listPlanningNotes(seeded.env, seeded.sessionId, seeded.meetingId, { limit: 50 });
  const oldDc = notes.find((note) => (
    note.noteKind === 'position' && Number(note.value?.currentValue?.amount) === 319_000
  ));

  // The plan corrects the old DC pension to a figure the client has by then
  // moved past. On the rebase this operation is re-validated against the state
  // it would actually be written onto.
  const stalePlan = () => ({
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{
      groupId: 'stale_correction',
      atomic: false,
      operations: [operation({
        operationId: 'stale_correction',
        op: 'correct_note',
        targetNoteId: oldDc.noteId,
        factInstanceId: oldDc.factInstanceId,
        entityId: oldDc.entityId,
        ownerId: 'primary',
        noteKind: 'position',
        certainty: 'exact',
        reasonCode: 'explicit_correction',
        // 777,000 is said by nobody, in any turn.
        valueJson: JSON.stringify({
          pensionId: oldDc.entityId, ownerId: 'primary', type: 'occupational',
          currentValue: { amount: 777_000, currency: 'EUR' }
        }),
        evidence: [{ turnId: seeded.turnId, quote: 'an old DC pension worth about €319,000' }]
      })]
    }]
  });

  const stub = stubModel(stalePlan, { onCall: async () => { await interrupt(seeded); } });
  let result;
  try {
    result = await runPlannerReconciliation({
      env: seeded.env,
      config: seeded.config,
      context: seeded.context,
      leaseId: seeded.meetingId,
      throughTurnId: seeded.turnId,
      loadContext: () => loadAgentContext(
        seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
      )
    });
  } finally { stub.restore(); }

  const after = await loadAgentContext(
    seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
  );
  assert.ok(!pensionAmounts(after.profile).includes(777_000),
    'an ungrounded value must never reach the profile, on a rebase least of all');
  assert.ok(pensionAmounts(after.profile).includes(319_000),
    'the value the client actually gave must stand');
  assert.ok((result.validation?.rejectedGroups || []).length > 0,
    'the refusal must be reported as a rejection rather than disappearing');
  console.info('[ConsumerReconciliationRebase] PASS: a rebase re-validates in full — newer state '
    + 'refuses a stale operation rather than being overwritten by it');
}

/* ============================================================== CASE B ==== */
/* A correction, and the conversation afterwards using the corrected figure.  */

{
  const seeded = await seedMeeting('reconciliation-rebase-case-b');
  assert.equal(monthlySpend(seeded.context.profile), 5_800,
    'the fixture must start from the figure the client first gave');

  // The client corrects themselves; T1 records it as it always would.
  await processAgentTurn(seeded.env, seeded.config, {
    sessionId: seeded.sessionId,
    meetingId: seeded.meetingId,
    message: 'Actually, make that 6,200 a month — I recalculated.',
    deps: {
      extractTurn: async ({ sourceTurnId }) => ({
        extraction: extractionOf(sourceTurnId, {
          semanticFacts: [{
            candidateId: 'c1',
            operation: 'upsert',
            factId: 'monthly_spending',
            value: { amount: 6_200, currency: 'EUR' },
            certainty: 'exact',
            evidenceText: 'Actually, make that 6,200 a month — I recalculated.',
            correctionTarget: ''
          }]
        }),
        metadata: { costMicroEur: 0 }
      }),
      renderText: SILENT_RENDERER
    }
  });

  const corrected = await loadAgentContext(
    seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
  );
  assert.equal(monthlySpend(corrected.profile), 6_200, 'the corrected figure must be canonical');

  const ledger = await listPlanningNotes(
    seeded.env, seeded.sessionId, seeded.meetingId, { limit: 50 }
  );
  const spendNotes = ledger.filter((note) => note.factId === 'monthly_spending');
  const superseded = spendNotes.find((note) => note.lifecycle === 'superseded');
  const active = spendNotes.find((note) => note.lifecycle === 'active');
  assert.ok(superseded, 'the earlier figure must be superseded, not deleted');
  assert.equal(active?.lifecycle, 'active', 'exactly the corrected figure stays active');

  // And what the conversation is told next reflects it: no analysis is still
  // asking for a figure the client has now given twice.
  const stillNeeded = (corrected.state?.recommendations || [])
    .flatMap((item) => item.requiredMissing || [])
    .filter((need) => need.factId === 'monthly_spending' && need.status !== 'satisfied');
  assert.equal(stillNeeded.length, 0,
    'a corrected figure must not leave its own need open');
  console.info('[ConsumerReconciliationRebase] PASS: CASE B — €5,800 → €6,200 supersedes and the '
    + 'need closes');
}

/* ============================================================== CASE D ==== */
/* Reconciliation fails; the meeting is unaffected and can recover.           */

{
  const seeded = await seedMeeting('reconciliation-rebase-case-d');
  const before = pensionAmounts(seeded.context.profile);
  const beforeRevision = Number(seeded.context.profile.revision);

  const timeout = stubModel(() => {
    const error = new Error('The background planner timed out.');
    error.code = 'planner_reconciliation_timeout';
    return error;
  });
  let threw = null;
  try {
    await runPlannerReconciliation({
      env: seeded.env,
      config: seeded.config,
      context: seeded.context,
      leaseId: seeded.meetingId,
      throughTurnId: seeded.turnId,
      loadContext: () => loadAgentContext(
        seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
      )
    });
  } catch (error) { threw = error; } finally { timeout.restore(); }

  assert.ok(threw, 'a planner outage must surface to the scheduler rather than look like success');
  const afterFailure = await loadAgentContext(
    seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
  );
  assert.equal(Number(afterFailure.profile.revision), beforeRevision,
    'a failure must not advance the canonical revision');
  assert.deepEqual(pensionAmounts(afterFailure.profile), before,
    'a failure must not corrupt canonical state');

  // THE MEETING CARRIES ON. The next client turn is recorded and applied
  // exactly as if no reconciliation had been attempted.
  await interrupt(seeded);
  const afterTurn = await loadAgentContext(
    seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
  );
  assert.ok(pensionAmounts(afterTurn.profile).includes(415_000),
    'the conversation must keep working after a planner failure');

  // AND IT CAN BE REPAIRED LATER. A subsequent pass, from the newer state,
  // still fixes what the failed one could not.
  const notesNow = await listPlanningNotes(
    seeded.env, seeded.sessionId, seeded.meetingId, { limit: 50 }
  );
  const recovery = stubModel(() => reclassifyTotalPlan(notesNow, seeded.turnId));
  let recovered;
  try {
    recovered = await runPlannerReconciliation({
      env: seeded.env,
      config: seeded.config,
      context: afterTurn,
      leaseId: seeded.meetingId,
      throughTurnId: seeded.turnId,
      loadContext: () => loadAgentContext(
        seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
      )
    });
  } finally { recovery.restore(); }
  assert.equal(recovered.status, 'applied', 'a later pass must be able to recover the correction');
  const afterRecovery = await loadAgentContext(
    seeded.env, seeded.config, seeded.sessionId, seeded.meetingId
  );
  assert.deepEqual(pensionAmounts(afterRecovery.profile), [319_000, 339_000, 415_000],
    'the recovered pass must remove the phantom without losing anything since');
  console.info('[ConsumerReconciliationRebase] PASS: CASE D — a failure stops nothing and is '
    + 'recoverable');
}

/* Without a context loader the behaviour is exactly what it was. */
{
  const seeded = await seedMeeting('reconciliation-rebase-optional');
  const notes = await listPlanningNotes(seeded.env, seeded.sessionId, seeded.meetingId, { limit: 50 });
  const stub = stubModel(() => reclassifyTotalPlan(notes, seeded.turnId));
  let result;
  try {
    result = await runPlannerReconciliation({
      env: seeded.env,
      config: seeded.config,
      context: seeded.context,
      leaseId: seeded.meetingId,
      throughTurnId: seeded.turnId
    });
  } finally { stub.restore(); }
  assert.equal(result.status, 'applied');
  assert.equal(result.rebasedFromRevisions, undefined,
    'an uncontended reconciliation must not report a rebase it never made');
  console.info('[ConsumerReconciliationRebase] PASS: an uncontended pass is unchanged');
}

console.info('[ConsumerReconciliationRebase] PASS: the planner\'s answer survives an active meeting');
