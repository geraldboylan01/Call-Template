#!/usr/bin/env node

import assert from 'node:assert/strict';

import { loadAgentContext, processAgentTurn } from '../worker/src/consumer/agent_session.js';
import {
  completePlannerReconciliation,
  listPlanningNotes,
  loadPlannerReconciliation,
  startPlannerReconciliation
} from '../worker/src/consumer/realtime_repository.js';
import {
  makeConfig,
  makeEnv,
  newDatabase,
  newSession
} from './agent-harness/transports.mjs';

const databasePath = newDatabase('planning-reconciliation-persistence');
const env = makeEnv(databasePath, {
  CONSUMER_PLANNER_RECONCILIATION_MODE: 'shadow'
});
const config = makeConfig(env);
const { sessionId, meetingId } = await newSession(env, config);

const extractTurn = async ({ sourceTurnId }) => ({
  extraction: {
    schemaVersion: 'PlannerExtractionV3',
    sourceTurnId,
    goalCandidates: [],
    semanticFacts: [],
    positions: [{
      candidateId: 'position-1',
      operation: 'upsert',
      kind: 'pension',
      label: 'Current occupational pension',
      entityId: 'current_dc',
      linkedEntityId: '',
      amount: { amount: 339000, currency: 'EUR' },
      country: '',
      owner: 'primary',
      propertyUse: null,
      pensionType: 'occupational',
      incomeType: null,
      agricultural: null,
      certainty: 'exact',
      evidenceText: 'My current occupational pension is worth €339,000.',
      correctionTarget: ''
    }],
    sectionCompletions: [],
    invalidCandidates: [],
    clientQuestion: { present: false, intent: 'none', topic: '', questionText: '' },
    ambiguities: [],
    narrativeSummary: { summary: '', evidence: [] }
  },
  metadata: { costMicroEur: 0 }
});

await processAgentTurn(env, config, {
  sessionId,
  meetingId,
  message: 'My current occupational pension is worth €339,000.',
  deps: {
    extractTurn,
    renderText: async ({ context }) => ({
      text: 'Thanks, I have recorded that for review.',
      fallback: false,
      decisions: [],
      usageMicroEur: 0,
      context
    })
  }
});

const context = await loadAgentContext(env, config, sessionId, meetingId);
const notes = await listPlanningNotes(env, sessionId, meetingId);
assert.equal(notes.length, 1, 'an accepted T1 fact must create one ledger note');
assert.equal(notes[0].noteKind, 'position');
assert.equal(notes[0].factId, 'pension_positions');
const pension = context.profile.pensions[0];
assert.equal(notes[0].entityId, pension.pensionId);
assert.equal(notes[0].ownerId, context.profile.primaryPerson.personId);
assert.equal(
  notes[0].value.pensionId,
  notes[0].entityId,
  `the note must retain the canonical profile record: ${JSON.stringify(notes[0].value)}`
);
assert.equal(notes[0].reviewStatus, 'provisional');
assert.deepEqual(notes[0].evidenceRefs, [], 'T1 may not invent an exact evidence span');

const turn = await env.CONSUMER_DB.prepare(`
  SELECT id FROM consumer_realtime_final_turns
  WHERE session_id = ? AND realtime_session_id = ? AND role = 'user'
  ORDER BY created_at DESC, id DESC LIMIT 1
`).bind(sessionId, meetingId).first();
const input = {
  schemaVersion: 1,
  throughTurnId: turn.id,
  profileRevision: context.profile.revision,
  notes
};
const started = await startPlannerReconciliation(env, {
  sessionId,
  leaseId: meetingId,
  baseProfileRevision: context.profile.revision,
  throughTurnId: turn.id,
  trigger: 'agent_shadow_replay',
  mode: 'shadow',
  idempotencyKey: `test:${turn.id}:${context.profile.revision}`,
  promptVersion: config.plannerReconciliationPromptVersion,
  input
});
assert.equal(started.replayed, false);

