import assert from 'node:assert/strict';

import {
  NEED_ANSWER_POLICIES,
  NEED_STATUSES,
  PLANNING_NOTE_LIFECYCLES,
  PLANNING_NOTE_REVIEW_STATUSES,
  PLANNING_NOTE_SOURCES,
  applyReconciliationPlan,
  buildReconciliationIdempotencyInput,
  hashReconciliationPlan,
  normalizeNeedV2,
  normalizePlanningNoteV1,
  normalizePlanningNotesV1,
  normalizeReconciliationPlanV1,
  projectPlanningNotesToProfile
} from '../js/planning/reconciliation.js';
import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';

const NOW = '2026-08-09T10:00:00.000Z';
const LATER = '2026-08-09T10:05:00.000Z';

function runCase(name, callback) {
  return Promise.resolve()
    .then(callback)
    .then(() => console.log(`PASS ${name}`));
}

function evidenceRef(turn, quote) {
  const start = turn.text.indexOf(quote);
  assert.notEqual(start, -1, `Fixture quote must occur in ${turn.turnId}.`);
  return { turnId: turn.turnId, start, end: start + quote.length };
}

function baseProfile() {
  const profile = createHouseholdProfile({
    profileId: 'profile_reconciliation',
    primaryPersonId: 'primary',
    nowIso: NOW,
    calculationDateIso: '2026-08-09'
  });
  return normalizeHouseholdProfile({
    ...profile,
    partner: {
      personId: 'partner',
      role: 'partner',
      displayName: 'Aoife',
      employmentStatus: 'employee'
    },
    pensions: [
      {
        pensionId: 'pension_old_dc',
        ownerId: 'primary',
        type: 'occupational',
        label: 'Old DC pension',
        currentValue: { amount: 319_000, currency: 'EUR' }
      },
      {
        pensionId: 'pension_stated_total',
        ownerId: 'primary',
        type: 'other',
        label: 'Three pensions total',
        currentValue: { amount: 1_070_000, currency: 'EUR' }
      }
    ]
  });
}

const turns = [
  {
    turnId: 'turn_pensions',
    role: 'user',
    finalized: true,
    sequence: 1,
    text: 'My old DC pension is about €319k. Total pensions are about €1.07 million.'
  },
  {
    turnId: 'turn_future',
    role: 'client',
    finalized: true,
    sequence: 2,
    text: 'An inheritance of about €50k is coming in a few months, and I could retire at 58.'
  },
  {
    turnId: 'turn_owner',
    role: 'user',
    finalized: true,
    sequence: 3,
    text: "Actually that is my wife's pension, not mine."
  },
  {
    turnId: 'turn_ambiguous_owner',
    role: 'user',
    finalized: true,
    sequence: 4,
    text: 'Actually that pension belongs somewhere else.'
  },
  {
    turnId: 'turn_range',
    role: 'user',
    finalized: true,
    sequence: 5,
    text: 'We spend between €3,000 and €3,500 per month.'
  },
  {
    turnId: 'turn_assistant',
    role: 'assistant',
    finalized: true,
    sequence: 6,
    text: 'I will write down €999k.'
  },
  {
    turnId: 'turn_unfinalized',
    role: 'user',
    finalized: false,
    sequence: 7,
    text: 'The value is €999k.'
  },
  {
    turnId: 'turn_same_value',
    role: 'user',
    finalized: true,
    sequence: 8,
    text: 'One is €319k and the other is also €319k.'
  },
  {
    turnId: 'turn_merge',
    role: 'user',
    finalized: true,
    sequence: 9,
    text: 'That second Old DC entry is a duplicate of the first one.'
  },
  {
    turnId: 'turn_retract',
    role: 'user',
    finalized: true,
    sequence: 10,
    text: 'That imported Old DC pension is not one of mine; remove it.'
  },
  {
    turnId: 'turn_relative_date',
    role: 'user',
    finalized: true,
    sequence: 11,
    text: 'Her public-sector pension starts in December this year.'
  }
];

function baseNotes() {
  const pensionQuote = 'My old DC pension is about €319k.';
  const totalQuote = 'Total pensions are about €1.07 million.';
  return [
    normalizePlanningNoteV1({
      noteId: 'note_old_dc',
      noteKind: 'position',
      factId: 'pension_positions',
      factInstanceId: 'pension_positions:pension_old_dc',
      entityId: 'pension_old_dc',
      ownerId: 'primary',
      value: {
        pensionId: 'pension_old_dc',
        ownerId: 'primary',
        type: 'occupational',
        label: 'Old DC pension',
        currentValue: { amount: 319_000, currency: 'EUR' }
      },
      certainty: 'approximate',
      lifecycle: 'active',
      reviewStatus: 'provisional',
      source: 'realtime_note',
      evidenceRefs: [evidenceRef(turns[0], pensionQuote)],
      replacesNoteIds: [],
      createdAt: NOW
    }),
    normalizePlanningNoteV1({
      noteId: 'note_pension_total',
      noteKind: 'position',
      factId: 'pension_positions',
      factInstanceId: 'pension_positions:pension_stated_total',
      entityId: 'pension_stated_total',
      ownerId: 'primary',
      value: {
        pensionId: 'pension_stated_total',
        ownerId: 'primary',
        type: 'other',
        label: 'Three pensions total',
        currentValue: { amount: 1_070_000, currency: 'EUR' }
      },
      certainty: 'approximate',
      lifecycle: 'active',
      reviewStatus: 'provisional',
      source: 'realtime_note',
      evidenceRefs: [evidenceRef(turns[0], totalQuote)],
      replacesNoteIds: [],
      createdAt: NOW
    })
  ];
}

