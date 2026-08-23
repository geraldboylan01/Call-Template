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
  projectPlanningNotesToProfile,
  splitIndependentOperationGroups
} from '../js/planning/reconciliation.js';
import {
  createHouseholdProfile,
  hasOwnerConfirmedNone,
  normalizeHouseholdProfile
} from '../js/planning/profile.js';

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
  },
  // Appended, never inserted: cases below index into `turns` positionally.
  {
    turnId: 'turn_spend_first',
    role: 'user',
    finalized: true,
    sequence: 12,
    text: 'We spend about €5,800 a month.'
  },
  {
    turnId: 'turn_spend_corrected',
    role: 'user',
    finalized: true,
    sequence: 13,
    text: 'Actually, make that €6,200 a month.'
  },
  {
    turnId: 'turn_aggregate_first',
    role: 'user',
    finalized: true,
    sequence: 14,
    text: "There's about a million across the pensions I think."
  },
  {
    turnId: 'turn_named_after',
    role: 'user',
    finalized: true,
    sequence: 15,
    text: "The pensions: one's about 319,000, the Zurich one is 415,000 and the work one is 339,000."
  },
  {
    turnId: 'turn_coincidental_holding',
    role: 'user',
    finalized: true,
    sequence: 16,
    text: 'I also hold a separate buyout bond worth 1,073,000 in my own name.'
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

// A scalar correction only counts if the analysis reads it. These are the three
// outcomes the bridge has to keep apart: a path the registry and the entity
// decide between them, a path that would need a guess, and a "scalar" that is
// really a collection and must never touch it.
await runCase('a scalar fact reaches its profile path, or stays unprojected rather than guess', async () => {
  const scalarPlan = (operationId, factId, value, extra = {}) => ({
    schemaVersion: 1,
    verdict: 'changes_proposed',
    reviewedNoteIds: [],
    operationGroups: [{
      groupId: operationId,
      operations: [{
        operationId,
        op: 'upsert_note',
        factId,
        noteKind: 'fact',
        certainty: 'exact',
        reasonCode: 'missing_note',
        value,
        evidence: [{ turnId: 'turn_future', quote: 'I could retire at 58' }],
        ...extra
      }]
    }]
  });

  // Owner decides between /primaryPerson and /partner.
  const owned = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan: scalarPlan('retire_58', 'intended_retirement_age', 58, {
      factInstanceId: 'intended_retirement_age:primary',
      entityId: 'primary',
      ownerId: 'primary'
    }),
    ...common
  });
  assert.equal(owned.status, 'applied');
  assert.deepEqual(owned.unprojectedFactOperationIds, []);
  assert.equal(owned.profile.primaryPerson.intendedRetirementAge, 58);
  assert.equal(owned.profile.partner?.intendedRetirementAge, undefined,
    'an owner-scoped scalar must not also land on the other person');

  // A count is not a scalar: /pensions is a collection, and writing 3 there
  // would replace every holding with a number. Asserted on the projector so the
  // guard is proved directly rather than through whichever validation rule
  // happens to refuse this shape first.
  const countNote = normalizePlanningNoteV1({
    noteId: 'note_count',
    noteKind: 'fact',
    factId: 'pension_positions',
    factInstanceId: 'pension_positions:primary_count',
    ownerId: 'primary',
    value: 3,
    certainty: 'exact',
    lifecycle: 'active',
    reviewStatus: 'provisional',
    source: 'realtime_note',
    evidenceRefs: [],
    replacesNoteIds: [],
    createdAt: NOW
  });
  const projected = projectPlanningNotesToProfile(baseProfile(), [...baseNotes(), countNote]);
  assert.equal(Array.isArray(projected.pensions), true, 'the holdings must remain a collection');
  assert.equal(projected.pensions.length, 2, 'the holdings must be untouched by a count');
});

// ---------------------------------------------------------------------------
// A FACT WHOSE CANONICAL HOME IS A FIELD INSIDE A PARENT OBJECT.
//
// `target_retirement_income` resolves to the leaf
// `/assumptions/values/retirement/targetIncomeToday`, but the live lane's mapper
// answers for the PARENT, `/assumptions/values/retirement`, with
// `{targetIncomeToday: 45000}`. A `===` comparison read that as a disagreement,
// dropped the mapped value, and fell back to the RAW note value -- so
// `{amount: 45000, currency: "EUR"}` was written into a slot that holds a bare
// number. It normalised cleanly, because the profile contract cannot tell one
// object from another there, and Pension Projection then refused to run against
// its own required input with `analysis_missing_information` -- on a figure the
// client had stated plainly and the live lane had canonicalised correctly.
//
// The direction of the relationship is the whole safety argument, so all three
// refusals are pinned here beside the fix.
// ---------------------------------------------------------------------------

await runCase('a mapper answering for a parent path canonicalises the leaf, and only downwards', async () => {
  const targetIncomeNote = (value) => normalizePlanningNoteV1({
    noteId: 'note_target_income',
    noteKind: 'fact',
    factId: 'target_retirement_income',
    factInstanceId: 'target_retirement_income',
    value,
    certainty: 'exact',
    lifecycle: 'active',
    reviewStatus: 'provisional',
    source: 'realtime_note',
    evidenceRefs: [],
    replacesNoteIds: [],
    createdAt: NOW
  });
  const leaf = '/assumptions/values/retirement/targetIncomeToday';
  const money = { amount: 45_000, currency: 'EUR' };
  const readLeaf = (profile) => profile.assumptions.values.retirement?.targetIncomeToday;

  // Without a mapper the raw money object is all there is, which is the
  // behaviour every other fact keeps. Stated so the fix below is visibly the
  // mapper's doing and not a change to the bridge's default.
  assert.deepEqual(
    readLeaf(projectPlanningNotesToProfile(baseProfile(), [...baseNotes(), targetIncomeNote(money)])),
    money,
    'with no mapper the bridge still writes exactly what the note holds'
  );

  // THE FIX: the mapper answers for the parent, and the leaf gets the number.
  const parentMapper = () => ({
    fieldPath: '/assumptions/values/retirement',
    canonicalValue: { targetIncomeToday: 45_000 },
    displayValue: money
  });
  assert.equal(
    readLeaf(projectPlanningNotesToProfile(
      baseProfile(), [...baseNotes(), targetIncomeNote(money)], { mapFactValue: parentMapper }
    )),
    45_000,
    'a parent-path mapping must canonicalise the leaf it actually contains'
  );

  // REFUSAL 1 — the mapper answers for something NARROWER than the resolved
  // path. `/goals/0` must never be written to `/goals`; the raw value stands.
  const narrowerMapper = () => ({
    fieldPath: `${leaf}/deeper`,
    canonicalValue: 1,
    displayValue: money
  });
  assert.deepEqual(
    readLeaf(projectPlanningNotesToProfile(
      baseProfile(), [...baseNotes(), targetIncomeNote(money)], { mapFactValue: narrowerMapper }
    )),
    money,
    'a mapping narrower than the resolved path must not be unwrapped into it'
  );

  // REFUSAL 2 — an ancestor whose canonical object does not actually carry the
  // remaining segment. Nothing is inferred; the raw value stands.
  const missingSegmentMapper = () => ({
    fieldPath: '/assumptions/values/retirement',
    canonicalValue: { somethingElse: 1 },
    displayValue: money
  });
  assert.deepEqual(
    readLeaf(projectPlanningNotesToProfile(
      baseProfile(), [...baseNotes(), targetIncomeNote(money)], { mapFactValue: missingSegmentMapper }
    )),
    money,
    'an ancestor mapping missing the leaf segment must not be guessed at'
  );

  // REFUSAL 3 — a root-ish fieldPath would address the whole profile.
  const rootMapper = () => ({
    fieldPath: '/',
    canonicalValue: { assumptions: { values: { retirement: { targetIncomeToday: 1 } } } },
    displayValue: money
  });
  assert.deepEqual(
    readLeaf(projectPlanningNotesToProfile(
      baseProfile(), [...baseNotes(), targetIncomeNote(money)], { mapFactValue: rootMapper }
    )),
    money,
    'a root mapping must never be walked into an arbitrary slot'
  );

  // And an explicit refusal still has the last word: no raw fallback.
  const refusingMapper = () => ({ refused: true });
  assert.equal(
    readLeaf(projectPlanningNotesToProfile(
      baseProfile(), [...baseNotes(), targetIncomeNote(money)], { mapFactValue: refusingMapper }
    )),
    undefined,
    'a mapper that owns a fact and refuses its value must leave the slot empty'
  );
});

