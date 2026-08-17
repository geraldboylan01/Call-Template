#!/usr/bin/env node

/**
 * TWO WAYS A GOOD REPAIR GETS LOST, BOTH FOUND ON PAID PROBES.
 *
 * 1. THE PLANNER COULD NOT ASK. `request_clarification` exists so the reconciler
 *    can decline to guess. A real planner used it — twice in one run — to ask
 *    whether a partner should be included, invented `entityId: "partner"` for a
 *    person the household does not yet contain, and `normalizeNeedV2` refused
 *    both. The refusal is correct; being unable to ask at all is not. The
 *    identity fields are optional, and nothing told the model that.
 *
 * 2. A DUPLICATE NOBODY INTRODUCED. `ensureLegacyPlanningNotes` recognised its
 *    own records only by `factInstanceId`. Once a correction re-identified a
 *    holding, the snapshot seeded a SECOND active position note for the same
 *    pension, and every later reconciliation failed `active_position_duplicate`
 *    at the whole-profile projection. Because no group had introduced it, the
 *    per-group containment could not attribute it: the rejection was global and
 *    discarded unrelated correct work with it.
 *
 * Both are pinned here against the real Durable Object and real D1, because
 * both are sequence failures that a unit test on either component would pass.
 */

import assert from 'node:assert/strict';

import { attachLiveSession, newLiveMeeting, settle } from './live-harness/session.mjs';
import { LiveProviderSimulator } from './live-harness/provider.mjs';
import { scriptedPlanner } from './live-harness/scripted-planner.mjs';
import { normalizeNeedV2 } from '../js/planning/reconciliation.js';
import { listPlanningNotes } from '../worker/src/consumer/realtime_repository.js';
import { getCurrentProfile, getSessionRow } from '../worker/src/consumer/repository.js';

const pass = (message) => console.info(`[ReconciliationIntegrity] PASS: ${message}`);

async function rig(label, planFor) {
  const meeting = await newLiveMeeting(label, { CONSUMER_PLANNER_RECONCILIATION_MODE: 'apply' });
  const { session, durable, provider } = await attachLiveSession(meeting);
  const simulator = new LiveProviderSimulator({ session, durable, provider });
  const planner = scriptedPlanner(planFor);
  const outcomes = [];
  const realExecute = session.executePlannerReconciliation.bind(session);
  session.executePlannerReconciliation = async (config, context, job) => {
    const result = await realExecute(config, context, job);
    if (result?.validation) {
      outcomes.push({
        status: result.status,
        accepted: result.validation.acceptedOperationIds || [],
        rejected: (result.validation.rejectedGroups || [])
          .map((group) => ({ groupId: group.groupId, code: group.code })),
        clarifications: (result.validation.clarificationNeeds || [])
          .map((need) => need.factInstanceId)
      });
    }
    return result;
  };
  const say = async (clientText, facts = null) => {
    await simulator.turn({
      clientText,
      act: async ({ callTool }) => {
        if (facts) await callTool('save_facts', { facts });
        return { speech: 'Noted.' };
      }
    });
    await settle(durable, session);
  };
  const profile = async () => getCurrentProfile(
    meeting.env, await getSessionRow(meeting.env, meeting.sessionId)
  );
  return { meeting, session, planner, outcomes, say, profile };
}

const openingFacts = [
  { factId: 'primary_goal', value: { type: 'improve_pension' }, certainty: 'exact' }
];
const pensionFact = [{
  factId: 'pension_positions',
  value: {
    operation: 'upsert', entityId: 'occ1', type: 'occupational', owner: 'primary',
    currentValue: { amount: 319000, currency: 'EUR' }
  },
  certainty: 'approximate'
}];

/* ================================================ 1. the planner can now ask */

// The shape the real planner produced, verbatim. It names an entity the
// household does not contain, and must still be refused — the fix is not to
// accept it, but to tell the model the field is optional.
assert.throws(
  () => normalizeNeedV2({
    schemaVersion: 2, needId: 'need_partner_person:partner', factId: 'partner_person',
    factInstanceId: 'partner_person:partner', reasonCode: 'required_input_missing',
    prompt: 'Please clarify partner person.', importance: 'required', blockingModuleIds: [],
    answerPolicy: 'unknown_allowed', status: 'open', entityId: 'partner', ownerId: 'primary'
  }, { allowedOwnerIds: ['primary'], allowedEntityIds: ['primary'] }),
  /NeedV2.entityId partner is not a known entity/,
  'an invented identity must still be refused'
);

// The same question, asked without inventing an identity, is valid.
assert.doesNotThrow(() => normalizeNeedV2({
  schemaVersion: 2, needId: 'need_partner_person', factId: 'partner_person',
  factInstanceId: 'partner_person', reasonCode: 'needs_clarification',
  prompt: 'Should your partner be included as a separate person in the plan?',
  importance: 'required', blockingModuleIds: [], answerPolicy: 'unknown_allowed', status: 'open'
}, { allowedOwnerIds: ['primary'], allowedEntityIds: ['primary'] }));
pass('a clarification about something that does not exist yet is expressible');