function summaryPlan() {
  return {
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: ['note_old_dc', 'note_pension_total'],
    operationGroups: [{
      groupId: 'group_summary',
      operations: [{
        operationId: 'reclass_total',
        op: 'reclassify_note',
        targetNoteId: 'note_pension_total',
        factId: 'pension_positions',
        entityId: 'pension_stated_total',
        ownerId: 'primary',
        noteKind: 'summary',
        value: {
          label: 'Stated pension total',
          amount: { amount: 1_070_000, currency: 'EUR' }
        },
        certainty: 'approximate',
        reasonCode: 'aggregate_summary',
        evidence: [{
          turnId: 'turn_pensions',
          quote: 'Total pensions are about €1.07 million.'
        }]
      }]
    }]
  };
}

const common = {
  transcriptTurns: turns,
  sessionId: 'session_reconciliation',
  transcriptWatermark: 'turn_range',
  baseProfileRevision: 0,
  nowIso: LATER
};

const p57Turn = {
  turnId: 'turn_p57_compact',
  role: 'user',
  finalized: true,
  sequence: 1,
  text: "I have three pensions: an old DC worth about €319k, a PRSA of about €415k, and my current DC of about €339k; together they're roughly €1.07 million. My wife's public-sector defined benefit pension pays about €35k a year from age 60 with a €105k lump sum. She also expects an inheritance of about €50k in a few months. For me the options are retire now, retire at 58, or contract until 60; I haven't chosen one."
};

function p57Profile() {
  const profile = createHouseholdProfile({
    profileId: 'profile_p57_compact',
    primaryPersonId: 'primary',
    nowIso: NOW,
    calculationDateIso: '2026-08-09'
  });
  return normalizeHouseholdProfile({
    ...profile,
    partner: {
      personId: 'partner',
      role: 'partner',
      displayName: 'the client spouse',
      employmentStatus: 'employee'
    },
    assets: [{
      assetId: 'p57_future_inheritance',
      ownerIds: ['partner'],
      type: 'cash',
      label: 'Expected inheritance',
      currentValue: { amount: 50_000, currency: 'EUR' }
    }],
    pensions: [
      {
        pensionId: 'p57_old_dc', ownerId: 'primary', type: 'occupational',
        label: 'Old DC', currentValue: { amount: 319_000, currency: 'EUR' },
        contributionStatus: 'paid_up'
      },
      {
        pensionId: 'p57_prsa', ownerId: 'primary', type: 'prsa',
        label: 'PRSA', currentValue: { amount: 415_000, currency: 'EUR' },
        contributionStatus: 'unknown'
      },
      {
        pensionId: 'p57_current_dc', ownerId: 'primary', type: 'occupational',
        label: 'Current DC', currentValue: { amount: 339_000, currency: 'EUR' },
        contributionStatus: 'active'
      },
      {
        pensionId: 'p57_rounded_total', ownerId: 'primary', type: 'other',
        label: 'Rounded pension total', currentValue: { amount: 1_070_000, currency: 'EUR' }
      },
      {
        pensionId: 'p57_partner_db', ownerId: 'partner', type: 'defined_benefit',
        label: 'Public-sector DB pension', currentValue: { amount: 35_000, currency: 'EUR' }
      }
    ]
  });
}

function p57Notes() {
  const profile = p57Profile();
  const pension = (pensionId) => profile.pensions.find((item) => item.pensionId === pensionId);
  const position = ({ noteId, factId, entityId, ownerId, value, quote }) => normalizePlanningNoteV1({
    noteId,
    noteKind: 'position',
    factId,
    factInstanceId: `${factId}:${entityId}`,
    entityId,
    ownerId,
    value,
    certainty: 'approximate',
    lifecycle: 'active',
    reviewStatus: 'provisional',
    source: 'realtime_note',
    evidenceRefs: [evidenceRef(p57Turn, quote)],
    replacesNoteIds: [],
    createdAt: NOW
  });
  return [
    position({
      noteId: 'note_p57_old_dc', factId: 'pension_positions', entityId: 'p57_old_dc', ownerId: 'primary',
      value: pension('p57_old_dc'), quote: 'an old DC worth about €319k'
    }),
    position({
      noteId: 'note_p57_prsa', factId: 'pension_positions', entityId: 'p57_prsa', ownerId: 'primary',
      value: pension('p57_prsa'), quote: 'a PRSA of about €415k'
    }),
    position({
      noteId: 'note_p57_current_dc', factId: 'pension_positions', entityId: 'p57_current_dc', ownerId: 'primary',
      value: pension('p57_current_dc'), quote: 'my current DC of about €339k'
    }),
    position({
      noteId: 'note_p57_total', factId: 'pension_positions', entityId: 'p57_rounded_total', ownerId: 'primary',
      value: pension('p57_rounded_total'), quote: "together they're roughly €1.07 million"
    }),
    position({
      noteId: 'note_p57_partner_db', factId: 'pension_positions', entityId: 'p57_partner_db', ownerId: 'partner',
      value: pension('p57_partner_db'),
      quote: "My wife's public-sector defined benefit pension pays about €35k a year from age 60 with a €105k lump sum"
    }),
    position({
      noteId: 'note_p57_inheritance', factId: 'asset_position', entityId: 'p57_future_inheritance', ownerId: 'partner',
      value: profile.assets[0], quote: 'She also expects an inheritance of about €50k in a few months'
    }),
    normalizePlanningNoteV1({
      noteId: 'note_p57_count',
      noteKind: 'fact',
      factId: 'pension_positions',
      factInstanceId: 'pension_positions:primary_count',
      ownerId: 'primary',
      value: 3,
      certainty: 'exact',
      lifecycle: 'active',
      reviewStatus: 'provisional',
      source: 'realtime_note',
      evidenceRefs: [evidenceRef(p57Turn, 'I have three pensions')],
      replacesNoteIds: [],
      createdAt: NOW
    })
  ];
}

const p57Common = {
  transcriptTurns: [p57Turn],
  sessionId: 'session_p57_compact',
  transcriptWatermark: p57Turn.turnId,
  baseProfileRevision: 0,
  nowIso: LATER
};