// ---------------------------------------------------------------------------
// THE TWO SHAPES A REAL PLANNER MODEL GOT WRONG.
//
// A paid probe against gpt-5.6-luna produced both, and neither failed loudly:
//
//   1. `{entityId, ownerId, type, grossAnnual}` for an income position. The
//      prompt said to copy the identity into "the canonical record's entity ID
//      field" and no record has one — income sources carry `incomeId`. The
//      record is malformed, so nothing reaches /incomeSources.
//   2. `pension_current_value` emitted as noteKind position. It is a value ABOUT
//      a pension, not a pension. The position projector only walks
//      POSITION_PROJECTIONS keys and the scalar projector only takes
//      noteKind 'fact', so the note falls between the two: accepted, applied,
//      and canonically invisible.
//
// The projector is right in both cases. These pin its behaviour so the contract
// the prompt now hands the model cannot drift away from what is enforced here.
// ---------------------------------------------------------------------------

await runCase('a position record is keyed by its own id field, and only a position fact may be one', async () => {
  const positionNote = (over) => normalizePlanningNoteV1({
    noteId: 'note_shape',
    noteKind: 'position',
    factId: 'income_sources',
    factInstanceId: 'income_sources:income_probe',
    entityId: 'income_probe',
    ownerId: 'primary',
    certainty: 'exact',
    lifecycle: 'active',
    reviewStatus: 'provisional',
    source: 'realtime_note',
    evidenceRefs: [],
    replacesNoteIds: [],
    createdAt: NOW,
    ...over
  });
  const incomes = (profile) => (profile.incomeSources || [])
    .map((item) => ({ incomeId: item.incomeId, gross: item.grossAnnual?.amount }));

  // 1. THE MODEL'S SHAPE: `entityId` inside the record. Quarantined, and the
  //    quarantine is reported rather than swallowed.
  const wrongKey = [];
  const withEntityId = projectPlanningNotesToProfile(
    baseProfile(),
    [...baseNotes(), positionNote({
      value: {
        entityId: 'income_probe', ownerId: 'primary', type: 'employment',
        grossAnnual: { amount: 95_000, currency: 'EUR' }
      }
    })],
    { onUnprojectable: (entry) => wrongKey.push(entry) }
  );
  assert.deepEqual(incomes(withEntityId), [],
    'a record keyed by entityId is not a canonical income source and must not reach the profile');
  assert.equal(wrongKey.some((entry) => entry.code === 'position_entity_mismatch'), true,
    'and the mismatch must be reported, not silently dropped');

  // 2. THE CORRECT SHAPE: `incomeId`, equal to the note's entityId. Canonical.
  const withIncomeId = projectPlanningNotesToProfile(
    baseProfile(),
    [...baseNotes(), positionNote({
      value: {
        incomeId: 'income_probe', ownerId: 'primary', type: 'employment',
        label: 'Employment income', grossAnnual: { amount: 95_000, currency: 'EUR' }
      }
    })]
  );
  assert.deepEqual(incomes(withIncomeId), [{ incomeId: 'income_probe', gross: 95_000 }],
    'an accepted entity operation must actually become canonical');

  // 3. PENSIONS USE THEIR OWN KEY, so the rule is per-collection and not a
  //    single shared spelling that happens to work for income.
  const pensionNote = positionNote({
    noteId: 'note_pension_shape',
    factId: 'pension_positions',
    factInstanceId: 'pension_positions:pension_probe',
    entityId: 'pension_probe',
    value: {
      pensionId: 'pension_probe', ownerId: 'primary', type: 'occupational',
      currentValue: { amount: 319_000, currency: 'EUR' }
    }
  });
  const withPension = projectPlanningNotesToProfile(baseProfile(), [...baseNotes(), pensionNote]);
  assert.equal(
    withPension.pensions.find((item) => item.pensionId === 'pension_probe')?.currentValue?.amount,
    319_000,
    'a pension position record is keyed by pensionId'
  );

  // 4. A SCALAR FACT MAY NOT BE A POSITION. `pension_current_value` marked
  //    `position` reaches neither projector; the value stays where the client's
  //    words put it and the slot is untouched.
  const scalarAsPosition = positionNote({
    noteId: 'note_scalar_as_position',
    factId: 'pension_current_value',
    factInstanceId: 'pension_current_value:pension_old_dc',
    entityId: 'pension_old_dc',
    value: { amount: 999_999, currency: 'EUR' }
  });
  const before = baseProfile();
  const after = projectPlanningNotesToProfile(before, [...baseNotes(), scalarAsPosition]);
  assert.deepEqual(
    after.pensions.map((item) => item.currentValue?.amount),
    before.pensions.map((item) => item.currentValue?.amount),
    'a scalar fact emitted as a position must not reach the holdings it names'
  );
  assert.equal(after.pensions.some((item) => item.currentValue?.amount === 999_999), false,
    'and its figure must not appear anywhere in the collection');
});