{
  let asked = false;
  const r = await rig('integrity-clarification', () => {
    if (asked) return null;
    asked = true;
    return {
      // A plan carrying only a clarification is `clarification_required`;
      // `changes_proposed` demands at least one mutating operation.
      verdict: 'clarification_required',
      repairs: [{
        groupId: 'ask', operationId: 'ask', op: 'request_clarification',
        factId: 'partner_person', factInstanceId: 'partner_person',
        noteKind: 'fact', certainty: 'exact', reasonCode: 'needs_clarification',
        value: {
          schemaVersion: 2, needId: 'need_partner_person', factId: 'partner_person',
          factInstanceId: 'partner_person', reasonCode: 'needs_clarification',
          prompt: 'Should your partner be included as a separate person in the plan?',
          importance: 'required', blockingModuleIds: [], answerPolicy: 'unknown_allowed',
          status: 'open'
        },
        quote: "I'm married"
      }]
    };
  });
  await r.say("I'm married and I want to get my pension sorted out.", openingFacts);

  const withClarification = r.outcomes.find((outcome) => outcome.clarifications.length > 0);
  assert.ok(withClarification, 'the clarification must survive validation and be reported');
  assert.deepEqual(withClarification.accepted, ['ask'],
    'a well-formed clarification must be accepted, not refused as operation_invalid');
  assert.deepEqual(withClarification.rejected, []);
  assert.deepEqual(withClarification.clarifications, ['partner_person'],
    'and the need itself must be carried out of validation for the lane to absorb');
  // WHAT IS DELIBERATELY NOT ASSERTED HERE: whether this particular need then
  // reaches the speaking model. `absorbPlannerRequests` keeps a request only
  // while the deterministic needs still list that instance, which is Phase 3
  // behaviour with its own coverage. Re-testing it from this fixture would tie
  // this regression to a readiness state that has nothing to do with the defect.
  r.planner.restore();
  pass('a clarification validates, is accepted, and survives into the lane');
}

/* ============================== 2. no duplicate, and no collateral damage */

{
  // A correction that RE-IDENTIFIES the holding, which is what made the legacy
  // snapshot stop recognising its own record and seed a second one.
  let corrected = false;
  const r = await rig('integrity-duplicate-seed', ({ notes }) => {
    const position = notes.find((note) => note.factId === 'pension_positions'
      && note.noteKind === 'position' && note.lifecycle === 'active');
    if (!position || corrected) return null;
    corrected = true;
    return {
      repairs: [{
        groupId: 'reidentify', operationId: 'reidentify', op: 'correct_note',
        targetNoteId: position.noteId,
        factId: 'pension_positions', factInstanceId: 'pension_positions:reidentified',
        entityId: position.entityId, ownerId: 'primary', noteKind: 'position',
        certainty: 'exact', reasonCode: 'incorrect_value',
        value: {
          pensionId: position.entityId, ownerId: 'primary', type: 'occupational',
          currentValue: { amount: 319000, currency: 'EUR' }
        },
        quote: '319,000'
      }]
    };
  });
  await r.say("I'm 57 and I want to get my pension sorted out.", openingFacts);
  await r.say('The occupational pension is worth about 319,000 right now.', pensionFact);
  await r.say('That is everything for now.', null);
  await r.say('Nothing else to add.', null);

  const notes = await listPlanningNotes(r.meeting.meeting?.env || r.meeting.env,
    r.meeting.sessionId, r.meeting.meetingId, { limit: 300 });
  const activePositions = notes.filter((note) => note.factId === 'pension_positions'
    && note.noteKind === 'position' && note.lifecycle === 'active');
  const byEntity = new Map();
  for (const note of activePositions) {
    byEntity.set(note.entityId, (byEntity.get(note.entityId) || 0) + 1);
  }
  for (const [entityId, count] of byEntity) {
    assert.equal(count, 1, `${entityId} must have exactly one active position note, found ${count}`);
  }
  assert.equal(r.outcomes.some((outcome) => outcome.rejected
    .some((rejection) => rejection.code === 'active_position_duplicate')), false,
  'no reconciliation may fail on a duplicate the snapshot seeded against itself');
  assert.equal((await r.profile()).pensions.length, 1, 'and the household still holds one pension');
  r.planner.restore();
  pass('re-identifying a holding does not seed a second active position note');
}