await runCase('PlanningNoteV1 and NeedV2 reject unstable or conflated identities', () => {
  assert.ok(NEED_ANSWER_POLICIES.includes('unknown_allowed'));
  assert.ok(NEED_STATUSES.includes('blocked_unknown'));
  assert.ok(PLANNING_NOTE_LIFECYCLES.includes('retracted'));
  assert.ok(PLANNING_NOTE_REVIEW_STATUSES.includes('planner_corrected'));
  assert.ok(PLANNING_NOTE_SOURCES.includes('legacy_import'));
  assert.equal(normalizePlanningNotesV1(baseNotes()).length, 2);
  assert.throws(() => normalizePlanningNoteV1({
    noteId: 'bad_position',
    noteKind: 'position',
    factId: 'pension_positions',
    value: null,
    certainty: 'unknown',
    lifecycle: 'active',
    reviewStatus: 'provisional',
    source: 'realtime_note',
    evidenceRefs: [],
    replacesNoteIds: [],
    createdAt: NOW
  }), /entityId is required/);
  assert.throws(() => normalizeNeedV2({
    needId: 'need_rate',
    factId: 'pension_employee_contribution_rate',
    factInstanceId: 'pension_employee_contribution_rate:pension_old_dc',
    entityId: 'pension_other',
    ownerId: 'partner',
    reasonCode: 'missing',
    prompt: "What does Aoife contribute to this pension?",
    importance: 'required',
    blockingModuleIds: ['pension_projection'],
    answerPolicy: 'unknown_allowed',
    status: 'open'
  }, {
    allowedOwnerIds: ['primary', 'partner'],
    allowedEntityIds: ['pension_old_dc']
  }), /not a known entity/);
});

await runCase('an aggregate reclassification removes the phantom holding and creates only a summary sidecar', async () => {
  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan: summaryPlan(),
    ...common
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.profile.revision, 1);
  assert.deepEqual(result.profile.pensions.map((pension) => pension.pensionId), ['pension_old_dc']);
  assert.equal(result.profile.assumptions.values.planning.statedSummaries.length, 1);
  assert.equal(
    result.profile.assumptions.values.planning.statedSummaries[0].value.amount.amount,
    1_070_000
  );
  const corrected = result.notes.find((note) => note.noteId === 'recon_reclass_total');
  assert.deepEqual(
    corrected.evidenceRefs,
    [evidenceRef(turns[0], 'Total pensions are about €1.07 million.')]
  );
  assert.equal(result.notes.find((note) => note.noteId === 'note_pension_total').lifecycle, 'superseded');
});

// The first live shadow reconciliation returned semantically correct pension
// corrections whose position values carried the entity under the reconciler's
// own `entityId` vocabulary and omitted the internal collection key. Every
// operation was then discarded by the whole-profile position invariant. The
// collection key is server-owned identity, so it is stamped rather than
// demanded from the model — and it cannot be overridden by the model either.
await runCase('a position correction takes its collection identity from the server, not the model', async () => {
  const quote = 'My old DC pension is about €319k.';
  const plan = {
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{
      groupId: 'model_shaped_position_correction',
      operations: [{
        operationId: 'correct_old_dc',
        op: 'correct_note',
        targetNoteId: 'note_old_dc',
        factId: 'pension_positions',
        factInstanceId: 'pension_positions:pension_old_dc',
        entityId: 'pension_old_dc',
        ownerId: 'primary',
        noteKind: 'position',
        certainty: 'approximate',
        reasonCode: 'explicit_correction',
        value: {
          // Exactly what the shadow call emitted: no pensionId at all.
          entityId: 'pension_old_dc',
          ownerId: 'primary',
          type: 'occupational',
          currentValue: { amount: 319_000, currency: 'EUR' }
        },
        evidence: [{ turnId: turns[0].turnId, quote }]
      }]
    }]
  };
  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan,
    ...common
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.rejectedGroups.length, 0);
  const pension = result.profile.pensions.find((item) => item.pensionId === 'pension_old_dc');
  assert.equal(pension.currentValue.amount, 319_000);
  assert.equal(pension.ownerId, 'primary');
  // The descriptive label survives a correction that did not mention it.
  assert.equal(pension.label, 'Old DC pension');
  // The reconciler's identity vocabulary never becomes a profile field.
  assert.equal(pension.entityId, undefined);

  // A model-supplied collection key cannot retarget another entity's record.
  const smuggled = JSON.parse(JSON.stringify(plan));
  smuggled.operationGroups[0].operations[0].value.pensionId = 'pension_stated_total';
  const retargeted = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan: smuggled,
    ...common
  });
  assert.equal(retargeted.status, 'applied');
  assert.equal(
    retargeted.profile.pensions.find((item) => item.pensionId === 'pension_old_dc').currentValue.amount,
    319_000
  );
  assert.equal(
    retargeted.profile.pensions.find((item) => item.pensionId === 'pension_stated_total').currentValue.amount,
    1_070_000
  );
});

// This corpus once validated summaries, future money and scenarios through
// fact ids that do not exist -- retirement_scenario, future_inheritance,
// future_pension_start, pension_count. The reconciler's own JSON schema only
// offers the registered catalogue, so the model could never emit any of them:
// the cases passed while exercising nothing production can produce, and the
// scenario contract they "proved" disagreed with what the live shadow run
// actually did. The deterministic layer now enforces what the schema promises.
await runCase('the reconciler cannot name a fact that is not in the registry', async () => {
  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      operationGroups: [{
        groupId: 'phantom_fact',
        operations: [{
          operationId: 'invent_scenario_fact',
          op: 'set_scenario',
          factId: 'retirement_scenario',
          factInstanceId: 'retirement_scenario:retire_58',
          noteKind: 'scenario_option',
          value: { scenarioId: 'retire_58', retirementAge: 58, status: 'exploring' },
          certainty: 'exact',
          reasonCode: 'scenario_option',
          evidence: [{ turnId: 'turn_future', quote: 'I could retire at 58' }]
        }]
      }]
    },
    ...common
  });
  assert.equal(result.status, 'no_change');
  assert.equal(result.rejectedGroups[0].code, 'fact_identity_unknown');
  assert.equal(result.profile.assumptions.values.planning.decisionScenarios?.length ?? 0, 0);
});