await runCase('position-ledger projection preserves a canonical home-mortgage edge', () => {
  const linked = normalizeHouseholdProfile({
    ...baseProfile(),
    properties: [{
      propertyId: 'property_family_home',
      ownerIds: ['primary'],
      use: 'home',
      associatedLiabilityIds: ['liability_home_mortgage'],
      currentValue: { amount: 500_000, currency: 'EUR' }
    }],
    liabilities: [{
      liabilityId: 'liability_home_mortgage',
      ownerIds: ['primary'],
      type: 'mortgage',
      label: 'Mortgage',
      currentBalance: { amount: 350_000, currency: 'EUR' }
    }]
  });
  const positionNote = (over) => normalizePlanningNoteV1({
    noteId: over.noteId,
    noteKind: 'position',
    factId: over.factId,
    factInstanceId: `${over.factId}:${over.entityId}`,
    entityId: over.entityId,
    ownerId: 'primary',
    certainty: 'exact',
    lifecycle: 'active',
    reviewStatus: 'provisional',
    source: 'realtime_note',
    evidenceRefs: [],
    replacesNoteIds: [],
    createdAt: NOW,
    value: over.value
  });
  const projected = projectPlanningNotesToProfile(linked, [
    positionNote({
      noteId: 'note_family_home',
      factId: 'property_position',
      entityId: 'property_family_home',
      // This is the real ledger shape: the cross-position edge is not stored
      // in the property note even though it is already canonical in profile.
      value: {
        propertyId: 'property_family_home', ownerIds: ['primary'], use: 'home',
        associatedLiabilityIds: [], currentValue: { amount: 500_000, currency: 'EUR' }
      }
    }),
    positionNote({
      noteId: 'note_home_mortgage',
      factId: 'mortgage_position',
      entityId: 'liability_home_mortgage',
      value: {
        liabilityId: 'liability_home_mortgage', ownerIds: ['primary'], type: 'mortgage',
        label: 'Mortgage', currentBalance: { amount: 350_000, currency: 'EUR' }
      }
    })
  ]);
  assert.deepEqual(
    projected.properties[0].associatedLiabilityIds,
    ['liability_home_mortgage'],
    'a background reconciliation must not erase a valid cross-position edge'
  );
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
        // DECLARED atomicity. These two operations share no note, entity or
        // fact instance, so identity alone would treat them as independent and
        // the valid one would survive. The planner is asserting they belong
        // together, and a claimed group is honoured exactly as given -- which
        // is what this case exists to prove.
        atomic: true,
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

await runCase('a stated absence reaches the marker that readiness reads, and an unstated one never does', async () => {
  /* ELEVEN OF TWELVE entity_fact_mismatch REFUSALS WERE THIS ONE WRITE.
   *
   * The planner recording "my partner has no pension of their own" against the
   * partner, refused because a person is not valid for a pensions-collection
   * fact. One paid run retried it six times and never reached a module.
   *
   * The planner was right: canonical confirmed-none is keyed by collection AND
   * PERSON — /pensions/owner/<personId> — and there is no pension entity to
   * point at, which is what "none" means.
   *
   * AND FIXING ONLY THAT WOULD HAVE BEEN WORSE. Completion notes projected into
   * the `completions` sidecar and nowhere else, while every reader of an
   * absence looks at completionFacts.confirmedNonePaths. Accepting the note
   * without writing the marker would have turned a visible refusal into a
   * silent no-op: the planner would stop retrying and readiness would stay
   * open with nothing in the audit trail to say why. */
  const profile = normalizeHouseholdProfile({
    ...baseProfile(),
    pensions: [{
      pensionId: 'pension_primary_occ', ownerId: 'primary', type: 'occupational',
      currentValue: { amount: 319_000, currency: 'EUR' }
    }]
  });
  const SAID = 'My partner has no pension of their own.';
  const noneOperation = (over = {}) => ({
    operationId: 'op_none', op: 'set_completion', factId: 'pension_positions',
    factInstanceId: 'pension_positions:partner', noteKind: 'completion',
    value: { resolution: 'confirmed_none' }, certainty: 'exact',
    reasonCode: 'explicit_none',
    evidence: [{ turnId: 'turn_none', quote: SAID }],
    ...over
  });
  const attempt = async (operation, text = SAID) => {
    const result = await applyReconciliationPlan({
      profile, notes: [],
      plan: {
        schemaVersion: 1, verdict: 'changes_proposed', reviewedNoteIds: [],
        operationGroups: [{ groupId: 'none', operations: [operation] }]
      },
      ...common,
      transcriptTurns: [...turns,
        { turnId: 'turn_none', role: 'user', finalized: true, sequence: 96, text }],
      transcriptWatermark: 'turn_none'
    });
    return {
      code: result.rejectedGroups[0]?.code ?? null,
      markers: result.profile.assumptions?.values?.completionFacts?.confirmedNonePaths || {},
      profile: result.profile
    };
  };

  /* SHOULD RECORD — exactly the operation the paid runs kept sending. */
  const partner = await attempt(noneOperation({ entityId: 'partner', ownerId: 'partner' }));
  assert.equal(partner.code, null, 'a person is the right scope for their own absence');
  assert.equal(partner.markers['/pensions/owner/partner'], true,
    'and it must reach the marker readiness reads, not only the sidecar');
  assert.equal(hasOwnerConfirmedNone(partner.profile, '/pensions', 'partner'), true,
    'so the canonical reader agrees the partner holds none');

  /* ONE PERSON'S ABSENCE IS NOT THE OTHER'S. */
  assert.equal(hasOwnerConfirmedNone(partner.profile, '/pensions', 'primary'), false,
    "the partner having none must never close the client's own need");

  /* HOUSEHOLD-WIDE — no owner named, so the whole collection is empty. */
  const HOUSEHOLD_SAID = 'We have no pensions at all.';
  const household = await attempt(
    noneOperation({
      ownerId: undefined, entityId: undefined,
      evidence: [{ turnId: 'turn_none', quote: HOUSEHOLD_SAID }]
    }),
    HOUSEHOLD_SAID
  );
  assert.equal(household.code, null, 'a household-wide none is allowed');
  assert.equal(household.markers['/pensions'], true, 'and marks the collection itself');

  /* A NARROW CITATION OF A CLEAR SENTENCE. Evidence rules push the planner
   * toward the tightest span, so "no pension of their own" can arrive as a
   * fragment that no longer reads as a negation by itself. The question is
   * whether the CLIENT said there were none — a property of what they said,
   * not of how tightly it was quoted. Nine refusals in the 2026-08-18 paid
   * batch were this, on turns where the client had said it twice. */
  const REAL_TURN = 'No, my partner has no pension of their own, no occupational pension, '
    + 'PRSA or personal pension.';
  for (const fragment of ['no pension of their own', 'PRSA or personal pension']) {
    const narrow = await attempt(
      noneOperation({
        entityId: 'partner', ownerId: 'partner',
        evidence: [{ turnId: 'turn_none', quote: fragment }]
      }),
      REAL_TURN
    );
    assert.equal(narrow.code, null,
      `a narrow citation of a turn that plainly states the absence must bind (${fragment})`);
    assert.equal(narrow.markers['/pensions/owner/partner'], true,
      'and must still reach the marker');
  }

  /* MUST FAIL CLOSED — an absence the client never stated. The quote is a real
   * span of a real turn, and says the opposite. */
  const unsaid = await attempt(
    noneOperation({
      entityId: 'partner', ownerId: 'partner',
      evidence: [{ turnId: 'turn_none', quote: 'My partner has a big pension.' }]
    }),
    'My partner has a big pension.'
  );
  assert.equal(unsaid.code, 'completion_none_unsupported',
    'citing a real quote that says the opposite must not record an absence');
  assert.equal(unsaid.markers['/pensions/owner/partner'], undefined,
    'and must leave no marker behind');

  /* MUST FAIL CLOSED — the exemption is for completions only. An ordinary
   * pension write still cannot be aimed at a person. */
  const ordinary = await attempt({
    operationId: 'op_position', op: 'upsert_note', factId: 'pension_positions',
    factInstanceId: 'pension_positions:partner', noteKind: 'position',
    entityId: 'partner', ownerId: 'partner',
    value: {
      pensionId: 'partner', ownerId: 'partner', type: 'occupational',
      currentValue: { amount: 50_000, currency: 'EUR' }
    },
    certainty: 'exact', reasonCode: 'missing_note',
    evidence: [{ turnId: 'turn_none', quote: SAID }]
  });
  assert.equal(ordinary.code, 'entity_fact_mismatch',
    'a holding still needs a holding to attach to');
});

await runCase('a person is named by the pronoun in the clause holding the number, and a mixed sentence binds neither loosely', async () => {
  /* THE PRIMARY CLIENT COULD NEVER SATISFY THIS CHECK.
   *
   * Their label is "you" — three characters, dropped by significantCueTerms'
   * length rule — so the cue list was EMPTY and quoteHasCue returned false for
   * every sentence ever spoken. The check refused correct and incorrect
   * attributions identically, which is a dead rule rather than a fail-closed
   * one. The partner, labelled "your partner", worked fine; the asymmetry is
   * the tell.
   *
   * A person is named by grammar, and the grammar is LOCAL: "she's retiring at
   * 62 and I'm going at 65" attributes each number by the pronoun in its own
   * clause. Reading the whole quote finds both pronouns and would bind either
   * number to either person. */
  const profile = normalizeHouseholdProfile({
    ...baseProfile(),
    pensions: [{
      pensionId: 'pension_sole', ownerId: 'primary', type: 'occupational',
      currentValue: { amount: 319_000, currency: 'EUR' }
    }]
  });
  const ageOperation = (entityId, value) => ({
    operationId: 'op_age', op: 'upsert_note', factId: 'intended_retirement_age',
    factInstanceId: `intended_retirement_age:${entityId}`,
    entityId, ownerId: entityId, noteKind: 'fact', value,
    certainty: 'exact', reasonCode: 'missing_note',
    evidence: [{ turnId: 'turn_people', quote: null }]
  });
  const said = async (text, operation) => {
    const result = await applyReconciliationPlan({
      profile, notes: [],
      plan: {
        schemaVersion: 1, verdict: 'changes_proposed', reviewedNoteIds: [],
        operationGroups: [{
          groupId: 'ages',
          operations: [{ ...operation, evidence: [{ turnId: 'turn_people', quote: text }] }]
        }]
      },
      ...common,
      transcriptTurns: [...turns,
        { turnId: 'turn_people', role: 'user', finalized: true, sequence: 98, text }],
      transcriptWatermark: 'turn_people'
    });
    return result.rejectedGroups[0]?.code ?? null;
  };

  /* SHOULD BIND — the client speaks about themselves. */
  assert.equal(await said("I'm retiring at 62 and I have 3 children.", ageOperation('primary', 62)), null,
    'a first-person clause names the client');
  assert.equal(await said('Use 62 for me, not 65.', ageOperation('primary', 62)), null,
    '"for me" names them just as well');

  /* THE MIXED SENTENCE — each number belongs to the person in ITS clause. */
  const MIXED = "She's retiring at 62 and I'm going at 65.";
  assert.equal(await said(MIXED, ageOperation('primary', 65)), null,
    "the client's own figure binds to the client");
  assert.equal(await said(MIXED, ageOperation('partner', 62)), null,
    "and the partner's to the partner");
  assert.equal(await said(MIXED, ageOperation('primary', 62)), 'numeric_entity_binding_ambiguous',
    "the PARTNER's figure must never land on the client");
  assert.equal(await said(MIXED, ageOperation('partner', 65)), 'numeric_entity_binding_ambiguous',
    "nor the client's on the partner");

  /* COLLECTIVE — attributes nothing to anybody, so neither may have it. */
  const COLLECTIVE = "We're retiring at 62 and 65.";
  for (const entityId of ['primary', 'partner']) {
    assert.equal(await said(COLLECTIVE, ageOperation(entityId, 62)), 'numeric_entity_binding_ambiguous',
      `a collective statement gives ${entityId} no claim to either figure`);
  }
});

await runCase('a product that cannot receive contributions is neither a candidate for one nor a target of one', async () => {
  /* A buy-out bond takes no ongoing contribution — the profile has said so in
   * NON_CONTRIBUTORY_PENSION_TYPES all along, and the live lane already refuses
   * to ask about them. Counting one as a RIVAL made "I contribute 6% and my
   * employer contributes 8%" ambiguous between an occupational pension and a
   * PRB, when only one of them could ever have received it. */
  const RATE_QUOTE = 'I contribute 6% and my employer contributes 8%.';
  const withPensions = (pensions) => normalizeHouseholdProfile({ ...baseProfile(), pensions });
  const occupational = {
    pensionId: 'pension_occ', ownerId: 'primary', type: 'occupational',
    currentValue: { amount: 319_000, currency: 'EUR' }
  };
  const rateOperation = (entityId) => ({
    operationId: 'op_rate', op: 'upsert_note',
    factId: 'pension_employee_contribution_rate',
    factInstanceId: `pension_employee_contribution_rate:${entityId}`,
    entityId, ownerId: 'primary', noteKind: 'fact', value: 6,
    certainty: 'exact', reasonCode: 'missing_note',
    evidence: [{ turnId: 'turn_rate', quote: RATE_QUOTE }]
  });
  const attempt = async (pensions, operation) => {
    const result = await applyReconciliationPlan({
      profile: withPensions(pensions), notes: [],
      plan: {
        schemaVersion: 1, verdict: 'changes_proposed', reviewedNoteIds: [],
        operationGroups: [{ groupId: 'rate', operations: [operation] }]
      },
      ...common,
      transcriptTurns: [...turns,
        { turnId: 'turn_rate', role: 'user', finalized: true, sequence: 97, text: RATE_QUOTE }],
      transcriptWatermark: 'turn_rate'
    });
    return result.rejectedGroups[0]?.code ?? null;
  };

  const bond = {
    pensionId: 'pension_prb', ownerId: 'primary', type: 'buyout_bond',
    currentValue: { amount: 80_000, currency: 'EUR' }
  };
  const definedBenefit = {
    pensionId: 'pension_db', ownerId: 'primary', type: 'defined_benefit',
    projectedAnnualIncome: { amount: 30_000, currency: 'EUR' }
  };

  /* SHOULD BIND — the ineligible product is not a rival. */
  assert.equal(await attempt([occupational, bond], rateOperation('pension_occ')), null,
    'a buy-out bond cannot compete for a contribution rate');
  assert.equal(await attempt([occupational, definedBenefit], rateOperation('pension_occ')), null,
    'nor can a defined benefit scheme');

  /* MUST FAIL CLOSED — the rate must never reach the bond by any route. */
  assert.equal(await attempt([occupational, bond], rateOperation('pension_prb')),
    'contribution_not_supported_by_product',
    'a contribution rate aimed at a buy-out bond is refused outright');
  assert.equal(await attempt([bond], rateOperation('pension_prb')),
    'contribution_not_supported_by_product',
    'including when it is the only pension on the record');

  /* MUST FAIL CLOSED — two products that CAN both receive contributions. */
  assert.equal(await attempt([occupational, {
    pensionId: 'pension_prsa', ownerId: 'primary', type: 'prsa',
    currentValue: { amount: 80_000, currency: 'EUR' }
  }], rateOperation('pension_occ')), 'numeric_entity_binding_ambiguous',
  'two contribution-capable pensions stay ambiguous until the client says which');
});

await runCase('a figure binds to the only holding that could own it, and stops binding the moment a second exists', async () => {
  /* THE REAL CASE, FROM THE PAID RUNS.
   *
   * "I'm paying in 6%, with my employer paying 7% as far as I remember."
   *
   * Two rates in the cited span, so the binding check demanded a word from the
   * entity's label — "pension" — inside that span. The client had named the
   * pension in the previous sentence and there was only ONE pension on the
   * record, so there was no alternative they could have meant. Eleven writes
   * across the paid runs were refused this way; every one was re-proposed and
   * accepted a pass later, so the rule cost planner passes rather than data.
   *
   * WHICH ENTITY IS COUNTED FROM STATE. The second half of this case is the
   * half that matters: add a second pension and the cue is required again. */
  const onePension = normalizeHouseholdProfile({
    ...baseProfile(),
    pensions: [{
      pensionId: 'pension_realtime_primary_occupational_1',
      ownerId: 'primary',
      type: 'occupational',
      currentValue: { amount: 319_000, currency: 'EUR' }
    }]
  });
  const noteFor = (pension, noteId) => normalizePlanningNoteV1({
    noteId,
    noteKind: 'position',
    factId: 'pension_positions',
    factInstanceId: `pension_positions:${pension.pensionId}`,
    entityId: pension.pensionId,
    ownerId: 'primary',
    value: pension,
    certainty: 'exact',
    lifecycle: 'active',
    reviewStatus: 'provisional',
    source: 'realtime_note',
    evidenceRefs: [],
    replacesNoteIds: [],
    createdAt: NOW
  });
  const NARROW_QUOTE = "I'm paying in 6%, with my employer paying 7% as far as I remember.";
  const rateOperation = (entityId) => ({
    operationId: 'op_employee_rate',
    op: 'upsert_note',
    factId: 'pension_employee_contribution_rate',
    factInstanceId: `pension_employee_contribution_rate:${entityId}`,
    entityId,
    ownerId: 'primary',
    noteKind: 'fact',
    value: 6,
    certainty: 'exact',
    reasonCode: 'missing_note',
    evidence: [{ turnId: 'turn_rates', quote: NARROW_QUOTE }]
  });
  const attempt = (profile, notes, operation) => applyReconciliationPlan({
    profile,
    notes,
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      operationGroups: [{ groupId: 'rates', operations: [operation] }]
    },
    ...common,
    transcriptTurns: [...turns,
      { turnId: 'turn_rates', role: 'user', finalized: true, sequence: 99, text: NARROW_QUOTE },
      { turnId: 'turn_ages', role: 'user', finalized: true, sequence: 100,
        text: 'Use 62, please, sorry - I said 63, I meant 62.' }
    ],
    transcriptWatermark: 'turn_ages'
  });

  /* SHOULD BIND — one pension, so "which pension" has one possible answer. */
  const sole = await attempt(onePension, [noteFor(onePension.pensions[0], 'note_sole')],
    rateOperation('pension_realtime_primary_occupational_1'));
  assert.equal(sole.rejectedGroups.length, 0,
    'a rate must bind to the only pension on the record without naming it again');

  /* MUST FAIL CLOSED — a second pension makes the question real. */
  const twoPensions = normalizeHouseholdProfile({
    ...onePension,
    pensions: [...onePension.pensions, {
      pensionId: 'pension_realtime_old_scheme',
      ownerId: 'primary',
      type: 'personal',
      currentValue: { amount: 50_000, currency: 'EUR' }
    }]
  });
  const twoNotes = [
    noteFor(twoPensions.pensions[0], 'note_first'),
    noteFor(twoPensions.pensions[1], 'note_second')
  ];
  for (const [label, entityId] of [
    ['the pension it means', 'pension_realtime_primary_occupational_1'],
    ['the other pension', 'pension_realtime_old_scheme']
  ]) {
    const ambiguous = await attempt(twoPensions, twoNotes, rateOperation(entityId));
    assert.equal(ambiguous.rejectedGroups[0]?.code, 'numeric_entity_binding_ambiguous',
      `with two pensions the same quote must be refused, including for ${label}`);
  }

  /* MUST FAIL CLOSED — the figure already sits on another entity, however few
   * candidates there are. This trigger is deliberately independent. */
  const duplicated = await attempt(onePension, [
    noteFor(onePension.pensions[0], 'note_sole'),
    normalizePlanningNoteV1({
      noteId: 'note_elsewhere',
      noteKind: 'fact',
      factId: 'pension_employer_contribution_rate',
      factInstanceId: 'pension_employer_contribution_rate:pension_old_dc',
      entityId: 'pension_old_dc',
      ownerId: 'primary',
      value: 6,
      certainty: 'exact',
      lifecycle: 'active',
      reviewStatus: 'provisional',
      source: 'realtime_note',
      evidenceRefs: [],
      replacesNoteIds: [],
      createdAt: NOW
    })
  ], rateOperation('pension_realtime_primary_occupational_1'));
  assert.equal(duplicated.rejectedGroups[0]?.code, 'numeric_entity_binding_ambiguous',
    'a figure already recorded against another entity must still be tied to this one');

  /* MUST FAIL CLOSED — a person's figure still needs the person named, because
   * a household always has more than one candidate person. */
  const partnerAge = await attempt(onePension, [noteFor(onePension.pensions[0], 'note_sole')], {
    operationId: 'op_partner_retirement',
    op: 'upsert_note',
    factId: 'intended_retirement_age',
    factInstanceId: 'intended_retirement_age:partner',
    entityId: 'partner',
    ownerId: 'partner',
    noteKind: 'fact',
    value: 62,
    certainty: 'exact',
    reasonCode: 'missing_note',
    evidence: [{ turnId: 'turn_ages', quote: 'Use 62, please, sorry - I said 63, I meant 62.' }]
  });
  assert.equal(partnerAge.rejectedGroups[0]?.code, 'numeric_entity_binding_ambiguous',
    "a retirement age must not attach to the partner on a quote that never mentions them");
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
  // A scalar bound to one holding now REACHES the profile. It used to be
  // accepted into the ledger and stop there, because only positions and the
  // planning sidecars were projected — so the reconciler could correct a
  // pension value, record that it had, and leave the analysis reading the old
  // one. The path is the registry's own mapping with the entity's index in its
  // collection, so it is derived rather than guessed.
  assert.equal(bound.status, 'applied');
  assert.deepEqual(bound.unprojectedFactOperationIds, []);
  assert.equal(
    bound.profile.pensions.find((item) => item.pensionId === 'pension_old_dc').currentValue.amount,
    319_000
  );
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

// The invariant is attributed to the group that breaks it, so a single-group
// plan whose one operation cannot project reports `no_change` with that group
// rejected — the same shape as any other rejected-only plan. Nothing is
// written, the note is not created, and the profile does not move.
await runCase('an invariant-breaking correction is rejected and nothing is applied', async () => {
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
  assert.equal(result.status, 'no_change');
  assert.equal(result.profile.revision, 0);
  assert.equal(result.profile.pensions[0].type, 'occupational');
  assert.equal(result.notes.some((note) => note.noteId === 'recon_invalid_pension_type'), false);
  assert.equal(result.rejectedGroups.at(-1).code, 'profile_invariant_failed');
  // Attributed to its own group and operation rather than to a global `*`.
  assert.equal(result.rejectedGroups.at(-1).groupId, 'invalid_pension_type');
  assert.equal(result.operationOutcomes[0].status, 'rejected');
  assert.equal(result.acceptedOperationIds.length, 0);
});

// Grouping is recomputed from what the operations touch, so the planner cannot
// couple correct work to incorrect work by accident.
await runCase('dependency groups are decomposed by identity unless atomicity is claimed', async () => {
  const op = (operationId, over = {}) => ({
    operationId, op: 'upsert_note', targetNoteId: '', factId: 'monthly_spending',
    factInstanceId: '', entityId: '', ownerId: '', noteKind: 'fact',
    certainty: 'exact', targetEntityId: '', sourceEntityIds: [],
    value: { amount: 1, currency: 'EUR' }, reasonCode: 'missing_note',
    evidence: [{ turnId: 'turn_range', quote: 'x' }], ...over
  });

  // Nothing shared: three independent groups.
  const independent = splitIndependentOperationGroups([{
    groupId: 'mixed',
    atomic: false,
    operations: [op('a'), op('b'), op('c')]
  }]);
  assert.deepEqual(independent.map((group) => group.groupId), ['mixed#1', 'mixed#2', 'mixed#3']);

  // Shared entity keeps two together; the third stands alone.
  const partly = splitIndependentOperationGroups([{
    groupId: 'partly',
    atomic: false,
    operations: [op('a', { entityId: 'pension_x' }), op('b', { entityId: 'pension_x' }), op('c')]
  }]);
  assert.equal(partly.length, 2);
  assert.deepEqual(partly[0].operations.map((item) => item.operationId), ['a', 'b']);
  assert.deepEqual(partly[1].operations.map((item) => item.operationId), ['c']);

  // Transitive coupling: a-b share a note, b-c share an entity, so all three
  // are one component even though a and c share nothing directly.
  const chained = splitIndependentOperationGroups([{
    groupId: 'chained',
    atomic: false,
    operations: [
      op('a', { targetNoteId: 'note_1' }),
      op('b', { targetNoteId: 'note_1', entityId: 'pension_x' }),
      op('c', { entityId: 'pension_x' })
    ]
  }]);
  assert.equal(chained.length, 1);
  assert.equal(chained[0].groupId, 'chained');

  // A claimed group is never decomposed, whatever its operations touch.
  const claimed = splitIndependentOperationGroups([{
    groupId: 'claimed',
    atomic: true,
    operations: [op('a'), op('b')]
  }]);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].groupId, 'claimed');

  // An unsplit group keeps the planner's own id, so runs stay comparable.
  const single = splitIndependentOperationGroups([{
    groupId: 'single', atomic: false, operations: [op('a')]
  }]);
  assert.deepEqual(single.map((group) => group.groupId), ['single']);

  // Atomicity is opt-in: a plan that says nothing is not atomic.
  const normalized = normalizeReconciliationPlanV1({
    schemaVersion: 1, verdict: 'changes_proposed', reviewedNoteIds: [],
    operationGroups: [{ groupId: 'unclaimed', operations: [op('a')] }]
  });
  assert.equal(normalized.operationGroups[0].atomic, false);
});

// PHASE 1 SUCCESS CRITERION: a later explicit correction replaces the earlier
// value, reaches the canonical profile, and is not blocked by an unrelated
// invalid operation sitting in the same plan.
//
// This is the end-to-end shape the whole reconciler exists for, and until now
// none of it landed: the correction had no canonical path to be written to, and
// the unrelated failure discarded it anyway.
await runCase('a later scalar correction applies and an unrelated invalid operation cannot block it', async () => {
  // What the live voice lane left behind: a draft note carrying the first
  // figure the client gave.
  const spendFirst = normalizePlanningNoteV1({
    noteId: 'note_spend_first',
    noteKind: 'fact',
    factId: 'monthly_spending',
    factInstanceId: 'monthly_spending',
    value: { amount: 5_800, currency: 'EUR' },
    certainty: 'approximate',
    lifecycle: 'active',
    reviewStatus: 'provisional',
    source: 'realtime_note',
    evidenceRefs: [evidenceRef(
      turns.find((turn) => turn.turnId === 'turn_spend_first'),
      'We spend about €5,800 a month.'
    )],
    replacesNoteIds: [],
    createdAt: NOW
  });

  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: [...baseNotes(), spendFirst],
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      // ONE group, as the planner actually returns them. Nothing here claims
      // atomicity, and the correction shares no note, entity or fact instance
      // with the invalid operation, so it must not be taken down with it.
      operationGroups: [{
        groupId: 'turn_corrections',
        operations: [
          {
            // The voice lane already wrote €5,800 (note_spend_first, below).
            // This is the reconciler catching the client's later correction.
            operationId: 'spend_corrected',
            op: 'correct_note',
            targetNoteId: 'note_spend_first',
            factId: 'monthly_spending',
            factInstanceId: 'monthly_spending',
            noteKind: 'fact',
            value: { amount: 6_200, currency: 'EUR' },
            certainty: 'exact',
            reasonCode: 'explicit_correction',
            evidence: [{ turnId: 'turn_spend_corrected', quote: 'Actually, make that €6,200 a month.' }]
          },
          {
            // Unrelated and invalid: a figure that appears in no quote. Before
            // the grouping fix this discarded both corrections above.
            operationId: 'invented_pension_value',
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
      }]
    },
    ...common
  });

  // THE CORRECTION IS CANONICAL. €6,200 wins, €5,800 does not survive.
  assert.equal(result.status, 'applied');
  assert.equal(result.profileChanged, true);
  assert.equal(result.profile.expenses.monthlyEssential.amount, 6_200);
  assert.equal(result.profile.revision, 1);

  // The invalid operation is still refused, on its own.
  assert.equal(
    result.rejectedGroups.some((group) => group.code === 'numeric_value_unsupported'),
    true,
    'The unsupported figure must still be rejected.'
  );
  assert.equal(result.acceptedOperationIds.includes('invented_pension_value'), false);
  assert.equal(result.profile.pensions[0].currentValue.amount, 319_000);

  // ...and it did not take the corrections with it.
  assert.equal(result.acceptedOperationIds.includes('spend_corrected'), true);
  assert.equal(
    result.operationOutcomes.some((outcome) => outcome.code === 'dependency_group_rejected'),
    false,
    'Independent operations must not be discarded for a sibling failure.'
  );

  // The superseded value is no longer an active note.
  const activeSpending = result.notes.filter((note) => (
    note.factId === 'monthly_spending' && note.lifecycle === 'active'
  ));
  assert.equal(activeSpending.length, 1);
  assert.equal(activeSpending[0].value.amount, 6_200);
});