{
  /**
   * BLAST RADIUS, which is the property that actually matters.
   *
   * The offending group used to be an upsert duplicating a holding; that is now
   * an UPDATE and no longer rejects, so the containment is proved with a group
   * that is genuinely invalid for a different reason — an `aggregate_summary`
   * claim carried on a position note, which the validator refuses by name. What
   * is asserted is unchanged: only the bad group falls, and unrelated correct
   * work in another group still reaches canonical state.
   */
  let fired = false;
  const r = await rig('integrity-blast-radius', ({ notes }) => {
    const position = notes.find((note) => note.factId === 'pension_positions'
      && note.noteKind === 'position' && note.lifecycle === 'active');
    if (!position || fired) return null;
    fired = true;
    return {
      repairs: [
        {
          groupId: 'bad', operationId: 'bad', op: 'upsert_note', factId: 'pension_positions',
          factInstanceId: 'pension_positions:aggregate_claim', entityId: position.entityId,
          ownerId: 'primary', noteKind: 'position', certainty: 'approximate',
          // A position that claims to be an aggregate. Refused by name.
          reasonCode: 'aggregate_summary',
          value: {
            pensionId: position.entityId, ownerId: 'primary', type: 'occupational',
            currentValue: { amount: 400000, currency: 'EUR' }
          },
          quote: '400,000'
        },
        {
          groupId: 'age', operationId: 'age', op: 'upsert_note', factId: 'person_current_age',
          factInstanceId: 'person_current_age:primary', entityId: 'primary', ownerId: 'primary',
          noteKind: 'fact', certainty: 'exact', reasonCode: 'missing_note',
          value: { age: 57 }, quote: "I'm 57"
        }
      ]
    };
  });
  await r.say("I'm 57 and I want my pension sorted out. I had 400,000 in mind.", openingFacts);
  await r.say('The occupational pension is worth about 319,000 right now.', pensionFact);
  await r.say('That is everything for now.', null);

  const contained = r.outcomes.find((outcome) => outcome.rejected.length > 0);
  assert.ok(contained, 'the invalid group must be rejected');
  assert.deepEqual(contained.rejected.map((rejection) => rejection.groupId), ['bad'],
    'ONLY the offending group may be rejected');
  assert.equal(contained.rejected[0].code, 'aggregate_not_a_position');
  assert.ok(contained.accepted.includes('age'),
    'an unrelated correct repair in another group must still be accepted');
  const profile = await r.profile();
  assert.equal(profile.primaryPerson.age, 57, 'and it must reach canonical state');
  assert.equal(profile.pensions.length, 1, 'while the refused holding never appears');
  assert.equal(profile.pensions[0].currentValue.amount, 319_000,
    'and the real figure is untouched by the refused one');
  r.planner.restore();
  pass('an invalid group is rejected alone, and unrelated correct work survives');
}

/* ================== 3. a holding created first, amended afterwards */

{
  /**
   * THE SHAPE A REAL PLANNER PRODUCED. It created the income record, then sent a
   * SECOND operation to fill in the amount — and the second was refused
   * `active_position_duplicate`, so the household ended the call holding an
   * income source with no money in it and `income_sources` still outstanding.
   *
   * An upsert naming an entity that already holds an active position is an
   * update of that holding. One active note throughout; the amount lands.
   */
  let step = 0;
  const income = (over) => ({
    groupId: `income_${step}`, operationId: `income_${step}`, op: 'upsert_note',
    factId: 'income_sources', factInstanceId: 'income_sources:recon_slot_income_sources_1',
    entityId: 'recon_slot_income_sources_1', ownerId: 'primary', noteKind: 'position',
    certainty: 'exact', reasonCode: 'missing_note', quote: '95,000',
    value: {
      incomeId: 'recon_slot_income_sources_1', ownerId: 'primary',
      type: 'employment', label: 'Employment income', ...over
    }
  });
  const r = await rig('integrity-position-amend', () => {
    step += 1;
    if (step === 1) return { repairs: [income({})] };
    if (step === 2) return { repairs: [income({ grossAnnual: { amount: 95_000, currency: 'EUR' } })] };
    return null;
  });
  await r.say("I'm 57 and I want my pension sorted out.", openingFacts);
  await r.say("I'm on 95,000 a year. I put in 6 percent and the company puts in 8 percent.", [
    { factId: 'pension_employee_contribution_rate', value: 6, certainty: 'exact' }
  ]);
  await r.say('That is everything for now.', null);

  const notes = await listPlanningNotes(r.meeting.env, r.meeting.sessionId, r.meeting.meetingId, { limit: 300 });
  const active = notes.filter((note) => note.factId === 'income_sources'
    && note.noteKind === 'position' && note.lifecycle === 'active');
  assert.equal(active.length, 1,
    `amending a holding must leave exactly one active note, found ${active.length}`);
  assert.equal(r.outcomes.some((outcome) => outcome.rejected
    .some((rejection) => rejection.code === 'active_position_duplicate')), false,
  'amending an existing holding must not be refused as a duplicate');

  const profile = await r.profile();
  assert.equal(profile.incomeSources.length, 1, 'and the household holds one income source');
  assert.deepEqual(profile.incomeSources[0].grossAnnual, { amount: 95_000, currency: 'EUR' },
    'the amount added by the second operation must reach canonical state');
  r.planner.restore();
  pass('a holding created first and amended later ends with one note and the amount');
}