await runCase('future events and scenarios cannot enter current assets, income or settled retirement age', async () => {
  const plan = {
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [
      {
        groupId: 'future',
        operations: [{
          operationId: 'future_inheritance',
          op: 'upsert_note',
          factId: 'asset_position',
          noteKind: 'future_event',
          value: {
            eventId: 'inheritance_expected',
            amount: { amount: 50_000, currency: 'EUR' },
            timing: 'next_few_months'
          },
          certainty: 'approximate',
          reasonCode: 'future_event',
          evidence: [{
            turnId: 'turn_future',
            quote: 'An inheritance of about €50k is coming in a few months'
          }]
        }]
      },
      {
        groupId: 'scenario',
        operations: [{
          operationId: 'retire_58',
          op: 'set_scenario',
          factId: 'intended_retirement_age',
          factInstanceId: 'intended_retirement_age:retire_58',
          noteKind: 'scenario_option',
          value: { scenarioId: 'retire_58', retirementAge: 58, status: 'exploring' },
          certainty: 'exact',
          reasonCode: 'scenario_option',
          evidence: [{ turnId: 'turn_future', quote: 'I could retire at 58' }]
        }]
      }
    ]
  };
  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan,
    ...common
  });
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.profile.assets, []);
  assert.deepEqual(result.profile.incomeSources, []);
  assert.equal(result.profile.primaryPerson.intendedRetirementAge, undefined);
  assert.equal(result.profile.assumptions.values.planning.futureEvents.length, 1);
  assert.equal(result.profile.assumptions.values.planning.decisionScenarios.length, 1);
});

await runCase('one unsupported operation rejects its whole dependency group but not an independent valid group', async () => {
  const plan = {
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [
      {
        groupId: 'atomic_invalid',
        operations: [
          {
            operationId: 'future_would_be_valid',
            op: 'upsert_note',
            factId: 'asset_position',
            noteKind: 'future_event',
            value: { eventId: 'inheritance_expected', amount: { amount: 50_000, currency: 'EUR' } },
            certainty: 'approximate',
            reasonCode: 'future_event',
            evidence: [{ turnId: 'turn_future', quote: 'An inheritance of about €50k' }]
          },
          {
            operationId: 'invented_value',
            op: 'correct_note',
            targetNoteId: 'note_old_dc',
            factId: 'pension_positions',
            entityId: 'pension_old_dc',
            ownerId: 'primary',
            noteKind: 'position',
            value: {
              pensionId: 'pension_old_dc', ownerId: 'primary', type: 'occupational',
              label: 'Old DC pension', currentValue: { amount: 999_000, currency: 'EUR' }
            },
            certainty: 'approximate',
            reasonCode: 'incorrect_value',
            evidence: [{ turnId: 'turn_pensions', quote: 'My old DC pension is about €319k.' }]
          }
        ]
      },
      {
        groupId: 'independent_valid',
        operations: [{
          operationId: 'retire_58_independent',
          op: 'set_scenario',
          factId: 'intended_retirement_age',
          factInstanceId: 'intended_retirement_age:retire_58',
          noteKind: 'scenario_option',
          value: { scenarioId: 'retire_58', retirementAge: 58 },
          certainty: 'exact',
          reasonCode: 'scenario_option',
          evidence: [{ turnId: 'turn_future', quote: 'I could retire at 58' }]
        }]
      }
    ]
  };
  const result = await applyReconciliationPlan({
    profile: baseProfile(), notes: baseNotes(), plan, ...common
  });
  assert.deepEqual(result.acceptedGroupIds, ['independent_valid']);
  assert.equal(result.rejectedGroups[0].code, 'numeric_value_unsupported');
  assert.equal(result.profile.assumptions.values.planning.futureEvents?.length ?? 0, 0);
  assert.equal(result.profile.assumptions.values.planning.decisionScenarios.length, 1);
  assert.equal(result.profile.pensions[0].currentValue.amount, 319_000);
  assert.equal(result.clarificationNeeds[0].factInstanceId, 'pension_positions:pension_old_dc');
});

await runCase('owner correction requires a known partner, stable entity and explicit destination-owner words', async () => {
  const correction = (turnId, quote, operationId) => ({
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{
      groupId: `owner_${operationId}`,
      operations: [{
        operationId,
        op: 'correct_note',
        targetNoteId: 'note_old_dc',
        factId: 'pension_positions',
        entityId: 'pension_old_dc',
        ownerId: 'partner',
        noteKind: 'position',
        value: {
          pensionId: 'pension_old_dc', ownerId: 'partner', type: 'occupational',
          label: 'Old DC pension', currentValue: { amount: 319_000, currency: 'EUR' }
        },
        certainty: 'exact',
        reasonCode: 'wrong_owner',
        evidence: [{ turnId, quote }]
      }]
    }]
  });
  const accepted = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan: correction('turn_owner', "Actually that is my wife's pension, not mine.", 'owner_good'),
    ...common
  });
  assert.equal(accepted.rejectedGroups.length, 0);
  assert.equal(
    accepted.profile.pensions.find((pension) => pension.pensionId === 'pension_old_dc').ownerId,
    'partner'
  );

  const rejected = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan: correction(
      'turn_ambiguous_owner',
      'Actually that pension belongs somewhere else.',
      'owner_ambiguous'
    ),
    ...common
  });
  assert.equal(rejected.rejectedGroups[0].code, 'owner_change_evidence_missing');
  assert.equal(
    rejected.profile.pensions.find((pension) => pension.pensionId === 'pension_old_dc').ownerId,
    'primary'
  );
});