// THE INVARIANT FAILURE THAT DISCARDED SIX GOOD OPERATIONS.
//
// Recovered verbatim from r4-medium reconciliation revision 1:
//   pensions[1].type must be one of: occupational, prsa, personal,
//   defined_benefit, buyout_bond, other.
// introduced by a single `upsert_note` proposing `"type": "pension"`. Nine
// operations were proposed, zero were accepted, and an age, an income, a
// spending correction, a retirement scenario, a summary and a clarification —
// none of them touching a pension — came back `discarded_global_invariant`.
await runCase('a profile invariant failure rejects only the group that causes it', async () => {
  const spendQuote = 'Actually, make that €6,200 a month.';
  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      operationGroups: [
        {
          groupId: 'g_spending',
          operations: [{
            operationId: 'op_spending',
            op: 'upsert_note',
            factId: 'monthly_spending',
            factInstanceId: 'monthly_spending',
            noteKind: 'fact',
            value: { amount: 6_200, currency: 'EUR' },
            certainty: 'exact',
            reasonCode: 'explicit_correction',
            evidence: [{ turnId: 'turn_spend_corrected', quote: spendQuote }]
          }]
        },
        {
          // The exact defect: `pension` is not a member of the pension type
          // enum, so this note passes operation validation — the entity, owner
          // and evidence are all real — and fails only when the ledger is
          // projected into a profile. That is what makes it a whole-profile
          // invariant failure rather than an operation-level rejection.
          groupId: 'g_bad_pension',
          operations: [{
            operationId: 'op_bad_pension',
            op: 'correct_note',
            targetNoteId: 'note_old_dc',
            factId: 'pension_positions',
            factInstanceId: 'pension_positions:pension_old_dc',
            entityId: 'pension_old_dc',
            ownerId: 'primary',
            noteKind: 'position',
            value: {
              pensionId: 'pension_old_dc', ownerId: 'primary', type: 'pension',
              label: 'Old DC pension', currentValue: { amount: 319_000, currency: 'EUR' }
            },
            certainty: 'approximate',
            reasonCode: 'incorrect_classification',
            evidence: [{ turnId: 'turn_pensions', quote: 'My old DC pension is about €319k.' }]
          }]
        }
      ]
    },
    ...common
  });

  // The unrelated correction survives and reaches the canonical profile.
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.acceptedOperationIds, ['op_spending']);
  assert.equal(result.profile.expenses.monthlyEssential.amount, 6_200);

  // The offending group is refused, attributed to itself, and nothing invalid
  // is written: the invariant is enforced exactly as before.
  const rejected = result.rejectedGroups.find((group) => group.groupId === 'g_bad_pension');
  assert.ok(rejected, 'The invalid group must be rejected by name, not globally.');
  assert.equal(rejected.code, 'profile_invariant_failed');
  // The invalid type never reaches the profile: the existing value stands.
  assert.equal(result.profile.pensions[0].type, 'occupational');

  // No global `*` rejection, and nothing discarded for someone else's failure.
  assert.equal(result.rejectedGroups.some((group) => group.groupId === '*'), false);
  assert.equal(
    result.operationOutcomes.some((outcome) => outcome.status === 'discarded_global_invariant'),
    false,
    'An unrelated operation must not be discarded for another group\'s invariant failure.'
  );
});

