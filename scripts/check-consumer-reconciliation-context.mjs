#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  createHouseholdProfile,
  normalizeHouseholdProfile
} from '../js/planning/index.js';
import {
  buildPlannerReconciliationContext,
  legacyPlanningNotesFromProfile
} from '../worker/src/consumer/planner_reconciliation.js';
import {
  beginRealtimeToolAttempt,
  completeRealtimeToolAttempt,
  listReconciliationTranscriptWindow,
  listRealtimeWriteOutcomes,
  recordRealtimeFinalTurn
} from '../worker/src/consumer/realtime_repository.js';
import {
  makeConfig,
  makeEnv,
  newDatabase,
  newSession
} from './agent-harness/transports.mjs';

const NOW = '2026-08-09T10:00:00.000Z';
const created = createHouseholdProfile({
  profileId: 'reconciliation-context',
  nowIso: NOW,
  calculationDateIso: NOW.slice(0, 10)
});
const profile = normalizeHouseholdProfile({
  ...created,
  primaryPerson: {
    ...created.primaryPerson,
    displayName: 'Pat',
    age: 57,
    intendedRetirementAge: 58,
    employmentStatus: 'employee'
  },
  partner: {
    personId: 'person-partner',
    role: 'partner',
    displayName: 'Niamh',
    age: 59,
    employmentStatus: 'employee'
  },
  goals: [{
    goalId: 'goal-retire',
    type: 'retire_early',
    title: 'Explore early retirement',
    priority: 'high',
    status: 'active'
  }],
  pensions: [{
    pensionId: 'primary-active-dc',
    ownerId: created.primaryPerson.personId,
    type: 'occupational',
    label: 'Current DC pension',
    currentValue: { amount: 339_000, currency: 'EUR' },
    contributionStatus: 'active'
  }]
});

const employeeNeed = {
  factId: 'pension_employee_contribution_rate',
  fieldPath: '/pensions/0/employeeContributionRate',
  reasonCode: 'active_pension_employee_rate_missing',
  importance: 'required',
  answerPolicy: 'unknown_allowed',
  reason: 'The employee contribution affects the pension projection.'
};
const employerNeed = {
  factId: 'pension_employer_contribution_rate',
  fieldPath: '/pensions/0/employerContributionRate',
  reasonCode: 'active_pension_employer_rate_missing',
  importance: 'required',
  answerPolicy: 'unknown_allowed',
  reason: 'The employer contribution affects the pension projection.'
};
const primaryFact = {
  factId: employeeNeed.factId,
  factInstanceId: `${employeeNeed.factId}:primary-active-dc`,
  entityId: 'primary-active-dc',
  ownerId: profile.primaryPerson.personId,
  prompt: 'What percentage do you contribute?'
};
const linkedFact = {
  factId: employerNeed.factId,
  factInstanceId: `${employerNeed.factId}:primary-active-dc`,
  entityId: 'primary-active-dc',
  ownerId: profile.primaryPerson.personId,
  prompt: 'What does your employer add?'
};
const state = {
  profileRevision: profile.revision,
  moduleSlots: [{
    slot: 1,
    moduleId: 'pension_projection',
    availability: 'needs_information',
    intakeStatus: 'needs_information',
    selectionState: 'selected',
    blockingFactIds: [employeeNeed.factId, employerNeed.factId]
  }, {
    slot: 2,
    moduleId: 'personal_balance_sheet',
    availability: 'ready',
    intakeStatus: 'ready',
    selectionState: 'selected',
    blockingFactIds: []
  }],
  recommendations: [{
    moduleId: 'pension_projection',
    availability: 'needs_information',
    status: 'needs_information',
    // describeConversationState exposes these fields flat; the protected
    // consumer projection must accept that real runtime shape as well as the
    // adapter's nested readiness shape.
    requiredMissing: [employeeNeed, employerNeed],
    assumptionsUsed: []
  }, {
    moduleId: 'personal_balance_sheet',
    availability: 'ready',
    readiness: { status: 'ready', requiredMissing: [], assumptionsUsed: [] }
  }],
  meetingBrief: {
    questionBatch: {
      primaryFact,
      linkedFact,
      prompt: 'Roughly what percentage do you pay, and what does your employer add?'
    }
  },
  facts: []
};
const context = {
  profile,
  state,
  sessionRow: { id: 'session-context', current_profile_revision: profile.revision }
};
const legacyNotes = legacyPlanningNotesFromProfile(profile);
assert.ok(legacyNotes.some((note) => (
  note.factId === 'pension_positions'
  && note.factInstanceId === 'pension_positions:primary-active-dc'
  && note.value.pensionId === 'primary-active-dc'
)), 'the first reconciliation must lazily represent pre-ledger holdings');
assert.equal(
  new Set(legacyNotes.map((note) => note.factInstanceId)).size,
  legacyNotes.length,
  'a lazy profile snapshot must contain one note per stable fact instance'
);
const voiceWriteOutcomes = [{
  toolAttemptId: 'tool-1',
  status: 'succeeded',
  result: {
    outcomes: [{
      factId: employeeNeed.factId,
      accepted: false,
      errorCode: 'realtime_pension_review_required'
    }]
  }
}];
const built = buildPlannerReconciliationContext({
  context,
  turns: [{ id: 'turn-client', role: 'user', transcript: 'I do not know either rate.', sequence: 1 }],
  notes: [],
  throughTurnId: 'turn-client',
  voiceWriteOutcomes
});
assert.deepEqual(
  built.currentQuestion.boundFactInstanceIds,
  [primaryFact.factInstanceId, linkedFact.factInstanceId],
  'the signed paired question must retain both answer bindings'
);
assert.ok(built.needs.some((need) => (
  need.factInstanceId === primaryFact.factInstanceId
  && need.entityId === 'primary-active-dc'
  && need.ownerId === profile.primaryPerson.personId
  && need.blockingModuleIds.includes('pension_projection')
)), 'reconciliation needs must retain owner/entity/instance and blocking analysis');
assert.equal(
  built.selectedAnalyses.find((item) => item.moduleId === 'personal_balance_sheet')?.availability,
  'ready'
);
assert.equal(
  built.selectedAnalyses.find((item) => item.moduleId === 'personal_balance_sheet')?.runnable,
  true,
  'a ready independent analysis remains explicitly runnable'
);
assert.deepEqual(built.voiceWriteOutcomes, voiceWriteOutcomes);
assert.ok(built.entities.some((entity) => (
  entity.newEntitySlot === true && entity.factIds.includes('pension_positions')
)), 'the server must supply bounded identities for positions T1 omitted entirely');