await runCase('only exact, unique spans from finalized client turns can support a correction', async () => {
  const planFor = (turnId, quote, operationId) => ({
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{
      groupId: operationId,
      operations: [{
        operationId,
        op: 'correct_note',
        targetNoteId: 'note_old_dc',
        factId: 'pension_positions',
        entityId: 'pension_old_dc',
        ownerId: 'primary',
        noteKind: 'position',
        value: {
          pensionId: 'pension_old_dc', ownerId: 'primary', type: 'occupational',
          label: 'Old DC pension', currentValue: { amount: 999_000, currency: 'EUR' }
        },
        certainty: 'exact',
        reasonCode: 'explicit_correction',
        evidence: [{ turnId, quote }]
      }]
    }]
  });
  const assistant = await applyReconciliationPlan({
    profile: baseProfile(), notes: baseNotes(),
    plan: planFor('turn_assistant', 'I will write down €999k.', 'assistant_evidence'),
    ...common
  });
  assert.equal(assistant.rejectedGroups[0].code, 'evidence_role_not_client');

  const unfinalized = await applyReconciliationPlan({
    profile: baseProfile(), notes: baseNotes(),
    plan: planFor('turn_unfinalized', 'The value is €999k.', 'unfinalized_evidence'),
    ...common
  });
  assert.equal(unfinalized.rejectedGroups[0].code, 'evidence_turn_not_finalized');

  const inexact = await applyReconciliationPlan({
    profile: baseProfile(), notes: baseNotes(),
    plan: planFor('turn_owner', 'that is my spouse pension', 'inexact_evidence'),
    ...common
  });
  assert.equal(inexact.rejectedGroups[0].code, 'evidence_quote_not_exact');
});

await runCase('range endpoints are grounded while a model-created midpoint is refused', async () => {
  const operation = (operationId, value, certainty) => ({
    operationId,
    op: 'upsert_note',
    factId: 'monthly_spending',
    noteKind: 'fact',
    value,
    certainty,
    reasonCode: 'missing_note',
    evidence: [{ turnId: 'turn_range', quote: 'We spend between €3,000 and €3,500 per month.' }]
  });
  const plan = (op) => ({
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{ groupId: op.operationId, operations: [op] }]
  });
  const endpoints = await applyReconciliationPlan({
    profile: baseProfile(), notes: baseNotes(), plan: plan(operation('range_ok', { min: 3_000, max: 3_500 }, 'range')),
    ...common
  });
  assert.deepEqual(endpoints.acceptedGroupIds, ['range_ok']);
  assert.equal(endpoints.status, 'needs_profile_projection');
  assert.equal(endpoints.fullyProjected, false);
  assert.deepEqual(endpoints.unprojectedFactOperationIds, ['range_ok']);
  const midpoint = await applyReconciliationPlan({
    profile: baseProfile(), notes: baseNotes(), plan: plan(operation('midpoint_bad', 3_250, 'approximate')),
    ...common
  });
  assert.equal(midpoint.rejectedGroups[0].code, 'numeric_value_unsupported');
});

await runCase('a reconciler-created canonical date is rejected when the client stated only relative timing', async () => {
  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      operationGroups: [{
        groupId: 'invented_date',
        operations: [{
          operationId: 'invented_pension_start_date',
          op: 'upsert_note',
          factId: 'pension_benefit_start_age',
          noteKind: 'future_event',
          value: { eventId: 'partner_db_start', date: '2026-12-01' },
          certainty: 'approximate',
          reasonCode: 'future_event',
          evidence: [{
            turnId: 'turn_relative_date',
            quote: 'Her public-sector pension starts in December this year.'
          }]
        }]
      }]
    },
    ...common
  });
  assert.equal(result.status, 'no_change');
  assert.equal(result.rejectedGroups[0].code, 'date_value_unsupported');
  assert.equal(result.profile.assumptions.values.planning.futureEvents?.length ?? 0, 0);
});

await runCase('identical figures require entity binding and accepted scalar facts remain fail-closed', async () => {
  const profile = normalizeHouseholdProfile({
    ...baseProfile(),
    assets: [{
      assetId: 'asset_etf',
      ownerIds: ['primary'],
      type: 'investment',
      label: 'ETF account',
      currentValue: { amount: 319_000, currency: 'EUR' }
    }]
  });
  const notes = [
    ...baseNotes(),
    normalizePlanningNoteV1({
      noteId: 'note_etf',
      noteKind: 'position',
      factId: 'asset_position',
      factInstanceId: 'asset_position:asset_etf',
      entityId: 'asset_etf',
      ownerId: 'primary',
      value: profile.assets[0],
      certainty: 'exact',
      lifecycle: 'active',
      reviewStatus: 'provisional',
      source: 'realtime_note',
      evidenceRefs: [],
      replacesNoteIds: [],
      createdAt: NOW
    })
  ];
  const planFor = (operationId, turnId, quote) => ({
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{
      groupId: operationId,
      operations: [{
        operationId,
        op: 'upsert_note',
        factId: 'pension_current_value',
        factInstanceId: 'pension_current_value:pension_old_dc',
        entityId: 'pension_old_dc',
        ownerId: 'primary',
        noteKind: 'fact',
        value: { amount: 319_000, currency: 'EUR' },
        certainty: 'exact',
        reasonCode: 'missing_note',
        evidence: [{ turnId, quote }]
      }]
    }]
  });
  const ambiguous = await applyReconciliationPlan({
    profile,
    notes,
    plan: planFor('identical_ambiguous', 'turn_same_value', turns[7].text),
    ...common
  });
  assert.equal(ambiguous.rejectedGroups[0].code, 'numeric_entity_binding_ambiguous');

  const bound = await applyReconciliationPlan({
    profile,
    notes,
    plan: planFor('identical_bound', 'turn_pensions', 'My old DC pension is about €319k.'),
    ...common
  });
  assert.equal(bound.rejectedGroups.length, 0);
  assert.equal(bound.status, 'needs_profile_projection');
  assert.deepEqual(bound.unprojectedFactOperationIds, ['identical_bound']);
});