// Atomicity inside the offending group is still absolute: a group whose own
// operations depend on each other loses all of them together.
await runCase('an invariant failure still rolls back its whole group', async () => {
  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: baseNotes(),
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      operationGroups: [{
        groupId: 'g_same_entity',
        operations: [
          {
            operationId: 'op_valid_sibling',
            op: 'correct_note',
            targetNoteId: 'note_old_dc',
            factId: 'pension_positions',
            factInstanceId: 'pension_positions:pension_old_dc',
            entityId: 'pension_old_dc',
            ownerId: 'primary',
            noteKind: 'position',
            value: {
              pensionId: 'pension_old_dc', ownerId: 'primary', type: 'occupational',
              label: 'Old DC pension', currentValue: { amount: 319_000, currency: 'EUR' }
            },
            certainty: 'approximate',
            reasonCode: 'explicit_correction',
            evidence: [{ turnId: 'turn_pensions', quote: 'My old DC pension is about €319k.' }]
          },
          {
            // Same entity, so identity keeps these two in one group.
            operationId: 'op_breaks_invariant',
            op: 'correct_note',
            targetNoteId: 'note_old_dc',
            factId: 'pension_positions',
            factInstanceId: 'pension_positions:pension_old_dc',
            entityId: 'pension_old_dc',
            ownerId: 'primary',
            noteKind: 'position',
            value: { pensionId: 'pension_old_dc', ownerId: 'primary', type: 'pension' },
            certainty: 'approximate',
            reasonCode: 'incorrect_classification',
            evidence: [{ turnId: 'turn_pensions', quote: 'My old DC pension is about €319k.' }]
          }
        ]
      }]
    },
    ...common
  });
  assert.deepEqual(result.acceptedOperationIds, []);
  assert.equal(result.profile.pensions[0].type, 'occupational');
  assert.equal(result.profile.revision, 0);
});