const replay = await startPlannerReconciliation(env, {
  sessionId,
  leaseId: meetingId,
  baseProfileRevision: context.profile.revision,
  throughTurnId: turn.id,
  trigger: 'agent_shadow_replay',
  mode: 'shadow',
  idempotencyKey: `test:${turn.id}:${context.profile.revision}`,
  promptVersion: config.plannerReconciliationPromptVersion,
  input
});
assert.equal(replay.replayed, true, 'the same reconciliation trigger must be idempotent');

await completePlannerReconciliation(env, {
  sessionId,
  leaseId: meetingId,
  reconciliationId: started.row.id,
  reconciliationRevision: Number(started.row.reconciliation_revision),
  throughTurnId: turn.id,
  status: 'shadow',
  output: { schemaVersion: 1, verdict: 'clean' },
  model: 'test-model',
  inputTokens: 10,
  outputTokens: 3,
  cachedInputTokens: 4,
  latencyMs: 25,
  operationCount: 0,
  acceptedOperationCount: 0,
  rejectedOperationCount: 0,
  errorCode: null
});

const saved = await loadPlannerReconciliation(env, sessionId, meetingId, started.row.id);
assert.equal(saved.row.status, 'shadow');
assert.deepEqual(saved.output, { schemaVersion: 1, verdict: 'clean' });
const lease = await env.CONSUMER_DB.prepare(`
  SELECT planner_reconciled_through_turn_id, planner_reconciliation_status
  FROM consumer_realtime_sessions WHERE id = ?
`).bind(meetingId).first();
assert.equal(lease.planner_reconciled_through_turn_id, turn.id);
assert.equal(lease.planner_reconciliation_status, 'shadow');

const raw = await env.CONSUMER_DB.prepare(`
  SELECT note_encrypted FROM consumer_planning_notes WHERE realtime_session_id = ? LIMIT 1
`).bind(meetingId).first();
assert.ok(!raw.note_encrypted.includes('339000'), 'financial note values must be encrypted at rest');

await processAgentTurn(env, config, {
  sessionId,
  meetingId,
  message: 'Correction: that same current occupational pension is €350,000.',
  deps: {
    extractTurn: async ({ sourceTurnId }) => ({
      extraction: {
        ...(await extractTurn({ sourceTurnId })).extraction,
        sourceTurnId,
        positions: [{
          candidateId: 'position-correction',
          operation: 'upsert',
          kind: 'pension',
          label: 'Current occupational pension',
          entityId: 'current_dc',
          linkedEntityId: '',
          amount: { amount: 350000, currency: 'EUR' },
          country: '',
          owner: 'primary',
          propertyUse: null,
          pensionType: 'occupational',
          incomeType: null,
          agricultural: null,
          certainty: 'exact',
          evidenceText: 'Correction: that same current occupational pension is €350,000.',
          correctionTarget: ''
        }]
      },
      metadata: { costMicroEur: 0 }
    }),
    renderText: async ({ context: next }) => ({
      text: 'Thanks, I have corrected that draft.',
      fallback: false,
      decisions: [],
      usageMicroEur: 0,
      context: next
    })
  }
});

const correctedNotes = await listPlanningNotes(env, sessionId, meetingId, { limit: 20 });
const activePensionNotes = correctedNotes.filter((note) => (
  note.factInstanceId === notes[0].factInstanceId && note.lifecycle === 'active'
));
const supersededPensionNotes = correctedNotes.filter((note) => (
  note.factInstanceId === notes[0].factInstanceId && note.lifecycle === 'superseded'
));
assert.equal(activePensionNotes.length, 1, 'one fact instance may have only one active ledger note');
assert.equal(supersededPensionNotes.length, 1, 'a corrected T1 note must retain superseded history');
assert.deepEqual(
  activePensionNotes[0].replacesNoteIds,
  [supersededPensionNotes[0].noteId],
  'the active correction must name its predecessor'
);
assert.equal(activePensionNotes[0].value.currentValue.amount, 350000);

console.info('[ConsumerReconciliationPersistence] PASS: T1 ledger, encryption, idempotency and shadow watermark');