await runCase('older transcript evidence cannot override a note backed by a newer client correction', async () => {
  const notes = baseNotes();
  notes[0] = normalizePlanningNoteV1({
    ...notes[0],
    evidenceRefs: [evidenceRef(turns[2], "Actually that is my wife's pension, not mine.")]
  });
  const plan = {
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{
      groupId: 'older_evidence',
      operations: [{
        operationId: 'older_evidence',
        op: 'correct_note',
        targetNoteId: 'note_old_dc',
        factId: 'pension_positions',
        entityId: 'pension_old_dc',
        ownerId: 'primary',
        noteKind: 'position',
        value: notes[0].value,
        certainty: 'approximate',
        reasonCode: 'explicit_correction',
        evidence: [{ turnId: 'turn_pensions', quote: 'My old DC pension is about €319k.' }]
      }]
    }]
  };
  const result = await applyReconciliationPlan({
    profile: baseProfile(), notes, plan, ...common
  });
  assert.equal(result.rejectedGroups[0].code, 'evidence_older_than_target');
  assert.equal(result.profile.revision, 0);
});

await runCase('a legacy-import note without retained source evidence cannot be automatically retracted', async () => {
  const retractPlan = {
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{
      groupId: 'legacy_retract',
      operations: [{
        operationId: 'legacy_retract',
        op: 'retract_note',
        targetNoteId: 'note_old_dc',
        factId: 'pension_positions',
        entityId: 'pension_old_dc',
        ownerId: 'primary',
        reasonCode: 'stale_note',
        evidence: [{
          turnId: 'turn_retract',
          quote: turns.find((turn) => turn.turnId === 'turn_retract').text
        }]
      }]
    }]
  };
  const legacyNotes = (evidenceRefs) => {
    const notes = baseNotes();
    notes[0] = normalizePlanningNoteV1({
      ...notes[0],
      source: 'legacy_import',
      evidenceRefs
    });
    return notes;
  };
  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: legacyNotes([]),
    plan: retractPlan,
    ...common
  });
  assert.equal(result.status, 'no_change');
  assert.equal(result.rejectedGroups[0].code, 'legacy_retraction_evidence_unavailable');
  assert.equal(result.notes.find((note) => note.noteId === 'note_old_dc').lifecycle, 'active');
  assert.equal(result.profile.pensions.some((pension) => pension.pensionId === 'pension_old_dc'), true);

  const assistantTurn = turns.find((turn) => turn.turnId === 'turn_assistant');
  const invalidStoredEvidence = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: legacyNotes([{ turnId: assistantTurn.turnId, start: 0, end: assistantTurn.text.length }]),
    plan: retractPlan,
    ...common
  });
  assert.equal(invalidStoredEvidence.rejectedGroups[0].code, 'legacy_retraction_evidence_unavailable');
  assert.equal(invalidStoredEvidence.profile.pensions.some((pension) => pension.pensionId === 'pension_old_dc'), true);
});

await runCase('an explicitly evidenced same-owner merge is stable and removes only the duplicate entity', async () => {
  const profile = baseProfile();
  profile.pensions[1] = {
    ...profile.pensions[0],
    pensionId: 'pension_stated_total'
  };
  const notes = baseNotes();
  notes[1] = normalizePlanningNoteV1({
    ...notes[1],
    value: profile.pensions[1]
  });
  const result = await applyReconciliationPlan({
    profile: normalizeHouseholdProfile(profile),
    notes,
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      operationGroups: [{
        groupId: 'merge_duplicate',
        operations: [{
          operationId: 'merge_duplicate',
          op: 'merge_entities',
          factId: 'pension_positions',
          ownerId: 'primary',
          targetEntityId: 'pension_old_dc',
          sourceEntityIds: ['pension_stated_total'],
          reasonCode: 'duplicate_entity',
          evidence: [{ turnId: 'turn_merge', quote: turns[8].text }]
        }]
      }]
    },
    ...common
  });
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.profile.pensions.map((pension) => pension.pensionId), ['pension_old_dc']);
  assert.equal(result.notes.find((note) => note.noteId === 'note_pension_total').lifecycle, 'superseded');
});

await runCase('clean review advances ledger review state without changing the financial profile revision', async () => {
  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan: {
      schemaVersion: 1,
      verdict: 'clean',
      reviewedNoteIds: ['note_old_dc'],
      operationGroups: []
    },
    ...common
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.profile.revision, 0);
  assert.equal(result.profileChanged, false);
  assert.equal(result.notes.find((note) => note.noteId === 'note_old_dc').reviewStatus, 'planner_verified');
});

await runCase('span-free, wrong-role and out-of-bounds reviewed notes fail review without failing reconciliation', async () => {
  const plan = {
    schemaVersion: 1,
    verdict: 'clean',
    reviewedNoteIds: ['note_old_dc'],
    operationGroups: []
  };
  const review = async (evidenceRefs) => {
    const notes = baseNotes();
    notes[0] = normalizePlanningNoteV1({ ...notes[0], evidenceRefs });
    return applyReconciliationPlan({ profile: baseProfile(), notes, plan, ...common });
  };

  const missing = await review([]);
  assert.equal(missing.status, 'no_change');
  assert.deepEqual(missing.reviewOutcomes, [{
    noteId: 'note_old_dc', status: 'rejected', code: 'review_evidence_missing'
  }]);
  assert.equal(missing.notes[0].reviewStatus, 'provisional');

  const assistantTurn = turns.find((turn) => turn.turnId === 'turn_assistant');
  const wrongRole = await review([{ turnId: assistantTurn.turnId, start: 0, end: assistantTurn.text.length }]);
  assert.equal(wrongRole.status, 'no_change');
  assert.equal(wrongRole.reviewOutcomes[0].code, 'review_evidence_role_not_client');
  assert.equal(wrongRole.notes[0].reviewStatus, 'provisional');

  const pensionTurn = turns.find((turn) => turn.turnId === 'turn_pensions');
  const outsideTurn = await review([{ turnId: pensionTurn.turnId, start: 0, end: pensionTurn.text.length + 1 }]);
  assert.equal(outsideTurn.status, 'no_change');
  assert.equal(outsideTurn.reviewOutcomes[0].code, 'review_evidence_span_invalid');
  assert.equal(outsideTurn.notes[0].reviewStatus, 'provisional');
});