// THE SESSION-ENDING WEDGE. The projection runs over the WHOLE ledger, not
// just the notes a plan touched, and the ledger is re-read every turn. A single
// malformed realtime capture -- one whose value.ownerId disagreed with its own
// ownerId -- therefore made the FINAL global step throw on every subsequent
// reconciliation, and every correctly validated, fully evidenced operation came
// back `discarded_global_invariant`. The reconciler could never apply the one
// correction that would have repaired the note that was blocking it.
//
// Observed live: three calls, five reconciler invocations, zero applied
// operations, `* -> position_owner_mismatch` with six operations discarded.
await runCase('one malformed ledger note is quarantined instead of disabling the reconciler', async () => {
  const wedgeQuote = 'My old DC pension is about €319k.';
  // Not introduced by the plan: already sitting in the ledger, exactly as a
  // realtime capture leaves it. The plan below never touches this note.
  const malformed = normalizePlanningNoteV1({
    noteId: 'note_owner_conflict',
    noteKind: 'position',
    factId: 'pension_positions',
    factInstanceId: 'pension_positions:pension_conflicted',
    entityId: 'pension_conflicted',
    ownerId: 'partner',
    value: {
      pensionId: 'pension_conflicted',
      ownerId: 'primary',
      type: 'occupational',
      label: 'Conflicted pension',
      currentValue: { amount: 50_000, currency: 'EUR' }
    },
    certainty: 'approximate',
    lifecycle: 'active',
    reviewStatus: 'provisional',
    source: 'realtime_note',
    evidenceRefs: [evidenceRef(turns[0], wedgeQuote)],
    replacesNoteIds: [],
    createdAt: NOW
  });

  const result = await applyReconciliationPlan({
    profile: baseProfile(),
    notes: [...baseNotes(), malformed],
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      operationGroups: [{
        groupId: 'unrelated_correction',
        operations: [{
          operationId: 'unrelated_correction',
          op: 'reclassify_note',
          targetNoteId: 'note_pension_total',
          factId: 'pension_positions',
          entityId: 'pension_stated_total',
          ownerId: 'primary',
          noteKind: 'summary',
          value: { amount: 1_070_000, currency: 'EUR' },
          certainty: 'approximate',
          reasonCode: 'aggregate_summary',
          evidence: [{ turnId: 'turn_pensions', quote: 'Total pensions are about €1.07 million.' }]
        }]
      }]
    },
    ...common
  });

  // The unrelated operation survives. Before the fix this was
  // `discarded_global_invariant` / `profile_invariant_failed`.
  assert.equal(result.operationOutcomes[0].status, 'accepted');
  assert.deepEqual(result.acceptedOperationIds, ['unrelated_correction']);
  assert.equal(
    result.rejectedGroups.some((group) => group.groupId === '*'),
    false,
    'A quarantined ledger note must not produce a global rejection.'
  );

  // FAIL CLOSED ON THE NOTE ITSELF. It is still refused the canonical profile,
  // and it is reported so the next pass can repair it rather than silently
  // dropping it.
  assert.equal(result.profile.pensions.some((row) => row.pensionId === 'pension_conflicted'), false);
  assert.deepEqual(
    result.unprojectableNotes.map((entry) => [entry.noteId, entry.code]),
    [['note_owner_conflict', 'position_owner_mismatch']]
  );

  // The records the ledger CAN describe are untouched by the quarantine.
  assert.equal(
    result.profile.pensions.find((row) => row.pensionId === 'pension_old_dc')?.currentValue?.amount,
    319_000
  );
});

