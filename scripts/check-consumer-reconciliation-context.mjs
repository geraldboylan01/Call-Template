#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  createHouseholdProfile,
  normalizeHouseholdProfile
} from '../js/planning/index.js';
import {
  RECONCILIATION_SYSTEM_PROMPT,
  buildPlannerReconciliationContext,
  legacyPlanningNotesFromProfile,
  normalizeModelReconciliationPlan
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

/* ------------------------------------------------------------------------ */
/* AN UNPARSEABLE OPERATION LOSES ITSELF, NOT THE BATCH.                      */
/*                                                                            */
/* `valueJson` is a JSON document inside a JSON string, so the structured      */
/* output schema constrains none of it. Observed live: one malformed value on  */
/* `op7` returned `planner_reconciliation_output_invalid` and discarded six    */
/* other correct operations in the same response.                             */
/* ------------------------------------------------------------------------ */
{
  const operation = (operationId, valueJson) => ({
    operationId,
    op: 'upsert_note',
    targetNoteId: '',
    factId: 'monthly_spending',
    factInstanceId: 'monthly_spending',
    entityId: '',
    ownerId: '',
    noteKind: 'fact',
    certainty: 'exact',
    targetEntityId: '',
    sourceEntityIds: [],
    valueJson,
    reasonCode: 'missing_note',
    evidence: [{ turnId: 'turn_1', quote: 'we spend 6,200 a month' }]
  });

  const { plan, droppedOperations } = normalizeModelReconciliationPlan({
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{
      groupId: 'mixed',
      atomic: false,
      operations: [
        operation('good_1', JSON.stringify({ amount: 6_200, currency: 'EUR' })),
        // Exactly the shape observed: not JSON at all.
        operation('bad', '{amount: 6200, currency: EUR}'),
        operation('good_2', JSON.stringify({ amount: 5_800, currency: 'EUR' }))
      ]
    }]
  });

  const survivors = plan.operationGroups.flatMap((group) => group.operations)
    .map((item) => item.operationId);
  assert.deepEqual(survivors, ['good_1', 'good_2'], 'parseable operations must survive a malformed sibling');
  assert.equal(droppedOperations.length, 1);
  assert.equal(droppedOperations[0].operationId, 'bad');
  assert.equal(droppedOperations[0].code, 'planner_reconciliation_output_invalid');

  // A CLAIMED group still loses everything: that is what the claim means.
  const claimed = normalizeModelReconciliationPlan({
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{
      groupId: 'claimed',
      atomic: true,
      operations: [
        operation('claimed_good', JSON.stringify({ amount: 6_200, currency: 'EUR' })),
        operation('claimed_bad', 'not json')
      ]
    }]
  });
  assert.equal(claimed.plan.operationGroups.length, 0, 'an atomic group loses all of its operations');
  assert.deepEqual(
    claimed.droppedOperations.map((entry) => [entry.operationId, entry.code]),
    [['claimed_bad', 'planner_reconciliation_output_invalid'], ['claimed_good', 'dependency_group_rejected']]
  );

  // `atomic` must reach the validator. Dropping it here silently decomposed
  // every group the planner had deliberately claimed.
  const carried = normalizeModelReconciliationPlan({
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [
      { groupId: 'claims', atomic: true, operations: [operation('a', JSON.stringify({ amount: 1, currency: 'EUR' }))] },
      { groupId: 'does_not', atomic: false, operations: [operation('b', JSON.stringify({ amount: 2, currency: 'EUR' }))] }
    ]
  });
  assert.deepEqual(carried.plan.operationGroups.map((group) => group.atomic), [true, false]);

  // A response whose every operation is unusable is an empty plan, not a throw.
  const allBad = normalizeModelReconciliationPlan({
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{ groupId: 'all_bad', atomic: false, operations: [operation('x', '<<<')] }]
  });
  assert.deepEqual(allBad.plan.operationGroups, []);
  assert.equal(allBad.droppedOperations.length, 1);
  assert.equal(allBad.plan.verdict, 'clean', 'an emptied plan reports that nothing could be changed');

  // ...but a model that returns changes_proposed with no operations of its own
  // is still making a mistake, and must still fail.
  assert.throws(
    () => normalizeModelReconciliationPlan({
      schemaVersion: 1, verdict: 'changes_proposed', reviewedNoteIds: [], operationGroups: []
    }),
    /invalid reconciliation plan/
  );
}

/* ------------------------------------------- the position record contract */