await runCase('the plan hash is server-bound, stable and prevents duplicate mutation', async () => {
  const input = buildReconciliationIdempotencyInput({
    sessionId: common.sessionId,
    transcriptWatermark: common.transcriptWatermark,
    baseProfileRevision: 0,
    plan: summaryPlan()
  });
  const firstHash = await hashReconciliationPlan(input);
  const secondHash = await hashReconciliationPlan({
    baseProfileRevision: 0,
    transcriptWatermark: common.transcriptWatermark,
    plan: summaryPlan(),
    sessionId: common.sessionId
  });
  assert.equal(firstHash, secondHash);

  const duplicate = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan: summaryPlan(),
    appliedPlanHashes: [firstHash],
    ...common
  });
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.profile.revision, 0);
  assert.equal(duplicate.notes.some((note) => note.noteId === 'recon_reclass_total'), false);
});

await runCase('stale revisions and model-owned control fields fail closed', async () => {
  const conflict = await applyReconciliationPlan({
    profile: baseProfile(), notes: baseNotes(), plan: summaryPlan(),
    ...common,
    baseProfileRevision: 9
  });
  assert.equal(conflict.status, 'conflicted');
  assert.equal(conflict.profile.revision, 0);

  const controlled = normalizeReconciliationPlanV1({
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{
      groupId: 'control',
      operations: [{
        operationId: 'confirm_forbidden',
        op: 'set_scenario',
        factId: 'intended_retirement_age',
        noteKind: 'scenario_option',
        value: { scenarioId: 'now', confirmedAt: LATER },
        certainty: 'exact',
        reasonCode: 'scenario_option',
        evidence: [{ turnId: 'turn_future', quote: 'I could retire at 58' }]
      }]
    }]
  });
  const rejected = await applyReconciliationPlan({
    profile: baseProfile(), notes: baseNotes(), plan: controlled, ...common
  });
  assert.equal(rejected.rejectedGroups[0].code, 'control_field_forbidden');
});

await runCase('a whole-profile invariant failure rolls back an otherwise accepted correction', async () => {
  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      operationGroups: [{
        groupId: 'invalid_pension_type',
        operations: [{
          operationId: 'invalid_pension_type',
          op: 'correct_note',
          targetNoteId: 'note_old_dc',
          factId: 'pension_positions',
          entityId: 'pension_old_dc',
          ownerId: 'primary',
          noteKind: 'position',
          value: {
            pensionId: 'pension_old_dc',
            ownerId: 'primary',
            type: 'invented_pension_type',
            label: 'Old DC pension',
            currentValue: { amount: 319_000, currency: 'EUR' }
          },
          certainty: 'approximate',
          reasonCode: 'incorrect_classification',
          evidence: [{ turnId: 'turn_pensions', quote: 'My old DC pension is about €319k.' }]
        }]
      }]
    },
    ...common
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.profile.revision, 0);
  assert.equal(result.profile.pensions[0].type, 'occupational');
  assert.equal(result.notes.some((note) => note.noteId === 'recon_invalid_pension_type'), false);
  assert.equal(result.rejectedGroups.at(-1).code, 'profile_invariant_failed');
  assert.equal(result.operationOutcomes[0].status, 'discarded_global_invariant');
});