/* ============================ 4. how wide an evidence quote may be */

/**
 * THE QUOTE IS PART OF THE OPERATION, NOT DECORATION.
 *
 * A real planner wrote a perfectly correct income record — right identity, right
 * money, gross correctly defaulted — and it was refused, because it cited the
 * WHOLE turn as evidence: "I'm on 95,000 a year. I put in 6 percent and the
 * company puts in 8 percent." Three figures in one quote and no cue naming a
 * brand-new income slot, so `assertNumericSemanticBinding` could not bind 95,000
 * to that entity and failed closed. It was right to.
 *
 * The fix is in what the planner is TOLD to cite, never in what the validator
 * accepts. These cases pin both directions: too wide is refused, the narrow span
 * lands, and narrowing cannot be taken so far that the cue disappears.
 */
{
  const TURN = "I'm on 95,000 a year. I put in 6 percent and the company puts in 8 percent.";
  const incomeRepair = (quote) => ({
    groupId: 'income', operationId: 'income', op: 'upsert_note',
    factId: 'income_sources', factInstanceId: 'income_sources:recon_slot_income_sources_1',
    entityId: 'recon_slot_income_sources_1', ownerId: 'primary', noteKind: 'position',
    certainty: 'exact', reasonCode: 'missing_note',
    value: {
      incomeId: 'recon_slot_income_sources_1', ownerId: 'primary', type: 'employment',
      label: 'Employment income', grossAnnual: { amount: 95_000, currency: 'EUR' }
    },
    quote,
    // The turn is always the real one; only the quote varies.
    resolveWith: TURN
  });

  const withQuote = async (label, quote) => {
    let fired = false;
    const r = await rig(`integrity-evidence-${label}`, ({ turns }) => {
      if (fired) return null;
      // Only once the turn carrying the figure is inside the window.
      if (!turns.some((turn) => turn.role === 'user' && turn.text.includes(TURN))) return null;
      fired = true;
      return { repairs: [incomeRepair(quote)] };
    });
    await r.say("I'm 57 and I want my pension sorted out.", openingFacts);
    await r.say(TURN, [{ factId: 'pension_employee_contribution_rate', value: 6, certainty: 'exact' }]);
    await r.say('That is everything for now.', null);
    const profile = await r.profile();
    const rejected = r.outcomes.flatMap((outcome) => outcome.rejected.map((item) => item.code));
    r.planner.restore();
    return {
      rejected,
      gross: (profile.incomeSources || []).map((item) => item.grossAnnual?.amount)
    };
  };

  const wide = await withQuote('wide', TURN);
  assert.deepEqual(wide.gross, [],
    'a whole-turn quote carrying unrelated numbers must not reach canonical state');
  assert.ok(wide.rejected.includes('numeric_entity_binding_ambiguous'),
    `a quote with unrelated numbers must be refused as ambiguous, got ${wide.rejected.join(', ') || 'nothing'}`);

  const narrow = await withQuote('narrow', "I'm on 95,000 a year");
  assert.deepEqual(narrow.rejected, [],
    `the narrowest identifying span must be accepted, got ${narrow.rejected.join(', ')}`);
  assert.deepEqual(narrow.gross, [95_000],
    'and the figure must reach canonical state');

  // NARROWING HAS A FLOOR. A quote trimmed past the words that say what the
  // number is cannot bind it once the same figure exists elsewhere, so trimming
  // to a bare figure is not a way around the rule.
  const bare = await withQuote('bare', '95,000');
  assert.deepEqual(bare.gross.length <= 1, true);
  assert.ok(bare.rejected.length > 0 || bare.gross.length === 1,
    'a bare figure either binds because nothing else competes, or is refused — never silently mis-binds');

  // AND IT MUST STILL BE A REAL SPAN. Paraphrase is not narrowing.
  const paraphrased = await withQuote('paraphrase', 'I earn 95,000 annually');
  assert.deepEqual(paraphrased.gross, [],
    'a paraphrase is not evidence, however accurate it sounds');
  assert.ok(paraphrased.rejected.includes('evidence_quote_not_exact'),
    `a quote that is not an exact stored span must be refused, got ${paraphrased.rejected.join(', ') || 'nothing'}`);

  pass('evidence must be the narrowest exact span that still identifies its number');
}

console.info('\n[ReconciliationIntegrity] PASS: the planner can ask, holdings amend cleanly, evidence binds, and one bad group cannot take the batch with it');
