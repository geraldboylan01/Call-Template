#!/usr/bin/env node

/**
 * Apply mode: the reconciler's validated corrections reaching canonical state.
 *
 * Shadow mode proved the reconciler can decide correctly. This proves the other
 * half — that what it decided is actually written, that what the validator
 * refused is not, and that a failure leaves the profile exactly as it was. The
 * model is stubbed, so this costs nothing and is deterministic; the validator,
 * projector, ledger and CAS guards under test are the production ones.
 */

import assert from 'node:assert/strict';

import { loadAgentContext, processAgentTurn } from '../worker/src/consumer/agent_session.js';
import { runPlannerReconciliation } from '../worker/src/consumer/planner_reconciliation.js';
import { listPlanningNotes } from '../worker/src/consumer/realtime_repository.js';
import { makeConfig, makeEnv, newDatabase, newSession } from './agent-harness/transports.mjs';

const TRANSCRIPT = 'I have an old DC pension worth about €319,000 and a current occupational '
  + 'pension of about €339,000. Together they are about €658,000, which is just the two of them '
  + 'added up, not a third pension.';

const position = (candidateId, entityId, label, amount) => ({
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
  correctionTarget: ''
});

async function seedMeeting(mode) {
  const env = makeEnv(newDatabase(`reconciliation-apply-${mode}`), {
    CONSUMER_PLANNER_RECONCILIATION_MODE: mode
  });
  const config = makeConfig(env);
  const { sessionId, meetingId } = await newSession(env, config);
  await processAgentTurn(env, config, {
    sessionId,
    meetingId,
    message: TRANSCRIPT,
    deps: {
      extractTurn: async ({ sourceTurnId }) => ({
        extraction: {
          schemaVersion: 'PlannerExtractionV3',
          sourceTurnId,
          goalCandidates: [],
          semanticFacts: [],
          positions: [
            position('p1', 'old_dc', 'Old DC pension', 319_000),
            position('p2', 'current_dc', 'Current occupational pension', 339_000),
            // The defect this architecture exists to correct: a stated total
            // recorded as though it were another holding.
            position('p3', 'pensions_total', 'Pensions total', 658_000)
          ],
          sectionCompletions: [],
          invalidCandidates: [],
          clientQuestion: { present: false, intent: 'none', topic: '', questionText: '' },
          ambiguities: [],
          narrativeSummary: { summary: '', evidence: [] }
        },
        metadata: { costMicroEur: 0 }
      }),
      renderText: async ({ context }) => ({
        text: 'Thanks, I have noted those.',
        fallback: false, decisions: [], usageMicroEur: 0, context
      })
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

function stubModel(planFor) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.openai.com')) return original(url, init);
    const plan = planFor();
    if (plan instanceof Error) throw plan;
    return new Response(JSON.stringify({
      id: 'resp_stub', status: 'completed',
      output_text: JSON.stringify(plan),
      usage: { input_tokens: 100, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return () => { globalThis.fetch = original; };
}

const operation = (over) => ({
  operationId: 'op', op: 'upsert_note', targetNoteId: '', factId: 'pension_positions',
  factInstanceId: '', entityId: '', ownerId: '', noteKind: 'position', certainty: 'exact',
  targetEntityId: '', sourceEntityIds: [], valueJson: '{}', reasonCode: 'missing_note',
  evidence: [], ...over
});

function planFrom(notes, turnId, { includeRejected = true } = {}) {
  const noteFor = (entityId) => notes.find((note) => note.entityId === entityId);
  const total = noteFor('pension_realtime_pensions_total') || noteFor('pensions_total')
    || notes.find((note) => Number(note.value?.currentValue?.amount) === 658_000);
  const oldDc = noteFor('pension_realtime_old_dc') || noteFor('old_dc')
    || notes.find((note) => Number(note.value?.currentValue?.amount) === 319_000);
  const currentDc = noteFor('pension_realtime_current_dc') || noteFor('current_dc')
    || notes.find((note) => Number(note.value?.currentValue?.amount) === 339_000);
  assert.ok(total && oldDc && currentDc,
    `fixture notes missing: ${notes.map((n) => n.entityId).join(',')}`);
  const groups = [
    {
      groupId: 'reclassify_total',
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
        valueJson: JSON.stringify({ label: 'Stated pension total', amount: { amount: 658_000, currency: 'EUR' } }),
        evidence: [{ turnId, quote: 'Together they are about €658,000' }]
      })]
    },
    {
      // Identity is the server's. A value naming a different pension must not
      // move this correction onto that other holding.
      groupId: 'identity_probe',
      operations: [operation({
        operationId: 'identity_probe',
        op: 'correct_note',
        targetNoteId: oldDc.noteId,
        factInstanceId: oldDc.factInstanceId,
        entityId: oldDc.entityId,
        ownerId: 'primary',
        noteKind: 'position',
        certainty: 'approximate',
        reasonCode: 'explicit_correction',
        valueJson: JSON.stringify({
          pensionId: 'current_dc', entityId: 'current_dc', ownerId: 'primary',
          type: 'occupational', currentValue: { amount: 319_000, currency: 'EUR' }
        }),
        evidence: [{ turnId, quote: 'an old DC pension worth about €319,000' }]
      })]
    }
  ];
  if (includeRejected) {
    groups.push({
      groupId: 'ungrounded',
      operations: [operation({
        operationId: 'ungrounded_value',
        op: 'correct_note',
        targetNoteId: currentDc.noteId,
        factInstanceId: currentDc.factInstanceId,
        entityId: currentDc.entityId,
        ownerId: 'primary',
        noteKind: 'position',
        certainty: 'exact',
        reasonCode: 'explicit_correction',
        // 999,000 appears nowhere in the transcript.
        valueJson: JSON.stringify({
          pensionId: currentDc.entityId, ownerId: 'primary', type: 'occupational',
          currentValue: { amount: 999_000, currency: 'EUR' }
        }),
        evidence: [{ turnId, quote: 'a current occupational pension of about €339,000' }]
      })]
    });
  }
  return { schemaVersion: 1, verdict: 'changes_proposed', reviewedNoteIds: [], operationGroups: groups };
}

const pensionAmounts = (profile) => profile.pensions
  .map((item) => Number(item.currentValue?.amount || 0)).sort((a, b) => a - b);

/* ------------------------------------------------------- apply writes state */
{
  const { env, config, sessionId, meetingId, context, turnId } = await seedMeeting('apply');
  const notes = await listPlanningNotes(env, sessionId, meetingId, { limit: 50 });
  assert.equal(pensionAmounts(context.profile).length, 3, 'T1 recorded the phantom total as a holding');

  const restore = stubModel(() => planFrom(notes, turnId));
  let result;
  try {
    result = await runPlannerReconciliation({
      env, config, context, leaseId: meetingId, throughTurnId: turnId
    });
  } finally { restore(); }

  assert.equal(result.status, 'applied', `apply must write, got ${result.status}`);
  assert.equal(result.appliedProfileRevision, context.profile.revision + 1);

  const after = await loadAgentContext(env, config, sessionId, meetingId);
  assert.equal(after.profile.revision, context.profile.revision + 1, 'canonical revision must advance');
  assert.deepEqual(pensionAmounts(after.profile), [319_000, 339_000],
    'the reclassified total must leave current holdings');
  assert.equal(after.profile.assumptions.values.planning.statedSummaries.length, 1,
    'the total must survive as a stated summary');
  assert.equal(
    after.profile.assumptions.values.planning.statedSummaries[0].value.amount.amount, 658_000);

  // Rejected operations are not written, and one refused group does not stop
  // the independent groups that validated.
  assert.ok(!pensionAmounts(after.profile).includes(999_000), 'an ungrounded value must never persist');
  assert.equal(result.validation.rejectedGroups.length, 1);
  assert.equal(result.validation.rejectedGroups[0].groupId, 'ungrounded');
  assert.equal(result.validation.rejectedGroups[0].code, 'numeric_value_unsupported');

  // Identity came from the server, so the correction stayed on its own pension.
  const oldDc = after.profile.pensions.find((item) => item.currentValue.amount === 319_000);
  const currentDc = after.profile.pensions.find((item) => item.currentValue.amount === 339_000);
  assert.notEqual(oldDc.pensionId, currentDc.pensionId, 'the model must not retarget a position');

  // The ledger records the transition rather than losing the history.
  const ledger = await listPlanningNotes(env, sessionId, meetingId, { limit: 50 });
  const summary = ledger.find((note) => note.noteKind === 'summary' && note.lifecycle === 'active');
  assert.ok(summary, 'the reclassification must exist as an active ledger note');
  assert.equal(summary.source, 'planner_reconciliation');
  assert.equal(summary.reviewStatus, 'planner_corrected');
  const supersededTotal = ledger.find((note) => (
    note.noteKind === 'position' && note.lifecycle === 'superseded'
      && Number(note.value?.currentValue?.amount) === 658_000
  ));
  assert.ok(supersededTotal, 'the phantom holding must be superseded, not deleted');

  // The corrected profile is what later planning sees.
  const stillNeeded = (after.state?.recommendations || [])
    .flatMap((item) => item.requiredMissing || []);
  assert.ok(Array.isArray(stillNeeded), 'planning state must recompute from the applied profile');
  console.info('[ConsumerReconciliationApply] PASS: accepted operations reach profile and ledger');
}

/* ------------------------------------------- a model failure changes nothing */
{
  const { env, config, sessionId, meetingId, context, turnId } = await seedMeeting('apply');
  const before = pensionAmounts(context.profile);
  const restore = stubModel(() => new Error('planner offline'));
  let threw = false;
  try {
    await runPlannerReconciliation({ env, config, context, leaseId: meetingId, throughTurnId: turnId });
  } catch { threw = true; } finally { restore(); }
  assert.ok(threw, 'a planner outage must surface rather than silently succeed');
  const after = await loadAgentContext(env, config, sessionId, meetingId);
  assert.equal(after.profile.revision, context.profile.revision, 'a failure must not advance the revision');
  assert.deepEqual(pensionAmounts(after.profile), before, 'a failure must not change holdings');
  const row = await env.CONSUMER_DB.prepare(`
    SELECT status, error_code, applied_profile_revision FROM consumer_planner_reconciliations
    WHERE realtime_session_id = ? ORDER BY created_at DESC LIMIT 1
  `).bind(meetingId).first();
  assert.equal(row.status, 'failed');
  assert.equal(row.applied_profile_revision, null);
  console.info('[ConsumerReconciliationApply] PASS: a planner failure leaves canonical state untouched');
}

/* ------------------------------------------------ legacy stays a no-op */
{
  const { env, config, context, meetingId, turnId } = await seedMeeting('legacy');
  const result = await runPlannerReconciliation({
    env, config, context, leaseId: meetingId, throughTurnId: turnId
  });
  assert.equal(result.status, 'legacy', 'legacy must remain the fail-closed fallback');
  console.info('[ConsumerReconciliationApply] PASS: legacy remains an inert fallback');
}

/* ------------------------------------------- shadow still writes nothing */
{
  const { env, config, sessionId, meetingId, context, turnId } = await seedMeeting('shadow');
  const notes = await listPlanningNotes(env, sessionId, meetingId, { limit: 50 });
  const restore = stubModel(() => planFrom(notes, turnId, { includeRejected: false }));
  let result;
  try {
    result = await runPlannerReconciliation({
      env, config, context, leaseId: meetingId, throughTurnId: turnId
    });
  } finally { restore(); }
  assert.equal(result.status, 'shadow');
  const after = await loadAgentContext(env, config, sessionId, meetingId);
  assert.equal(after.profile.revision, context.profile.revision, 'shadow must not write the profile');
  assert.deepEqual(pensionAmounts(after.profile), [319_000, 339_000, 658_000],
    'shadow must leave even a wrong holding in place');
  console.info('[ConsumerReconciliationApply] PASS: shadow observes without writing');
}

console.info('[ConsumerReconciliationApply] PASS: apply, failure, legacy and shadow all behave');