// (The plan-introduced invariant boundary is covered by the two cases above:
// a single invalid group is rejected and nothing is applied, and a group whose
// operations depend on each other loses all of them together. It used to roll
// the whole BATCH back, which is what "rejects only the group that causes it"
// now replaces.)

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

// ---------------------------------------------------------------------------
// A STATED TOTAL IS NOT A HOLDING.
//
// "There's about a million in the pensions" reached `/pensions` as a €1,000,000
// position beside three real ones, and Pension Projection was handed €2.07m for
// a client with €1.07m. The arithmetic was right and the canonical input was
// not, which is the worst shape a defect can take here.
//
// The rule these cases pin down is a CLASSIFICATION rule, never an arithmetic
// one: an operation the planner marks `aggregate_summary` must be a summary
// note, and a summary never projects into a positions collection. Case 3 is the
// guard on the guard -- a real holding whose value coincidentally equals the sum
// of its siblings stays a holding.
// ---------------------------------------------------------------------------

const AGGREGATE_TURNS = ['turn_aggregate_first', 'turn_named_after', 'turn_coincidental_holding']
  .map((turnId) => turns.find((turn) => turn.turnId === turnId));

/** A profile holding the three real pensions and nothing else. */
function threePensionProfile() {
  const profile = createHouseholdProfile({
    profileId: 'profile_three_pensions',
    primaryPersonId: 'primary',
    nowIso: NOW,
    calculationDateIso: '2026-08-09'
  });
  return normalizeHouseholdProfile({
    ...profile,
    pensions: [
      { pensionId: 'pension_old_dc', ownerId: 'primary', type: 'occupational', currentValue: { amount: 319_000, currency: 'EUR' } },
      { pensionId: 'pension_zurich', ownerId: 'primary', type: 'prsa', currentValue: { amount: 415_000, currency: 'EUR' } },
      { pensionId: 'pension_work', ownerId: 'primary', type: 'occupational', currentValue: { amount: 339_000, currency: 'EUR' } }
    ]
  });
}

function threePensionNotes() {
  return [
    ['pension_old_dc', 319_000, 'occupational', "one's about 319,000"],
    ['pension_zurich', 415_000, 'prsa', 'the Zurich one is 415,000'],
    ['pension_work', 339_000, 'occupational', 'the work one is 339,000']
  ].map(([pensionId, amount, type, quote]) => normalizePlanningNoteV1({
    noteId: `note_${pensionId}`,
    noteKind: 'position',
    factId: 'pension_positions',
    factInstanceId: `pension_positions:${pensionId}`,
    entityId: pensionId,
    ownerId: 'primary',
    value: { pensionId, ownerId: 'primary', type, currentValue: { amount, currency: 'EUR' } },
    certainty: 'approximate',
    lifecycle: 'active',
    reviewStatus: 'provisional',
    source: 'realtime_note',
    evidenceRefs: [evidenceRef(AGGREGATE_TURNS[1], quote)],
    replacesNoteIds: [],
    createdAt: NOW
  }, { nowIso: NOW }));
}

const aggregateCommon = {
  transcriptTurns: turns,
  sessionId: 'session_aggregate',
  transcriptWatermark: 'turn_coincidental_holding',
  baseProfileRevision: 0,
  nowIso: LATER,
  // The blank slot the server offers for one omitted holding, as the catalogue
  // supplies it in a real call.
  entities: [{
    entityId: 'recon_slot_pension_positions_1',
    label: 'new pension 1',
    ownerIds: [],
    factIds: ['pension_positions'],
    collection: 'pensions',
    aliases: ['pension'],
    newEntitySlot: true
  }]
};

/** Total pension money the deterministic module would read from the profile. */
function pensionTotal(profile) {
  return (profile.pensions || []).reduce((sum, pension) => sum + (pension.currentValue?.amount || 0), 0);
}

await runCase('three named pensions plus a stated total keep exactly three positions, total only as a summary', async () => {
  const result = await applyReconciliationPlan({
    profile: threePensionProfile(),
    notes: threePensionNotes(),
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      operationGroups: [{
        groupId: 'group_total',
        atomic: false,
        operations: [{
          operationId: 'op_total',
          op: 'upsert_note',
          reasonCode: 'aggregate_summary',
          noteKind: 'summary',
          factId: 'pension_current_value',
          factInstanceId: 'pension_current_value',
          certainty: 'approximate',
          value: { amount: 1_000_000, currency: 'EUR' },
          evidence: [{ turnId: 'turn_aggregate_first', quote: 'about a million across the pensions' }],
          sourceEntityIds: []
        }]
      }]
    },
    ...aggregateCommon
  });
  assert.deepEqual(result.acceptedOperationIds, ['op_total']);
  assert.deepEqual(
    result.profile.pensions.map((pension) => pension.pensionId),
    ['pension_old_dc', 'pension_zurich', 'pension_work'],
    'the stated total must not become a fourth holding'
  );
  assert.equal(pensionTotal(result.profile), 1_073_000);
  const summaries = result.profile.assumptions.values.planning.statedSummaries;
  assert.equal(summaries.length, 1, 'the total is kept, as a summary');
  assert.equal(summaries[0].value.amount, 1_000_000);
  assert.equal(summaries[0].evidenceRefs.length, 1, 'the aggregate keeps its provenance');
});