const single = normalizeHouseholdProfile({ ...profile, partner: undefined });
const singleContext = buildPlannerReconciliationContext({
  context: {
    profile: single,
    state: { moduleSlots: [], recommendations: [], facts: [] },
    sessionRow: { id: 'single', current_profile_revision: single.revision }
  },
  turns: [{ id: 'single-turn', role: 'user', transcript: 'I have one pension.', sequence: 1 }],
  notes: [],
  throughTurnId: 'single-turn'
});
assert.ok(!singleContext.owners.some((owner) => owner.ownerId === 'household'),
  'joint ownership is not allowlisted before a partner exists');

const databasePath = newDatabase('planning-reconciliation-context');
const env = makeEnv(databasePath);
const config = makeConfig(env);
const { sessionId, meetingId } = await newSession(env, config);
const userTurns = [];
for (let index = 1; index <= 10; index += 1) {
  const recorded = await recordRealtimeFinalTurn(env, {
    sessionId,
    leaseId: meetingId,
    providerItemId: `context-user-${index}`,
    role: 'user',
    transcript: `Client turn ${index}.`
  });
  userTurns.push(recorded.id);
  const attempt = await beginRealtimeToolAttempt(env, {
    sessionId,
    leaseId: meetingId,
    providerToolCallId: `context-tool-${index}`,
    toolName: 'silent_planner',
    toolVersion: 'context-test-v1',
    expectedProfileRevision: 1,
    sourceTurnId: recorded.id,
    arguments: { sourceTurnId: recorded.id, ordinal: index },
    maxToolCalls: config.realtimeMaxToolCalls
  });
  await completeRealtimeToolAttempt(env, {
    sessionId,
    leaseId: meetingId,
    toolAttemptId: attempt.row.id,
    status: 'succeeded',
    result: { ok: true, ordinal: index, outcomes: [] },
    errorCode: null,
    latencyMs: index
  });
  await recordRealtimeFinalTurn(env, {
    sessionId,
    leaseId: meetingId,
    providerItemId: `context-assistant-${index}`,
    role: 'assistant',
    transcript: `Assistant turn ${index}.`
  });
}

const window = await listReconciliationTranscriptWindow(
  env,
  sessionId,
  meetingId,
  userTurns[8],
  { maxClientTurns: 8, referencedTurnIds: [userTurns[0]] }
);
assert.ok(window.some((turn) => turn.id === userTurns[0]), 'older note evidence is retained explicitly');
assert.equal(window.filter((turn) => turn.role === 'user' && turn.id !== userTurns[0]).length, 8);
assert.ok(!window.some((turn) => turn.id === userTurns[9]), 'a turn-N window must never include N+1');
assert.ok(window.every((turn, index) => index === 0 || turn.sequence > window[index - 1].sequence),
  'transcript sequence must be monotonic');

const writes = await listRealtimeWriteOutcomes(env, sessionId, meetingId, userTurns[8]);
assert.equal(writes.length, 1, 'T1 outcomes must bind to the exact stored source turn');
assert.equal(writes[0].result.ordinal, 9);
assert.equal(writes[0].arguments.sourceTurnId, userTurns[8]);

console.info('[ConsumerReconciliationContext] PASS: needs, signed questions, bounded turns, new identities and T1 outcomes');