/**
 * WHAT THE MODEL IS TOLD ABOUT POSITION RECORDS.
 *
 * The prompt used to describe this in prose, and the prose was wrong: it said to
 * copy an identity into "the canonical record's entity ID field", and no
 * canonical record has one — income sources carry `incomeId`, pensions
 * `pensionId`. A real planner model followed that sentence literally, wrote
 * `value.entityId` on every entity it proposed, and the projector refused all of
 * them. The same run marked the scalar `pension_current_value` as a position,
 * because nothing said which facts are collections; a position note for a
 * non-position fact falls between both projectors and is accepted while doing
 * nothing at all.
 *
 * So the contract is now DATA, derived from the same constant the validator
 * enforces. These assertions are what stop the two drifting apart again.
 */
{
  const positioned = buildPlannerReconciliationContext({
    context,
    turns: [{ id: 'turn-client', role: 'user', transcript: 'I earn 95,000 gross.', sequence: 1 }],
    notes: [
      { factId: 'income_sources' },
      { factId: 'pension_positions' },
      { factId: 'pension_current_value' },
      { factId: 'person_current_age' }
    ],
    throughTurnId: 'turn-client',
    voiceWriteOutcomes: []
  });
  const contractFor = (factId) => positioned.positionContracts
    .find((entry) => entry.factId === factId);

  assert.deepEqual(contractFor('income_sources'), {
    factId: 'income_sources', idKey: 'incomeId', ownerKey: 'ownerId'
  }, 'an income position record is keyed by incomeId, never by entityId');
  assert.deepEqual(contractFor('pension_positions'), {
    factId: 'pension_positions', idKey: 'pensionId', ownerKey: 'ownerId'
  }, 'a pension position record is keyed by pensionId');
  assert.equal(contractFor('pension_current_value'), undefined,
    'pension_current_value is a value ABOUT a pension, not a pension: it is a scalar fact '
    + 'and must never be offered to the model as something that may be a position');
  assert.equal(contractFor('person_current_age'), undefined,
    'an ordinary scalar carries no position contract');
  assert.ok(positioned.positionContracts.every((entry) => entry.idKey && entry.ownerKey),
    'every offered contract must name both keys, or it teaches the model half a shape');

  // THE SHAPE OF A QUESTION. `request_clarification` is the reconciler's
  // fail-closed path, and a real planner could not use it: it invented an
  // entity id for a person the household did not contain, because nothing said
  // the identity fields were optional.
  assert.equal(positioned.clarificationContract.op, 'request_clarification');
  assert.equal(positioned.clarificationContract.schemaVersion, 2);
  for (const field of ['needId', 'factId', 'factInstanceId', 'prompt', 'importance', 'status']) {
    assert.ok(positioned.clarificationContract.required.includes(field),
      `the clarification contract must name ${field} as required`);
  }
  for (const field of ['entityId', 'ownerId']) {
    assert.ok(positioned.clarificationContract.optionalIdentity.includes(field),
      `${field} must be advertised as optional, or the model invents one`);
    assert.equal(positioned.clarificationContract.required.includes(field), false,
      `${field} must not be advertised as required`);
  }
  assert.ok(positioned.clarificationContract.importance.length > 0
    && positioned.clarificationContract.answerPolicy.length > 0
    && positioned.clarificationContract.status.length > 0,
  'the closed vocabularies must travel with the contract');

  // The prompt must actually bind to the data, or the data is decoration.
  assert.match(RECONCILIATION_SYSTEM_PROMPT, /positionContracts/,
    'the prompt must name the contract list it is handing the model');
  assert.match(RECONCILIATION_SYSTEM_PROMPT, /clarificationContract/,
    'the prompt must name the clarification contract too');

  /**
   * THE RULES THAT CANNOT BE DERIVED, AND SO CANNOT BE TRIMMED.
   *
   * The prompt was cut by 16% once the contracts carried the shapes it had been
   * describing in prose. Everything below states something no structured field
   * says — a semantic or safety rule, each one bought with a real defect — so a
   * future trim that reaches them fails here rather than in a paid probe.
   */
  for (const [rule, why] of [
    [/narrowest span/i, 'evidence width: a quote with unrelated numbers cannot bind'],
    [/trimming, never by rewriting/i, 'evidence must stay an exact stored span'],
    [/currency/i, 'money needs both keys, including nested inside a record'],
    [/no entityId field inside a canonical record/i, 'the misconception that refused every entity'],
    [/SERVER decides gross versus net/i, 'income basis is decided deterministically, not asked about'],
    [/REPLACES the old one/i, 'an upsert is not a merge'],
    [/aggregate_summary AND noteKind summary/i, 'a stated total is not a holding'],
    [/singletonFactIds/i, 'a household-wide slot must not be attached to a person'],
    [/does not exist yet is normal/i, 'a clarification may omit identities it cannot name'],
    [/own group/i, 'grouping decides blast radius'],
    [/reviewedNoteIds/i, 'a span-free note cannot be verified by id alone']
  ]) {
    assert.match(RECONCILIATION_SYSTEM_PROMPT, rule, `the prompt lost a rule — ${why}`);
  }
  assert.doesNotMatch(RECONCILIATION_SYSTEM_PROMPT, /canonical record's entity ID field/,
    'the sentence that told the model to write a field that does not exist must stay gone');
}

console.info('[ConsumerReconciliationContext] PASS: needs, signed questions, bounded turns, new identities, position contracts and T1 outcomes');