await runCase('the compact age-57 corpus reconciles positions, semantics, future money and unsettled scenarios safely', async () => {
  const result = await applyReconciliationPlan({
    profile: p57Profile(),
    notes: p57Notes(),
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [
        'note_p57_old_dc',
        'note_p57_prsa',
        'note_p57_current_dc',
        'note_p57_total',
        'note_p57_partner_db',
        'note_p57_inheritance',
        'note_p57_count'
      ],
      operationGroups: [
        {
          groupId: 'p57_summary',
          operations: [{
            operationId: 'p57_summary',
            op: 'reclassify_note',
            targetNoteId: 'note_p57_total',
            factId: 'pension_positions',
            entityId: 'p57_rounded_total',
            ownerId: 'primary',
            noteKind: 'summary',
            value: {
              label: 'Client-stated rounded pension total',
              amount: { amount: 1_070_000, currency: 'EUR' }
            },
            certainty: 'approximate',
            reasonCode: 'aggregate_summary',
            evidence: [{ turnId: p57Turn.turnId, quote: "together they're roughly €1.07 million" }]
          }]
        },
        {
          groupId: 'p57_db_semantics',
          operations: [{
            operationId: 'p57_db_semantics',
            op: 'correct_note',
            targetNoteId: 'note_p57_partner_db',
            factId: 'pension_positions',
            entityId: 'p57_partner_db',
            ownerId: 'partner',
            noteKind: 'position',
            value: {
              pensionId: 'p57_partner_db',
              ownerId: 'partner',
              type: 'defined_benefit',
              label: 'Public-sector DB pension',
              projectedAnnualIncome: { amount: 35_000, currency: 'EUR' },
              retirementLumpSum: { amount: 105_000, currency: 'EUR' },
              benefitStartAge: 60,
              contributionStatus: 'not_applicable'
            },
            certainty: 'approximate',
            reasonCode: 'incorrect_classification',
            evidence: [{
              turnId: p57Turn.turnId,
              quote: "My wife's public-sector defined benefit pension pays about €35k a year from age 60 with a €105k lump sum"
            }]
          }]
        },
        {
          groupId: 'p57_future_inheritance',
          operations: [{
            operationId: 'p57_future_inheritance',
            op: 'reclassify_note',
            targetNoteId: 'note_p57_inheritance',
            factId: 'asset_position',
            entityId: 'p57_future_inheritance',
            ownerId: 'partner',
            noteKind: 'future_event',
            value: {
              eventId: 'p57_expected_inheritance',
              amount: { amount: 50_000, currency: 'EUR' },
              timing: 'next_few_months'
            },
            certainty: 'approximate',
            reasonCode: 'future_event',
            evidence: [{
              turnId: p57Turn.turnId,
              quote: 'She also expects an inheritance of about €50k in a few months'
            }]
          }]
        },
        {
          groupId: 'p57_scenarios',
          operations: [
            {
              operationId: 'p57_retire_now',
              op: 'set_scenario',
              factId: 'intended_retirement_age',
              factInstanceId: 'intended_retirement_age:retire_now',
              noteKind: 'scenario_option',
              value: { scenarioId: 'retire_now', status: 'exploring' },
              certainty: 'exact',
              reasonCode: 'scenario_option',
              evidence: [{ turnId: p57Turn.turnId, quote: 'retire now' }]
            },
            {
              operationId: 'p57_retire_58',
              op: 'set_scenario',
              factId: 'intended_retirement_age',
              factInstanceId: 'intended_retirement_age:retire_58',
              noteKind: 'scenario_option',
              value: { scenarioId: 'retire_58', retirementAge: 58, status: 'exploring' },
              certainty: 'exact',
              reasonCode: 'scenario_option',
              evidence: [{ turnId: p57Turn.turnId, quote: 'retire at 58' }]
            },
            {
              operationId: 'p57_contract_60',
              op: 'set_scenario',
              factId: 'intended_retirement_age',
              factInstanceId: 'intended_retirement_age:contract_60',
              noteKind: 'scenario_option',
              value: { scenarioId: 'contract_60', employmentEndAge: 60, status: 'exploring' },
              certainty: 'exact',
              reasonCode: 'scenario_option',
              evidence: [{ turnId: p57Turn.turnId, quote: 'contract until 60' }]
            }
          ]
        },
        {
          groupId: 'p57_count_clarification',
          operations: [{
            operationId: 'p57_count_clarification',
            op: 'request_clarification',
            reasonCode: 'ambiguous_reference',
            evidence: [{ turnId: p57Turn.turnId, quote: 'I have three pensions' }],
            value: {
              needId: 'need_p57_count_binding',
              factId: 'pension_positions',
              factInstanceId: 'pension_positions:primary_count_check',
              ownerId: 'primary',
              entityLabel: 'your three named pensions',
              reasonCode: 'count_requires_named_positions',
              prompt: 'Please confirm the three named pensions are the complete list and the rounded total is not another pension.',
              importance: 'required',
              blockingModuleIds: ['pension_projection'],
              answerPolicy: 'unknown_allowed',
              status: 'open'
            }
          }]
        }
      ]
    },
    ...p57Common
  });

  assert.equal(result.status, 'applied');
  assert.equal(result.rejectedGroups.length, 0);
  assert.equal(result.acceptedOperationIds.length, 7);
  assert.equal(result.profile.revision, 1);
  assert.deepEqual(
    result.profile.pensions.filter((pension) => pension.ownerId === 'primary').map((pension) => pension.pensionId),
    ['p57_old_dc', 'p57_prsa', 'p57_current_dc']
  );
  const partnerDb = result.profile.pensions.find((pension) => pension.pensionId === 'p57_partner_db');
  assert.equal(partnerDb.ownerId, 'partner');
  assert.equal(partnerDb.currentValue, undefined);
  assert.equal(partnerDb.projectedAnnualIncome.amount, 35_000);
  assert.equal(partnerDb.retirementLumpSum.amount, 105_000);
  assert.equal(partnerDb.benefitStartAge, 60);
  assert.equal(partnerDb.contributionStatus, 'not_applicable');
  assert.equal(result.profile.assets.some((asset) => asset.assetId === 'p57_future_inheritance'), false);
  assert.equal(result.profile.assumptions.values.planning.statedSummaries.length, 1);
  assert.equal(result.profile.assumptions.values.planning.statedSummaries[0].value.amount.amount, 1_070_000);
  assert.equal(result.profile.assumptions.values.planning.futureEvents.length, 1);
  assert.equal(result.profile.assumptions.values.planning.futureEvents[0].value.amount.amount, 50_000);
  assert.deepEqual(
    result.profile.assumptions.values.planning.decisionScenarios
      .map((scenario) => scenario.value.scenarioId)
      .sort(),
    ['contract_60', 'retire_58', 'retire_now']
  );
  assert.equal(result.profile.primaryPerson.intendedRetirementAge, undefined);
  assert.equal(result.clarificationNeeds[0].factInstanceId, 'pension_positions:primary_count_check');
  assert.equal(result.clarificationNeeds[0].ownerId, 'primary');
  assert.equal(result.notes.some((note) => (
    note.noteKind === 'position'
      && note.lifecycle === 'active'
      && note.entityId === 'p57_rounded_total'
  )), false);
  assert.equal(result.reviewOutcomes.every((outcome) => outcome.status === 'verified'), true);
});

await runCase('the standalone projector also keeps summary-shaped money outside current holdings', () => {
  const profile = baseProfile();
  const notes = baseNotes();
  notes[1] = normalizePlanningNoteV1({
    ...notes[1],
    lifecycle: 'superseded',
    reviewStatus: 'planner_corrected',
    reviewedAt: LATER
  });
  notes.push(normalizePlanningNoteV1({
    ...notes[1],
    noteId: 'summary_total',
    noteKind: 'summary',
    lifecycle: 'active',
    source: 'planner_reconciliation',
    evidenceRefs: [evidenceRef(turns[0], 'Total pensions are about €1.07 million.')],
    replacesNoteIds: ['note_pension_total'],
    value: {
      pensionId: 'pension_stated_total',
      ownerId: 'primary',
      type: 'other',
      currentValue: { amount: 1_070_000, currency: 'EUR' }
    },
    createdAt: LATER
  }));
  const projected = projectPlanningNotesToProfile(profile, notes);
  assert.deepEqual(projected.pensions.map((pension) => pension.pensionId), ['pension_old_dc']);
  assert.equal(projected.assumptions.values.planning.statedSummaries.length, 1);
});

console.log('Planning reconciliation checks passed.');