await runCase('an aggregate classified as a position is refused rather than projected as a holding', async () => {
  const result = await applyReconciliationPlan({
    profile: threePensionProfile(),
    notes: threePensionNotes(),
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      operationGroups: [{
        groupId: 'group_total_as_position',
        atomic: false,
        operations: [{
          operationId: 'op_total_as_position',
          op: 'upsert_note',
          // The plan says "aggregate" in one field and "holding" in the other.
          // The noteKind is what projects, so the mismatch used to win.
          reasonCode: 'aggregate_summary',
          noteKind: 'position',
          factId: 'pension_positions',
          factInstanceId: 'pension_positions:recon_slot_pension_positions_1',
          entityId: 'recon_slot_pension_positions_1',
          ownerId: 'primary',
          certainty: 'approximate',
          value: { ownerId: 'primary', type: 'other', currentValue: { amount: 1_000_000, currency: 'EUR' } },
          evidence: [{ turnId: 'turn_aggregate_first', quote: 'about a million across the pensions' }],
          sourceEntityIds: []
        }]
      }]
    },
    ...aggregateCommon
  });
  assert.equal(result.rejectedGroups[0].code, 'aggregate_not_a_position');
  assert.equal(pensionTotal(result.profile), 1_073_000, 'the module must never see the total added to the holdings');
});

await runCase('an aggregate stated first is resolved by the named holdings and left as a summary, not a position', async () => {
  // The live lane recorded the aggregate as a placeholder holding before any
  // pension was named. The named holdings arrive next, and the repair path is
  // reclassify_note: the placeholder stops being a position and survives as the
  // stated total it always was.
  const placeholder = normalizePlanningNoteV1({
    noteId: 'note_placeholder_total',
    noteKind: 'position',
    factId: 'pension_positions',
    factInstanceId: 'pension_positions:pension_realtime_primary',
    entityId: 'pension_realtime_primary',
    ownerId: 'primary',
    value: {
      pensionId: 'pension_realtime_primary',
      ownerId: 'primary',
      type: 'occupational',
      currentValue: { amount: 1_000_000, currency: 'EUR' }
    },
    certainty: 'approximate',
    lifecycle: 'active',
    reviewStatus: 'provisional',
    source: 'realtime_note',
    evidenceRefs: [evidenceRef(AGGREGATE_TURNS[0], 'about a million across the pensions')],
    replacesNoteIds: [],
    createdAt: NOW
  }, { nowIso: NOW });
  const profile = normalizeHouseholdProfile({
    ...threePensionProfile(),
    pensions: [
      { pensionId: 'pension_realtime_primary', ownerId: 'primary', type: 'occupational', currentValue: { amount: 1_000_000, currency: 'EUR' } },
      ...threePensionProfile().pensions
    ]
  });
  assert.equal(pensionTotal(profile), 2_073_000, 'the observed double count is the starting state');

  const result = await applyReconciliationPlan({
    profile,
    notes: [placeholder, ...threePensionNotes()],
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      operationGroups: [{
        groupId: 'group_resolve_placeholder',
        atomic: false,
        operations: [{
          operationId: 'op_resolve_placeholder',
          op: 'reclassify_note',
          reasonCode: 'aggregate_summary',
          targetNoteId: 'note_placeholder_total',
          noteKind: 'summary',
          factId: 'pension_positions',
          factInstanceId: 'pension_positions:pension_realtime_primary',
          entityId: 'pension_realtime_primary',
          ownerId: 'primary',
          certainty: 'approximate',
          value: { amount: 1_000_000, currency: 'EUR' },
          evidence: [{ turnId: 'turn_aggregate_first', quote: 'about a million across the pensions' }],
          sourceEntityIds: []
        }]
      }]
    },
    ...aggregateCommon
  });
  assert.deepEqual(result.acceptedOperationIds, ['op_resolve_placeholder']);
  assert.deepEqual(
    result.profile.pensions.map((pension) => pension.pensionId),
    ['pension_old_dc', 'pension_zurich', 'pension_work'],
    'the placeholder must leave the holdings once the real pensions are named'
  );
  assert.equal(pensionTotal(result.profile), 1_073_000, 'the double count is repaired');
  assert.equal(result.profile.assumptions.values.planning.statedSummaries.length, 1);
});

await runCase('a real holding whose value coincidentally equals the sum of the others is NOT refused', async () => {
  // 319,000 + 415,000 + 339,000 = 1,073,000. An arithmetic guard would refuse
  // this buyout bond for matching that sum. The client said it is a separate
  // holding they own, and it is one.
  const result = await applyReconciliationPlan({
    profile: threePensionProfile(),
    notes: threePensionNotes(),
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      operationGroups: [{
        groupId: 'group_coincidental',
        atomic: false,
        operations: [{
          operationId: 'op_coincidental',
          op: 'upsert_note',
          reasonCode: 'missing_note',
          noteKind: 'position',
          factId: 'pension_positions',
          factInstanceId: 'pension_positions:recon_slot_pension_positions_1',
          entityId: 'recon_slot_pension_positions_1',
          ownerId: 'primary',
          certainty: 'exact',
          value: { ownerId: 'primary', type: 'buyout_bond', currentValue: { amount: 1_073_000, currency: 'EUR' } },
          evidence: [{
            turnId: 'turn_coincidental_holding',
            quote: 'I also hold a separate buyout bond worth 1,073,000 in my own name'
          }],
          sourceEntityIds: []
        }]
      }]
    },
    ...aggregateCommon
  });
  assert.deepEqual(result.rejectedGroups, [], 'no arithmetic coincidence may refuse a stated holding');
  assert.deepEqual(result.acceptedOperationIds, ['op_coincidental']);
  assert.equal(result.profile.pensions.length, 4);
  assert.equal(pensionTotal(result.profile), 2_146_000);
});

await runCase('approximate aggregate wording stays a summary and the module sees no double counting', async () => {
  const result = await applyReconciliationPlan({
    profile: threePensionProfile(),
    notes: threePensionNotes(),
    plan: {
      schemaVersion: 1,
      verdict: 'changes_proposed',
      reviewedNoteIds: [],
      operationGroups: [{
        groupId: 'group_approx_total',
        atomic: false,
        operations: [{
          operationId: 'op_approx_total',
          op: 'upsert_note',
          reasonCode: 'aggregate_summary',
          noteKind: 'summary',
          factId: 'pension_current_value',
          factInstanceId: 'pension_current_value',
          certainty: 'approximate',
          value: { amount: 1_000_000, currency: 'EUR', qualifier: 'about' },
          evidence: [{ turnId: 'turn_aggregate_first', quote: 'about a million across the pensions' }],
          sourceEntityIds: []
        }]
      }]
    },
    ...aggregateCommon
  });
  assert.deepEqual(result.acceptedOperationIds, ['op_approx_total']);
  const summaries = result.profile.assumptions.values.planning.statedSummaries;
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].certainty, 'approximate', 'the uncertainty survives');
  assert.equal(summaries[0].value.qualifier, 'about');
  // What Pension Projection actually reads: three holdings, €1.073m, and no
  // trace of the €1m the client estimated out loud.
  assert.equal(result.profile.pensions.length, 3);
  assert.equal(pensionTotal(result.profile), 1_073_000);
  assert.equal(
    result.profile.pensions.some((pension) => pension.currentValue?.amount === 1_000_000),
    false,
    'the stated total is not readable as a holding'
  );
});

console.log('Planning reconciliation checks passed.');
